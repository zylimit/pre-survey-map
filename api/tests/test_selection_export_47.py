"""#47 选区导出 KMZ —— 应用层契约测试（不连真库）。

被测端点：POST /api/export/selection（routers/exports.py::export_selection）

执行方式：直调 handler `export_selection(body, request)` + 走 Pydantic 校验，
不使用 fastapi.testclient（容器内未装 httpx），也不连 DB：
- routers.exports._fetch_rows  → async stub，返回固定空行集（不触 PostGIS）。
- routers.exports._build_kmz_meta → 返回固定 (fname, bytes, counts)，
  绕开 build_kml 对 site 行字段的真实依赖，聚焦本测关注点（mode / 半径 / 校验 / 响应）。
- routers.exports.write_audit → async stub，捕获传入 details 供断言 mode。

handler 内 polygon 校验用 `raise HTTPException(400, ...)`；
polygon 非 dict 的非法情形先被 Pydantic（polygon: dict[str, Any]）拦为 ValidationError
（即路由层 422），这里断言 Pydantic 拒绝即可。

覆盖的回归点：
- polygon 校验（缺 type / type=Point → HTTP 400；非 dict → Pydantic 拒绝）
- mode 白名单与非法回落（circle/rect/合法；xxx/空/大写 → polygon；缺省 → polygon）
- np_radius_m 非白名单回落（不抛错，走 200 默认）
- 成功路径返回 KMZ（media_type + Content-Disposition 文件名 region*.kmz）
"""

import asyncio
import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from routers import exports
from routers.exports import SelectionBody, export_selection


# 捕获 write_audit 收到的 details
_captured: dict = {}


async def _fake_fetch_rows(where, params):
    """不连库的 _fetch_rows 替身：捕获 where/params 实参后返回结构正确的空行集。"""
    _captured["where"] = where
    _captured["params"] = params
    return {"site": [], "road": [], "lessor": []}


def _fake_build_kmz_meta(label, data, np_radius_m=200):
    """固定产物，绕开 build_kml 对行字段的真实依赖；捕获 np_radius_m 供回落断言。"""
    _captured["np_radius_m"] = np_radius_m
    fname = f"export_{label}_20260604_000000.kmz"
    counts = {
        "site": len(data["site"]),
        "road": len(data["road"]),
        "lessor": len(data["lessor"]),
    }
    return fname, b"PK\x03\x04fake-kmz-bytes", counts


async def _fake_write_audit(action, details=None, result="success", error_msg=None, request=None):
    _captured["action"] = action
    _captured["details"] = details or {}


class _FakeRequest:
    """handler 只把 request 透传给（已 patch 的）write_audit，造个占位对象即可。"""

    def __init__(self):
        self.headers = {}
        self.client = None

        class _State:
            session_id = "test-sid"

        self.state = _State()


@pytest.fixture(autouse=True)
def patch_db(monkeypatch):
    """把 exports handler 的三处 DB 依赖换成替身，并清空捕获。"""
    _captured.clear()
    monkeypatch.setattr(exports, "_fetch_rows", _fake_fetch_rows)
    monkeypatch.setattr(exports, "_build_kmz_meta", _fake_build_kmz_meta)
    monkeypatch.setattr(exports, "write_audit", _fake_write_audit)


def _call(**body_kwargs):
    """构造 SelectionBody 并同步驱动 handler，返回 Response。"""
    body = SelectionBody(**body_kwargs)
    return asyncio.run(export_selection(body, _FakeRequest()))


def _valid_polygon() -> dict:
    """一个合法的 GeoJSON Polygon（闭合 LinearRing）。"""
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [121.00, 14.50],
                [121.01, 14.50],
                [121.01, 14.51],
                [121.00, 14.51],
                [121.00, 14.50],
            ]
        ],
    }


# ---------- 1. polygon 校验 → 拒绝 ----------


def test_polygon_missing_type_raises_400():
    """缺 type 字段 → HTTP 400，防止把任意 dict 当 Polygon 喂给 PostGIS。"""
    with pytest.raises(HTTPException) as exc:
        _call(polygon={"coordinates": [[[121.0, 14.5]]]})
    assert exc.value.status_code == 400


def test_polygon_type_point_raises_400():
    """type=Point（非 Polygon）→ HTTP 400，只接受 Polygon。"""
    with pytest.raises(HTTPException) as exc:
        _call(polygon={"type": "Point", "coordinates": [121.0, 14.5]})
    assert exc.value.status_code == 400


@pytest.mark.parametrize("bad_poly", [["a", "b"], "not-a-dict", 123])
def test_polygon_not_dict_rejected_by_pydantic(bad_poly):
    """polygon 不是 dict（list/str/int）→ Pydantic 拒绝（路由层即 422）。

    SelectionBody.polygon 声明为 dict[str, Any]，非 dict 在模型构造时抛 ValidationError，
    等价于 FastAPI 路由层返回 422，请求到不了 handler。
    """
    with pytest.raises(ValidationError):
        SelectionBody(polygon=bad_poly)


# ---------- 2~5. mode 白名单与回落 ----------


def test_mode_circle_recorded():
    """#47 圆形：mode=circle → 200 且 audit details.mode == circle。"""
    resp = _call(polygon=_valid_polygon(), mode="circle")
    assert resp.status_code == 200
    assert _captured["details"]["mode"] == "circle"


def test_mode_rect_recorded():
    """mode=rect → details.mode == rect。"""
    resp = _call(polygon=_valid_polygon(), mode="rect")
    assert resp.status_code == 200
    assert _captured["details"]["mode"] == "rect"


@pytest.mark.parametrize("bad_mode", ["xxx", "", "CIRCLE"])
def test_mode_invalid_falls_back_to_polygon(bad_mode):
    """非法 mode（未知串/空/大小写不匹配）→ 回落 polygon。"""
    resp = _call(polygon=_valid_polygon(), mode=bad_mode)
    assert resp.status_code == 200
    assert _captured["details"]["mode"] == "polygon"


def test_mode_default_is_polygon():
    """缺省 mode（不传）→ details.mode == polygon。"""
    resp = _call(polygon=_valid_polygon())
    assert resp.status_code == 200
    assert _captured["details"]["mode"] == "polygon"


# ---------- 6. np_radius_m 非白名单回落 ----------


def test_np_radius_non_whitelist_falls_back():
    """np_radius_m=999（非白名单 50/100/150/200/250）→ 不抛错，成功返回。

    _sanitize_np_radius 把非法值回落 DEFAULT_NP_RADIUS_M=200；
    成功走通即证明回落生效（999 未被原样喂下游）。
    """
    resp = _call(polygon=_valid_polygon(), np_radius_m=999)
    assert resp.status_code == 200
    # 非白名单 999 必须被 _sanitize_np_radius 回落为默认 200，再传给下游
    assert _captured["np_radius_m"] == 200


@pytest.mark.parametrize("radius", [50, 100, 150, 200, 250])
def test_np_radius_whitelist_value_ok(radius):
    """白名单值（50/100/150/200/250）正常通过且原样透传，作为回落用例的对照。"""
    resp = _call(polygon=_valid_polygon(), np_radius_m=radius)
    assert resp.status_code == 200
    # 白名单值原样透传，不被回落
    assert _captured["np_radius_m"] == radius


# ---------- 7. 成功路径返回 KMZ ----------


def test_success_returns_kmz_response():
    """成功路径返回 KMZ：media_type + Content-Disposition 文件名 region*.kmz。"""
    resp = _call(polygon=_valid_polygon(), mode="circle")
    assert resp.status_code == 200
    assert resp.media_type == "application/vnd.google-earth.kmz"
    cd = resp.headers["content-disposition"]
    assert "export_region_" in cd
    assert cd.endswith('.kmz"')
    assert resp.headers["x-filename"].startswith("export_region_")
    assert resp.headers["x-filename"].endswith(".kmz")


def test_selection_binds_contains_clause():
    """handler 必须把 exports.CONTAINS_CLAUSE 原样传给 _fetch_rows 作为 where。

    绑定被测常量，防止实现漂移（如把 ST_Contains 换成 ST_Covers/ST_Intersects）
    时本套件仍假绿。handler（export_selection）直接传常量、无拼接，故严格相等。
    """
    resp = _call(polygon=_valid_polygon())
    assert resp.status_code == 200
    assert _captured["where"] == exports.CONTAINS_CLAUSE


def test_selection_passes_polygon_geometry_to_db():
    """handler 必须把选区 polygon 几何真传给 db 层（params[0] 为 polygon 的 JSON dump）。

    绑定「选区几何确实下沉到 ST_GeomFromGeoJSON($1)」，防止 handler 丢几何或传错对象。
    handler 用 (json.dumps(poly),) 作 params，故 json.loads(params[0]) 应等于传入 polygon。
    """
    poly = _valid_polygon()
    resp = _call(polygon=poly)
    assert resp.status_code == 200
    params = _captured["params"]
    assert json.loads(params[0]) == poly
