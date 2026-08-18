"""#50 Phase 12 · 数据权限（scope）换算与校验（Spec F22「权限模型」节）

scope 节点 → 库内值映射表【单一真源】（勿在他处复制）：
- 运营商节点 Globe / Smart / Dito 直映射 site.operator
- 类别节点 EXISTING / PLANNED / SURVEY → site.category 中文值 存量 / 规划 / 勘测

子级继承：site 根 = 全部 site；site:<运营商> = 该运营商下全部类别；
site:<运营商>:<类别> = 精确子集。admin 以 "*" 哨兵表全量。

查看 = 编辑同权：能看即可编辑，行级校验与列表过滤共用同一套换算。
"""

from typing import Any, Optional

FULL = "*"
OPERATOR_NODES = ("Globe", "Smart", "Dito")
CATEGORY_NODE_TO_DB = {"EXISTING": "存量", "PLANNED": "规划", "SURVEY": "勘测"}
CATEGORY_DB_TO_NODE = {v: k for k, v in CATEGORY_NODE_TO_DB.items()}
SCOPE_ROOTS = ("site", "road", "lessor")


def visible_scopes(user: dict[str, Any]) -> list[str]:
    """用户可见 scope 集合；admin → ["*"] 全量哨兵。"""
    if user.get("is_admin"):
        return [FULL]
    return list(user.get("scopes") or [])


def request_scopes(request: Any) -> list[str]:
    """取当前请求可见 scope。

    鉴权中间件保证 request.state.user 存在；缺失（仅直调 handler 的单测）
    按全量放行——保持既有直调测试零改动，生产路径必过中间件。
    """
    user = getattr(request.state, "user", None) if request is not None else None
    if user is None:
        return [FULL]
    return visible_scopes(user)


def validate_scope_node(node: Any) -> bool:
    """scope 节点值域校验（管理接口建/改角色用）。"""
    if not isinstance(node, str):
        return False
    if node in SCOPE_ROOTS:
        return True
    parts = node.split(":")
    if len(parts) == 2:
        return parts[0] == "site" and parts[1] in OPERATOR_NODES
    if len(parts) == 3:
        return (
            parts[0] == "site"
            and parts[1] in OPERATOR_NODES
            and parts[2] in CATEGORY_NODE_TO_DB
        )
    return False


def site_scope_pairs(scopes: list[str]) -> Optional[list[tuple[str, Optional[str]]]]:
    """展开继承 → (operator, category_db|None) 列表。

    返回 None = site 全量可见（"*" 或 "site" 根）；
    否则 (operator, category) 对列表，category=None 表该运营商全类别。
    空列表 = 无任何 site 可见。
    """
    if FULL in scopes or "site" in scopes:
        return None
    full_ops: set[str] = set()
    cat_pairs: set[tuple[str, str]] = set()
    for s in scopes:
        parts = s.split(":")
        if len(parts) == 2 and parts[0] == "site":
            full_ops.add(parts[1])
        elif len(parts) == 3 and parts[0] == "site":
            cat = CATEGORY_NODE_TO_DB.get(parts[2])
            if cat is not None:
                cat_pairs.add((parts[1], cat))
    pairs: list[tuple[str, Optional[str]]] = [(op, None) for op in sorted(full_ops)]
    pairs += sorted(p for p in cat_pairs if p[0] not in full_ops)
    return pairs


def site_scope_where(scopes: list[str], start_idx: int = 1) -> tuple[str, list[Any]]:
    """scope → 参数化 WHERE 片段（不含 WHERE 关键字）。

    - 全量 → ("", [])
    - 无 site 可见 → ("FALSE", [])（拼进 WHERE 即空集）
    - 否则形如 ((operator = $n) OR (operator = $n AND category = $n+1))
    """
    pairs = site_scope_pairs(scopes)
    if pairs is None:
        return "", []
    if not pairs:
        return "FALSE", []
    clauses: list[str] = []
    params: list[Any] = []
    idx = start_idx
    for op, cat in pairs:
        if cat is None:
            clauses.append(f"(operator = ${idx})")
            params.append(op)
            idx += 1
        else:
            clauses.append(f"(operator = ${idx} AND category = ${idx + 1})")
            params.extend([op, cat])
            idx += 2
    return "(" + " OR ".join(clauses) + ")", params


def can_see_road(scopes: list[str]) -> bool:
    return FULL in scopes or "road" in scopes


def can_see_lessor(scopes: list[str]) -> bool:
    return FULL in scopes or "lessor" in scopes


def site_row_visible(
    scopes: list[str], operator: Optional[str], category: Optional[str]
) -> bool:
    """行级校验：某行 site（operator/category）是否落在可见 scope 内。"""
    pairs = site_scope_pairs(scopes)
    if pairs is None:
        return True
    return any(
        op == operator and (cat is None or cat == category) for op, cat in pairs
    )


def import_target_visible(
    scopes: list[str],
    target_kind: Optional[str],
    operator: Optional[str],
    category: Optional[str],
) -> bool:
    """盖戳目标图层可见性校验（imports.py 用）。

    target_kind=None（F1 全局导入，无盖戳）→ 不校验放行；
    site → 盖戳 operator/category 必须落在可见 scope 内（缺失视为不可见）。
    """
    if target_kind is None:
        return True
    if target_kind == "road":
        return can_see_road(scopes)
    if target_kind == "lessor":
        return can_see_lessor(scopes)
    if not operator or not category:
        return False
    return site_row_visible(scopes, operator, category)
