"""F19 · 审计写入辅助（Spec V1.x #23）

write_audit(action, details, result, error_msg, request) → INSERT INTO audit_log

设计要点：
1. 独立连接（pool().acquire()），不参与业务事务 → 业务回滚不影响审计；
   反之审计写入失败也绝不抛出（try/except 兜底 → logger.warning）。
2. ip 优先取 X-Forwarded-For 第一段，其次 X-Real-IP，最后 request.client.host。
3. user_agent 截断 512 字符防异常超长。
4. session_id 由中间件注入到 request.state.session_id。
"""

import json
import logging
from typing import Any, Optional

from starlette.requests import Request

from core.db import pool

logger = logging.getLogger("audit")

UA_MAX = 512


def _ip_of(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    xri = request.headers.get("x-real-ip")
    if xri:
        return xri.strip()
    if request.client:
        return request.client.host
    return None


def _ua_of(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    ua = request.headers.get("user-agent")
    if not ua:
        return None
    return ua[:UA_MAX]


def _sid_of(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    return getattr(request.state, "session_id", None)


def _username_of(request: Optional[Request]) -> Optional[str]:
    """#50 Phase 11：登录态请求从 request.state.user（鉴权中间件注入）取真实用户名。"""
    if request is None:
        return None
    user = getattr(request.state, "user", None)
    if not user:
        return None
    return user.get("username")


async def write_audit(
    action: str,
    details: Optional[dict[str, Any]] = None,
    result: str = "success",
    error_msg: Optional[str] = None,
    request: Optional[Request] = None,
    username: Optional[str] = None,
) -> None:
    """同步写一条审计；失败只 WARNING，绝不抛出。

    username：显式传优先（login/login_failed 时 request.state 尚无 user）；
    未传则自动从 request.state.user 取；未登录请求（login/health）记 NULL。
    """
    if username is None:
        username = _username_of(request)
    try:
        async with pool().acquire() as conn:
            await conn.execute(
                """
                INSERT INTO audit_log
                    (session_id, ip, user_agent, username, action, details, result, error_msg)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
                """,
                _sid_of(request),
                _ip_of(request),
                _ua_of(request),
                username,
                action,
                json.dumps(details or {}, default=str, ensure_ascii=False),
                result,
                error_msg,
            )
    except Exception as e:
        logger.warning(f"audit write failed action={action} err={e!r}")
