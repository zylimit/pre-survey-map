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
import type { Feature, FeatureCollection, SiteKey, SitePatch } from "../api";
import type { ViewLayerTarget } from "../state";
import { useT } from "../i18n";
import { nameOf, STATUS_COLOR, siteStatusColor, statusBucket } from "../utils";
import { targetVisible, type ScopeCtx } from "../scopes";
import ConfirmDialog from "./ConfirmDialog";

// #48：site 增删改/勾选导出列宽（固定，不参与 #31 等比拉伸；列宽可拖留到 Phase 8）
const CHECK_W = 36;   // 行前多选 checkbox 列
const ACTION_W = 60;  // 行尾操作列（编辑）

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

// #43：八方向拉伸。dir 含 e/w/n/s 的组合，角是两轴叠加。
type ResizeDir = "e" | "w" | "n" | "s" | "ne" | "nw" | "se" | "sw";
const RESIZE_DIRS: readonly ResizeDir[] = ["e", "w", "n", "s", "ne", "nw", "se", "sw"];
const RESIZE_CURSOR: Record<ResizeDir, string> = {
  e: "ew-resize", w: "ew-resize", n: "ns-resize", s: "ns-resize",
  ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize",
};
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
// #51：area 只读列表（name 去重键 + extras 主要字段；本期不做增删改）
const AREA_COLS: Col[] = [
  { key: "name",        labelKey: "lfl.col.name",        w: 220, get: f => str(f.properties?.name) },
  { key: "polygon_id",  labelKey: "lfl.col.polygon_id",  w: 130, get: f => str(f.properties?.polygon_id) },
  { key: "geozone_pr",  labelKey: "lfl.col.geozone_pr",  w: 130, get: f => str(f.properties?.geozone_pr) },
  { key: "new_polygo",  labelKey: "lfl.col.new_polygo",  w: 130, get: f => str(f.properties?.new_polygo) },
];

interface Props {
  target: ViewLayerTarget;
  anchor: { x: number; y: number } | null;  // 首次开窗定位锚（仅挂载时读）
  sites: FeatureCollection;
  roads: FeatureCollection;
  lessors: FeatureCollection;
  areas: FeatureCollection;   // #51：AREA 面图层只读列表数据源
  selectedId: string | number | null;
  onPick: (f: Feature) => void;   // = s.flyTo（飞到 + 选中 + 属性面板）
  onClose: () => void;
  // #48（仅 site 用）：编辑/删除/勾选导出。返回 null=成功，string=可读错误。
  onUpdateSite: (key: SiteKey, patch: SitePatch) => Promise<string | null>;
  onDeleteSites: (keys: SiteKey[]) => Promise<string | null>;
  onExportSites: (keys: SiteKey[]) => void;
  // #50 Phase 15：数据权限双保险（不可见图层入口不渲染）+ 功能权限门控
  scopes: string[];
  isAdmin: boolean;
  canExport: boolean;      // export → [导出选中]
  canEditDelete: boolean;  // edit_delete → 多选列 / [编辑] / [删除选中]
}

// 取 site 复合主键
const featKey = (f: Feature): SiteKey => ({
  site_id: String(f.properties?.site_id ?? ""),
  option: String(f.properties?.option ?? ""),
});

// ─── #48 Phase 8 列宽可拖调 ──────────────────────────────────────────────────
const MIN_COL_W = 48;  // 最小列宽守卫
function colsForKind(kind: ViewLayerTarget["kind"]): Col[] {
  return kind === "site" ? SITE_COLS
    : kind === "road" ? ROAD_COLS
    : kind === "area" ? AREA_COLS
    : LESSOR_COLS;
}
// localStorage key：按 kind+列key（如 presurvey.lfl.col.site.lati）。未拖列不写。
const colLSKey = (kind: string, colKey: string) => `presurvey.lfl.col.${kind}.${colKey}`;
// 开窗恢复手动列宽（仅读到 >=MIN_COL_W 的有效值）
function readManualWidths(kind: string, cols: Col[]): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const c of cols) {
      const v = Number(localStorage.getItem(colLSKey(kind, c.key)));
      if (Number.isFinite(v) && v >= MIN_COL_W) out[c.key] = v;
    }
  } catch { /* localStorage 不可用则全走自动 */ }
  return out;
}

export default function LayerFeatureList({
  target, anchor, sites, roads, lessors, areas,
  selectedId, onPick, onClose,
  onUpdateSite, onDeleteSites, onExportSites,
  scopes, isAdmin, canExport, canEditDelete,
}: Props) {
  const tFn = useT();
  const [filter, setFilter] = useState("");

  // #50 Phase 15：scope 判定上下文；不可见图层 → 整窗不渲染（树节点已不渲染，此处双保险）
  const scopeCtx: ScopeCtx = useMemo(() => ({ isAdmin, scopes }), [isAdmin, scopes]);
  const layerVisible = targetVisible(scopeCtx, target);

  // #48：仅 site 图层渲染多选/操作/批量按钮；road/lessor 保持纯只读
  // #50 Phase 15：多选列/[编辑]/[删除选中] 按 edit_delete 门控；[导出选中] 按 export 门控
  const isSite = target.kind === "site";
  const showCheck = isSite && canEditDelete;
  const showEdit = isSite && canEditDelete;
  const showDelete = canEditDelete;
  const showExportBtn = canExport;
  // 选中集合（key=feature id，如 "site:{id}:{option}"）。切图层 / 删除后清空。
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // 当前编辑的 site 行（null=未在编辑）
  const [editing, setEditing] = useState<Feature | null>(null);
  // 批量删除确认框
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // ─── #30 窗口位置 / 尺寸（组件 state；位置仅挂载时按 anchor 初始化）───────────
  const [size, setSize] = useState(() => computeInitSize());
  const [pos, setPos] = useState(() => initialPos(anchor, computeInitSize()));

  const cols = colsForKind(target.kind);
  // #48：site 多选列(前) + 操作列(后) 计入 minWidth，保横滚下限（#50：按权限门控折算）
  const extraW = (showCheck ? CHECK_W : 0) + (showEdit ? ACTION_W : 0);

  // ─── #48 Phase 8：手动列宽（被拖过的列）。空=全走 #31 等比。按 kind 持久化。─────
  const [manualWidths, setManualWidths] = useState<Record<string, number>>(
    () => readManualWidths(target.kind, colsForKind(target.kind)),
  );
  // 列 flex：手动拖过 → 固定宽 `0 0 Wpx`（退出等比）；未拖过 → #31 等比 `${w} 0 ${w}px`
  const colFlex = (col: Col): string =>
    manualWidths[col.key] != null
      ? `0 0 ${manualWidths[col.key]}px`
      : `${col.w} 0 ${col.w}px`;
  // minWidth 用「有效宽」（手动优先）求和，保横滚下限随手动宽联动
  const totalW = useMemo(
    () => cols.reduce((a, c) => a + (manualWidths[c.key] ?? c.w), 0) + extraW,
    [cols, extraW, manualWidths],
  );

  // ─── 本层要素子集（与 Phase 3 树计数同源的过滤口径）──────────────────────────
  const layerFeatures = useMemo<Feature[]>(() => {
    if (target.kind === "road") return roads.features;
    if (target.kind === "lessor") return lessors.features;
    // #51：area 按 operator 过滤（与树 areaMap 计数同源）
    if (target.kind === "area") {
      const op = target.operator ?? "";
      return areas.features.filter(f => String((f.properties ?? {}).operator ?? "") === op);
    }
    const op = target.operator ?? "";
    const cat = target.category ?? "";
    const tp = target.type ?? "";
    return sites.features.filter(f => {
      const p = f.properties ?? {};
      if (String(p.operator ?? "") !== op || String(p.category ?? "") !== cat || String(p.type ?? "") !== tp) {
        return false;
      }
      // #40：样式节点 [查看] 带 status → 再按 status 归桶收窄（与 siteMap 同口径）
      if (!target.status) return true;
      return statusBucket(p.site_status as string | null | undefined) === target.status;
    });
  }, [target, sites, roads, lessors, areas]);

  // ─── 本层筛选（仅本层内按显示名 nameOf 收窄，与 F16/树过滤同口径）────────────
  const filtered = useMemo<Feature[]>(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return layerFeatures;
    return layerFeatures.filter(f => nameOf(f).toLowerCase().includes(q));
  }, [layerFeatures, filter]);

  // ─── #48 选中派生值 ──────────────────────────────────────────────────────────
  // 选中要素从本层全集解析（选择可跨筛选保留）；删除/导出用其 {site_id,option}
  const selectedFeatures = useMemo<Feature[]>(
    () => (isSite ? layerFeatures.filter(f => selectedKeys.has(String(f.id))) : []),
    [isSite, layerFeatures, selectedKeys],
  );
  const selectedCount = selectedFeatures.length;
  // 全选 checkbox 只作用当前 filtered 子集（与筛选口径一致）
  const allFilteredSelected = isSite && filtered.length > 0
    && filtered.every(f => selectedKeys.has(String(f.id)));
  // Phase 7 低修复2：部分选中 → 全选 checkbox 显 indeterminate 三态
  const someFilteredSelected = isSite && filtered.some(f => selectedKeys.has(String(f.id)));
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someFilteredSelected && !allFilteredSelected;
    }
  }, [someFilteredSelected, allFilteredSelected]);

  const toggleOne = (id: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAllFiltered = () => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (allFilteredSelected) for (const f of filtered) next.delete(String(f.id));
      else for (const f of filtered) next.add(String(f.id));
      return next;
    });
  };

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
  //     #48：同时清空选中/编辑/删除确认，避免跨图层串台
  useEffect(() => {
    setFilter("");
    setScrollTop(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setSelectedKeys(new Set());
    setEditing(null);
    setConfirmingDelete(false);
    // #48 Phase 8：切 kind 重载该 kind 的手动列宽
    setManualWidths(readManualWidths(target.kind, colsForKind(target.kind)));
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
  const colRaf = useRef<number | null>(null);  // #48 Phase 8 列宽拖动节流
  useEffect(() => () => {
    if (dragRaf.current != null) cancelAnimationFrame(dragRaf.current);
    if (resizeRaf.current != null) cancelAnimationFrame(resizeRaf.current);
    if (colRaf.current != null) cancelAnimationFrame(colRaf.current);
  }, []);

  // #26 review 遗留：拖动进行中组件 unmount 时，pointerdown 挂上的 document
  // pointermove/pointerup 监听会泄漏（onUp 永远不会触发）。各 pointerdown handler
  // 注册一个 cleanup 到此 ref，unmount 统一兜底移除 + 还原 body 样式。
  const activeDragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    activeDragCleanup.current?.();
    activeDragCleanup.current = null;
  }, []);

  // #48 Phase 8：列宽拖动（表头列右边界手柄）。stopPropagation 防触发 header 窗口拖动/行点击。
  const onColResizeDown = (e: React.PointerEvent, col: Col) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = manualWidths[col.key] ?? col.w;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    let pending: number | null = null;
    const apply = () => {
      colRaf.current = null;
      if (pending != null) setManualWidths(prev => ({ ...prev, [col.key]: pending as number }));
    };
    const onMove = (mv: PointerEvent) => {
      pending = Math.max(MIN_COL_W, Math.round(startW + (mv.clientX - startX)));
      if (colRaf.current == null) colRaf.current = requestAnimationFrame(apply);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (activeDragCleanup.current === cleanup) activeDragCleanup.current = null;
      if (colRaf.current != null) { cancelAnimationFrame(colRaf.current); colRaf.current = null; }
      if (pending != null) {
        const w = pending;
        setManualWidths(prev => ({ ...prev, [col.key]: w }));
        try { localStorage.setItem(colLSKey(target.kind, col.key), String(w)); } catch { /* 忽略 */ }
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    // unmount 兜底注册（onUp 正常触发后自清）
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    activeDragCleanup.current = cleanup;
  };

  // #48 Phase 8：双击列手柄 → 清掉该列手动宽，还原 #31 自动等比（Excel 双击惯例）
  const onColResizeReset = (e: React.MouseEvent, col: Col) => {
    e.preventDefault();
    e.stopPropagation();
    setManualWidths(prev => {
      if (!(col.key in prev)) return prev;
      const next = { ...prev };
      delete next[col.key];
      return next;
    });
    try { localStorage.removeItem(colLSKey(target.kind, col.key)); } catch { /* 忽略 */ }
  };

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
      if (activeDragCleanup.current === cleanup) activeDragCleanup.current = null;
      if (dragRaf.current != null) { cancelAnimationFrame(dragRaf.current); dragRaf.current = null; }
      if (pending) setPos(pending);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    // unmount 兜底注册（onUp 正常触发后自清）
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
    };
    activeDragCleanup.current = cleanup;
  };

  // #43：八方向拉伸。含 w/n 时锚点在对侧 → 同步改 pos.left/top（坑1）；都走 clamp。
  const onResizePointerDown = (e: React.PointerEvent, dir: ResizeDir) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const startW = size.w, startH = size.h;
    const startLeft = pos.left, startTop = pos.top;
    const mW = maxW(), mH = maxH();
    document.body.style.userSelect = "none";
    document.body.style.cursor = RESIZE_CURSOR[dir];
    let pending: { w: number; h: number; left: number; top: number } | null = null;
    const apply = () => {
      resizeRaf.current = null;
      if (pending) {
        setSize({ w: pending.w, h: pending.h });
        setPos({ left: pending.left, top: pending.top });
      }
    };
    const onMove = (mv: PointerEvent) => {
      const dx = mv.clientX - startX, dy = mv.clientY - startY;
      let w = startW, h = startH, left = startLeft, top = startTop;
      if (dir.includes("e")) w = clamp(startW + dx, MIN_W, mW);
      if (dir.includes("w")) { w = clamp(startW - dx, MIN_W, mW); left = startLeft + (startW - w); }
      if (dir.includes("s")) h = clamp(startH + dy, MIN_H, mH);
      if (dir.includes("n")) { h = clamp(startH - dy, MIN_H, mH); top = startTop + (startH - h); }
      pending = { w, h, left, top };
      if (resizeRaf.current == null) resizeRaf.current = requestAnimationFrame(apply);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (activeDragCleanup.current === cleanup) activeDragCleanup.current = null;
      if (resizeRaf.current != null) { cancelAnimationFrame(resizeRaf.current); resizeRaf.current = null; }
      if (pending) {
        setSize({ w: pending.w, h: pending.h });
        setPos({ left: pending.left, top: pending.top });
        // 持久化仅尺寸（位置不持久化，#30）
        try { localStorage.setItem(LS_W, String(pending.w)); localStorage.setItem(LS_H, String(pending.h)); } catch { /* 忽略 */ }
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    // unmount 兜底注册（onUp 正常触发后自清）
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    activeDragCleanup.current = cleanup;
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
    // #51：area 标题 = 运营商 / Area（无类别/站型层级）
    if (target.kind === "area") return `${opLabel} / ${tFn("lfl.kind.area")}`;
    const catKey = target.category === "存量" ? "lt.tree.cat.legacy"
      : target.category === "规划" ? "lt.tree.cat.planned"
      : "lt.tree.cat.survey";
    const catLabel = tFn(catKey as Parameters<typeof tFn>[0]);
    const base = `${opLabel} / ${catLabel} / ${target.type ?? ""}`;
    // #40：样式节点 [查看] 带 status → 标题追加状态名（other 用「其他」，三标准用各自 i18n）
    if (!target.status) return base;
    const stLabel = target.status === "other"
      ? tFn("lt.tree.status.other")
      : tFn(`lt.tree.status.${target.status}` as Parameters<typeof tFn>[0]);
    return `${base} / ${stLabel}`;
  }, [target, tFn]);

  // ─── 单行渲染（多列 cell）────────────────────────────────────────────────────
  const renderRow = (f: Feature, index: number) => {
    const id = String(f.id);
    const sel = id === selStr;
    const checked = selectedKeys.has(id);
    return (
      <div
        key={id}
        className={`lfl-row${sel ? " selected" : ""}`}
        style={{ transform: `translateY(${index * ROW_H}px)`, height: ROW_H, width: "100%" }}
        onClick={() => onPick(f)}
        title={nameOf(f)}
      >
        {showCheck && (
          <span
            className="lfl-cell lfl-check"
            style={{ flex: `${CHECK_W} 0 ${CHECK_W}px` }}
            onClick={e => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggleOne(id)}
              aria-label={tFn("lfl.sel.row")}
            />
          </span>
        )}
        {cols.map(col => {
          const txt = col.get(f);
          // #37：site_status 走 siteStatusColor（已 toLowerCase，修大写退灰）；
          //      relationship 维持 STATUS_COLOR 原值查（Unfriendly/Normal 是大写 key，不能 lower）
          const color = !col.status
            ? undefined
            : col.key === "site_status"
              ? siteStatusColor(f.properties?.site_status as string | null | undefined)
              : (STATUS_COLOR[String(f.properties?.[col.key] ?? "")] ?? STATUS_COLOR[""]);
          return (
            <span key={col.key} className="lfl-cell" style={{ flex: colFlex(col), color }}>
              {txt}
            </span>
          );
        })}
        {showEdit && (
          <span
            className="lfl-cell lfl-action"
            style={{ flex: `${ACTION_W} 0 ${ACTION_W}px` }}
            onClick={e => e.stopPropagation()}
          >
            <button
              className="lfl-edit-btn"
              onClick={() => setEditing(f)}
              title={tFn("lfl.act.edit")}
            >✏️</button>
          </span>
        )}
      </div>
    );
  };

  // #50 Phase 15 双保险：无权限图层的列表入口不渲染（树节点已不渲染，正常路径不可达）
  if (!layerVisible) return null;

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

      {/* #48：site 批量操作条（删除选中 / 导出选中）；road/lessor 不渲染；
          #50 Phase 15：删除按 edit_delete、导出按 export 分别门控 */}
      {isSite && (showDelete || showExportBtn) && (
        <div className="lfl-actions">
          <span className="lfl-sel-count">{tFn("lfl.sel.count", { n: selectedCount })}</span>
          {showDelete && (
            <button
              className="lfl-act danger"
              disabled={selectedCount === 0}
              onClick={() => setConfirmingDelete(true)}
            >🗑️ {tFn("lfl.del.btn")}</button>
          )}
          {showExportBtn && (
            <button
              className="lfl-act"
              disabled={selectedCount === 0}
              onClick={() => onExportSites(selectedFeatures.map(featKey))}
            >💾 {tFn("lfl.exp.btn")}</button>
          )}
        </div>
      )}

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
          {/* #31：列宽随窗口等比拉伸填满，minWidth=totalW 保横滚下限 */}
          <div className="lfl-table" style={{ minWidth: totalW, width: "100%" }}>
            <div className="lfl-thead" style={{ minWidth: totalW, width: "100%", height: HEAD_H }}>
              {showCheck && (
                <span className="lfl-th lfl-check" style={{ flex: `${CHECK_W} 0 ${CHECK_W}px` }}>
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleAllFiltered}
                    title={tFn("lfl.sel.all")}
                    aria-label={tFn("lfl.sel.all")}
                  />
                </span>
              )}
              {cols.map(col => (
                <span key={col.key} className="lfl-th" style={{ flex: colFlex(col) }}>
                  {tFn(col.labelKey as Parameters<typeof tFn>[0])}
                  {/* #48 Phase 8：列右边界拖拽手柄（拖=调宽 / 双击=还原自动）*/}
                  <span
                    className="lfl-col-resize"
                    onPointerDown={e => onColResizeDown(e, col)}
                    onDoubleClick={e => onColResizeReset(e, col)}
                    title={tFn("lfl.col.resize")}
                  />
                </span>
              ))}
              {showEdit && (
                <span className="lfl-th lfl-action" style={{ flex: `${ACTION_W} 0 ${ACTION_W}px` }}>
                  {tFn("lfl.col.actions")}
                </span>
              )}
            </div>
            <div className="lfl-virt" style={{ height: total * ROW_H, minWidth: totalW, width: "100%" }}>
              {visible.map((f, i) => renderRow(f, start + i))}
            </div>
          </div>
        </div>
      )}

      {/* #43 八方向拉伸手柄（四边 + 四角）*/}
      {RESIZE_DIRS.map(d => (
        <div
          key={d}
          className={`lfl-resize lfl-resize-${d}`}
          onPointerDown={e => onResizePointerDown(e, d)}
        />
      ))}

      {/* #48 单行编辑表单 */}
      {editing && (
        <SiteEditModal
          feature={editing}
          onSubmit={patch => onUpdateSite(featKey(editing), patch)}
          onClose={() => setEditing(null)}
        />
      )}

      {/* #48 批量删除确认（复用 ConfirmDialog；成功后清空选中） */}
      {confirmingDelete && (
        <ConfirmDialog
          title={tFn("lfl.del.title")}
          body={tFn("lfl.del.body", { n: selectedCount })}
          confirmLabel={tFn("lfl.del.btn")}
          cancelLabel={tFn("lfl.del.cancel")}
          destructive
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={async () => {
            const err = await onDeleteSites(selectedFeatures.map(featKey));
            setConfirmingDelete(false);
            if (!err) setSelectedKeys(new Set());
          }}
        />
      )}
    </div>
  );
}

// ─── #48 site 单行编辑表单（小 modal）─────────────────────────────────────────
// 可改 project/site_status/lati/longi；site_id/option/operator/category/type 只读置灰。
// 只提交真正变更的字段；坐标做客户端有限数校验（后端再做范围/类型兜底校验）。
const editStr = (v: unknown): string => (v == null ? "" : String(v));

function SiteEditModal({
  feature,
  onSubmit,
  onClose,
}: {
  feature: Feature;
  onSubmit: (patch: SitePatch) => Promise<string | null>;
  onClose: () => void;
}) {
  const tFn = useT();
  const p = feature.properties ?? {};
  const [project, setProject] = useState(editStr(p.project));
  const [siteStatus, setSiteStatus] = useState(editStr(p.site_status));
  const [lati, setLati] = useState(editStr(p.lati));
  const [longi, setLongi] = useState(editStr(p.longi));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const patch: SitePatch = {};
    if (project !== editStr(p.project)) patch.project = project;
    if (siteStatus !== editStr(p.site_status)) patch.site_status = siteStatus;
    // 坐标：仅在文本变更时纳入；空串→不改，非空必须是有限数字且在合法经纬度范围内
    // （Phase 7 低修复3：补范围校验 lati∈[-90,90] / longi∈[-180,180]，后端仍兜底）
    if (lati !== editStr(p.lati)) {
      const n = Number(lati);
      if (lati.trim() === "" || !Number.isFinite(n) || n < -90 || n > 90) {
        setErr(tFn("lfl.edit.coord_err")); return;
      }
      patch.lati = n;
    }
    if (longi !== editStr(p.longi)) {
      const n = Number(longi);
      if (longi.trim() === "" || !Number.isFinite(n) || n < -180 || n > 180) {
        setErr(tFn("lfl.edit.coord_err")); return;
      }
      patch.longi = n;
    }
    if (Object.keys(patch).length === 0) { setErr(tFn("lfl.edit.nochange")); return; }
    setErr(null);
    setBusy(true);
    const e = await onSubmit(patch);
    setBusy(false);
    if (e) setErr(e);
    else onClose();
  };

  return (
    <div className="modal-mask">
      <div className="modal lfl-edit-modal">
        <div className="modal-header">
          <h2>{tFn("lfl.edit.title")}</h2>
        </div>
        <div className="modal-body lfl-edit-body">
          {/* 只读：主键 + 盖戳列 */}
          <label>{tFn("lfl.col.site_id")}<input value={editStr(p.site_id)} disabled /></label>
          <label>{tFn("lfl.col.option")}<input value={editStr(p.option)} disabled /></label>
          <label>{tFn("lfl.col.operator")}<input value={editStr(p.operator)} disabled /></label>
          <label>{tFn("lfl.col.category")}<input value={editStr(p.category)} disabled /></label>
          <label>{tFn("lfl.col.type")}<input value={editStr(p.type)} disabled /></label>
          {/* 可编辑 */}
          <label>{tFn("lfl.col.project")}
            <input value={project} onChange={e => setProject(e.target.value)} />
          </label>
          <label>{tFn("lfl.col.site_status")}
            <input value={siteStatus} onChange={e => setSiteStatus(e.target.value)} />
          </label>
          <label>{tFn("lfl.col.lati")}
            <input value={lati} onChange={e => setLati(e.target.value)} inputMode="decimal" />
          </label>
          <label>{tFn("lfl.col.longi")}
            <input value={longi} onChange={e => setLongi(e.target.value)} inputMode="decimal" />
          </label>
          {err && <div className="lfl-edit-err">{err}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} disabled={busy}>{tFn("lfl.edit.cancel")}</button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? tFn("lfl.edit.saving") : tFn("lfl.edit.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
