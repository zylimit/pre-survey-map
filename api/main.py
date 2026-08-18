import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Callable

import bcrypt
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from starlette.formparsers import MultiPartParser

from audit_middleware import SessionCookieMiddleware
from backup_scheduler import backup_loop
from db import close_pool, init_pool, ping, pool
from geo_loader import ensure_countries_loaded
from routers import audit, backups, baseline, exports, imports, lessors, restore_points, roads, sites

# SpooledTemporaryFile 默认 1MB 触发磁盘溢写，溢写路径调用 run_in_threadpool，
# 在 k8s pod 线程耗尽时抛出 RuntimeError: can't start new thread。
# 将上限调至 200MB，所有 ≤100MB 文件始终在内存中完成 write，规避磁盘路径。
MultiPartParser.max_file_size = 200 * 1024 * 1024

# F1 Spec：单文件上限 100MB（前端 + 后端 + nginx 三端配齐）
MAX_BODY_BYTES = 100 * 1024 * 1024
MAX_BODY_MB = MAX_BODY_BYTES // (1024 * 1024)

logger = logging.getLogger("startup")


async def ensure_admin_seed(pool) -> None:
    """#50：admin 角色 + admin 用户种子（判空幂等）。

    无 is_admin=true 的角色则插 name='admin'；无 username='admin' 的用户则插
    bcrypt('admin123') + must_change_password=true（首登强制改密）。
    """
    async with pool.acquire() as conn:
        role_id = await conn.fetchval(
            "SELECT id FROM app_role WHERE is_admin = true ORDER BY id LIMIT 1"
        )
        if role_id is None:
            role_id = await conn.fetchval(
                "INSERT INTO app_role (name, is_admin, perms) VALUES ($1, true, '{}'::jsonb)"
                " RETURNING id",
                "admin",
            )
            logger.info("已插入 admin 角色")

        user_exists = await conn.fetchval(
            "SELECT 1 FROM app_user WHERE username = $1", "admin"
        )
        if user_exists is None:
            # bcrypt 5.x 接受 bytes；哈希含 salt，每次种子生成不同，但判空保证只插一次
            password_hash = bcrypt.hashpw(b"admin123", bcrypt.gensalt()).decode()
            await conn.execute(
                "INSERT INTO app_user (username, password_hash, role_id)"
                " VALUES ($1, $2, $3)",
                "admin",
                password_hash,
                role_id,
            )
            logger.info("已插入 admin 用户（初始密码 admin123，首登强制改密）")


class MaxBodySizeMiddleware:
    """纯 ASGI 实现，只检查 Content-Length 头，不碰 body 流。

    BaseHTTPMiddleware 版本在大文件上传时会通过 asyncio Queue 转发 chunks，
    Queue 背压会导致 python-multipart 解析失败（"There was an error parsing the body"）。
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = {k.lower(): v for k, v in scope.get("headers", [])}
            cl = headers.get(b"content-length", b"").decode()
            if cl.isdigit() and int(cl) > MAX_BODY_BYTES:
                response = JSONResponse(
                    status_code=413,
                    content={"error": "file_too_large", "limit_mb": MAX_BODY_MB},
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_pool()
    # Natural Earth countries 一次性加载（Spec V1.x #12）
    try:
        await ensure_countries_loaded(pool())
    except Exception as e:
        # 加载失败不阻塞启动；地理判定会退化（in_sea / not_in_baseline 不触发）
        logger.error(f"countries 加载失败：{e}")
    # #50：admin 角色/用户种子（判空幂等；失败不阻塞启动，与审计容错风格一致）
    try:
        await ensure_admin_seed(pool())
    except Exception as e:
        logger.warning(f"admin 种子失败：{e}")
    # #42：起后台定时备份任务（每 12h + 启动补偿）
    backup_task = asyncio.create_task(backup_loop())
    try:
        yield
    finally:
        backup_task.cancel()
        try:
            await backup_task
        except asyncio.CancelledError:
            pass
        await close_pool()


app = FastAPI(title="pre-survey-map api", version="0.1.0", lifespan=lifespan)

# 顺序：CORS（最外层处理预检）→ MaxBody（拦超大请求）→ SessionCookie（注入 sid）
# Starlette 中间件后注册的反而是最外层 → 先注册 Cookie 后注册 CORS
app.add_middleware(SessionCookieMiddleware)
app.add_middleware(MaxBodySizeMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "X-Filename"],
    allow_credentials=True,
)


@app.get("/health")
async def health():
    return {"status": "ok", "db": await ping()}


app.include_router(sites.router, prefix="/api/sites", tags=["sites"])
app.include_router(roads.router, prefix="/api/roads", tags=["roads"])
app.include_router(lessors.router, prefix="/api/lessors", tags=["lessors"])
app.include_router(imports.router, prefix="/api/import", tags=["import"])
app.include_router(exports.router, prefix="/api/export", tags=["export"])
app.include_router(baseline.router, prefix="/api", tags=["baseline"])
app.include_router(restore_points.router, prefix="/api/restore-points", tags=["restore_points"])
app.include_router(backups.router, prefix="/api/backups", tags=["backups"])
app.include_router(audit.router, prefix="/api", tags=["audit"])
