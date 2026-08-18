"""#50 Phase 11 后端认证回归测试（不连真库，monkeypatch 范式同 test_site_crud_48）。
绑定点：登录锁定计数、滑动续期 SQL、吊销保留当前 session、login/login_failed/logout 审计。
"""

import asyncio
from datetime import datetime, timedelta, timezone

import importlib

import pytest
from fastapi import HTTPException

# __init__ 把 APIRouter 对象 re-export 成 auth.router，遮蔽同名子模块属性，
# 故用 importlib 取回真正的模块对象（monkeypatch 要打在模块命名空间上）。
auth_router = importlib.import_module("auth.router")
from auth.router import ChangePasswordBody, LoginBody
from auth.service import hash_password, resolve_user, verify_password


class _FakeRequest:
    def __init__(self, user=None, token=None, ip="1.2.3.4"):
        self.headers = {"x-forwarded-for": ip}
        self.client = None

        class _State:
            session_id = "test-sid"

        self.state = _State()
        if user is not None:
            self.state.user = user
        if token is not None:
            self.state.auth_token = token


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
    """按 SQL 关键字分发返回值；execute 全量记录用于断言。"""

    def __init__(self, *, user_row=None, session_row=None, scope_rows=None,
                 fetchrow_ret=None):
        self.user_row = user_row
        self.session_row = session_row
        self.scope_rows = scope_rows or []
        self.fetchrow_ret = fetchrow_ret
        self.exec_log = []  # [(sql, args)]
        self.fetchrow_calls = 0

    async def fetchrow(self, sql, *args):
        self.fetchrow_calls += 1
        if "FROM auth_session s" in sql:
            return self.session_row
        if "FROM app_user u JOIN app_role" in sql:
            return self.user_row
        return self.fetchrow_ret

    async def fetch(self, sql, *args):
        return self.scope_rows

    async def execute(self, sql, *args):
        self.exec_log.append((sql, args))
        return "OK"


@pytest.fixture(autouse=True)
def _clear_fail_count():
    auth_router._FAIL.clear()
    yield
    auth_router._FAIL.clear()


@pytest.fixture
def audits(monkeypatch):
    cap = []

    async def fake(action, details=None, result="success", error_msg=None,
                   request=None, username=None):
        cap.append({"action": action, "details": details or {},
                    "result": result, "username": username})

    monkeypatch.setattr(auth_router, "write_audit", fake)
    return cap


def _patch_pool(monkeypatch, conn):
    monkeypatch.setattr(auth_router, "pool", lambda: _Pool(conn))


def _user_row(disabled=False, perms='{"import": true}'):
    return {"user_id": 1, "username": "admin",
            "password_hash": hash_password("secret123"), "disabled": disabled,
            "must_change_password": True, "role_id": 7, "is_admin": True,
            "perms": perms}


def _session_row(expires_at=None, disabled=False):
    return {"token": "tok",
            "expires_at": expires_at or datetime.now(timezone.utc) + timedelta(days=1),
            "user_id": 1, "username": "admin", "disabled": disabled,
            "must_change_password": False, "role_id": 7, "is_admin": True,
            "perms": {}}


def _call_login(username="admin", password="secret123", ip="1.2.3.4"):
    body = LoginBody(username=username, password=password)
    return asyncio.run(auth_router.login(body, _FakeRequest(ip=ip)))


def test_hash_verify_roundtrip():
    h = hash_password("p@ss-密码-123")
    assert h != "p@ss-密码-123"
    assert verify_password("p@ss-密码-123", h) is True
    assert verify_password("wrong", h) is False


def test_password_over_72_bytes_rejected():
    with pytest.raises(ValueError):
        hash_password("x" * 73)
    assert verify_password("x" * 73, hash_password("x")) is False


def test_login_success_issues_token_and_audit(monkeypatch, audits):
    conn = _Conn(user_row=_user_row(), scope_rows=[{"scope_node": "site"}])
    _patch_pool(monkeypatch, conn)
    resp = _call_login()
    assert isinstance(resp["token"], str) and len(resp["token"]) > 20
    assert resp["user"]["username"] == "admin"
    assert resp["user"]["is_admin"] is True
    assert resp["user"]["perms"] == {"import": True}  # jsonb str → dict
    assert resp["user"]["scopes"] == ["site"]
    assert resp["user"]["must_change_password"] is True
    # session 入库（参数化 INSERT）
    assert any("INSERT INTO auth_session" in sql for sql, _ in conn.exec_log)
    # 审计 login 且带 username
    assert audits == [{"action": "login", "details": {"username": "admin"},
                       "result": "success", "username": "admin"}]


def test_login_wrong_password_401_and_audit(monkeypatch, audits):
    conn = _Conn(user_row=_user_row())
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        _call_login(password="bad")
    assert exc.value.status_code == 401
    assert exc.value.detail == "invalid credentials"
    assert not any("INSERT INTO auth_session" in sql for sql, _ in conn.exec_log)
    assert audits[-1]["action"] == "login_failed"
    assert audits[-1]["username"] == "admin"


def test_login_unknown_user_401(monkeypatch, audits):
    _patch_pool(monkeypatch, _Conn(user_row=None))
    with pytest.raises(HTTPException) as exc:
        _call_login(username="ghost")
    assert exc.value.status_code == 401
    assert audits[-1] == {"action": "login_failed",
                          "details": {"username": "ghost"},
                          "result": "failure", "username": "ghost"}


def test_login_disabled_user_401(monkeypatch, audits):
    _patch_pool(monkeypatch, _Conn(user_row=_user_row(disabled=True)))
    with pytest.raises(HTTPException) as exc:
        _call_login()
    assert exc.value.status_code == 401
    assert audits[-1]["action"] == "login_failed"


def test_login_locks_after_5_failures(monkeypatch, audits):
    conn = _Conn(user_row=_user_row())
    _patch_pool(monkeypatch, conn)
    for _ in range(5):
        with pytest.raises(HTTPException) as exc:
            _call_login(password="bad")
        assert exc.value.status_code == 401
    calls_before = conn.fetchrow_calls
    with pytest.raises(HTTPException) as exc:
        _call_login(password="bad")
    assert exc.value.status_code == 401
    assert "locked" in exc.value.detail
    assert conn.fetchrow_calls == calls_before  # 锁定短路：不再查库
    # 5 条失败审计 + 1 条锁定审计
    assert sum(1 for a in audits if a["action"] == "login_failed") == 6


def test_login_success_resets_fail_count(monkeypatch, audits):
    _patch_pool(monkeypatch, _Conn(user_row=_user_row()))
    for _ in range(4):
        with pytest.raises(HTTPException):
            _call_login(password="bad")
    _call_login()  # 成功 → 计数清零
    with pytest.raises(HTTPException) as exc:
        _call_login(password="bad")
    assert exc.value.detail == "invalid credentials"  # 只失败 1 次，不得锁定


def test_logout_revokes_token_and_audit(monkeypatch, audits):
    conn = _Conn()
    _patch_pool(monkeypatch, conn)
    req = _FakeRequest(user={"username": "admin"}, token="tok")
    resp = asyncio.run(auth_router.logout(req))
    assert resp == {"ok": True}
    assert conn.exec_log == [("DELETE FROM auth_session WHERE token = $1", ("tok",))]
    assert audits == [{"action": "logout", "details": {"username": "admin"},
                       "result": "success", "username": "admin"}]


def test_resolve_none_cases():
    # 吊销后查无此行
    assert asyncio.run(resolve_user(_Conn(session_row=None), "tok")) is None
    # 过期 → None 且不续期
    conn = _Conn(session_row=_session_row(
        expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
    assert asyncio.run(resolve_user(conn, "tok")) is None
    assert conn.exec_log == []
    # 禁用 → None
    disabled = _Conn(session_row=_session_row(disabled=True))
    assert asyncio.run(resolve_user(disabled, "tok")) is None


def test_resolve_valid_sliding_renewal():
    conn = _Conn(session_row=_session_row(), scope_rows=[{"scope_node": "road"}])
    user = asyncio.run(resolve_user(conn, "tok"))
    assert user["username"] == "admin"
    assert user["is_admin"] is True
    assert user["scopes"] == ["road"]
    assert user["token"] == "tok"
    # 滑动续期：UPDATE expires_at = now + 7 天
    updates = [sql for sql, _ in conn.exec_log if "UPDATE auth_session" in sql]
    assert len(updates) == 1
    assert "expires_at" in updates[0]


def test_me_returns_current_user():
    req = _FakeRequest(user={"username": "admin", "is_admin": True,
                             "perms": {"import": True}, "scopes": ["site"],
                             "must_change_password": False})
    resp = asyncio.run(auth_router.me(req))
    assert resp["user"]["username"] == "admin"
    assert resp["user"]["perms"] == {"import": True}


def test_me_unauthenticated_401():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(auth_router.me(_FakeRequest()))
    assert exc.value.status_code == 401


def _call_change_password(old, new, token="tok"):
    body = ChangePasswordBody(old_password=old, new_password=new)
    req = _FakeRequest(user={"username": "admin", "user_id": 1}, token=token)
    return asyncio.run(auth_router.change_password(body, req))


def test_change_password_wrong_old_401(monkeypatch):
    conn = _Conn(fetchrow_ret={"password_hash": hash_password("right-old")})
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        _call_change_password("wrong-old", "new-pass-1")
    assert exc.value.status_code == 401
    assert conn.exec_log == []  # 不改库


def test_change_password_short_new_400(monkeypatch):
    conn = _Conn()
    _patch_pool(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        _call_change_password("old", "short")
    assert exc.value.status_code == 400
    assert conn.fetchrow_calls == 0  # 参数校验先于 DB


def test_change_password_success_revokes_others_keeps_current(monkeypatch):
    conn = _Conn(fetchrow_ret={"password_hash": hash_password("old-pass-1")})
    _patch_pool(monkeypatch, conn)
    resp = _call_change_password("old-pass-1", "new-pass-1", token="current-tok")
    assert resp == {"ok": True}
    sqls = [sql for sql, _ in conn.exec_log]
    update = next(s for s in sqls if "UPDATE app_user" in s)
    assert "must_change_password = false" in update  # 取消强制改密
    delete = next(s for s in sqls if "DELETE FROM auth_session" in s)
    assert "token <>" in delete  # 吊销其他、保留当前
    args = next(a for s, a in conn.exec_log if "DELETE FROM auth_session" in s)
    assert args == (1, "current-tok")
