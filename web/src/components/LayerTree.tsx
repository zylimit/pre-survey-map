import { useEffect, useMemo, useRef, useState } from "react";
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

function Folder({
  title, items, hiddenIds, selectedId, expanded, onToggleExpanded,
  onPick, onToggleFeature, onSetKindVisible,
}: {
  title: string;
  items: Feature[];
  hiddenIds: Set<string>;
  selectedId: string | number | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onPick: (f: Feature) => void;
  onToggleFeature: (id: string) => void;
  onSetKindVisible: (ids: string[], visible: boolean) => void;
}) {
  const state = triState(items, hiddenIds);
  const allIds = items.map(f => String(f.id));
  const cbRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cbRef.current) cbRef.current.indeterminate = state === "partial";
  }, [state]);

  const onFolderClick = () => {
    onSetKindVisible(allIds, state !== "all"); // partial / none → 全开；all → 全关
  };

  return (
    <>
      <h3 className="folder-row" onClick={onFolderClick} title="点击全选/全关">
        <span
          className={`folder-disclose ${expanded ? "open" : "closed"}`}
          onClick={e => { e.stopPropagation(); onToggleExpanded(); }}
          title={expanded ? "折叠" : "展开"}
        >{expanded ? "−" : "+"}</span>
        <input
          ref={cbRef}
          type="checkbox"
          className="folder-cb-native"
          checked={state === "all"}
          onChange={onFolderClick}
          onClick={e => e.stopPropagation()}
          title="全选/全关"
        />
        <span className="folder-title">📂 {title}</span>
        <span className="folder-count">{formatCount(items.length)}</span>
      </h3>
      {expanded && items.length === 0 && <div className="node muted">暂无数据</div>}
      {expanded && items.map(f => {
        const id = String(f.id);
        const hidden = hiddenIds.has(id);
        const sel = id === String(selectedId);
        return (
          <div key={id} className={`node ${sel ? "selected" : ""} ${hidden ? "hidden-node" : ""}`}>
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
        );
      })}
    </>
  );
}

export default function LayerTree({
  sites, roads, lessors, selectedId, hiddenIds,
  onPick, onToggleFeature, onSetKindVisible,
  onResize, onResizeEnd,
}: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<"site" | "road" | "lessor", boolean>>({
    site: true, road: true, lessor: true,
  });
  const toggle = (k: "site" | "road" | "lessor") =>
    setExpanded(prev => ({ ...prev, [k]: !prev[k] }));

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

  return (
    <div className="tree">
      <input
        placeholder="🔍 过滤节点..."
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={{ width: "100%", padding: 6 }}
      />
      <Folder
        title="Site"
        items={filteredSites}
        hiddenIds={hiddenIds}
        selectedId={selectedId}
        expanded={expanded.site}
        onToggleExpanded={() => toggle("site")}
        onPick={onPick}
        onToggleFeature={onToggleFeature}
        onSetKindVisible={onSetKindVisible}
      />
      <Folder
        title="Road"
        items={filteredRoads}
        hiddenIds={hiddenIds}
        selectedId={selectedId}
        expanded={expanded.road}
        onToggleExpanded={() => toggle("road")}
        onPick={onPick}
        onToggleFeature={onToggleFeature}
        onSetKindVisible={onSetKindVisible}
      />
      <Folder
        title="Lessor"
        items={filteredLessors}
        hiddenIds={hiddenIds}
        selectedId={selectedId}
        expanded={expanded.lessor}
        onToggleExpanded={() => toggle("lessor")}
        onPick={onPick}
        onToggleFeature={onToggleFeature}
        onSetKindVisible={onSetKindVisible}
      />
      <ResizeHandle
        axis="x" edge="end"
        min={PANEL_LIMITS.left.min} max={PANEL_LIMITS.left.max}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
      />
    </div>
  );
}
