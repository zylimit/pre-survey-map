from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db import close_pool, init_pool, ping
from routers import exports, imports, lessors, roads, sites


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_pool()
    yield
    await close_pool()


app = FastAPI(title="pre-survey-map api", version="0.1.0", lifespan=lifespan)

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
