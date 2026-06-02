/**
 * F20 Phase 4 + #27 + #30 · 查看图层要素 —— 可拖可缩浮动窗口（V1.x #24/#27/#30）
 *
 * - 浮动窗口（非 modal，可关闭，不挡地图交互）；#30 改为可拖、可缩的固定尺寸窗口
 * - 数据 = 前端 filter 现有 FeatureCollection，与 Phase 3 树计数同源
 *   （site 按 operator/category/type 三列，road/lessor 整层）→ 行数 == 树节点计数
 * - 本版只读（无编辑/删除）
 * - #27-1 多列表格 + sticky 表头（列集按 kind 切换）；横向可滚动
 * - 本层筛选框（精确叫「筛选」，只在本层子集内按显示名收窄；≠ F16 全局搜索）
 * - 点击行 → 复用 F12（onPick = s.flyTo）：地图飞到 + 高亮 + 属性面板
 * - 虚拟化：固定行高范式（ROW_H/OVERSCAN/translateY），body 固定高 + overflow:auto
 *
 * #30 窗口交互：
 * - 首次开窗靠近触发按钮（anchor，仅组件挂载时读一次）；已开切图层 → 同窗口换内容、
 *   位置尺寸不动（App 不再用 key 重挂载；filter/scroll 复位改由 useEffect([target])）
 * - header 作 drag handle 改 left/top（rAF 节流 + clamp 防拖丢）
 * - 右下角手柄改 width/height（rAF 节流，最小 480×320 / 最大 视口−32）；宽高存 localStorage
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Feature, FeatureCollection } from "../api";
import type { ViewLayerTarget } from "../state";
import { useT } from "../i18n";
import { nameOf, STATUS_COLOR } from "../utils";

// ─── 虚拟化常量（沿用 #16 范式）────────────────────────────────────────────────
const ROW_H = 30;   // 数据行高（与 .lfl-row 一致）
const HEAD_H = 32;  // sticky 表头高（与 .lfl-thead 一致）
const OVERSCAN = 8;

// ─── #30 窗口常量 ─────────────────────────────────────────────────────────────
const LS_W = "presurvey.lfl.w";
const LS_H = "presurvey.lfl.h";
const DEF_W = 840, DEF_H = 460;     // 默认尺寸（宽够 Site 9 列一屏）
const MIN_W = 480, MIN_H = 320;     // 最小
const VP_MARGIN = 32;               // 最大 = 视口 − 32
const HEADER_KEEP = 48;             // 拖动时纵向至少保留的 header 可见高
const EDGE_KEEP = 120;              // 拖动时横向至少保留的可抓宽

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const maxW = () => Math.max(MIN_W, window.innerWidth - VP_MARGIN);
const maxH = () => Math.max(MIN_H, window.innerHeight - VP_MARGIN);

function readLSNum(k: string, def: number): number {
  try { const v = Number(localStorage.getItem(k)); return Number.isFinite(v) && v > 0 ? v : def; }
  catch { return def; }
}
function computeInitSize() {
  return {
    w: clamp(readLSNum(LS_W, DEF_W), MIN_W, maxW()),
    h: clamp(readLSNum(LS_H, DEF_H), MIN_H, maxH()),
  };
}
// 首次开窗位置：靠近触发按钮右下；clamp 进视口（无 anchor 则居中偏上）
function initialPos(anchor: { x: number; y: number } | null, size: { w: number; h: number }) {
  const m = 12;
  const maxLeft = Math.max(m, window.innerWidth - size.w - m);
  const maxTop = Math.max(m, window.innerHeight - size.h - m);
  if (!anchor) {
    return { left: clamp((window.innerWidth - size.w) / 2, m, maxLeft), top: clamp(96, m, maxTop) };
  }
  return { left: clamp(anchor.x + 8, m, maxLeft), top: clamp(anchor.y + 8, m, maxTop) };
}

// ─── 列定义（#27-1 列集，按 kind 切换）──────────────────────────────────────────
interface Col {
  key: string;
  labelKey: string;
  w: number;
  get: (f: Feature) => string;
  status?: boolean;
}

const str = (v: unknown): string => (v == null || v === "" ? "—" : String(v));
const fmtCoord = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(5) : "—";
};

// Road 取 LineString/MultiLineString 首坐标作「起点经纬度」
function roadStart(f: Feature): [string, string] {
  const g = f.geometry;
  if (!g) return ["—", "—"];
  let c: unknown = (g as { coordinates?: unknown }).coordinates;
  if (g.type === "MultiLineString") c = (c as number[][][])[0]?.[0];
  else if (g.type === "LineString") c = (c as number[][])[0];
  const arr = c as number[] | undefined;
  if (!Array.isArray(arr)) return ["—", "—"];
  return [fmtCoord(arr[0]), fmtCoord(arr[1])];
}

const SITE_COLS: Col[] = [
  { key: "project",     labelKey: "lfl.col.project",     w: 120, get: f => str(f.properties?.project) },
  { key: "site_id",     labelKey: "lfl.col.site_id",     w: 96,  get: f => str(f.properties?.site_id) },
  { key: "option",      labelKey: "lfl.col.option",      w: 70,  get: f => str(f.properties?.option) },
  { key: "site_status", labelKey: "lfl.col.site_status", w: 92,  get: f => str(f.properties?.site_status), status: true },
  { key: "lati",        labelKey: "lfl.col.lati",        w: 84,  get: f => fmtCoord(f.properties?.lati) },
  { key: "longi",       labelKey: "lfl.col.longi",       w: 84,  get: f => fmtCoord(f.properties?.longi) },
  { key: "operator",    labelKey: "lfl.col.operator",    w: 80,  get: f => str(f.properties?.operator) },
  { key: "category",    labelKey: "lfl.col.category",    w: 72,  get: f => str(f.properties?.category) },
  { key: "type",        labelKey: "lfl.col.type",        w: 104, get: f => str(f.properties?.type) },
];
const ROAD_COLS: Col[] = [
  { key: "property",  labelKey: "lfl.col.property",  w: 200, get: f => str(f.properties?.property) },
  { key: "start_lng", labelKey: "lfl.col.start_lng", w: 100, get: f => roadStart(f)[0] },
  { key: "start_lat", labelKey: "lfl.col.start_lat", w: 100, get: f => roadStart(f)[1] },
];
const LESSOR_COLS: Col[] = [
  { key: "lessor_name",     labelKey: "lfl.col.lessor_name",     w: 170, get: f => str(f.properties?.lessor_name) },
  { key: "lessor_category", labelKey: "lfl.col.lessor_category", w: 130, get: f => str(f.properties?.lessor_category) },
  { key: "relationship",    labelKey: "lfl.col.relationship",    w: 120, get: f => str(f.properties?.relationship), status: true },
];

interface Props {
  target: ViewLayerTarget;
  anchor: { x: number; y: number } | null;  // 首次开窗定位锚（仅挂载时读）
  sites: FeatureCollection;
  roads: FeatureCollection;
  lessors: FeatureCollection;
  selectedId: string | number | null;
  onPick: (f: Feature) => void;   // = s.flyTo（飞到 + 选中 + 属性面板）
  onClose: () => void;
}

export default function LayerFeatureList({
  target, anchor, sites, roads, lessors,
  selectedId, onPick, onClose,
}: Props) {
  const tFn = useT();
  const [filter, setFilter] = useState("");

  // ─── #30 窗口位置 / 尺寸（组件 state；位置仅挂载时按 anchor 初始化）───────────
  const [size, setSize] = useState(() => computeInitSize());
  const [pos, setPos] = useState(() => initialPos(anchor, computeInitSize()));

  const cols = target.kind === "site" ? SITE_COLS
    : target.kind === "road" ? ROAD_COLS : LESSOR_COLS;
  const totalW = useMemo(() => cols.reduce((a, c) => a + c.w, 0), [cols]);

  // ─── 本层要素子集（与 Phase 3 树计数同源的过滤口径）──────────────────────────
  const layerFeatures = useMemo<Feature[]>(() => {
    if (target.kind === "road") return roads.features;
    if (target.kind === "lessor") return lessors.features;
    const op = target.operator ?? "";
    const cat = target.category ?? "";
    const tp = target.type ?? "";
    return sites.features.filter(f => {
      const p = f.properties ?? {};
      return String(p.operator ?? "") === op
        && String(p.category ?? "") === cat
        && String(p.type ?? "") === tp;
    });
  }, [target, sites, roads, lessors]);

  // ─── 本层筛选（仅本层内按显示名 nameOf 收窄，与 F16/树过滤同口径）────────────
  const filtered = useMemo<Feature[]>(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return layerFeatures;
    return layerFeatures.filter(f => nameOf(f).toLowerCase().includes(q));
  }, [layerFeatures, filter]);

  // ─── 虚拟窗口 ────────────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(360);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ─── #30：切图层（target 变）→ 复位筛选 + 滚动（窗口不重挂载，位置尺寸保持）──
  useEffect(() => {
    setFilter("");
    setScrollTop(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [target]);

  // ─── F12 反向：地图选中本层要素 → 列表滚动到该行（扣掉 sticky 表头高）─────────
  useEffect(() => {
    if (selectedId == null) return;
    const sel = String(selectedId);
    const idx = filtered.findIndex(f => String(f.id) === sel);
    if (idx < 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const rowTop = HEAD_H + idx * ROW_H;
    const viewTop = el.scrollTop + HEAD_H;
    const viewBottom = el.scrollTop + el.clientHeight;
    if (rowTop < viewTop || rowTop + ROW_H > viewBottom) {
      el.scrollTop = Math.max(0, HEAD_H + idx * ROW_H - el.clientHeight / 2 + ROW_H / 2);
    }
  }, [selectedId, filtered]);

  // ─── #30：拖动（header）/ 缩放（右下角），rAF 节流 ───────────────────────────
  const dragRaf = useRef<number | null>(null);
  const resizeRaf = useRef<number | null>(null);
  useEffect(() => () => {
    if (dragRaf.current != null) cancelAnimationFrame(dragRaf.current);
    if (resizeRaf.current != null) cancelAnimationFrame(resizeRaf.current);
  }, []);

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".lfl-close")) return;  // 关闭按钮不触发拖动
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = pos.left, startTop = pos.top;
    document.body.style.userSelect = "none";
    let pending: { left: number; top: number } | null = null;
    const apply = () => { dragRaf.current = null; if (pending) setPos(pending); };
    const onMove = (mv: PointerEvent) => {
      // clamp：横向至少留 EDGE_KEEP 可抓宽，纵向 header 不越过视口上下沿（防拖丢）
      const left = clamp(startLeft + (mv.clientX - startX), -(size.w - EDGE_KEEP), window.innerWidth - EDGE_KEEP);
      const top = clamp(startTop + (mv.clientY - startY), 0, window.innerHeight - HEADER_KEEP);
      pending = { left, top };
      if (dragRaf.current == null) dragRaf.current = requestAnimationFrame(apply);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      if (dragRaf.current != null) { cancelAnimationFrame(dragRaf.current); dragRaf.current = null; }
      if (pending) setPos(pending);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const onResizePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const startW = size.w, startH = size.h;
    const mW = maxW(), mH = maxH();
    document.body.style.userSelect = "none";
    document.body.style.cursor = "nwse-resize";
    let pending: { w: number; h: number } | null = null;
    const apply = () => { resizeRaf.current = null; if (pending) setSize(pending); };
    const onMove = (mv: PointerEvent) => {
      const w = clamp(startW + (mv.clientX - startX), MIN_W, mW);
      const h = clamp(startH + (mv.clientY - startY), MIN_H, mH);
      pending = { w, h };
      if (resizeRaf.current == null) resizeRaf.current = requestAnimationFrame(apply);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (resizeRaf.current != null) { cancelAnimationFrame(resizeRaf.current); resizeRaf.current = null; }
      if (pending) {
        setSize(pending);
        try { localStorage.setItem(LS_W, String(pending.w)); localStorage.setItem(LS_H, String(pending.h)); } catch { /* 忽略 */ }
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  // ─── 可视区切片（content-Y = HEAD_H + i*ROW_H，故窗口先扣 HEAD_H）────────────
  const total = filtered.length;
  const start = Math.max(0, Math.floor((scrollTop - HEAD_H) / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop - HEAD_H + viewportH) / ROW_H) + OVERSCAN);
  const visible = filtered.slice(start, end);
  const selStr = String(selectedId);

  // ─── 标题路径 ────────────────────────────────────────────────────────────────
  const titlePath = useMemo(() => {
    if (target.kind === "road") return tFn("lfl.kind.road");
    if (target.kind === "lessor") return tFn("lfl.kind.lessor");
    const opLabel = tFn(`lt.tree.op.${target.operator}` as Parameters<typeof tFn>[0]);
    const catKey = target.category === "存量" ? "lt.tree.cat.legacy"
      : target.category === "规划" ? "lt.tree.cat.planned"
      : "lt.tree.cat.survey";
    const catLabel = tFn(catKey as Parameters<typeof tFn>[0]);
    return `${opLabel} / ${catLabel} / ${target.type ?? ""}`;
  }, [target, tFn]);

  // ─── 单行渲染（多列 cell）────────────────────────────────────────────────────
  const renderRow = (f: Feature, index: number) => {
    const id = String(f.id);
    const sel = id === selStr;
    return (
      <div
        key={id}
        className={`lfl-row${sel ? " selected" : ""}`}
        style={{ transform: `translateY(${index * ROW_H}px)`, height: ROW_H, width: totalW }}
        onClick={() => onPick(f)}
        title={nameOf(f)}
      >
        {cols.map(col => {
          const txt = col.get(f);
          const color = col.status
            ? (STATUS_COLOR[String(f.properties?.[col.key] ?? "")] ?? STATUS_COLOR[""])
            : undefined;
          return (
            <span key={col.key} className="lfl-cell" style={{ width: col.w, color }}>
              {txt}
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <div
      className="lfl-panel"
      role="dialog"
      aria-label={tFn("lfl.title")}
      style={{ left: pos.left, top: pos.top, width: size.w, height: size.h }}
    >
      <div className="lfl-head" onPointerDown={onHeaderPointerDown}>
        <span className="lfl-title">📋 {titlePath}</span>
        <span className="lfl-count">
          {filter.trim()
            ? tFn("lfl.count.filtered", { shown: total, total: layerFeatures.length })
            : tFn("lfl.count", { total: layerFeatures.length })}
        </span>
        <button className="lfl-close" onClick={onClose} title={tFn("lfl.close")}>✖</button>
      </div>

      <div className="lfl-filter">
        <input
          type="text"
          value={filter}
          placeholder={tFn("lfl.filter.placeholder")}
          onChange={e => setFilter(e.target.value)}
        />
      </div>

      {total === 0 ? (
        <div className="lfl-empty">
          {layerFeatures.length === 0 ? tFn("lfl.empty") : tFn("lfl.empty.filtered")}
        </div>
      ) : (
        <div
          className="lfl-scroll"
          ref={scrollRef}
          onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div className="lfl-table" style={{ width: totalW }}>
            <div className="lfl-thead" style={{ width: totalW, height: HEAD_H }}>
              {cols.map(col => (
                <span key={col.key} className="lfl-th" style={{ width: col.w }}>
                  {tFn(col.labelKey as Parameters<typeof tFn>[0])}
                </span>
              ))}
            </div>
            <div className="lfl-virt" style={{ height: total * ROW_H, width: totalW }}>
              {visible.map((f, i) => renderRow(f, start + i))}
            </div>
          </div>
        </div>
      )}

      {/* #30 右下角缩放手柄 */}
      <div className="lfl-resize" onPointerDown={onResizePointerDown} />
    </div>
  );
}
