import { useEffect } from "react";
import { Feature } from "../api";
import { useT } from "../i18n";
import { SearchResults } from "../state";
import { nameOf } from "../utils";

interface Props {
  searchResults: SearchResults | null;
  onResultClick: (f: Feature) => void;
  onClearSearch: () => void;
}

const KIND_LABEL: Record<string, string> = {
  site: "Site",
  road: "Road",
  lessor: "Lessor",
};

function kindOf(f: Feature): string {
  const k = f.properties?.kind;
  return typeof k === "string" ? k : "unknown";
}

function fmtCoord(lat: number, lng: number): string {
  return `(${lat.toFixed(5)}, ${lng.toFixed(5)})`;
}

function nonEmpty(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function firstCoord(geom: Feature["geometry"]): { lat: number; lng: number } | null {
  if (!geom) return null;
  let c: unknown = geom.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  if (Array.isArray(c) && c.length >= 2) {
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  return null;
}

function coreInfo(f: Feature): string {
  const p = f.properties ?? {};
  const k = kindOf(f);
  const segs: string[] = [];
  if (k === "site") {
    const status = nonEmpty(p.site_status);
    const project = nonEmpty(p.project);
    if (status) segs.push(`Status: ${status}`);
    if (project) segs.push(`Project: ${project}`);
    const lat = Number(p.lati);
    const lng = Number(p.longi);
    if (Number.isFinite(lat) && Number.isFinite(lng)) segs.push(fmtCoord(lat, lng));
  } else if (k === "lessor") {
    const cat = nonEmpty(p.lessor_category);
    const rel = nonEmpty(p.relationship);
    if (cat) segs.push(`Cat: ${cat}`);
    if (rel) segs.push(`Rel: ${rel}`);
  } else if (k === "road") {
    const c = firstCoord(f.geometry);
    if (c) segs.push(`Start: ${fmtCoord(c.lat, c.lng)}`);
  }
  return segs.join(" · ");
}

export default function SearchDropdown({ searchResults, onResultClick, onClearSearch }: Props) {
  const tFn = useT();

  // 点击 .search 容器外部收起浮层（参考 Toolbar openMenu 关闭模式）
  useEffect(() => {
    if (!searchResults) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      const container = document.querySelector(".toolbar .search");
      if (container && !container.contains(target)) onClearSearch();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [searchResults, onClearSearch]);

  if (!searchResults) return null;

  const firstResult = searchResults.results[0];

  return (
    <div className="search-dropdown">
      <div className="body-head">
        <span className="muted">
          {tFn("op.search.header")}{searchResults.total > 0 ? `（${searchResults.total}）` : ""}
        </span>
        <button
          className="clear-btn"
          onClick={(e) => { e.stopPropagation(); onClearSearch(); }}
          title={tFn("op.search.clear.tip")}
        >{tFn("op.search.clear.btn")}</button>
      </div>
      {searchResults.total === 0 ? (
        <div className="row error">{tFn("op.search.none")}</div>
      ) : (
        <>
          <div className="search-summary" onClick={() => firstResult && onResultClick(firstResult)}>
            {tFn("op.search.summary", { count: searchResults.total })}
          </div>
          {searchResults.results.map((f, i) => {
            const info = coreInfo(f);
            return (
              <div
                key={`${f.id}-${i}`}
                className="search-result-row"
                onClick={() => onResultClick(f)}
              >
                <span className="sr-name">{nameOf(f)}</span>
                {info && <span className="sr-info">{info}</span>}
                <span className={`sr-badge sr-${kindOf(f)}`}>
                  {KIND_LABEL[kindOf(f)] ?? "?"}
                </span>
              </div>
            );
          })}
          {searchResults.total > searchResults.results.length && (
            <div className="row muted">{tFn("op.search.capped", { cap: searchResults.results.length })}</div>
          )}
        </>
      )}
    </div>
  );
}
