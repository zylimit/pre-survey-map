/**
 * F20 Phase 3 · 固定深层图层骨架（V1.x #24）
 *
 * 树结构（写死，不随数据生长）：
 *   📁 Site
 *     📁 Globe / Smart / Dito
 *       📁 存量 / 规划 / 勘测
 *         🔺 站型图层（Macro / Micro NP / …）
 *           🎨 positive 🟢 / negative 🟡 / undermine 🔴 / null ⚪
 *   🔺 Road
 *     🎨 🟫
 *   🔺 Lessor
 *     🎨 Unfriendly 🔴 / Normal 🟡
 *
 * 去虚拟化：节点 ~100，直接 DOM 渲染，不需固定行高虚拟列表。
 * 去顶部搜索框：固定骨架无需搜索（检索由 Phase 4 列表框 + F16 全局搜索承担）。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { FeatureCollection, LayerStamp } from "../api";
import { PANEL_LIMITS } from "../state";
import type { Phase, ViewLayerTarget } from "../state";
import { ChevronRight, ChevronDown, Folder, FolderOpen, Download, Eye } from "lucide-react";
import { useT } from "../i18n";
import { STATUS_COLOR } from "../utils";
import ResizeHandle from "./ResizeHandle";

// ─── 骨架定义 ────────────────────────────────────────────────────────────────

const OPERATORS = ["Globe", "Smart", "Dito"] as const;
type Op = (typeof OPERATORS)[number];

const CATEGORY_TYPES: Readonly<Record<string, readonly string[]>> = {
  "存量": ["Macro", "Micro", "IBS"],
  "规划": ["Macro NP", "Micro NP"],
  "勘测": ["Macro-ongoing", "Micro-ongoing"],
};
const CATEGORIES = ["存量", "规划", "勘测"] as const;

const SITE_STATUSES = ["positive", "negative", "undermine"] as const;

// 🎨 样式圆点色统一引用 utils.STATUS_COLOR（单一真源，与 MapView/LayerFeatureList 同源）

// #29：🔺 图层节点图标按站型形状渲染（统一灰色，状态分色仍在下面 🎨 样式节点）。
// 实心字符 ▲●■◆ = 存量/勘测实心，空心字符 △○◇ = 规划空心——天然对应地图渲染口径。
const LAYER_ICON: Record<string, string> = {
  Macro: "▲", Micro: "●", IBS: "■",
  "Macro NP": "△", "Micro NP": "○",
  "Macro-ongoing": "◆", "Micro-ongoing": "◇",
};
function iconFor(stamp: LayerStamp): string {
  if (stamp.target_kind === "road") return "▬";    // 线形
  if (stamp.target_kind === "lessor") return "◼";  // 面形
  return LAYER_ICON[stamp.type ?? ""] ?? "▲";       // 站型缺失/未知 → 退化实心三角
}

// ─── 辅助 ────────────────────────────────────────────────────────────────────

type TriState = "all" | "none" | "partial";

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  sites: FeatureCollection;
  roads: FeatureCollection;
  lessors: FeatureCollection;
  selectedId: string | number | null;
  hiddenIds: Set<string>;
  onSetKindVisible: (ids: string[], visible: boolean) => void;
  onImportLayer: (file: File, stamp: LayerStamp) => void;
  onViewLayer: (target: ViewLayerTarget, anchor: { x: number; y: number }) => void;
  phase: Phase;
  onResize: (px: number) => void;
  onResizeEnd: () => void;
}

// ─── 组件 ────────────────────────────────────────────────────────────────────

function LayerTree({
  sites, roads, lessors,
  selectedId, hiddenIds,
  onSetKindVisible, onImportLayer, onViewLayer, phase,
  onResize, onResizeEnd,
}: Props) {
  const tFn = useT();
  const busy = phase !== "idle";

  // 展开状态：flat key→bool（默认：Site 根 + Road + Lessor 展开；Operator 折叠）
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    site: true,
    road: true,
    lessor: true,
  });
  const isOpen = (k: string) => !!expanded[k];
  const toggleOpen = (k: string) =>
    setExpanded(prev => ({ ...prev, [k]: !prev[k] }));

  // 高亮键：F12 反向定位时设置，指向 🎨 或 🔺 节点
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);

  // ─── O(n) 建立 key→featureId[] 映射 ────────────────────────────────────────

  const { siteMap, allRoadIds, lessorMap } = useMemo(() => {
    const siteMap = new Map<string, string[]>();

    const push = (key: string, id: string) => {
      if (!siteMap.has(key)) siteMap.set(key, []);
      siteMap.get(key)!.push(id);
    };

    for (const f of sites.features) {
      const id = String(f.id);
      const p = f.properties ?? {};
      const op  = String(p.operator  ?? "");
      const cat = String(p.category  ?? "");
      const tp  = String(p.type      ?? "");
      const st  = String(p.site_status ?? "");
      push("site",                      id);
      push(op,                          id);
      push(`${op}/${cat}`,              id);
      push(`${op}/${cat}/${tp}`,        id);
      push(`${op}/${cat}/${tp}/${st}`,  id);
    }

    const allRoadIds = roads.features.map(f => String(f.id));

    const lessorMap = new Map<string, string[]>();
    const pushL = (key: string, id: string) => {
      if (!lessorMap.has(key)) lessorMap.set(key, []);
      lessorMap.get(key)!.push(id);
    };
    for (const f of lessors.features) {
      const id  = String(f.id);
      const rel = String((f.properties ?? {}).relationship ?? "");
      pushL("lessor",        id);
      pushL(`lessor/${rel}`, id);
    }

    return { siteMap, allRoadIds, lessorMap };
  }, [sites, roads, lessors]);

  // ─── tristate ───────────────────────────────────────────────────────────────

  const triOf = useCallback((ids: string[]): TriState => {
    if (!ids.length) return "all";
    let vis = 0;
    for (const id of ids) if (!hiddenIds.has(id)) vis++;
    if (vis === 0) return "none";
    if (vis === ids.length) return "all";
    return "partial";
  }, [hiddenIds]);

  const toggleIds = useCallback((ids: string[]) => {
    const ts = triOf(ids);
    onSetKindVisible(ids, ts === "none");  // none→全显；all/partial→全隐
  }, [triOf, onSetKindVisible]);

  // ─── 文件选择（隐藏 input，共享 ref）────────────────────────────────────────

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingStamp = useRef<LayerStamp | null>(null);

  const openPicker = (stamp: LayerStamp) => {
    if (busy) return;
    pendingStamp.current = stamp;
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && pendingStamp.current) onImportLayer(file, pendingStamp.current);
    pendingStamp.current = null;
    e.target.value = "";
  };

  // ─── F12 地图→树反向定位 ────────────────────────────────────────────────────

  useEffect(() => {
    if (selectedId == null) { setHighlightedKey(null); return; }
    const sel = String(selectedId);

    const site = sites.features.find(f => String(f.id) === sel);
    if (site) {
      const p  = site.properties ?? {};
      const op  = String(p.operator    ?? "");
      const cat = String(p.category   ?? "");
      const tp  = String(p.type       ?? "");
      const st  = String(p.site_status ?? "");
      setHighlightedKey(`${op}/${cat}/${tp}/${st}`);
      setExpanded(prev => ({
        ...prev,
        site: true,
        [op]: true,
        [`${op}/${cat}`]: true,
        [`${op}/${cat}/${tp}`]: true,
      }));
      return;
    }

    if (roads.features.some(f => String(f.id) === sel)) {
      setHighlightedKey("road/__style__");
      setExpanded(prev => ({ ...prev, road: true }));
      return;
    }

    const lessor = lessors.features.find(f => String(f.id) === sel);
    if (lessor) {
      const rel = String((lessor.properties ?? {}).relationship ?? "");
      setHighlightedKey(`lessor/${rel}`);
      setExpanded(prev => ({ ...prev, lessor: true }));
      return;
    }

    setHighlightedKey(null);
  }, [selectedId, sites, roads, lessors]);

  // ─── 渲染辅助：checkbox（支持三态 indeterminate）─────────────────────────────

  const CB = ({
    ids, label,
  }: { ids: string[]; label?: string }) => {
    const ts = triOf(ids);
    return (
      <input
        type="checkbox"
        className="folder-cb-native"
        ref={el => { if (el) el.indeterminate = ts === "partial"; }}
        checked={ts === "all"}
        onChange={() => toggleIds(ids)}
        onClick={e => e.stopPropagation()}
        title={label}
      />
    );
  };

  // ─── 渲染：📁 文件夹行 ───────────────────────────────────────────────────────

  const FolderRow = ({
    nodeKey, label, depth = 0,
  }: { nodeKey: string; label: string; depth?: number }) => {
    const ids = nodeKey === "site"
      ? (siteMap.get("site") ?? [])
      : nodeKey.startsWith("lessor")
        ? (lessorMap.get(nodeKey) ?? [])
        : (siteMap.get(nodeKey) ?? []);
    const open = isOpen(nodeKey);
    return (
      <h3
        className="folder-row"
        style={{ paddingLeft: 4 + depth * 16 }}
        onClick={() => { toggleIds(ids); }}
        title={tFn("lt.folder.toggle.tip")}
      >
        {/* #36：展开符=lucide Chevron（去小方块边框）；类型图标=lucide Folder 独立列 */}
        <span
          className={`folder-disclose ${open ? "open" : "closed"}`}
          onClick={e => { e.stopPropagation(); toggleOpen(nodeKey); }}
          title={open ? tFn("lt.folder.collapse") : tFn("lt.folder.expand")}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <CB ids={ids} />
        <span className="node-type-icon">
          {open ? <FolderOpen size={14} /> : <Folder size={14} />}
        </span>
        <span className="folder-title">{label}</span>
        {/* #35：运营商/类别节点显子树要素总数（Site 根不显）；folder-title flex:1 推 count 靠右 */}
        {nodeKey !== "site" && <span className="folder-count">{ids.length}</span>}
      </h3>
    );
  };

  // ─── 渲染：🔺 图层行 ─────────────────────────────────────────────────────────

  const LayerRow = ({
    nodeKey, label, depth = 0, stamp, ids,
    highlighted = false,
  }: {
    nodeKey: string;
    label: string;
    depth?: number;
    stamp: LayerStamp;
    ids: string[];
    highlighted?: boolean;
  }) => {
    const open = isOpen(nodeKey);
    const cnt = ids.length;
    return (
      <div
        className={`layer-row${highlighted ? " node-highlighted" : ""}`}
        style={{ paddingLeft: 4 + depth * 16 }}
      >
        {/* #33：图层永远可展开（有样式骨架）；#36：展开符=lucide Chevron */}
        <span
          className={`folder-disclose ${open ? "open" : "closed"}`}
          onClick={() => toggleOpen(nodeKey)}
          title={open ? tFn("lt.folder.collapse") : tFn("lt.folder.expand")}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <CB ids={ids} />
        {/* #29 站型字符 #36 移入统一 node-type-icon 列（16px 居中灰） */}
        <span className="node-type-icon">{iconFor(stamp)}</span>
        {/* #27-2：两按钮紧跟文字后，默认隐藏，hover 行才显示（CSS）；计数靠右 */}
        <span className="folder-title layer-label">{label}</span>
        <div className="layer-actions">
          {/* #32：两按钮改纯 lucide 图标，文字进 title/aria-label */}
          <button
            className="layer-btn layer-btn-icon"
            disabled={busy}
            onClick={() => openPicker(stamp)}
            title={tFn("lt.btn.import_layer.tip")}
            aria-label={tFn("lt.btn.import_layer")}
          >
            <Download size={14} strokeWidth={1.8} />
          </button>
          <button
            className="layer-btn layer-btn-view layer-btn-icon"
            disabled={busy || cnt === 0}
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect();
              onViewLayer({
                kind: stamp.target_kind,
                operator: stamp.operator ?? null,
                category: stamp.category ?? null,
                type: stamp.type ?? null,
              }, { x: r.right, y: r.bottom });
            }}
            title={tFn("lt.btn.view_features.tip")}
            aria-label={tFn("lt.btn.view_features")}
          >
            <Eye size={14} strokeWidth={1.8} />
          </button>
        </div>
        <span className="folder-count layer-count">{cnt}</span>
      </div>
    );
  };

  // ─── 渲染：🎨 样式行 ─────────────────────────────────────────────────────────

  const StyleRow = ({
    nodeKey, label, color, ids, depth = 0,
    highlighted = false,
  }: {
    nodeKey: string;
    label: string;
    color: string;
    ids: string[];
    depth?: number;
    highlighted?: boolean;
  }) => {
    // #33：🎨 样式节点是图层固定子骨架，0 计数也显示（不再 null-return）。
    // 「未分类」灰色节点的「有才显示」由调用处单独包条件控制。
    const ts = triOf(ids);
    return (
      <div
        className={`style-row${highlighted ? " node-highlighted" : ""}`}
        style={{ paddingLeft: 4 + depth * 16 }}
      >
        {/* #36：叶子行补展开符空占位，叶子 checkbox 才对齐到比父右移一级（修"跑前面"）*/}
        <span className="folder-disclose leaf-spacer" aria-hidden="true" />
        <input
          type="checkbox"
          className="folder-cb-native"
          ref={el => { if (el) el.indeterminate = ts === "partial"; }}
          checked={ts === "all"}
          onChange={() => toggleIds(ids)}
          onClick={e => e.stopPropagation()}
        />
        <span className="node-type-icon">
          <span className="style-dot" style={{ background: color }} />
        </span>
        <span className="style-label">{label}</span>
        <span className="folder-count">{ids.length}</span>
      </div>
    );
  };

  // ─── 主体渲染 ────────────────────────────────────────────────────────────────

  const hl = highlightedKey;

  return (
    <div className="tree">
      <input
        ref={fileInputRef}
        type="file"
        accept=".kml,.kmz,.xlsx"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
      <div className="tree-scroll">

        {/* ══ 📁 Site ══ */}
        <FolderRow nodeKey="site" label={tFn("lt.tree.site")} depth={0} />

        {isOpen("site") && OPERATORS.map(op => {
          const opKey = op;
          const opIds = siteMap.get(opKey) ?? [];
          // i18n key: "lt.tree.op.Globe" etc.（#36：📁 抽成独立 Folder 图标列，文字去前缀）
          const opLabel = tFn(`lt.tree.op.${op}` as Parameters<typeof tFn>[0]);

          return (
            <div key={op}>
              {/* 📁 Operator */}
              <FolderRow nodeKey={opKey} label={opLabel} depth={1} />

              {isOpen(opKey) && CATEGORIES.map(cat => {
                const catKey = `${op}/${cat}`;
                const catIds = siteMap.get(catKey) ?? [];
                const catLabelKey = cat === "存量" ? "lt.tree.cat.legacy"
                  : cat === "规划" ? "lt.tree.cat.planned"
                  : "lt.tree.cat.survey";
                const catLabel = tFn(catLabelKey);

                return (
                  <div key={cat}>
                    {/* 📁 Category */}
                    <FolderRow nodeKey={catKey} label={catLabel} depth={2} />

                    {isOpen(catKey) && CATEGORY_TYPES[cat].map(tp => {
                      const layerKey = `${op}/${cat}/${tp}`;
                      const layerIds = siteMap.get(layerKey) ?? [];
                      const stamp: LayerStamp = {
                        operator: op, category: cat, type: tp, target_kind: "site",
                      };

                      return (
                        <div key={tp}>
                          {/* 🔺 Layer */}
                          <LayerRow
                            nodeKey={layerKey}
                            label={tp}
                            depth={3}
                            stamp={stamp}
                            ids={layerIds}
                            highlighted={hl !== null && (
                              hl === layerKey || hl.startsWith(layerKey + "/")
                            )}
                          />

                          {isOpen(layerKey) && (
                            <>
                              {SITE_STATUSES.map(st => {
                                const stKey = `${layerKey}/${st}`;
                                const stIds = siteMap.get(stKey) ?? [];
                                const stLabel = tFn(`lt.tree.status.${st}` as Parameters<typeof tFn>[0]);
                                return (
                                  <StyleRow
                                    key={st}
                                    nodeKey={stKey}
                                    label={stLabel}
                                    color={STATUS_COLOR[st]}
                                    ids={stIds}
                                    depth={4}
                                    highlighted={hl === stKey}
                                  />
                                );
                              })}
                              {/* #33：灰色「未分类」例外——仅当有空值点时显示
                                  （其余 pos/neg/und 已是固定骨架，0 计数也显示）*/}
                              {(() => {
                                const nullKey = `${layerKey}/`;
                                const nullIds = siteMap.get(nullKey) ?? [];
                                return nullIds.length > 0 ? (
                                  <StyleRow
                                    nodeKey={nullKey}
                                    label={tFn("lt.tree.status.null")}
                                    color={STATUS_COLOR[""]}
                                    ids={nullIds}
                                    depth={4}
                                    highlighted={hl === nullKey}
                                  />
                                ) : null;
                              })()}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* ══ 🔺 Road ══ */}
        <LayerRow
          nodeKey="road"
          label={tFn("lt.tree.road")}
          depth={0}
          stamp={{ target_kind: "road" }}
          ids={allRoadIds}
          highlighted={hl === "road" || hl === "road/__style__"}
        />
        {isOpen("road") && (
          <StyleRow
            nodeKey="road/__style__"
            label={tFn("lt.tree.status.road")}
            color={STATUS_COLOR["road"]}
            ids={allRoadIds}
            depth={1}
            highlighted={hl === "road/__style__"}
          />
        )}

        {/* ══ 🔺 Lessor ══ */}
        <LayerRow
          nodeKey="lessor"
          label={tFn("lt.tree.lessor")}
          depth={0}
          stamp={{ target_kind: "lessor" }}
          ids={lessorMap.get("lessor") ?? []}
          highlighted={hl !== null && hl.startsWith("lessor/")}
        />
        {isOpen("lessor") && (["Unfriendly", "Normal"] as const).map(rel => {
          const relKey = `lessor/${rel}`;
          const relIds = lessorMap.get(relKey) ?? [];
          const relLabel = tFn(`lt.tree.status.${rel.toLowerCase()}` as Parameters<typeof tFn>[0]);
          return (
            <StyleRow
              key={rel}
              nodeKey={relKey}
              label={relLabel}
              color={STATUS_COLOR[rel]}
              ids={relIds}
              depth={1}
              highlighted={hl === relKey}
            />
          );
        })}

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
