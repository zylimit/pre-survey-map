"""#50 Phase 11 · 鉴权中间件（Spec F22「登录」节）

白名单：POST /api/auth/login、GET /health、非 /api 路径（/docs /openapi.json 等）。
其余所有 /api 请求校验 Authorization: Bearer <token> → resolve_user：
- 无效/过期/禁用 → 401 {"detail": "unauthenticated"}
- 有效 → request.state.user = user dict、request.state.auth_token = token

纯 ASGI 实现（与 SessionCookieMiddleware 同风格），不用 BaseHTTPMiddleware，
避免其 asyncio Queue 机制在大文件上传时导致 multipart 解析失败。

挂载顺序：注册在 SessionCookieMiddleware 之后（= 更外层，先跑鉴权），
未认证请求不会签发 presurvey_sid cookie，也不触发 open 审计。
"""

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from db import pool

from .service import resolve_user


class AuthMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        method = scope.get("method", "")

        # 白名单：非 /api 路径、健康检查、登录端点
        if (
            not path.startswith("/api")
            or path == "/health"
            or (path == "/api/auth/login" and method == "POST")
        ):
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        auth_header = headers.get(b"authorization", b"").decode("latin-1")
        token = None
        if auth_header.startswith("Bearer "):
            token = auth_header[len("Bearer "):].strip() or None

        user = None
        if token:
            async with pool().acquire() as conn:
                user = await resolve_user(conn, token)

        if user is None:
            response = JSONResponse(
                status_code=401, content={"detail": "unauthenticated"}
            )
            await response(scope, receive, send)
            return

        if "state" not in scope:
            scope["state"] = {}
        scope["state"]["user"] = user
        scope["state"]["auth_token"] = token
        await self.app(scope, receive, send)
