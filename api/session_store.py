"""导入流程的两阶段 session 暂存。

Phase 1 (POST /api/import) 解析完后把待入库的数据塞进 session，返回 session_id。
Phase 2 (POST /api/import/{sid}/commit) 拿用户决策真正入库；DELETE 取消并丢弃 session。

存在进程内存里，30 分钟 TTL 自动清理。单实例够用，多副本部署要换 Redis。
"""

import threading
import time
import uuid
from typing import Any, Optional

TTL_SECONDS = 30 * 60

_lock = threading.Lock()
_sessions: dict[str, dict[str, Any]] = {}


def _gc() -> None:
    """惰性清理：每次访问时顺手把过期的 session 丢掉。"""
    now = time.time()
    expired = [sid for sid, s in _sessions.items() if now - s["_created"] > TTL_SECONDS]
    for sid in expired:
        _sessions.pop(sid, None)


def create(data: dict[str, Any]) -> str:
    sid = uuid.uuid4().hex
    with _lock:
        _gc()
        _sessions[sid] = {"_created": time.time(), **data}
    return sid


def get(sid: str) -> Optional[dict[str, Any]]:
    with _lock:
        _gc()
        return _sessions.get(sid)


def drop(sid: str) -> bool:
    with _lock:
        return _sessions.pop(sid, None) is not None
