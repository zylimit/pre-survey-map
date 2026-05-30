import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Feature, FeatureCollection } from "../api";
import { formatCount } from "../utils";
import { PANEL_LIMITS } from "../state";
import ResizeHandle from "./ResizeHandle";

interface Props {
  sites: FeatureCollection;
  roads: FeatureCollection;
  lessors: FeatureCollection;
  selectedId: string | number | null;
  hiddenIds: Set<string>;
  onPick: (f: Feature) => void;
  onToggleFeature: (id: string) => void;
  onSetKindVisible: (ids: string[], visible: boolean) => void;
  onResize: (px: number) => void;
  onResizeEnd: () => void;
}

type Kind = "site" | "road" | "lessor";

function nameOf(f: Feature): string {
  const p = f.properties;
  if (!p) return "(未命名)";
  if (p.kind === "site") return `${p.site_id ?? "?"}${p.option ? ` / ${p.option}` : ""}`;
  if (p.kind === "road") return (p.property as string) || `road #${p.id}`;
  if (p.kind === "lessor") return (p.lessor_name as string) || `lessor ${p.fid}`;
  return "(未知)";
}

function searchMatch(f: Feature, q: string): boolean {
  if (!q) return true;
  const lower = q.toLowerCase();
  return nameOf(f).toLowerCase().includes(lower);
}

type TriState = "all" | "none" | "partial";

function triState(items: Feature[], hidden: Set<string>): TriState {
  if (items.length === 0) return "all";
  let visible = 0;
  for (const f of items) if (!hidden.has(String(f.id))) visible++;
  if (visible === 0) return "none";
  if (visible === items.length) return "all";
  return "partial";
}

// 扁平行：把「文件夹头 + 展开的节点」拍平成一维数组喂给虚拟列表
type Row =
  | { t: "folder"; kind: Kind; title: string; items: Feature[]; state: TriState; expanded: boolean }
  | { t: "empty" }
  | { t: "node"; feature: Feature };

// 固定行高虚拟化：DOM 里只保留视口可见的 ~30 行，13000 节点也丝滑
const ROW_H = 24;
const OVERSCAN = 8;

function LayerTree({
  sites, roads, lessors, selectedId, hiddenIds,
  onPick, onToggleFeature, onSetKindVisible,
  onResize, onResizeEnd,
}: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<Kind, boolean>>({
    site: true, road: true, lessor: true,
  });
  const toggle = (k: Kind) => setExpanded(prev => ({ ...prev, [k]: !prev[k] }));

  const filteredSites = useMemo(
    () => sites.features.filter(f => searchMatch(f, query)),
    [sites, query]
  );
  const filteredRoads = useMemo(
    () => roads.features.filter(f => searchMatch(f, query)),
    [roads, query]
  );
  const filteredLessors = useMemo(
    () => lessors.features.filter(f => searchMatch(f, query)),
    [lessors, query]
  );

  // 拍平成行数组。依赖 hiddenIds 仅为算文件夹三态；selectedId 不在依赖里
  // （选中只重渲可见行，不重建数组）。
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const add = (kind: Kind, title: string, items: Feature[]) => {
      out.push({ t: "folder", kind, title, items, state: triState(items, hiddenIds), expanded: expanded[kind] });
      if (expanded[kind]) {
        if (items.length === 0) out.push({ t: "empty" });
        else for (const f of items) out.push({ t: "node", feature: f });
      }
    };
    add("site", "Site", filteredSites);
    add("road", "Road", filteredRoads);
    add("lessor", "Lessor", filteredLessors);
    return out;
  }, [filteredSites, filteredRoads, filteredLessors, hiddenIds, expanded]);

  // ---- 虚拟窗口 ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 地图选中 → 树定位：虚拟列表里目标节点可能没渲染，需先展开所在文件夹，
  // 再把它滚进视口。依赖 rows：展开后 rows 重建会再次触发本 effect 完成滚动。
  useEffect(() => {
    if (selectedId == null) return;
    const sel = String(selectedId);

    const idx = rows.findIndex(r => r.t === "node" && String(r.feature.id) === sel);
    if (idx < 0) {
      // 节点不在 rows 里 = 所在文件夹折叠了，先展开（本 effect 会因 rows 变化重跑）
      let kind: Kind | null = null;
      if (filteredSites.some(f => String(f.id) === sel)) kind = "site";
      else if (filteredRoads.some(f => String(f.id) === sel)) kind = "road";
      else if (filteredLessors.some(f => String(f.id) === sel)) kind = "lessor";
      if (kind && !expanded[kind]) setExpanded(prev => ({ ...prev, [kind!]: true }));
      return;
    }

    const el = scrollRef.current;
    if (!el) return;
    const top = idx * ROW_H;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight;
    if (top < viewTop || top + ROW_H > viewBottom) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2 + ROW_H / 2);
    }
  }, [selectedId, rows, filteredSites, filteredRoads, filteredLessors, expanded]);

  const total = rows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const visible = rows.slice(start, end);
  const selStr = String(selectedId);

  const renderRow = (row: Row, index: number) => {
    const top = index * ROW_H;
    if (row.t === "folder") {
      const allIds = row.items.map(f => String(f.id));
      const onFolderClick = () => onSetKindVisible(allIds, row.state !== "all");
      return (
        <div className="tree-row" style={{ transform: `translateY(${top}px)` }} key={`f-${row.kind}`}>
          <h3 className="folder-row" onClick={onFolderClick} title="点击全选/全关">
            <span
              className={`folder-disclose ${row.expanded ? "open" : "closed"}`}
              onClick={e => { e.stopPropagation(); toggle(row.kind); }}
              title={row.expanded ? "折叠" : "展开"}
            >{row.expanded ? "−" : "+"}</span>
            <input
              type="checkbox"
              className="folder-cb-native"
              ref={el => { if (el) el.indeterminate = row.state === "partial"; }}
              checked={row.state === "all"}
              onChange={onFolderClick}
              onClick={e => e.stopPropagation()}
              title="全选/全关"
            />
            <span className="folder-title">📂 {row.title}</span>
            <span className="folder-count">{formatCount(row.items.length)}</span>
          </h3>
        </div>
      );
    }
    if (row.t === "empty") {
      return (
        <div className="tree-row" style={{ transform: `translateY(${top}px)` }} key={`e-${top}`}>
          <div className="node muted">暂无数据</div>
        </div>
      );
    }
    const f = row.feature;
    const id = String(f.id);
    const hidden = hiddenIds.has(id);
    const sel = id === selStr;
    return (
      <div className="tree-row" style={{ transform: `translateY(${top}px)` }} key={`n-${id}`}>
        <div className={`node ${sel ? "selected" : ""} ${hidden ? "hidden-node" : ""}`}>
          <input
            type="checkbox"
            checked={!hidden}
            onChange={() => onToggleFeature(id)}
            onClick={e => e.stopPropagation()}
            title={hidden ? "勾选显示" : "取消勾选隐藏"}
          />
          <span className="node-label" onClick={() => onPick(f)}>
            {nameOf(f)}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="tree">
      <div className="tree-head">
        <input
          placeholder="🔍 过滤节点..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          style={{ width: "100%", padding: 6 }}
        />
      </div>
      <div
        className="tree-scroll"
        ref={scrollRef}
        onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div className="tree-virt" style={{ height: total * ROW_H }}>
          {visible.map((row, i) => renderRow(row, start + i))}
        </div>
      </div>
      <ResizeHandle
        axis="x" edge="end"
        min={PANEL_LIMITS.left.min} max={PANEL_LIMITS.left.max}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
      />
    </div>
  );
}

export default memo(LayerTree);
