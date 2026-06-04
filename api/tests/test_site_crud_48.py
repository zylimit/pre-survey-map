"""#48/#49 site 编辑/删除/勾选导出/撤销删除 回归测试（不连真库）。

范式：直调 handler + monkeypatch DB/audit/KMZ 外部依赖。
重点绑定 handler 内的校验、SQL 组装、事务顺序、半径净化和审计 details，避免只断 200 的伪覆盖。

#49 Phase 9：delete 从 F17 全表快照（create_restore_point）改为轻量撤销
（capture 被删行→site_delete_undo，再 DELETE）。删除调用序列断言随之从
[tx_enter→restore_point→delete→tx_exit] 改为 [tx_enter→capture_undo→delete→tx_exit]。
"""

import asyncio
import math
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from routers import exports, sites
from routers.exports import SelectionIdsBody, export_selection_ids
from routers.sites import (
    DeleteBody,
    SitePatchBody,
    delete_history,
    delete_sites,
    undo_delete,
    update_site,
)


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
    """SQL 感知的假连接：按语句分类记录调用序列 + 逐类返回值，用于断言事务顺序。"""

    def __init__(self, *, row=None, rows=None, status="DELETE 2", calls=None,
                 capture=None, fetchval_ret=None, exec_returns=None, exec_raise=None):
        self.row = row
        self.rows = rows if rows is not None else []
        self.status = status
        self.calls = calls if calls is not None else []
        self.capture = capture
        self.fetchval_ret = fetchval_ret
        self.exec_returns = exec_returns or {}  # 分类 -> 返回 status 串
        self.exec_raise = set(exec_raise or ())  # 分类 -> 触发异常（测 evict 失败容错）
        # 末次捕获 + 全量执行日志（kind, sql, args）
        self.fetchrow_sql = None
        self.fetchrow_args = None
        self.fetch_sql = None
        self.fetch_args = None
        self.execute_sql = None
        self.execute_args = None
        self.fetchval_sql = None
        self.fetchval_args = None
        self.exec_log = []

    async def fetchval(self, sql, *args):
        self.fetchval_sql = sql
        self.fetchval_args = args
        self.calls.append("fetchval")
        return self.fetchval_ret

    async def fetchrow(self, sql, *args):
        self.fetchrow_sql = sql
        self.fetchrow_args = args
        # #49 修复2：删除+捕获已并入单条 CTE（DELETE FROM site RETURNING → INSERT site_delete_undo）
        if "site_delete_undo" in sql and "DELETE FROM site" in sql:
            self.calls.append("delete_capture")
            return self.capture
        self.calls.append("fetchrow")
        return self.row

    async def fetch(self, sql, *args):
        self.fetch_sql = sql
        self.fetch_args = args
        self.calls.append("fetch")
        return self.rows

    async def execute(self, sql, *args):
        s = sql.strip()
        if s.startswith("DELETE FROM site_delete_undo"):
            kind = "evict"
        elif s.startswith("DELETE FROM site"):
            kind = "delete"
        elif s.startswith("INSERT INTO site ("):
            kind = "undo_insert"
        elif s.startswith("UPDATE site_delete_undo"):
            kind = "undo_mark"
        else:
            kind = "execute"
        self.execute_sql = sql
        self.execute_args = args
        self.exec_log.append((kind, sql, args))
        self.calls.append(kind)
        if kind in self.exec_raise:
            raise RuntimeError(f"injected failure on {kind}")
        return self.exec_returns.get(kind, self.status)

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


# ───────────────────────── PATCH 编辑 ─────────────────────────


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


# ───────────────────────── 删除（#49 轻量撤销） ─────────────────────────


def test_delete_empty_keys_returns_400():
    with pytest.raises(HTTPException) as exc:
        _call_delete(keys=[])
    assert exc.value.status_code == 400


def test_delete_atomic_capture_from_delete_returning(monkeypatch, captured):
    """#49 修复2：删除+捕获并入单条 CTE（DELETE FROM site RETURNING → INSERT site_delete_undo）。

    捕获==实删行（原子，无独立 SELECT-then-delete、无竞态）。
    序列 [tx_enter→delete_capture→tx_exit]，环形淘汰(evict)在事务后。无 F17 restore_point。
    """
    calls = []
    conn = _Conn(
        calls=calls,
        capture={"undo_id": 7, "deleted": 2},  # CTE 返回 undo_id + 实删条数
        exec_returns={"evict": "DELETE 0"},
    )
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))

    resp = _call_delete(keys=[{"site_id": "S1", "option": "A"}, {"site_id": "S2", "option": ""}])

    # 单条 CTE：delete+capture 一步，事务内；evict 在事务后
    assert calls[:3] == ["tx_enter", "delete_capture", "tx_exit"]
    assert "evict" in calls and calls.index("evict") > calls.index("tx_exit")
    # 反向验证（防伪）：旧 F17 路径消失；不再有独立 SELECT-then-delete（仅一次 delete_capture）
    assert "restore_point" not in calls
    assert calls.count("delete_capture") == 1
    assert "delete" not in calls  # 没有独立 DELETE 语句（已并入 CTE 的 fetchrow）

    # 单 CTE 同时含 DELETE...RETURNING（捕获源=实删行）与 INSERT site_delete_undo + nextval
    sql = conn.fetchrow_sql
    assert "DELETE FROM site" in sql
    assert "RETURNING" in sql
    assert "INSERT INTO site_delete_undo" in sql
    assert "nextval(" in sql
    assert "FROM del" in sql  # INSERT 取自 DELETE RETURNING 的 del CTE，而非独立 SELECT FROM site
    assert conn.fetchrow_args == (["S1", "S2"], ["A", ""])

    # 返回 + 审计：deleted/undo_id 取自 CTE；无 restore_point_id
    assert resp == {"deleted": 2, "undo_id": 7}
    assert captured["sites_audit"]["action"] == "delete_site"
    assert captured["sites_audit"]["details"]["undo_id"] == 7
    assert captured["sites_audit"]["details"]["deleted"] == 2
    assert "restore_point_id" not in captured["sites_audit"]["details"]


def test_delete_evict_failure_still_returns_and_audits(monkeypatch, captured):
    """#49 修复1：环形淘汰(evict)在事务提交后失败，绝不连累已提交的删除/审计/返回。"""
    calls = []
    conn = _Conn(
        calls=calls,
        capture={"undo_id": 9, "deleted": 1},
        exec_raise={"evict"},  # evict 抛异常
    )
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))

    # evict 抛错被吞（仅 warning），不向上抛
    resp = _call_delete(keys=[{"site_id": "S1", "option": "A"}])

    assert resp == {"deleted": 1, "undo_id": 9}  # 删除结果照常返回
    assert "evict" in calls  # evict 确实被调用并抛错
    # 审计必须在 evict 之前完成，evict 失败不影响
    assert captured["sites_audit"]["action"] == "delete_site"
    assert captured["sites_audit"]["details"]["undo_id"] == 9
    assert captured["sites_audit"]["details"]["deleted"] == 1


# ───────────────────────── 撤销删除（#49 新端点） ─────────────────────────


def test_undo_delete_reinserts_marks_undone_and_audits(monkeypatch, captured):
    """撤销：INSERT 回 site（ON CONFLICT DO NOTHING）→ 标记 undone；restored=实插数。"""
    calls = []
    conn = _Conn(
        calls=calls,
        fetchval_ret=3,  # 该批共 3 行
        exec_returns={"undo_insert": "INSERT 0 2", "undo_mark": "UPDATE 3"},
    )
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))

    resp = asyncio.run(undo_delete(7, _FakeRequest()))

    # restored 取自 INSERT 实插数(2)，requested 取自该批行数(3)——二者不同，防把 requested 当 restored
    assert resp == {"restored": 2, "requested": 3}
    assert resp["restored"] != resp["requested"]

    # 事务内顺序：先查批次行数(fetchval) → 插回 → 标记 undone
    assert calls[:4] == ["tx_enter", "fetchval", "undo_insert", "undo_mark"]
    insert_call = next(c for c in conn.exec_log if c[0] == "undo_insert")
    assert "ON CONFLICT" in insert_call[1]
    assert "DO NOTHING" in insert_call[1]
    mark_call = next(c for c in conn.exec_log if c[0] == "undo_mark")
    assert "undone = true" in mark_call[1]

    assert captured["sites_audit"]["action"] == "undo_delete_site"
    assert captured["sites_audit"]["details"] == {"undo_id": 7, "restored": 2}


def test_undo_delete_unknown_batch_returns_404(monkeypatch, captured):
    conn = _Conn(fetchval_ret=0)  # 批次不存在
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(undo_delete(999, _FakeRequest()))

    assert exc.value.status_code == 404
    assert "sites_audit" not in captured  # 404 不写审计


# ───────────────────────── 删除历史 ─────────────────────────


def test_delete_history_groups_batches_with_summary(monkeypatch):
    dt = datetime(2026, 6, 4, 12, 0, 0, tzinfo=timezone.utc)
    rows = [
        {
            "undo_id": 7,
            "deleted_at": dt,
            "count": 2,
            "undone": False,
            "operators": "Globe",
            "categories": "规划",
            "types": "Macro NP",
            "sample": ["S1", "S2"],
        }
    ]
    conn = _Conn(rows=rows)
    monkeypatch.setattr(sites, "pool", lambda: _Pool(conn))

    out = asyncio.run(delete_history())

    assert out == [
        {
            "undo_id": 7,
            "deleted_at": dt.isoformat(),
            "count": 2,
            "layer": "Globe / 规划 / Macro NP",
            "sample": ["S1", "S2"],
            "undone": False,
        }
    ]
    # 按 undo_id 分组 + 时间倒序 + 环形上限
    assert "GROUP BY undo_id" in conn.fetch_sql
    assert "ORDER BY max(deleted_at) DESC" in conn.fetch_sql


# ───────────────────────── 勾选导出（#48） ─────────────────────────


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
