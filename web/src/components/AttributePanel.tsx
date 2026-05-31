import { Feature } from "../api";
import { useT } from "../i18n";
import { PANEL_LIMITS } from "../state";
import ResizeHandle from "./ResizeHandle";

interface Props {
  feature: Feature | null;
  onClose: () => void;
  onResize: (px: number) => void;
  onResizeEnd: () => void;
}

const CORE_FIELDS: Record<string, string[]> = {
  site:   ["site_id", "option", "project", "site_status", "lati", "longi", "source_file"],
  road:   ["id", "property", "source_file"],
  lessor: ["fid", "lessor_name", "lessor_category", "relationship", "source_file"],
};

const CORE_LABELS: Record<string, string> = {
  site_id:          "SITE ID",
  option:           "OPTION",
  project:          "PROJECT",
  site_status:      "SITE STATUS",
  lati:             "LATI",
  longi:            "LONGI",
  id:               "ID",
  property:         "Property",
  fid:              "fid",
  lessor_name:      "Lessor Name",
  lessor_category:  "Lessor Category",
  relationship:     "Relationship",
};

function isCoordSwapOrOutOfRange(lati: unknown, longi: unknown): boolean {
  const la = typeof lati === "number" ? lati : Number(lati);
  const lo = typeof longi === "number" ? longi : Number(longi);
  if (!isFinite(la) || !isFinite(lo)) return false;
  return Math.abs(la) > 90 || Math.abs(lo) > 180;
}

function display(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default function AttributePanel({ feature, onClose, onResize, onResizeEnd }: Props) {
  const tFn = useT();

  const resizeHandle = (
    <ResizeHandle
      axis="x" edge="start"
      min={PANEL_LIMITS.right.min} max={PANEL_LIMITS.right.max}
      onResize={onResize}
      onResizeEnd={onResizeEnd}
    />
  );

  const featureTitle = (f: Feature): string => {
    const p = f.properties ?? {};
    if (p.kind === "site") return `Site: ${p.site_id ?? "?"}${p.option ? " / " + p.option : ""}`;
    if (p.kind === "road") return `Road: ${p.property ?? "#" + p.id}`;
    if (p.kind === "lessor") return `Lessor: ${p.lessor_name ?? p.fid}`;
    return tFn("ap.feature");
  };

  if (!feature) {
    return (
      <div className="attr">
        {resizeHandle}
        <h3>{tFn("ap.title")}</h3>
        <div className="placeholder">{tFn("ap.placeholder")}</div>
      </div>
    );
  }

  const p = (feature.properties ?? {}) as Record<string, unknown>;
  const kind = String(p.kind ?? "");
  const coreFields = CORE_FIELDS[kind] ?? [];
  const coreSet = new Set(coreFields);
  coreSet.add("kind");

  const extrasEntries = Object.entries(p).filter(([k]) => !coreSet.has(k));
  const coordWarn = kind === "site" && isCoordSwapOrOutOfRange(p.lati, p.longi);

  return (
    <div className="attr">
      {resizeHandle}
      <div className="attr-head">
        <h3>{featureTitle(feature)}</h3>
        <button className="close" onClick={onClose} title={tFn("ap.close")}>✖</button>
      </div>

      {coordWarn && (
        <div className="warn-banner">{tFn("ap.coord_warn")}</div>
      )}

      <div className="attr-section">
        <div className="attr-section-title">{tFn("ap.core")}</div>
        {coreFields.map(k => {
          const isLat = k === "lati";
          const isLon = k === "longi";
          const highlight = (isLat || isLon) && coordWarn;
          const label = k === "source_file" ? tFn("ap.source") : (CORE_LABELS[k] ?? k);
          return (
            <div key={k} className={`attr-row ${highlight ? "highlight" : ""}`}>
              <span className="k">{label}</span>
              <span className="v">{display(p[k])}</span>
            </div>
          );
        })}
      </div>

      {extrasEntries.length > 0 && (
        <div className="attr-section">
          <div className="attr-section-title">{tFn("ap.extras", { n: extrasEntries.length })}</div>
          {extrasEntries.map(([k, v]) => (
            <div key={k} className="attr-row">
              <span className="k">{k}</span>
              <span className="v">{display(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
