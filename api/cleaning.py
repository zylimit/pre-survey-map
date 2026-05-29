"""数据清洗 + 主基准区域算法（Spec V1.x #12 F13）。

四类清洗（Spec「数据清洗规则」节）：
  1. 坐标写反（LAT/LONG 颠倒）
  2. 坐标漏小数点
  3. 在海里（1km buffer 外无任何国家）
  4. 不在主基准区域（在某国陆地 1km 内但不在基线国家 1km 内）

主基准（Spec「主基准区域算法」节）：
  基线已有 ≥ 1 个 site → 用基线统计国家分布
  基线为空 → 用本次导入点位算
  70% 阈值，无 70% 取最大占比
"""

from typing import Any, Optional

BUFFER_DEG = 0.01  # ≈ 1.1km @ 赤道，容错 NE 10m 漏掉的小岛
BASELINE_THRESHOLD = 0.70  # 70% 阈值


# ---------- 4 类清洗判定（纯 Python，不依赖 DB） ----------


def detect_swap_or_missing_decimal(lati: Optional[float], longi: Optional[float]) -> Optional[str]:
    """坐标写反 / 漏小数点二选一。

    返回 "swap_latlong" / "missing_decimal" / None。
    """
    if lati is None or longi is None:
        return None
    lat_ok = -90.0 <= lati <= 90.0
    lon_ok = -180.0 <= longi <= 180.0

    if lat_ok and lon_ok:
        return None

    # 写反：LATI 越界但 LONGI 合法，且两者交换后都合法
    if not lat_ok and lon_ok:
        if -90.0 <= longi <= 90.0 and -180.0 <= lati <= 180.0:
            return "swap_latlong"

    # 其他越界 = 漏小数点（无法自动修）
    return "missing_decimal"


# ---------- DB 辅助：用 PostGIS 算 in_sea / not_in_baseline / 国家归属 ----------


async def classify_points(conn, points: list[dict[str, Any]],
                           baseline_iso_a2: Optional[str]) -> dict[str, dict[str, Any]]:
    """对一批合法坐标的点（lng/lat 在范围内），批量算：
      - country_iso_a2：所属国家（按 ST_DWithin 0.01 度）
      - in_sea：True 即 1km 内不在任何国家
      - not_in_baseline：True 即在某国但不在基线国家

    points: [{"row_id": ..., "lng": ..., "lat": ...}]
    返回 {row_id: {"country_iso_a2", "country_name_zh", "in_sea", "not_in_baseline"}}
    """
    if not points:
        return {}

    # 单次往返：用 VALUES 子句把所有点喂进 PostGIS LATERAL 关联到 countries
    values_sql = ",".join(
        f"(${i*3+1}::text, ${i*3+2}::float8, ${i*3+3}::float8)"
        for i in range(len(points))
    )
    args = []
    for p in points:
        args.extend([p["row_id"], p["lng"], p["lat"]])

    # 取距离最近的国家（即使在海里也取一个最近的，方便展示；in_sea 由 0.01 buffer 内是否有命中判定）
    rows = await conn.fetch(
        f"""
        WITH pts(row_id, lng, lat) AS (VALUES {values_sql}),
        pts_geom AS (
            SELECT row_id, ST_SetSRID(ST_MakePoint(lng, lat), 4326) AS g FROM pts
        )
        SELECT
            p.row_id,
            (
                SELECT c.iso_a2 FROM countries c
                WHERE ST_DWithin(p.g, c.geom, {BUFFER_DEG})
                ORDER BY c.geom <-> p.g LIMIT 1
            ) AS country_iso_a2,
            (
                SELECT c.name_zh FROM countries c
                WHERE ST_DWithin(p.g, c.geom, {BUFFER_DEG})
                ORDER BY c.geom <-> p.g LIMIT 1
            ) AS country_name_zh
        FROM pts_geom p
        """,
        *args,
    )

    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        rid = r["row_id"]
        country = r["country_iso_a2"]
        in_sea = country is None
        not_in_baseline = (
            (not in_sea)
            and baseline_iso_a2 is not None
            and country != baseline_iso_a2
        )
        out[rid] = {
            "country_iso_a2": country,
            "country_name_zh": r["country_name_zh"],
            "in_sea": in_sea,
            "not_in_baseline": not_in_baseline,
        }
    return out


# ---------- 主基准区域计算 ----------


async def compute_baseline_region(conn,
                                  current_points: Optional[list[dict[str, Any]]] = None
                                  ) -> Optional[dict[str, Any]]:
    """先入为主：基线有 ≥ 1 个 site 用基线，否则用 current_points。

    返回 {country_iso_a2, country_name_zh, source, coverage_pct, points_used, points_total}
    或 None（基线为空且 current_points 也为空）。
    """
    # 基线模式
    total = await conn.fetchval("SELECT count(*) FROM site")
    if total and total >= 1:
        country = await _country_dist_in_db(conn)
        if country is None:
            # 库里有点但全在海里 / 全无 geom → 退化
            return {
                "country_iso_a2": None,
                "country_name_zh": None,
                "source": "baseline",
                "coverage_pct": 0,
                "points_used": 0,
                "points_total": total,
            }
        country["source"] = "baseline"
        country["points_total"] = total
        return country

    # current_file 模式
    if not current_points:
        return None
    country = await _country_dist_in_current(conn, current_points)
    if country is None:
        return {
            "country_iso_a2": None,
            "country_name_zh": None,
            "source": "current_file",
            "coverage_pct": 0,
            "points_used": 0,
            "points_total": len(current_points),
        }
    country["source"] = "current_file"
    country["points_total"] = len(current_points)
    return country


async def _country_dist_in_db(conn) -> Optional[dict[str, Any]]:
    """统计 site 表里每个点最近国家分布，应用 70% 阈值。"""
    rows = await conn.fetch(
        f"""
        WITH site_country AS (
            SELECT
                s.site_id,
                (
                    SELECT c.iso_a2 FROM countries c
                    WHERE ST_DWithin(s.geom, c.geom, {BUFFER_DEG})
                    ORDER BY c.geom <-> s.geom LIMIT 1
                ) AS iso_a2
            FROM site s WHERE s.geom IS NOT NULL
        )
        SELECT iso_a2, count(*) AS cnt FROM site_country
        WHERE iso_a2 IS NOT NULL
        GROUP BY iso_a2
        ORDER BY cnt DESC
        """,
    )
    return await _pick_country(conn, rows)


async def _country_dist_in_current(conn, points: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """统计 current_points 国家分布。"""
    classified = await classify_points(conn, points, baseline_iso_a2=None)
    counts: dict[str, int] = {}
    for cls in classified.values():
        c = cls.get("country_iso_a2")
        if c:
            counts[c] = counts.get(c, 0) + 1
    if not counts:
        return None
    rows = sorted(counts.items(), key=lambda kv: -kv[1])
    rows = [{"iso_a2": k, "cnt": v} for k, v in rows]
    return await _pick_country(conn, rows)


async def _pick_country(conn, rows) -> Optional[dict[str, Any]]:
    """从国家分布 [{iso_a2, cnt}, ...] 按 70% 阈值挑主基准，无则取最大。"""
    if not rows:
        return None
    total_classified = sum(r["cnt"] for r in rows)
    if total_classified == 0:
        return None

    # 70% 阈值
    for r in rows:
        pct = r["cnt"] / total_classified
        if pct >= BASELINE_THRESHOLD:
            name_zh = await _country_name_zh(conn, r["iso_a2"])
            return {
                "country_iso_a2": r["iso_a2"],
                "country_name_zh": name_zh,
                "coverage_pct": round(pct * 100),
                "points_used": r["cnt"],
            }

    # 无 70% → 取最大占比
    top = rows[0]
    pct = top["cnt"] / total_classified
    name_zh = await _country_name_zh(conn, top["iso_a2"])
    return {
        "country_iso_a2": top["iso_a2"],
        "country_name_zh": name_zh,
        "coverage_pct": round(pct * 100),
        "points_used": top["cnt"],
    }


async def _country_name_zh(conn, iso_a2: str) -> Optional[str]:
    return await conn.fetchval(
        "SELECT name_zh FROM countries WHERE iso_a2 = $1 LIMIT 1", iso_a2
    )
