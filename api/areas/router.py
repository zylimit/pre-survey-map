"""#51 F23：AREA 运营商区域面图层只读列表（本期不做增删改）。

scope 过滤：operator ∈ 可见运营商集合（site:<op> 或 site:<op>:AREA 授予）；
admin / site 根全量。参照 lessors/router.py 结构。
"""

import json

from fastapi import APIRouter, Request

from auth.scopes import area_scope_operators, request_scopes
from core.db import pool

router = APIRouter()


@router.get("")
async def list_areas(request: Request):
    ops = area_scope_operators(request_scopes(request))
    # 可见运营商为空集 → 空 FeatureCollection（不查库）
    if ops is not None and not ops:
        return {"type": "FeatureCollection", "features": []}
    async with pool().acquire() as conn:
        if ops is None:
            rows = await conn.fetch(
                """
                SELECT id, name, operator, extras,
                       CASE WHEN geom IS NULL THEN NULL ELSE ST_AsGeoJSON(geom) END AS geojson
                FROM area
                """
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id, name, operator, extras,
                       CASE WHEN geom IS NULL THEN NULL ELSE ST_AsGeoJSON(geom) END AS geojson
                FROM area
                WHERE operator = ANY($1::text[])
                """,
                sorted(ops),
            )

    features = []
    for r in rows:
        props = {
            "kind": "area",
            "id": r["id"],
            "name": r["name"],
            "operator": r["operator"],
        }
        extras = r["extras"]
        if isinstance(extras, str):
            extras = json.loads(extras)
        if extras:
            for k, v in extras.items():
                props.setdefault(k, v)
        features.append({
            "type": "Feature",
            "id": f"area:{r['id']}",
            "geometry": json.loads(r["geojson"]) if r["geojson"] else None,
            "properties": props,
        })

    return {"type": "FeatureCollection", "features": features}
