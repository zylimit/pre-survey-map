import { useEffect, useRef, useState } from "react";
import { DrawMode } from "../state";
import { useLang, useT } from "../i18n";

interface Props {
  onImport: (files: File[]) => void;
  busy: boolean;
  drawMode: DrawMode;
  hasSelection: boolean;
  onStartDraw: (mode: DrawMode) => void;
  onClearSelection: () => void;
  onExportAll: () => void;
  onExportSelection: () => void;
  onRefresh: () => void;
  onSearch: (query: string) => void;
  onClearBaseline: () => void;
  onOpenRestorePoints: () => void;
}

export default function Toolbar({
  onImport, busy, drawMode, hasSelection,
  onStartDraw, onClearSelection, onExportAll, onExportSelection,
  onRefresh, onSearch, onClearBaseline, onOpenRestorePoints,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
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

  const pick = () => inputRef.current?.click();
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onImport(files);
    e.target.value = "";
  };

  const submitSearch = () => {
    const q = query.trim();
    if (q) onSearch(q);
  };

  const drawLabel = drawMode
    ? tFn(drawMode === "polygon" ? "tb.draw.active.poly" : "tb.draw.active.rect")
    : tFn("tb.draw.label");

  return (
    <div className="toolbar" ref={rootRef}>
      <button onClick={pick} disabled={busy} title={tFn("tb.import.tip")}>
        {busy ? tFn("tb.import.busy") : tFn("tb.import.label")}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".kml,.kmz,.xlsx"
        style={{ display: "none" }}
        onChange={onChange}
      />

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
      </div>

      <button
        className="danger"
        disabled={busy}
        onClick={onClearBaseline}
        title={tFn("tb.clear.tip")}
      >{tFn("tb.clear.label")}</button>

      <button
        onClick={onOpenRestorePoints}
        disabled={busy}
        title={tFn("tb.restore.tip")}
      >{tFn("tb.restore.label")}</button>

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
