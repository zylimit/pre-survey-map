from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from db import close_pool, init_pool, ping, pool
from geo_loader import ensure_countries_loaded
from routers import baseline, exports, imports, lessors, restore_points, roads, sites

# F1 Spec：单文件上限 100MB（前端 + 后端 + nginx 三端配齐）
MAX_BODY_BYTES = 100 * 1024 * 1024
MAX_BODY_MB = MAX_BODY_BYTES // (1024 * 1024)


class MaxBodySizeMiddleware(BaseHTTPMiddleware):
    """看 Content-Length 头超 100MB 直接 413，免得 FastAPI 把整个 body 拉完再处理。

    Chunked encoding（无 Content-Length）这层放过，nginx client_max_body_size 兜底。
    """

    async def dispatch(self, request: Request, call_next):
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > MAX_BODY_BYTES:
            return JSONResponse(
                status_code=413,
                content={"error": "file_too_large", "limit_mb": MAX_BODY_MB},
            )
        return await call_next(request)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_pool()
    # Natural Earth countries 一次性加载（Spec V1.x #12）
    try:
        await ensure_countries_loaded(pool())
    except Exception as e:
        # 加载失败不阻塞启动；地理判定会退化（in_sea / not_in_baseline 不触发）
        import logging
        logging.getLogger("startup").error(f"countries 加载失败：{e}")
    yield
    await close_pool()


app = FastAPI(title="pre-survey-map api", version="0.1.0", lifespan=lifespan)

app.add_middleware(MaxBodySizeMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "X-Filename"],
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
