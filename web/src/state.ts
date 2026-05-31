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
  ConflictRow,
  Decision,
  downloadConflictsXlsx,
  exportAll,
  exportSelection,
  Feature,
  FeatureCollection,
  fetchAll,
  fetchBaselineState,
  GeoJSONPolygon,
  Phase1Summary,
  proceedToConflicts,
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

// F9 框选模式
export type DrawMode = "polygon" | "rectangle" | null;

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

  const importFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;

      // Spec F1 #12：V1 单文件强制。拖入多个 → 只取首个 + warn
      if (files.length > 1) {
        const dropped = files.length - 1;
        const droppedNames = files.slice(1).map(f => f.name).join(", ");
        log("warn", t("log.multi_file", { n: dropped, names: droppedNames }));
        files = [files[0]];
      }

      const f0 = files[0];
      if (f0.size > MAX_FILE_BYTES) {
        log("error", t("log.file_too_large", { name: f0.name, size: fmtMB(f0.size), limit: MAX_FILE_MB }));
        return;
      }

      setPhase("uploading");
      log("info", t("log.upload_start", { name: f0.name }));
      try {
        const resp = await uploadFile(f0);
        const sm = resp.summary;
        log("info", t("log.parse_ok", {
          count: sm.total_parsed,
          groups: sm.intra_file_duplicates.site_groups + sm.intra_file_duplicates.lessor_groups,
          discarded: sm.intra_file_duplicates.site_discarded + sm.intra_file_duplicates.lessor_discarded,
          cleanings: sm.cleanings_count,
        }));

        // 默认决策按后端给的 default_action
        const decisions: Record<string, CleaningAction> = {};
        for (const c of resp.cleanings) decisions[c.row_id] = c.default_action;

        setImportSession({
          sessionId: resp.session_id,
          fileName: f0.name,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setPhase("committing");
      log("info", t("log.committing", { file: importSession.fileName }));
      try {
        const list = Object.entries(decisions).map(([key, action]) => ({ key, action }));
        const resp = await commitImport(importSession.sessionId, list);
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
          log("info", t("log.baseline_fixed", { name: bs.name_zh ?? bs.iso_a2, iso: bs.iso_a2, pct: bs.coverage_pct ?? "?" }));
        }
        await refresh();
        await refreshBaselineState();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", t("log.commit_err", { msg }));
      } finally {
        setImportSession(null);
        setPhase("idle");
      }
    },
    [importSession, log, refresh]
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

  const onSelectionDrawn = useCallback((polygon: GeoJSONPolygon) => {
    setSelectionPolygon(polygon);
    setDrawMode(null);
    log("info", t("log.selection_drawn"));
  }, [log]);

  const clearSelection = useCallback(() => {
    setSelectionPolygon(null);
    setDrawMode(null);
  }, []);

  const doExportAll = useCallback(async () => {
    setPhase("exporting");
    log("info", t("log.export_all_start"));
    try {
      await exportAll();
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

  const doExportSelection = useCallback(async () => {
    if (!selectionPolygon) {
      log("error", t("log.no_selection"));
      return;
    }
    setPhase("exporting");
    log("info", t("log.export_sel_start"));
    try {
      await exportSelection(selectionPolygon);
      log("info", t("log.export_sel_ok"));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", t("log.export_sel_err", { msg }));
    } finally {
      setPhase("idle");
    }
  }, [selectionPolygon, log]);

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
    importFiles,
    goToConflicts,
    goBackToCleaning,
    confirmConflicts,
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
  };
}
