"""F14 清除基线 + F15 全局基线状态栏（Spec V1.x #12 / #15）。

- DELETE /api/baseline     清空 site / road / lessor / area / baseline_state 五张表
  （#51 area 纳入；countries 永远保留）
- GET    /api/baseline-state  全局基线状态栏数据源（~1ms 单行 SELECT）

V1 不做权限控制，前端弹确认 modal 防误点。
"""

from fastapi import APIRouter, Depends, Request

from audit.service import write_audit
from auth.permissions import require_perm
from core.db import pool
from restore.helper import create_restore_point

router = APIRouter()


# F15 全局基线状态栏：单行 SELECT，启动 + 每次 commit 后前端 refetch
# 路由 prefix 在 main.py 设为 /api，所以这里写完整路径
@router.get("/baseline-state")
async def get_baseline_state():
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT bs.*, c.name_en FROM baseline_state bs "
            "LEFT JOIN countries c ON c.iso_a2 = bs.iso_a2 WHERE bs.id = 1"
        )
    if row is None:
        return {"established": False}
    return {
        "established": True,
        "iso_a2": row["iso_a2"],
        "name_zh": row["name_zh"],
        "name_en": row["name_en"],
        "coverage_pct": row["coverage_pct"],
        "points_used": row["points_used"],
        "established_at": row["established_at"].isoformat() if row["established_at"] else None,
    }


# #50 Phase 12：清除基线属高危操作 → danger 功能权限门控（GET baseline-state 不门控）
@router.delete("/baseline", dependencies=[Depends(require_perm("danger"))])
async def clear_baseline(request: Request):
    """F14：清空 site / road / lessor / area + baseline_state（换基线唯一通道）。countries 不动。"""
    rp_id: int | None = None
    async with pool().acquire() as conn:
        async with conn.transaction():
            # F17: 清除基线前自动建恢复点（pre_clear）
            rp_id = await create_restore_point(conn, "pre_clear")

            site_n = await conn.fetchval("SELECT count(*) FROM site")
            road_n = await conn.fetchval("SELECT count(*) FROM road")
            lessor_n = await conn.fetchval("SELECT count(*) FROM lessor")
            baseline_n = await conn.fetchval("SELECT count(*) FROM baseline_state")
            area_n = await conn.fetchval("SELECT count(*) FROM area")
            # Spec #15 雷 26：truncate 范围扩展到 4 张表，含 baseline_state
            # #51：第四类实体 area 全链路同 site 待遇——清除基线连 area 一起清（清空全部业务数据语义）
            await conn.execute(
                'TRUNCATE TABLE site, road, lessor, area, baseline_state RESTART IDENTITY CASCADE'
            )
    # F19 审计：clear_baseline + 关联 restore_point_create_auto（pre_clear）
    await write_audit(
        action="clear_baseline",
        details={
            "counts_before": {
                "site": site_n, "road": road_n,
                "lessor": lessor_n, "area": area_n, "baseline_state": baseline_n,
            },
            "restore_point_id": rp_id,
        },
        request=request,
    )
    if rp_id is not None:
        await write_audit(
            action="restore_point_create_auto",
            details={"restore_point_id": rp_id, "reason": "pre_clear"},
            request=request,
        )
    return {
        "deleted": {
            "site": site_n,
            "road": road_n,
            "lessor": lessor_n,
            "area": area_n,
            "baseline_state": baseline_n,
        }
    }
