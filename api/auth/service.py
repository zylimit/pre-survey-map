"""#50 Phase 11 · 认证核心（Spec F22「登录」节）

- hash/verify：bcrypt（>72 字节拒——bcrypt 硬性上限，超长直接 ValueError/False）
- session：DB token（auth_session 表，非 JWT——admin 禁用/重置须立即吊销）
- 过期：7 天滑动（resolve_user 命中即续期 expires_at = now + 7d）
- 清理：session_cleanup_loop 每日删过期行（lifespan 挂 asyncio task，仿 backup_scheduler）
"""

import asyncio
import json
import logging
import secrets
from datetime import datetime, timezone
from typing import Any, Optional

import bcrypt

from core.db import pool

logger = logging.getLogger("auth")

SESSION_DAYS = 7
PASSWORD_MAX_BYTES = 72  # bcrypt 上限
CLEANUP_INTERVAL_SECONDS = 24 * 3600  # 每日清理过期 session


def hash_password(pw: str) -> str:
    """bcrypt 哈希；>72 字节抛 ValueError（调用方转 400）。"""
    data = pw.encode("utf-8")
    if len(data) > PASSWORD_MAX_BYTES:
        raise ValueError("password exceeds 72 bytes")
    return bcrypt.hashpw(data, bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    """校验密码；超长或哈希非法一律 False，不抛。"""
    data = pw.encode("utf-8")
    if len(data) > PASSWORD_MAX_BYTES:
        return False
    try:
        return bcrypt.checkpw(data, hashed.encode("utf-8"))
    except ValueError:
        return False


def coerce_perms(raw: Any) -> dict:
    """asyncpg 默认把 jsonb 解码成 str，统一转成 dict。"""
    if isinstance(raw, str):
        return json.loads(raw)
    return dict(raw or {})


async def create_session(conn, user_id: int) -> str:
    """签发 session token（URL-safe 32 字节随机），expires = now + 7 天。"""
    token = secrets.token_urlsafe(32)
    await conn.execute(
        "INSERT INTO auth_session (token, user_id, expires_at)"
        " VALUES ($1, $2, now() + make_interval(days => $3))",
        token,
        user_id,
        SESSION_DAYS,
    )
    return token


async def load_scopes(conn, role_id: int) -> list[str]:
    rows = await conn.fetch(
        "SELECT scope_node FROM app_role_scope WHERE role_id = $1 ORDER BY id",
        role_id,
    )
    return [r["scope_node"] for r in rows]


async def resolve_user(conn, token: str) -> Optional[dict]:
    """token → 用户 dict（JOIN app_user + app_role + scopes）。

    过期或 disabled → None；命中有效 session 则滑动续期 expires_at = now + 7 天。
    """
    row = await conn.fetchrow(
        "SELECT s.token, s.expires_at,"
        " u.id AS user_id, u.username, u.disabled, u.must_change_password,"
        " u.role_id, r.is_admin, r.perms"
        " FROM auth_session s"
        " JOIN app_user u ON u.id = s.user_id"
        " JOIN app_role r ON r.id = u.role_id"
        " WHERE s.token = $1",
        token,
    )
    if row is None:
        return None
    expires_at = row["expires_at"]
    if expires_at is None or expires_at <= datetime.now(timezone.utc):
        return None
    if row["disabled"]:
        return None
    # 滑动续期：有活动自动续 7 天
    await conn.execute(
        "UPDATE auth_session SET expires_at = now() + make_interval(days => $2)"
        " WHERE token = $1",
        token,
        SESSION_DAYS,
    )
    return {
        "user_id": row["user_id"],
        "username": row["username"],
        "role_id": row["role_id"],
        "is_admin": row["is_admin"],
        "perms": coerce_perms(row["perms"]),
        "scopes": await load_scopes(conn, row["role_id"]),
        "must_change_password": row["must_change_password"],
        "disabled": row["disabled"],
        "token": token,
    }


async def revoke_sessions(conn, user_id: int, keep_token: Optional[str] = None) -> None:
    """吊销该用户全部 session；keep_token 给定时保留当前会话（改密场景）。"""
    if keep_token:
        await conn.execute(
            "DELETE FROM auth_session WHERE user_id = $1 AND token <> $2",
            user_id,
            keep_token,
        )
    else:
        await conn.execute(
            "DELETE FROM auth_session WHERE user_id = $1",
            user_id,
        )


async def cleanup_expired_sessions(conn) -> None:
    await conn.execute("DELETE FROM auth_session WHERE expires_at <= now()")


async def session_cleanup_loop() -> None:
    """后台循环：每日清理过期 session。由 lifespan 创建/取消（仿 backup_loop）。"""
    while True:
        try:
            await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
            async with pool().acquire() as conn:
                await cleanup_expired_sessions(conn)
            logger.info("过期 session 清理完成")
        except asyncio.CancelledError:
            break
        except Exception as e:  # noqa: BLE001 — 清理失败不阻塞 api
            logger.error(f"过期 session 清理失败：{e}")
