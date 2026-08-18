"""#47 圆形框选导出 —— 圆形几何语义 + 全链路回归测试（不连真库）。

补的测试债：#47 当时无测试就部署（progress.md TODO #1）。

与既有两个 #47 测试文件的分工：
- test_selection_export_47.py：通用选区契约（polygon 校验 / mode 白名单 / np_radius 回落），
  其 circle 用例只用**方形** polygon 记审计，不碰圆形几何本身。
- test_st_contains_47.py：32 段近似圆 + ST_Contains 真库集成测试，docker 套件内 skip。
- 本文件：前端真实管线形状（3857 下 fromCircle(circle, 64) → transform 4326 的
  内接 64 边形）在「严格包含」语义下的边界行为（用 shapely/GEOS 做 PostGIS 同语义代理，
  不连库、套件内真跑），+ mode=circle 带真实圆形几何走 handler 全链路，
  + 受限 scope 用户走 _fetch_rows_scoped 时谓词/几何不丢。

两层范式：
A. 几何语义层 —— shapely（GEOS）。ST_Contains 与 shapely contains 同为 GEOS/OGC
   「contains：内部相交且边界不算」语义，且后端用 geometry(4326) 平面计算，
   与 shapely 在度数坐标下的计算模型一致，代理有效。
B. handler 层 —— monkeypatch 直调 export_selection，对齐 test_selection_export_47.py。
"""

import asyncio
import json
import math

import pytest
from shapely.geometry import Point, Polygon

from exports import router as exports
from exports.router import SelectionBody, export_selection

# ---------- 前端管线复刻（web/src/components/MapView.tsx:415） ----------
# drawend: geom 是 ol/geom Circle（3857，单位米）→ fromCircle(geom, 64) 转内接 64 边形
# → clone().transform("EPSG:3857", "EPSG:4326") → GeoJSON Polygon 发后端。

EARTH_R = 6378137.0  # EPSG:3857 球半径（米）
CENTER_LNG = 121.0
CENTER_LAT = 14.5
RADIUS_M = 500.0
SEGMENTS = 64  # MapView.tsx:415 fromCircle(geom, 64)


def _to_3857(lng: float, lat: float) -> tuple[float, float]:
    lam = math.radians(lng)
    phi = math.radians(lat)
    return EARTH_R * lam, EARTH_R * math.log(math.tan(math.pi / 4 + phi / 2))


def _to_4326(x: float, y: float) -> tuple[float, float]:
    lng = math.degrees(x / EARTH_R)
    lat = math.degrees(2 * math.atan(math.exp(y / EARTH_R)) - math.pi / 2)
    return lng, lat


def _meters_offset_to_4326(cx: float, cy: float, dx_m: float, dy_m: float) -> list[float]:
    """3857 坐标下圆心 + 米偏移 → 4326 [lng, lat]（模拟「距圆心 X 米的站点」）。"""
    return list(_to_4326(cx + dx_m, cy + dy_m))


def _circle_polygon_4326(
    center_lng: float = CENTER_LNG,
    center_lat: float = CENTER_LAT,
    radius_m: float = RADIUS_M,
    segments: int = SEGMENTS,
) -> dict:
    """复刻前端产物：3857 下 fromCircle(64) → transform 4326 的闭合 GeoJSON Polygon。"""
    cx, cy = _to_3857(center_lng, center_lat)
    ring = []
    for i in range(segments):
        theta = 2.0 * math.pi * i / segments
        ring.append(_meters_offset_to_4326(cx, cy, radius_m * math.cos(theta), radius_m * math.sin(theta)))
    ring.append(list(ring[0]))  # 闭合
    return {"type": "Polygon", "coordinates": [ring]}


@pytest.fixture()
def circle_poly() -> dict:
    return _circle_polygon_4326()


@pytest.fixture()
def circle_shape(circle_poly) -> Polygon:
    return Polygon(circle_poly["coordinates"][0])


# ---------- A. 夹具保真：测试用的多边形确实复刻了前端 fromCircle(64) 管线 ----------


def test_fixture_ring_is_closed_64gon(circle_poly):
    """环 = 64 段 + 闭合点共 65 个坐标，首尾相等（OL fromCircle 产物形状）。"""
    ring = circle_poly["coordinates"][0]
    assert len(ring) == SEGMENTS + 1
    assert ring[0] == ring[-1]


def test_fixture_vertices_inscribed_on_true_circle(circle_poly):
    """所有顶点在 3857 下距圆心恰为 R（内接多边形，不是外接）——弦在圆内。

    这是 fromCircle 的关键形状特征：选区多边形严格小于用户看到的圆。
    """
    cx, cy = _to_3857(CENTER_LNG, CENTER_LAT)
    for lng, lat in circle_poly["coordinates"][0]:
        x, y = _to_3857(lng, lat)
        assert math.hypot(x - cx, y - cy) == pytest.approx(RADIUS_M, rel=1e-6)


def test_fixture_4326_lng_extent_wider_than_lat(circle_poly):
    """3857 的圆 transform 到 4326 后，经度跨度 > 纬度跨度（1/cos φ 倍）。

    锁夹具复刻了「投影坐标圆 → 度数坐标非均匀拉伸」这一前端管线特征；
    若有人把夹具改成「度数下直接画圆」，本断言会红。
    """
    ring = circle_poly["coordinates"][0]
    lng_extent = max(p[0] for p in ring) - min(p[0] for p in ring)
    lat_extent = max(p[1] for p in ring) - min(p[1] for p in ring)
    assert lng_extent > lat_extent
    assert lng_extent / lat_extent == pytest.approx(1 / math.cos(math.radians(CENTER_LAT)), rel=0.01)


# ---------- B. 严格包含语义（GEOS 代理 ST_Contains，不连库） ----------


def test_center_point_contained(circle_shape):
    """圆心站点 → 包含。"""
    assert circle_shape.contains(Point(CENTER_LNG, CENTER_LAT)) is True


@pytest.mark.parametrize("theta_deg", [0, 90, 180, 270, 45])
def test_half_radius_point_contained(circle_shape, theta_deg):
    """圆心 0.5R 处（各方向）的站点 → 包含。"""
    cx, cy = _to_3857(CENTER_LNG, CENTER_LAT)
    t = math.radians(theta_deg)
    lng, lat = _meters_offset_to_4326(cx, cy, 0.5 * RADIUS_M * math.cos(t), 0.5 * RADIUS_M * math.sin(t))
    assert circle_shape.contains(Point(lng, lat)) is True


def test_far_point_not_contained(circle_shape):
    """2R 外的站点 → 不包含。"""
    cx, cy = _to_3857(CENTER_LNG, CENTER_LAT)
    lng, lat = _meters_offset_to_4326(cx, cy, 2 * RADIUS_M, 0)
    assert circle_shape.contains(Point(lng, lat)) is False


def test_vertex_on_boundary_not_contained(circle_shape, circle_poly):
    """多边形顶点（= 真圆上的点，theta=0）在边界上 → 严格包含判 False。"""
    vertex = circle_poly["coordinates"][0][0]
    assert circle_shape.contains(Point(vertex)) is False


def test_chord_midpoint_on_boundary_not_contained(circle_shape, circle_poly):
    """弦中点（相邻两顶点连线的中点，在边界上）→ 严格包含判 False。"""
    ring = circle_poly["coordinates"][0]
    mid = [(ring[0][0] + ring[1][0]) / 2, (ring[0][1] + ring[1][1]) / 2]
    assert circle_shape.contains(Point(mid)) is False


def test_arc_point_in_segment_gap_not_contained(circle_shape):
    """位于「真圆弧与弦之间」圆段区域的点 → 不包含（64 段内接多边形 < 真圆）。

    锁 #47 的关键边界语义：用户在地图上看到的圆，实际选区是其内接 64 边形，
    贴近圆边缘的站点（弧-弦间隙内，R=500m 时间隙径向约 0.6m）会被 ST_Contains 排除。
    该点距圆心恰为 R（在真圆上），但落在多边形外。
    """
    cx, cy = _to_3857(CENTER_LNG, CENTER_LAT)
    gap_theta = math.pi / SEGMENTS  # 相邻顶点的角平分方向（弦离弧最远方向）
    lng, lat = _meters_offset_to_4326(cx, cy, RADIUS_M * math.cos(gap_theta), RADIUS_M * math.sin(gap_theta))
    assert circle_shape.contains(Point(lng, lat)) is False


def test_just_inside_chord_contained(circle_shape):
    """弧-弦间隙方向、略收于弦内的点（0.98·R·cos(π/64)）→ 包含。

    与 gap 用例对照：同一方向上，弦内一侧包含、弦外（弧侧）不包含，
    边界就是弦本身——近似圆的过滤主体仍覆盖圆内区域。
    """
    cx, cy = _to_3857(CENTER_LNG, CENTER_LAT)
    gap_theta = math.pi / SEGMENTS
    r = 0.98 * RADIUS_M * math.cos(gap_theta)
    lng, lat = _meters_offset_to_4326(cx, cy, r * math.cos(gap_theta), r * math.sin(gap_theta))
    assert circle_shape.contains(Point(lng, lat)) is True


# ---------- C. handler 全链路（monkeypatch 范式，对齐 test_selection_export_47.py） ----------

_captured: dict = {}


async def _fake_fetch_rows(where, params):
    _captured["fetch_rows_called"] = True
    _captured["where"] = where
    _captured["params"] = params
    return {"site": [], "road": [], "lessor": []}


async def _fake_fetch_rows_scoped(where, params, scopes):
    _captured["fetch_rows_scoped_called"] = True
    _captured["where"] = where
    _captured["params"] = params
    _captured["scopes"] = scopes
    return {"site": [], "road": [], "lessor": []}


def _fake_build_kmz_meta(label, data, np_radius_m=200):
    counts = {k: len(v) for k, v in data.items()}
    return f"export_{label}_20260604_000000.kmz", b"PK\x03\x04fake", counts


async def _fake_write_audit(action, details=None, result="success", error_msg=None, request=None):
    _captured["action"] = action
    _captured["details"] = details or {}


class _FakeRequest:
    def __init__(self, user=None):
        self.headers = {}
        self.client = None

        class _State:
            session_id = "test-sid"

        self.state = _State()
        if user is not None:
            self.state.user = user


@pytest.fixture(autouse=True)
def patch_db(monkeypatch):
    _captured.clear()
    monkeypatch.setattr(exports, "_fetch_rows", _fake_fetch_rows)
    monkeypatch.setattr(exports, "_fetch_rows_scoped", _fake_fetch_rows_scoped)
    monkeypatch.setattr(exports, "_build_kmz_meta", _fake_build_kmz_meta)
    monkeypatch.setattr(exports, "write_audit", _fake_write_audit)


def _call(request=None, **body_kwargs):
    body = SelectionBody(**body_kwargs)
    return asyncio.run(export_selection(body, request or _FakeRequest()))


def test_circle_mode_full_chain_geometry_untouched(circle_poly):
    """mode=circle 全链路：64 段圆形几何原样下沉 DB、谓词不换、审计记 circle。

    与 test_selection_export_47.py 的 circle 用例（方形 polygon）互补：
    这里锁「真实前端产物形状」逐点无损耗地传到 ST_GeomFromGeoJSON($1)。
    """
    resp = _call(polygon=circle_poly, mode="circle")
    assert resp.status_code == 200
    assert _captured.get("fetch_rows_called") is True
    assert _captured["where"] == exports.CONTAINS_CLAUSE
    sent = json.loads(_captured["params"][0])
    assert sent == circle_poly  # 65 点闭合环逐点相等，几何零损耗
    assert len(sent["coordinates"][0]) == SEGMENTS + 1
    assert _captured["details"]["mode"] == "circle"
    assert resp.headers["x-filename"].startswith("export_region_")


def test_circle_audit_excludes_selection_geometry(circle_poly):
    """Spec 雷33：审计只记 file_name/counts/bytes/mode，不记选区几何。

    防回归：有人把 polygon/WKT 塞进 audit details（泄隐私 + 胀审计表）。
    """
    resp = _call(polygon=circle_poly, mode="circle")
    assert resp.status_code == 200
    details = _captured["details"]
    assert set(details.keys()) == {"file_name", "counts", "bytes", "mode"}
    assert "coordinates" not in json.dumps(details)


def test_circle_scoped_user_keeps_contains_clause_and_geometry(circle_poly):
    """受限 scope 用户走 _fetch_rows_scoped：谓词仍是 CONTAINS_CLAUSE、几何仍透传。

    #50 Phase 12 后 selection 端点有两条取数路径；既有测试只覆盖了全量路径
    （request 无 user → ["*"]）。锁受限路径下 circle 选区几何不丢、scope 原样透传、
    且不走全量 _fetch_rows。
    """
    user = {"is_admin": False, "scopes": ["site:Globe", "road"]}
    resp = _call(request=_FakeRequest(user=user), polygon=circle_poly, mode="circle")
    assert resp.status_code == 200
    assert _captured.get("fetch_rows_scoped_called") is True
    assert "fetch_rows_called" not in _captured
    assert _captured["where"] == exports.CONTAINS_CLAUSE
    assert json.loads(_captured["params"][0]) == circle_poly
    assert _captured["scopes"] == ["site:Globe", "road"]
    assert _captured["details"]["mode"] == "circle"
