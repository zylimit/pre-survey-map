"""#50 Phase 12 · 用户管理端点（Spec F22「管理界面」节）

- GET    /users                        用户列表
- POST   /users                        建号（must_change_password=true）
- POST   /users/{id}/reset-password    重设密码 + 吊销全部 session
- POST   /users/{id}/toggle-disabled   禁用/启用（禁用即吊销；admin 角色用户拒禁用）

所有写操作审计 user_manage（username 由 write_audit 从
request.state.user 自动带）。
"""

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from admin.validators import _check_password
from audit.service import write_audit
from auth.service import hash_password, revoke_sessions
from core.db import pool

router = APIRouter()


def _user_dict(r: Any) -> dict[str, Any]:
    return {
        "id": r["id"],
        "username": r["username"],
        "role_id": r["role_id"],
        "role_name": r["role_name"],
        "disabled": r["disabled"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
    }


@router.get("/users")
async def list_users() -> list[dict[str, Any]]:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT u.id, u.username, u.role_id, r.name AS role_name,"
            " u.disabled, u.created_at"
            " FROM app_user u LEFT JOIN app_role r ON r.id = u.role_id"
            " ORDER BY u.id"
        )
    return [_user_dict(r) for r in rows]


class CreateUserBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str
    role_id: int
    password: str


@router.post("/users", status_code=201)
async def create_user(body: CreateUserBody, request: Request) -> dict[str, Any]:
    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="username 不能为空")
    _check_password(body.password)
    async with pool().acquire() as conn:
        role = await conn.fetchrow(
            "SELECT id, name FROM app_role WHERE id = $1", body.role_id
        )
        if role is None:
            raise HTTPException(status_code=400, detail=f"角色 {body.role_id} 不存在")
        dup = await conn.fetchval(
            "SELECT 1 FROM app_user WHERE username = $1", username
        )
        if dup:
            raise HTTPException(status_code=400, detail=f"用户名 {username} 已存在")
        row = await conn.fetchrow(
            "INSERT INTO app_user (username, password_hash, role_id)"
            " VALUES ($1, $2, $3)"
            " RETURNING id, username, role_id, disabled, created_at",
            username,
            hash_password(body.password),
            body.role_id,
        )
    await write_audit(
        action="user_manage",
        details={"target": username, "action": "create", "role_id": body.role_id},
        request=request,
    )
    return {**_user_dict({**row, "role_name": role["name"]})}


class ResetPasswordBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    password: str


@router.post("/users/{user_id}/reset-password")
async def reset_password(
    user_id: int, body: ResetPasswordBody, request: Request
) -> dict[str, Any]:
    _check_password(body.password)
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, username FROM app_user WHERE id = $1", user_id
        )
        if row is None:
            raise HTTPException(status_code=404, detail=f"用户 {user_id} 不存在")
        await conn.execute(
            "UPDATE app_user SET password_hash = $1, must_change_password = true"
            " WHERE id = $2",
            hash_password(body.password),
            user_id,
        )
        # 重设密码 → 该用户全部 session 立即吊销（下次请求 401）
        await revoke_sessions(conn, user_id)
    await write_audit(
        action="user_manage",
        details={"target": row["username"], "action": "reset"},
        request=request,
    )
    return {"ok": True, "id": user_id}


@router.post("/users/{user_id}/toggle-disabled")
async def toggle_disabled(user_id: int, request: Request) -> dict[str, Any]:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT u.id, u.username, u.disabled, r.is_admin"
            " FROM app_user u JOIN app_role r ON r.id = u.role_id"
            " WHERE u.id = $1",
            user_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail=f"用户 {user_id} 不存在")
        if row["is_admin"]:
            raise HTTPException(
                status_code=400, detail="admin 角色的用户不可禁用"
            )
        new_val = not row["disabled"]
        await conn.execute(
            "UPDATE app_user SET disabled = $1 WHERE id = $2", new_val, user_id
        )
        if new_val:
            # 禁用 → 全部 session 立即吊销
            await revoke_sessions(conn, user_id)
    await write_audit(
        action="user_manage",
        details={
            "target": row["username"],
            "action": "disable" if new_val else "enable",
        },
        request=request,
    )
    return {"id": user_id, "disabled": new_val}
