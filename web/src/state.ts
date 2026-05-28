import { useCallback, useState } from "react";
import {
  cancelImport,
  commitImport,
  ConflictRow,
  CoordWarning,
  Decision,
  downloadConflictsXlsx,
  exportAll,
  exportSelection,
  Feature,
  FeatureCollection,
  fetchAll,
  GeoJSONPolygon,
  ImportSessionResponse,
  uploadFiles,
} from "./api";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  msg: string;
}

// Spec F11：导入/解析/入库阶段进度条
export type Phase = "idle" | "uploading" | "awaiting_decision" | "committing" | "exporting";

// F9 框选模式
export type DrawMode = "polygon" | "rectangle" | null;

export interface ImportSession {
  sessionId: string;
  conflicts: ConflictRow[];
  warnings: CoordWarning[];
  // 每条冲突的当前决策；默认 ignore（Spec：忽略 = 仅导无冲突）
  decisions: Record<string, Decision>;
  fileNames: string[];
  summary: ImportSessionResponse["summary"];
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
  // 触发地图调用 fit-all 的 epoch
  const [fitAllEpoch, setFitAllEpoch] = useState(0);

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

  const importFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setPhase("uploading");
      log("info", `开始上传 ${files.length} 个文件：${files.map(f => f.name).join(", ")}`);
      try {
        const resp = await uploadFiles(files);
        // 文件级解析错误先报
        for (const f of resp.files) {
          if (f.error) log("error", `${f.name} → ${f.error}`);
        }
        // 坐标异常 warnings
        for (const w of resp.warnings) {
          log("warn", `坐标异常 ${w.name} (来自 ${w.source_file})：${w.message}`);
        }

        const sumLine = (label: string, k: "site" | "road" | "lessor") =>
          `${label} ${resp.summary[k].non_conflict}/${resp.summary[k].conflict}`;
        log(
          "info",
          `解析完成（无冲突/冲突）：${sumLine("site", "site")}，${sumLine("road", "road")}，${sumLine("lessor", "lessor")}`
        );

        if (resp.conflicts.length === 0) {
          // 直接 commit 空决策
          await doCommit(resp.session_id, [], files.map(f => f.name));
          return;
        }

        // 默认全部忽略（Spec：忽略 = 仅导无冲突）
        const decisions: Record<string, Decision> = {};
        for (const c of resp.conflicts) decisions[c.key] = "ignore";

        setImportSession({
          sessionId: resp.session_id,
          conflicts: resp.conflicts,
          warnings: resp.warnings,
          decisions,
          fileNames: files.map(f => f.name),
          summary: resp.summary,
        });
        setPhase("awaiting_decision");
        log("info", `等待用户处理 ${resp.conflicts.length} 条冲突`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", `导入失败：${msg}`);
        setPhase("idle");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log]
  );

  const doCommit = useCallback(
    async (
      sessionId: string,
      decisions: { key: string; action: Decision }[],
      fileNames: string[]
    ) => {
      setPhase("committing");
      log("info", `正在入库 (${fileNames.join(", ")})...`);
      try {
        const resp = await commitImport(sessionId, decisions);
        const s = resp.stats;
        log(
          "info",
          `入库完成：site ${s.site.inserted}+${s.site.updated}/-${s.site.ignored}，` +
            `road ${s.road.inserted}/-，` +
            `lessor ${s.lessor.inserted}+${s.lessor.updated}/-${s.lessor.ignored}`
        );
        await refresh();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", `入库失败：${msg}`);
      } finally {
        setImportSession(null);
        setPhase("idle");
      }
    },
    [log, refresh]
  );

  const confirmConflicts = useCallback(
    async (decisions: Record<string, Decision>) => {
      if (!importSession) return;
      const list = Object.entries(decisions).map(([key, action]) => ({ key, action }));
      await doCommit(importSession.sessionId, list, importSession.fileNames);
    },
    [importSession, doCommit]
  );

  const abortConflicts = useCallback(async () => {
    if (!importSession) return;
    // F5：先拿 xlsx 文件，再释放 session（顺序不能反，删了 session 就拿不到 xlsx 了）
    try {
      await downloadConflictsXlsx(importSession.sessionId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", `下载冲突 Excel 失败：${msg}`);
    }
    try {
      await cancelImport(importSession.sessionId);
      log("warn", `已取消导入 (${importSession.fileNames.join(", ")})，冲突列表已下载为 Excel`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", `取消导入失败：${msg}`);
    } finally {
      setImportSession(null);
      setPhase("idle");
    }
  }, [importSession, log]);

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
    log,
    clearLogs,
    refresh,
    importFiles,
    confirmConflicts,
    abortConflicts,
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
  };
}
