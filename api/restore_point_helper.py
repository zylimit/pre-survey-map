"""F17 · create_restore_point — 事务内复用的建点函数（Spec V1.x #20）。

调用方必须已在同一 conn 的事务内（asyncpg connection，不是 pool）。
"""

from typing import Optional

_KEEP = 10  # 环形淘汰保留最近 N 个


async def create_restore_point(
    conn,
    reason: str,
    note: Optional[str] = None,
    protect_id: Optional[int] = None,
) -> int:
    """在当前 conn 事务内建恢复点，返回新 restore_point.id。

    protect_id：环形淘汰时永不删除的目标点 id（回滚时传入目标点，防止
    新建 pre_rollback 把刚好处于淘汰边界的回滚目标连同其快照一起删掉）。
    """
    # 1. 插入元行，拿 id
    rp_id: int = await conn.fetchval(
        "INSERT INTO restore_point (reason, note) VALUES ($1, $2) RETURNING id",
        reason,
        note,
    )

    # 2. 快照四张表
    await conn.execute(
        """
        INSERT INTO site_snapshot
            (restore_point_id, site_id, "option", project, site_status,
             lati, longi, extras, source_file, created_at, updated_at, geom)
        SELECT $1, site_id, "option", project, site_status,
               lati, longi, extras, source_file, created_at, updated_at, geom
        FROM site
        """,
        rp_id,
    )
    await conn.execute(
        """
        INSERT INTO road_snapshot
            (restore_point_id, id, property, extras, source_file, created_at, geom)
        SELECT $1, id, property, extras, source_file, created_at, geom
        FROM road
        """,
        rp_id,
    )
    await conn.execute(
        """
        INSERT INTO lessor_snapshot
            (restore_point_id, fid, lessor_name, lessor_category, relationship,
             extras, source_file, created_at, updated_at, geom)
        SELECT $1, fid, lessor_name, lessor_category, relationship,
               extras, source_file, created_at, updated_at, geom
        FROM lessor
        """,
        rp_id,
    )
    await conn.execute(
        """
        INSERT INTO baseline_state_snapshot
            (restore_point_id, id, iso_a2, name_zh, coverage_pct, points_used, established_at)
        SELECT $1, id, iso_a2, name_zh, coverage_pct, points_used, established_at
        FROM baseline_state
        """,
        rp_id,
    )

    # 3. 回填摘要列
    await conn.execute(
        """
        UPDATE restore_point SET
            site_count      = (SELECT count(*) FROM site),
            road_count      = (SELECT count(*) FROM road),
            lessor_count    = (SELECT count(*) FROM lessor),
            baseline_iso_a2 = (SELECT iso_a2 FROM baseline_state WHERE id = 1)
        WHERE id = $1
        """,
        rp_id,
    )

    # 4. 环形淘汰：DELETE 最旧的，保留最近 _KEEP 个（CASCADE 清快照）
    #    protect_id 永不被淘汰——回滚时保护目标点，防止把刚要回滚的快照删掉。
    await conn.execute(
        """
        DELETE FROM restore_point
        WHERE id NOT IN (
            SELECT id FROM restore_point
            ORDER BY created_at DESC
            LIMIT $1
        )
        AND ($2::bigint IS NULL OR id <> $2)
        """,
        _KEEP,
        protect_id,
    )

    return rp_id
