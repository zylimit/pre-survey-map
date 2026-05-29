import { useCallback, useEffect, useMemo, useState } from "react";
import Toolbar from "./components/Toolbar";
import LayerTree from "./components/LayerTree";
import MapView from "./components/MapView";
import AttributePanel from "./components/AttributePanel";
import OutputPanel from "./components/OutputPanel";
import ConflictDialog from "./components/ConflictDialog";
import CleaningDialog from "./components/CleaningDialog";
import ConfirmDialog from "./components/ConfirmDialog";
import BaselineStatusBar from "./components/BaselineStatusBar";
import { useAppState } from "./state";

export default function App() {
  const [outputOpen, setOutputOpen] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const s = useAppState();

  useEffect(() => {
    s.refresh().catch(err => s.log("error", `首次加载失败：${err.message ?? err}`));
    s.refreshBaselineState();  // F15：启动时拉一次主基准状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (s.logs.length > 0 && s.logs[s.logs.length - 1].level !== "info") {
      setOutputOpen(true);
    }
  }, [s.logs]);

  const onRefresh = useCallback(async () => {
    s.log("info", "刷新数据...");
    try {
      const { sites, roads, lessors } = await s.refresh();
      s.log(
        "info",
        `刷新完成：site ${sites.features.length} · road ${roads.features.length} · lessor ${lessors.features.length}`
      );
    } catch (e: unknown) {
      s.log("error", `刷新失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [s]);

  const onSearch = useCallback((q: string) => {
    s.globalSearch(q);
  }, [s]);

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
        busy={s.phase === "uploading" || s.phase === "committing" || s.phase === "exporting"}
        drawMode={s.drawMode}
        hasSelection={s.selectionPolygon !== null}
        onStartDraw={s.startDraw}
        onClearSelection={s.clearSelection}
        onExportAll={s.doExportAll}
        onExportSelection={s.doExportSelection}
        onRefresh={onRefresh}
        onSearch={onSearch}
        onClearBaseline={() => setConfirmingClear(true)}
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
        onResize={px => s.setPanelSize("left", px)}
        onResizeEnd={() => s.persistPanelSize("left")}
      />
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
        onResize={px => s.setPanelSize("right", px)}
        onResizeEnd={() => s.persistPanelSize("right")}
      />
      <OutputPanel
        open={outputOpen}
        onToggle={() => setOutputOpen(o => !o)}
        logs={s.logs}
        phase={s.phase}
        onClearLogs={s.clearLogs}
        onResize={px => s.setPanelSize("bottom", px)}
        onResizeEnd={() => s.persistPanelSize("bottom")}
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

      {/* F14 清除基线确认 */}
      {confirmingClear && (
        <ConfirmDialog
          title="清除基线数据"
          body={
            "此操作将清空 site / road / lessor 三表的所有数据。\n" +
            "本操作不可撤销，主基准区域也会被重置。\n" +
            "确定继续吗?"
          }
          confirmLabel="确定清除"
          cancelLabel="取消"
          destructive
          onConfirm={() => {
            setConfirmingClear(false);
            s.doClearBaseline();
          }}
          onCancel={() => setConfirmingClear(false)}
        />
      )}
    </div>
  );
}
