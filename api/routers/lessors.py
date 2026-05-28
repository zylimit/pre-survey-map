import json

from fastapi import APIRouter

from db import pool

router = APIRouter()


@router.get("")
async def list_lessors():
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT fid, lessor_name, lessor_category, relationship,
                   extras, source_file,
                   CASE WHEN geom IS NULL THEN NULL ELSE ST_AsGeoJSON(geom) END AS geojson
            FROM lessor
            """
        )

    features = []
    for r in rows:
        props = {
            "kind": "lessor",
            "fid": r["fid"],
            "lessor_name": r["lessor_name"],
            "lessor_category": r["lessor_category"],
            "relationship": r["relationship"],
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
            "id": f"lessor:{r['fid']}",
            "geometry": json.loads(r["geojson"]) if r["geojson"] else None,
            "properties": props,
        })

    return {"type": "FeatureCollection", "features": features}
