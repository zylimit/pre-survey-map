import { useCallback, useEffect, useMemo, useState } from "react";
import { t, useT } from "./i18n";
import Toolbar from "./components/Toolbar";
import LayerTree from "./components/LayerTree";
import LayerFeatureList from "./components/LayerFeatureList";
import MapView from "./components/MapView";
import AttributePanel from "./components/AttributePanel";
import OutputPanel from "./components/OutputPanel";
import ConflictDialog from "./components/ConflictDialog";
import CleaningDialog from "./components/CleaningDialog";
import ConfirmDialog from "./components/ConfirmDialog";
import LoginPage, { ForcePasswordModal } from "./components/LoginPage";
import RestorePointDialog from "./components/RestorePointDialog";
import DeleteHistoryPanel from "./components/DeleteHistoryPanel";
import BaselineStatusBar from "./components/BaselineStatusBar";
import AuditPasswordPrompt from "./components/AuditPasswordPrompt";
import AuditModal from "./components/AuditModal";
import BackupRestoreDialog from "./components/BackupRestoreDialog";
import { useEscTrigger } from "./hooks/useEscTrigger";
import { useKeyTrigger } from "./hooks/useKeyTrigger";
import { useAppState } from "./state";
import { NP_RADIUS_KEY, NP_RADIUS_OPTIONS, readNpRadius } from "./utils";

export default function App() {
  const [outputOpen, setOutputOpen] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [restorePointsOpen, setRestorePointsOpen] = useState(false);
  const [deleteHistoryOpen, setDeleteHistoryOpen] = useState(false);
  const [auditPwdOpen, setAuditPwdOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  // #42：3×B → 密码门 → 备份恢复 Modal
  const [backupPwdOpen, setBackupPwdOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupPwd, setBackupPwd] = useState("");
  const [npRadiusM, setNpRadiusM] = useState<number>(readNpRadius);
  const s = useAppState();
  const tFn = useT();

  // #45：改半径 → 写 localStorage + 更新 state（state 变化驱动 MapView 重绘）
  const onChangeNpRadius = useCallback((m: number) => {
    if (!(NP_RADIUS_OPTIONS as readonly number[]).includes(m)) return;
    setNpRadiusM(m);
    try { localStorage.setItem(NP_RADIUS_KEY, String(m)); } catch { /* 忽略写入失败 */ }
  }, []);

  // F19 隐藏入口：3 次 Esc（间隔 < 1s）→ 密码框 → Audit Modal
  // #39：导入提交中（uploading/committing）屏蔽 ESC，防误弹审计 / 防中断对话框
  // #50：未通过认证闸门（登录页/改密页）时也屏蔽，防登录后误弹
  const importBusy = s.phase === "uploading" || s.phase === "committing";
  // #50：认证闸门（me 通过且无需强制改密）；未过闸门时屏蔽隐藏入口 + 不拉数据
  const authed = s.currentUser !== null && !s.currentUser.must_change_password;
  useEscTrigger(() => {
    // 已打开任意一个就不再弹
    if (auditPwdOpen || auditOpen) return;
    setAuditPwdOpen(true);
  }, 3, 1000, authed && !importBusy);

  // #42 隐藏入口：连按 3 次 B → 密码框 → 备份恢复 Modal（输入态/导入中屏蔽）
  useKeyTrigger("KeyB", () => {
    if (backupPwdOpen || backupOpen) return;
    setBackupPwdOpen(true);
  }, 3, 1000, authed && !importBusy);

  // #50 Phase 13 启动闸门：me 验证未完成 → 启动画面；无 token/验证失败 → 登录页
  useEffect(() => {
    void s.checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主界面数据只在 me 通过且无需强制改密后才拉（不先闪一屏全量数据）
  useEffect(() => {
    if (!authed) return;
    s.refresh().catch(err => s.log("error", t("log.load_err", { msg: err.message ?? String(err) })));
    s.refreshBaselineState();  // F15：启动时拉一次主基准状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

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

  // #50 Phase 13 渲染闸门：启动画面 → 登录页 → 强制改密（不可关闭）→ 主界面
  if (!s.authChecked) {
    return <div className="boot-splash">⏳ {tFn("auth.checking")}</div>;
  }
  if (!s.currentUser) {
    return <LoginPage onLogin={s.doLogin} />;
  }
  if (s.currentUser.must_change_password) {
    return <ForcePasswordModal onSubmit={s.doChangePassword} />;
  }

  return (
    <div className={`app ${s.selected ? "" : "no-attr"}`} style={gridStyle}>
      <Toolbar
        busy={s.phase === "loading" || s.phase === "uploading" || s.phase === "committing" || s.phase === "exporting"}
        drawMode={s.drawMode}
        hasSelection={s.selectionPolygon !== null}
        npRadiusM={npRadiusM}
        username={s.currentUser.username}
        isAdmin={s.currentUser.is_admin}
        onLogout={s.doLogout}
        onStartDraw={s.startDraw}
        onClearSelection={s.clearSelection}
        onExportAll={() => s.doExportAll(npRadiusM)}
        onExportSelection={() => s.doExportSelection(npRadiusM)}
        onRefresh={onRefresh}
        onSearch={onSearch}
        onClearBaseline={() => setConfirmingClear(true)}
        onOpenRestorePoints={() => setRestorePointsOpen(true)}
        onOpenDeleteHistory={() => setDeleteHistoryOpen(true)}
        onChangeNpRadius={onChangeNpRadius}
      />
      {/* F15 全局基线状态栏（Spec V1.x #15）*/}
      <BaselineStatusBar state={s.baselineState} />
      <LayerTree
        sites={s.sites}
        roads={s.roads}
        lessors={s.lessors}
        selectedId={selectedId}
        hiddenIds={s.hiddenIds}
        onSetKindVisible={s.setKindVisible}
        onImportLayer={s.importLayerFile}
        onViewLayer={s.toggleLayerFeatures}
        phase={s.phase}
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
        npRadiusM={npRadiusM}
        onDropDisabled={s.notifyDropDisabled}
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
        importProgress={s.importProgress}
      />

      {/* F20 Phase 4/#30：查看图层要素浮动窗口（非 modal，可拖可缩）。
          不再用 key 重挂载——切图层只换 target、窗口位置/尺寸不动（#30 拍板）；
          筛选/滚动复位改由组件内 useEffect([target]) 处理。anchor=首次开窗定位锚。 */}
      {s.viewLayer && (
        <LayerFeatureList
          target={s.viewLayer.target}
          anchor={s.viewLayer.anchor}
          sites={s.sites}
          roads={s.roads}
          lessors={s.lessors}
          selectedId={selectedId}
          onPick={s.flyTo}
          onClose={s.closeLayerFeatures}
          onUpdateSite={s.doUpdateSite}
          onDeleteSites={s.doDeleteSites}
          onExportSites={(keys) => s.doExportSelectionIds(keys, npRadiusM)}
        />
      )}

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
          busy={importBusy}
        />
      )}
      {s.importSession && s.importSession.step === "conflicts" && (
        <ConflictDialog
          conflicts={s.importSession.conflicts}
          initial={s.importSession.conflictDecisions}
          onConfirm={s.confirmConflicts}
          onCancel={s.abortImport}
          onBack={s.goBackToCleaning}
          busy={importBusy}
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

      {/* #49 Phase 9：持久「删除历史」面板（逐批撤销删除） */}
      {deleteHistoryOpen && (
        <DeleteHistoryPanel
          onClose={() => setDeleteHistoryOpen(false)}
          onUndo={s.doUndoDelete}
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

      {/* #42 隐藏备份恢复入口（3×B） */}
      {backupPwdOpen && (
        <AuditPasswordPrompt
          onPass={(pwd) => { setBackupPwd(pwd); setBackupPwdOpen(false); setBackupOpen(true); }}
          onCancel={() => setBackupPwdOpen(false)}
        />
      )}
      {backupOpen && (
        <BackupRestoreDialog
          password={backupPwd}
          onClose={() => { setBackupOpen(false); setBackupPwd(""); }}
          onRestored={async () => {
            await s.refresh();
            await s.refreshBaselineState();
          }}
        />
      )}
    </div>
  );
}
