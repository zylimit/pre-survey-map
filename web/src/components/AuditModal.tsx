import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { AuditAction, AuditLogItem, exportAuditLog, listAuditLog } from "../api";
import { I18nKey, useLang, useT } from "../i18n";

interface Props {
  onClose: () => void;
}

const ACTIONS: AuditAction[] = [
  "open",
  "import",
  "export_full",
  "export_region",
  "export_conflicts",
  "clear_baseline",
  "restore_point_create_auto",
  "restore_point_create_manual",
  "restore_point_delete",
  "restore_point_rollback",
  "restore_point_undo_last_import",
  "audit_log_export",
];

const ACTION_KEY: Record<AuditAction, I18nKey> = {
  open:                            "audit.action.open",
  import:                          "audit.action.import",
  export_full:                     "audit.action.export_full",
  export_region:                   "audit.action.export_region",
  export_conflicts:                "audit.action.export_conflicts",
  clear_baseline:                  "audit.action.clear_baseline",
  restore_point_create_auto:       "audit.action.rp_create_auto",
  restore_point_create_manual:     "audit.action.rp_create_manual",
  restore_point_delete:            "audit.action.rp_delete",
  restore_point_rollback:          "audit.action.rp_rollback",
  restore_point_undo_last_import:  "audit.action.rp_undo_last_import",
  audit_log_export:                "audit.action.audit_log_export",
};

const PAGE_SIZE = 50;

// 时间筛选范围预设值（小时数）
const TIME_PRESETS: { key: I18nKey; hours: number | null }[] = [
  { key: "audit.filter.time.all",    hours: null },
  { key: "audit.filter.time.1h",     hours: 1 },
  { key: "audit.filter.time.24h",    hours: 24 },
  { key: "audit.filter.time.7d",     hours: 24 * 7 },
  { key: "audit.filter.time.30d",    hours: 24 * 30 },
];

export default function AuditModal({ onClose }: Props) {
  const tFn = useT();
  const { lang } = useLang();
  const [items, setItems] = useState<AuditLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState<string>("");
  const [timePresetIdx, setTimePresetIdx] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const filters = useMemo(() => {
    const f: { action?: string; from?: string; to?: string } = {};
    if (actionFilter) f.action = actionFilter;
    const preset = TIME_PRESETS[timePresetIdx];
    if (preset && preset.hours != null) {
      const ms = preset.hours * 3600 * 1000;
      f.from = new Date(Date.now() - ms).toISOString();
    }
    return f;
  }, [actionFilter, timePresetIdx]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAuditLog(filters, page, PAGE_SIZE);
      setItems(res.items);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => { load(); }, [load]);

  // 筛选变化重置页码
  useEffect(() => { setPage(1); }, [actionFilter, timePresetIdx]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fmtTs = (iso: string) => new Date(iso).toLocaleString(
    lang === "zh" ? "zh-CN" : "en-US",
    { year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit" }
  );

  const fmtAction = (a: AuditAction) => tFn(ACTION_KEY[a] ?? "audit.action.open");

  const summarizeDetails = (it: AuditLogItem): string => {
    const d = it.details ?? {};
    const parts: string[] = [];
    if (d["file_name"]) parts.push(`file: ${d["file_name"]}`);
    if (d["counts"]) {
      const c = d["counts"] as Record<string, number>;
      const counts = Object.entries(c).map(([k, v]) => `${k}=${v}`).join(", ");
      if (counts) parts.push(`counts: {${counts}}`);
    }
    if (d["restore_point_id"] != null) parts.push(`rp#${d["restore_point_id"]}`);
    if (d["reason"]) parts.push(`reason: ${d["reason"]}`);
    if (d["exported_rows"] != null) parts.push(`rows: ${d["exported_rows"]}`);
    if (d["path"]) parts.push(`path: ${d["path"]}`);
    return parts.join(" · ") || "—";
  };

  const handleExport = async () => {
    setBusy(true);
    try {
      await exportAuditLog(filters);
      // 元审计触发后，下一次 reload 能看到那条 audit_log_export
      setTimeout(() => load(), 300);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal audit-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{tFn("audit.title")}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="audit-toolbar">
          <label>
            <span>{tFn("audit.filter.action")}</span>
            <select
              value={actionFilter}
              onChange={e => setActionFilter(e.target.value)}
            >
              <option value="">{tFn("audit.filter.action.all")}</option>
              {ACTIONS.map(a => (
                <option key={a} value={a}>{fmtAction(a)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{tFn("audit.filter.time")}</span>
            <select
              value={timePresetIdx}
              onChange={e => setTimePresetIdx(Number(e.target.value))}
            >
              {TIME_PRESETS.map((p, i) => (
                <option key={p.key} value={i}>{tFn(p.key)}</option>
              ))}
            </select>
          </label>
          <div className="audit-toolbar-spacer" />
          <button
            className="primary"
            onClick={handleExport}
            disabled={busy || loading || total === 0}
            title={tFn("audit.export.tip")}
          >
            {tFn("audit.export")}
          </button>
        </div>

        <div className="audit-table-wrap">
          <table className="audit-table">
            <thead>
              <tr>
                <th className="col-ts">{tFn("audit.col.ts")}</th>
                <th className="col-action">{tFn("audit.col.action")}</th>
                <th className="col-details">{tFn("audit.col.details")}</th>
                <th className="col-ip">{tFn("audit.col.ip")}</th>
                <th className="col-ua">{tFn("audit.col.ua")}</th>
                <th className="col-sid">{tFn("audit.col.session")}</th>
                <th className="col-result">{tFn("audit.col.result")}</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="audit-empty">{tFn("audit.loading")}</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={7} className="audit-empty">{tFn("audit.empty")}</td></tr>
              )}
              {!loading && items.map(it => {
                const open = expanded === it.id;
                const uaShort = (it.user_agent || "").slice(0, 36);
                const sidShort = (it.session_id || "").slice(0, 8);
                return (
                  <Fragment key={it.id}>
                    <tr
                      className={`audit-row ${open ? "audit-row-open" : ""} ${it.result !== "success" ? "audit-row-err" : ""}`}
                      onClick={() => setExpanded(open ? null : it.id)}
                    >
                      <td className="col-ts">{fmtTs(it.ts)}</td>
                      <td className="col-action">
                        <span className={`audit-badge audit-act-${it.action}`}>
                          {fmtAction(it.action)}
                        </span>
                      </td>
                      <td className="col-details" title={summarizeDetails(it)}>
                        {summarizeDetails(it)}
                      </td>
                      <td className="col-ip">{it.ip ?? "—"}</td>
                      <td className="col-ua" title={it.user_agent ?? ""}>{uaShort || "—"}</td>
                      <td className="col-sid" title={it.session_id ?? ""}><code>{sidShort || "—"}</code></td>
                      <td className="col-result">{it.result}</td>
                    </tr>
                    {open && (
                      <tr className="audit-row-detail">
                        <td colSpan={7}>
                          <pre>{JSON.stringify(it.details ?? {}, null, 2)}</pre>
                          {it.error_msg && (
                            <pre className="audit-err">{it.error_msg}</pre>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="audit-pager">
          <span className="audit-total">
            {tFn("audit.total", { n: total })}
          </span>
          <div className="audit-pager-btns">
            <button
              disabled={page <= 1 || loading}
              onClick={() => setPage(1)}
            >« {tFn("audit.pager.first")}</button>
            <button
              disabled={page <= 1 || loading}
              onClick={() => setPage(p => Math.max(1, p - 1))}
            >‹ {tFn("audit.pager.prev")}</button>
            <span className="audit-pager-cur">{page} / {totalPages}</span>
            <button
              disabled={page >= totalPages || loading}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            >{tFn("audit.pager.next")} ›</button>
            <button
              disabled={page >= totalPages || loading}
              onClick={() => setPage(totalPages)}
            >{tFn("audit.pager.last")} »</button>
          </div>
        </div>
      </div>
    </div>
  );
}
