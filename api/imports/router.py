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

from fastapi import APIRouter, Depends, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from core import session_store
from audit.service import write_audit
from auth.permissions import require_perm
from auth.scopes import import_target_visible, request_scopes
from .cleaning import (
    _country_dist_in_db,
    classify_geoms,
    classify_points,
    compute_baseline_region,
    detect_swap_or_missing_decimal,
)
from core.db import pool
from exporters.conflicts_xlsx import build_conflicts_xlsx
from restore.helper import create_restore_point
from parsers.kml import AreaRow, LessorRow, ParseResult, SiteRow, parse_kml
from parsers.kmz import parse_kmz
from parsers.xlsx import ParseError, parse_xlsx

# #50 Phase 12：全端点 import 功能权限门控（admin 恒过）
router = APIRouter(dependencies=[Depends(require_perm("import"))])


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


def _road_key(property: str | None) -> str:
    """F20 V1.x #24：Road 全局去重键 = Property（trim+lower）。空 Property 无身份，返回 ''。"""
    return (property or "").strip().lower()


def _lessor_key(fid: str) -> str:
    return (fid or "").strip().lower()


def _area_key(name: str) -> str:
    """#51 F23：area 去重键 = name（trim+lower）；运营商维度由盖戳固定，不入 key。"""
    return (name or "").strip().lower()


# ---------- F20 状态值规范化（导入器层面，V1.x #25）----------
# 库内无旧数据要迁（清库重来），但源 KML 仍可能带旧值：导入时映射到新口径。


def _norm_site_status(v: str | None) -> str | None:
    """源 site_status 统一小写入库（#37：源值可能大写 Negative，前后端枚举均小写）；
    Unknown → undermine（红色不变，仅改名）。空值返回 None。"""
    if v is None:
        return None
    s = v.strip().lower()
    if not s:
        return None
    return "undermine" if s == "unknown" else s


def _norm_relationship(v: str | None) -> str | None:
    """源 lessor relationship=Friendly → 入库 Normal（去掉 Friendly 一态）。"""
    if v is not None and v.strip().lower() == "friendly":
        return "Normal"
    return v


def _row_id(kind: str, key: str) -> str:
    return f"{kind}:{key}"


# ---------- 行 → dict（asdict + 添加 source_file） ----------


def _site_dict(s: SiteRow, source: str) -> dict[str, Any]:
    d = {**asdict(s), "source_file": source}
    d["site_status"] = _norm_site_status(d.get("site_status"))  # F20：Unknown→undermine
    return d


def _lessor_dict(l: LessorRow, source: str) -> dict[str, Any]:
    d = {**asdict(l), "source_file": source}
    d["relationship"] = _norm_relationship(d.get("relationship"))  # F20：Friendly→Normal
    return d


def _normalize_jsonb(row: dict[str, Any]) -> dict[str, Any]:
    if "extras" in row and isinstance(row["extras"], str):
        row = {**row, "extras": json.loads(row["extras"])}
    return row


# =====================================================================
# Phase 1: POST /api/import （单文件，Spec F1 #12）
# =====================================================================


@router.post("")
async def import_file(
    file: UploadFile,
    request: Request,
    operator: str | None = Form(None),
    category: str | None = Form(None),
    type_: str | None = Form(None, alias="type"),
    target_kind: str | None = Form(None),
):
    """解析单文件 → 几何护栏 → 同文件内重复折叠 → 清洗扫描 4 类 → 算主基准。

    F20 盖戳导入（V1.x #24）：
    - target_kind（site/road/lessor）= 图层强类型，几何护栏只保留该类要素，其余跳过并报告；
      为 None 时退回 F1 全局导入行为（不护栏、不盖戳），保向后兼容（KMZ 自反测试走此路）。
    - operator/category/type = 图层盖戳值，commit 时强制写入 site 三列，源文件同名属性一律忽略。
    - #50：盖戳目标图层必须落在可见数据权限 scope 内，否则 403。
    """
    if target_kind is not None and target_kind not in ("site", "road", "lessor", "area"):
        raise HTTPException(status_code=400, detail=f"非法 target_kind：{target_kind}")
    if not import_target_visible(
        request_scopes(request), target_kind, operator, category
    ):
        raise HTTPException(
            status_code=403, detail="forbidden: 目标图层不在数据权限范围内"
        )
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
    area_pool: dict[str, dict[str, Any]] = {}  # #51：仅 target_kind=area 时填充
    # 同文件内重复统计（Spec Q2：banner 第 2 行展示）
    site_dups_groups = 0
    site_dups_discarded = 0
    lessor_dups_groups = 0
    lessor_dups_discarded = 0
    area_dups_groups = 0
    area_dups_discarded = 0
    parsed_count = 0

    try:
        data = await file.read()
        parsed = _parse(kind, data)

        # === 几何护栏（F20 V1.x #24，前置）===
        # 图层强类型：Site 层只收点 / Road 层只收线 / Lessor 层只收面 / Area 层只收面（#51）。
        # 几何类型不匹配的要素跳过 + 报告，不阻断其余导入。target_kind=None → 不护栏（F1 全局导入）。
        geometry_skipped = {"site": 0, "road": 0, "lessor": 0, "area": 0}
        if target_kind == "site":
            geometry_skipped["road"] = len(parsed.roads)
            geometry_skipped["lessor"] = len(parsed.lessors)
            geometry_skipped["area"] = len(parsed.areas)
            parsed.roads, parsed.lessors, parsed.areas = [], [], []
        elif target_kind == "road":
            geometry_skipped["site"] = len(parsed.sites)
            geometry_skipped["lessor"] = len(parsed.lessors)
            geometry_skipped["area"] = len(parsed.areas)
            parsed.sites, parsed.lessors, parsed.areas = [], [], []
        elif target_kind == "lessor":
            geometry_skipped["site"] = len(parsed.sites)
            geometry_skipped["road"] = len(parsed.roads)
            geometry_skipped["area"] = len(parsed.areas)
            parsed.sites, parsed.roads, parsed.areas = [], [], []
        elif target_kind == "area":
            geometry_skipped["site"] = len(parsed.sites)
            geometry_skipped["road"] = len(parsed.roads)
            geometry_skipped["lessor"] = len(parsed.lessors)
            parsed.sites, parsed.roads, parsed.lessors = [], [], []

        parsed_count = (
            len(parsed.sites) + len(parsed.roads)
            + len(parsed.lessors) + len(parsed.areas)
        )
        file_report["parsed"] = {
            "site": len(parsed.sites),
            "road": len(parsed.roads),
            "lessor": len(parsed.lessors),
            "area": len(parsed.areas),
        }

        # 同文件内重复折叠：同 key 后者覆盖前者（组数/丢弃数在下方按 seen 计数算）
        for s in parsed.sites:
            k = _site_key(s.site_id, s.option)
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

        # #51：area 只在 target_kind=area 时入池（F1 全局导入/其他图层不碰，保向后兼容）。
        # 盖戳 operator 在 commit 时强制写入，源属性忽略（同 F20 盖戳模型）。
        if target_kind == "area":
            for a in parsed.areas:
                k = _area_key(a.name)
                area_pool[k] = {**asdict(a), "source_file": file.filename or ""}
            area_dups_discarded = len(parsed.areas) - len(area_pool)
            seen = {}
            for a in parsed.areas:
                k = _area_key(a.name)
                seen[k] = seen.get(k, 0) + 1
            area_dups_groups = sum(1 for v in seen.values() if v > 1)

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
    # #51：area 面要素以其 ST_Centroid 质心做同一套海里/基准国判定（F13 同 site 待遇）
    geo_areas: list[dict[str, Any]] = [
        {"row_id": _row_id("area", k), "wkt": row["wkt"]}
        for k, row in area_pool.items()
        if row.get("wkt")
    ]
    try:
        async with pool().acquire() as conn:
            # 先算主基准（基线 ≥ 1 用基线，否则用本文件 geo_points）
            baseline = await compute_baseline_region(conn, current_points=geo_points)
            baseline_iso = baseline["country_iso_a2"] if baseline else None

            # 对 geo_points 做地理分类
            classified = await classify_points(conn, geo_points, baseline_iso)
            # #51：面要素质心分类（与选区导出 ST_Contains(选区, 质心) 口径一致）
            classified_areas = await classify_geoms(conn, geo_areas, baseline_iso)
    except Exception as e:
        traceback.print_exc()
        print(
            f"[import] geo classify FAILED after {time.perf_counter() - _t0:.1f}s "
            f"points={len(geo_points)} areas={len(geo_areas)} baseline_iso={baseline_iso}",
            flush=True,
        )
        raise HTTPException(
            status_code=500,
            detail=f"地理清洗失败（{len(geo_points)} 点 / {len(geo_areas)} 面）：{type(e).__name__}: {e}",
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

    # #51：area 面清洗结果 → cleanings（面以质心判定；无坐标写反/漏小数点规则——
    # 那是点列算术规则，面要素无 lati/longi 列）
    for g in geo_areas:
        cls = classified_areas.get(g["row_id"])
        if cls is None:
            continue
        rid = g["row_id"]
        row = area_pool.get(rid.split(":", 1)[1])
        if row is None:
            continue
        if cls["in_sea"]:
            cleanings.append({
                "row_id": rid,
                "kind": "area",
                "name": row["name"],
                "file_name": row["source_file"],
                "issue": "in_sea",
                "current_coord": None,
                "fixed_coord_preview": None,
                "default_action": "discard",
                "country_iso_a2": None,
            })
        elif cls["not_in_baseline"]:
            cleanings.append({
                "row_id": rid,
                "kind": "area",
                "name": row["name"],
                "file_name": row["source_file"],
                "issue": "not_in_baseline",
                "current_coord": None,
                "fixed_coord_preview": None,
                "default_action": "discard",
                "country_iso_a2": cls["country_iso_a2"],
                "country_name_zh": cls["country_name_zh"],
                "country_name_en": cls.get("country_name_en"),
            })

    # 几何护栏报告（F20）：跳过的非本类要素，供前端底部输出窗口展示
    _guard_label = {"site": "非点要素", "road": "非线要素", "lessor": "非面要素", "area": "非面要素"}
    total_skipped = sum(geometry_skipped.values())
    geometry_guard = {
        "target_kind": target_kind,
        "skipped": geometry_skipped,
        "total_skipped": total_skipped,
        "message": (
            f"几何护栏：跳过 {total_skipped} 个{_guard_label[target_kind]}"
            if target_kind and total_skipped else None
        ),
    }

    summary = {
        "total_parsed": parsed_count,
        "intra_file_duplicates": {
            "site_groups": site_dups_groups,
            "site_discarded": site_dups_discarded,
            "lessor_groups": lessor_dups_groups,
            "lessor_discarded": lessor_dups_discarded,
            "area_groups": area_dups_groups,
            "area_discarded": area_dups_discarded,
        },
        "after_dedup": {
            "site": len(site_pool),
            "road": len(road_pool),
            "lessor": len(lessor_pool),
            "area": len(area_pool),
        },
        "geometry_guard": geometry_guard,
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
            "area_pool": area_pool,
            "cleanings": cleanings,
            "baseline_region": baseline,
            # F20 盖戳上下文：commit 时取用，强制写 site 三列
            "target_kind": target_kind,
            "stamp_operator": operator,
            "stamp_category": category,
            "stamp_type": type_,
        },
        state="cleaning",
    )

    return {
        "session_id": sid,
        "file": file_report,
        "summary": summary,
        "baseline_region": baseline,
        "cleanings": cleanings,
        "geometry_guard": geometry_guard,
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
    area_pool: dict[str, dict[str, Any]] = dict(s.get("area_pool") or {})  # #51 同拷贝语义
    cleanings: list[dict[str, Any]] = s["cleanings"]

    # 应用清洗决策
    cleaning_stats = {"auto_fixed": 0, "kept": 0, "discarded": 0}
    for c in cleanings:
        if c["kind"] == "area":
            # #51：area 只参与 in_sea / not_in_baseline（质心判定），无 auto_fix 路径
            rid = c["row_id"]
            action = decisions.get(rid, c["default_action"])
            key = rid.split(":", 1)[1]
            if action == "discard":
                area_pool.pop(key, None)
                cleaning_stats["discarded"] += 1
            else:
                cleaning_stats["kept"] += 1
            continue
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
        existing_roads = await conn.fetch(
            "SELECT id, property, extras, source_file FROM road"
        )
        existing_lessors = await conn.fetch(
            "SELECT fid, lessor_name, lessor_category, relationship, extras, "
            "source_file FROM lessor"
        )
        # #51：area 冲突判定带 operator 维度（去重键 = operator+name）——
        # 只查盖戳运营商的既有面；不同运营商同名不算冲突
        existing_areas = (
            await conn.fetch(
                "SELECT id, name, operator, extras FROM area WHERE operator = $1",
                s.get("stamp_operator"),
            )
            if area_pool
            else []
        )

    existing_site_idx = {
        _site_key(r["site_id"], r["option"]): dict(r) for r in existing_sites
    }
    # F20：Road 改按 Property 去重（空 Property 无身份，不入索引 → 永远当新行插入）
    existing_road_idx: dict[str, dict[str, Any]] = {}
    for r in existing_roads:
        pk = _road_key(r["property"])
        if pk:
            existing_road_idx[pk] = dict(r)
    existing_lessor_idx = {
        _lessor_key(r["fid"]): dict(r) for r in existing_lessors
    }
    existing_area_idx = {
        _area_key(r["name"]): dict(r) for r in existing_areas
    }

    conflicts: list[dict[str, Any]] = []
    non_conflicts: dict[str, list[dict[str, Any]]] = {
        "site": [],
        "road": [],
        "lessor": [],
        "area": [],
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

    # F20：Road 纳入冲突检测（按 Property 查库判重；空 Property 永远当新行插入）
    for row in road_pool:
        pk = _road_key(row.get("property"))
        existing = existing_road_idx.get(pk) if pk else None
        if existing is None:
            non_conflicts["road"].append(row)
        else:
            existing = _normalize_jsonb(existing)
            conflicts.append({
                "key": f"road:{row.get('property')}",
                "kind": "road",
                "name": row.get("property") or "(无 Property)",
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

    # #51：area 冲突三路径（覆盖/忽略/取消导 Excel）同 F4；key 带盖戳运营商便于前端区分
    for key, row in area_pool.items():
        existing = existing_area_idx.get(key)
        if existing is None:
            non_conflicts["area"].append(row)
        else:
            existing = _normalize_jsonb(existing)
            conflicts.append({
                "key": f"area:{s.get('stamp_operator')}:{row['name']}",
                "kind": "area",
                "name": row["name"],
                "existing": existing,
                "incoming": row,
                "source_file": row["source_file"],
            })

    # 写回 session（清洗后的 pool + 计算出的 non_conflicts + conflicts）
    session_store.update(sid, {
        "site_pool_cleaned": site_pool,
        "area_pool_cleaned": area_pool,
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
            "conflict": sum(1 for c in conflicts if c["kind"] == "road"),
        },
        "lessor": {
            "non_conflict": len(non_conflicts["lessor"]),
            "conflict": sum(1 for c in conflicts if c["kind"] == "lessor"),
        },
        "area": {
            "non_conflict": len(non_conflicts["area"]),
            "conflict": sum(1 for c in conflicts if c["kind"] == "area"),
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
        # 二次提交（session 已消费/过期）→ 友好提示而非裸 404（前端已有防重入，这是兜底）
        raise HTTPException(
            status_code=409,
            detail={"error": "already_committed", "msg": "该导入已提交或已过期，请勿重复提交"},
        )
    if "non_conflicts" not in s:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_state", "msg": "尚未通过 proceed-to-conflicts"},
        )

    err = session_store.transition(sid, "committing")
    if err:
        raise HTTPException(status_code=400, detail={"error": "invalid_state", "msg": err})

    decisions = {d.key: d.action for d in body.decisions}
    # F20 盖戳值（图层强制写 site 三列；target_kind != site 时为 None → 写 NULL）
    stamp = {
        "operator": s.get("stamp_operator"),
        "category": s.get("stamp_category"),
        "type": s.get("stamp_type"),
    }
    stats = {
        "site": {"inserted": 0, "updated": 0, "ignored": 0},
        "road": {"inserted": 0, "updated": 0, "ignored": 0},
        "lessor": {"inserted": 0, "updated": 0, "ignored": 0},
        "area": {"inserted": 0, "updated": 0, "ignored": 0},
    }
    rp_id: int | None = None

    # #39：commit 进度（分批上报，单事务原子性不变——全成功 or 全回滚）。
    # 进度写内存 session_store（独立于事务），每 _EVERY 条更新一次，供前端轮询。
    non_site = s["non_conflicts"]["site"]
    non_road = s["non_conflicts"]["road"]
    non_lessor = s["non_conflicts"]["lessor"]
    non_area = s["non_conflicts"].get("area", [])
    _total = (
        len(non_site) + len(non_road) + len(non_lessor) + len(non_area)
        + len(s["conflicts"])
    )
    _done = 0
    _EVERY = 500
    session_store.set_progress(sid, 0, _total, "committing")

    baseline_established = None
    try:
        async with pool().acquire() as conn:
            async with conn.transaction():
                # F17: commit 落库前自动建恢复点（pre_import）
                rp_id = await create_restore_point(conn, "pre_import")

                for r in non_site:
                    await _insert_site(conn, r, stamp)
                    stats["site"]["inserted"] += 1
                    _done += 1
                    if _done % _EVERY == 0:
                        session_store.set_progress(sid, _done, _total, "committing")
                for r in non_road:
                    await _insert_road(conn, r)
                    stats["road"]["inserted"] += 1
                    _done += 1
                    if _done % _EVERY == 0:
                        session_store.set_progress(sid, _done, _total, "committing")
                for r in non_lessor:
                    await _insert_lessor(conn, r)
                    stats["lessor"]["inserted"] += 1
                    _done += 1
                    if _done % _EVERY == 0:
                        session_store.set_progress(sid, _done, _total, "committing")
                for r in non_area:
                    await _insert_area(conn, r, stamp)
                    stats["area"]["inserted"] += 1
                    _done += 1
                    if _done % _EVERY == 0:
                        session_store.set_progress(sid, _done, _total, "committing")

                for c in s["conflicts"]:
                    action = decisions.get(c["key"], "ignore")
                    if action == "overwrite":
                        if c["kind"] == "site":
                            await _update_site(conn, c["existing"], c["incoming"], stamp)
                            stats["site"]["updated"] += 1
                        elif c["kind"] == "road":
                            await _update_road(conn, c["existing"], c["incoming"])
                            stats["road"]["updated"] += 1
                        elif c["kind"] == "lessor":
                            await _update_lessor(conn, c["existing"], c["incoming"])
                            stats["lessor"]["updated"] += 1
                        elif c["kind"] == "area":
                            await _update_area(conn, c["existing"], c["incoming"], stamp)
                            stats["area"]["updated"] += 1
                    else:
                        stats[c["kind"]]["ignored"] += 1
                    _done += 1
                    if _done % _EVERY == 0:
                        session_store.set_progress(sid, _done, _total, "committing")

                # Spec V1.x #15：第一次 commit 成功 + site 新增 > 0 + baseline_state 空 → 固化主基准
                # 在同一事务内，确保入库 + 固化原子性
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
        # 事务上下文正常退出 = 已 COMMIT → 标完成
        session_store.set_progress(sid, _total, _total, "done")
    except Exception:
        session_store.clear_progress(sid)   # #39 坑1：回滚清进度
        raise

    # F19 审计：import + restore_point_create_auto（pre_import）
    await write_audit(
        action="import",
        details={
            "file_name": s.get("file_name"),
            "parsed_count": sum(stats[k]["inserted"] + stats[k]["updated"] + stats[k]["ignored"] for k in ("site", "road", "lessor", "area")),
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
# GET /api/import/{sid}/progress  (#39：commit 写库进度，前端轮询)
# =====================================================================


@router.get("/{sid}/progress")
async def import_progress(sid: str):
    p = session_store.get_progress(sid)
    if p is None:
        return {"done": 0, "total": 0, "pct": 0, "phase": "idle"}
    done, total = p["done"], p["total"]
    pct = int(done * 100 / total) if total > 0 else 0
    return {"done": done, "total": total, "pct": pct, "phase": p["phase"]}


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
                # #51 Phase 18 残留：road 冲突已纳入检测（F20），审计 counts 补 road 维度
                "road": sum(1 for c in conflicts if c.get("kind") == "road"),
                "lessor": sum(1 for c in conflicts if c.get("kind") == "lessor"),
                "area": sum(1 for c in conflicts if c.get("kind") == "area"),
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


async def _insert_site(conn, row: dict[str, Any], stamp: dict[str, Any] | None = None) -> None:
    # F20 盖戳：operator/category/type 强制写 stamp 值，源文件这三个属性一律忽略（将错就错）。
    stamp = stamp or {}
    await conn.execute(
        """
        INSERT INTO site (site_id, "option", project, site_status,
                          operator, category, type, lati, longi,
                          extras, source_file, geom)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
                CASE WHEN $12::text IS NULL THEN NULL
                     ELSE ST_GeomFromText($12, 4326) END)
        ON CONFLICT (site_id, "option") DO NOTHING
        """,
        row["site_id"], row["option"], row.get("project"), row.get("site_status"),
        stamp.get("operator"), stamp.get("category"), stamp.get("type"),
        row.get("lati"), row.get("longi"),
        json.dumps(row.get("extras") or {}),
        row.get("source_file"), row.get("wkt"),
    )


async def _update_site(conn, existing: dict[str, Any], row: dict[str, Any],
                       stamp: dict[str, Any] | None = None) -> None:
    # F20 盖戳：overwrite 同样强制写 stamp 三列（incoming 归属本图层导入）。
    stamp = stamp or {}
    await conn.execute(
        """
        UPDATE site SET
            site_id = $1, "option" = $2,
            project = $3, site_status = $4,
            operator = $5, category = $6, type = $7,
            lati = $8, longi = $9,
            extras = $10::jsonb, source_file = $11, updated_at = now(),
            geom = CASE WHEN $12::text IS NULL THEN NULL
                        ELSE ST_GeomFromText($12, 4326) END
        WHERE site_id = $13 AND "option" = $14
        """,
        row["site_id"], row["option"], row.get("project"), row.get("site_status"),
        stamp.get("operator"), stamp.get("category"), stamp.get("type"),
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


async def _update_road(conn, existing: dict[str, Any], row: dict[str, Any]) -> None:
    # F20：Road 按 Property 去重，overwrite 按 id 精确更新（避免同 property 多行误伤）。
    await conn.execute(
        """
        UPDATE road SET
            property = $1, extras = $2::jsonb, source_file = $3,
            geom = CASE WHEN $4::text IS NULL THEN NULL
                        ELSE ST_GeomFromText($4, 4326) END
        WHERE id = $5
        """,
        row.get("property"),
        json.dumps(row.get("extras") or {}),
        row.get("source_file"),
        row.get("wkt"),
        existing["id"],
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


# #51 F23：area 去重键 = (operator, name)，DB 级 UNIQUE 兜底；盖戳 operator 强制写
async def _insert_area(conn, row: dict[str, Any], stamp: dict[str, Any] | None = None) -> None:
    stamp = stamp or {}
    await conn.execute(
        """
        INSERT INTO area (name, operator, extras, geom)
        VALUES ($1, $2, $3::jsonb,
                CASE WHEN $4::text IS NULL THEN NULL
                     ELSE ST_GeomFromText($4, 4326) END)
        ON CONFLICT (operator, name) DO NOTHING
        """,
        row["name"], stamp.get("operator"),
        json.dumps(row.get("extras") or {}),
        row.get("wkt"),
    )


async def _update_area(conn, existing: dict[str, Any], row: dict[str, Any],
                       stamp: dict[str, Any] | None = None) -> None:
    # 覆盖路径：更新 geom + extras（冲突三路径之「覆盖」语义），盖戳运营商不变
    stamp = stamp or {}
    await conn.execute(
        """
        UPDATE area SET
            name = $1, operator = $2, extras = $3::jsonb,
            geom = CASE WHEN $4::text IS NULL THEN NULL
                        ELSE ST_GeomFromText($4, 4326) END
        WHERE operator = $5 AND name = $6
        """,
        row["name"], stamp.get("operator") or existing["operator"],
        json.dumps(row.get("extras") or {}),
        row.get("wkt"),
        existing["operator"], existing["name"],
    )
