"""#50 Phase 12 · 功能权限门控依赖（Spec F22「权限模型」节）

- require_admin    ：仅 is_admin 放行，否则 403（管理界面/审计/备份端点）
- require_perm(perm)：is_admin 或角色 perms[perm]=true 放行，否则 403
  perm ∈ import / export / edit_delete / danger

依赖返回 user dict，handler 可直接取用做数据权限过滤。
request.state.user 由 AuthMiddleware 注入；缺失 → 401（防御，正常到不了）。
"""

from typing import Any, Callable

from fastapi import HTTPException, Request


def current_user(request: Request) -> dict[str, Any]:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="unauthenticated")
    return user


async def require_admin(request: Request) -> dict[str, Any]:
    user = current_user(request)
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="forbidden: admin only")
    return user


def require_perm(perm: str) -> Callable[..., Any]:
    async def _dep(request: Request) -> dict[str, Any]:
        user = current_user(request)
        if user.get("is_admin"):
            return user
        if (user.get("perms") or {}).get(perm):
            return user
        raise HTTPException(
            status_code=403, detail=f"forbidden: missing perm '{perm}'"
        )

    return _dep
