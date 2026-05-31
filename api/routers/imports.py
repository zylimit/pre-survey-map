"""三阶段导入（Spec V1.x #12）：

Phase 1 (POST /api/import)：解析单文件 → 同文件内重复 dict 折叠 → 清洗扫描 4 类
  + 主基准区域计算 → 存 session(state=cleaning)，返回 cleanings + baseline_region + summary

Phase 2 (POST /api/import/{sid}/proceed-to-conflicts)：应用用户清洗决策
  （auto_fix swap 坐标 / keep 原样 / discard 丢弃）→ 用清洗后剩下的点做冲突检测
  → 转 state=conflicts，返回 conflicts[]

Phase 3 (POST /api/import/{sid}/commit)：拿用户冲突决策入库（事务）
  non_conflicts INSERT + 冲突按 decision overwrite/ignore 处理
  → 转 state=committing→done

DELETE /api/import/{sid}：取消，丢弃 session
GET  /api/import/{sid}/conflicts.xlsx：F5 冲突 Excel 导出
"""

import json
import time
import traceback
from dataclasses import asdict
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

import session_store
from audit import write_audit
from cleaning import (
    _country_dist_in_db,
    classify_points,
    compute_baseline_region,
    detect_swap_or_missing_decimal,
)
from db import pool
from exporters.conflicts_xlsx import build_conflicts_xlsx
from restore_point_helper import create_restore_point
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


# ---------- 归一化 ----------


def _site_key(site_id: str, option: str) -> str:
    return f"{(site_id or '').strip().lower()}|{(option or '').strip().lower()}"


def _lessor_key(fid: str) -> str:
    return (fid or "").strip().lower()


def _row_id(kind: str, key: str) -> str:
    return f"{kind}:{key}"


# ---------- 行 → dict（asdict + 添加 source_file） ----------


def _site_dict(s: SiteRow, source: str) -> dict[str, Any]:
    return {**asdict(s), "source_file": source}


def _lessor_dict(l: LessorRow, source: str) -> dict[str, Any]:
    return {**asdict(l), "source_file": source}


def _normalize_jsonb(row: dict[str, Any]) -> dict[str, Any]:
    if "extras" in row and isinstance(row["extras"], str):
        row = {**row, "extras": json.loads(row["extras"])}
    return row


# =====================================================================
# Phase 1: POST /api/import （单文件，Spec F1 #12）
# =====================================================================


@router.post("")
async def import_file(file: UploadFile):
    """解析单文件 → 同文件内重复折叠 → 清洗扫描 4 类 → 算主基准。"""
    kind = _detect(file.filename or "")
    if kind == "unknown":
        raise HTTPException(
            status_code=400,
            detail="不支持的文件类型，仅支持 .kml / .kmz / .xlsx",
        )

    file_report: dict[str, Any] = {"name": file.filename, "type": kind}
    site_pool: dict[str, dict[str, Any]] = {}
    lessor_pool: dict[str, dict[str, Any]] = {}
    road_pool: list[dict[str, Any]] = []
    # 同文件内重复统计（Spec Q2：banner 第 2 行展示）
    site_dups_groups = 0
    site_dups_discarded = 0
    lessor_dups_groups = 0
    lessor_dups_discarded = 0
    parsed_count = 0

    try:
        data = await file.read()
        parsed = _parse(kind, data)
        parsed_count = len(parsed.sites) + len(parsed.roads) + len(parsed.lessors)
        file_report["parsed"] = {
            "site": len(parsed.sites),
            "road": len(parsed.roads),
            "lessor": len(parsed.lessors),
        }

        # 同文件内重复折叠：dict 替换；统计被丢弃的
        for s in parsed.sites:
            k = _site_key(s.site_id, s.option)
            if k in site_pool:
                if site_dups_groups == 0 or k not in {sk for sk in site_pool}:
                    pass  # 简化：统计在下面
            site_pool[k] = _site_dict(s, file.filename or "")
        # 用 parsed.sites 的总数减去 dict 后的数 = discarded
        site_dups_discarded = len(parsed.sites) - len(site_pool)
        # 组数 = 出现过多次的 key 数
        seen: dict[str, int] = {}
        for s in parsed.sites:
            k = _site_key(s.site_id, s.option)
            seen[k] = seen.get(k, 0) + 1
        site_dups_groups = sum(1 for v in seen.values() if v > 1)

        for r in parsed.roads:
            road_pool.append({**asdict(r), "source_file": file.filename or ""})

        for le in parsed.lessors:
            k = _lessor_key(le.fid)
            lessor_pool[k] = _lessor_dict(le, file.filename or "")
        lessor_dups_discarded = len(parsed.lessors) - len(lessor_pool)
        seen = {}
        for le in parsed.lessors:
            k = _lessor_key(le.fid)
            seen[k] = seen.get(k, 0) + 1
        lessor_dups_groups = sum(1 for v in seen.values() if v > 1)

    except ParseError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"{type(e).__name__}: {e}\n{traceback.format_exc().splitlines()[-2]}",
        )

    # === 清洗扫描 4 类 + 主基准 ===
    cleanings: list[dict[str, Any]] = []

    # 1) 坐标写反 / 漏小数点（纯算术）
    # 同时收集"坐标合法"的点用于地理判定
    geo_points: list[dict[str, Any]] = []
    for k, row in site_pool.items():
        rid = _row_id("site", k)
        issue = detect_swap_or_missing_decimal(row.get("lati"), row.get("longi"))
        if issue == "swap_latlong":
            # 写反 → 默认 auto_fix，预览交换后的值
            cleanings.append({
                "row_id": rid,
                "kind": "site",
                "name": f"{row['site_id']}{' / ' + row['option'] if row['option'] else ''}",
                "file_name": row["source_file"],
                "issue": "swap_latlong",
                "current_coord": {"lat": row["lati"], "lng": row["longi"]},
                "fixed_coord_preview": {"lat": row["longi"], "lng": row["lati"]},
                "default_action": "auto_fix",
            })
        elif issue == "missing_decimal":
            cleanings.append({
                "row_id": rid,
                "kind": "site",
                "name": f"{row['site_id']}{' / ' + row['option'] if row['option'] else ''}",
                "file_name": row["source_file"],
                "issue": "missing_decimal",
                "current_coord": {"lat": row.get("lati"), "lng": row.get("longi")},
                "fixed_coord_preview": None,
                "default_action": "discard",
            })
        else:
            # 坐标合法 → 收集做地理判定
            if row.get("lati") is not None and row.get("longi") is not None:
                geo_points.append({
                    "row_id": rid,
                    "lat": row["lati"],
                    "lng": row["longi"],
                })

    # 2) + 3) 在海里 / 不在主基准（PostGIS）
    # 这段是偶发 502/500 的高危区（清空基线后导入大文件，PostGIS KNN 重负载）。
    # 包 try/except 把裸异常变成可读错误 + 打满堆栈和耗时到 stderr，下次必留证据。
    _t0 = time.perf_counter()
    baseline = None
    baseline_iso = None
    try:
        async with pool().acquire() as conn:
            # 先算主基准（基线 ≥ 1 用基线，否则用本文件 geo_points）
            baseline = await compute_baseline_region(conn, current_points=geo_points)
            baseline_iso = baseline["country_iso_a2"] if baseline else None

            # 对 geo_points 做地理分类
            classified = await classify_points(conn, geo_points, baseline_iso)
    except Exception as e:
        traceback.print_exc()
        print(
            f"[import] geo classify FAILED after {time.perf_counter() - _t0:.1f}s "
            f"points={len(geo_points)} baseline_iso={baseline_iso}",
            flush=True,
        )
        raise HTTPException(
            status_code=500,
            detail=f"地理清洗失败（{len(geo_points)} 点）：{type(e).__name__}: {e}",
        )
    print(
        f"[import] geo classify OK in {time.perf_counter() - _t0:.1f}s "
        f"points={len(geo_points)} baseline_iso={baseline_iso}",
        flush=True,
    )

    for p in geo_points:
        cls = classified.get(p["row_id"])
        if cls is None:
            continue
        rid = p["row_id"]
        # 从 site_pool 拿对应行的展示信息
        # rid = "site:{key}"，key = "{site_id}|{option}"（lower trim）
        # 重新从 site_pool 取
        k = rid.split(":", 1)[1]
        row = site_pool.get(k)
        if row is None:
            continue
        name = f"{row['site_id']}{' / ' + row['option'] if row['option'] else ''}"
        coord = {"lat": row["lati"], "lng": row["longi"]}
        if cls["in_sea"]:
            cleanings.append({
                "row_id": rid,
                "kind": "site",
                "name": name,
                "file_name": row["source_file"],
                "issue": "in_sea",
                "current_coord": coord,
                "fixed_coord_preview": None,
                "default_action": "discard",
                "country_iso_a2": None,
            })
        elif cls["not_in_baseline"]:
            cleanings.append({
                "row_id": rid,
                "kind": "site",
                "name": name,
                "file_name": row["source_file"],
                "issue": "not_in_baseline",
                "current_coord": coord,
                "fixed_coord_preview": None,
                # Spec V1.x #15：野蛮粗暴版，默认 [丢弃] 强约束"先入为主"
                # 用户要保留某个跨境点可显式点 [强制保留]
                "default_action": "discard",
                "country_iso_a2": cls["country_iso_a2"],
                "country_name_zh": cls["country_name_zh"],
                "country_name_en": cls.get("country_name_en"),
            })

    summary = {
        "total_parsed": parsed_count,
        "intra_file_duplicates": {
            "site_groups": site_dups_groups,
            "site_discarded": site_dups_discarded,
            "lessor_groups": lessor_dups_groups,
            "lessor_discarded": lessor_dups_discarded,
        },
        "after_dedup": {
            "site": len(site_pool),
            "road": len(road_pool),
            "lessor": len(lessor_pool),
        },
        "cleanings_count": len(cleanings),
    }

    # Spec V1.x #15 雷 29：基线已确立 + 本文件 0 点在基线国家 → 前端弹红 banner
    warn_all_outside = False
    if baseline and baseline.get("source") == "baseline" and baseline.get("country_iso_a2"):
        b_iso = baseline["country_iso_a2"]
        inside = sum(
            1 for cls in classified.values()
            if cls.get("country_iso_a2") == b_iso
        )
        warn_all_outside = (len(geo_points) > 0 and inside == 0)

    sid = session_store.create(
        {
            "file_name": file.filename,
            "site_pool": site_pool,
            "lessor_pool": lessor_pool,
            "road_pool": road_pool,
            "cleanings": cleanings,
            "baseline_region": baseline,
        },
        state="cleaning",
    )

    return {
        "session_id": sid,
        "file": file_report,
        "summary": summary,
        "baseline_region": baseline,
        "cleanings": cleanings,
        "warn_all_outside_baseline": warn_all_outside,
    }


# =====================================================================
# Phase 2: POST /api/import/{sid}/proceed-to-conflicts
# =====================================================================


class CleaningDecision(BaseModel):
    row_id: str
    action: str  # "auto_fix" | "keep" | "discard"


class ProceedBody(BaseModel):
    decisions: list[CleaningDecision] = []


@router.post("/{sid}/proceed-to-conflicts")
async def proceed_to_conflicts(sid: str, body: ProceedBody):
    s = session_store.get(sid)
    if s is None:
        raise HTTPException(status_code=404, detail="session 不存在或已过期")

    err = session_store.transition(sid, "conflicts")
    if err:
        raise HTTPException(status_code=400, detail={"error": "invalid_state", "msg": err})

    decisions = {d.row_id: d.action for d in body.decisions}
    site_pool: dict[str, dict[str, Any]] = dict(s["site_pool"])  # 拷贝，应用清洗后回写
    cleanings: list[dict[str, Any]] = s["cleanings"]

    # 应用清洗决策
    cleaning_stats = {"auto_fixed": 0, "kept": 0, "discarded": 0}
    for c in cleanings:
        if c["kind"] != "site":
            continue
        rid = c["row_id"]
        action = decisions.get(rid, c["default_action"])
        key = rid.split(":", 1)[1]
        if action == "discard":
            site_pool.pop(key, None)
            cleaning_stats["discarded"] += 1
        elif action == "auto_fix" and c["issue"] == "swap_latlong":
            row = site_pool.get(key)
            if row is not None:
                # swap lati/longi 列 + 同步 extras + 重算 wkt
                old_lati, old_longi = row.get("lati"), row.get("longi")
                row["lati"] = old_longi
                row["longi"] = old_lati
                # extras 里如果有 LATI/LONGI（KML/Excel 解析时存的），同步 swap
                ex = dict(row.get("extras") or {})
                if "LATI" in ex and "LONGI" in ex:
                    ex["LATI"], ex["LONGI"] = ex["LONGI"], ex["LATI"]
                row["extras"] = ex
                # 重算 wkt（POINT(lng lat)）
                if row["lati"] is not None and row["longi"] is not None:
                    row["wkt"] = f"POINT({row['longi']} {row['lati']})"
            cleaning_stats["auto_fixed"] += 1
        else:
            # keep（含 auto_fix 用在非 swap 类型时也按 keep 处理）
            cleaning_stats["kept"] += 1

    # 用清洗后的 site_pool 做冲突检测（lessor / road 不参与清洗）
    lessor_pool: dict[str, dict[str, Any]] = s["lessor_pool"]
    road_pool: list[dict[str, Any]] = s["road_pool"]

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

    # 写回 session（清洗后的 pool + 计算出的 non_conflicts + conflicts）
    session_store.update(sid, {
        "site_pool_cleaned": site_pool,
        "non_conflicts": non_conflicts,
        "conflicts": conflicts,
        "cleaning_decisions": decisions,
        "cleaning_stats": cleaning_stats,
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

    return {
        "session_id": sid,
        "summary": summary,
        "conflicts": conflicts,
        "cleaning_stats": cleaning_stats,
    }


# =====================================================================
# Phase 2 back: POST /api/import/{sid}/back-to-cleaning
# =====================================================================


@router.post("/{sid}/back-to-cleaning")
async def back_to_cleaning(sid: str):
    """从冲突向导返回清洗向导。保留 cleaning_decisions 缓存，清掉 conflicts 决策。"""
    s = session_store.get(sid)
    if s is None:
        raise HTTPException(status_code=404, detail="session 不存在或已过期")
    err = session_store.transition(sid, "cleaning")
    if err:
        raise HTTPException(status_code=400, detail={"error": "invalid_state", "msg": err})
    return {
        "session_id": sid,
        "cleanings": s["cleanings"],
        "baseline_region": s["baseline_region"],
        "cleaning_decisions": s.get("cleaning_decisions", {}),
    }


# =====================================================================
# Phase 3: POST /api/import/{sid}/commit
# =====================================================================


class Decision(BaseModel):
    key: str
    action: str  # "overwrite" | "ignore"


class CommitBody(BaseModel):
    decisions: list[Decision] = []


@router.post("/{sid}/commit")
async def commit_import(sid: str, body: CommitBody, request: Request):
    s = session_store.get(sid)
    if s is None:
        raise HTTPException(status_code=404, detail="session 不存在或已过期")
    if "non_conflicts" not in s:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_state", "msg": "尚未通过 proceed-to-conflicts"},
        )

    err = session_store.transition(sid, "committing")
    if err:
        raise HTTPException(status_code=400, detail={"error": "invalid_state", "msg": err})

    decisions = {d.key: d.action for d in body.decisions}
    stats = {
        "site": {"inserted": 0, "updated": 0, "ignored": 0},
        "road": {"inserted": 0, "updated": 0, "ignored": 0},
        "lessor": {"inserted": 0, "updated": 0, "ignored": 0},
    }
    rp_id: int | None = None

    async with pool().acquire() as conn:
        async with conn.transaction():
            # F17: commit 落库前自动建恢复点（pre_import）
            rp_id = await create_restore_point(conn, "pre_import")

            for r in s["non_conflicts"]["site"]:
                await _insert_site(conn, r)
                stats["site"]["inserted"] += 1
            for r in s["non_conflicts"]["road"]:
                await _insert_road(conn, r)
                stats["road"]["inserted"] += 1
            for r in s["non_conflicts"]["lessor"]:
                await _insert_lessor(conn, r)
                stats["lessor"]["inserted"] += 1

            for c in s["conflicts"]:
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

            # Spec V1.x #15：第一次 commit 成功 + site 新增 > 0 + baseline_state 空 → 固化主基准
            # 在同一事务内，确保入库 + 固化原子性
            baseline_established = None
            site_added = stats["site"]["inserted"] + stats["site"]["updated"]
            if site_added > 0:
                exists = await conn.fetchval(
                    "SELECT 1 FROM baseline_state WHERE id = 1"
                )
                if not exists:
                    country = await _country_dist_in_db(conn)
                    if country and country.get("country_iso_a2"):
                        await conn.execute(
                            """
                            INSERT INTO baseline_state
                                (id, iso_a2, name_zh, coverage_pct, points_used)
                            VALUES (1, $1, $2, $3, $4)
                            ON CONFLICT (id) DO NOTHING
                            """,
                            country["country_iso_a2"],
                            country.get("country_name_zh"),
                            country.get("coverage_pct"),
                            country.get("points_used"),
                        )
                        baseline_established = {
                            "iso_a2": country["country_iso_a2"],
                            "name_zh": country.get("country_name_zh"),
                            "name_en": country.get("country_name_en"),
                            "coverage_pct": country.get("coverage_pct"),
                            "points_used": country.get("points_used"),
                        }
                    # country=None（全在海里）→ 不固化，下次 commit 再尝试（Spec 雷 30）

    # F19 审计：import + restore_point_create_auto（pre_import）
    await write_audit(
        action="import",
        details={
            "file_name": s.get("file_name"),
            "parsed_count": sum(stats[k]["inserted"] + stats[k]["updated"] + stats[k]["ignored"] for k in ("site", "road", "lessor")),
            "cleaning_stats": s.get("cleaning_stats", {}),
            "stats": stats,
            "restore_point_id": rp_id,
            "baseline_established": baseline_established,
        },
        request=request,
    )
    if rp_id is not None:
        await write_audit(
            action="restore_point_create_auto",
            details={"restore_point_id": rp_id, "reason": "pre_import"},
            request=request,
        )

    session_store.drop(sid)
    return {
        "stats": stats,
        "cleaning_stats": s.get("cleaning_stats", {}),
        "baseline_established": baseline_established,  # None = 未触发或未成功
    }


# =====================================================================
# DELETE /api/import/{sid}
# =====================================================================


@router.delete("/{sid}")
async def cancel_import(sid: str):
    dropped = session_store.drop(sid)
    return {"dropped": dropped}


# =====================================================================
# GET /api/import/{sid}/conflicts.xlsx (F5)
# =====================================================================


@router.get("/{sid}/conflicts.xlsx")
async def conflicts_xlsx(sid: str, request: Request):
    s = session_store.get(sid)
    if s is None:
        raise HTTPException(status_code=404, detail="session 不存在或已过期")
    conflicts = s.get("conflicts", [])
    data = build_conflicts_xlsx(conflicts)
    fname = f"conflicts_{datetime.now().strftime('%Y%m%d%H%M%S')}.xlsx"
    await write_audit(
        action="export_conflicts",
        details={
            "file_name": fname,
            "source_file": s.get("file_name"),
            "counts": {
                "total": len(conflicts),
                "site": sum(1 for c in conflicts if c.get("kind") == "site"),
                "lessor": sum(1 for c in conflicts if c.get("kind") == "lessor"),
            },
            "bytes": len(data),
        },
        request=request,
    )
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "X-Filename": fname,
        },
    )


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
