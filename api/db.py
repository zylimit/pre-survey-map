import os
from typing import Optional

import asyncpg

_pool: Optional[asyncpg.Pool] = None


def _dsn() -> str:
    return (
        f"postgresql://{os.getenv('DB_USER', 'postgres')}:"
        f"{os.getenv('DB_PASSWORD', 'postgres')}@"
        f"{os.getenv('DB_HOST', 'db')}:"
        f"{os.getenv('DB_PORT', '5432')}/"
        f"{os.getenv('DB_NAME', 'presurvey')}"
    )


async def init_pool() -> None:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(dsn=_dsn(), min_size=1, max_size=10)


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("db pool not initialized")
    return _pool


async def ping() -> bool:
    try:
        async with pool().acquire() as conn:
            await conn.fetchval("SELECT 1")
        return True
    except Exception:
        return False
