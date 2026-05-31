"""KMZ 导出路由。

- GET  /api/export/all       → 整库三表全部要素 → KMZ
- POST /api/export/selection → 接收 GeoJSON polygon，PostGIS ST_Contains 严格包含过滤

文件名：export_{full|region}_{YYYYMMDD_HHMMSS}.kmz
"""

import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from audit import write_audit
from db import pool
from exporters.kmz import build_kml, pack_kmz

router = APIRouter()


# ---------- SQL 模板 ----------

SITE_SQL = """
SELECT site_id, "option", project, site_status, lati, longi, extras, source_file,
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

# 选区过滤：ST_Contains(选区, geom) 严格包含（点在边界上不算）
CONTAINS_CLAUSE = "WHERE geom IS NOT NULL AND ST_Contains(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), geom)"


async def _fetch_rows(where: str, params: tuple) -> dict[str, list[dict[str, Any]]]:
    async with pool().acquire() as conn:
        sites = await conn.fetch(SITE_SQL.format(where=where), *params)
        roads = await conn.fetch(ROAD_SQL.format(where=where), *params)
        lessors = await conn.fetch(LESSOR_SQL.format(where=where), *params)
    return {
        "site": [dict(r) for r in sites],
        "road": [dict(r) for r in roads],
        "lessor": [dict(r) for r in lessors],
    }


def _build_kmz_meta(label: str, data: dict[str, list[dict[str, Any]]]) -> tuple[str, bytes, dict[str, int]]:
    kml = build_kml(data["site"], data["road"], data["lessor"])
    kmz_bytes = pack_kmz(kml)
    fname = f"export_{label}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.kmz"
    counts = {
        "site": len(data["site"]),
        "road": len(data["road"]),
        "lessor": len(data["lessor"]),
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
async def export_all(request: Request):
    data = await _fetch_rows("", ())
    fname, kmz_bytes, counts = _build_kmz_meta("full", data)
    await write_audit(
        action="export_full",
        details={"file_name": fname, "counts": counts, "bytes": len(kmz_bytes)},
        request=request,
    )
    return _kmz_response(fname, kmz_bytes)


# ---------- /api/export/selection ----------


class SelectionBody(BaseModel):
    polygon: dict[str, Any]  # GeoJSON Polygon


@router.post("/selection")
async def export_selection(body: SelectionBody, request: Request):
    poly = body.polygon
    if not isinstance(poly, dict) or poly.get("type") != "Polygon":
        raise HTTPException(status_code=400, detail="polygon 必须是 GeoJSON Polygon 对象")
    data = await _fetch_rows(CONTAINS_CLAUSE, (json.dumps(poly),))
    fname, kmz_bytes, counts = _build_kmz_meta("region", data)
    # Spec 雷 33：导出字段只记类型/文件名/数据计数，不记选区 WKT 几何
    await write_audit(
        action="export_region",
        details={"file_name": fname, "counts": counts, "bytes": len(kmz_bytes)},
        request=request,
    )
    return _kmz_response(fname, kmz_bytes)
