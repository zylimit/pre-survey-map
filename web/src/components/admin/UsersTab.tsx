/**
 * #50 Phase 14 · 用户管理 tab（Spec F22「管理界面」节）
 *
 * 表格（用户名/角色/状态/创建时间）+ [新建用户]（用户名+角色下拉+初始密码）
 * + 行操作 [重置密码]（弹输入新密码）/ [禁用·启用]。
 * admin 角色用户行禁用按钮置灰（后端也 400 拒，前端先拦）；操作成功刷新列表；
 * 400 detail 经 mapAdminErr 双语透出。
 */
import { useCallback, useEffect, useState } from "react";
import {
  AdminRole,
  AdminUser,
  createAdminUser,
  listAdminRoles,
  listAdminUsers,
  resetUserPassword,
  toggleUserDisabled,
} from "../../api";
import { useLang, useT } from "../../i18n";
import { mapAdminErr } from "./AdminModal";

export default function UsersTab() {
  const tFn = useT();
  const { lang } = useLang();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 新建用户表单（null = 收起）
  const [draft, setDraft] = useState<{ username: string; role_id: number; password: string } | null>(null);
  // 重置密码目标（null = 未在重置）
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [us, rs] = await Promise.all([listAdminUsers(), listAdminRoles()]);
      setUsers(us);
      setRoles(rs);
    } catch (e: unknown) {
      setError(mapAdminErr(e instanceof Error ? e.message : String(e), tFn));
    } finally {
      setLoading(false);
    }
  }, [tFn]);

  useEffect(() => { void load(); }, [load]);

  const isAdminUser = (u: AdminUser): boolean =>
    roles.find(r => r.id === u.role_id)?.is_admin === true;

  const fmtTs = (iso: string | null) =>
    iso == null
      ? "—"
      : new Date(iso).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit",
        });

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

  const submitCreate = async () => {
    if (!draft || !draft.username.trim() || !draft.password) return;
    const ok = await runOp(() =>
      createAdminUser(draft.username.trim(), draft.role_id, draft.password),
    );
    if (ok) setDraft(null);
  };

  const submitReset = async () => {
    if (!resetTarget || !resetPw) return;
    const ok = await runOp(() => resetUserPassword(resetTarget.id, resetPw));
    if (ok) {
      setResetTarget(null);
      setResetPw("");
    }
  };

  return (
    <div className="admin-pane">
      <div className="admin-toolbar">
        <button
          className="primary"
          disabled={busy}
          onClick={() => setDraft(draft ? null : {
            username: "",
            role_id: roles.find(r => !r.is_admin)?.id ?? roles[0]?.id ?? 0,
            password: "",
          })}
        >
          {tFn("admin.users.create")}
        </button>
      </div>

      {error && <div className="login-err admin-err">{error}</div>}

      {draft && (
        <form
          className="admin-form"
          onSubmit={e => { e.preventDefault(); void submitCreate(); }}
        >
          <input
            value={draft.username}
            onChange={e => setDraft({ ...draft, username: e.target.value })}
            placeholder={tFn("admin.users.form.username")}
            autoComplete="off"
            disabled={busy}
          />
          <select
            value={draft.role_id}
            onChange={e => setDraft({ ...draft, role_id: Number(e.target.value) })}
            disabled={busy}
          >
            {roles.map(r => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <input
            type="password"
            value={draft.password}
            onChange={e => setDraft({ ...draft, password: e.target.value })}
            placeholder={tFn("admin.users.form.password")}
            autoComplete="new-password"
            disabled={busy}
          />
          <button type="submit" className="primary" disabled={busy || !draft.username.trim() || !draft.password}>
            {tFn("admin.form.submit")}
          </button>
          <button type="button" disabled={busy} onClick={() => setDraft(null)}>
            {tFn("admin.form.cancel")}
          </button>
        </form>
      )}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>{tFn("admin.users.col.username")}</th>
              <th>{tFn("admin.users.col.role")}</th>
              <th>{tFn("admin.users.col.status")}</th>
              <th>{tFn("admin.users.col.created")}</th>
              <th>{tFn("admin.users.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="audit-empty">{tFn("admin.loading")}</td></tr>
            )}
            {!loading && users.length === 0 && (
              <tr><td colSpan={5} className="audit-empty">{tFn("admin.users.empty")}</td></tr>
            )}
            {!loading && users.map(u => {
              const adminRow = isAdminUser(u);
              return (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td>{u.role_name ?? "—"}</td>
                  <td className={u.disabled ? "admin-status-off" : "admin-status-on"}>
                    {u.disabled ? tFn("admin.users.status.disabled") : tFn("admin.users.status.enabled")}
                  </td>
                  <td className="admin-col-ts">{fmtTs(u.created_at)}</td>
                  <td className="admin-row-actions">
                    <button
                      disabled={busy}
                      onClick={() => { setResetTarget(u); setResetPw(""); }}
                    >
                      {tFn("admin.users.reset")}
                    </button>
                    <button
                      className={u.disabled ? "" : "danger"}
                      disabled={busy || adminRow}
                      title={adminRow ? tFn("admin.users.disable.admin_tip") : ""}
                      onClick={() => void runOp(() => toggleUserDisabled(u.id))}
                    >
                      {u.disabled ? tFn("admin.users.enable") : tFn("admin.users.disable")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {resetTarget && (
        <div className="modal-mask" onClick={() => setResetTarget(null)}>
          <div className="modal confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{tFn("admin.users.reset.title", { name: resetTarget.username })}</h2>
            </div>
            <form onSubmit={e => { e.preventDefault(); void submitReset(); }}>
              <div className="modal-body force-pw-body">
                <input
                  type="password"
                  value={resetPw}
                  onChange={e => setResetPw(e.target.value)}
                  placeholder={tFn("admin.users.reset.new")}
                  autoComplete="new-password"
                  disabled={busy}
                />
              </div>
              <div className="modal-footer">
                <button type="button" disabled={busy} onClick={() => setResetTarget(null)}>
                  {tFn("admin.form.cancel")}
                </button>
                <button type="submit" className="primary" disabled={busy || !resetPw}>
                  {tFn("admin.form.submit")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
