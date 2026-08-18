"""#50 Phase 11 · 认证端点（Spec F22「登录」节）

- POST /api/auth/login           白名单（鉴权中间件放行）；成功发 token + 审计 login
- POST /api/auth/logout          吊销当前 token + 审计 logout
- GET  /api/auth/me              当前用户 + 角色 perms + scopes（前端启动拉一次）
- POST /api/auth/change-password 校验旧密码 → 改 hash + 吊销其他 session（留当前）

登录锁定：内存计数器 _FAIL[(username, ip)]，连续失败 5 次锁 10 分钟
（重启清零可接受——Spec「防内网脚本爆破，够用即止」）。
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from audit.service import write_audit
from core.db import pool

from .service import (
    coerce_perms,
    create_session,
    hash_password,
    load_scopes,
    revoke_sessions,
    verify_password,
)

router = APIRouter()
logger = logging.getLogger("auth.router")

LOCK_THRESHOLD = 5
LOCK_MINUTES = 10
# (username, ip) -> {"count": int, "locked_until": datetime | None}
_FAIL: dict[tuple[str, str], dict] = {}


class LoginBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str
    password: str


class ChangePasswordBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    old_password: str
    new_password: str


def _client_ip(request: Request) -> str:
    """与 audit._ip_of 同优先级：XFF 第一段 → X-Real-IP → client.host。"""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    xri = request.headers.get("x-real-ip")
    if xri:
        return xri.strip()
    if request.client:
        return request.client.host
    return "unknown"


def _public_user(user: dict) -> dict:
    """login/me 响应里的用户结构（不含内部字段）。"""
    return {
        "username": user["username"],
        "is_admin": user["is_admin"],
        "perms": user["perms"],
        "scopes": user["scopes"],
        "must_change_password": user["must_change_password"],
    }


def _current_user(request: Request) -> dict:
    """取鉴权中间件注入的 request.state.user；缺失 → 401（防御，正常到不了）。"""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="unauthenticated")
    return user


def _record_fail(key: tuple[str, str]) -> None:
    entry = _FAIL.setdefault(key, {"count": 0, "locked_until": None})
    entry["count"] += 1
    if entry["count"] >= LOCK_THRESHOLD:
        entry["locked_until"] = datetime.now(timezone.utc) + timedelta(
            minutes=LOCK_MINUTES
        )
        entry["count"] = 0


def _is_locked(key: tuple[str, str]) -> bool:
    entry = _FAIL.get(key)
    if not entry or not entry.get("locked_until"):
        return False
    if entry["locked_until"] > datetime.now(timezone.utc):
        return True
    # 锁已过期 → 清掉重新计
    _FAIL.pop(key, None)
    return False


@router.post("/login")
async def login(body: LoginBody, request: Request):
    key = (body.username, _client_ip(request))
    if _is_locked(key):
        await write_audit(
            action="login_failed",
            details={"username": body.username, "reason": "locked"},
            result="failure",
            username=body.username,
            request=request,
        )
        raise HTTPException(status_code=401, detail="account locked, try again later")

    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT u.id AS user_id, u.username, u.password_hash, u.disabled,"
            " u.must_change_password, u.role_id, r.is_admin, r.perms"
            " FROM app_user u JOIN app_role r ON r.id = u.role_id"
            " WHERE u.username = $1",
            body.username,
        )
        ok = (
            row is not None
            and not row["disabled"]
            and verify_password(body.password, row["password_hash"])
        )
        if not ok:
            _record_fail(key)
            await write_audit(
                action="login_failed",
                details={"username": body.username},
                result="failure",
                username=body.username,
                request=request,
            )
            raise HTTPException(status_code=401, detail="invalid credentials")

        _FAIL.pop(key, None)  # 成功 → 该组合计数清零
        token = await create_session(conn, row["user_id"])
        user = {
            "user_id": row["user_id"],
            "username": row["username"],
            "role_id": row["role_id"],
            "is_admin": row["is_admin"],
            "perms": coerce_perms(row["perms"]),
            "scopes": await load_scopes(conn, row["role_id"]),
            "must_change_password": row["must_change_password"],
        }

    await write_audit(
        action="login",
        details={"username": row["username"]},
        username=row["username"],
        request=request,
    )
    return {"token": token, "user": _public_user(user)}


@router.post("/logout")
async def logout(request: Request):
    user = _current_user(request)
    token = getattr(request.state, "auth_token", None)
    async with pool().acquire() as conn:
        if token:
            await conn.execute("DELETE FROM auth_session WHERE token = $1", token)
    await write_audit(
        action="logout",
        details={"username": user["username"]},
        username=user["username"],
        request=request,
    )
    return {"ok": True}


@router.get("/me")
async def me(request: Request):
    return {"user": _public_user(_current_user(request))}


@router.post("/change-password")
async def change_password(body: ChangePasswordBody, request: Request):
    user = _current_user(request)
    new_bytes = body.new_password.encode("utf-8")
    if len(new_bytes) < 8:
        raise HTTPException(status_code=400, detail="new password must be at least 8 bytes")
    if len(new_bytes) > 72:
        raise HTTPException(status_code=400, detail="new password exceeds 72 bytes")

    token: Optional[str] = getattr(request.state, "auth_token", None)
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT password_hash FROM app_user WHERE id = $1", user["user_id"]
        )
        if row is None or not verify_password(body.old_password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="invalid credentials")
        await conn.execute(
            "UPDATE app_user SET password_hash = $1, must_change_password = false"
            " WHERE id = $2",
            hash_password(body.new_password),
            user["user_id"],
        )
        # 吊销该用户其他全部 session，保留当前
        await revoke_sessions(conn, user["user_id"], keep_token=token)
    return {"ok": True}
