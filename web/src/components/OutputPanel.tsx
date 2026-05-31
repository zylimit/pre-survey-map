import { useEffect, useState } from "react";
import { Feature } from "../api";
import { I18nKey, useT } from "../i18n";
import { LogEntry, PANEL_LIMITS, Phase, SearchResults } from "../state";
import { nameOf } from "../utils";
import ResizeHandle from "./ResizeHandle";

interface Props {
  open: boolean;
  onToggle: () => void;
  logs: LogEntry[];
  phase: Phase;
  onClearLogs: () => void;
  onResize: (px: number) => void;
  onResizeEnd: () => void;
  searchResults: SearchResults | null;
  onResultClick: (f: Feature) => void;
  onClearSearch: () => void;
}

const KIND_LABEL: Record<string, string> = {
  site: "Site",
  road: "Road",
  lessor: "Lessor",
};

const PHASE_KEY: Record<Phase, I18nKey> = {
  idle:       "phase.idle",
  loading:    "phase.loading",
  uploading:  "phase.uploading",
  cleaning:   "phase.cleaning",
  conflicts:  "phase.conflicts",
  committing: "phase.committing",
  exporting:  "phase.exporting",
};

const PHASE_BUSY: Record<Phase, boolean> = {
  idle: false,
  loading: true,
  uploading: true,
  cleaning: false,
  conflicts: false,
  committing: true,
  exporting: true,
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

export default function OutputPanel({
  open, onToggle, logs, phase, onClearLogs, onResize, onResizeEnd,
  searchResults, onResultClick, onClearSearch,
}: Props) {
  const tFn = useT();
  const [dbOk, setDbOk] = useState<boolean | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/health");
        const data = await res.json();
        setDbOk(Boolean(data.db));
      } catch {
        setDbOk(false);
      }
    };
    check();
    const id = setInterval(check, 10000);
    return () => clearInterval(id);
  }, []);

  const dotClass = dbOk === null ? "dot" : dbOk ? "dot ok" : "dot err";
  const dotLabel = dbOk === null ? tFn("op.db.checking") : dbOk ? tFn("op.db.ok") : tFn("op.db.error");
  const latest = logs[logs.length - 1];
  const showBar = phase !== "idle";

  const firstResult = searchResults?.results[0];
  const onCollapsedSummary = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open) onToggle();
    if (firstResult) onResultClick(firstResult);
  };

  return (
    <div className="output">
      {open && (
        <ResizeHandle
          axis="y" edge="start"
          min={PANEL_LIMITS.bottom.min} max={PANEL_LIMITS.bottom.max}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
        />
      )}
      <div className="bar" onClick={onToggle}>
        <span>{open ? "▾" : "▸"}</span>
        <span className="phase-label">
          {showBar ? tFn(PHASE_KEY[phase]) : latest ? `${latest.ts} ${latest.msg}` : tFn("phase.idle")}
        </span>
        {showBar && (
          <div className={`progress ${PHASE_BUSY[phase] ? "indeterminate" : "paused"}`}>
            <div className="bar-inner" />
          </div>
        )}
        {!open && searchResults && searchResults.total > 0 && firstResult && (
          <span className="search-summary-collapsed" onClick={onCollapsedSummary}>
            {tFn("op.search.summary", { count: searchResults.total })}
          </span>
        )}
        <div className="status">
          <span className={dotClass} />
          <span>{dotLabel}</span>
        </div>
      </div>
      {open && (
        <div className="body">
          {searchResults && (
            <div className="search-results">
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
          )}
          <div className="body-head">
            <span className="muted">{tFn("op.logs.header")}</span>
            <button
              className="clear-btn"
              onClick={(e) => { e.stopPropagation(); onClearLogs(); }}
              disabled={logs.length === 0}
              title={tFn("op.logs.clear")}
            >{tFn("op.logs.clear")}</button>
          </div>
          {logs.length === 0 && <div className="row muted">{tFn("op.logs.empty")}</div>}
          {logs.map((l, i) => (
            <div key={i} className={`row ${l.level}`}>
              [{l.ts}] {l.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
