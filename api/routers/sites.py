import json
import logging
import math
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, field_validator

from audit import write_audit
from auth.permissions import require_perm
from auth.scopes import (
    request_scopes,
    site_row_visible,
    site_scope_pairs,
    site_scope_where,
)
from db import pool

router = APIRouter()
logger = logging.getLogger("sites")

# #49 Phase 9：site 删除镜像列（site_delete_undo 与 site 全列对齐，撤销时原样插回）
_SITE_MIRROR_COLS = (
    'site_id, "option", project, site_status, operator, category, type, '
    "lati, longi, extras, source_file, created_at, updated_at, geom"
)
# 环形保留最近 N 批删除（按 undo_id 递增=时间序）
_UNDO_KEEP_BATCHES = 200


# site 主键 = (site_id, "option")；盖戳三列 operator/category/type 不可改（来源即真相）。
STAMPED_COLS = ("operator", "category", "type")
PK_COLS = ("site_id", "option")
FORBIDDEN_EDIT = set(STAMPED_COLS) | set(PK_COLS)
# 可编辑业务列白名单由 SitePatchFields（extra=forbid）强制；坐标变更触发 geom 重算。

# 列出全列的 SELECT/RETURNING 片段，供列表与单条编辑复用同一序列化。
_SITE_COLS = """
    site_id, "option", project, site_status,
    operator, category, type,
    lati, longi,
    extras, source_file,
    CASE WHEN geom IS NULL THEN NULL ELSE ST_AsGeoJSON(geom) END AS geojson
"""


def _row_to_feature(r) -> dict:
    props = {
        "kind": "site",
        "site_id": r["site_id"],
        "option": r["option"],
        "project": r["project"],
        "site_status": r["site_status"],
        "operator": r["operator"],
        "category": r["category"],
        "type": r["type"],
        "lati": r["lati"],
        "longi": r["longi"],
        "source_file": r["source_file"],
    }
    extras = r["extras"]
    if isinstance(extras, str):
        extras = json.loads(extras)
    if extras:
        for k, v in extras.items():
            props.setdefault(k, v)
    return {
        "type": "Feature",
        "id": f"site:{r['site_id']}:{r['option']}",
        "geometry": json.loads(r["geojson"]) if r["geojson"] else None,
        "properties": props,
    }


@router.get("")
async def list_sites(request: Request):
    # #50 Phase 12：数据权限过滤——scope 换算 operator/category WHERE（admin/全量 → 无 WHERE）
    frag, params = site_scope_where(request_scopes(request))
    where = f"WHERE {frag}" if frag else ""
    async with pool().acquire() as conn:
        rows = await conn.fetch(f"SELECT {_SITE_COLS} FROM site {where}", *params)
    return {"type": "FeatureCollection", "features": [_row_to_feature(r) for r in rows]}


# ---------- 交付1：PATCH 单条编辑 ----------


class SitePatchFields(BaseModel):
    """可编辑业务字段白名单 + 值校验。extra=forbid → 盖戳列/主键/未知字段一律拒绝。

    坐标若提供必须是有限数字且在合法经纬度范围内（拒 nan/inf/越界）。
    """

    model_config = ConfigDict(extra="forbid")

    project: Optional[str] = None
    site_status: Optional[str] = None
    lati: Optional[float] = None
    longi: Optional[float] = None

    @field_validator("lati")
    @classmethod
    def _check_lat(cls, v: Optional[float]) -> Optional[float]:
        if v is None:
            return v
        if not math.isfinite(v):
            raise ValueError("lati 必须是有限数字（拒 nan/inf）")
        if not -90.0 <= v <= 90.0:
            raise ValueError("lati 必须在 [-90, 90]")
        return v

    @field_validator("longi")
    @classmethod
    def _check_lng(cls, v: Optional[float]) -> Optional[float]:
        if v is None:
            return v
        if not math.isfinite(v):
            raise ValueError("longi 必须是有限数字（拒 nan/inf）")
        if not -180.0 <= v <= 180.0:
            raise ValueError("longi 必须在 [-180, 180]")
        return v


class SitePatchBody(BaseModel):
    """key 走 body（与 delete 一致），patch 携可编辑字段。"""

    site_id: str
    option: str = ""
    patch: dict[str, Any]


@router.patch("", dependencies=[Depends(require_perm("edit_delete"))])
async def update_site(body: SitePatchBody, request: Request):
    """编辑单条 site 业务属性（key 在 body，不走 path）。

    - 可改：project / site_status / lati / longi（坐标变更同步重算 geom）。
    - 拒改：盖戳三列 operator/category/type 与主键 site_id/option → 400。
    - 坐标非法（nan/inf/越界）→ 400；未知字段 → 400；主键不存在 → 404。
    - #50：edit_delete 功能权限（Depends）+ 目标行必须在可见 scope 内（否则 403）。
    """
    raw = body.patch

    # 盖戳列/主键显式拦截（清晰中文报错；其余未知字段交由 extra=forbid 兜底）
    bad = FORBIDDEN_EDIT & set(raw.keys())
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"禁止修改字段 {sorted(bad)}：盖戳列(operator/category/type)与主键(site_id/option)不可改",
        )

    # Pydantic 统一校验：未知字段（extra=forbid）+ 坐标值合法性
    try:
        fields = SitePatchFields(**raw)
    except ValueError as e:  # ValidationError 是 ValueError 子类
        raise HTTPException(status_code=400, detail=f"patch 字段非法：{e}")

    updates = fields.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=400, detail="无可更新字段（可改：project/site_status/lati/longi）"
        )

    set_parts: list[str] = []
    args: list[Any] = []
    idx = 1
    # 非坐标列：列名取自白名单字段名，值参数化
    for col in ("project", "site_status"):
        if col in updates:
            set_parts.append(f'"{col}" = ${idx}')
            args.append(updates[col])
            idx += 1

    # 坐标列：COALESCE 从现有列补另一维 → 单条 UPDATE 内寻址+重算 geom，消除 SELECT+UPDATE 竞态
    if "lati" in updates or "longi" in updates:
        lat_idx = idx
        args.append(updates.get("lati"))
        idx += 1
        lng_idx = idx
        args.append(updates.get("longi"))
        idx += 1
        set_parts.append(f"lati = COALESCE(${lat_idx}::double precision, lati)")
        set_parts.append(f"longi = COALESCE(${lng_idx}::double precision, longi)")
        set_parts.append(
            f"geom = ST_SetSRID(ST_MakePoint("
            f"COALESCE(${lng_idx}::double precision, longi), "
            f"COALESCE(${lat_idx}::double precision, lati)), 4326)"
        )

    set_parts.append("updated_at = now()")
    sid_idx = idx
    args.append(body.site_id)
    idx += 1
    opt_idx = idx
    args.append(body.option)
    idx += 1

    # #50 Phase 12：行级 scope 校验——目标行不可见 → 403（全量 scope 零额外查询，
    # 保持原单条 UPDATE 路径不变）
    scopes = request_scopes(request)
    if site_scope_pairs(scopes) is not None:
        async with pool().acquire() as conn:
            target = await conn.fetchrow(
                'SELECT operator, category FROM site'
                ' WHERE site_id = $1 AND "option" = $2',
                body.site_id,
                body.option,
            )
        if target is None:
            raise HTTPException(
                status_code=404, detail=f"site {body.site_id}/{body.option} 不存在"
            )
        if not site_row_visible(scopes, target["operator"], target["category"]):
            raise HTTPException(
                status_code=403,
                detail=f"site {body.site_id}/{body.option} 不在数据权限范围内",
            )

    sql = (
        f"UPDATE site SET {', '.join(set_parts)} "
        f'WHERE site_id = ${sid_idx} AND "option" = ${opt_idx} '
        f"RETURNING {_SITE_COLS}"
    )
    async with pool().acquire() as conn:
        row = await conn.fetchrow(sql, *args)
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"site {body.site_id}/{body.option} 不存在"
        )

    await write_audit(
        action="edit_site",
        details={
            "site_id": body.site_id,
            "option": body.option,
            "changed_fields": sorted(updates.keys()),
        },
        request=request,
    )
    return _row_to_feature(row)


# ---------- 交付2：POST 批量删除 ----------


class SiteKey(BaseModel):
    site_id: str
    option: str = ""


class DeleteBody(BaseModel):
    keys: list[SiteKey]


# #49 Phase 9：删除并原子捕获被删行到 site_delete_undo（单条 CTE，O(删除条数)）。
# 修复2（消并发串批）：undo 捕获直接来自 DELETE ... RETURNING——捕获的就是【本次实际删除的行】，
# 不再用独立 INSERT...SELECT FROM site（避免并发删同 key 时 capture 到别人删的行）。
# undo_id 用 nextval 序列（batch CTE，0 行命中也有批次号）。返回 undo_id + 实删条数。
_DELETE_CAPTURE_SQL = f"""
WITH batch AS (
    SELECT nextval('site_delete_undo_batch_seq') AS undo_id
), del AS (
    DELETE FROM site
    WHERE (site_id, "option") IN (SELECT * FROM unnest($1::text[], $2::text[]))
    RETURNING {_SITE_MIRROR_COLS}
), ins AS (
    INSERT INTO site_delete_undo (undo_id, deleted_at, {_SITE_MIRROR_COLS})
    SELECT b.undo_id, now(), {_SITE_MIRROR_COLS}
    FROM del, batch b
    RETURNING 1
)
SELECT (SELECT undo_id FROM batch) AS undo_id, (SELECT count(*) FROM ins) AS deleted
"""

# 环形淘汰：只保留最近 _UNDO_KEEP_BATCHES 个 undo_id（undo_id 单调=时间序）。事务外清理，
# 失败不影响本次删除（仅留多余历史，无害）→ 调用处 try/except 仅 warning。
_EVICT_UNDO_SQL = f"""
DELETE FROM site_delete_undo
WHERE undo_id < (
    SELECT min(undo_id) FROM (
        SELECT DISTINCT undo_id FROM site_delete_undo
        ORDER BY undo_id DESC LIMIT {_UNDO_KEEP_BATCHES}
    ) keep
)
"""


@router.post("/delete", dependencies=[Depends(require_perm("edit_delete"))])
async def delete_sites(body: DeleteBody, request: Request):
    """批量删除 site：单条 CTE 原子删除 + 捕获被删行（DELETE RETURNING），供后续撤销。

    #50 Phase 12：edit_delete 功能权限（Depends）+ 行级 scope 校验——越权行跳过
    并在响应/审计报 skipped 数（不静默成功）。全量 scope 走原路径（零额外查询）。
    """
    if not body.keys:
        raise HTTPException(status_code=400, detail="keys 不能为空")

    site_ids = [k.site_id for k in body.keys]
    options = [k.option for k in body.keys]

    # #50：行级 scope 过滤（仅非全量 scope 时启用）
    scopes = request_scopes(request)
    scoped = site_scope_pairs(scopes) is not None
    skipped = 0
    if scoped:
        async with pool().acquire() as conn:
            rows = await conn.fetch(
                'SELECT site_id, "option", operator, category FROM site'
                ' WHERE (site_id, "option") IN'
                ' (SELECT * FROM unnest($1::text[], $2::text[]))',
                site_ids,
                options,
            )
        allowed = {
            (r["site_id"], r["option"])
            for r in rows
            if site_row_visible(scopes, r["operator"], r["category"])
        }
        skipped = len(rows) - len(allowed)
        kept = [
            (sid, opt) for sid, opt in zip(site_ids, options) if (sid, opt) in allowed
        ]
        site_ids = [k[0] for k in kept]
        options = [k[1] for k in kept]
        if not kept:
            # 全部越权（或不存在）→ 不删，审计 + 报 skipped，不静默成功
            await write_audit(
                action="delete_site",
                details={
                    "deleted": 0,
                    "undo_id": None,
                    "requested": len(body.keys),
                    "skipped": skipped,
                },
                request=request,
            )
            return {"deleted": 0, "undo_id": None, "skipped": skipped}

    async with pool().acquire() as conn:
        async with conn.transaction():
            # 原子：DELETE ... RETURNING 直接喂 INSERT，捕获==实删行，无独立 SELECT、无竞态
            row = await conn.fetchrow(_DELETE_CAPTURE_SQL, site_ids, options)
        undo_id = row["undo_id"]
        deleted = row["deleted"]

        # 修复1：审计 + 返回必须在 evict 之前完成；evict 失败仅 warning，绝不连累已提交的删除
        details: dict[str, Any] = {
            "deleted": deleted,
            "undo_id": undo_id,
            "requested": len(body.keys),
        }
        if scoped:
            details["skipped"] = skipped
        await write_audit(action="delete_site", details=details, request=request)

        # 环形保留最近 N 批（事务外，cleanup 失败不影响删除结果/审计/返回）
        try:
            await conn.execute(_EVICT_UNDO_SQL)
        except Exception as e:  # noqa: BLE001 — cleanup 失败无害，留多余历史，绝不抛
            logger.warning(f"site_delete_undo evict failed (harmless): {e!r}")

    resp: dict[str, Any] = {"deleted": deleted, "undo_id": undo_id}
    if scoped:
        resp["skipped"] = skipped
    return resp


# ---------- 交付3：删除历史 + 撤销删除 ----------


@router.get("/delete-history", dependencies=[Depends(require_perm("edit_delete"))])
async def delete_history():
    """列最近删除批次（每批一行摘要），按时间倒序，供「删除历史」面板用。"""
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT undo_id,
                   max(deleted_at) AS deleted_at,
                   count(*)::int AS count,
                   bool_and(undone) AS undone,
                   string_agg(DISTINCT coalesce(operator, '—'), '/') AS operators,
                   string_agg(DISTINCT coalesce(category, '—'), '/') AS categories,
                   string_agg(DISTINCT coalesce(type, '—'), '/') AS types,
                   (array_agg(site_id ORDER BY site_id))[1:3] AS sample
            FROM site_delete_undo
            GROUP BY undo_id
            ORDER BY max(deleted_at) DESC
            LIMIT {_UNDO_KEEP_BATCHES}
            """
        )
    out = []
    for r in rows:
        layer = f"{r['operators']} / {r['categories']} / {r['types']}"
        out.append({
            "undo_id": r["undo_id"],
            "deleted_at": r["deleted_at"].isoformat() if r["deleted_at"] else None,
            "count": r["count"],
            "layer": layer,
            "sample": list(r["sample"] or []),
            "undone": r["undone"],
        })
    return out


@router.post("/undo-delete/{undo_id}", dependencies=[Depends(require_perm("edit_delete"))])
async def undo_delete(undo_id: int, request: Request):
    """撤销某批删除：把该批未撤销行插回 site（ON CONFLICT DO NOTHING），标记 undone。

    #50 Phase 12：行级 scope 校验——越权行不插回、不标 undone（留给有权限者后续撤销），
    响应报 skipped 数（不静默成功）。全量 scope 走原路径。
    """
    # scope 片段参数从 $2 起（$1 = undo_id）
    frag, sparams = site_scope_where(request_scopes(request), start_idx=2)
    scope_and = f" AND ({frag})" if frag else ""

    async with pool().acquire() as conn:
        async with conn.transaction():
            requested = await conn.fetchval(
                "SELECT count(*) FROM site_delete_undo WHERE undo_id = $1",
                undo_id,
            )
            if not requested:
                raise HTTPException(status_code=404, detail=f"删除批次 {undo_id} 不存在")
            skipped = 0
            if frag:
                skipped = await conn.fetchval(
                    "SELECT count(*) FROM site_delete_undo"
                    f" WHERE undo_id = $1 AND undone = false AND NOT ({frag})",
                    undo_id,
                    *sparams,
                )
            status = await conn.execute(
                f"""
                INSERT INTO site ({_SITE_MIRROR_COLS})
                SELECT {_SITE_MIRROR_COLS}
                FROM site_delete_undo
                WHERE undo_id = $1 AND undone = false{scope_and}
                ON CONFLICT (site_id, "option") DO NOTHING
                """,
                undo_id,
                *sparams,
            )
            await conn.execute(
                "UPDATE site_delete_undo SET undone = true"
                f" WHERE undo_id = $1{scope_and}",
                undo_id,
                *sparams,
            )
    restored = int(status.split()[-1]) if status else 0

    details: dict[str, Any] = {"undo_id": undo_id, "restored": restored}
    if frag:
        details["skipped"] = skipped
    await write_audit(action="undo_delete_site", details=details, request=request)
    resp: dict[str, Any] = {"restored": restored, "requested": int(requested)}
    if frag:
        resp["skipped"] = skipped
    return resp
