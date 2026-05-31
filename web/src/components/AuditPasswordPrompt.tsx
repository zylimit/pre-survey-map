import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";

/**
 * F19 · 审计密码框（Spec V1.x #23）
 * 硬编码密码 `mangosv5`（用户明确，V1 接受）。
 * 错误：抖动 + 提示，不限次数。
 */
const AUDIT_PASSWORD = "mangosv5";

interface Props {
  onPass: () => void;
  onCancel: () => void;
}

export default function AuditPasswordPrompt({ onPass, onCancel }: Props) {
  const tFn = useT();
  const [value, setValue] = useState("");
  const [shake, setShake] = useState(false);
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => {
    if (value === AUDIT_PASSWORD) {
      onPass();
      return;
    }
    setError(true);
    setShake(true);
    setTimeout(() => setShake(false), 400);
  };

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div
        className={`audit-pwd ${shake ? "audit-pwd-shake" : ""}`}
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={e => { setValue(e.target.value); setError(false); }}
          onKeyDown={e => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
          placeholder={tFn("audit.password")}
          autoComplete="off"
        />
        {error && <div className="audit-pwd-err">{tFn("audit.password_wrong")}</div>}
      </div>
    </div>
  );
}
