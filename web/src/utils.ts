import { Feature } from "./api";

// 数字千分位：< 1000 原样，>= 1000 加 ,（en-US locale）
// Spec V1.x Mint Tech「科技感细节」硬要求
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US");
}

// 要素显示名：左树过滤、全局搜索（F16）共用同一口径，避免两套语义
export function nameOf(f: Feature): string {
  const p = f.properties;
  if (!p) return "(未命名)";
  if (p.kind === "site") return `${p.site_id ?? "?"}${p.option ? ` / ${p.option}` : ""}`;
  if (p.kind === "road") return (p.property as string) || `road #${p.id}`;
  if (p.kind === "lessor") return (p.lessor_name as string) || `lessor ${p.fid}`;
  return "(未知)";
}

// ─── F20 Phase 5 · 要素渲染单一真源（V1.x #24/#25）───────────────────────────
// ⚠️ #19 地图区护栏：要素颜色是「数据语义」，硬编码在此，不读 theme.css、不参与
//    亮/暗主题切换。LayerTree / LayerFeatureList / MapView 三处统一 import 此处，
//    不许再各抄一份色表（收敛 Phase 4 遗留的坑6）。

// 状态 / 关系 / 类型 → 色。键沿用历史口径（LayerTree/LayerFeatureList 原样）：
//   site_status: positive 绿 / negative 红 / undermine 黄 / ""(空值未知) 灰（#33 红黄对调）
//   lessor relationship: Unfriendly 红 / Normal 黄（去 Friendly）
//   road: 单色棕
export const STATUS_COLOR: Record<string, string> = {
  positive:   "#4caf50",
  negative:   "#f44336",
  undermine:  "#ffb300",
  "":         "#9e9e9e",
  Unfriendly: "#f44336",
  Normal:     "#ffb300",
  road:       "#795548",
};

// #41：site_status 归桶——三标准状态取小写原值，其余（空值/pending/未知）统一归 "other"。
// ⚠️ 单一真源：siteMap 分组、F12 反向定位、LayerFeatureList 过滤三处必须用它，口径一致。
export function statusBucket(raw: unknown): string {
  const s = String(raw ?? "").toLowerCase();
  return (s === "positive" || s === "negative" || s === "undermine") ? s : "other";
}

// #44：图层默认色（按 category）。状态分色只在勘测用；存量/规划用这套图层色。
// 避开状态绿(#4caf50)/红(#f44336)/黄(#ffb300)/棕(#795548) + 选中蓝(#3b82f6)。
export const LAYER_COLOR: Record<string, string> = {
  "存量": "#f97316",  // 橙
  "规划": "#a855f7",  // 紫
};

// site_status → 填充色（大小写不敏感；正/负/受损，其余=空值灰）
export function siteStatusColor(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "positive") return STATUS_COLOR.positive;
  if (s === "negative") return STATUS_COLOR.negative;
  if (s === "undermine") return STATUS_COLOR.undermine;
  return STATUS_COLOR[""];
}

// lessor relationship → 线色（去 Friendly：仅 Normal 黄 / 其余=Unfriendly 红）
export function lessorLineColor(rel: string | null | undefined): string {
  return (rel ?? "").toLowerCase() === "normal" ? STATUS_COLOR.Normal : STATUS_COLOR.Unfriendly;
}

// 站型 type → 形状（实心=存量 / 空心=规划 / 菱形=勘测）
export type ShapeKind = "triangle" | "circle" | "square" | "diamond";
export interface SiteShape {
  shape: ShapeKind;
  filled: boolean;
  ring?: boolean;   // 规划类 Macro NP / Micro NP：额外画 50m 辐射圈
}
export const TYPE_SHAPE: Record<string, SiteShape> = {
  "Macro":         { shape: "triangle", filled: true },
  "Micro":         { shape: "circle",   filled: true },
  "IBS":           { shape: "square",   filled: true },
  "Macro NP":      { shape: "triangle", filled: false, ring: true },
  "Micro NP":      { shape: "circle",   filled: false, ring: true },
  "Macro-ongoing": { shape: "diamond",  filled: true },
  "Micro-ongoing": { shape: "diamond",  filled: false },
};
// 缺失 / 未知 type（旧数据）→ 退化默认实心圆，不报错
export const DEFAULT_SITE_SHAPE: SiteShape = { shape: "circle", filled: true };

export function siteShape(type: string | null | undefined): SiteShape {
  if (type == null) return DEFAULT_SITE_SHAPE;
  return TYPE_SHAPE[type] ?? DEFAULT_SITE_SHAPE;
}

// NP 辐射圈半径（#45）：默认 50m，可配。全局唯一值，挂工具栏下拉、存 localStorage。
export const DEFAULT_NP_RADIUS_M = 50;
// 半径白名单（米）。下拉选项 + localStorage 读入校验都用这一份真源。
export const NP_RADIUS_OPTIONS = [50, 100, 150, 200, 250] as const;

// 真实地面米 → EPSG:3857 投影半径。
// Web Mercator 在纬度 φ 处单位被拉伸 1/cos(φ)，故投影半径 = meters / cos(φ)。
// 用点自身纬度算 → 圈是真实 50m，且因 geometry 用地图单位、缩放时自动正确缩放。
export function metersToProjRadius(meters: number, latDeg: number): number {
  const c = Math.cos((latDeg * Math.PI) / 180);
  return c > 1e-6 ? meters / c : meters;
}

// #RRGGBB → rgba(...)（lessor 半透明面填充用；alpha 0~1）
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
