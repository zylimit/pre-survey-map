// 数字千分位：< 1000 原样，>= 1000 加 ,（en-US locale）
// Spec V1.x Mint Tech「科技感细节」硬要求
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US");
}
