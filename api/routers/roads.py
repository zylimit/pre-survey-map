import json

from fastapi import APIRouter, Request

from auth.scopes import can_see_road, request_scopes
from db import pool

router = APIRouter()


@router.get("")
async def list_roads(request: Request):
    # #50 Phase 12：数据权限——road 不可见 → 空 FeatureCollection（不查库）
    if not can_see_road(request_scopes(request)):
        return {"type": "FeatureCollection", "features": []}
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, property, extras, source_file,
                   CASE WHEN geom IS NULL THEN NULL ELSE ST_AsGeoJSON(geom) END AS geojson
            FROM road
            """
        )

    features = []
    for r in rows:
        props = {
            "kind": "road",
            "id": r["id"],
            "property": r["property"],
            "source_file": r["source_file"],
        }
        extras = r["extras"]
        if isinstance(extras, str):
            extras = json.loads(extras)
        if extras:
            for k, v in extras.items():
                props.setdefault(k, v)
        features.append({
            "type": "Feature",
            "id": f"road:{r['id']}",
            "geometry": json.loads(r["geojson"]) if r["geojson"] else None,
            "properties": props,
        })

    return {"type": "FeatureCollection", "features": features}
