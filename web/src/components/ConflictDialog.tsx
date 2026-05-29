import { useMemo, useState } from "react";
import { ConflictRow, Decision } from "../api";
import { formatCount } from "../utils";
import ImportStepper from "./ImportStepper";

interface Props {
  conflicts: ConflictRow[];
  initial: Record<string, Decision>;
  onConfirm: (decisions: Record<string, Decision>) => void;
  onCancel: () => void;
  onBack?: () => void;
}

// 把库里现状 / 新数据浓缩成一行展示字符串
function summarize(row: Record<string, unknown>, kind: "site" | "lessor"): string {
  if (kind === "site") {
    const parts = [
      row.site_status ? String(row.site_status) : "—",
      row.lati != null && row.longi != null ? `${row.lati}, ${row.longi}` : "(无坐标)",
      row.project ? String(row.project) : "",
    ].filter(Boolean);
    return parts.join(" · ");
  }
  return [
    row.lessor_category ? String(row.lessor_category) : "—",
    row.relationship ? String(row.relationship) : "—",
  ].join(" · ");
}

export default function ConflictDialog({ conflicts, initial, onConfirm, onCancel, onBack }: Props) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>(initial);

  const setOne = (key: string, action: Decision) =>
    setDecisions(prev => ({ ...prev, [key]: action }));

  const setAll = (action: Decision) =>
    setDecisions(Object.fromEntries(conflicts.map(c => [c.key, action])));

  const flipAll = () =>
    setDecisions(prev =>
      Object.fromEntries(
        conflicts.map(c => [c.key, prev[c.key] === "overwrite" ? "ignore" : "overwrite"])
      )
    );

  const counts = useMemo(() => {
    let ov = 0, ig = 0;
    for (const c of conflicts) {
      if (decisions[c.key] === "overwrite") ov++; else ig++;
    }
    return { ov, ig };
  }, [conflicts, decisions]);

  return (
    <div className="modal-mask">
      <div className="modal conflict-modal">
        <div className="modal-header">
          {onBack && <ImportStepper current="conflicts" />}
          <h2>{onBack ? "步骤 2：" : ""}⚠️ 冲突列表（共 {formatCount(conflicts.length)} 条）</h2>
          <div className="batch-actions">
            <button onClick={() => setAll("overwrite")}>全部覆盖</button>
            <button onClick={() => setAll("ignore")}>全部忽略</button>
            <button onClick={flipAll}>反选</button>
            <span className="counts">
              已选：覆盖 <b>{formatCount(counts.ov)}</b> · 忽略 <b>{formatCount(counts.ig)}</b>
            </span>
          </div>
        </div>

        <div className="modal-body">
          <table className="conflict-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>名称</th>
                <th>库里现状</th>
                <th>导入文件</th>
                <th>来源文件名</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map(c => {
                const action = decisions[c.key] ?? "ignore";
                return (
                  <tr key={c.key} className={action === "overwrite" ? "act-overwrite" : "act-ignore"}>
                    <td>{c.kind}</td>
                    <td>{c.name}</td>
                    <td>{summarize(c.existing, c.kind)}</td>
                    <td>{summarize(c.incoming, c.kind)}</td>
                    <td>{c.source_file}</td>
                    <td>
                      <button
                        className={action === "overwrite" ? "active" : ""}
                        onClick={() => setOne(c.key, "overwrite")}
                      >覆盖</button>
                      <button
                        className={action === "ignore" ? "active" : ""}
                        onClick={() => setOne(c.key, "ignore")}
                      >忽略</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="modal-footer">
          {onBack && <button onClick={onBack}>← 返回步骤 1</button>}
          <button className="cancel" onClick={onCancel}>
            取消（下载冲突 Excel）
          </button>
          <button className="primary" onClick={() => onConfirm(decisions)}>
            确认导入（覆盖 {formatCount(counts.ov)} · 忽略 {formatCount(counts.ig)}）
          </button>
        </div>
      </div>
    </div>
  );
}
