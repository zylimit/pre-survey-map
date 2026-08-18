/**
 * #50 Phase 14 · 管理 Modal（Spec F22「管理界面」节）
 *
 * 四 tab：用户 / 角色 / 审计日志 / 备份恢复。仅 is_admin 可达（Toolbar 门控 + 后端 403 双保险）。
 * 审计/备份 tab 内嵌复用现有 AuditModal / BackupRestoreDialog（embedded 模式，逻辑不动）。
 * ESC / 点遮罩可关（非强制改密，正常 Modal 行为）。
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import AuditModal from "../AuditModal";
import BackupRestoreDialog from "../BackupRestoreDialog";
import UsersTab from "./UsersTab";
import RolesTab from "./RolesTab";

type TFn = ReturnType<typeof useT>;

/**
 * 后端 admin detail（api/admin/*.py）→ 双语映射（思路同 LoginPage mapAuthErr）：
 * 命中已知串走 i18n；未匹配兜底直出原文。
 */
export function mapAdminErr(detail: string, tFn: TFn): string {
  const d = detail.trim();
  let m: RegExpMatchArray | null;
  if (d === "username 不能为空") return tFn("admin.err.username_required");
  if ((m = d.match(/^用户名 (.+) 已存在$/))) return tFn("admin.err.username_exists", { name: m[1] });
  if ((m = d.match(/^角色 (\d+) 不存在$/))) return tFn("admin.err.role_not_found", { id: m[1] });
  if ((m = d.match(/^用户 (\d+) 不存在$/))) return tFn("admin.err.user_not_found", { id: m[1] });
  if (d === "admin 角色的用户不可禁用") return tFn("admin.err.admin_user_no_disable");
  if (d === "角色名不能为空") return tFn("admin.err.role_name_required");
  if ((m = d.match(/^角色名 (.+) 已存在$/))) return tFn("admin.err.role_name_exists", { name: m[1] });
  if (d === "内置 admin 角色不可修改") return tFn("admin.err.admin_role_no_edit");
  if (d === "内置 admin 角色不可删除") return tFn("admin.err.admin_role_no_delete");
  if ((m = d.match(/^角色仍挂载 (\d+) 个用户/))) return tFn("admin.err.role_in_use", { n: m[1] });
  if (d === "password must be at least 8 bytes") return tFn("pw.err.too_short");
  if (d === "password exceeds 72 bytes") return tFn("pw.err.too_long");
  if (d.includes("非法 scope")) return tFn("admin.err.invalid_scope");
  if (d.includes("非法权限键")) return tFn("admin.err.invalid_perms");
  return detail;
}

type TabKey = "users" | "roles" | "audit" | "backup";

const TABS: { key: TabKey; labelKey: "admin.tab.users" | "admin.tab.roles" | "admin.tab.audit" | "admin.tab.backup" }[] = [
  { key: "users", labelKey: "admin.tab.users" },
  { key: "roles", labelKey: "admin.tab.roles" },
  { key: "audit", labelKey: "admin.tab.audit" },
  { key: "backup", labelKey: "admin.tab.backup" },
];

interface Props {
  onClose: () => void;
  onRestored: () => void | Promise<void>;   // 备份还原成功 → App 刷新数据
}

export default function AdminModal({ onClose, onRestored }: Props) {
  const tFn = useT();
  const [tab, setTab] = useState<TabKey>("users");
  // 备份 tab 的还原密码门（后端 restore 仍校验共享密码；Phase 15 随隐藏入口一并拆除）
  const [backupPwd, setBackupPwd] = useState<string | null>(null);

  // ESC 关闭（ForcePasswordModal 那种关不掉的除外——这是正常 Modal）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal admin-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header admin-header">
          <h2>{tFn("admin.title")}</h2>
          <button className="modal-close" onClick={onClose} title={tFn("admin.close.tip")}>×</button>
        </div>

        <div className="admin-tabs">
          {TABS.map(tb => (
            <button
              key={tb.key}
              className={`admin-tab ${tab === tb.key ? "active" : ""}`}
              onClick={() => setTab(tb.key)}
            >
              {tFn(tb.labelKey)}
            </button>
          ))}
        </div>

        <div className="admin-tab-body">
          {tab === "users" && <UsersTab />}
          {tab === "roles" && <RolesTab />}
          {tab === "audit" && <AuditModal embedded />}
          {tab === "backup" && (
            backupPwd != null ? (
              <BackupRestoreDialog
                embedded
                password={backupPwd}
                onRestored={onRestored}
              />
            ) : (
              <BackupPasswordGate onPass={setBackupPwd} />
            )
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 备份还原密码门（内联版 AuditPasswordPrompt——共享密码 mangosv5 是 #42 遗留，
 * 后端 POST /api/backups/{id}/restore 仍校验；Phase 15 拆隐藏入口时一并移除）。
 */
const BACKUP_PASSWORD = "mangosv5";

function BackupPasswordGate({ onPass }: { onPass: (pwd: string) => void }) {
  const tFn = useT();
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => {
    if (value === BACKUP_PASSWORD) {
      onPass(value);
      return;
    }
    setError(true);
  };

  return (
    <form
      className="backup-gate"
      onSubmit={e => { e.preventDefault(); submit(); }}
    >
      <div className="backup-gate-hint">{tFn("admin.backup.gate.hint")}</div>
      <input
        ref={inputRef}
        type="password"
        value={value}
        onChange={e => { setValue(e.target.value); setError(false); }}
        placeholder={tFn("audit.password")}
        autoComplete="off"
      />
      {error && <div className="login-err">{tFn("audit.password_wrong")}</div>}
    </form>
  );
}
