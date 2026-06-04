import { useCallback, useEffect, useState } from "react";
import { DeleteHistoryItem, fetchDeleteHistory } from "../api";
import { useLang, useT } from "../i18n";

interface Props {
  onClose: () => void;
  // 撤销某批；返回 null=成功 / string=可读错误（state.doUndoDelete）
  onUndo: (undoId: number) => Promise<string | null>;
}

// #49 Phase 9：持久「删除历史」面板（参照 RestorePointDialog 列表+逐条操作范式）。
export default function DeleteHistoryPanel({ onClose, onUndo }: Props) {
  const tFn = useT();
  const { lang } = useLang();
  const [items, setItems] = useState<DeleteHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchDeleteHistory());
    } catch (e: unknown) {
      // 修复3：加载失败不静默/不 unhandled rejection → 面板内显错误文案
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleUndo = async (undoId: number) => {
    setBusy(true);
    try {
      const err = await onUndo(undoId);
      if (!err) await load();  // 成功后刷新列表（该批 undone 置灰）
    } finally {
      setBusy(false);
    }
  };

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
          month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
        })
      : "—";

  return (
    <div className="modal-mask">
      <div className="modal restore-dialog">
        <div className="modal-header">
          <h2>{tFn("dh.title")}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="restore-list">
          {loading && <div className="restore-empty">{tFn("dh.loading")}</div>}
          {!loading && error && (
            <div className="restore-empty lfl-edit-err">{tFn("dh.load_err", { msg: error })}</div>
          )}
          {!loading && !error && items.length === 0 && (
            <div className="restore-empty">{tFn("dh.empty")}</div>
          )}
          {!loading && !error && items.map(it => (
            <div key={it.undo_id} className={`restore-row${it.undone ? " is-undone" : ""}`}>
              <div className="restore-meta">
                <span className="restore-time">{fmt(it.deleted_at)}</span>
                <span className="restore-badge badge-clear">
                  {tFn("dh.count", { n: it.count })}
                </span>
                {it.undone && (
                  <span className="restore-badge badge-manual">{tFn("dh.undone")}</span>
                )}
              </div>
              <div className="restore-counts">
                {it.layer}
                {it.sample.length > 0 && (
                  <span className="restore-note">
                    {" "}· {it.sample.join(", ")}
                    {it.count > it.sample.length ? " …" : ""}
                  </span>
                )}
              </div>
              <div className="restore-actions">
                <button
                  className="primary"
                  disabled={busy || it.undone}
                  onClick={() => handleUndo(it.undo_id)}
                  title={it.undone ? tFn("dh.undone") : tFn("dh.undo")}
                >
                  {tFn("dh.undo")}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
