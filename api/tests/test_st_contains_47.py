"""#47 选区导出 —— ST_Contains 空间谓词契约测试（连真库，可 skip）。

核心价值：验证 #47 选区"严格包含"语义（exports.py::CONTAINS_CLAUSE 用的谓词），
即 ST_Contains(ST_SetSRID(ST_GeomFromGeoJSON(选区), 4326), 点)：
- 圆心点（明显在内）→ True
- 远离圆的点 → False
- 多边形顶点（边界上）→ False（ST_Contains 严格，边界不算 contains）

不碰任何业务表（site/road/lessor），只跑自包含 SQL，仅验证 PostGIS 谓词行为。
DB 不可用时整文件 skip，不让 db 缺失把测试套件搞红。
"""

import asyncio
import math
import os

import pytest

# asyncpg 缺失 → 整文件跳过
asyncpg = pytest.importorskip("asyncpg")

# 被测常量：用于绑定本集成测试验证的谓词就是 exports.CONTAINS_CLAUSE 所用谓词
from routers import exports  # 置于 importorskip 后，避免 asyncpg 缺失时被导入链卡住


# 圆参数（近似圆多边形）
CENTER_LNG = 121.0
CENTER_LAT = 14.5
RADIUS_DEG = 0.01
SEGMENTS = 32


def _circle_polygon_geojson() -> str:
    """生成一个近似圆的闭合 GeoJSON Polygon 字符串（用于 ST_GeomFromGeoJSON）。"""
    import json

    ring = []
    for i in range(SEGMENTS):
        theta = 2.0 * math.pi * i / SEGMENTS
        lng = CENTER_LNG + RADIUS_DEG * math.cos(theta)
        lat = CENTER_LAT + RADIUS_DEG * math.sin(theta)
        ring.append([lng, lat])
    ring.append(ring[0])  # 闭合
    return json.dumps({"type": "Polygon", "coordinates": [ring]})


def _candidate_dsns() -> list[str]:
    """连库候选：优先容器内 env（DB_HOST=db:5432），回退宿主 localhost:5433。"""
    user = os.getenv("DB_USER", "presurvey")
    pwd = os.getenv("DB_PASSWORD", "postgres")
    name = os.getenv("DB_NAME", "presurvey")
    dsns = []
    # 1) 按当前环境 env（容器内为 db:5432）
    host = os.getenv("DB_HOST", "db")
    port = os.getenv("DB_PORT", "5432")
    dsns.append(f"postgresql://{user}:{pwd}@{host}:{port}/{name}")
    # 2) 宿主直连映射端口
    dsns.append(f"postgresql://{user}:{pwd}@localhost:5433/{name}")
    dsns.append(f"postgresql://{user}:{pwd}@127.0.0.1:5433/{name}")
    # 去重保序
    seen = set()
    out = []
    for d in dsns:
        if d not in seen:
            seen.add(d)
            out.append(d)
    return out


async def _connect():
    last_err = None
    for dsn in _candidate_dsns():
        try:
            return await asyncio.wait_for(asyncpg.connect(dsn=dsn), timeout=5.0)
        except Exception as e:  # noqa: BLE001 — 探测多个候选，逐个尝试
            last_err = e
            continue
    raise last_err if last_err else RuntimeError("no dsn candidates")


@pytest.fixture
def _loop():
    """专用事件循环，确保连接与查询在同一 loop 上执行。

    刻意不叫 event_loop：该名为 pytest-asyncio 保留 fixture，撞名会触发弃用告警/语义冲突。
    """
    loop = asyncio.new_event_loop()
    try:
        yield loop
    finally:
        loop.close()


@pytest.fixture
def db_conn(_loop):
    """提供一个真库连接；连不上则 skip 整个用例。"""
    try:
        conn = _loop.run_until_complete(_connect())
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"PostGIS 不可达，跳过 ST_Contains 集成测试：{e!r}")
    try:
        yield conn
    finally:
        _loop.run_until_complete(conn.close())


async def _contains_point(conn, geojson: str, lng: float, lat: float) -> bool:
    return await conn.fetchval(
        """
        SELECT ST_Contains(
            ST_SetSRID(ST_GeomFromGeoJSON($1), 4326),
            ST_SetSRID(ST_MakePoint($2, $3), 4326)
        )
        """,
        geojson,
        lng,
        lat,
    )


@pytest.mark.integration
def test_st_contains_strict_inclusion(db_conn, _loop):
    """验证 ST_Contains 对圆形选区的严格包含语义（#47 谓词契约）。"""
    # 绑定被测常量：确认本测真库验证的谓词正是 exports.CONTAINS_CLAUSE 所用谓词，
    # 防止实现把 ST_Contains/ST_GeomFromGeoJSON 换掉而本套件仍假绿。
    assert "ST_Contains" in exports.CONTAINS_CLAUSE
    assert "ST_GeomFromGeoJSON" in exports.CONTAINS_CLAUSE

    geojson = _circle_polygon_geojson()
    loop = _loop

    # 1) 圆心点 → 明显在内 → True
    inside = loop.run_until_complete(
        _contains_point(db_conn, geojson, CENTER_LNG, CENTER_LAT)
    )
    assert inside is True, "圆心点应被 ST_Contains 判为包含"

    # 2) 远离圆的点 → False
    outside = loop.run_until_complete(
        _contains_point(db_conn, geojson, 122.0, 15.0)
    )
    assert outside is False, "远离圆的点应被判为不包含"

    # 3) 多边形顶点（边界上）→ False（ST_Contains 严格，边界不算）
    vertex_lng = CENTER_LNG + RADIUS_DEG  # theta=0 处的顶点
    vertex_lat = CENTER_LAT
    on_boundary = loop.run_until_complete(
        _contains_point(db_conn, geojson, vertex_lng, vertex_lat)
    )
    assert on_boundary is False, "边界顶点应被 ST_Contains 判为不包含（严格语义）"
