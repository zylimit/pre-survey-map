"""导入流程的三阶段 session 暂存（Spec V1.x #12）。

状态机：
  parsing  ─POST /api/import────────────►  cleaning
  cleaning ─POST /api/import/{sid}/proceed-to-conflicts─►  conflicts
  conflicts ─POST /api/import/{sid}/commit─►  committing → done
  任意状态 ─DELETE /api/import/{sid}─►  drop

非法转换由 router 返回 HTTP 400 + {"error":"invalid_state"}。

存在进程内存里，30 分钟 TTL。
"""

import threading
import time
import uuid
from typing import Any, Optional

TTL_SECONDS = 30 * 60

_lock = threading.Lock()
_sessions: dict[str, dict[str, Any]] = {}

# #39：commit 写库进度（内存，独立于 DB 事务——事务未提交也能让前端轮询看到进度）。
# 单独一张 dict，生命周期由 commit 显式管理（set 期间写 / done 标完成 / drop 清理）。
_progress: dict[str, dict[str, Any]] = {}

# 合法状态转换图：当前状态 → 允许的下一状态
ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "cleaning":  {"conflicts"},
    "conflicts": {"cleaning", "committing"},   # 允许 [← 返回步骤 1]
    "committing": {"done"},
}


def _gc() -> None:
    now = time.time()
    expired = [sid for sid, s in _sessions.items() if now - s["_created"] > TTL_SECONDS]
    for sid in expired:
        _sessions.pop(sid, None)


def create(data: dict[str, Any], state: str = "cleaning") -> str:
    sid = uuid.uuid4().hex
    with _lock:
        _gc()
        _sessions[sid] = {"_created": time.time(), "_state": state, **data}
    return sid


def get(sid: str) -> Optional[dict[str, Any]]:
    with _lock:
        _gc()
        return _sessions.get(sid)


def update(sid: str, patch: dict[str, Any]) -> Optional[dict[str, Any]]:
    with _lock:
        s = _sessions.get(sid)
        if s is None:
            return None
        s.update(patch)
        return s


def transition(sid: str, to_state: str) -> Optional[str]:
    """尝试把 session 推进到 to_state。返回错误描述或 None（成功）。"""
    with _lock:
        s = _sessions.get(sid)
        if s is None:
            return "session 不存在或已过期"
        cur = s.get("_state", "")
        allowed = ALLOWED_TRANSITIONS.get(cur, set())
        if to_state not in allowed:
            return f"invalid_state（当前 {cur}，不能转到 {to_state}）"
        s["_state"] = to_state
        return None


def drop(sid: str) -> bool:
    with _lock:
        _progress.pop(sid, None)   # #39：会话清理时一并清进度
        return _sessions.pop(sid, None) is not None


# ─── #39 commit 进度（内存，独立于事务）──────────────────────────────────────

def set_progress(sid: str, done: int, total: int, phase: str = "committing") -> None:
    with _lock:
        _progress[sid] = {"done": done, "total": total, "phase": phase}


def get_progress(sid: str) -> Optional[dict[str, Any]]:
    with _lock:
        p = _progress.get(sid)
        return dict(p) if p is not None else None


def clear_progress(sid: str) -> None:
    with _lock:
        _progress.pop(sid, None)
