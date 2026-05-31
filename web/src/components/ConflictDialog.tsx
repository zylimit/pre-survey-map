import { useMemo, useState } from "react";
import { ConflictRow, Decision } from "../api";
import { useT } from "../i18n";
import { formatCount } from "../utils";
import ImportStepper from "./ImportStepper";

interface Props {
  conflicts: ConflictRow[];
  initial: Record<string, Decision>;
  onConfirm: (decisions: Record<string, Decision>) => void;
  onCancel: () => void;
  onBack?: () => void;
}

function summarize(row: Record<string, unknown>, kind: "site" | "lessor", noCoord: string): string {
  if (kind === "site") {
    const parts = [
      row.site_status ? String(row.site_status) : "—",
      row.lati != null && row.longi != null ? `${row.lati}, ${row.longi}` : noCoord,
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
  const tFn = useT();
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

  const noCoord = tFn("co.no_coord");

  return (
    <div className="modal-mask">
      <div className="modal conflict-modal">
        <div className="modal-header">
          {onBack && <ImportStepper current="conflicts" />}
          <h2>
            {onBack ? tFn("co.step") : ""}
            {tFn("co.title", { count: formatCount(conflicts.length) })}
          </h2>
          <div className="batch-actions">
            <button onClick={() => setAll("overwrite")}>{tFn("co.batch.overwrite")}</button>
            <button onClick={() => setAll("ignore")}>{tFn("co.batch.ignore")}</button>
            <button onClick={flipAll}>{tFn("co.batch.toggle")}</button>
            <span className="counts">
              {tFn("co.batch.status", { ov: formatCount(counts.ov), ig: formatCount(counts.ig) })}
            </span>
          </div>
        </div>

        <div className="modal-body">
          <table className="conflict-table">
            <thead>
              <tr>
                <th>{tFn("co.col.type")}</th>
                <th>{tFn("co.col.name")}</th>
                <th>{tFn("co.col.existing")}</th>
                <th>{tFn("co.col.incoming")}</th>
                <th>{tFn("co.col.file")}</th>
                <th>{tFn("co.col.action")}</th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map(c => {
                const action = decisions[c.key] ?? "ignore";
                return (
                  <tr key={c.key} className={action === "overwrite" ? "act-overwrite" : "act-ignore"}>
                    <td>{c.kind}</td>
                    <td>{c.name}</td>
                    <td>{summarize(c.existing, c.kind, noCoord)}</td>
                    <td>{summarize(c.incoming, c.kind, noCoord)}</td>
                    <td>{c.source_file}</td>
                    <td>
                      <button
                        className={action === "overwrite" ? "active" : ""}
                        onClick={() => setOne(c.key, "overwrite")}
                      >{tFn("co.action.overwrite")}</button>
                      <button
                        className={action === "ignore" ? "active" : ""}
                        onClick={() => setOne(c.key, "ignore")}
                      >{tFn("co.action.ignore")}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="modal-footer">
          {onBack && <button onClick={onBack}>{tFn("co.back")}</button>}
          <button className="cancel" onClick={onCancel}>
            {tFn("co.cancel")}
          </button>
          <button className="primary" onClick={() => onConfirm(decisions)}>
            {tFn("co.confirm", { ov: formatCount(counts.ov), ig: formatCount(counts.ig) })}
          </button>
        </div>
      </div>
    </div>
  );
}
