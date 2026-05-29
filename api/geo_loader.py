"""Natural Earth countries 数据加载器（Spec V1.x #12）。

api 启动时检查 countries 表：空则从 /app/geo_data/ne_10m_admin_0_countries.geojson
一次性入库；非空跳过。无 GeoJSON 文件时 graceful degrade（只 log warn，不阻塞启动）。
"""

import json
import logging
import os
from typing import Optional

logger = logging.getLogger("geo_loader")

GEOJSON_PATH = "/app/geo_data/ne_10m_admin_0_countries.geojson"


async def ensure_countries_loaded(pool) -> Optional[int]:
    """检测 countries 表行数，0 就从 GeoJSON 加载。

    返回加载后行数；GeoJSON 不存在返回 None。
    """
    async with pool.acquire() as conn:
        try:
            count = await conn.fetchval("SELECT count(*) FROM countries")
        except Exception as e:
            logger.warning(f"countries 表查询失败（表可能不存在）：{e}")
            return None

        if count and count > 0:
            logger.info(f"countries 表已有 {count} 行，跳过加载")
            return count

        if not os.path.exists(GEOJSON_PATH):
            logger.warning(
                f"countries 表为空但 {GEOJSON_PATH} 不存在，地理判定将退化（in_sea / not_in_baseline 不触发）"
            )
            return None

        logger.info(f"countries 表为空，从 {GEOJSON_PATH} 加载...")
        with open(GEOJSON_PATH, encoding="utf-8") as f:
            data = json.load(f)

        features = data.get("features", [])
        inserted = 0
        async with conn.transaction():
            for feat in features:
                props = feat.get("properties", {}) or {}
                geom = feat.get("geometry")
                if not geom:
                    continue
                # ST_Multi 把 Polygon 也统一成 MultiPolygon
                await conn.execute(
                    """
                    INSERT INTO countries (iso_a2, iso_a3, name, name_en, name_zh, admin, geom)
                    VALUES ($1, $2, $3, $4, $5, $6,
                            ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($7), 4326)))
                    """,
                    props.get("ISO_A2"),
                    props.get("ISO_A3"),
                    props.get("NAME"),
                    props.get("NAME_EN"),
                    props.get("NAME_ZH"),
                    props.get("ADMIN"),
                    json.dumps(geom),
                )
                inserted += 1

        logger.info(f"已加载 {inserted} 个国家到 countries 表")
        return inserted
