"""#50 Phase 11 · 认证 feature 包（Spec F22「登录」节）。

对外接口汇总：
- service    ：hash/verify、session 签发/解析/吊销/清理、session_cleanup_loop
- middleware ：AuthMiddleware（纯 ASGI 鉴权）
- router     ：/api/auth 端点（login/logout/me/change-password + 登录锁定）
"""

from auth.middleware import AuthMiddleware
from auth.router import router
from auth.service import (
    cleanup_expired_sessions,
    coerce_perms,
    create_session,
    hash_password,
    load_scopes,
    resolve_user,
    revoke_sessions,
    session_cleanup_loop,
    verify_password,
)

__all__ = [
    "AuthMiddleware",
    "router",
    "cleanup_expired_sessions",
    "coerce_perms",
    "create_session",
    "hash_password",
    "load_scopes",
    "resolve_user",
    "revoke_sessions",
    "session_cleanup_loop",
    "verify_password",
]
