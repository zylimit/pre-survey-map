"""#42 · 自动备份恢复 API（Spec F21）。

GET  /api/backups            → 列出 reason='auto_backup' 的备份（时间倒序 + 三类计数）
POST /api/backups/{id}/restore → 还原（body 带密码，校验 mangosv5；复用 F17 rollback）

备份的创建由 backup_scheduler 后台定时任务负责，这里只读+还原。
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from audit import write_audit
from auth.permissions import require_admin
from db import pool
from restore_point_helper import create_restore_point, restore_from_snapshot

# #50 Phase 12：备份恢复端点收编管理界面 → admin-only
router = APIRouter(dependencies=[Depends(require_admin)])

# 同 F19 审计入口，写死后端校验（前端校验可绕过，必须后端把关）
RESTORE_PASSWORD = "mangosv5"


def _row_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "created_at": row["created_at"].isoformat(),
        "reason": row["reason"],
        "note": row["note"],
        "site_count": row["site_count"],
        "road_count": row["road_count"],
        "lessor_count": row["lessor_count"],
        "baseline_iso_a2": row["baseline_iso_a2"],
    }


@router.get("")
async def list_backups():
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM restore_point WHERE reason = 'auto_backup' ORDER BY created_at DESC"
        )
    return [_row_to_dict(r) for r in rows]


class RestoreBody(BaseModel):
    password: str = ""


@router.post("/{rp_id}/restore")
async def restore_backup(rp_id: int, body: RestoreBody, request: Request):
    # 密码后端校验（坑5：前端校验可绕过）
    if body.password != RESTORE_PASSWORD:
        raise HTTPException(status_code=403, detail="密码错误")

    pre_rollback_rp_id: int | None = None
    async with pool().acquire() as conn:
        target = await conn.fetchrow(
            "SELECT id, reason FROM restore_point WHERE id = $1 AND reason = 'auto_backup'",
            rp_id,
        )
        if target is None:
            raise HTTPException(status_code=404, detail=f"备份 {rp_id} 不存在")

        async with conn.transaction():
            # 还原前自建 pre_rollback 点（可逆）；protect_id 保护还原目标不被环淘汰删
            pre_rollback_rp_id = await create_restore_point(conn, "pre_rollback", protect_id=rp_id)
            await restore_from_snapshot(conn, rp_id)

    await write_audit(
        action="backup_restore",
        details={"backup_id": rp_id, "pre_rollback_id": pre_rollback_rp_id},
        request=request,
    )
    if pre_rollback_rp_id is not None:
        await write_audit(
            action="restore_point_create_auto",
            details={"restore_point_id": pre_rollback_rp_id, "reason": "pre_rollback"},
            request=request,
        )
    return {"ok": True, "restored_from": rp_id}
