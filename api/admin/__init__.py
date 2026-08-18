"""#50 Phase 12 · 管理 feature 包（Spec F22「管理界面」节）。

对外接口：router（/api/admin 端点，users/roles CRUD，全部 admin-only）。
聚合 users / roles 子路由，统一挂 require_admin 依赖（非 admin → 403）。
"""

from fastapi import APIRouter, Depends

from admin import roles, users
from auth.permissions import require_admin

router = APIRouter(dependencies=[Depends(require_admin)])
router.include_router(users.router)
router.include_router(roles.router)

__all__ = ["router"]
