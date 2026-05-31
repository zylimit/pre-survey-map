"""F19 · Session Cookie 中间件（Spec V1.x #23）

每个请求检查 cookie `presurvey_sid`：
- 缺失则生成 uuid4 写入 Set-Cookie（HttpOnly + SameSite=Lax + 1 年过期）
- 注入到 request.state.session_id 供下游 audit.write_audit() 使用
- 同时 cookie 首次创建 → 触发 action=open 审计（仅 GET 请求避免 POST 噪音）
"""

import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

COOKIE_NAME = "presurvey_sid"
COOKIE_MAX_AGE = 365 * 24 * 3600  # 1 年


class SessionCookieMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        sid = request.cookies.get(COOKIE_NAME)
        newly_issued = False
        if not sid:
            sid = uuid.uuid4().hex
            newly_issued = True

        # 注入 request.state，供路由 / audit.write_audit 取
        request.state.session_id = sid
        request.state.session_new = newly_issued

        response = await call_next(request)

        if newly_issued:
            response.set_cookie(
                key=COOKIE_NAME,
                value=sid,
                max_age=COOKIE_MAX_AGE,
                httponly=True,
                samesite="lax",
                path="/",
            )
            # 仅 GET 请求触发 open 审计，POST/DELETE 自带业务审计
            # （首访问浏览器一般是 GET / 或 GET /api/sites）
            try:
                if request.method == "GET":
                    from audit import write_audit  # 延迟导入避免循环
                    await write_audit(
                        action="open",
                        details={"path": request.url.path},
                        request=request,
                    )
            except Exception:
                pass  # 静默，不阻塞响应
        return response
