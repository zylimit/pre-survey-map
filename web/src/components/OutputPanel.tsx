import { useEffect, useState } from "react";
import { Feature } from "../api";
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

// Road 起点：从几何首坐标取（LineString / MultiLineString 都剥到 [lng, lat]），取不到返回 null
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

// 结果行核心属性：只取强类型核心列（不碰 extras），缺失即省略该段（不渲染空占位）
function coreInfo(f: Feature): string {
  const p = f.properties ?? {};
  const k = kindOf(f);
  const segs: string[] = [];
  if (k === "site") {
    const status = nonEmpty(p.site_status);
    const project = nonEmpty(p.project);
    if (status) segs.push(`状态: ${status}`);
    if (project) segs.push(`项目: ${project}`);
    const lat = Number(p.lati);
    const lng = Number(p.longi);
    if (Number.isFinite(lat) && Number.isFinite(lng)) segs.push(fmtCoord(lat, lng));
  } else if (k === "lessor") {
    const cat = nonEmpty(p.lessor_category);
    const rel = nonEmpty(p.relationship);
    if (cat) segs.push(`类别: ${cat}`);
    if (rel) segs.push(`关系: ${rel}`);
  } else if (k === "road") {
    const c = firstCoord(f.geometry);
    if (c) segs.push(`起点: ${fmtCoord(c.lat, c.lng)}`);
  }
  return segs.join(" · ");
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: "就绪",
  uploading: "上传 + 解析中...",
  cleaning: "等待用户处理清洗",
  conflicts: "等待用户处理冲突",
  committing: "入库中...",
  exporting: "导出中...",
};

const PHASE_BUSY: Record<Phase, boolean> = {
  idle: false,
  uploading: true,
  cleaning: false,
  conflicts: false,
  committing: true,
  exporting: true,
};

export default function OutputPanel({
  open, onToggle, logs, phase, onClearLogs, onResize, onResizeEnd,
  searchResults, onResultClick, onClearSearch,
}: Props) {
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
  const dotLabel = dbOk === null ? "DB 检测中" : dbOk ? "DB 已连接" : "DB 断开";
  const latest = logs[logs.length - 1];
  const showBar = phase !== "idle";

  const firstResult = searchResults?.results[0];
  // 折叠态汇总行：点击 → 展开面板 + 飞第一条
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
          {showBar ? PHASE_LABEL[phase] : latest ? `${latest.ts} ${latest.msg}` : "就绪"}
        </span>
        {showBar && (
          <div className={`progress ${PHASE_BUSY[phase] ? "indeterminate" : "paused"}`}>
            <div className="bar-inner" />
          </div>
        )}
        {!open && searchResults && searchResults.total > 0 && firstResult && (
          <span className="search-summary-collapsed" onClick={onCollapsedSummary}>
            🔍 搜索匹配 {searchResults.total} 条，飞到第一条
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
                  搜索结果{searchResults.total > 0 ? `（${searchResults.total}）` : ""}
                </span>
                <button
                  className="clear-btn"
                  onClick={(e) => { e.stopPropagation(); onClearSearch(); }}
                  title="只清搜索结果，不动日志"
                >✖ 清空结果</button>
              </div>
              {searchResults.total === 0 ? (
                <div className="row error">未匹配到任何要素</div>
              ) : (
                <>
                  <div className="search-summary" onClick={() => firstResult && onResultClick(firstResult)}>
                    🔍 搜索匹配 {searchResults.total} 条，飞到第一条
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
                    <div className="row muted">仅显示前 {searchResults.results.length} 条，请细化关键词</div>
                  )}
                </>
              )}
            </div>
          )}
          <div className="body-head">
            <span className="muted">日志（最近 50 条）</span>
            <button
              className="clear-btn"
              onClick={(e) => { e.stopPropagation(); onClearLogs(); }}
              disabled={logs.length === 0}
              title="清空日志"
            >清空</button>
          </div>
          {logs.length === 0 && <div className="row muted">暂无日志</div>}
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
