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
