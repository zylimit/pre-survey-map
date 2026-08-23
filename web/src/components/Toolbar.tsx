import { useEffect, useRef, useState } from "react";
import { Feature } from "../api";
import { DrawMode, SearchResults } from "../state";
import { useLang, useT } from "../i18n";
import { NP_RADIUS_OPTIONS } from "../utils";
import SearchDropdown from "./SearchDropdown";

interface Props {
  busy: boolean;
  drawMode: DrawMode;
  hasSelection: boolean;
  npRadiusM: number;
  username: string;     // #50：当前登录用户
  isAdmin: boolean;     // #50：[⚙ 管理] 仅 admin 渲染
  onOpenAdmin: () => void;  // #50 Phase 14：打开管理 Modal
  // #50 Phase 15：功能权限门控（App 已按 is_admin 放行折算好传入）
  canExport: boolean;      // export → [导出 KMZ] 下拉
  canEditDelete: boolean;  // edit_delete → [删除历史]
  canDanger: boolean;      // danger → [清除基线] / [恢复点]
  onLogout: () => void;
  onStartDraw: (mode: DrawMode) => void;
  onClearSelection: () => void;
  onExportAll: () => void;
  onExportSelection: () => void;
  onRefresh: () => void;
  onSearch: (query: string) => void;
  searchResults: SearchResults | null;
  onResultClick: (f: Feature) => void;
  onClearSearch: () => void;
  onClearBaseline: () => void;
  onOpenRestorePoints: () => void;
  onOpenDeleteHistory: () => void;
  onChangeNpRadius: (m: number) => void;
  showPolygonLabels: boolean;         // #52 F24 ④：面名称标签全局显隐
  onTogglePolygonLabels: () => void;
}

export default function Toolbar({
  busy, drawMode, hasSelection, npRadiusM,
  username, isAdmin, onOpenAdmin, canExport, canEditDelete, canDanger, onLogout,
  onStartDraw, onClearSelection, onExportAll, onExportSelection,
  onRefresh, onSearch, onClearBaseline, onOpenRestorePoints, onOpenDeleteHistory, onChangeNpRadius,
  showPolygonLabels, onTogglePolygonLabels,
  searchResults, onResultClick, onClearSearch,
}: Props) {
  const [openMenu, setOpenMenu] = useState<"export" | "draw" | null>(null);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark")
  );
  const { toggleLang } = useLang();
  const tFn = useT();

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("presurvey.theme", next); } catch { }
  };

  useEffect(() => {
    if (!openMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [openMenu]);

  const submitSearch = () => {
    const q = query.trim();
    if (q) onSearch(q);
  };

  const drawLabel = drawMode
    ? tFn(
        drawMode === "polygon"
          ? "tb.draw.active.poly"
          : drawMode === "circle"
            ? "tb.draw.active.circle"
            : "tb.draw.active.rect",
      )
    : tFn("tb.draw.label");

  return (
    <div className="toolbar" ref={rootRef}>
      {/* F20 Phase 5：顶部全局 [📁 导入] 按钮已移除——导入唯一入口下沉到图层
          [导入图层]（Phase 3 接通）。地图拖拽导入（onDropFiles）仍保留为 F1 旁路。
          #50 Phase 15：无 export 权限 → 整个导出下拉不渲染 */}
      {canExport && (
      <div className="dropdown">
        <button
          onClick={() => setOpenMenu(openMenu === "export" ? null : "export")}
          disabled={busy}
        >
          {tFn("tb.export.label")}
        </button>
        {openMenu === "export" && (
          <div className="dropdown-menu">
            <div className="dropdown-item" onClick={() => { setOpenMenu(null); onExportAll(); }}>
              {tFn("tb.export.all")}
            </div>
            <div
              className={`dropdown-item ${hasSelection ? "" : "disabled"}`}
              onClick={() => hasSelection && (setOpenMenu(null), onExportSelection())}
              title={hasSelection ? "" : tFn("tb.export.nosel.tip")}
            >
              {hasSelection ? tFn("tb.export.selection") : tFn("tb.export.nosel.txt")}
            </div>
          </div>
        )}
      </div>
      )}

      <div className="dropdown">
        <button
          onClick={() => setOpenMenu(openMenu === "draw" ? null : "draw")}
          disabled={busy}
          className={drawMode ? "active" : ""}
        >
          {drawLabel}
        </button>
        {openMenu === "draw" && (
          <div className="dropdown-menu">
            <div className="dropdown-item" onClick={() => { setOpenMenu(null); onStartDraw("polygon"); }}>
              {tFn("tb.draw.polygon")}
            </div>
            <div className="dropdown-item" onClick={() => { setOpenMenu(null); onStartDraw("rectangle"); }}>
              {tFn("tb.draw.rect")}
            </div>
            <div className="dropdown-item" onClick={() => { setOpenMenu(null); onStartDraw("circle"); }}>
              {tFn("tb.draw.circle")}
            </div>
            {(drawMode || hasSelection) && (
              <div
                className="dropdown-item danger"
                onClick={() => { setOpenMenu(null); onClearSelection(); }}
              >
                {tFn("tb.draw.clear")}
              </div>
            )}
          </div>
        )}
      </div>

      <button onClick={onRefresh} disabled={busy} title={tFn("tb.refresh.tip")}>
        {tFn("tb.refresh.label")}
      </button>

      {/* #45 NP 辐射圈半径下拉（全局唯一入口，仅前端 localStorage，不入库） */}
      <label className="np-radius" title={tFn("tb.np_radius.tip")}>
        <span>{tFn("tb.np_radius.label")}</span>
        <select
          value={npRadiusM}
          onChange={e => onChangeNpRadius(Number(e.target.value))}
        >
          {NP_RADIUS_OPTIONS.map(m => (
            <option key={m} value={m}>{m}m</option>
          ))}
        </select>
      </label>

      {/* #52 F24 ④：面名称标签全局显隐开关（默认显示，偏好存 localStorage） */}
      <button
        className={showPolygonLabels ? "active" : ""}
        onClick={onTogglePolygonLabels}
        title={tFn("tb.polygon_labels.tip")}
      >{tFn("tb.polygon_labels.label")}</button>

      <div className="search">
        <input
          placeholder={tFn("tb.search.placeholder")}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submitSearch(); }}
        />
        <button onClick={submitSearch} disabled={!query.trim()} title={tFn("tb.search.tip")}>
          {tFn("tb.search.btn")}
        </button>
        <SearchDropdown
          searchResults={searchResults}
          onResultClick={onResultClick}
          onClearSearch={onClearSearch}
        />
      </div>

      {/* #50 Phase 15：danger 权限门控 [清除基线] / [恢复点]；edit_delete 门控 [删除历史] */}
      {canDanger && (
      <button
        className="danger"
        disabled={busy}
        onClick={onClearBaseline}
        title={tFn("tb.clear.tip")}
      >{tFn("tb.clear.label")}</button>
      )}

      {canDanger && (
      <button
        onClick={onOpenRestorePoints}
        disabled={busy}
        title={tFn("tb.restore.tip")}
      >{tFn("tb.restore.label")}</button>
      )}

      {canEditDelete && (
      <button
        onClick={onOpenDeleteHistory}
        disabled={busy}
        title={tFn("tb.delhist.tip")}
      >{tFn("tb.delhist.label")}</button>
      )}

      {/* #50：当前用户 + [⚙ 管理]（仅 admin，Phase 14 已接通 AdminModal）+ [登出] */}
      <span className="tb-username" title={username}>{username}</span>
      {isAdmin && (
        <button onClick={onOpenAdmin} title={tFn("tb.admin.tip")}>{tFn("tb.admin.label")}</button>
      )}
      <button onClick={onLogout} title={tFn("tb.logout.tip")}>
        {tFn("tb.logout.label")}
      </button>

      {/* #19 主题切换 */}
      <button
        className="theme-toggle"
        onClick={toggleTheme}
        title={theme === "dark" ? tFn("tb.theme.to_light") : tFn("tb.theme.to_dark")}
      >{theme === "dark" ? "☀" : "☾"}</button>

      {/* F18 语言切换 */}
      <button
        className="lang-toggle"
        onClick={toggleLang}
        title={tFn("tb.lang.tip")}
      >{tFn("tb.lang.label")}</button>
    </div>
  );
}
