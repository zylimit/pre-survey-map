import { useCallback, useRef, useState } from "react";
import { getLang, t } from "./i18n";
import {
  backToCleaning,
  BaselineRegion,
  BaselineState,
  cancelImport,
  CleaningAction,
  CleaningRow,
  clearBaseline,
  commitImport,
  fetchImportProgress,
  ImportProgress,
  ConflictRow,
  Decision,
  downloadConflictsXlsx,
  exportAll,
  exportSelection,
  exportSelectionIds,
  deleteSites,
  undoDelete,
  updateSite,
  Feature,
  FeatureCollection,
  fetchAll,
  fetchBaselineState,
  GeoJSONPolygon,
  LayerStamp,
  Phase1Summary,
  proceedToConflicts,
  SiteKey,
  SitePatch,
  uploadFile,
} from "./api";
import { nameOf } from "./utils";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

// Spec F1：单文件上限 100MB（前端拦截 + 后端 413 + nginx client_max_body_size 三层）
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FILE_MB = 100;

function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  msg: string;
}

// F16 全局搜索结果：Output 内独立 state，不进 50 条日志数组
export interface SearchResults {
  query: string;
  total: number;       // 命中总数（封顶前）
  results: Feature[];  // 实际渲染列表，封顶 200 条
}

// 结果封顶：超出只提示不全量渲染（与 #16 虚拟化精神一致，防卡）
const SEARCH_CAP = 200;

// Spec F11/12：导入阶段进度条 + 向导步骤
export type Phase =
  | "idle"
  | "loading"         // 初始/刷新数据加载中
  | "uploading"
  | "cleaning"        // 步骤 1 等待用户决策
  | "conflicts"       // 步骤 2 等待用户决策
  | "committing"
  | "exporting";

// F9 框选模式（#47 增 circle 圆形选区）
export type DrawMode = "polygon" | "rectangle" | "circle" | null;

// export_region 审计 mode 取值（Spec line 708）。与 DrawMode 映射：rectangle→rect，其余同名。
export type SelectionMode = "polygon" | "rect" | "circle";

// F20 Phase 4：「查看图层要素」浮动列表框的目标图层标识
// 与 Phase 3 树计数同源——site 按 operator/category/type 三列过滤，road/lessor 整层。
export interface ViewLayerTarget {
  kind: "site" | "road" | "lessor";
  operator: string | null;  // site only
  category: string | null;  // site only
  type: string | null;      // site only
  status?: string;          // #40：site 样式节点 [查看] 时按 status 收窄（positive/.../other）
}

// #34：两个图层目标是否同一层（toggle 判定）。road/lessor 的 op/cat/type 均 null，
// null===null 成立，安全。
function sameTarget(a: ViewLayerTarget, b: ViewLayerTarget): boolean {
  return a.kind === b.kind && a.operator === b.operator
    && a.category === b.category && a.type === b.type
    && a.status === b.status;  // #40：同图层不同 status 的 [查看] 视为不同窗（toggle 不误判）
}

// F20 #30：列表框=可拖可缩浮动窗口。单 state 复用——首次开窗用 anchor（触发按钮坐标）
// 定位；已开时切图层只换 target、anchor 仅在组件首次挂载读取，位置尺寸不动。
export interface ViewLayerState {
  target: ViewLayerTarget;
  anchor: { x: number; y: number } | null;  // 触发按钮的右下角视口坐标
}

// 三面板缩放（Spec V1.x #11）
export type PanelKey = "left" | "right" | "bottom";

export const PANEL_LIMITS: Record<PanelKey, { min: number; max: number }> = {
  left: { min: 200, max: 500 },
  right: { min: 240, max: 600 },
  bottom: { min: 120, max: 500 },
};

const PANEL_LS_KEY: Record<PanelKey, string> = {
  left: "presurvey.panel.left",
  right: "presurvey.panel.right",
  bottom: "presurvey.panel.bottom",
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function readPanelSize(key: PanelKey): number | null {
  try {
    const v = localStorage.getItem(PANEL_LS_KEY[key]);
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const { min, max } = PANEL_LIMITS[key];
    return clamp(n, min, max);
  } catch {
    return null;
  }
}

// Spec #12 两步向导：缓存清洗 / 冲突两个阶段的 state
export interface ImportSession {
  sessionId: string;
  fileName: string;
  // 步骤 1
  cleanings: CleaningRow[];
  cleaningDecisions: Record<string, CleaningAction>;
  baselineRegion: BaselineRegion | null;
  phase1Summary: Phase1Summary;
  warnAllOutsideBaseline: boolean;  // Spec #15 雷 29
  // 步骤 2（proceed-to-conflicts 后填）
  conflicts: ConflictRow[];
  conflictDecisions: Record<string, Decision>;
  // 当前在哪一步
  step: "cleaning" | "conflicts";
}

export function useAppState() {
  const [sites, setSites] = useState<FeatureCollection>(EMPTY);
  const [roads, setRoads] = useState<FeatureCollection>(EMPTY);
  const [lessors, setLessors] = useState<FeatureCollection>(EMPTY);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [importSession, setImportSession] = useState<ImportSession | null>(null);
  const [selected, setSelected] = useState<Feature | null>(null);
  // 用 epoch 让 MapView 在收到新值时 fly-to；即便是同一个 feature 再次点击也能再飞一次
  const [flyTarget, setFlyTarget] = useState<{ feature: Feature; epoch: number } | null>(null);
  const [drawMode, setDrawMode] = useState<DrawMode>(null);
  const [selectionPolygon, setSelectionPolygon] = useState<GeoJSONPolygon | null>(null);
  // #47：记住产出当前选区的绘制模式，导出时映射为 audit mode（polygon/rect/circle）
  const [selectionMode, setSelectionMode] = useState<SelectionMode | null>(null);
  // 被显式隐藏的要素 id（左树/全局都看这同一份）
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  // F15 全局基线状态栏
  const [baselineState, setBaselineState] = useState<BaselineState>({ established: false });
  // F16 全局搜索结果（独立于日志数组）
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  // 触发地图调用 fit-all 的 epoch
  const [fitAllEpoch, setFitAllEpoch] = useState(0);
  // 三面板尺寸；null = 用 CSS 默认百分比，number = 用户拖拽过的 px
  const [panelSizes, setPanelSizes] = useState<Record<PanelKey, number | null>>(() => ({
    left: readPanelSize("left"),
    right: readPanelSize("right"),
    bottom: readPanelSize("bottom") ?? 200,
  }));
  // 拖拽中通知地图 updateSize() 的 epoch
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  // F20 Phase 4/#30：当前打开的「查看图层要素」浮动窗口（null = 未打开）
  const [viewLayer, setViewLayer] = useState<ViewLayerState | null>(null);
  // #39：commit 写库进度（null = 未在提交）；轮询 /progress 填充
  const [importProgress, setImportProgress] = useState<{ done: number; total: number; pct: number } | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  // 同步防重入守卫（补 React setState/busy 异步空窗：大数据慢、用户狂点 commit）
  const committingRef = useRef(false);

  const log = useCallback((level: LogEntry["level"], msg: string) => {
    const locale = getLang() === "zh" ? "zh-CN" : "en-US";
    const ts = new Date().toLocaleTimeString(locale, { hour12: false });
    setLogs(prev => [...prev.slice(-49), { ts, level, msg }]);
  }, []);

  const refresh = useCallback(async () => {
    setPhase("loading");
    try {
      const { sites, roads, lessors } = await fetchAll();
      setSites(sites);
      setRoads(roads);
      setLessors(lessors);
      return { sites, roads, lessors };
    } finally {
      setPhase("idle");
    }
  }, []);

  const refreshBaselineState = useCallback(async () => {
    try {
      const bs = await fetchBaselineState();
      setBaselineState(bs);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("warn", t("log.baseline_err", { msg }));
    }
  }, [log]);

  // #28：地图拖拽导入已禁用（堵开盖戳旁路）。原 importFiles 是拖拽唯一调用方，
  // 随之移除；拖入文件改为只 warn 提示走图层 [导入图层]。
  const notifyDropDisabled = useCallback(() => {
    log("warn", t("log.drop_disabled"));
  }, [log]);

  // F20 Phase 3：图层 [导入图层] 按钮触发（传盖戳入参+几何护栏）
  const importLayerFile = useCallback(
    async (file: File, stamp: LayerStamp) => {
      if (file.size > MAX_FILE_BYTES) {
        log("error", t("log.file_too_large", { name: file.name, size: fmtMB(file.size), limit: MAX_FILE_MB }));
        return;
      }
      setPhase("uploading");
      log("info", t("log.upload_start", { name: file.name }));
      try {
        const resp = await uploadFile(file, stamp);
        const sm = resp.summary;
        // 几何护栏跳过报告（geometry_guard 现已在 Phase1Response 显式声明）
        if (resp.geometry_guard?.message) log("info", resp.geometry_guard.message);
        log("info", t("log.parse_ok", {
          count: sm.total_parsed,
          groups: sm.intra_file_duplicates.site_groups + sm.intra_file_duplicates.lessor_groups,
          discarded: sm.intra_file_duplicates.site_discarded + sm.intra_file_duplicates.lessor_discarded,
          cleanings: sm.cleanings_count,
        }));
        const decisions: Record<string, CleaningAction> = {};
        for (const c of resp.cleanings) decisions[c.row_id] = c.default_action;
        setImportSession({
          sessionId: resp.session_id,
          fileName: file.name,
          cleanings: resp.cleanings,
          cleaningDecisions: decisions,
          baselineRegion: resp.baseline_region,
          warnAllOutsideBaseline: Boolean(resp.warn_all_outside_baseline),
          phase1Summary: sm,
          conflicts: [],
          conflictDecisions: {},
          step: "cleaning",
        });
        setPhase("cleaning");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", t("log.upload_err", { msg }));
        setPhase("idle");
      }
    },
    [log]
  );

  // 步骤 1 → 步骤 2
  const goToConflicts = useCallback(
    async (cleaningDecisions: Record<string, CleaningAction>) => {
      if (!importSession) return;
      setPhase("uploading");  // 用"上传中"做占位 spinner；后端处理一般 < 1s
      try {
        const list = Object.entries(cleaningDecisions).map(([row_id, action]) => ({ row_id, action }));
        const resp = await proceedToConflicts(importSession.sessionId, list);
        const cs = resp.cleaning_stats;
        log("info", t("log.cleaning_saved", {
          af: cs.auto_fixed, k: cs.kept, d: cs.discarded, count: resp.conflicts.length,
        }));

        // 冲突默认决策：ignore（Spec F4 / Stage 2 沿用）
        const cdec: Record<string, Decision> = {};
        for (const c of resp.conflicts) cdec[c.key] = "ignore";

        setImportSession({
          ...importSession,
          cleaningDecisions,
          conflicts: resp.conflicts,
          conflictDecisions: cdec,
          step: "conflicts",
        });
        setPhase("conflicts");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", t("log.conflict_err", { msg }));
        setPhase("cleaning");
      }
    },
    [importSession, log]
  );

  // 步骤 2 → 步骤 1（保留 cleaning 决策）
  const goBackToCleaning = useCallback(async () => {
    if (!importSession) return;
    try {
      await backToCleaning(importSession.sessionId);
      setImportSession({
        ...importSession,
        conflicts: [],
        conflictDecisions: {},
        step: "cleaning",
      });
      setPhase("cleaning");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", t("log.back_err", { msg }));
    }
  }, [importSession, log]);

  const confirmConflicts = useCallback(
    async (decisions: Record<string, Decision>) => {
      if (!importSession) return;
      if (committingRef.current) return;   // 同步防重入：commit 进行中再点直接忽略（防二次提交 404）
      committingRef.current = true;
      const sid = importSession.sessionId;
      const fileName = importSession.fileName;
      setPhase("committing");
      setImportProgress({ done: 0, total: 0, pct: 0 });
      log("info", t("log.committing", { file: fileName }));

      // #39：轮询写库进度（每 500ms）。停止条件：done===total / phase=done / finally 兜底。
      const stopPoll = () => {
        if (progressTimerRef.current != null) {
          clearInterval(progressTimerRef.current);
          progressTimerRef.current = null;
        }
      };
      // 关框 + 退提交态（成功/失败都用，幂等）
      const closeFrame = () => {
        stopPoll();
        setImportProgress(null);
        setImportSession(null);
        setPhase("idle");
      };
      stopPoll();
      progressTimerRef.current = window.setInterval(async () => {
        try {
          const p: ImportProgress = await fetchImportProgress(sid);
          setImportProgress({ done: p.done, total: p.total, pct: p.pct });
          if (p.phase === "done" || (p.total > 0 && p.done >= p.total)) stopPoll();
        } catch { /* 轮询失败忽略，commit await 兜底 */ }
      }, 500);

      let ok = false;
      try {
        const list = Object.entries(decisions).map(([key, action]) => ({ key, action }));
        const resp = await commitImport(sid, list);
        const s = resp.stats;
        const cs = resp.cleaning_stats;
        log("info", t("log.commit_ok", {
          af: cs.auto_fixed, d: cs.discarded,
          si: s.site.inserted, su: s.site.updated, sn: s.site.ignored,
          ri: s.road.inserted,
          li: s.lessor.inserted, lu: s.lessor.updated, ln: s.lessor.ignored,
        }));
        if (resp.baseline_established) {
          const bs = resp.baseline_established;
          log("info", t("log.baseline_fixed", { name: (getLang() === "zh" ? bs.name_zh : bs.name_en) ?? bs.name_zh ?? bs.iso_a2, iso: bs.iso_a2, pct: bs.coverage_pct ?? "?" }));
        }
        ok = true;
        // ★ commit 成功立即关框 + 退提交态（不等 refresh，否则 13300 条重载期间框还挂着，
        //   用户以为失败再点 → 二次提交 sid 已消费 → 404）
        closeFrame();
        log("info", t("log.import_done"));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", t("log.commit_err", { msg }));
        closeFrame();   // 失败也关框，别卡死在 committing
      } finally {
        stopPoll();
        committingRef.current = false;
      }

      // 成功后才后台刷新（框已退，慢也不影响体验；失败已 return-like 跳过）
      if (ok) {
        try {
          await refresh();
          await refreshBaselineState();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          log("error", t("log.refresh_err", { msg }));
        }
      }
    },
    [importSession, log, refresh, refreshBaselineState]
  );

  // 取消导入：步骤 2 取消 → 下载 Excel 然后 DELETE；步骤 1 取消 → 直接 DELETE
  const abortImport = useCallback(async () => {
    if (!importSession) return;
    const isStep2 = importSession.step === "conflicts" && importSession.conflicts.length > 0;
    if (isStep2) {
      try {
        await downloadConflictsXlsx(importSession.sessionId);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", t("log.cancel_excel_err", { msg }));
      }
    }
    try {
      await cancelImport(importSession.sessionId);
      log("warn", t("log.cancel_ok", { file: importSession.fileName }) +
        (isStep2 ? t("log.cancel_ok_extra") : ""));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", t("log.cancel_err", { msg }));
    } finally {
      setImportSession(null);
      setPhase("idle");
    }
  }, [importSession, log]);

  // F14 清除基线
  const doClearBaseline = useCallback(async () => {
    try {
      const resp = await clearBaseline();
      const d = resp.deleted;
      log("error", t("log.clear_ok", { s: d.site, r: d.road, l: d.lessor }) +
        (d.baseline_state ? t("log.clear_ok_reset") : ""));
      await refresh();
      await refreshBaselineState();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", t("log.clear_err", { msg }));
    }
  }, [log, refresh, refreshBaselineState]);

  const selectFeature = useCallback((f: Feature | null) => {
    setSelected(f);
  }, []);

  const flyTo = useCallback((f: Feature) => {
    setSelected(f);
    // 坐标异常的 site（LATI/LONGI 写反或漏小数点）跳过飞到 ——
    // 这种点投到 EPSG:3857 时会产生 Infinity，再喂给 view.animate 会损坏 view 状态。
    const p = f.properties ?? {};
    if (p.kind === "site") {
      const lat = Number(p.lati);
      const lon = Number(p.longi);
      if (
        !Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180
      ) {
        log("warn", t("log.coord_err", { id: String(p.site_id ?? f.id) }));
        return;
      }
    }
    setFlyTarget({ feature: f, epoch: Date.now() });
  }, [log]);

  const startDraw = useCallback((mode: DrawMode) => {
    setDrawMode(mode);
  }, []);

  const onSelectionDrawn = useCallback((polygon: GeoJSONPolygon, mode: DrawMode) => {
    setSelectionPolygon(polygon);
    // #47：DrawMode → audit mode（rectangle→rect，circle/polygon 同名；null 兜底 polygon）
    setSelectionMode(mode === "rectangle" ? "rect" : mode === "circle" ? "circle" : "polygon");
    setDrawMode(null);
    log("info", t("log.selection_drawn"));
  }, [log]);

  const clearSelection = useCallback(() => {
    setSelectionPolygon(null);
    setSelectionMode(null);
    setDrawMode(null);
  }, []);

  // #46：npRadiusM 由调用方（App 持有的内存 state）显式传入，作为导出半径的单一真源；
  // 「所见即所得」——导出半径 === 地图当前显示半径，不在此处重读 localStorage。
  const doExportAll = useCallback(async (npRadiusM: number) => {
    setPhase("exporting");
    log("info", t("log.export_all_start"));
    try {
      await exportAll(npRadiusM);
      log("info", t("log.export_all_ok"));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", t("log.export_all_err", { msg }));
    } finally {
      setPhase("idle");
    }
  }, [log]);

  const clearLogs = useCallback(() => setLogs([]), []);

  const toggleFeatureVisible = useCallback((id: string) => {
    setHiddenIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setKindVisible = useCallback((ids: string[], visible: boolean) => {
    setHiddenIds(prev => {
      const next = new Set(prev);
      if (visible) for (const id of ids) next.delete(id);
      else for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const fitAll = useCallback(() => setFitAllEpoch(Date.now()), []);

  // F20 Phase 4/#30：打开/关闭「查看图层要素」浮动窗口。anchor=触发按钮坐标（首次开窗定位用）
  const openLayerFeatures = useCallback(
    (target: ViewLayerTarget, anchor: { x: number; y: number } | null) =>
      setViewLayer({ target, anchor }),
    [],
  );
  // #34：眼睛按钮 toggle——同图层再点关闭、异图层切内容（用函数式更新拿最新 prev）
  const toggleLayerFeatures = useCallback(
    (target: ViewLayerTarget, anchor: { x: number; y: number } | null) =>
      setViewLayer(prev => (prev && sameTarget(prev.target, target) ? null : { target, anchor })),
    [],
  );
  const closeLayerFeatures = useCallback(() => setViewLayer(null), []);

  // 拖拽中实时改 panel size 并通知地图重绘
  // layoutEpoch 用 rAF 节流：pointermove 可能比帧率更密，避免地图每个事件都 updateSize
  const layoutRafRef = useRef<number | null>(null);
  const setPanelSize = useCallback((key: PanelKey, sizePx: number) => {
    const { min, max } = PANEL_LIMITS[key];
    const clamped = clamp(sizePx, min, max);
    setPanelSizes(prev => ({ ...prev, [key]: clamped }));
    if (layoutRafRef.current == null) {
      layoutRafRef.current = requestAnimationFrame(() => {
        layoutRafRef.current = null;
        setLayoutEpoch(Date.now());
      });
    }
  }, []);

  // 拖拽结束写 localStorage
  const persistPanelSize = useCallback((key: PanelKey) => {
    setPanelSizes(prev => {
      const v = prev[key];
      if (v != null) {
        try {
          localStorage.setItem(PANEL_LS_KEY[key], String(v));
        } catch { /* localStorage 不可用就放弃持久化 */ }
      }
      return prev;
    });
  }, []);

  // F16 全局搜索：三类全搜，匹配口径复用 nameOf（与左树过滤同口径，子串、大小写不敏感）
  // 结果写入独立 searchResults（不进 50 条日志），新搜覆盖旧；非空自动飞第一条。
  const globalSearch = useCallback((query: string) => {
    const q = query.trim();
    if (!q) return;  // 空关键词不搜索
    const lower = q.toLowerCase();
    const all = [...sites.features, ...roads.features, ...lessors.features];
    const matches = all.filter(f => nameOf(f).toLowerCase().includes(lower));
    setSearchResults({ query: q, total: matches.length, results: matches.slice(0, SEARCH_CAP) });
    if (matches.length > 0) flyTo(matches[0]);
  }, [sites, roads, lessors, flyTo]);

  // F16 #18：清空搜索结果（只动 searchResults，不碰日志数组）
  const clearSearch = useCallback(() => setSearchResults(null), []);

  const doExportSelection = useCallback(async (npRadiusM: number) => {
    if (!selectionPolygon) {
      log("error", t("log.no_selection"));
      return;
    }
    setPhase("exporting");
    log("info", t("log.export_sel_start"));
    try {
      // #46：框选导出半径同样来自内存 state（单一真源），所见即所得
      // #47：mode（polygon/rect/circle）透传给后端记审计；兜底 polygon
      await exportSelection(selectionPolygon, npRadiusM, selectionMode ?? "polygon");
      log("info", t("log.export_sel_ok"));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", t("log.export_sel_err", { msg }));
    } finally {
      setPhase("idle");
    }
  }, [selectionPolygon, selectionMode, log]);

  // ---------- #48 site 增删改 + 勾选导出（接 Phase 6 后端）----------
  // 编辑/删除后统一 await refresh() 重拉三表 FeatureCollection → 地图重渲染 + 左树计数同步。
  // 返回 null=成功，string=可读错误（同时已写日志面板）。

  // Phase 7 低修复1：refresh 后按 selected.id 在新三表里重绑定 selected；
  // 找不到（被删/不存在）→ setSelected(null)，避免属性面板显示旧值或已删项。
  const rebindSelected = useCallback(
    (cols: { sites: FeatureCollection; roads: FeatureCollection; lessors: FeatureCollection }) => {
      setSelected(prev => {
        if (!prev) return prev;
        const id = String(prev.id);
        const all = [...cols.sites.features, ...cols.roads.features, ...cols.lessors.features];
        return all.find(f => String(f.id) === id) ?? null;
      });
    },
    [],
  );

  const doUpdateSite = useCallback(
    async (key: SiteKey, patch: SitePatch): Promise<string | null> => {
      try {
        await updateSite(key, patch);
        log("info", t("log.edit_site_ok", { id: key.site_id }));
        const cols = await refresh();
        rebindSelected(cols);
        return null;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", t("log.edit_site_err", { msg }));
        return msg;
      }
    },
    [log, refresh, rebindSelected],
  );

  const doDeleteSites = useCallback(
    async (keys: SiteKey[]): Promise<string | null> => {
      try {
        const resp = await deleteSites(keys);
        log("info", t("log.delete_site_ok", { n: resp.deleted }));
        const cols = await refresh();
        rebindSelected(cols);
        return null;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", t("log.delete_site_err", { msg }));
        return msg;
      }
    },
    [log, refresh, rebindSelected],
  );

  // #49 Phase 9：撤销某批删除 → 插回 site → refresh + 重绑 selected。返回 null=成功 / string=错误。
  const doUndoDelete = useCallback(
    async (undoId: number): Promise<string | null> => {
      try {
        const resp = await undoDelete(undoId);
        log("info", t("log.undo_delete_ok", { restored: resp.restored, requested: resp.requested }));
        const cols = await refresh();
        rebindSelected(cols);
        return null;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", t("log.undo_delete_err", { msg }));
        return msg;
      }
    },
    [log, refresh, rebindSelected],
  );

  const doExportSelectionIds = useCallback(
    async (keys: SiteKey[], npRadiusM: number): Promise<void> => {
      if (keys.length === 0) {
        log("error", t("log.export_ids_empty"));
        return;
      }
      setPhase("exporting");
      log("info", t("log.export_ids_start", { n: keys.length }));
      try {
        await exportSelectionIds(keys, npRadiusM);
        log("info", t("log.export_ids_ok"));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", t("log.export_ids_err", { msg }));
      } finally {
        setPhase("idle");
      }
    },
    [log],
  );

  return {
    sites,
    roads,
    lessors,
    logs,
    phase,
    importSession,
    selected,
    flyTarget,
    drawMode,
    selectionPolygon,
    hiddenIds,
    fitAllEpoch,
    panelSizes,
    layoutEpoch,
    log,
    clearLogs,
    refresh,
    notifyDropDisabled,
    importLayerFile,
    goToConflicts,
    goBackToCleaning,
    confirmConflicts,
    importProgress,
    abortImport,
    doClearBaseline,
    baselineState,
    refreshBaselineState,
    selectFeature,
    flyTo,
    startDraw,
    onSelectionDrawn,
    clearSelection,
    doExportAll,
    doExportSelection,
    toggleFeatureVisible,
    setKindVisible,
    fitAll,
    globalSearch,
    searchResults,
    clearSearch,
    setPanelSize,
    persistPanelSize,
    viewLayer,
    openLayerFeatures,
    toggleLayerFeatures,
    closeLayerFeatures,
    doUpdateSite,
    doDeleteSites,
    doExportSelectionIds,
    doUndoDelete,
  };
}
