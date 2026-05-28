import { useEffect, useState } from "react";
import { LogEntry, Phase } from "../state";

interface Props {
  open: boolean;
  onToggle: () => void;
  logs: LogEntry[];
  phase: Phase;
  onClearLogs: () => void;
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: "就绪",
  uploading: "上传 + 解析中...",
  awaiting_decision: "等待用户处理冲突",
  committing: "入库中...",
  exporting: "导出中...",
};

const PHASE_BUSY: Record<Phase, boolean> = {
  idle: false,
  uploading: true,
  awaiting_decision: false,
  committing: true,
  exporting: true,
};

export default function OutputPanel({ open, onToggle, logs, phase, onClearLogs }: Props) {
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
  const dotLabel = dbOk === null ? "DB 检测中" : dbOk ? "DB 已连接" : "DB 断开";
  const latest = logs[logs.length - 1];
  const showBar = phase !== "idle";

  return (
    <div className="output">
      <div className="bar" onClick={onToggle}>
        <span>{open ? "▾" : "▸"}</span>
        <span className="phase-label">
          {showBar ? PHASE_LABEL[phase] : latest ? `${latest.ts} ${latest.msg}` : "就绪"}
        </span>
        {showBar && (
          <div className={`progress ${PHASE_BUSY[phase] ? "indeterminate" : "paused"}`}>
            <div className="bar-inner" />
          </div>
        )}
        <div className="status">
          <span className={dotClass} />
          <span>{dotLabel}</span>
        </div>
      </div>
      {open && (
        <div className="body">
          <div className="body-head">
            <span className="muted">日志（最近 50 条）</span>
            <button
              className="clear-btn"
              onClick={(e) => { e.stopPropagation(); onClearLogs(); }}
              disabled={logs.length === 0}
              title="清空日志"
            >清空</button>
          </div>
          {logs.length === 0 && <div className="row muted">暂无日志</div>}
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
