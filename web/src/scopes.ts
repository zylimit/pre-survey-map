/**
 * #50 Phase 15 · 前端数据权限可见性（前端双保险，与后端 api/auth/scopes.py 同口径）
 *
 * 判定规则（子级继承）：
 *   is_admin 或 scopes 含 "*"            → 全部可见
 *   "site"                               → SITE 整棵树可见
 *   "site:Globe"                         → 该运营商子树（其下类别/图层/样式全可见）
 *   "site:Globe:SURVEY"                  → 该运营商该类别子树
 *   "road" / "lessor"                    → 对应整层可见
 *
 * LayerTree（节点不渲染）/ MapView（要素过滤）/ LayerFeatureList（入口双保险）
 * 三处共用此单一真源，禁止各抄一份。
 */
import type { Feature, FeatureCollection } from "./api";
import type { ViewLayerTarget } from "./state";

const FULL = "*";

// 库内中文类别 → scope 英文节点（后端 CATEGORY_NODE_TO_DB 的反向映射）
const CATEGORY_DB_TO_NODE: Record<string, string> = {
  "存量": "EXISTING",
  "规划": "PLANNED",
  "勘测": "SURVEY",
};

export interface ScopeCtx {
  isAdmin: boolean;
  scopes: string[];
}

const fullAccess = (ctx: ScopeCtx): boolean => ctx.isAdmin || ctx.scopes.includes(FULL);

/** SITE 根可见：全量，或持有任何 site 系 scope */
export function siteRootVisible(ctx: ScopeCtx): boolean {
  return fullAccess(ctx) || ctx.scopes.some(s => s === "site" || s.startsWith("site:"));
}

/** 运营商 📁 子树可见 */
export function operatorVisible(ctx: ScopeCtx, op: string): boolean {
  if (fullAccess(ctx) || ctx.scopes.includes("site")) return true;
  return ctx.scopes.some(s => s === `site:${op}` || s.startsWith(`site:${op}:`));
}

/** 类别 📁 子树可见（catZh = 库内中文类别值 存量/规划/勘测）；其下图层/样式节点随子树可见 */
export function categoryVisible(ctx: ScopeCtx, op: string, catZh: string): boolean {
  if (fullAccess(ctx) || ctx.scopes.includes("site") || ctx.scopes.includes(`site:${op}`)) {
    return true;
  }
  const node = CATEGORY_DB_TO_NODE[catZh];
  return node != null && ctx.scopes.includes(`site:${op}:${node}`);
}

export function roadVisible(ctx: ScopeCtx): boolean {
  return fullAccess(ctx) || ctx.scopes.includes("road");
}

export function lessorVisible(ctx: ScopeCtx): boolean {
  return fullAccess(ctx) || ctx.scopes.includes("lessor");
}

/**
 * #51 F23：AREA 面图层可见（operator 维度，与后端 area_scope_operators 同口径）：
 * 全量 / "site" / "site:<op>"（继承涵盖）/ "site:<op>:AREA" 授予；
 * 类别级节点（site:<op>:SURVEY 等）不授予 area。
 */
export function areaVisible(ctx: ScopeCtx, op: string): boolean {
  if (fullAccess(ctx) || ctx.scopes.includes("site") || ctx.scopes.includes(`site:${op}`)) {
    return true;
  }
  return ctx.scopes.includes(`site:${op}:AREA`);
}

/**
 * site 要素可见（MapView 双保险，与后端 site_scope_where 同口径）：
 * "site" / "site:<op>" 命中不看 category（NULL 类别也放行）；
 * 类别级 scope 要求 operator + category 双等。
 */
export function siteFeatureVisible(ctx: ScopeCtx, f: Feature): boolean {
  if (fullAccess(ctx) || ctx.scopes.includes("site")) return true;
  const p = f.properties ?? {};
  const op = String(p.operator ?? "");
  if (!op) return false;
  if (ctx.scopes.includes(`site:${op}`)) return true;
  const node = CATEGORY_DB_TO_NODE[String(p.category ?? "")];
  return node != null && ctx.scopes.includes(`site:${op}:${node}`);
}

/** 「查看图层要素」入口双保险：目标图层必须在可见 scope 内 */
export function targetVisible(ctx: ScopeCtx, target: ViewLayerTarget): boolean {
  if (target.kind === "road") return roadVisible(ctx);
  if (target.kind === "lessor") return lessorVisible(ctx);
  if (target.kind === "area") return areaVisible(ctx, target.operator ?? "");
  return categoryVisible(ctx, target.operator ?? "", target.category ?? "");
}

/** FeatureCollection 按 scope 过滤（MapView 渲染前双保险；数据本已被后端过滤） */
export function filterByScope(
  ctx: ScopeCtx,
  kind: ViewLayerTarget["kind"],
  fc: FeatureCollection,
): FeatureCollection {
  if (fullAccess(ctx)) return fc;
  if (kind === "road") return roadVisible(ctx) ? fc : { ...fc, features: [] };
  if (kind === "lessor") return lessorVisible(ctx) ? fc : { ...fc, features: [] };
  // #51：area 按 feature 的 operator 逐个判定（site:<op>:AREA 只授予单运营商）
  if (kind === "area") {
    return {
      ...fc,
      features: fc.features.filter(f =>
        areaVisible(ctx, String((f.properties ?? {}).operator ?? ""))),
    };
  }
  return { ...fc, features: fc.features.filter(f => siteFeatureVisible(ctx, f)) };
}
