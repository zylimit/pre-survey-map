import { Feature } from "../api";

interface Props {
  feature: Feature | null;
  onClose: () => void;
}

// 各类型的核心强类型列。Spec：属性面板先核心列，再展开 extras
const CORE_FIELDS: Record<string, string[]> = {
  site: ["site_id", "option", "project", "site_status", "lati", "longi", "source_file"],
  road: ["id", "property", "source_file"],
  lessor: ["fid", "lessor_name", "lessor_category", "relationship", "source_file"],
};

const CORE_LABELS: Record<string, string> = {
  site_id: "SITE ID",
  option: "OPTION",
  project: "PROJECT",
  site_status: "SITE STATUS",
  lati: "LATI",
  longi: "LONGI",
  id: "ID",
  property: "Property",
  fid: "fid",
  lessor_name: "Lessor Name",
  lessor_category: "Lessor Category",
  relationship: "Relationship",
  source_file: "来源文件",
};

function title(f: Feature): string {
  const p = f.properties ?? {};
  if (p.kind === "site") return `Site: ${p.site_id ?? "?"}${p.option ? " / " + p.option : ""}`;
  if (p.kind === "road") return `Road: ${p.property ?? "#" + p.id}`;
  if (p.kind === "lessor") return `Lessor: ${p.lessor_name ?? p.fid}`;
  return "要素";
}

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

export default function AttributePanel({ feature, onClose }: Props) {
  if (!feature) {
    return (
      <div className="attr">
        <h3>📋 属性面板</h3>
        <div className="placeholder">点击地图要素或左侧树节点查看属性</div>
      </div>
    );
  }

  const p = (feature.properties ?? {}) as Record<string, unknown>;
  const kind = String(p.kind ?? "");
  const coreFields = CORE_FIELDS[kind] ?? [];
  const coreSet = new Set(coreFields);
  coreSet.add("kind");

  const extras = (p as Record<string, unknown>);
  const extrasEntries = Object.entries(extras).filter(([k]) => !coreSet.has(k));

  const coordWarn = kind === "site" && isCoordSwapOrOutOfRange(p.lati, p.longi);

  return (
    <div className="attr">
      <div className="attr-head">
        <h3>{title(feature)}</h3>
        <button className="close" onClick={onClose} title="关闭">✖</button>
      </div>

      {coordWarn && (
        <div className="warn-banner">
          ⚠️ 坐标异常（LATI/LONGI 写反或漏小数点），请核对源文件
        </div>
      )}

      <div className="attr-section">
        <div className="attr-section-title">核心字段</div>
        {coreFields.map(k => {
          const isLat = k === "lati";
          const isLon = k === "longi";
          const highlight = (isLat || isLon) && coordWarn;
          return (
            <div key={k} className={`attr-row ${highlight ? "highlight" : ""}`}>
              <span className="k">{CORE_LABELS[k] ?? k}</span>
              <span className="v">{display(p[k])}</span>
            </div>
          );
        })}
      </div>

      {extrasEntries.length > 0 && (
        <div className="attr-section">
          <div className="attr-section-title">扩展字段（{extrasEntries.length}）</div>
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
