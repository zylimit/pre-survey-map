import { useCallback, useEffect, useState } from "react";
import { Backup, listBackups, restoreBackup } from "../api";
import { useLang, useT } from "../i18n";
import ConfirmDialog from "./ConfirmDialog";

/**
 * #42 · 自动备份恢复 Modal（仿 RestorePointDialog）。
 * 列出 reason='auto_backup' 的备份（时间倒序 + 三类计数）→ 选一个 → 二次确认 → 还原。
 * password 由 3×B 密码门验证后传入（后端 restore 仍二次校验 mangosv5）。
 */
interface Props {
  password: string;
  onClose: () => void;
  onRestored: () => void;
}

export default function BackupRestoreDialog({ password, onClose, onRestored }: Props) {
  const tFn = useT();
  const { lang } = useLang();
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Backup | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBackups(await listBackups());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRestore = async (b: Backup) => {
    setBusy(true);
    try {
      await restoreBackup(b.id, password);
      await load();
      onRestored();
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });

  return (
    <div className="modal-mask">
      <div className="modal restore-dialog">
        <div className="modal-header">
          <h2>{tFn("bk.title")}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="restore-list">
          {loading && <div className="restore-empty">{tFn("bk.loading")}</div>}
          {!loading && backups.length === 0 && (
            <div className="restore-empty">{tFn("bk.empty")}</div>
          )}
          {!loading && backups.map(b => (
            <div key={b.id} className="restore-row">
              <div className="restore-meta">
                <span className="restore-badge badge-rollback">{tFn("bk.badge")}</span>
                <span className="restore-time">{fmt(b.created_at)}</span>
                {b.baseline_iso_a2 && (
                  <span className="restore-country">{b.baseline_iso_a2}</span>
                )}
              </div>
              <div className="restore-counts">
                site {b.site_count ?? 0} · road {b.road_count ?? 0} · lessor {b.lessor_count ?? 0}
              </div>
              <div className="restore-actions">
                <button className="primary" disabled={busy} onClick={() => setConfirm(b)}>
                  {tFn("bk.restore")}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={tFn("bk.confirm.title")}
          body={tFn("bk.confirm.body", {
            time: fmt(confirm.created_at),
            s: confirm.site_count ?? 0,
            r: confirm.road_count ?? 0,
            l: confirm.lessor_count ?? 0,
          })}
          confirmLabel={tFn("bk.confirm.ok")}
          cancelLabel={tFn("bk.confirm.cancel")}
          destructive
          onConfirm={() => handleRestore(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
