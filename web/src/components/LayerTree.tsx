/**
 * F20 Phase 3 · 固定深层图层骨架（V1.x #24）
 *
 * 树结构（写死，不随数据生长）：
 *   📁 Site
 *     📁 Globe / Smart / Dito
 *       📁 存量 / 规划 / 勘测
 *         🔺 站型图层（Macro / Micro NP / …）
 *           🎨 positive 🟢 / negative 🟡 / undetermined 🔴 / null ⚪
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
import { STATUS_COLOR, statusBucket } from "../utils";
import {
  areaVisible, categoryVisible, lessorVisible, operatorVisible, roadVisible, siteRootVisible,
  type ScopeCtx,
} from "../scopes";
import ResizeHandle from "./ResizeHandle";
import SiteShapeIcon from "./SiteShapeIcon";

// ─── 骨架定义 ────────────────────────────────────────────────────────────────

const OPERATORS = ["Globe", "Smart", "Dito"] as const;
type Op = (typeof OPERATORS)[number];

const CATEGORY_TYPES: Readonly<Record<string, readonly string[]>> = {
  "存量": ["Macro", "Micro", "IBS"],
  "规划": ["Macro NP", "Micro NP"],
  "勘测": ["Macro-ongoing", "Micro-ongoing"],
};
const CATEGORIES = ["存量", "规划", "勘测"] as const;

const SITE_STATUSES = ["positive", "negative", "undetermined"] as const;

// 🎨 样式圆点色统一引用 utils.STATUS_COLOR（单一真源，与 MapView/LayerFeatureList 同源）

// #29→#37：🔺 图层节点图标已改自绘 SVG（SiteShapeIcon），形状读 utils.siteShape，
// 颜色 currentColor 继承灰。原 Unicode 字符映射（LAYER_ICON/iconFor）已移除。

// ─── 辅助 ────────────────────────────────────────────────────────────────────

type TriState = "all" | "none" | "partial";

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  sites: FeatureCollection;
  roads: FeatureCollection;
  lessors: FeatureCollection;
  areas: FeatureCollection;  // #51：AREA 面图层（运营商下）
  selectedId: string | number | null;
  hiddenIds: Set<string>;
  onSetKindVisible: (ids: string[], visible: boolean) => void;
  onImportLayer: (file: File, stamp: LayerStamp) => void;
  onViewLayer: (target: ViewLayerTarget, anchor: { x: number; y: number }) => void;
  phase: Phase;
  onResize: (px: number) => void;
  onResizeEnd: () => void;
  // #50 Phase 15：数据权限（无权限文件夹/图层/样式节点不渲染）+ 功能权限（import 门控）
  scopes: string[];
  isAdmin: boolean;
  canImport: boolean;
}

// ─── 组件 ────────────────────────────────────────────────────────────────────

function LayerTree({
  sites, roads, lessors, areas,
  selectedId, hiddenIds,
  onSetKindVisible, onImportLayer, onViewLayer, phase,
  onResize, onResizeEnd,
  scopes, isAdmin, canImport,
}: Props) {
  const tFn = useT();
  const busy = phase !== "idle";

  // #50 Phase 15：scope 判定上下文（不可见节点的子树整棵不渲染，计数与可见性一致）
  const scopeCtx: ScopeCtx = useMemo(() => ({ isAdmin, scopes }), [isAdmin, scopes]);

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

  const { siteMap, allRoadIds, lessorMap, areaMap } = useMemo(() => {
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
      // #37 小写化 + #41 归桶：三标准状态取原值，其余统一 "other"（空值/pending 都进 other）
      const st  = statusBucket(p.site_status);
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

    // #51：AREA 面按运营商分桶（key = `area/<op>`，文件夹与该面图层共用同一组 id）
    const areaMap = new Map<string, string[]>();
    for (const f of areas.features) {
      const id = String(f.id);
      const op = String((f.properties ?? {}).operator ?? "");
      const key = `area/${op}`;
      if (!areaMap.has(key)) areaMap.set(key, []);
      areaMap.get(key)!.push(id);
    }

    return { siteMap, allRoadIds, lessorMap, areaMap };
  }, [sites, roads, lessors, areas]);

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
      // #37/#41：与 siteMap 分组同口径（归桶）
      const st  = statusBucket(p.site_status);
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

    // #51：area 面 → 反向定位运营商下 AREA 图层（展开 site/op/AREA 文件夹三级）
    const area = areas.features.find(f => String(f.id) === sel);
    if (area) {
      const op = String((area.properties ?? {}).operator ?? "");
      setHighlightedKey(`area/${op}/AREA`);
      setExpanded(prev => ({ ...prev, site: true, [op]: true, [`area/${op}`]: true }));
      return;
    }

    setHighlightedKey(null);
  }, [selectedId, sites, roads, lessors, areas]);

  // ─── 渲染辅助：checkbox（支持三态 indeterminate）─────────────────────────────

  const CB = ({
    ids, label,
  }: { ids: string[]; label?: string }) => {
    const ts = triOf(ids);
    const empty = ids.length === 0;   // #44 后：0 要素节点无可显隐 → checkbox 灰禁用
    return (
      <input
        type="checkbox"
        className="folder-cb-native"
        ref={el => { if (el) el.indeterminate = !empty && ts === "partial"; }}
        checked={!empty && ts === "all"}
        disabled={empty}
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
        : nodeKey.startsWith("area/")
          ? (areaMap.get(nodeKey) ?? [])
          // 运营商节点（Globe/Smart/Dito）：site ids + area ids 并集。
          // 本机库运营商可能全无 site（如 Globe 只有 area 面），只算 site 会让计数显 0、
          // checkbox 被禁；并入 area 后计数正确、可勾选、勾选联动 site+area 子层可见性。
          : (OPERATORS as readonly string[]).includes(nodeKey)
            ? [...(siteMap.get(nodeKey) ?? []), ...(areaMap.get(`area/${nodeKey}`) ?? [])]
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
    highlighted = false, hasChildren = true,
  }: {
    nodeKey: string;
    label: string;
    depth?: number;
    stamp: LayerStamp;
    ids: string[];
    highlighted?: boolean;
    // 有无样式子节点（#44）：勘测 site 图层 + Road/Lessor=有；存量/规划 site 图层=无（叶子）
    hasChildren?: boolean;
  }) => {
    const open = isOpen(nodeKey);
    const cnt = ids.length;
    return (
      <div
        className={`layer-row${highlighted ? " node-highlighted" : ""}`}
        style={{ paddingLeft: 4 + depth * 16 }}
      >
        {/* #36 Chevron 可展开；存量/规划图层无样式子节点 → leaf-spacer 占位无箭头（对齐不变）*/}
        {hasChildren ? (
          <span
            className={`folder-disclose ${open ? "open" : "closed"}`}
            onClick={() => toggleOpen(nodeKey)}
            title={open ? tFn("lt.folder.collapse") : tFn("lt.folder.expand")}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        ) : (
          <span className="folder-disclose leaf-spacer" aria-hidden="true" />
        )}
        <CB ids={ids} />
        {/* #37：站型自绘 SVG（替代 #29 Unicode 字符），居中在 #36 的 16px 列 */}
        <span className="node-type-icon"><SiteShapeIcon stamp={stamp} size={14} /></span>
        {/* #27-2：两按钮紧跟文字后，默认隐藏，hover 行才显示（CSS）；计数靠右 */}
        <span className="folder-title layer-label">{label}</span>
        <div className="layer-actions">
          {/* #32：两按钮改纯 lucide 图标，文字进 title/aria-label；
              #50 Phase 15：无 import 权限 → [导入图层] 不渲染 */}
          {canImport && (
            <button
              className="layer-btn layer-btn-icon"
              disabled={busy}
              onClick={() => openPicker(stamp)}
              title={tFn("lt.btn.import_layer.tip")}
              aria-label={tFn("lt.btn.import_layer")}
            >
              <Download size={14} strokeWidth={1.8} />
            </button>
          )}
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
    highlighted = false, viewStatus,
  }: {
    nodeKey: string;
    label: string;
    color: string;
    ids: string[];
    depth?: number;
    highlighted?: boolean;
    // #40：site 样式节点带此项 → 渲染 [查看] 眼睛（按 status 筛选）；road/lessor 不传 → 无按钮
    viewStatus?: { op: string; cat: string; tp: string; st: string };
  }) => {
    // #33：🎨 样式节点是图层固定子骨架，0 计数也显示（不再 null-return）。
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
          ref={el => { if (el) el.indeterminate = ids.length > 0 && ts === "partial"; }}
          checked={ids.length > 0 && ts === "all"}
          disabled={ids.length === 0}
          onChange={() => toggleIds(ids)}
          onClick={e => e.stopPropagation()}
        />
        <span className="node-type-icon">
          <span className="style-dot" style={{ background: color }} />
        </span>
        <span className="style-label">{label}</span>
        {/* #40：site 样式节点 [查看]（无导入），按 status 筛选；默认隐藏 hover 行显示 */}
        {viewStatus && (
          <div className="layer-actions">
            <button
              className="layer-btn layer-btn-view layer-btn-icon"
              disabled={ids.length === 0}
              onClick={e => {
                const r = e.currentTarget.getBoundingClientRect();
                onViewLayer({
                  kind: "site",
                  operator: viewStatus.op,
                  category: viewStatus.cat,
                  type: viewStatus.tp,
                  status: viewStatus.st,
                }, { x: r.right, y: r.bottom });
              }}
              title={tFn("lt.btn.view_features.tip")}
              aria-label={tFn("lt.btn.view_features")}
            >
              <Eye size={14} strokeWidth={1.8} />
            </button>
          </div>
        )}
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

        {/* ══ 📁 Site ══（#50 Phase 15：无 site 系 scope → 整棵不渲染） */}
        {siteRootVisible(scopeCtx) && (
          <>
        <FolderRow nodeKey="site" label={tFn("lt.tree.site")} depth={0} />

        {isOpen("site") && OPERATORS.map(op => {
          // #50 Phase 15：无权限运营商子树整棵不渲染
          if (!operatorVisible(scopeCtx, op)) return null;
          const opKey = op;
          // i18n key: "lt.tree.op.Globe" etc.（#36：📁 抽成独立 Folder 图标列，文字去前缀）
          const opLabel = tFn(`lt.tree.op.${op}` as Parameters<typeof tFn>[0]);

          return (
            <div key={op}>
              {/* 📁 Operator */}
              <FolderRow nodeKey={opKey} label={opLabel} depth={1} />

              {isOpen(opKey) && (
                <>
                {/* ══ #51 F23：📁 AREA → 🔺 AREA 面图层（与类别并列，无样式子层）。
                    权限：areaVisible（site / site:<op> / site:<op>:AREA 授予）══ */}
                {areaVisible(scopeCtx, op) && (
                  <div>
                    <FolderRow nodeKey={`area/${op}`} label={tFn("lt.tree.area")} depth={2} />
                    {isOpen(`area/${op}`) && (
                      <LayerRow
                        nodeKey={`area/${op}/AREA`}
                        label={tFn("lt.tree.area")}
                        depth={3}
                        stamp={{ operator: op, target_kind: "area" }}
                        ids={areaMap.get(`area/${op}`) ?? []}
                        highlighted={hl === `area/${op}/AREA`}
                        hasChildren={false}
                      />
                    )}
                  </div>
                )}
                {CATEGORIES.map(cat => {
                // #50 Phase 15：无权限类别子树整棵不渲染（图层/样式随子树消失）
                if (!categoryVisible(scopeCtx, op, cat)) return null;
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
                            hasChildren={cat === "勘测"}
                          />

                          {/* #44：样式节点仅勘测类显示（存量/规划展开后无 🎨）。
                              恢复 = 去掉 `&& cat === "勘测"` 即可，零成本。siteMap 归类不动。 */}
                          {isOpen(layerKey) && cat === "勘测" && (
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
                                    viewStatus={{ op, cat, tp, st }}
                                  />
                                );
                              })}
                              {/* #41：Other 节点收纳非三标准状态（空值/pending/未知）——有才显示、灰 */}
                              {(() => {
                                const otherKey = `${layerKey}/other`;
                                const otherIds = siteMap.get(otherKey) ?? [];
                                return otherIds.length > 0 ? (
                                  <StyleRow
                                    nodeKey={otherKey}
                                    label={tFn("lt.tree.status.other")}
                                    color={STATUS_COLOR[""]}
                                    ids={otherIds}
                                    depth={4}
                                    highlighted={hl === otherKey}
                                    viewStatus={{ op, cat, tp, st: "other" }}
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
                </>
              )}
            </div>
          );
        })}
          </>
        )}

        {/* ══ 🔺 Road ══（#50 Phase 15：无 road scope → 整层不渲染） */}
        {roadVisible(scopeCtx) && (
          <>
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
          </>
        )}

        {/* ══ 🔺 Lessor ══（#50 Phase 15：无 lessor scope → 整层不渲染） */}
        {lessorVisible(scopeCtx) && (
          <>
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
          </>
        )}

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
