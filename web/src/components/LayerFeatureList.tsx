/**
 * F20 Phase 4 · 查看图层要素 —— 浮动列表框（V1.x #24）
 *
 * - 浮动面板（floating panel，非 modal，可关闭，不挡地图交互）
 * - 数据 = 前端 filter 现有 FeatureCollection，与 Phase 3 树计数同源
 *   （site 按 operator/category/type 三列，road/lessor 整层）→ 行数 == 树节点计数
 * - 本版只读（无编辑/删除）
 * - 本层筛选框（精确叫「筛选」，只在本层子集内按显示名收窄；≠ F16 全局搜索）
 * - 点击行 → 复用 F12（onPick = s.flyTo）：地图飞到 + 高亮 + 属性面板
 * - 虚拟化：沿用 LayerTree #16 的零依赖固定行高范式（ROW_H/OVERSCAN/translateY）
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Feature, FeatureCollection } from "../api";
import type { ViewLayerTarget } from "../state";
import { useT } from "../i18n";
import { nameOf, STATUS_COLOR } from "../utils";

// ─── 虚拟化常量（沿用 #16 范式）────────────────────────────────────────────────
const ROW_H = 30;
const OVERSCAN = 8;

// 圆点色统一引用 utils.STATUS_COLOR（单一真源，与 MapView/LayerTree 同源）

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

  // ─── F12 反向：地图选中本层要素 → 列表滚动到该行 ─────────────────────────────
  useEffect(() => {
    if (selectedId == null) return;
    const sel = String(selectedId);
    const idx = filtered.findIndex(f => String(f.id) === sel);
    if (idx < 0) return;  // 选中的要素不属于当前打开的图层 → 不滚动
    const el = scrollRef.current;
    if (!el) return;
    const top = idx * ROW_H;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight;
    if (top < viewTop || top + ROW_H > viewBottom) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2 + ROW_H / 2);
    }
  }, [selectedId, filtered]);

  // ─── 可视区切片 ──────────────────────────────────────────────────────────────
  const total = filtered.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
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

  // ─── 单行渲染 ────────────────────────────────────────────────────────────────
  const renderRow = (f: Feature, index: number) => {
    const id = String(f.id);
    const p = f.properties ?? {};
    const sel = id === selStr;
    let dotKey = "";
    let secondary = "";
    if (target.kind === "site") {
      dotKey = String(p.site_status ?? "");
      secondary = dotKey ? tFn(`lt.tree.status.${dotKey}` as Parameters<typeof tFn>[0]) : tFn("lt.tree.status.null");
    } else if (target.kind === "road") {
      dotKey = "road";
    } else {
      const rel = String(p.relationship ?? "");
      dotKey = rel;
      secondary = rel ? tFn(`lt.tree.status.${rel.toLowerCase()}` as Parameters<typeof tFn>[0]) : "";
    }
    const color = STATUS_COLOR[dotKey] ?? STATUS_COLOR[""];
    return (
      <div
        key={id}
        className={`lfl-row${sel ? " selected" : ""}`}
        style={{ transform: `translateY(${index * ROW_H}px)`, height: ROW_H }}
        onClick={() => onPick(f)}
        title={nameOf(f)}
      >
        <span className="lfl-dot" style={{ background: color }} />
        <span className="lfl-name">{nameOf(f)}</span>
        {secondary && <span className="lfl-secondary">{secondary}</span>}
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
          <div className="lfl-virt" style={{ height: total * ROW_H }}>
            {visible.map((f, i) => renderRow(f, start + i))}
          </div>
        </div>
      )}
    </div>
  );
}
