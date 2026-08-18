"""F19 · Session Cookie 中间件（Spec V1.x #23）

每个请求检查 cookie `presurvey_sid`：
- 缺失则生成 uuid4 写入 Set-Cookie（HttpOnly + SameSite=Lax + 1 年过期）
- 注入到 request.state.session_id 供下游 audit.write_audit() 使用
- 同时 cookie 首次创建 → 触发 action=open 审计（仅 GET 请求避免 POST 噪音）

纯 ASGI 实现，不使用 BaseHTTPMiddleware，避免其 asyncio Queue 机制
在大文件上传时导致 multipart 解析失败。
"""

import uuid

from starlette.types import ASGIApp, Message, Receive, Scope, Send

COOKIE_NAME = "presurvey_sid"
COOKIE_MAX_AGE = 365 * 24 * 3600  # 1 年


class SessionCookieMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        # 从请求头解析 cookies
        headers = dict(scope.get("headers", []))
        cookie_header = headers.get(b"cookie", b"").decode("latin-1")
        cookies = {}
        for part in cookie_header.split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                cookies[k.strip()] = v.strip()

        sid = cookies.get(COOKIE_NAME)
        newly_issued = not sid
        if not sid:
            sid = uuid.uuid4().hex

        # 注入 scope["state"]，供路由 / audit.write_audit 取
        # starlette Request.state 从 scope["state"] 读取
        if "state" not in scope:
            scope["state"] = {}
        scope["state"]["session_id"] = sid
        scope["state"]["session_new"] = newly_issued

        method = scope.get("method", "")

        async def send_with_cookie(message: Message) -> None:
            if message["type"] == "http.response.start" and newly_issued:
                headers_list = list(message.get("headers", []))
                cookie_value = (
                    f"{COOKIE_NAME}={sid}; Max-Age={COOKIE_MAX_AGE}; "
                    f"Path=/; HttpOnly; SameSite=Lax"
                )
                headers_list.append(
                    (b"set-cookie", cookie_value.encode("latin-1"))
                )
                message = {**message, "headers": headers_list}
            await send(message)

        await self.app(scope, receive, send_with_cookie)

        # 仅 GET 请求 + 新 session → 触发 open 审计（异步，不阻塞响应）
        if newly_issued and method == "GET":
            try:
                from starlette.requests import Request
                from audit import write_audit
                request = Request(scope, receive)
                await write_audit(
                    action="open",
                    details={"path": scope.get("path", "")},
                    request=request,
                )
            except Exception:
                pass
