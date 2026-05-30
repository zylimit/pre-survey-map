"""F17 · 基线恢复点 API（Spec V1.x #20）。

GET    /api/restore-points             → 列表（仅元数据）
POST   /api/restore-points             → 手动建点（reason=manual）
POST   /api/restore-points/{id}/rollback → 覆盖式回滚（事务内先建 pre_rollback）
DELETE /api/restore-points/{id}        → 删除（CASCADE 清快照）
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from db import pool
from restore_point_helper import create_restore_point

router = APIRouter()


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
async def list_restore_points():
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM restore_point ORDER BY created_at DESC"
        )
    return [_row_to_dict(r) for r in rows]


class CreateBody(BaseModel):
    note: Optional[str] = None


@router.post("")
async def create_manual(body: CreateBody):
    async with pool().acquire() as conn:
        async with conn.transaction():
            rp_id = await create_restore_point(conn, "manual", body.note)
        row = await conn.fetchrow("SELECT * FROM restore_point WHERE id = $1", rp_id)
    return _row_to_dict(row)


@router.post("/{rp_id}/rollback")
async def rollback(rp_id: int):
    async with pool().acquire() as conn:
        # 确认目标点存在
        target = await conn.fetchrow(
            "SELECT id FROM restore_point WHERE id = $1", rp_id
        )
        if target is None:
            raise HTTPException(status_code=404, detail=f"恢复点 {rp_id} 不存在")

        async with conn.transaction():
            # 回滚前先建 pre_rollback 点（可逆）；protect_id 保护回滚目标，
            # 防止环形淘汰把目标点连同快照一起删掉导致回滚后数据全空。
            await create_restore_point(conn, "pre_rollback", protect_id=rp_id)

            # 覆盖式回滚：TRUNCATE + 从快照重灌
            await conn.execute("TRUNCATE TABLE site, road, lessor")
            await conn.execute("DELETE FROM baseline_state")

            await conn.execute(
                """
                INSERT INTO site
                    (site_id, "option", project, site_status, lati, longi,
                     extras, source_file, created_at, updated_at, geom)
                SELECT site_id, "option", project, site_status, lati, longi,
                       extras, source_file, created_at, updated_at, geom
                FROM site_snapshot
                WHERE restore_point_id = $1
                """,
                rp_id,
            )
            await conn.execute(
                """
                INSERT INTO road (id, property, extras, source_file, created_at, geom)
                SELECT id, property, extras, source_file, created_at, geom
                FROM road_snapshot
                WHERE restore_point_id = $1
                """,
                rp_id,
            )
            await conn.execute(
                """
                INSERT INTO lessor
                    (fid, lessor_name, lessor_category, relationship,
                     extras, source_file, created_at, updated_at, geom)
                SELECT fid, lessor_name, lessor_category, relationship,
                       extras, source_file, created_at, updated_at, geom
                FROM lessor_snapshot
                WHERE restore_point_id = $1
                """,
                rp_id,
            )
            await conn.execute(
                """
                INSERT INTO baseline_state
                    (id, iso_a2, name_zh, coverage_pct, points_used, established_at)
                SELECT id, iso_a2, name_zh, coverage_pct, points_used, established_at
                FROM baseline_state_snapshot
                WHERE restore_point_id = $1
                ON CONFLICT (id) DO NOTHING
                """,
                rp_id,
            )

    return {"ok": True, "rolled_back_to": rp_id}


@router.delete("/{rp_id}")
async def delete_restore_point(rp_id: int):
    async with pool().acquire() as conn:
        deleted = await conn.fetchval(
            "DELETE FROM restore_point WHERE id = $1 RETURNING id", rp_id
        )
    if deleted is None:
        raise HTTPException(status_code=404, detail=f"恢复点 {rp_id} 不存在")
    return {"deleted": rp_id}
