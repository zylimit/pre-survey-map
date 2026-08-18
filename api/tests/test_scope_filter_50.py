"""#50 Phase 12 数据权限（scope）换算 + 过滤落点回归测试（不连真库，monkeypatch 范式）。

绑定点：
- auth/scopes.py：映射表单一真源、继承展开、WHERE 换算、行级/盖戳校验布尔
- 落点：GET sites 带 WHERE / roads·lessors 不可见返空 / exports 三端点过滤 /
  imports 盖戳目标 403 / PATCH·delete·undo-delete 越权行跳过+报数
"""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from auth.scopes import (
    CATEGORY_NODE_TO_DB,
    can_see_lessor,
    can_see_road,
    import_target_visible,
    site_row_visible,
    site_scope_pairs,
    site_scope_where,
    validate_scope_node,
    visible_scopes,
)
from routers import exports, imports, lessors, roads, sites
from routers.exports import SelectionBody, SelectionIdsBody, export_all, export_selection, export_selection_ids
from routers.imports import import_file
from routers.lessors import list_lessors
from routers.roads import list_roads
from routers.sites import DeleteBody, SitePatchBody, delete_sites, list_sites, undo_delete, update_site


class _FakeRequest:
    def __init__(self, user=None):
        self.headers = {}
        self.client = None

        class _State:
            session_id = "test-sid"

        self.state = _State()
        if user is not None:
            self.state.user = user


def _user(scopes, is_admin=False, perms=None):
    return {"user_id": 9, "username": "u", "is_admin": is_admin,
            "perms": perms or {}, "scopes": scopes}


class _Acquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *a):
        return False


class _Pool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return _Acquire(self.conn)


class _Tx:
    def __init__(self, calls):
        self.calls = calls

    async def __aenter__(self):
        self.calls.append("tx_enter")
        return self

    async def __aexit__(self, *a):
        self.calls.append("tx_exit")
        return False


class _Conn:
    """全方法记录调用；fetchrow/fetchval 支持队列式返回值。"""

    def __init__(self, *, rows=None, fetchrow_rets=None, fetchval_rets=None):
        self.rows = rows or []
        self._fetchrow = list(fetchrow_rets or [])
        self._fetchval = list(fetchval_rets or [])
        self.calls = []
        self.fetches = []
        self.fetchrows = []
        self.fetchvals = []
        self.executed = []

    async def fetch(self, sql, *args):
        self.calls.append("fetch")
        self.fetches.append((sql, args))
        return self.rows

    async def fetchrow(self, sql, *args):
        self.calls.append("fetchrow")
        self.fetchrows.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, sql, *args):
        self.calls.append("fetchval")
        self.fetchvals.append((sql, args))
        return self._fetchval.pop(0) if self._fetchval else None

    async def execute(self, sql, *args):
        self.calls.append("execute")
        self.executed.append((sql, args))
        return "INSERT 0 2" if sql.strip().startswith("INSERT") else "UPDATE 2"

    def transaction(self):
        return _Tx(self.calls)


@pytest.fixture
def captured(monkeypatch):
    cap = {}

    async def fake_audit(action, details=None, result="success", error_msg=None, request=None, username=None):
        cap.setdefault("audits", []).append({"action": action, "details": details or {}})

    for mod in (sites, exports, imports):
        monkeypatch.setattr(mod, "write_audit", fake_audit)
    return cap


# ───────────────────────── scope 换算（纯函数） ─────────────────────────


def test_mapping_table_single_source():
    assert CATEGORY_NODE_TO_DB == {"EXISTING": "存量", "PLANNED": "规划", "SURVEY": "勘测"}


def test_visible_scopes_admin_sentinel():
    assert visible_scopes(_user([], is_admin=True)) == ["*"]
    assert visible_scopes(_user(["site:Globe"])) == ["site:Globe"]


@pytest.mark.parametrize("node,ok", [
    ("site", True), ("road", True), ("lessor", True),
    ("site:Globe", True), ("site:Smart", True), ("site:Dito", True),
    ("site:Globe:SURVEY", True), ("site:Dito:EXISTING", True),
    ("site:Globe:BAD", False), ("site:BadOp", False), ("site:Globe:SURVEY:X", False),
    ("roads", False), ("", False), (None, False), (123, False),
])
def test_validate_scope_node(node, ok):
    assert validate_scope_node(node) is ok


def test_pairs_full_and_root():
    assert site_scope_pairs(["*"]) is None
    assert site_scope_pairs(["site"]) is None
    assert site_scope_pairs(["road"]) == []  # 无 site 可见


def test_pairs_inheritance_expand():
    # site:Globe 涵盖其下全部类别；与精确类别并存时父级赢
    assert site_scope_pairs(["site:Globe"]) == [("Globe", None)]
    assert site_scope_pairs(["site:Globe", "site:Globe:SURVEY"]) == [("Globe", None)]
    assert site_scope_pairs(["site:Globe:SURVEY"]) == [("Globe", "勘测")]
    assert site_scope_pairs(["site:Smart:EXISTING", "site:Dito:PLANNED"]) == [
        ("Dito", "规划"), ("Smart", "存量"),
    ]


def test_scope_where_parameterized():
    assert site_scope_where(["*"]) == ("", [])
    assert site_scope_where(["road"]) == ("FALSE", [])
    frag, params = site_scope_where(["site:Globe"])
    assert frag == "((operator = $1))"
    assert params == ["Globe"]
    frag, params = site_scope_where(["site:Globe:SURVEY"], start_idx=2)
    assert "$2" in frag and "$3" in frag and "category" in frag
    assert params == ["Globe", "勘测"]
    frag, params = site_scope_where(["site:Globe", "site:Smart:EXISTING"])
    assert " OR " in frag and params == ["Globe", "Smart", "存量"]


def test_visibility_booleans():
    assert can_see_road(["*"]) and can_see_road(["road"]) and not can_see_road(["site"])
    assert can_see_lessor(["*"]) and can_see_lessor(["lessor"]) and not can_see_lessor(["site"])
    assert site_row_visible(["*"], "Globe", "勘测")
    assert site_row_visible(["site:Globe"], "Globe", "存量")
    assert not site_row_visible(["site:Globe"], "Smart", "存量")
    assert site_row_visible(["site:Globe:SURVEY"], "Globe", "勘测")
    assert not site_row_visible(["site:Globe:SURVEY"], "Globe", "规划")


def test_import_target_visible():
    assert import_target_visible(["*"], "site", "Globe", "勘测")
    assert import_target_visible(["site:Globe"], None, None, None)  # 无盖戳不校验
    assert import_target_visible(["site:Globe"], "site", "Globe", "规划")
    assert not import_target_visible(["site:Globe"], "site", "Smart", "规划")
    assert not import_target_visible(["site:Globe"], "site", None, None)  # 缺盖戳值
    assert import_target_visible(["road"], "road", None, None)
    assert not import_target_visible(["site"], "road", None, None)
    assert not import_target_visible(["site"], "lessor", None, None)


# ───────────────────────── GET 过滤落点 ─────────────────────────


def test_list_sites_appends_scope_where(monkeypatch):
    conn = _Conn()
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))
    out = asyncio.run(list_sites(_FakeRequest(user=_user(["site:Globe:SURVEY"]))))
    sql, args = conn.fetches[0]
    assert "WHERE" in sql and "operator = $1" in sql and "category = $2" in sql
    assert args == ("Globe", "勘测")
    assert out["type"] == "FeatureCollection"


def test_list_sites_admin_no_where(monkeypatch):
    conn = _Conn()
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))
    asyncio.run(list_sites(_FakeRequest(user=_user([], is_admin=True))))
    sql, args = conn.fetches[0]
    assert "WHERE" not in sql and args == ()


def test_list_roads_invisible_returns_empty_without_db(monkeypatch):
    monkeypatch.setattr(roads, "pool", lambda: (_ for _ in ()).throw(AssertionError("不应查库")))
    out = asyncio.run(list_roads(_FakeRequest(user=_user(["site:Globe"]))))
    assert out == {"type": "FeatureCollection", "features": []}


def test_list_lessors_invisible_returns_empty(monkeypatch):
    out = asyncio.run(list_lessors(_FakeRequest(user=_user(["road"]))))
    assert out == {"type": "FeatureCollection", "features": []}


# ───────────────────────── exports 过滤 ─────────────────────────


def _stub_kmz(monkeypatch, cap):
    def fake_build(label, data, np_radius_m=200):
        cap["kmz"] = {"label": label, "data": data}
        return "f.kmz", b"PK\x03\x04", {k: len(v) for k, v in data.items()}

    monkeypatch.setattr(exports, "_build_kmz_meta", fake_build)


def test_export_all_scoped_filters_and_skips_types(monkeypatch, captured):
    cap = {}
    _stub_kmz(monkeypatch, cap)
    conn = _Conn()
    monkeypatch.setattr(exports, "pool", lambda: _Pool(conn))

    resp = asyncio.run(export_all(_FakeRequest(user=_user(["site:Globe"]))))

    assert resp.status_code == 200
    assert len(conn.fetches) == 1  # road/lessor 不可见 → 不查
    sql, args = conn.fetches[0]
    assert "FROM site" in sql and "operator = $1" in sql
    assert args == ("Globe",)
    assert cap["kmz"]["data"]["road"] == [] and cap["kmz"]["data"]["lessor"] == []


def test_export_all_admin_uses_original_fetch(monkeypatch, captured):
    calls = []

    async def fake_fetch_rows(where, params):
        calls.append((where, params))
        return {"site": [], "road": [], "lessor": []}

    monkeypatch.setattr(exports, "_fetch_rows", fake_fetch_rows)
    _stub_kmz(monkeypatch, {})
    asyncio.run(export_all(_FakeRequest(user=_user([], is_admin=True))))
    assert calls == [("", ())]  # 原路径：两参数、空 where


def test_export_selection_scoped_combines_contains_and_scope(monkeypatch, captured):
    cap = {}
    _stub_kmz(monkeypatch, cap)
    conn = _Conn()
    monkeypatch.setattr(exports, "pool", lambda: _Pool(conn))
    poly = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
    body = SelectionBody(polygon=poly)

    asyncio.run(export_selection(body, _FakeRequest(user=_user(["site:Globe:SURVEY", "road"]))))

    assert len(conn.fetches) == 2  # site + road（lessor 不可见跳过）
    site_sql, site_args = conn.fetches[0]
    assert "ST_Contains" in site_sql and "operator = $2" in site_sql and "category = $3" in site_sql
    assert site_args[1:] == ("Globe", "勘测")
    road_sql, _ = conn.fetches[1]
    assert "FROM road" in road_sql


def test_export_selection_ids_scoped_skips_forbidden_keys(monkeypatch, captured):
    _stub_kmz(monkeypatch, {})
    row = {"site_id": "S1", "option": "", "project": None, "site_status": None,
           "type": None, "lati": 1.0, "longi": 2.0, "extras": {}, "source_file": "f",
           "geom_kml": None}
    conn = _Conn(rows=[row])
    monkeypatch.setattr(exports, "pool", lambda: _Pool(conn))
    body = SelectionIdsBody(keys=[{"site_id": "S1", "option": ""}])

    asyncio.run(export_selection_ids(body, _FakeRequest(user=_user(["site:Smart"]))))

    sql, args = conn.fetches[0]
    assert sql != exports.SITE_BY_KEYS_SQL  # 越权主键由 SQL 过滤
    assert "AND (" in sql and "operator = $3" in sql
    assert args == (["S1"], [""], "Smart")


# ───────────────────────── imports 盖戳目标 403 ─────────────────────────


def test_import_target_out_of_scope_403():
    req = _FakeRequest(user=_user(["site:Smart"], perms={"import": True}))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(import_file(None, req, operator="Globe", category="规划",
                                type_=None, target_kind="site"))
    assert exc.value.status_code == 403


def test_import_road_target_without_scope_403():
    req = _FakeRequest(user=_user(["site"], perms={"import": True}))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(import_file(None, req, operator=None, category=None,
                                type_=None, target_kind="road"))
    assert exc.value.status_code == 403


def test_import_target_in_scope_passes_scope_check():
    # scope 校验通过 → 走到文件类型检测（filename 空 → 400 而非 403）
    req = _FakeRequest(user=_user(["site:Globe"], perms={"import": True}))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(import_file(SimpleNamespace(filename=""), req, operator="Globe",
                                category="规划", type_=None, target_kind="site"))
    assert exc.value.status_code == 400


# ───────────────────────── PATCH / delete / undo 行级校验 ─────────────────────────


def _site_row(site_id="S1", option="A", operator="Globe", category="规划"):
    return {"site_id": site_id, "option": option, "project": "P",
            "site_status": "positive", "operator": operator, "category": category,
            "type": "Macro NP", "lati": 14.5, "longi": 121.0, "extras": {},
            "source_file": "seed.kmz",
            "geojson": '{"type":"Point","coordinates":[121.0,14.5]}'}


def test_patch_forbidden_row_403(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[{"operator": "Globe", "category": "规划"}])
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))
    req = _FakeRequest(user=_user(["site:Smart"], perms={"edit_delete": True}))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(update_site(SitePatchBody(site_id="S1", option="A", patch={"project": "X"}), req))
    assert exc.value.status_code == 403
    assert len(conn.fetchrows) == 1  # 只做了可见性探查，未走到 UPDATE
    assert "audits" not in captured


def test_patch_visible_row_proceeds(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[{"operator": "Globe", "category": "规划"},
                                _site_row()])
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))
    req = _FakeRequest(user=_user(["site:Globe"], perms={"edit_delete": True}))
    resp = asyncio.run(update_site(SitePatchBody(site_id="S1", option="A", patch={"project": "X"}), req))
    assert resp["properties"]["site_id"] == "S1"
    assert len(conn.fetchrows) == 2  # 探查 + UPDATE


def test_delete_skips_forbidden_rows_and_reports(monkeypatch, captured):
    conn = _Conn(
        rows=[{"site_id": "S1", "option": "A", "operator": "Globe", "category": "规划"},
              {"site_id": "S2", "option": "", "operator": "Smart", "category": "勘测"}],
        fetchrow_rets=[{"undo_id": 3, "deleted": 1}],
    )
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))
    req = _FakeRequest(user=_user(["site:Globe"], perms={"edit_delete": True}))
    body = DeleteBody(keys=[{"site_id": "S1", "option": "A"}, {"site_id": "S2", "option": ""}])

    resp = asyncio.run(delete_sites(body, req))

    assert resp == {"deleted": 1, "undo_id": 3, "skipped": 1}
    assert conn.fetchrows[0][1] == (["S1"], ["A"])  # CTE 只删可见行
    audit = captured["audits"][0]
    assert audit["action"] == "delete_site" and audit["details"]["skipped"] == 1


def test_delete_all_forbidden_no_cte(monkeypatch, captured):
    conn = _Conn(rows=[{"site_id": "S2", "option": "", "operator": "Smart", "category": "勘测"}])
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))
    req = _FakeRequest(user=_user(["site:Globe"], perms={"edit_delete": True}))
    body = DeleteBody(keys=[{"site_id": "S2", "option": ""}])

    resp = asyncio.run(delete_sites(body, req))

    assert resp == {"deleted": 0, "undo_id": None, "skipped": 1}
    assert "fetchrow" not in conn.calls  # 不触发删除 CTE
    assert captured["audits"][0]["details"]["skipped"] == 1  # 不静默成功


def test_undo_delete_scoped_skips_and_keeps_undone_false(monkeypatch, captured):
    conn = _Conn(fetchval_rets=[3, 1])  # 批共 3 行 / 越权 1 行
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))
    req = _FakeRequest(user=_user(["site:Globe"], perms={"edit_delete": True}))

    resp = asyncio.run(undo_delete(7, req))

    assert resp == {"restored": 2, "requested": 3, "skipped": 1}
    insert_sql, insert_args = conn.executed[0]
    assert "AND (" in insert_sql and "operator = $2" in insert_sql
    assert insert_args == (7, "Globe")
    mark_sql, mark_args = conn.executed[1]
    assert "AND (" in mark_sql and mark_args == (7, "Globe")  # 越权行不标 undone
    assert captured["audits"][0]["details"]["skipped"] == 1
