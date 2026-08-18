"""#50 Phase 12 管理接口 + 功能权限门控回归测试（不连真库，monkeypatch 范式）。

绑定点：
- auth/permissions.py：require_admin / require_perm 放行与 403
- admin/users.py：用户 CRUD（建号/重复 400/重置吊销/admin 用户拒禁用）
- admin/roles.py：角色 CRUD（is_admin 拒改拒删/有用户挂载拒删/scopes 值域校验）、
  审计快照（create/update/delete 均记 perms+scopes）
"""

import asyncio
import importlib
import json
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

# monkeypatch 要打在端点所在模块的命名空间上（pool/write_audit/hash_password
# 均为模块级 import），用 importlib 取回子模块对象。
admin_users = importlib.import_module("admin.users")
admin_roles = importlib.import_module("admin.roles")
from admin.users import (
    CreateUserBody,
    ResetPasswordBody,
    create_user,
    reset_password,
    toggle_disabled,
)
from admin.roles import (
    CreateRoleBody,
    PatchRoleBody,
    create_role,
    delete_role,
    list_roles,
    update_role,
)
from auth.permissions import require_admin, require_perm


DT = datetime(2026, 8, 1, 12, 0, 0, tzinfo=timezone.utc)
ADMIN = {"user_id": 1, "username": "admin", "is_admin": True, "perms": {}, "scopes": []}


class _FakeRequest:
    def __init__(self, user=None):
        self.headers = {}
        self.client = None

        class _State:
            session_id = "test-sid"

        self.state = _State()
        if user is not None:
            self.state.user = user


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
    """队列式返回值（fetchrow/fetchval/fetch 按调用顺序弹出）+ 全量执行日志。"""

    def __init__(self, *, fetchrow_rets=None, fetchval_rets=None, fetch_rets=None):
        self._fetchrow = list(fetchrow_rets or [])
        self._fetchval = list(fetchval_rets or [])
        self._fetch = list(fetch_rets or [])
        self.calls = []
        self.fetchrow_calls = []
        self.fetchval_calls = []
        self.executed = []

    async def fetchrow(self, sql, *args):
        self.calls.append("fetchrow")
        self.fetchrow_calls.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, sql, *args):
        self.calls.append("fetchval")
        self.fetchval_calls.append((sql, args))
        return self._fetchval.pop(0) if self._fetchval else None

    async def fetch(self, sql, *args):
        self.calls.append("fetch")
        return self._fetch.pop(0) if self._fetch else []

    async def execute(self, sql, *args):
        self.calls.append("execute")
        self.executed.append((sql, args))
        return "UPDATE 1"

    def transaction(self):
        return _Tx(self.calls)


@pytest.fixture
def captured(monkeypatch):
    cap = {}

    async def fake_audit(action, details=None, result="success", error_msg=None, request=None, username=None):
        cap.setdefault("audits", []).append({"action": action, "details": details or {}})

    monkeypatch.setattr(admin_users, "write_audit", fake_audit)
    monkeypatch.setattr(admin_roles, "write_audit", fake_audit)
    monkeypatch.setattr(admin_users, "hash_password", lambda pw: f"HASH:{pw}")
    return cap


def _patch_pool(monkeypatch, conn):
    """users/roles 两模块各自 import 了 pool，统一打到同一个假连接上。"""
    fake = lambda: _Pool(conn)
    monkeypatch.setattr(admin_users, "pool", fake)
    monkeypatch.setattr(admin_roles, "pool", fake)


# ───────────────────────── 权限依赖 ─────────────────────────


def test_require_admin_allows_admin():
    out = asyncio.run(require_admin(_FakeRequest(user=ADMIN)))
    assert out is ADMIN


def test_require_admin_rejects_non_admin_403():
    req = _FakeRequest(user={"is_admin": False, "perms": {}})
    with pytest.raises(HTTPException) as exc:
        asyncio.run(require_admin(req))
    assert exc.value.status_code == 403


def test_require_admin_missing_user_401():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(require_admin(_FakeRequest()))
    assert exc.value.status_code == 401


def test_require_perm_admin_always_pass():
    dep = require_perm("danger")
    out = asyncio.run(dep(_FakeRequest(user=ADMIN)))
    assert out is ADMIN


def test_require_perm_with_perm_pass():
    dep = require_perm("import")
    user = {"is_admin": False, "perms": {"import": True}}
    out = asyncio.run(dep(_FakeRequest(user=user)))
    assert out is user


def test_require_perm_without_perm_403():
    dep = require_perm("export")
    req = _FakeRequest(user={"is_admin": False, "perms": {"import": True}})
    with pytest.raises(HTTPException) as exc:
        asyncio.run(dep(req))
    assert exc.value.status_code == 403


# ───────────────────────── 用户管理 ─────────────────────────


def test_create_user_success(monkeypatch, captured):
    conn = _Conn(
        fetchrow_rets=[
            {"id": 2, "name": "Globe PM"},  # 角色存在性
            {"id": 5, "username": "u1", "role_id": 2, "disabled": False, "created_at": DT},
        ],
        fetchval_rets=[None],  # 用户名不重复
    )
    _patch_pool(monkeypatch, conn)

    resp = asyncio.run(create_user(
        CreateUserBody(username="u1", role_id=2, password="pass1234"),
        _FakeRequest(user=ADMIN),
    ))

    assert resp["id"] == 5 and resp["role_name"] == "Globe PM" and resp["disabled"] is False
    insert_sql, insert_args = conn.fetchrow_calls[1]
    assert "INSERT INTO app_user" in insert_sql
    assert insert_args == ("u1", "HASH:pass1234", 2)
    assert captured["audits"][0] == {
        "action": "user_manage",
        "details": {"target": "u1", "action": "create", "role_id": 2},
    }


def test_create_user_duplicate_username_400(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[{"id": 2, "name": "R"}], fetchval_rets=[1])
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(create_user(
            CreateUserBody(username="u1", role_id=2, password="pass1234"),
            _FakeRequest(user=ADMIN),
        ))
    assert exc.value.status_code == 400
    assert "audits" not in captured


def test_create_user_role_missing_400(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[None])
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(create_user(
            CreateUserBody(username="u1", role_id=99, password="pass1234"),
            _FakeRequest(user=ADMIN),
        ))
    assert exc.value.status_code == 400


@pytest.mark.parametrize("pw", ["short", "x" * 73])
def test_create_user_password_length_400(pw):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(create_user(
            CreateUserBody(username="u1", role_id=2, password=pw),
            _FakeRequest(user=ADMIN),
        ))
    assert exc.value.status_code == 400


def test_reset_password_updates_hash_and_revokes(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[{"id": 5, "username": "u1"}])
    _patch_pool(monkeypatch, conn)

    resp = asyncio.run(reset_password(
        5, ResetPasswordBody(password="newpass123"), _FakeRequest(user=ADMIN),
    ))

    assert resp == {"ok": True, "id": 5}
    sqls = [s for s, _ in conn.executed]
    assert any("must_change_password = true" in s for s in sqls)
    assert any("HASH:newpass123" in str(a) for _, a in conn.executed)
    assert any("DELETE FROM auth_session" in s for s in sqls)  # 吊销全部 session
    assert captured["audits"][0]["details"] == {"target": "u1", "action": "reset"}


def test_reset_password_user_missing_404(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[None])
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(reset_password(
            99, ResetPasswordBody(password="newpass123"), _FakeRequest(user=ADMIN),
        ))
    assert exc.value.status_code == 404


def test_toggle_disabled_admin_role_user_400(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[
        {"id": 1, "username": "admin", "disabled": False, "is_admin": True}
    ])
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(toggle_disabled(1, _FakeRequest(user=ADMIN)))
    assert exc.value.status_code == 400
    assert "audits" not in captured


def test_toggle_disable_revokes_sessions(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[
        {"id": 5, "username": "u1", "disabled": False, "is_admin": False}
    ])
    _patch_pool(monkeypatch, conn)

    resp = asyncio.run(toggle_disabled(5, _FakeRequest(user=ADMIN)))

    assert resp == {"id": 5, "disabled": True}
    sqls = [s for s, _ in conn.executed]
    assert any("UPDATE app_user SET disabled" in s for s in sqls)
    assert any("DELETE FROM auth_session" in s for s in sqls)  # 禁用即吊销
    assert captured["audits"][0]["details"] == {"target": "u1", "action": "disable"}


def test_toggle_enable_keeps_sessions(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[
        {"id": 5, "username": "u1", "disabled": True, "is_admin": False}
    ])
    _patch_pool(monkeypatch, conn)

    resp = asyncio.run(toggle_disabled(5, _FakeRequest(user=ADMIN)))

    assert resp == {"id": 5, "disabled": False}
    sqls = [s for s, _ in conn.executed]
    assert not any("DELETE FROM auth_session" in s for s in sqls)  # 启用不碰 session
    assert captured["audits"][0]["details"] == {"target": "u1", "action": "enable"}


# ───────────────────────── 角色管理 ─────────────────────────


def test_list_roles_with_scopes_and_user_count(monkeypatch):
    conn = _Conn(fetch_rets=[
        [
            {"id": 1, "name": "admin", "is_admin": True, "perms": "{}", "created_at": DT, "user_count": 1},
            {"id": 2, "name": "Globe PM", "is_admin": False,
             "perms": '{"import": true}', "created_at": DT, "user_count": 2},
        ],
        [{"role_id": 2, "scope_node": "site:Globe"}],
    ])
    _patch_pool(monkeypatch, conn)

    out = asyncio.run(list_roles())

    assert out[0]["is_admin"] is True and out[0]["scopes"] == []
    assert out[1]["perms"] == {"import": True}
    assert out[1]["scopes"] == ["site:Globe"]
    assert out[1]["user_count"] == 2


def test_create_role_success(monkeypatch, captured):
    conn = _Conn(fetchval_rets=[None, 7])  # 不重名 → 插入返回 id=7
    _patch_pool(monkeypatch, conn)

    resp = asyncio.run(create_role(
        CreateRoleBody(name="Globe PM", perms={"import": True},
                       scopes=["site:Globe", "site:Globe:SURVEY"]),
        _FakeRequest(user=ADMIN),
    ))

    assert resp["id"] == 7 and resp["is_admin"] is False
    assert resp["perms"] == {"import": True, "export": False,
                             "edit_delete": False, "danger": False}
    insert_sql, insert_args = conn.fetchval_calls[1]
    assert "INSERT INTO app_role" in insert_sql
    assert json.loads(insert_args[1]) == resp["perms"]
    scope_inserts = [a for s, a in conn.executed if "app_role_scope" in s and "INSERT" in s]
    assert scope_inserts == [(7, "site:Globe"), (7, "site:Globe:SURVEY")]
    assert captured["audits"][0]["action"] == "role_manage"
    assert captured["audits"][0]["details"]["scopes"] == ["site:Globe", "site:Globe:SURVEY"]


def test_create_role_duplicate_name_400(monkeypatch, captured):
    conn = _Conn(fetchval_rets=[1])
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(create_role(CreateRoleBody(name="R"), _FakeRequest(user=ADMIN)))
    assert exc.value.status_code == 400


def test_create_role_invalid_scope_400():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(create_role(
            CreateRoleBody(name="R", scopes=["site:Globe:BAD"]), _FakeRequest(user=ADMIN),
        ))
    assert exc.value.status_code == 400


def test_create_role_invalid_perm_key_400():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(create_role(
            CreateRoleBody(name="R", perms={"sudo": True}), _FakeRequest(user=ADMIN),
        ))
    assert exc.value.status_code == 400


def test_update_role_admin_role_400(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[{"id": 1, "name": "admin", "is_admin": True}])
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(update_role(1, PatchRoleBody(perms={"import": True}),
                                _FakeRequest(user=ADMIN)))
    assert exc.value.status_code == 400


def test_update_role_missing_404(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[None])
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(update_role(99, PatchRoleBody(name="X"), _FakeRequest(user=ADMIN)))
    assert exc.value.status_code == 404


def test_update_role_perms_and_scopes(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[{"id": 7, "name": "R", "is_admin": False}])
    _patch_pool(monkeypatch, conn)

    resp = asyncio.run(update_role(
        7, PatchRoleBody(perms={"danger": True}, scopes=["road"]),
        _FakeRequest(user=ADMIN),
    ))

    assert resp == {"id": 7, "changed": ["perms", "scopes"]}
    sqls = [s for s, _ in conn.executed]
    assert any("UPDATE app_role SET perms" in s for s in sqls)
    assert any("DELETE FROM app_role_scope" in s for s in sqls)
    assert any("INSERT INTO app_role_scope" in s for s in sqls)
    audit = captured["audits"][0]["details"]
    assert audit["changed"] == ["perms", "scopes"]
    assert audit["perms"]["danger"] is True
    assert audit["scopes"] == ["road"]


def test_update_role_name_only_snapshot_from_db(monkeypatch, captured):
    """只改名时，审计快照仍带变更后完整 perms+scopes（从库读当前值）。"""
    conn = _Conn(
        fetchrow_rets=[{"id": 7, "name": "R", "is_admin": False,
                        "perms": '{"import": true}'}],
        fetchval_rets=[None],  # 新名不重复
        fetch_rets=[[{"scope_node": "site:Globe"}]],
    )
    _patch_pool(monkeypatch, conn)

    resp = asyncio.run(update_role(
        7, PatchRoleBody(name="R2"), _FakeRequest(user=ADMIN),
    ))

    assert resp == {"id": 7, "changed": ["name"]}
    audit = captured["audits"][0]["details"]
    assert audit["target"] == "R2" and audit["action"] == "update"
    assert audit["perms"] == {"import": True}
    assert audit["scopes"] == ["site:Globe"]


def test_update_role_duplicate_name_400(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[{"id": 7, "name": "R", "is_admin": False}],
                 fetchval_rets=[1])
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(update_role(7, PatchRoleBody(name="X"), _FakeRequest(user=ADMIN)))
    assert exc.value.status_code == 400


def test_delete_role_admin_role_400(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[{"id": 1, "name": "admin", "is_admin": True}])
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(delete_role(1, _FakeRequest(user=ADMIN)))
    assert exc.value.status_code == 400


def test_delete_role_with_mounted_users_400(monkeypatch, captured):
    conn = _Conn(fetchrow_rets=[{"id": 7, "name": "R", "is_admin": False}],
                 fetchval_rets=[2])
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(delete_role(7, _FakeRequest(user=ADMIN)))
    assert exc.value.status_code == 400
    assert "先迁移用户" in exc.value.detail


def test_delete_role_success(monkeypatch, captured):
    conn = _Conn(
        fetchrow_rets=[{"id": 7, "name": "R", "is_admin": False,
                        "perms": '{"import": true}'}],
        fetchval_rets=[0],
        fetch_rets=[[{"scope_node": "site:Globe"}]],
    )
    _patch_pool(monkeypatch, conn)

    resp = asyncio.run(delete_role(7, _FakeRequest(user=ADMIN)))

    assert resp == {"deleted": 7}
    assert any("DELETE FROM app_role WHERE" in s for s, _ in conn.executed)
    # 审计 details 带被删角色的权限快照（Spec F22）
    assert captured["audits"][0]["details"] == {
        "target": "R",
        "action": "delete",
        "perms": {"import": True},
        "scopes": ["site:Globe"],
    }
