import { useCallback, useEffect, useMemo, useState } from "react";
import { t, useT } from "./i18n";
import Toolbar from "./components/Toolbar";
import LayerTree from "./components/LayerTree";
import MapView from "./components/MapView";
import AttributePanel from "./components/AttributePanel";
import OutputPanel from "./components/OutputPanel";
import ConflictDialog from "./components/ConflictDialog";
import CleaningDialog from "./components/CleaningDialog";
import ConfirmDialog from "./components/ConfirmDialog";
import RestorePointDialog from "./components/RestorePointDialog";
import BaselineStatusBar from "./components/BaselineStatusBar";
import AuditPasswordPrompt from "./components/AuditPasswordPrompt";
import AuditModal from "./components/AuditModal";
import { useEscTrigger } from "./hooks/useEscTrigger";
import { useAppState } from "./state";

export default function App() {
  const [outputOpen, setOutputOpen] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [restorePointsOpen, setRestorePointsOpen] = useState(false);
  const [auditPwdOpen, setAuditPwdOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const s = useAppState();
  const tFn = useT();

  // F19 隐藏入口：3 次 Esc（间隔 < 1s）→ 密码框 → Audit Modal
  useEscTrigger(() => {
    // 已打开任意一个就不再弹
    if (auditPwdOpen || auditOpen) return;
    setAuditPwdOpen(true);
  }, 3, 1000);

  useEffect(() => {
    s.refresh().catch(err => s.log("error", t("log.load_err", { msg: err.message ?? String(err) })));
    s.refreshBaselineState();  // F15：启动时拉一次主基准状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (s.logs.length > 0 && s.logs[s.logs.length - 1].level !== "info") {
      setOutputOpen(true);
    }
  }, [s.logs]);

  // F16：每次新搜索（searchResults 引用变化）自动展开 Output，确保结果/边界文案可见
  useEffect(() => {
    if (s.searchResults) setOutputOpen(true);
  }, [s.searchResults]);

  const onRefresh = useCallback(async () => {
    s.log("info", tFn("log.refresh_start"));
    try {
      const { sites, roads, lessors } = await s.refresh();
      s.log("info", tFn("log.refresh_ok", {
        s: sites.features.length, r: roads.features.length, l: lessors.features.length,
      }));
    } catch (e: unknown) {
      s.log("error", tFn("log.refresh_err", { msg: e instanceof Error ? e.message : String(e) }));
    }
  }, [s, tFn]);

  const onSearch = useCallback((q: string) => {
    s.globalSearch(q);
  }, [s]);

  // 稳定的拖动回调：避免每帧 pointermove 透过 inline 箭头函数让子组件丢失 memo
  const onResizeLeft = useCallback((px: number) => s.setPanelSize("left", px), [s]);
  const onResizeEndLeft = useCallback(() => s.persistPanelSize("left"), [s]);
  const onResizeRight = useCallback((px: number) => s.setPanelSize("right", px), [s]);
  const onResizeEndRight = useCallback(() => s.persistPanelSize("right"), [s]);
  const onResizeBottom = useCallback((px: number) => s.setPanelSize("bottom", px), [s]);
  const onResizeEndBottom = useCallback(() => s.persistPanelSize("bottom"), [s]);

  const selectedId = s.selected?.id ?? null;

  // Spec V1.x #11/#15：四行 grid（toolbar / baseline 状态栏 / 内容 / 输出）
  const gridStyle: React.CSSProperties = useMemo(() => {
    const left = s.panelSizes.left != null ? `${s.panelSizes.left}px` : "20%";
    const right = !s.selected
      ? "0"
      : s.panelSizes.right != null
        ? `${s.panelSizes.right}px`
        : "25%";
    const bottom = outputOpen ? `${s.panelSizes.bottom ?? 200}px` : "28px";
    return {
      gridTemplateColumns: `${left} 1fr ${right}`,
      // 56px toolbar + 28px baseline + 1fr 内容 + 28~500px 输出
      gridTemplateRows: `56px 28px 1fr ${bottom}`,
    };
  }, [s.panelSizes, s.selected, outputOpen]);

  return (
    <div className={`app ${s.selected ? "" : "no-attr"}`} style={gridStyle}>
      <Toolbar
        onImport={s.importFiles}
        busy={s.phase === "loading" || s.phase === "uploading" || s.phase === "committing" || s.phase === "exporting"}
        drawMode={s.drawMode}
        hasSelection={s.selectionPolygon !== null}
        onStartDraw={s.startDraw}
        onClearSelection={s.clearSelection}
        onExportAll={s.doExportAll}
        onExportSelection={s.doExportSelection}
        onRefresh={onRefresh}
        onSearch={onSearch}
        onClearBaseline={() => setConfirmingClear(true)}
        onOpenRestorePoints={() => setRestorePointsOpen(true)}
      />
      {/* F15 全局基线状态栏（Spec V1.x #15）*/}
      <BaselineStatusBar state={s.baselineState} />
      <LayerTree
        sites={s.sites}
        roads={s.roads}
        lessors={s.lessors}
        selectedId={selectedId}
        hiddenIds={s.hiddenIds}
        onPick={s.flyTo}
        onToggleFeature={s.toggleFeatureVisible}
        onSetKindVisible={s.setKindVisible}
        onResize={onResizeLeft}
        onResizeEnd={onResizeEndLeft}
      />
      {s.phase === "loading" && (
        <div className="map-loading-overlay">
          <div className="map-loading-box">⏳ {tFn("phase.loading")}</div>
        </div>
      )}
      <MapView
        sites={s.sites}
        roads={s.roads}
        lessors={s.lessors}
        selectedId={selectedId}
        flyTarget={s.flyTarget}
        drawMode={s.drawMode}
        selectionPolygon={s.selectionPolygon}
        hiddenIds={s.hiddenIds}
        fitAllEpoch={s.fitAllEpoch}
        layoutEpoch={s.layoutEpoch}
        onDropFiles={s.importFiles}
        onSelectFeature={s.selectFeature}
        onSelectionDrawn={s.onSelectionDrawn}
        onFitAll={s.fitAll}
      />
      <AttributePanel
        feature={s.selected}
        onClose={() => s.selectFeature(null)}
        onResize={onResizeRight}
        onResizeEnd={onResizeEndRight}
      />
      <OutputPanel
        open={outputOpen}
        onToggle={() => setOutputOpen(o => !o)}
        logs={s.logs}
        phase={s.phase}
        onClearLogs={s.clearLogs}
        onResize={onResizeBottom}
        onResizeEnd={onResizeEndBottom}
        searchResults={s.searchResults}
        onResultClick={s.flyTo}
        onClearSearch={s.clearSearch}
      />

      {/* Spec #12 两步向导：步骤 1 清洗 / 步骤 2 冲突 */}
      {s.importSession && s.importSession.step === "cleaning" && (
        <CleaningDialog
          fileName={s.importSession.fileName}
          cleanings={s.importSession.cleanings}
          baselineRegion={s.importSession.baselineRegion}
          summary={s.importSession.phase1Summary}
          initial={s.importSession.cleaningDecisions}
          warnAllOutsideBaseline={s.importSession.warnAllOutsideBaseline}
          onProceed={s.goToConflicts}
          onCancel={s.abortImport}
        />
      )}
      {s.importSession && s.importSession.step === "conflicts" && (
        <ConflictDialog
          conflicts={s.importSession.conflicts}
          initial={s.importSession.conflictDecisions}
          onConfirm={s.confirmConflicts}
          onCancel={s.abortImport}
          onBack={s.goBackToCleaning}
        />
      )}

      {/* F17 恢复点对话框 */}
      {restorePointsOpen && (
        <RestorePointDialog
          onClose={() => setRestorePointsOpen(false)}
          onRolledBack={async () => {
            await s.refresh();
            await s.refreshBaselineState();
          }}
        />
      )}

      {/* F14 清除基线确认 */}
      {confirmingClear && (
        <ConfirmDialog
          title={tFn("app.clear.title")}
          body={tFn("app.clear.body")}
          confirmLabel={tFn("app.clear.confirm")}
          cancelLabel={tFn("app.clear.cancel")}
          destructive
          onConfirm={() => {
            setConfirmingClear(false);
            s.doClearBaseline();
          }}
          onCancel={() => setConfirmingClear(false)}
        />
      )}

      {/* F19 隐藏审计入口 */}
      {auditPwdOpen && (
        <AuditPasswordPrompt
          onPass={() => { setAuditPwdOpen(false); setAuditOpen(true); }}
          onCancel={() => setAuditPwdOpen(false)}
        />
      )}
      {auditOpen && (
        <AuditModal onClose={() => setAuditOpen(false)} />
      )}
    </div>
  );
}
