"""#50 Phase 12 · 角色管理端点（Spec F22「管理界面」节）

- GET    /roles         角色列表（perms + scopes + 挂载用户数）
- POST   /roles         建角色（scopes 值域校验）
- PATCH  /roles/{id}    改角色（is_admin 拒改）
- DELETE /roles/{id}    删角色（is_admin 拒删；有用户挂载拒删）

所有写操作审计 role_manage，details 记角色名 + 权限快照（perms + scopes，
改/删快照取变更后/删除前的当前值，与 create 对齐）。
"""

import json
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from admin.validators import _check_perms, _check_scopes
from audit.service import write_audit
from auth.service import coerce_perms
from core.db import pool

router = APIRouter()


@router.get("/roles")
async def list_roles() -> list[dict[str, Any]]:
    async with pool().acquire() as conn:
        roles = await conn.fetch(
            "SELECT r.id, r.name, r.is_admin, r.perms, r.created_at,"
            " (SELECT count(*)::int FROM app_user u WHERE u.role_id = r.id)"
            " AS user_count FROM app_role r ORDER BY r.id"
        )
        scope_rows = await conn.fetch(
            "SELECT role_id, scope_node FROM app_role_scope ORDER BY id"
        )
    scopes_by_role: dict[int, list[str]] = {}
    for s in scope_rows:
        scopes_by_role.setdefault(s["role_id"], []).append(s["scope_node"])
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "is_admin": r["is_admin"],
            "perms": coerce_perms(r["perms"]),
            "scopes": scopes_by_role.get(r["id"], []),
            "user_count": r["user_count"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        }
        for r in roles
    ]


class CreateRoleBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    perms: dict[str, Any] = {}
    scopes: list[str] = []


async def _insert_scopes(conn: Any, role_id: int, scopes: list[str]) -> None:
    for s in scopes:
        await conn.execute(
            "INSERT INTO app_role_scope (role_id, scope_node) VALUES ($1, $2)"
            " ON CONFLICT DO NOTHING",
            role_id,
            s,
        )


@router.post("/roles", status_code=201)
async def create_role(body: CreateRoleBody, request: Request) -> dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="角色名不能为空")
    perms = _check_perms(body.perms)
    scopes = _check_scopes(body.scopes)
    async with pool().acquire() as conn:
        dup = await conn.fetchval("SELECT 1 FROM app_role WHERE name = $1", name)
        if dup:
            raise HTTPException(status_code=400, detail=f"角色名 {name} 已存在")
        async with conn.transaction():
            role_id = await conn.fetchval(
                "INSERT INTO app_role (name, perms) VALUES ($1, $2::jsonb)"
                " RETURNING id",
                name,
                json.dumps(perms),
            )
            await _insert_scopes(conn, role_id, scopes)
    await write_audit(
        action="role_manage",
        details={
            "target": name,
            "action": "create",
            "perms": perms,
            "scopes": scopes,
        },
        request=request,
    )
    return {
        "id": role_id,
        "name": name,
        "is_admin": False,
        "perms": perms,
        "scopes": scopes,
        "user_count": 0,
    }


class PatchRoleBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = None
    perms: Optional[dict[str, Any]] = None
    scopes: Optional[list[str]] = None


@router.patch("/roles/{role_id}")
async def update_role(
    role_id: int, body: PatchRoleBody, request: Request
) -> dict[str, Any]:
    async with pool().acquire() as conn:
        role = await conn.fetchrow(
            "SELECT id, name, is_admin, perms FROM app_role WHERE id = $1", role_id
        )
        if role is None:
            raise HTTPException(status_code=404, detail=f"角色 {role_id} 不存在")
        if role["is_admin"]:
            raise HTTPException(status_code=400, detail="内置 admin 角色不可修改")

        new_name = body.name.strip() if body.name is not None else None
        if new_name is not None and not new_name:
            raise HTTPException(status_code=400, detail="角色名不能为空")
        perms = _check_perms(body.perms) if body.perms is not None else None
        scopes = _check_scopes(body.scopes) if body.scopes is not None else None

        if new_name is not None and new_name != role["name"]:
            dup = await conn.fetchval(
                "SELECT 1 FROM app_role WHERE name = $1 AND id <> $2",
                new_name,
                role_id,
            )
            if dup:
                raise HTTPException(
                    status_code=400, detail=f"角色名 {new_name} 已存在"
                )

        changed: list[str] = []
        async with conn.transaction():
            if new_name is not None and new_name != role["name"]:
                await conn.execute(
                    "UPDATE app_role SET name = $1 WHERE id = $2", new_name, role_id
                )
                changed.append("name")
            if perms is not None:
                await conn.execute(
                    "UPDATE app_role SET perms = $1::jsonb WHERE id = $2",
                    json.dumps(perms),
                    role_id,
                )
                changed.append("perms")
            if scopes is not None:
                await conn.execute(
                    "DELETE FROM app_role_scope WHERE role_id = $1", role_id
                )
                await _insert_scopes(conn, role_id, scopes)
                changed.append("scopes")

        # 审计快照取变更后当前值：未改的维度从库里读
        if scopes is None:
            scope_rows = await conn.fetch(
                "SELECT scope_node FROM app_role_scope"
                " WHERE role_id = $1 ORDER BY id",
                role_id,
            )
            cur_scopes = [r["scope_node"] for r in scope_rows]
        else:
            cur_scopes = scopes
    cur_perms = perms if perms is not None else coerce_perms(role["perms"])
    await write_audit(
        action="role_manage",
        details={
            "target": new_name or role["name"],
            "action": "update",
            "changed": changed,
            "perms": cur_perms,
            "scopes": cur_scopes,
        },
        request=request,
    )
    return {"id": role_id, "changed": changed}


@router.delete("/roles/{role_id}")
async def delete_role(role_id: int, request: Request) -> dict[str, Any]:
    async with pool().acquire() as conn:
        role = await conn.fetchrow(
            "SELECT id, name, is_admin, perms FROM app_role WHERE id = $1", role_id
        )
        if role is None:
            raise HTTPException(status_code=404, detail=f"角色 {role_id} 不存在")
        if role["is_admin"]:
            raise HTTPException(status_code=400, detail="内置 admin 角色不可删除")
        n = await conn.fetchval(
            "SELECT count(*) FROM app_user WHERE role_id = $1", role_id
        )
        if n:
            raise HTTPException(
                status_code=400,
                detail=f"角色仍挂载 {n} 个用户，请先迁移用户",
            )
        # 删除前取权限快照（scopes 随角色删除而消失）
        scope_rows = await conn.fetch(
            "SELECT scope_node FROM app_role_scope WHERE role_id = $1 ORDER BY id",
            role_id,
        )
        await conn.execute("DELETE FROM app_role WHERE id = $1", role_id)
    await write_audit(
        action="role_manage",
        details={
            "target": role["name"],
            "action": "delete",
            "perms": coerce_perms(role["perms"]),
            "scopes": [r["scope_node"] for r in scope_rows],
        },
        request=request,
    )
    return {"deleted": role_id}
