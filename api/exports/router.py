"""KMZ 导出路由。

- GET  /api/export/all       → 整库三表全部要素 → KMZ
- POST /api/export/selection → 接收 GeoJSON polygon，PostGIS ST_Contains 严格包含过滤

文件名：export_{full|region}_{YYYYMMDD_HHMMSS}.kmz
"""

import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from audit.service import write_audit
from auth.permissions import require_perm
from auth.scopes import (
    area_scope_operators,
    can_see_lessor,
    can_see_road,
    request_scopes,
    site_scope_pairs,
    site_scope_where,
)
from core.db import pool
from exporters.kmz import build_kml, pack_kmz

# #50 Phase 12：全端点 export 功能权限门控（admin 恒过）
router = APIRouter(dependencies=[Depends(require_perm("export"))])


# ---------- SQL 模板 ----------

SITE_SQL = """
SELECT site_id, "option", project, site_status, type, lati, longi, extras, source_file,
       CASE WHEN geom IS NULL THEN NULL ELSE ST_AsKML(geom, 15) END AS geom_kml
FROM site
{where}
"""

ROAD_SQL = """
SELECT id, property, extras, source_file,
       CASE WHEN geom IS NULL THEN NULL ELSE ST_AsKML(geom, 15) END AS geom_kml
FROM road
{where}
"""

LESSOR_SQL = """
SELECT fid, lessor_name, lessor_category, relationship, extras, source_file,
       CASE WHEN geom IS NULL THEN NULL ELSE ST_AsKML(geom, 15) END AS geom_kml
FROM lessor
{where}
"""

# #51 F23：area 面导出（area 表无 source_file 列，与 site/road/lessor 不同）
AREA_SQL = """
SELECT id, name, operator, extras,
       CASE WHEN geom IS NULL THEN NULL ELSE ST_AsKML(geom, 15) END AS geom_kml
FROM area
{where}
"""

# 选区过滤：ST_Contains(选区, geom) 严格包含（点在边界上不算）
CONTAINS_CLAUSE = "WHERE geom IS NOT NULL AND ST_Contains(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), geom)"
# #51：area 选区口径 = ST_Contains(选区, ST_Centroid(geom))，与清洗质心判定一致
AREA_CONTAINS_CLAUSE = "WHERE geom IS NOT NULL AND ST_Contains(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), ST_Centroid(geom))"

# #46：NP 范围圈半径白名单（米），与前端 NP_RADIUS_OPTIONS 一致。非白名单值回落默认 200。
NP_RADIUS_OPTIONS = (50, 100, 150, 200, 250)
DEFAULT_NP_RADIUS_M = 200


def _sanitize_np_radius(v: int) -> int:
    return v if v in NP_RADIUS_OPTIONS else DEFAULT_NP_RADIUS_M


# #48 勾选导出：按主键 (site_id,"option") 子集取 site，列别名与 SITE_SQL 对齐供 build_kml 复用
SITE_BY_KEYS_SQL = """
SELECT site_id, "option", project, site_status, type, lati, longi, extras, source_file,
       CASE WHEN geom IS NULL THEN NULL ELSE ST_AsKML(geom, 15) END AS geom_kml
FROM site
WHERE (site_id, "option") IN (SELECT * FROM unnest($1::text[], $2::text[]))
"""


def _area_where(where: str) -> str:
    """#51：area 选区过滤用质心口径（AREA_CONTAINS_CLAUSE），整库导出原样（空串）。"""
    return AREA_CONTAINS_CLAUSE if where == CONTAINS_CLAUSE else where


async def _fetch_rows(where: str, params: tuple) -> dict[str, list[dict[str, Any]]]:
    async with pool().acquire() as conn:
        sites = await conn.fetch(SITE_SQL.format(where=where), *params)
        roads = await conn.fetch(ROAD_SQL.format(where=where), *params)
        lessors = await conn.fetch(LESSOR_SQL.format(where=where), *params)
        areas = await conn.fetch(AREA_SQL.format(where=_area_where(where)), *params)
    return {
        "site": [dict(r) for r in sites],
        "road": [dict(r) for r in roads],
        "lessor": [dict(r) for r in lessors],
        "area": [dict(r) for r in areas],
    }


def _scope_filter_needed(scopes: list[str]) -> bool:
    """全量可见（site 无限制 + road + lessor + area 无限制）→ False，走原 _fetch_rows 路径。"""
    return (
        site_scope_pairs(scopes) is not None
        or not can_see_road(scopes)
        or not can_see_lessor(scopes)
        or area_scope_operators(scopes) is not None
    )


async def _fetch_rows_scoped(
    where: str, params: tuple, scopes: list[str]
) -> dict[str, list[dict[str, Any]]]:
    """#50 Phase 12：数据权限过滤版取数。

    site 追加 scope WHERE（参数接在已有 params 之后）；road/lessor 不可见 → 空列表。
    #51：area 按可见运营商集合过滤（area_scope_operators 口径；空集 → 空列表）。
    """
    frag, sparams = site_scope_where(scopes, start_idx=len(params) + 1)
    if where:
        site_where = f"{where} AND ({frag})" if frag else where
    else:
        site_where = f"WHERE {frag}" if frag else ""

    # area：可见运营商集合 → operator = ANY($n) 追加在选区/整库 where 之后
    ops = area_scope_operators(scopes)
    area_where = _area_where(where)
    if ops is not None:
        op_idx = len(params) + 1
        clause = f"operator = ANY(${op_idx}::text[])"
        area_where = f"{area_where} AND {clause}" if area_where else f"WHERE {clause}"

    async with pool().acquire() as conn:
        sites = await conn.fetch(SITE_SQL.format(where=site_where), *params, *sparams)
        roads = (
            await conn.fetch(ROAD_SQL.format(where=where), *params)
            if can_see_road(scopes)
            else []
        )
        lessors = (
            await conn.fetch(LESSOR_SQL.format(where=where), *params)
            if can_see_lessor(scopes)
            else []
        )
        areas = (
            await conn.fetch(
                AREA_SQL.format(where=area_where),
                *params,
                *([sorted(ops)] if ops is not None else []),
            )
            if ops is None or ops
            else []
        )
    return {
        "site": [dict(r) for r in sites],
        "road": [dict(r) for r in roads],
        "lessor": [dict(r) for r in lessors],
        "area": [dict(r) for r in areas],
    }


def _build_kmz_meta(
    label: str, data: dict[str, list[dict[str, Any]]], np_radius_m: int = DEFAULT_NP_RADIUS_M
) -> tuple[str, bytes, dict[str, int]]:
    kml = build_kml(
        data["site"], data["road"], data["lessor"],
        np_radius_m=np_radius_m, area_rows=data.get("area") or [],
    )
    kmz_bytes = pack_kmz(kml)
    fname = f"export_{label}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.kmz"
    counts = {
        "site": len(data["site"]),
        "road": len(data["road"]),
        "lessor": len(data["lessor"]),
        "area": len(data.get("area") or []),
    }
    return fname, kmz_bytes, counts


def _kmz_response(fname: str, kmz_bytes: bytes) -> Response:
    return Response(
        content=kmz_bytes,
        media_type="application/vnd.google-earth.kmz",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "X-Filename": fname,
        },
    )


# ---------- /api/export/all ----------


@router.get("/all")
async def export_all(request: Request, np_radius_m: int = DEFAULT_NP_RADIUS_M):
    np_radius_m = _sanitize_np_radius(np_radius_m)
    scopes = request_scopes(request)
    if _scope_filter_needed(scopes):
        data = await _fetch_rows_scoped("", (), scopes)
    else:
        data = await _fetch_rows("", ())
    fname, kmz_bytes, counts = _build_kmz_meta("full", data, np_radius_m)
    await write_audit(
        action="export_full",
        details={"file_name": fname, "counts": counts, "bytes": len(kmz_bytes)},
        request=request,
    )
    return _kmz_response(fname, kmz_bytes)


# ---------- /api/export/selection ----------


# #47：选区绘制模式白名单（审计用）。非法值回落 polygon。
SELECTION_MODES = ("polygon", "rect", "circle")


class SelectionBody(BaseModel):
    polygon: dict[str, Any]  # GeoJSON Polygon
    np_radius_m: int = DEFAULT_NP_RADIUS_M  # #46：当前 NP 半径，缺省 200
    mode: str = "polygon"  # #47：选区模式 polygon|rect|circle，仅记审计，不参与过滤


@router.post("/selection")
async def export_selection(body: SelectionBody, request: Request):
    poly = body.polygon
    if not isinstance(poly, dict) or poly.get("type") != "Polygon":
        raise HTTPException(status_code=400, detail="polygon 必须是 GeoJSON Polygon 对象")
    coords = poly.get("coordinates")
    if (
        not isinstance(coords, list)
        or not coords
        or not isinstance(coords[0], list)
        or not coords[0]
    ):
        raise HTTPException(status_code=400, detail="polygon.coordinates 必须是非空 LinearRing 列表")
    np_radius_m = _sanitize_np_radius(body.np_radius_m)
    mode = body.mode if body.mode in SELECTION_MODES else "polygon"  # #47：审计 mode，非法回落
    scopes = request_scopes(request)
    if _scope_filter_needed(scopes):
        data = await _fetch_rows_scoped(CONTAINS_CLAUSE, (json.dumps(poly),), scopes)
    else:
        data = await _fetch_rows(CONTAINS_CLAUSE, (json.dumps(poly),))
    fname, kmz_bytes, counts = _build_kmz_meta("region", data, np_radius_m)
    # Spec 雷 33：导出字段只记类型/文件名/数据计数 + 选区模式（#47），不记选区 WKT 几何
    await write_audit(
        action="export_region",
        details={"file_name": fname, "counts": counts, "bytes": len(kmz_bytes), "mode": mode},
        request=request,
    )
    return _kmz_response(fname, kmz_bytes)


# ---------- /api/export/selection_ids（#48 勾选导出） ----------


class SelectionKey(BaseModel):
    site_id: str
    option: str = ""


class SelectionIdsBody(BaseModel):
    keys: list[SelectionKey]
    np_radius_m: int = DEFAULT_NP_RADIUS_M  # #46：NP 圈半径随点带


@router.post("/selection_ids")
async def export_selection_ids(body: SelectionIdsBody, request: Request):
    """勾选导出：仅导出选中 site 子集（road/lessor 不参与），scope=region。

    #50 Phase 12：越权主键跳过——scope WHERE 直接并入查询（全量 scope 走原 SQL）。
    """
    if not body.keys:
        raise HTTPException(status_code=400, detail="keys 不能为空")
    np_radius_m = _sanitize_np_radius(body.np_radius_m)
    site_ids = [k.site_id for k in body.keys]
    options = [k.option for k in body.keys]

    scopes = request_scopes(request)
    async with pool().acquire() as conn:
        if site_scope_pairs(scopes) is not None:
            frag, sparams = site_scope_where(scopes, start_idx=3)
            sql = f"{SITE_BY_KEYS_SQL} AND ({frag})"
            rows = await conn.fetch(sql, site_ids, options, *sparams)
        else:
            rows = await conn.fetch(SITE_BY_KEYS_SQL, site_ids, options)
    data: dict[str, list[dict[str, Any]]] = {
        "site": [dict(r) for r in rows],
        "road": [],
        "lessor": [],
        "area": [],  # #51：勾选导出仅 site 子集，area 不参与（与 road/lessor 同口径）
    }

    fname, kmz_bytes, counts = _build_kmz_meta("region", data, np_radius_m)
    await write_audit(
        action="export_region",
        details={"file_name": fname, "counts": counts, "bytes": len(kmz_bytes), "mode": "list"},
        request=request,
    )
    return _kmz_response(fname, kmz_bytes)
