/**
 * #50 Phase 14 · 角色管理 tab（Spec F22「管理界面」节）
 *
 * 角色列表（名称/功能权限摘要/用户数）+ [新建角色] / [编辑] / [删除]。
 * 编辑表单 = 名称 + 4 个功能权限 checkbox + ScopeTree 数据权限勾选树。
 * is_admin 内置角色只读展示（不渲染编辑/删除）；删除有用户挂载的角色 → 400 detail 透出。
 */
import { useCallback, useEffect, useState } from "react";
import {
  AdminRole,
  createAdminRole,
  deleteAdminRole,
  listAdminRoles,
  updateAdminRole,
} from "../../api";
import { I18nKey, useT } from "../../i18n";
import ConfirmDialog from "../ConfirmDialog";
import { mapAdminErr } from "./AdminModal";
import ScopeTree from "./ScopeTree";

// 功能权限 4 开关（与后端 admin/validators.py PERM_KEYS 对齐）
const PERM_KEYS: { key: string; labelKey: I18nKey }[] = [
  { key: "import", labelKey: "admin.perm.import" },
  { key: "export", labelKey: "admin.perm.export" },
  { key: "edit_delete", labelKey: "admin.perm.edit_delete" },
  { key: "danger", labelKey: "admin.perm.danger" },
];

interface Draft {
  id: number | null;    // null = 新建
  name: string;
  perms: Record<string, boolean>;
  scopes: string[];
}

const EMPTY_PERMS: Record<string, boolean> = {
  import: false, export: false, edit_delete: false, danger: false,
};

export default function RolesTab() {
  const tFn = useT();
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminRole | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRoles(await listAdminRoles());
    } catch (e: unknown) {
      setError(mapAdminErr(e instanceof Error ? e.message : String(e), tFn));
    } finally {
      setLoading(false);
    }
  }, [tFn]);

  useEffect(() => { void load(); }, [load]);

  const runOp = async (op: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await op();
      await load();
      return true;
    } catch (e: unknown) {
      setError(mapAdminErr(e instanceof Error ? e.message : String(e), tFn));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (r: AdminRole) =>
    setDraft({ id: r.id, name: r.name, perms: { ...EMPTY_PERMS, ...r.perms }, scopes: r.scopes });

  const submitDraft = async () => {
    if (!draft || !draft.name.trim()) return;
    const ok = await runOp(() =>
      draft.id == null
        ? createAdminRole(draft.name.trim(), draft.perms, draft.scopes)
        : updateAdminRole(draft.id, { name: draft.name.trim(), perms: draft.perms, scopes: draft.scopes }),
    );
    if (ok) setDraft(null);
  };

  const permsSummary = (r: AdminRole): string => {
    if (r.is_admin) return tFn("admin.roles.perms_all");
    const on = PERM_KEYS.filter(p => r.perms[p.key]).map(p => tFn(p.labelKey));
    return on.length ? on.join(" · ") : "—";
  };

  return (
    <div className="admin-pane">
      <div className="admin-toolbar">
        <button
          className="primary"
          disabled={busy}
          onClick={() => setDraft(draft ? null : { id: null, name: "", perms: { ...EMPTY_PERMS }, scopes: [] })}
        >
          {tFn("admin.roles.create")}
        </button>
      </div>

      {error && <div className="login-err admin-err">{error}</div>}

      {draft && (
        <form
          className="admin-form admin-role-form"
          onSubmit={e => { e.preventDefault(); void submitDraft(); }}
        >
          <div className="admin-form-row">
            <input
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              placeholder={tFn("admin.roles.form.name")}
              autoComplete="off"
              disabled={busy}
            />
            <button type="submit" className="primary" disabled={busy || !draft.name.trim()}>
              {tFn("admin.form.submit")}
            </button>
            <button type="button" disabled={busy} onClick={() => setDraft(null)}>
              {tFn("admin.form.cancel")}
            </button>
          </div>
          <div className="admin-form-row admin-perms-row">
            <span className="admin-form-label">{tFn("admin.roles.perms.legend")}</span>
            {PERM_KEYS.map(p => (
              <label key={p.key} className="admin-perm-item">
                <input
                  type="checkbox"
                  checked={Boolean(draft.perms[p.key])}
                  disabled={busy}
                  onChange={e => setDraft({ ...draft, perms: { ...draft.perms, [p.key]: e.target.checked } })}
                />
                <span>{tFn(p.labelKey)}</span>
              </label>
            ))}
          </div>
          <div className="admin-form-row admin-scopes-row">
            <span className="admin-form-label">{tFn("admin.roles.scopes.legend")}</span>
            <ScopeTree
              value={draft.scopes}
              disabled={busy}
              onChange={scopes => setDraft({ ...draft, scopes })}
            />
          </div>
        </form>
      )}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>{tFn("admin.roles.col.name")}</th>
              <th>{tFn("admin.roles.col.perms")}</th>
              <th>{tFn("admin.roles.col.users")}</th>
              <th>{tFn("admin.roles.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={4} className="audit-empty">{tFn("admin.loading")}</td></tr>
            )}
            {!loading && roles.length === 0 && (
              <tr><td colSpan={4} className="audit-empty">{tFn("admin.roles.empty")}</td></tr>
            )}
            {!loading && roles.map(r => (
              <tr key={r.id}>
                <td>
                  {r.name}
                  {r.is_admin && <span className="admin-badge">{tFn("admin.roles.builtin")}</span>}
                </td>
                <td className="admin-perms-summary">{permsSummary(r)}</td>
                <td>{r.user_count}</td>
                <td className="admin-row-actions">
                  {!r.is_admin && (
                    <>
                      <button disabled={busy} onClick={() => startEdit(r)}>
                        {tFn("admin.roles.edit")}
                      </button>
                      <button className="danger" disabled={busy} onClick={() => setDeleteTarget(r)}>
                        {tFn("admin.roles.delete")}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title={tFn("admin.roles.delete.confirm.title")}
          body={tFn("admin.roles.delete.confirm.body", { name: deleteTarget.name })}
          confirmLabel={tFn("admin.roles.delete")}
          cancelLabel={tFn("admin.form.cancel")}
          destructive
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            void runOp(() => deleteAdminRole(target.id));
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
