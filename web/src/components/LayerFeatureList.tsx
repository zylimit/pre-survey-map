/**
 * F20 Phase 4 + #27 · 查看图层要素 —— 浮动列表框（V1.x #24/#27）
 *
 * - 浮动面板（floating panel，非 modal，可关闭，不挡地图交互）
 * - 数据 = 前端 filter 现有 FeatureCollection，与 Phase 3 树计数同源
 *   （site 按 operator/category/type 三列，road/lessor 整层）→ 行数 == 树节点计数
 * - 本版只读（无编辑/删除）
 * - #27-1 多列表格 + sticky 表头（列集按 kind 切换）；横向可滚动
 * - 本层筛选框（精确叫「筛选」，只在本层子集内按显示名收窄；≠ F16 全局搜索）
 * - 点击行 → 复用 F12（onPick = s.flyTo）：地图飞到 + 高亮 + 属性面板
 * - 虚拟化：沿用 LayerTree #16 的零依赖固定行高范式（ROW_H/OVERSCAN/translateY）
 *   多列后仍是固定行高，虚拟化照旧；表头 sticky 占 HEAD_H，窗口计算扣掉它
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

// ─── 列定义（#27-1 列集，按 kind 切换）──────────────────────────────────────────
interface Col {
  key: string;       // 对应 properties 字段名（status 列用它取原值算色）
  labelKey: string;  // i18n 列标题键
  w: number;         // 列宽 px（固定，撑横向滚动）
  get: (f: Feature) => string;
  status?: boolean;  // 该列文字按 STATUS_COLOR 上色（site_status / relationship）
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
  // Point 时 c 已是 [lng,lat]
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
  sites: FeatureCollection;
  roads: FeatureCollection;
  lessors: FeatureCollection;
  selectedId: string | number | null;
  onPick: (f: Feature) => void;   // = s.flyTo（飞到 + 选中 + 属性面板）
  onClose: () => void;
}

export default function LayerFeatureList({
  target, sites, roads, lessors,
  selectedId, onPick, onClose,
}: Props) {
  const tFn = useT();
  const [filter, setFilter] = useState("");

  const cols = target.kind === "site" ? SITE_COLS
    : target.kind === "road" ? ROAD_COLS : LESSOR_COLS;
  const totalW = useMemo(() => cols.reduce((a, c) => a + c.w, 0), [cols]);

  // ─── 本层要素子集（与 Phase 3 树计数同源的过滤口径）──────────────────────────
  const layerFeatures = useMemo<Feature[]>(() => {
    if (target.kind === "road") return roads.features;
    if (target.kind === "lessor") return lessors.features;
    // site：与 LayerTree siteMap 的 `${op}/${cat}/${tp}` 键完全同口径
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

  // ─── F12 反向：地图选中本层要素 → 列表滚动到该行（扣掉 sticky 表头高）─────────
  useEffect(() => {
    if (selectedId == null) return;
    const sel = String(selectedId);
    const idx = filtered.findIndex(f => String(f.id) === sel);
    if (idx < 0) return;  // 选中的要素不属于当前打开的图层 → 不滚动
    const el = scrollRef.current;
    if (!el) return;
    const rowTop = HEAD_H + idx * ROW_H;
    const viewTop = el.scrollTop + HEAD_H;       // 表头遮住的区域不算可视
    const viewBottom = el.scrollTop + el.clientHeight;
    if (rowTop < viewTop || rowTop + ROW_H > viewBottom) {
      el.scrollTop = Math.max(0, HEAD_H + idx * ROW_H - el.clientHeight / 2 + ROW_H / 2);
    }
  }, [selectedId, filtered]);

  // ─── 可视区切片（content-Y = HEAD_H + i*ROW_H，故窗口先扣 HEAD_H）────────────
  const total = filtered.length;
  const start = Math.max(0, Math.floor((scrollTop - HEAD_H) / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop - HEAD_H + viewportH) / ROW_H) + OVERSCAN);
  const visible = filtered.slice(start, end);
  const selStr = String(selectedId);

  // ─── 标题路径（site: 运营商/类别/站型；road/lessor: 类名）────────────────────
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
    <div className="lfl-panel" role="dialog" aria-label={tFn("lfl.title")}>
      <div className="lfl-head">
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
            {/* sticky 表头 */}
            <div className="lfl-thead" style={{ width: totalW, height: HEAD_H }}>
              {cols.map(col => (
                <span key={col.key} className="lfl-th" style={{ width: col.w }}>
                  {tFn(col.labelKey as Parameters<typeof tFn>[0])}
                </span>
              ))}
            </div>
            {/* 虚拟化 body：撑高 = 行数 × 行高，行用 translateY 绝对定位 */}
            <div className="lfl-virt" style={{ height: total * ROW_H, width: totalW }}>
              {visible.map((f, i) => renderRow(f, start + i))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
