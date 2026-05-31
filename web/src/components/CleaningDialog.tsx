import { useMemo, useState } from "react";
import { BaselineRegion, CleaningAction, CleaningRow, Phase1Summary } from "../api";
import { I18nKey, useT } from "../i18n";
import { formatCount } from "../utils";
import ImportStepper from "./ImportStepper";

interface Props {
  fileName: string;
  cleanings: CleaningRow[];
  baselineRegion: BaselineRegion | null;
  summary: Phase1Summary;
  initial: Record<string, CleaningAction>;
  warnAllOutsideBaseline?: boolean;
  onProceed: (decisions: Record<string, CleaningAction>) => void;
  onCancel: () => void;
}

const ISSUE_KEY: Record<string, I18nKey> = {
  swap_latlong:     "cl.issue.swap",
  missing_decimal:  "cl.issue.decimal",
  in_sea:           "cl.issue.sea",
  not_in_baseline:  "cl.issue.baseline",
};

function fmtCoord(c: { lat: number | null; lng: number | null } | null): string {
  if (!c || c.lat == null || c.lng == null) return "—";
  return `${c.lat}, ${c.lng}`;
}

function defaultsOf(rows: CleaningRow[]): Record<string, CleaningAction> {
  const r: Record<string, CleaningAction> = {};
  for (const c of rows) r[c.row_id] = c.default_action;
  return r;
}

export default function CleaningDialog({
  fileName, cleanings, baselineRegion, summary, initial,
  warnAllOutsideBaseline, onProceed, onCancel,
}: Props) {
  const tFn = useT();
  const [decisions, setDecisions] = useState<Record<string, CleaningAction>>(initial);

  const setOne = (rid: string, action: CleaningAction) =>
    setDecisions(prev => ({ ...prev, [rid]: action }));

  const setAll = (action: CleaningAction) =>
    setDecisions(prev => {
      const next = { ...prev };
      for (const c of cleanings) {
        if (action === "auto_fix" && c.issue !== "swap_latlong") {
          next[c.row_id] = "keep";
        } else {
          next[c.row_id] = action;
        }
      }
      return next;
    });

  const resetToDefaults = () => setDecisions(defaultsOf(cleanings));

  const counts = useMemo(() => {
    let af = 0, k = 0, d = 0;
    for (const c of cleanings) {
      const a = decisions[c.row_id] ?? c.default_action;
      if (a === "auto_fix") af++;
      else if (a === "keep") k++;
      else d++;
    }
    return { af, k, d };
  }, [cleanings, decisions]);

  const baselineBanner = (): string => {
    const b = baselineRegion;
    if (!b || !b.country_iso_a2) return tFn("cl.baseline.none");
    const name = b.country_name_zh || b.country_iso_a2;
    if (b.source === "baseline") {
      return tFn("cl.baseline.db", {
        name, used: formatCount(b.points_used), total: formatCount(b.points_total), pct: b.coverage_pct,
      });
    }
    return tFn("cl.baseline.file", {
      name, used: formatCount(b.points_used), total: formatCount(b.points_total), pct: b.coverage_pct,
    });
  };

  const summaryBanner = (): string => {
    const dup = summary.intra_file_duplicates;
    return tFn("cl.banner.summary", {
      total: formatCount(summary.total_parsed),
      groups: formatCount(dup.site_groups + dup.lessor_groups),
      discarded: formatCount(dup.site_discarded + dup.lessor_discarded),
      cleanings: formatCount(summary.cleanings_count),
    });
  };

  return (
    <div className="modal-mask">
      <div className="modal cleaning-modal">
        <div className="modal-header">
          <ImportStepper current="cleaning" />
          <h2>{tFn("cl.step", { file: fileName })}</h2>
          {warnAllOutsideBaseline && (
            <div className="banner banner-danger">
              {tFn("cl.warn.all_outside", {
                count: String(summary.total_parsed),
                iso: baselineRegion?.country_name_zh ?? baselineRegion?.country_iso_a2 ?? "?",
              })}
              {" "}{tFn("cl.warn.change")}
            </div>
          )}
          <div className="banner banner-baseline">{baselineBanner()}</div>
          <div className="banner banner-summary">{summaryBanner()}</div>
          <div className="batch-actions">
            <button onClick={() => setAll("auto_fix")}>{tFn("cl.batch.fix")}</button>
            <button onClick={() => setAll("keep")}>{tFn("cl.batch.keep")}</button>
            <button onClick={() => setAll("discard")}>{tFn("cl.batch.discard")}</button>
            <button onClick={resetToDefaults}>{tFn("cl.batch.reset")}</button>
            <span className="counts">
              {tFn("cl.batch.status", {
                fix: formatCount(counts.af),
                keep: formatCount(counts.k),
                discard: formatCount(counts.d),
              })}
            </span>
          </div>
        </div>

        <div className="modal-body">
          {cleanings.length === 0 && (
            <div className="empty">{tFn("cl.no_issues")}</div>
          )}
          {cleanings.length > 0 && (
            <table className="cleaning-table">
              <thead>
                <tr>
                  <th>{tFn("cl.col.type")}</th>
                  <th>{tFn("cl.col.name")}</th>
                  <th>{tFn("cl.col.file")}</th>
                  <th>{tFn("cl.col.issue")}</th>
                  <th>{tFn("cl.col.coord")}</th>
                  <th>{tFn("cl.col.preview")}</th>
                  <th>{tFn("cl.col.default")}</th>
                  <th>{tFn("cl.col.action")}</th>
                </tr>
              </thead>
              <tbody>
                {cleanings.map(c => {
                  const a = decisions[c.row_id] ?? c.default_action;
                  const canAutoFix = c.issue === "swap_latlong";
                  const issueKey = ISSUE_KEY[c.issue];
                  const issueLabel = issueKey ? tFn(issueKey) : c.issue;
                  return (
                    <tr key={c.row_id} className={`act-${a}`}>
                      <td>{c.kind}</td>
                      <td>{c.name}</td>
                      <td className="mono">{c.file_name}</td>
                      <td>{issueLabel}{c.issue === "not_in_baseline" && c.country_name_zh ? `（${c.country_name_zh}）` : ""}</td>
                      <td className="mono">{fmtCoord(c.current_coord)}</td>
                      <td className="mono">{fmtCoord(c.fixed_coord_preview)}</td>
                      <td><span className={`badge badge-${c.default_action}`}>{c.default_action}</span></td>
                      <td>
                        {canAutoFix && (
                          <button
                            className={a === "auto_fix" ? "active" : ""}
                            onClick={() => setOne(c.row_id, "auto_fix")}
                          >{tFn("cl.action.fix")}</button>
                        )}
                        <button
                          className={a === "keep" ? "active" : ""}
                          onClick={() => setOne(c.row_id, "keep")}
                        >{canAutoFix ? tFn("cl.action.keep") : tFn("cl.action.force_keep")}</button>
                        <button
                          className={a === "discard" ? "active" : ""}
                          onClick={() => setOne(c.row_id, "discard")}
                        >{tFn("cl.action.discard")}</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="modal-footer">
          <button className="cancel" onClick={onCancel}>{tFn("cl.cancel")}</button>
          <button className="primary" onClick={() => onProceed(decisions)}>
            {tFn("cl.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
