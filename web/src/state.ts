import { useCallback, useState } from "react";
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

// Spec F11/12：导入阶段进度条 + 向导步骤
export type Phase =
  | "idle"
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
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setLogs(prev => [...prev.slice(-49), { ts, level, msg }]);
  }, []);

  const refresh = useCallback(async () => {
    const { sites, roads, lessors } = await fetchAll();
    setSites(sites);
    setRoads(roads);
    setLessors(lessors);
    return { sites, roads, lessors };
  }, []);

  const refreshBaselineState = useCallback(async () => {
    try {
      const bs = await fetchBaselineState();
      setBaselineState(bs);
    } catch (e: unknown) {
      // 不挡正常流程，只 log
      const msg = e instanceof Error ? e.message : String(e);
      log("warn", `获取基线状态失败：${msg}`);
    }
  }, [log]);

  const importFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;

      // Spec F1 #12：V1 单文件强制。拖入多个 → 只取首个 + warn
      if (files.length > 1) {
        const dropped = files.length - 1;
        const droppedNames = files.slice(1).map(f => f.name).join(", ");
        log("warn", `已忽略其他 ${dropped} 个文件（V1 一次只能传一个）：${droppedNames}`);
        files = [files[0]];
      }

      const f0 = files[0];
      if (f0.size > MAX_FILE_BYTES) {
        log("error", `文件 ${f0.name} (${fmtMB(f0.size)}MB) 超过 ${MAX_FILE_MB}MB 上限，已拒绝`);
        return;
      }

      setPhase("uploading");
      log("info", `开始上传：${f0.name}`);
      try {
        const resp = await uploadFile(f0);
        const sm = resp.summary;
        log(
          "info",
          `解析 ${sm.total_parsed} 条；文件内重复去重 ${sm.intra_file_duplicates.site_groups + sm.intra_file_duplicates.lessor_groups} 组` +
          `（丢弃 ${sm.intra_file_duplicates.site_discarded + sm.intra_file_duplicates.lessor_discarded}）；检测异常 ${sm.cleanings_count} 条，等待用户决策（尚未写库）`
        );

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
        log("error", `导入失败：${msg}`);
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
        log("info",
          `清洗决策已暂存（自动修复 ${cs.auto_fixed} / 保留 ${cs.kept} / 丢弃 ${cs.discarded}）；` +
          `待处理冲突 ${resp.conflicts.length} 条；尚未写库`
        );

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
        log("error", `进入冲突检测失败：${msg}`);
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
      log("error", `返回清洗步骤失败：${msg}`);
    }
  }, [importSession, log]);

  const confirmConflicts = useCallback(
    async (decisions: Record<string, Decision>) => {
      if (!importSession) return;
      setPhase("committing");
      log("info", `正在入库 (${importSession.fileName})...`);
      try {
        const list = Object.entries(decisions).map(([key, action]) => ({ key, action }));
        const resp = await commitImport(importSession.sessionId, list);
        const s = resp.stats;
        const cs = resp.cleaning_stats;
        log(
          "info",
          `入库完成：清洗 fix ${cs.auto_fixed}/丢弃 ${cs.discarded}；` +
          `site ${s.site.inserted}+${s.site.updated}/-${s.site.ignored}，` +
          `road ${s.road.inserted}/-，` +
          `lessor ${s.lessor.inserted}+${s.lessor.updated}/-${s.lessor.ignored}`
        );
        // Spec #15：commit 后刷基线状态栏（可能本次刚固化）
        if (resp.baseline_established) {
          const bs = resp.baseline_established;
          log("info", `✅ 主基准已固化：${bs.name_zh ?? bs.iso_a2} (${bs.iso_a2}) · ${bs.coverage_pct}% 覆盖`);
        }
        await refresh();
        await refreshBaselineState();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", `入库失败：${msg}`);
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
        log("error", `下载冲突 Excel 失败：${msg}`);
      }
    }
    try {
      await cancelImport(importSession.sessionId);
      log("warn",
        `已取消导入 (${importSession.fileName})，数据库未变动${isStep2 ? "，冲突列表已下载为 Excel" : ""}`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", `取消导入失败：${msg}`);
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
      log("error",
        `基线已清空：site -${d.site} / road -${d.road} / lessor -${d.lessor}` +
        (d.baseline_state ? `（主基准已重置）` : "")
      );
      await refresh();
      await refreshBaselineState();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", `清除基线失败：${msg}`);
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
        log("warn", `${p.site_id ?? f.id} 坐标异常，无法定位（请修源文件后重新导入）`);
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
    log("info", "已绘制选区，可点 [导出 KMZ ▾ → 导出选区] 下载");
  }, [log]);

  const clearSelection = useCallback(() => {
    setSelectionPolygon(null);
    setDrawMode(null);
  }, []);

  const doExportAll = useCallback(async () => {
    setPhase("exporting");
    log("info", "整库导出中...");
    try {
      await exportAll();
      log("info", "整库 KMZ 下载已触发");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", `整库导出失败：${msg}`);
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
  const setPanelSize = useCallback((key: PanelKey, sizePx: number) => {
    const { min, max } = PANEL_LIMITS[key];
    const clamped = clamp(sizePx, min, max);
    setPanelSizes(prev => ({ ...prev, [key]: clamped }));
    setLayoutEpoch(Date.now());
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

  // 全局搜索：按 SITE ID / Lessor Name / Road Property 匹配，返回第一个命中
  const globalSearch = useCallback((query: string): Feature | null => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const test = (f: Feature, fields: (keyof Record<string, unknown>)[]): boolean => {
      const p = f.properties ?? {};
      for (const fld of fields) {
        const v = p[fld as string];
        if (v != null && String(v).toLowerCase().includes(q)) return true;
      }
      return false;
    };
    const all = [
      ...sites.features.map(f => ({ f, fields: ["site_id", "option"] as string[] })),
      ...lessors.features.map(f => ({ f, fields: ["lessor_name", "fid"] as string[] })),
      ...roads.features.map(f => ({ f, fields: ["property"] as string[] })),
    ];
    const matches = all.filter(({ f, fields }) => test(f, fields as never));
    if (matches.length === 0) {
      log("warn", `搜索：未匹配 "${query}"`);
      return null;
    }
    if (matches.length > 1) {
      log("info", `搜索匹配 ${matches.length} 条，飞到第一条`);
    }
    const first = matches[0].f;
    setSelected(first);
    setFlyTarget({ feature: first, epoch: Date.now() });
    return first;
  }, [sites, roads, lessors, log]);

  const doExportSelection = useCallback(async () => {
    if (!selectionPolygon) {
      log("error", "未绘制选区");
      return;
    }
    setPhase("exporting");
    log("info", "选区导出中...");
    try {
      await exportSelection(selectionPolygon);
      log("info", "选区 KMZ 下载已触发");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", `选区导出失败：${msg}`);
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
    setPanelSize,
    persistPanelSize,
  };
}
