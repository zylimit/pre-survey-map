"""F14 清除基线（Spec V1.x #12）。

TRUNCATE site / road / lessor 三表，不动 countries（地理数据保留）。
V1 不做权限控制，前端弹确认 modal 防误点。
"""

from fastapi import APIRouter

from db import pool

router = APIRouter()


@router.delete("")
async def clear_baseline():
    async with pool().acquire() as conn:
        async with conn.transaction():
            site_n = await conn.fetchval("SELECT count(*) FROM site")
            road_n = await conn.fetchval("SELECT count(*) FROM road")
            lessor_n = await conn.fetchval("SELECT count(*) FROM lessor")
            # TRUNCATE 不能在 read-only 事务里跑；RESTART IDENTITY 让 road 的 BIGSERIAL 重置
            await conn.execute(
                'TRUNCATE TABLE site, road, lessor RESTART IDENTITY CASCADE'
            )
    return {"deleted": {"site": site_n, "road": road_n, "lessor": lessor_n}}
