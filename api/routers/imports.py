"""两阶段导入。

Phase 1 (POST /api/import)：解析所有上传文件 → 同批次按主键归一化去重（后者覆盖前者，
Spec 合并策略表）→ 与 DB 现状比对得出 non_conflicts / conflicts → 存 session 暂不写库
→ 返回 session_id + conflicts[] 给前端决策。

Phase 2 (POST /api/import/{sid}/commit)：拿用户 decisions 在一个事务内执行：
non_conflicts 全部 INSERT，conflicts 按决策做 UPDATE（覆盖）或跳过（忽略）。
Road 不做去重（Spec），全部直接 INSERT。

DELETE /api/import/{sid}：取消，丢弃 session，不写任何库。
"""

import json
import traceback
from dataclasses import asdict
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

import session_store
from anomaly import detect_coord_warning
from db import pool
from exporters.conflicts_xlsx import build_conflicts_xlsx
from parsers.kml import LessorRow, ParseResult, SiteRow, parse_kml
from parsers.kmz import parse_kmz
from parsers.xlsx import ParseError, parse_xlsx

router = APIRouter()


# ---------- 文件类型分发 ----------


def _detect(filename: str) -> str:
    name = filename.lower()
    if name.endswith(".kmz"):
        return "kmz"
    if name.endswith(".kml"):
        return "kml"
    if name.endswith(".xlsx"):
        return "xlsx"
    return "unknown"


def _parse(kind: str, data: bytes) -> ParseResult:
    if kind == "kml":
        return parse_kml(data)
    if kind == "kmz":
        return parse_kmz(data)
    if kind == "xlsx":
        return parse_xlsx(data)
    raise ValueError(f"不支持的文件类型：{kind}")


# ---------- 归一化（用于冲突比对的 key） ----------


def _site_key(site_id: str, option: str) -> str:
    return f"{(site_id or '').strip().lower()}|{(option or '').strip().lower()}"


def _lessor_key(fid: str) -> str:
    return (fid or "").strip().lower()


# ---------- 行 → 可 JSON 序列化的字典 ----------


def _site_row_dict(s: SiteRow, source_file: str) -> dict[str, Any]:
    return {**asdict(s), "source_file": source_file}


def _lessor_row_dict(l: LessorRow, source_file: str) -> dict[str, Any]:
    return {**asdict(l), "source_file": source_file}


# ---------- Phase 1: POST /api/import ----------


@router.post("")
async def import_files(files: list[UploadFile]):
    file_reports: list[dict[str, Any]] = []
    # 同批次内按主键归一化去重；后者覆盖前者
    site_pool: dict[str, dict[str, Any]] = {}
    lessor_pool: dict[str, dict[str, Any]] = {}
    road_pool: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []

    for f in files:
        kind = _detect(f.filename or "")
        report: dict[str, Any] = {"name": f.filename, "type": kind}
        if kind == "unknown":
            report["error"] = "不支持的文件类型，仅支持 .kml / .kmz / .xlsx"
            file_reports.append(report)
            continue
        try:
            data = await f.read()
            parsed = _parse(kind, data)
            report["parsed"] = {
                "site": len(parsed.sites),
                "road": len(parsed.roads),
                "lessor": len(parsed.lessors),
            }
            for s in parsed.sites:
                key = _site_key(s.site_id, s.option)
                site_pool[key] = _site_row_dict(s, f.filename or "")
                w = detect_coord_warning(s.lati, s.longi)
                if w:
                    warnings.append({
                        "key": f"site:{s.site_id}:{s.option}",
                        "name": f"{s.site_id}{' / ' + s.option if s.option else ''}",
                        "source_file": f.filename or "",
                        "message": w,
                    })
            for r in parsed.roads:
                road_pool.append({**asdict(r), "source_file": f.filename or ""})
            for le in parsed.lessors:
                lessor_pool[_lessor_key(le.fid)] = _lessor_row_dict(le, f.filename or "")
        except ParseError as e:
            report["error"] = str(e)
        except Exception as e:
            report["error"] = f"{type(e).__name__}: {e}"
            report["trace"] = traceback.format_exc().splitlines()[-3:]
        file_reports.append(report)

    # 与 DB 现状比对 → 分流 non_conflicts / conflicts
    async with pool().acquire() as conn:
        existing_sites = await conn.fetch(
            "SELECT site_id, \"option\", project, site_status, lati, longi, "
            "extras, source_file FROM site"
        )
        existing_lessors = await conn.fetch(
            "SELECT fid, lessor_name, lessor_category, relationship, extras, "
            "source_file FROM lessor"
        )

    existing_site_idx = {
        _site_key(r["site_id"], r["option"]): dict(r) for r in existing_sites
    }
    existing_lessor_idx = {
        _lessor_key(r["fid"]): dict(r) for r in existing_lessors
    }

    conflicts: list[dict[str, Any]] = []
    non_conflicts: dict[str, list[dict[str, Any]]] = {
        "site": [],
        "road": road_pool,
        "lessor": [],
    }

    for key, row in site_pool.items():
        existing = existing_site_idx.get(key)
        if existing is None:
            non_conflicts["site"].append(row)
        else:
            existing = _normalize_jsonb(existing)
            conflicts.append({
                "key": f"site:{row['site_id']}:{row['option']}",
                "kind": "site",
                "name": f"{row['site_id']}{' / ' + row['option'] if row['option'] else ''}",
                "existing": existing,
                "incoming": row,
                "source_file": row["source_file"],
            })

    for key, row in lessor_pool.items():
        existing = existing_lessor_idx.get(key)
        if existing is None:
            non_conflicts["lessor"].append(row)
        else:
            existing = _normalize_jsonb(existing)
            conflicts.append({
                "key": f"lessor:{row['fid']}",
                "kind": "lessor",
                "name": row.get("lessor_name") or row["fid"],
                "existing": existing,
                "incoming": row,
                "source_file": row["source_file"],
            })

    summary = {
        "site": {
            "non_conflict": len(non_conflicts["site"]),
            "conflict": sum(1 for c in conflicts if c["kind"] == "site"),
        },
        "road": {
            "non_conflict": len(non_conflicts["road"]),
            "conflict": 0,
        },
        "lessor": {
            "non_conflict": len(non_conflicts["lessor"]),
            "conflict": sum(1 for c in conflicts if c["kind"] == "lessor"),
        },
    }

    sid = session_store.create({
        "non_conflicts": non_conflicts,
        "conflicts": conflicts,
    })

    return {
        "session_id": sid,
        "files": file_reports,
        "summary": summary,
        "conflicts": conflicts,
        "warnings": warnings,
    }


def _normalize_jsonb(row: dict[str, Any]) -> dict[str, Any]:
    """asyncpg 返回的 JSONB 字段是 str，转回 dict 方便前端用。"""
    if "extras" in row and isinstance(row["extras"], str):
        row = {**row, "extras": json.loads(row["extras"])}
    return row


# ---------- Phase 2: POST /api/import/{sid}/commit ----------


class Decision(BaseModel):
    key: str
    action: str  # "overwrite" | "ignore"


class CommitBody(BaseModel):
    decisions: list[Decision] = []


@router.post("/{sid}/commit")
async def commit_import(sid: str, body: CommitBody):
    session = session_store.get(sid)
    if session is None:
        raise HTTPException(status_code=404, detail="session 不存在或已过期")

    decisions = {d.key: d.action for d in body.decisions}
    stats = {
        "site": {"inserted": 0, "updated": 0, "ignored": 0},
        "road": {"inserted": 0, "updated": 0, "ignored": 0},
        "lessor": {"inserted": 0, "updated": 0, "ignored": 0},
    }

    async with pool().acquire() as conn:
        async with conn.transaction():
            for s in session["non_conflicts"]["site"]:
                await _insert_site(conn, s)
                stats["site"]["inserted"] += 1

            for r in session["non_conflicts"]["road"]:
                await _insert_road(conn, r)
                stats["road"]["inserted"] += 1

            for le in session["non_conflicts"]["lessor"]:
                await _insert_lessor(conn, le)
                stats["lessor"]["inserted"] += 1

            for c in session["conflicts"]:
                action = decisions.get(c["key"], "ignore")
                if action == "overwrite":
                    if c["kind"] == "site":
                        await _update_site(conn, c["existing"], c["incoming"])
                        stats["site"]["updated"] += 1
                    elif c["kind"] == "lessor":
                        await _update_lessor(conn, c["existing"], c["incoming"])
                        stats["lessor"]["updated"] += 1
                else:
                    stats[c["kind"]]["ignored"] += 1

    session_store.drop(sid)
    return {"stats": stats}


# ---------- GET /api/import/{sid}/conflicts.xlsx ----------


@router.get("/{sid}/conflicts.xlsx")
async def conflicts_xlsx(sid: str):
    """F5：当前 session 的冲突列表导出 Excel。

    用户选 [取消] 时前端先调这个端点拿到 xlsx，再调 DELETE 释放 session。
    """
    session = session_store.get(sid)
    if session is None:
        raise HTTPException(status_code=404, detail="session 不存在或已过期")
    data = build_conflicts_xlsx(session.get("conflicts", []))
    fname = f"conflicts_{datetime.now().strftime('%Y%m%d%H%M%S')}.xlsx"
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "X-Filename": fname,
        },
    )


# ---------- DELETE /api/import/{sid} ----------


@router.delete("/{sid}")
async def cancel_import(sid: str):
    dropped = session_store.drop(sid)
    return {"dropped": dropped}


# ---------- SQL helpers ----------


async def _insert_site(conn, row: dict[str, Any]) -> None:
    await conn.execute(
        """
        INSERT INTO site (site_id, "option", project, site_status, lati, longi,
                          extras, source_file, geom)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8,
                CASE WHEN $9::text IS NULL THEN NULL
                     ELSE ST_GeomFromText($9, 4326) END)
        ON CONFLICT (site_id, "option") DO NOTHING
        """,
        row["site_id"], row["option"], row.get("project"), row.get("site_status"),
        row.get("lati"), row.get("longi"),
        json.dumps(row.get("extras") or {}),
        row.get("source_file"), row.get("wkt"),
    )


async def _update_site(conn, existing: dict[str, Any], row: dict[str, Any]) -> None:
    """完整替换（Spec：新数据完整替换库中旧记录，V1 不做字段级合并）。

    用 existing 的原始 PK 做 WHERE 定位旧行，SET 用 incoming 全字段。
    """
    await conn.execute(
        """
        UPDATE site SET
            site_id = $1, "option" = $2,
            project = $3, site_status = $4, lati = $5, longi = $6,
            extras = $7::jsonb, source_file = $8, updated_at = now(),
            geom = CASE WHEN $9::text IS NULL THEN NULL
                        ELSE ST_GeomFromText($9, 4326) END
        WHERE site_id = $10 AND "option" = $11
        """,
        row["site_id"], row["option"], row.get("project"), row.get("site_status"),
        row.get("lati"), row.get("longi"),
        json.dumps(row.get("extras") or {}),
        row.get("source_file"), row.get("wkt"),
        existing["site_id"], existing["option"],
    )


async def _insert_road(conn, row: dict[str, Any]) -> None:
    await conn.execute(
        """
        INSERT INTO road (property, extras, source_file, geom)
        VALUES ($1, $2::jsonb, $3,
                CASE WHEN $4::text IS NULL THEN NULL
                     ELSE ST_GeomFromText($4, 4326) END)
        """,
        row.get("property"),
        json.dumps(row.get("extras") or {}),
        row.get("source_file"),
        row.get("wkt"),
    )


async def _insert_lessor(conn, row: dict[str, Any]) -> None:
    await conn.execute(
        """
        INSERT INTO lessor (fid, lessor_name, lessor_category, relationship,
                            extras, source_file, geom)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6,
                CASE WHEN $7::text IS NULL THEN NULL
                     ELSE ST_GeomFromText($7, 4326) END)
        ON CONFLICT (fid) DO NOTHING
        """,
        row["fid"], row.get("lessor_name"), row.get("lessor_category"),
        row.get("relationship"),
        json.dumps(row.get("extras") or {}),
        row.get("source_file"),
        row.get("wkt"),
    )


async def _update_lessor(conn, existing: dict[str, Any], row: dict[str, Any]) -> None:
    await conn.execute(
        """
        UPDATE lessor SET
            fid = $1, lessor_name = $2, lessor_category = $3, relationship = $4,
            extras = $5::jsonb, source_file = $6, updated_at = now(),
            geom = CASE WHEN $7::text IS NULL THEN NULL
                        ELSE ST_GeomFromText($7, 4326) END
        WHERE fid = $8
        """,
        row["fid"], row.get("lessor_name"), row.get("lessor_category"),
        row.get("relationship"),
        json.dumps(row.get("extras") or {}),
        row.get("source_file"),
        row.get("wkt"),
        existing["fid"],
    )
