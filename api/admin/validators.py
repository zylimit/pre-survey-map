"""#50 Phase 12 · 管理接口共享入参校验（Spec F22「管理界面」节）。"""

from typing import Any

from fastapi import HTTPException

from auth.scopes import validate_scope_node

PERM_KEYS = ("import", "export", "edit_delete", "danger")


def _check_password(pw: str) -> None:
    n = len(pw.encode("utf-8"))
    if n < 8:
        raise HTTPException(status_code=400, detail="password must be at least 8 bytes")
    if n > 72:
        raise HTTPException(status_code=400, detail="password exceeds 72 bytes")


def _check_perms(perms: Any) -> dict[str, bool]:
    if not isinstance(perms, dict):
        raise HTTPException(status_code=400, detail="perms 必须是对象")
    bad = set(perms) - set(PERM_KEYS)
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"非法权限键 {sorted(bad)}（允许：{list(PERM_KEYS)}）",
        )
    return {k: bool(perms.get(k, False)) for k in PERM_KEYS}


def _check_scopes(scopes: Any) -> list[str]:
    if not isinstance(scopes, list):
        raise HTTPException(status_code=400, detail="scopes 必须是数组")
    out: list[str] = []
    for s in scopes:
        if not validate_scope_node(s):
            raise HTTPException(status_code=400, detail=f"非法 scope 节点：{s!r}")
        if s not in out:
            out.append(s)
    return out
