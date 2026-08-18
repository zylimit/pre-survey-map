import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";

type TFn = ReturnType<typeof useT>;

/**
 * 后端 auth detail（api/auth/router.py）→ 双语映射：
 * 命中已知串走 i18n；未匹配的 detail 兜底直出原文。
 * ctx 区分上下文——同一个 "invalid credentials" 在登录页是账号密码错、在改密框是旧密码错。
 */
function mapAuthErr(detail: string, tFn: TFn, ctx: "login" | "pw"): string {
  const d = detail.toLowerCase();
  if (d === "invalid credentials") {
    return tFn(ctx === "pw" ? "pw.err.invalid_old" : "login.err.invalid_credentials");
  }
  if (d.includes("locked")) return tFn("login.err.locked");
  if (d === "new password must be at least 8 bytes") return tFn("pw.err.too_short");
  if (d === "new password exceeds 72 bytes") return tFn("pw.err.too_long");
  return detail;
}

/**
 * #50 Phase 13 · 登录页 + 首登强制改密 Modal（Spec F22「登录」节）
 * 视觉对齐现有 modal 惯例，全部走 theme.css 变量（双主题自适应）。
 */

interface LoginProps {
  onLogin: (username: string, password: string) => Promise<string | null>;
}

export default function LoginPage({ onLogin }: LoginProps) {
  const tFn = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async () => {
    if (busy || !username || !password) return;
    setBusy(true);
    setError(null);
    try {
      const err = await onLogin(username, password);
      // 后端 detail（invalid credentials / account locked...）映射成当前语言
      if (err) setError(mapAuthErr(err, tFn, "login"));
    } catch {
      // 网络错误（后端不可达）——onLogin 已接住 HTTP 错误，这里只剩 fetch 层异常
      setError(tFn("login.err.generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form
        className="login-card"
        onSubmit={e => { e.preventDefault(); void submit(); }}
      >
        <h1 className="login-title">{tFn("login.title")}</h1>
        <input
          ref={inputRef}
          value={username}
          onChange={e => { setUsername(e.target.value); setError(null); }}
          placeholder={tFn("login.username")}
          autoComplete="username"
          disabled={busy}
        />
        <input
          type="password"
          value={password}
          onChange={e => { setPassword(e.target.value); setError(null); }}
          placeholder={tFn("login.password")}
          autoComplete="current-password"
          disabled={busy}
        />
        {error && <div className="login-err">{error}</div>}
        <button
          type="submit"
          className="primary login-btn"
          disabled={busy || !username || !password}
        >
          {busy ? tFn("login.submitting") : tFn("login.submit")}
        </button>
      </form>
    </div>
  );
}

interface ForcePwProps {
  onSubmit: (oldPassword: string, newPassword: string) => Promise<string | null>;
}

/** 首登强制改密 Modal：不可关闭（无 ✖ / ESC 无效 / 遮罩不可点穿），改完才能进主界面 */
export function ForcePasswordModal({ onSubmit }: ForcePwProps) {
  const tFn = useT();
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async () => {
    if (busy) return;
    if (!oldPw || !newPw || !confirmPw) return;
    // 前端校验：≥8 字符 + 两次一致（后端仍做 8..72 字节硬校验）
    if (newPw.length < 8) {
      setError(tFn("pw.err.too_short"));
      return;
    }
    if (newPw !== confirmPw) {
      setError(tFn("pw.err.mismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const err = await onSubmit(oldPw, newPw);
      if (err) setError(mapAuthErr(err, tFn, "pw"));
    } catch {
      setError(tFn("pw.err.generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask">
      <div className="modal force-pw-modal">
        <div className="modal-header">
          <h2>{tFn("pw.title")}</h2>
        </div>
        <form onSubmit={e => { e.preventDefault(); void submit(); }}>
          <div className="modal-body force-pw-body">
            <div className="force-pw-hint">{tFn("pw.hint")}</div>
            <input
              ref={inputRef}
              type="password"
              value={oldPw}
              onChange={e => { setOldPw(e.target.value); setError(null); }}
              placeholder={tFn("pw.old")}
              autoComplete="current-password"
              disabled={busy}
            />
            <input
              type="password"
              value={newPw}
              onChange={e => { setNewPw(e.target.value); setError(null); }}
              placeholder={tFn("pw.new")}
              autoComplete="new-password"
              disabled={busy}
            />
            <input
              type="password"
              value={confirmPw}
              onChange={e => { setConfirmPw(e.target.value); setError(null); }}
              placeholder={tFn("pw.confirm")}
              autoComplete="new-password"
              disabled={busy}
            />
            {error && <div className="login-err">{error}</div>}
          </div>
          <div className="modal-footer">
            <button
              type="submit"
              className="primary"
              disabled={busy || !oldPw || !newPw || !confirmPw}
            >
              {busy ? tFn("pw.submitting") : tFn("pw.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
