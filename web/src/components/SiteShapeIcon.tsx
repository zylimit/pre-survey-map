/**
 * F20 #37 · 站型图标自绘 SVG（替代 Unicode 字符 ▲●■）
 *
 * 形状单一真源 = utils.siteShape(type)（与地图 RegularShape 同源，防漂移）：
 *   实心=存量 / 空心=规划 / 菱形=勘测；road=线、lessor=面。
 * 颜色走 currentColor → 继承 .node-type-icon 的灰 #9e9e9e，hover/选中（#34 蓝）自动跟。
 */
import { siteShape } from "../utils";
import type { LayerStamp } from "../api";

export default function SiteShapeIcon({ stamp, size = 14 }: { stamp: LayerStamp; size?: number }) {
  // road = 线
  if (stamp.target_kind === "road") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1" y="7.1" width="14" height="1.8" rx="0.9" fill="currentColor" />
      </svg>
    );
  }
  // lessor = 面
  if (stamp.target_kind === "lessor") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="currentColor" opacity="0.85" />
      </svg>
    );
  }
  // site = 按 type 形状（实心 fill / 空心 stroke）
  const { shape, filled } = siteShape(stamp.type ?? null);
  const paint = filled
    ? { fill: "currentColor", stroke: "none" }
    : { fill: "none", stroke: "currentColor", strokeWidth: 1.6 };
  let el;
  if (shape === "triangle") el = <polygon points="8,2.5 14,13.5 2,13.5" {...paint} strokeLinejoin="round" />;
  else if (shape === "circle") el = <circle cx="8" cy="8" r="5.5" {...paint} />;
  else if (shape === "square") el = <rect x="2.5" y="2.5" width="11" height="11" rx="1" {...paint} />;
  else el = <polygon points="8,1.8 14.2,8 8,14.2 1.8,8" {...paint} strokeLinejoin="round" />; // diamond
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">{el}</svg>
  );
}
