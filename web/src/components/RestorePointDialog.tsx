import { useCallback, useEffect, useState } from "react";
import {
  RestorePoint,
  createRestorePoint,
  deleteRestorePoint,
  listRestorePoints,
  rollbackToPoint,
} from "../api";
import { I18nKey, useLang, useT } from "../i18n";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  onClose: () => void;
  onRolledBack: () => void;
}

const REASON_KEY: Record<RestorePoint["reason"], I18nKey> = {
  pre_import:    "rp.reason.pre_import",
  pre_clear:     "rp.reason.pre_clear",
  pre_rollback:  "rp.reason.pre_rollback",
  manual:        "rp.reason.manual",
};

const REASON_CLASS: Record<RestorePoint["reason"], string> = {
  pre_import:    "badge-import",
  pre_clear:     "badge-clear",
  pre_rollback:  "badge-rollback",
  manual:        "badge-manual",
};

export default function RestorePointDialog({ onClose, onRolledBack }: Props) {
  const tFn = useT();
  const { lang } = useLang();
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
    new Date(iso).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
      month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });

  return (
    <div className="modal-mask">
      <div className="modal restore-dialog">
        <div className="modal-header">
          <h2>{tFn("rp.title")}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="restore-toolbar">
          <button onClick={handleCreate} disabled={busy}>
            {tFn("rp.create")}
          </button>
          <button
            onClick={handleUndoImport}
            disabled={busy || !lastImport}
            title={lastImport ? tFn("rp.undo.tip") : tFn("rp.undo.none.tip")}
          >
            {tFn("rp.undo")}
          </button>
        </div>

        <div className="restore-list">
          {loading && <div className="restore-empty">{tFn("rp.loading")}</div>}
          {!loading && points.length === 0 && (
            <div className="restore-empty">{tFn("rp.empty")}</div>
          )}
          {!loading && points.map(rp => (
            <div key={rp.id} className="restore-row">
              <div className="restore-meta">
                <span className={`restore-badge ${REASON_CLASS[rp.reason]}`}>
                  {tFn(REASON_KEY[rp.reason])}
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
                  {tFn("rp.rollback")}
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => handleDelete(rp.id)}
                >
                  {tFn("rp.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {confirmRollback && (
        <ConfirmDialog
          title={tFn("rp.confirm.title")}
          body={tFn("rp.confirm.body", {
            reason: tFn(REASON_KEY[confirmRollback.reason]),
            time: fmt(confirmRollback.created_at),
            s: confirmRollback.site_count ?? 0,
            r: confirmRollback.road_count ?? 0,
            l: confirmRollback.lessor_count ?? 0,
          })}
          confirmLabel={tFn("rp.confirm.ok")}
          cancelLabel={tFn("rp.confirm.cancel")}
          destructive
          onConfirm={() => handleRollback(confirmRollback)}
          onCancel={() => setConfirmRollback(null)}
        />
      )}
    </div>
  );
}
