import json
import math
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, field_validator

from audit import write_audit
from db import pool
from restore_point_helper import create_restore_point

router = APIRouter()


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
async def list_sites():
    async with pool().acquire() as conn:
        rows = await conn.fetch(f"SELECT {_SITE_COLS} FROM site")
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


@router.patch("")
async def update_site(body: SitePatchBody, request: Request):
    """编辑单条 site 业务属性（key 在 body，不走 path）。

    - 可改：project / site_status / lati / longi（坐标变更同步重算 geom）。
    - 拒改：盖戳三列 operator/category/type 与主键 site_id/option → 400。
    - 坐标非法（nan/inf/越界）→ 400；未知字段 → 400；主键不存在 → 404。
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


@router.post("/delete")
async def delete_sites(body: DeleteBody, request: Request):
    """批量删除 site：事务内先建恢复点（pre_feature_delete）再删除。"""
    if not body.keys:
        raise HTTPException(status_code=400, detail="keys 不能为空")

    site_ids = [k.site_id for k in body.keys]
    options = [k.option for k in body.keys]

    async with pool().acquire() as conn:
        async with conn.transaction():
            # 顺序硬约束：建点必须在删除前、同一事务（删错可整体回滚 / F17 可恢复）
            rp_id = await create_restore_point(conn, reason="pre_feature_delete")
            status = await conn.execute(
                'DELETE FROM site WHERE (site_id, "option") IN '
                "(SELECT * FROM unnest($1::text[], $2::text[]))",
                site_ids,
                options,
            )
    deleted = int(status.split()[-1]) if status else 0

    await write_audit(
        action="delete_site",
        details={"deleted": deleted, "restore_point_id": rp_id, "requested": len(body.keys)},
        request=request,
    )
    return {"deleted": deleted, "restore_point_id": rp_id}
