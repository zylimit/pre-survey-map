import { useCallback, useEffect, useState } from "react";
import Toolbar from "./components/Toolbar";
import LayerTree from "./components/LayerTree";
import MapView from "./components/MapView";
import AttributePanel from "./components/AttributePanel";
import OutputPanel from "./components/OutputPanel";
import ConflictDialog from "./components/ConflictDialog";
import { useAppState } from "./state";

export default function App() {
  const [outputOpen, setOutputOpen] = useState(false);
  const s = useAppState();

  useEffect(() => {
    s.refresh().catch(err => s.log("error", `首次加载失败：${err.message ?? err}`));
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

  return (
    <div className={`app ${s.selected ? "" : "no-attr"}`}>
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
      />
      <LayerTree
        sites={s.sites}
        roads={s.roads}
        lessors={s.lessors}
        selectedId={selectedId}
        hiddenIds={s.hiddenIds}
        onPick={s.flyTo}
        onToggleFeature={s.toggleFeatureVisible}
        onSetKindVisible={s.setKindVisible}
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
        onDropFiles={s.importFiles}
        onSelectFeature={s.selectFeature}
        onSelectionDrawn={s.onSelectionDrawn}
        onFitAll={s.fitAll}
      />
      <AttributePanel feature={s.selected} onClose={() => s.selectFeature(null)} />
      <OutputPanel
        open={outputOpen}
        onToggle={() => setOutputOpen(o => !o)}
        logs={s.logs}
        phase={s.phase}
        onClearLogs={s.clearLogs}
      />

      {s.importSession && (
        <ConflictDialog
          conflicts={s.importSession.conflicts}
          initial={s.importSession.decisions}
          onConfirm={s.confirmConflicts}
          onCancel={s.abortConflicts}
        />
      )}
    </div>
  );
}
