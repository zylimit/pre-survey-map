"""F14 清除基线 + F15 全局基线状态栏（Spec V1.x #12 / #15）。

- DELETE /api/baseline     清空 site / road / lessor / baseline_state 四张表
  （countries 永远保留）
- GET    /api/baseline-state  全局基线状态栏数据源（~1ms 单行 SELECT）

V1 不做权限控制，前端弹确认 modal 防误点。
"""

from fastapi import APIRouter

from db import pool

router = APIRouter()


# F15 全局基线状态栏：单行 SELECT，启动 + 每次 commit 后前端 refetch
# 路由 prefix 在 main.py 设为 /api，所以这里写完整路径
@router.get("/baseline-state")
async def get_baseline_state():
    async with pool().acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM baseline_state WHERE id = 1")
    if row is None:
        return {"established": False}
    return {
        "established": True,
        "iso_a2": row["iso_a2"],
        "name_zh": row["name_zh"],
        "coverage_pct": row["coverage_pct"],
        "points_used": row["points_used"],
        "established_at": row["established_at"].isoformat() if row["established_at"] else None,
    }


@router.delete("/baseline")
async def clear_baseline():
    """F14：清空 site / road / lessor + baseline_state（换基线唯一通道）。countries 不动。"""
    async with pool().acquire() as conn:
        async with conn.transaction():
            site_n = await conn.fetchval("SELECT count(*) FROM site")
            road_n = await conn.fetchval("SELECT count(*) FROM road")
            lessor_n = await conn.fetchval("SELECT count(*) FROM lessor")
            baseline_n = await conn.fetchval("SELECT count(*) FROM baseline_state")
            # Spec #15 雷 26：truncate 范围扩展到 4 张表，含 baseline_state
            await conn.execute(
                'TRUNCATE TABLE site, road, lessor, baseline_state RESTART IDENTITY CASCADE'
            )
    return {
        "deleted": {
            "site": site_n,
            "road": road_n,
            "lessor": lessor_n,
            "baseline_state": baseline_n,
        }
    }
