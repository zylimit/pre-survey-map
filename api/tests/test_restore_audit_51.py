"""#51 rollback 审计 details 回归测试（不连真库，monkeypatch 范式，对齐 test_admin_50.py）。

锁定 Spec:879「审计日志」表契约：
  restore_point_rollback details 必含
    restore_point_id / new_restore_point_id / counts_before / counts_after
  且 counts_before/counts_after 各含 site/road/lessor/area 四表计数。

背景：review 曾发现 rollback 审计 details 缺 counts（修复后补此永久回归锁）。
防的回归：有人改 details key 名 / 漏掉 counts / before-after 顺序写反 / 四表计数缺表。
"""

import asyncio
import importlib

import pytest
from fastapi import HTTPException

# monkeypatch 打在端点所在模块命名空间（pool/write_audit/create_restore_point/
# restore_from_snapshot 均为模块级 import）。
restore_router = importlib.import_module("restore.router")
from restore.router import _table_counts, rollback


class _FakeRequest:
    def __init__(self):
        self.headers = {}
        self.client = None

        class _State:
            session_id = "test-sid"

        self.state = _State()


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
    """队列式返回值（fetchrow 按调用顺序弹出）+ 调用日志。"""

    def __init__(self, *, fetchrow_rets=None):
        self._fetchrow = list(fetchrow_rets or [])
        self.calls = []

    async def fetchrow(self, sql, *args):
        self.calls.append("fetchrow")
        return self._fetchrow.pop(0) if self._fetchrow else None

    def transaction(self):
        return _Tx(self.calls)


def _counts(site, road, lessor, area):
    return {"site": site, "road": road, "lessor": lessor, "area": area}


@pytest.fixture
def captured(monkeypatch):
    """捕获 write_audit + 打桩 helper（建点/回灌不碰真库）。"""
    cap = {"audits": [], "restore_calls": []}

    async def fake_audit(action, details=None, result="success", error_msg=None,
                         request=None, username=None):
        cap["audits"].append({"action": action, "details": details or {}})

    async def fake_create_rp(conn, reason, note=None, protect_id=None):
        return 777  # pre_rollback 新点 id

    async def fake_restore(conn, rp_id):
        cap["restore_calls"].append(rp_id)

    monkeypatch.setattr(restore_router, "write_audit", fake_audit)
    monkeypatch.setattr(restore_router, "create_restore_point", fake_create_rp)
    monkeypatch.setattr(restore_router, "restore_from_snapshot", fake_restore)
    return cap


def _patch_pool(monkeypatch, conn):
    monkeypatch.setattr(restore_router, "pool", lambda: _Pool(conn))


# ───────────────────── _table_counts 四表计数 ─────────────────────


def test_table_counts_returns_four_tables():
    """counts 字典必须含 site/road/lessor/area 四个 key（Spec:879 counts 结构）。"""
    conn = _Conn(fetchrow_rets=[_counts(10, 20, 30, 40)])
    out = asyncio.run(_table_counts(conn))
    assert out == {"site": 10, "road": 20, "lessor": 30, "area": 40}


# ───────────────────── rollback 审计 details（Spec:879）─────────────────────


def test_rollback_audit_details_has_spec879_keys(monkeypatch, captured):
    """普通回滚（reason != pre_import）：details 含 Spec:879 四 key，
    且 counts_before/counts_after 正确反映回滚前后不同的数据量。"""
    before = _counts(100, 50, 30, 5)   # 回滚前（当前库）
    after = _counts(80, 40, 25, 3)     # 回滚后（快照重灌）
    conn = _Conn(fetchrow_rets=[
        {"id": 42, "reason": "manual"},  # 目标点存在性查询
        before,                          # counts_before
        after,                           # counts_after
    ])
    _patch_pool(monkeypatch, conn)

    resp = asyncio.run(rollback(42, _FakeRequest()))

    assert resp == {"ok": True, "rolled_back_to": 42}
    assert captured["restore_calls"] == [42]  # 确实回滚到目标点

    rollback_audits = [a for a in captured["audits"]
                       if a["action"] == "restore_point_rollback"]
    assert len(rollback_audits) == 1
    details = rollback_audits[0]["details"]

    # Spec:879 四 key 一个不能少
    assert details["restore_point_id"] == 42
    assert details["new_restore_point_id"] == 777
    assert details["counts_before"] == before
    assert details["counts_after"] == after

    # before ≠ after 场景：两组计数必须各自独立、不被写成同一份
    assert details["counts_before"] != details["counts_after"]
    for k in ("site", "road", "lessor", "area"):
        assert k in details["counts_before"]
        assert k in details["counts_after"]

    # 附带：pre_rollback 建点审计（restore_point_create_auto）仍应记录
    auto_audits = [a for a in captured["audits"]
                   if a["action"] == "restore_point_create_auto"]
    assert len(auto_audits) == 1
    assert auto_audits[0]["details"]["restore_point_id"] == 777
    assert auto_audits[0]["details"]["reason"] == "pre_rollback"


def test_rollback_undo_last_import_also_has_spec_keys(monkeypatch, captured):
    """目标点 reason=pre_import → 记 restore_point_undo_last_import（Spec:880
    「等价 restore_point_rollback」），details 同样必含四 key。"""
    before = _counts(60, 10, 8, 2)
    after = _counts(55, 10, 8, 2)
    conn = _Conn(fetchrow_rets=[
        {"id": 7, "reason": "pre_import"},
        before,
        after,
    ])
    _patch_pool(monkeypatch, conn)

    asyncio.run(rollback(7, _FakeRequest()))

    undo_audits = [a for a in captured["audits"]
                   if a["action"] == "restore_point_undo_last_import"]
    assert len(undo_audits) == 1
    details = undo_audits[0]["details"]
    assert details["restore_point_id"] == 7
    assert details["new_restore_point_id"] == 777
    assert details["counts_before"] == before
    assert details["counts_after"] == after
    # 此分支不得误记普通 rollback
    assert not any(a["action"] == "restore_point_rollback"
                   for a in captured["audits"])


def test_undo_last_import_shortcut_true_normal_rollback_without(monkeypatch, captured):
    """Spec:880 —— undo_last_import 分支 details 必带 `shortcut: true`；
    普通 rollback（reason != pre_import）**不得**带 shortcut（反向断言）。"""
    # ① undo 分支（目标点 reason=pre_import）→ details.shortcut is True
    conn = _Conn(fetchrow_rets=[
        {"id": 7, "reason": "pre_import"},
        _counts(60, 10, 8, 2),
        _counts(55, 10, 8, 2),
    ])
    _patch_pool(monkeypatch, conn)
    asyncio.run(rollback(7, _FakeRequest()))

    undo_audits = [a for a in captured["audits"]
                   if a["action"] == "restore_point_undo_last_import"]
    assert len(undo_audits) == 1
    assert undo_audits[0]["details"]["shortcut"] is True

    # ② 普通 rollback（reason=manual）→ details 不得含 shortcut key
    conn2 = _Conn(fetchrow_rets=[
        {"id": 42, "reason": "manual"},
        _counts(100, 50, 30, 5),
        _counts(80, 40, 25, 3),
    ])
    _patch_pool(monkeypatch, conn2)
    asyncio.run(rollback(42, _FakeRequest()))

    plain_audits = [a for a in captured["audits"]
                    if a["action"] == "restore_point_rollback"]
    assert len(plain_audits) == 1
    assert "shortcut" not in plain_audits[0]["details"]


def test_rollback_target_missing_404_no_audit(monkeypatch, captured):
    """目标恢复点不存在 → 404，且不写任何审计（counts 更无从谈起）。"""
    conn = _Conn(fetchrow_rets=[None])
    _patch_pool(monkeypatch, conn)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(rollback(999, _FakeRequest()))

    assert exc.value.status_code == 404
    assert captured["audits"] == []
    assert captured["restore_calls"] == []
