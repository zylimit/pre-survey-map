"""#42 · 定时全库自动备份（Spec F21）。

调度：api lifespan 起一个 asyncio 后台任务，每 12h 跑一次备份（零依赖，
不引入 APScheduler）。备份 = 复用 F17 restore_point + snapshot 机制，
reason='auto_backup'。30 天滚动清理（ON DELETE CASCADE 连带删 snapshot）。

api 重启会重置调度 → 启动时做补偿检查：距上次 auto_backup 超 12h（或从无）
立即补一次，避免重启窗口漏备份。
"""

import asyncio
import logging
from datetime import datetime, timezone

from core.db import pool
from restore.helper import create_restore_point

BACKUP_INTERVAL_SECONDS = 12 * 3600   # 每 12h
RETENTION_DAYS = 30                    # 保留 30 天

_log = logging.getLogger("backup")


async def run_backup_once() -> int | None:
    """建一个 auto_backup 恢复点 + 30 天滚动清理，单事务。返回新 rp_id。"""
    async with pool().acquire() as conn:
        async with conn.transaction():
            note = f"auto_backup {datetime.now().strftime('%Y-%m-%d %H:%M')}"
            # evict=False：自动备份不参与「保留最近 10 个交互恢复点」的环淘汰
            rp_id = await create_restore_point(conn, "auto_backup", note, evict=False)
            # 30 天滚动清理：删旧 auto_backup（CASCADE 自动连带删其 snapshot）
            await conn.execute(
                "DELETE FROM restore_point "
                "WHERE reason = 'auto_backup' AND created_at < now() - make_interval(days => $1)",
                RETENTION_DAYS,
            )
    return rp_id


async def _seconds_since_last_backup(conn) -> float | None:
    ts = await conn.fetchval(
        "SELECT created_at FROM restore_point "
        "WHERE reason = 'auto_backup' ORDER BY created_at DESC LIMIT 1"
    )
    if ts is None:
        return None
    return (datetime.now(timezone.utc) - ts).total_seconds()


async def backup_loop() -> None:
    """后台循环：启动补偿 + 每 12h 一次。由 lifespan 创建/取消。"""
    # 启动补偿：距上次 auto_backup 超 12h（或从无）→ 立即补一次
    try:
        async with pool().acquire() as conn:
            since = await _seconds_since_last_backup(conn)
        if since is None or since >= BACKUP_INTERVAL_SECONDS:
            rp_id = await run_backup_once()
            _log.info(f"启动补偿备份完成 rp_id={rp_id}")
    except Exception as e:  # noqa: BLE001 — 备份失败不阻塞 api
        _log.error(f"启动补偿备份失败：{e}")

    # 周期循环
    while True:
        try:
            await asyncio.sleep(BACKUP_INTERVAL_SECONDS)
            rp_id = await run_backup_once()
            _log.info(f"定时备份完成 rp_id={rp_id}")
        except asyncio.CancelledError:
            break
        except Exception as e:  # noqa: BLE001
            _log.error(f"定时备份失败：{e}")
