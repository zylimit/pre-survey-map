import { BaselineState } from "../api";
import { useLang, useT } from "../i18n";

interface Props {
  state: BaselineState;
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : iso;
}

export default function BaselineStatusBar({ state }: Props) {
  const tFn = useT();
  const { lang } = useLang();
  const countryName = (lang === "zh" ? state.name_zh : state.name_en) ?? state.name_zh ?? state.iso_a2;

  if (state.established) {
    return (
      <div className="baseline-bar established">
        <span className="baseline-icon">📍</span>
        <span className="baseline-text">
          {tFn("bs.country")}
          <b>{countryName}</b>
          {" "}
          <span className="baseline-iso">({state.iso_a2})</span>
          {" · "}
          {tFn("bs.established")} <span className="baseline-date">{fmtDate(state.established_at)}</span>
          {state.coverage_pct != null && (
            <span className="baseline-meta">
              {" · "}{state.coverage_pct}% {tFn("bs.coverage")} / {state.points_used} {tFn("bs.points")}
            </span>
          )}
        </span>
      </div>
    );
  }
  return (
    <div className="baseline-bar pending">
      <span className="baseline-icon">📍</span>
      <span className="baseline-text">{tFn("bs.pending")}</span>
    </div>
  );
}
