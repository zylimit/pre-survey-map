"""#48 Phase 6 site 编辑/删除/勾选导出回归测试（不连真库）。

范式同 test_selection_export_47：直调 handler + monkeypatch DB/audit/KMZ 外部依赖。
重点绑定 handler 内的校验、SQL 组装、事务顺序、半径净化和审计 details，避免只断 200 的伪覆盖。
"""

import asyncio
import math

import pytest
from fastapi import HTTPException

from routers import exports, sites
from routers.exports import SelectionIdsBody, export_selection_ids
from routers.sites import DeleteBody, SitePatchBody, delete_sites, update_site


class _FakeRequest:
    def __init__(self):
        self.headers = {}
        self.client = None

        class _State:
            session_id = "test-sid"

        self.state = _State()


def _site_row(site_id="S1", option="A", project="P", status="positive", lati=14.5, longi=121.0):
    return {
        "site_id": site_id,
        "option": option,
        "project": project,
        "site_status": status,
        "operator": "Globe",
        "category": "规划",
        "type": "Macro NP",
        "lati": lati,
        "longi": longi,
        "extras": {},
        "source_file": "seed.kmz",
        "geojson": '{"type":"Point","coordinates":[121.0,14.5]}',
        "geom_kml": "<Point><coordinates>121.0,14.5</coordinates></Point>",
    }


class _Tx:
    def __init__(self, calls):
        self.calls = calls

    async def __aenter__(self):
        self.calls.append("tx_enter")
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self.calls.append("tx_exit")
        return False


class _Acquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _Pool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return _Acquire(self.conn)


class _Conn:
    def __init__(self, *, row=None, rows=None, status="DELETE 2", calls=None):
        self.row = row
        self.rows = rows if rows is not None else []
        self.status = status
        self.calls = calls if calls is not None else []
        self.fetchrow_sql = None
        self.fetchrow_args = None
        self.fetch_sql = None
        self.fetch_args = None
        self.execute_sql = None
        self.execute_args = None

    async def fetchrow(self, sql, *args):
        self.fetchrow_sql = sql
        self.fetchrow_args = args
        self.calls.append("fetchrow")
        return self.row

    async def fetch(self, sql, *args):
        self.fetch_sql = sql
        self.fetch_args = args
        self.calls.append("fetch")
        return self.rows

    async def execute(self, sql, *args):
        self.execute_sql = sql
        self.execute_args = args
        self.calls.append("delete")
        return self.status

    def transaction(self):
        return _Tx(self.calls)


def _call_update(**body_kwargs):
    body = SitePatchBody(**body_kwargs)
    return asyncio.run(update_site(body, _FakeRequest()))


def _call_delete(**body_kwargs):
    body = DeleteBody(**body_kwargs)
    return asyncio.run(delete_sites(body, _FakeRequest()))


def _call_export_ids(**body_kwargs):
    body = SelectionIdsBody(**body_kwargs)
    return asyncio.run(export_selection_ids(body, _FakeRequest()))


@pytest.fixture
def captured(monkeypatch):
    cap = {}

    async def fake_sites_audit(action, details=None, result="success", error_msg=None, request=None):
        cap["sites_audit"] = {"action": action, "details": details or {}}

    async def fake_exports_audit(action, details=None, result="success", error_msg=None, request=None):
        cap["exports_audit"] = {"action": action, "details": details or {}}

    monkeypatch.setattr(sites, "write_audit", fake_sites_audit)
    monkeypatch.setattr(exports, "write_audit", fake_exports_audit)
    return cap


@pytest.mark.parametrize("field", ["operator", "category", "type"])
def test_patch_rejects_stamped_columns(field):
    with pytest.raises(HTTPException) as exc:
        _call_update(site_id="S1", option="A", patch={field: "bad"})
    assert exc.value.status_code == 400


@pytest.mark.parametrize("field", ["site_id", "option"])
def test_patch_rejects_primary_key_fields_in_patch(field):
    with pytest.raises(HTTPException) as exc:
        _call_update(site_id="S1", option="A", patch={field: "bad"})
    assert exc.value.status_code == 400


def test_patch_rejects_unknown_field():
    with pytest.raises(HTTPException) as exc:
        _call_update(site_id="S1", option="A", patch={"unknown": "bad"})
    assert exc.value.status_code == 400


@pytest.mark.parametrize("patch", [{"lati": 91}, {"longi": 200}, {"lati": math.nan}])
def test_patch_rejects_invalid_coordinates(patch):
    with pytest.raises(HTTPException) as exc:
        _call_update(site_id="S1", option="A", patch=patch)
    assert exc.value.status_code == 400


def test_patch_missing_key_returns_404(monkeypatch, captured):
    conn = _Conn(row=None)
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))

    with pytest.raises(HTTPException) as exc:
        _call_update(site_id="NOPE", option="", patch={"project": "P2"})

    assert exc.value.status_code == 404
    assert "UPDATE site SET" in conn.fetchrow_sql
    assert "NOPE" in conn.fetchrow_args
    assert "sites_audit" not in captured


def test_patch_success_recomputes_geom_with_parameterized_coalesce(monkeypatch, captured):
    conn = _Conn(row=_site_row(site_id="S1", option="A", lati=15.0, longi=121.0))
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))

    resp = _call_update(site_id="S1", option="A", patch={"project": "P2", "lati": 15.0})

    sql = conn.fetchrow_sql
    args = conn.fetchrow_args
    assert resp["properties"]["project"] == "P"
    assert "UPDATE site SET" in sql
    assert '"project" = $1' in sql
    assert "ST_SetSRID(ST_MakePoint(" in sql
    assert "COALESCE(" in sql
    assert "longi)" in sql
    assert "lati)" in sql
    assert "15.0" not in sql
    assert "P2" not in sql
    assert args == ("P2", 15.0, None, "S1", "A")
    assert captured["sites_audit"]["action"] == "edit_site"
    assert captured["sites_audit"]["details"] == {
        "site_id": "S1",
        "option": "A",
        "changed_fields": ["lati", "project"],
    }


def test_delete_empty_keys_returns_400():
    with pytest.raises(HTTPException) as exc:
        _call_delete(keys=[])
    assert exc.value.status_code == 400


def test_delete_creates_restore_point_before_delete_in_same_transaction(monkeypatch, captured):
    calls = []
    conn = _Conn(status="DELETE 2", calls=calls)
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))

    async def fake_create_restore_point(conn_arg, reason, note=None, protect_id=None, evict=True):
        assert conn_arg is conn
        assert reason == "pre_feature_delete"
        calls.append("restore_point")
        return 42

    monkeypatch.setattr(sites, "create_restore_point", fake_create_restore_point)

    resp = _call_delete(keys=[{"site_id": "S1", "option": "A"}, {"site_id": "S2", "option": ""}])

    assert calls == ["tx_enter", "restore_point", "delete", "tx_exit"]
    assert conn.execute_sql.startswith('DELETE FROM site WHERE (site_id, "option") IN')
    assert conn.execute_args == (["S1", "S2"], ["A", ""])
    assert resp == {"deleted": 2, "restore_point_id": 42}
    assert captured["sites_audit"]["action"] == "delete_site"
    assert captured["sites_audit"]["details"]["restore_point_id"] == 42
    assert captured["sites_audit"]["details"]["deleted"] == 2


def test_export_selection_ids_empty_keys_returns_400():
    with pytest.raises(HTTPException) as exc:
        _call_export_ids(keys=[])
    assert exc.value.status_code == 400


def test_export_selection_ids_exports_site_subset_and_audits(monkeypatch, captured):
    rows = [_site_row(site_id="S1", option="A"), _site_row(site_id="S2", option="")]
    conn = _Conn(rows=rows)
    monkeypatch.setattr(exports, "pool", lambda: _Pool(conn))

    def fake_build_kmz_meta(label, data, np_radius_m=200):
        captured["kmz"] = {"label": label, "data": data, "np_radius_m": np_radius_m}
        return "export_region_test.kmz", b"PK\x03\x04fake", {
            "site": len(data["site"]),
            "road": len(data["road"]),
            "lessor": len(data["lessor"]),
        }

    monkeypatch.setattr(exports, "_build_kmz_meta", fake_build_kmz_meta)

    resp = _call_export_ids(
        keys=[{"site_id": "S1", "option": "A"}, {"site_id": "S2", "option": ""}],
        np_radius_m=999,
    )

    assert resp.status_code == 200
    assert conn.fetch_sql == exports.SITE_BY_KEYS_SQL
    assert conn.fetch_args == (["S1", "S2"], ["A", ""])
    assert captured["kmz"]["label"] == "region"
    assert captured["kmz"]["np_radius_m"] == 200
    assert [r["site_id"] for r in captured["kmz"]["data"]["site"]] == ["S1", "S2"]
    assert captured["kmz"]["data"]["road"] == []
    assert captured["kmz"]["data"]["lessor"] == []
    assert captured["exports_audit"]["action"] == "export_region"
    assert captured["exports_audit"]["details"]["mode"] == "list"
    assert captured["exports_audit"]["details"]["counts"] == {"site": 2, "road": 0, "lessor": 0}
