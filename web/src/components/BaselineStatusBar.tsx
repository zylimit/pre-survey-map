import { BaselineState } from "../api";

interface Props {
  state: BaselineState;
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  // 截取到日期部分 YYYY-MM-DD
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : iso;
}

// Spec V1.x #15 · F15：Toolbar 下方独立 28px 横条，永远显示当前主基准状态
export default function BaselineStatusBar({ state }: Props) {
  if (state.established) {
    return (
      <div className="baseline-bar established">
        <span className="baseline-icon">📍</span>
        <span className="baseline-text">
          基线国家：
          <b>{state.name_zh ?? state.iso_a2}</b>
          {" "}
          <span className="baseline-iso">({state.iso_a2})</span>
          {" · "}
          固化于 <span className="baseline-date">{fmtDate(state.established_at)}</span>
          {state.coverage_pct != null && (
            <span className="baseline-meta">
              {" · "}{state.coverage_pct}% 覆盖 / {state.points_used} 点
            </span>
          )}
        </span>
      </div>
    );
  }
  return (
    <div className="baseline-bar pending">
      <span className="baseline-icon">📍</span>
      <span className="baseline-text">
        基线未确立 · 首次导入完成后将自动锁定
      </span>
    </div>
  );
}
