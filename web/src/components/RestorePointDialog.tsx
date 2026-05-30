import { useCallback, useEffect, useState } from "react";
import {
  RestorePoint,
  createRestorePoint,
  deleteRestorePoint,
  listRestorePoints,
  rollbackToPoint,
} from "../api";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  onClose: () => void;
  onRolledBack: () => void;  // 回滚后刷新地图 + 基线状态
}

const REASON_LABEL: Record<RestorePoint["reason"], string> = {
  pre_import: "导入前",
  pre_clear:  "清除前",
  pre_rollback: "回滚前",
  manual:     "手动",
};

const REASON_CLASS: Record<RestorePoint["reason"], string> = {
  pre_import:   "badge-import",
  pre_clear:    "badge-clear",
  pre_rollback: "badge-rollback",
  manual:       "badge-manual",
};

export default function RestorePointDialog({ onClose, onRolledBack }: Props) {
  const [points, setPoints] = useState<RestorePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState<RestorePoint | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPoints(await listRestorePoints());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const lastImport = points.find(p => p.reason === "pre_import") ?? null;

  const handleCreate = async () => {
    setBusy(true);
    try {
      await createRestorePoint();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const handleUndoImport = () => {
    if (!lastImport) return;
    setConfirmRollback(lastImport);
  };

  const handleRollback = async (rp: RestorePoint) => {
    setBusy(true);
    try {
      await rollbackToPoint(rp.id);
      await load();
      onRolledBack();
    } finally {
      setBusy(false);
      setConfirmRollback(null);
    }
  };

  const handleDelete = async (id: number) => {
    setBusy(true);
    try {
      await deleteRestorePoint(id);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });

  return (
    <div className="modal-mask">
      <div className="modal restore-dialog">
        <div className="modal-header">
          <h2>🕘 恢复点</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="restore-toolbar">
          <button onClick={handleCreate} disabled={busy}>
            + 手动建恢复点
          </button>
          <button
            onClick={handleUndoImport}
            disabled={busy || !lastImport}
            title={lastImport ? "回滚到最近一次导入前的状态" : "没有可撤销的导入记录"}
          >
            ↩ 撤销上一次导入
          </button>
        </div>

        <div className="restore-list">
          {loading && <div className="restore-empty">加载中...</div>}
          {!loading && points.length === 0 && (
            <div className="restore-empty">暂无恢复点</div>
          )}
          {!loading && points.map(rp => (
            <div key={rp.id} className="restore-row">
              <div className="restore-meta">
                <span className={`restore-badge ${REASON_CLASS[rp.reason]}`}>
                  {REASON_LABEL[rp.reason]}
                </span>
                <span className="restore-time">{fmt(rp.created_at)}</span>
                {rp.baseline_iso_a2 && (
                  <span className="restore-country">{rp.baseline_iso_a2}</span>
                )}
              </div>
              <div className="restore-counts">
                site {rp.site_count ?? 0} · road {rp.road_count ?? 0} · lessor {rp.lessor_count ?? 0}
                {rp.note && <span className="restore-note"> · {rp.note}</span>}
              </div>
              <div className="restore-actions">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => setConfirmRollback(rp)}
                >
                  回滚
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => handleDelete(rp.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {confirmRollback && (
        <ConfirmDialog
          title="覆盖式回滚"
          body={
            `回滚到「${REASON_LABEL[confirmRollback.reason]}」恢复点\n` +
            `（${fmt(confirmRollback.created_at)}，` +
            `site ${confirmRollback.site_count ?? 0} · road ${confirmRollback.road_count ?? 0} · lessor ${confirmRollback.lessor_count ?? 0}）\n\n` +
            "当前数据将被完全替换。\n" +
            "回滚前会自动建一个「回滚前」恢复点，可再退回。\n\n" +
            "确定继续？"
          }
          confirmLabel="确定回滚"
          cancelLabel="取消"
          destructive
          onConfirm={() => handleRollback(confirmRollback)}
          onCancel={() => setConfirmRollback(null)}
        />
      )}
    </div>
  );
}
