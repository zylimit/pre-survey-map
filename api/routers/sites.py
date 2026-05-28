import json

from fastapi import APIRouter

from db import pool

router = APIRouter()


@router.get("")
async def list_sites():
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT site_id, "option", project, site_status, lati, longi,
                   extras, source_file,
                   CASE WHEN geom IS NULL THEN NULL ELSE ST_AsGeoJSON(geom) END AS geojson
            FROM site
            """
        )

    features = []
    for r in rows:
        props = {
            "kind": "site",
            "site_id": r["site_id"],
            "option": r["option"],
            "project": r["project"],
            "site_status": r["site_status"],
            "lati": r["lati"],
            "longi": r["longi"],
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
            "id": f"site:{r['site_id']}:{r['option']}",
            "geometry": json.loads(r["geojson"]) if r["geojson"] else None,
            "properties": props,
        })

    return {"type": "FeatureCollection", "features": features}
