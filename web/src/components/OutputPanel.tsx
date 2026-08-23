import { useEffect, useState } from "react";
import { I18nKey, useT } from "../i18n";
import { LogEntry, PANEL_LIMITS, Phase } from "../state";
import ResizeHandle from "./ResizeHandle";

interface Props {
  open: boolean;
  onToggle: () => void;
  logs: LogEntry[];
  phase: Phase;
  onClearLogs: () => void;
  onResize: (px: number) => void;
  onResizeEnd: () => void;
  importProgress: { done: number; total: number; pct: number } | null;  // #39
}

const PHASE_KEY: Record<Phase, I18nKey> = {
  idle:       "phase.idle",
  loading:    "phase.loading",
  uploading:  "phase.uploading",
  cleaning:   "phase.cleaning",
  conflicts:  "phase.conflicts",
  committing: "phase.committing",
  exporting:  "phase.exporting",
};

const PHASE_BUSY: Record<Phase, boolean> = {
  idle: false,
  loading: true,
  uploading: true,
  cleaning: false,
  conflicts: false,
  committing: true,
  exporting: true,
};

export default function OutputPanel({
  open, onToggle, logs, phase, onClearLogs, onResize, onResizeEnd,
  importProgress,
}: Props) {
  const tFn = useT();
  const [dbOk, setDbOk] = useState<boolean | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/health");
        const data = await res.json();
        setDbOk(Boolean(data.db));
      } catch {
        setDbOk(false);
      }
    };
    check();
    const id = setInterval(check, 10000);
    return () => clearInterval(id);
  }, []);

  const dotClass = dbOk === null ? "dot" : dbOk ? "dot ok" : "dot err";
  const dotLabel = dbOk === null ? tFn("op.db.checking") : dbOk ? tFn("op.db.ok") : tFn("op.db.error");
  const latest = logs[logs.length - 1];
  const showBar = phase !== "idle";

  return (
    <div className="output">
      {open && (
        <ResizeHandle
          axis="y" edge="start"
          min={PANEL_LIMITS.bottom.min} max={PANEL_LIMITS.bottom.max}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
        />
      )}
      <div className="bar" onClick={onToggle}>
        <span>{open ? "▾" : "▸"}</span>
        <span className="phase-label">
          {showBar ? tFn(PHASE_KEY[phase]) : latest ? `${latest.ts} ${latest.msg}` : tFn("phase.idle")}
        </span>
        {/* #39：committing 且有进度 → determinate 真百分比；其余 busy 态保持 indeterminate */}
        {showBar && (
          phase === "committing" && importProgress && importProgress.total > 0 ? (
            <div className="progress determinate">
              <div className="bar-inner" style={{ width: `${importProgress.pct}%` }} />
            </div>
          ) : (
            <div className={`progress ${PHASE_BUSY[phase] ? "indeterminate" : "paused"}`}>
              <div className="bar-inner" />
            </div>
          )
        )}
        {phase === "committing" && importProgress && importProgress.total > 0 && (
          <span className="commit-progress-text">
            {tFn("op.commit_progress", {
              done: importProgress.done,
              total: importProgress.total,
              pct: importProgress.pct,
            })}
          </span>
        )}
        {/* #38：软件版本号 + 构建时间（构建时注入，DB 状态圆点旁）*/}
        <span
          className="app-version"
          onClick={e => e.stopPropagation()}
          title={`版本 ${__APP_VERSION__} · 构建 ${__BUILD_TIME__}`}
        >
          v{__APP_VERSION__} · {__BUILD_TIME__}
        </span>
        <div className="status">
          <span className={dotClass} />
          <span>{dotLabel}</span>
        </div>
      </div>
      {open && (
        <div className="body">
          <div className="body-head">
            <span className="muted">{tFn("op.logs.header")}</span>
            <button
              className="clear-btn"
              onClick={(e) => { e.stopPropagation(); onClearLogs(); }}
              disabled={logs.length === 0}
              title={tFn("op.logs.clear")}
            >{tFn("op.logs.clear")}</button>
          </div>
          {logs.length === 0 && <div className="row muted">{tFn("op.logs.empty")}</div>}
          {logs.map((l, i) => (
            <div key={i} className={`row ${l.level}`}>
              [{l.ts}] {l.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
