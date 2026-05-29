import { useMemo, useState } from "react";
import { BaselineRegion, CleaningAction, CleaningRow, Phase1Summary } from "../api";
import { formatCount } from "../utils";
import ImportStepper from "./ImportStepper";

interface Props {
  fileName: string;
  cleanings: CleaningRow[];
  baselineRegion: BaselineRegion | null;
  summary: Phase1Summary;
  initial: Record<string, CleaningAction>;
  warnAllOutsideBaseline?: boolean;  // Spec #15 雷 29
  onProceed: (decisions: Record<string, CleaningAction>) => void;
  onCancel: () => void;
}

const ISSUE_LABEL: Record<string, string> = {
  swap_latlong: "坐标写反",
  missing_decimal: "漏小数点",
  in_sea: "在海里",
  not_in_baseline: "不在主基准",
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

function bannerLine1(b: BaselineRegion | null): string {
  if (!b || !b.country_iso_a2) {
    return "基准区域：未识别（库与本文件都无法定位到任何国家）";
  }
  const name = b.country_name_zh || b.country_iso_a2;
  if (b.source === "baseline") {
    return `基准区域：${name}（来自基线 ${formatCount(b.points_used)}/${formatCount(b.points_total)} 个点，${b.coverage_pct}%）`;
  }
  return `基准区域：${name}（来自本文件 ${formatCount(b.points_used)}/${formatCount(b.points_total)} 个点，${b.coverage_pct}% · 首次导入将固化为基线）`;
}

function bannerLine2(summary: Phase1Summary): string {
  const dup = summary.intra_file_duplicates;
  const dupGroups = dup.site_groups + dup.lessor_groups;
  const dupDiscarded = dup.site_discarded + dup.lessor_discarded;
  const afterDedup = summary.after_dedup.site + summary.after_dedup.road + summary.after_dedup.lessor;
  return (
    `文件解析 ${formatCount(summary.total_parsed)} 条；` +
    `文件内重复自动去重 ${formatCount(dupGroups)} 组（保留后者，丢弃 ${formatCount(dupDiscarded)} 个）；` +
    `待清洗 ${formatCount(afterDedup)} 个，检测异常 ${formatCount(summary.cleanings_count)} 条`
  );
}

export default function CleaningDialog({
  fileName, cleanings, baselineRegion, summary, initial,
  warnAllOutsideBaseline, onProceed, onCancel,
}: Props) {
  const [decisions, setDecisions] = useState<Record<string, CleaningAction>>(initial);

  const setOne = (rid: string, action: CleaningAction) =>
    setDecisions(prev => ({ ...prev, [rid]: action }));

  const setAll = (action: CleaningAction) =>
    setDecisions(prev => {
      const next = { ...prev };
      for (const c of cleanings) {
        // auto_fix 只对 swap_latlong 有意义；其他类型在 batch 时退化为 keep
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

  return (
    <div className="modal-mask">
      <div className="modal cleaning-modal">
        <div className="modal-header">
          <ImportStepper current="cleaning" />
          <h2>步骤 1：数据清洗 · {fileName}</h2>
          {warnAllOutsideBaseline && (
            <div className="banner banner-danger">
              ⚠️ 本文件 <b>0</b> 个点位在基线国家
              <b>{baselineRegion?.country_name_zh ?? baselineRegion?.country_iso_a2}</b>
              内，按当前决策导入将一无所获。要换基线请点 [🗑️ 清除基线]。
            </div>
          )}
          <div className="banner banner-baseline">{bannerLine1(baselineRegion)}</div>
          <div className="banner banner-summary">{bannerLine2(summary)}</div>
          <div className="batch-actions">
            <button onClick={() => setAll("auto_fix")}>全部自动修复</button>
            <button onClick={() => setAll("keep")}>全部保留</button>
            <button onClick={() => setAll("discard")}>全部丢弃</button>
            <button onClick={resetToDefaults}>按默认动作重置</button>
            <span className="counts">
              已选：自动修复 <b>{formatCount(counts.af)}</b> ·
              保留 <b>{formatCount(counts.k)}</b> ·
              丢弃 <b>{formatCount(counts.d)}</b>
            </span>
          </div>
        </div>

        <div className="modal-body">
          {cleanings.length === 0 && (
            <div className="empty">✓ 未检测到清洗异常，直接进入下一步</div>
          )}
          {cleanings.length > 0 && (
            <table className="cleaning-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>名称</th>
                  <th>来源文件</th>
                  <th>问题</th>
                  <th>当前坐标</th>
                  <th>修复后预览</th>
                  <th>默认</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {cleanings.map(c => {
                  const a = decisions[c.row_id] ?? c.default_action;
                  const canAutoFix = c.issue === "swap_latlong";
                  return (
                    <tr key={c.row_id} className={`act-${a}`}>
                      <td>{c.kind}</td>
                      <td>{c.name}</td>
                      <td className="mono">{c.file_name}</td>
                      <td>{ISSUE_LABEL[c.issue] || c.issue}{c.issue === "not_in_baseline" && c.country_name_zh ? `（${c.country_name_zh}）` : ""}</td>
                      <td className="mono">{fmtCoord(c.current_coord)}</td>
                      <td className="mono">{fmtCoord(c.fixed_coord_preview)}</td>
                      <td><span className={`badge badge-${c.default_action}`}>{c.default_action}</span></td>
                      <td>
                        {canAutoFix && (
                          <button
                            className={a === "auto_fix" ? "active" : ""}
                            onClick={() => setOne(c.row_id, "auto_fix")}
                          >自动修复</button>
                        )}
                        <button
                          className={a === "keep" ? "active" : ""}
                          onClick={() => setOne(c.row_id, "keep")}
                        >{canAutoFix ? "原样保留" : "强制保留"}</button>
                        <button
                          className={a === "discard" ? "active" : ""}
                          onClick={() => setOne(c.row_id, "discard")}
                        >丢弃</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="modal-footer">
          <button className="cancel" onClick={onCancel}>取消导入</button>
          <button className="primary" onClick={() => onProceed(decisions)}>
            下一步：冲突检测 →
          </button>
        </div>
      </div>
    </div>
  );
}
