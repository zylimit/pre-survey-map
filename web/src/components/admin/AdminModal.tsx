/**
 * #50 Phase 14 · 管理 Modal（Spec F22「管理界面」节）
 *
 * 四 tab：用户 / 角色 / 审计日志 / 备份恢复。仅 is_admin 可达（Toolbar 门控 + 后端 403 双保险）。
 * 审计/备份 tab 内嵌复用现有 AuditModal / BackupRestoreDialog（embedded 模式，逻辑不动）。
 * ESC / 点遮罩可关（非强制改密，正常 Modal 行为）。
 */
import { useEffect, useState } from "react";
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
  // #50 Phase 15（Phase 14 review Low 修复）：后端 403（require_admin/require_perm）双语透出
  if (d.includes("forbidden")) return tFn("admin.err.forbidden");
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
  // #50 Phase 15：备份密码门已拆除——admin-only 门控即是防线，备份 tab 直接进内容

  // ESC 关闭（ForcePasswordModal 那种关不掉的除外——这是正常 Modal）。
  // Phase 15（Phase 14 review Low 修复）：子 Modal（重置密码/确认框）内 ESC 已
  // stopPropagation，不会穿透误关本 Modal。
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
            <BackupRestoreDialog embedded onRestored={onRestored} />
          )}
        </div>
      </div>
    </div>
  );
}
