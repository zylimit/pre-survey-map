import { useEffect, useRef, useState } from "react";
import { DrawMode } from "../state";

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
}

export default function Toolbar({
  onImport, busy, drawMode, hasSelection,
  onStartDraw, onClearSelection, onExportAll, onExportSelection,
  onRefresh, onSearch, onClearBaseline,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [openMenu, setOpenMenu] = useState<"export" | "draw" | null>(null);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="toolbar" ref={rootRef}>
      <button onClick={pick} disabled={busy} title="导入 KML/KMZ/Excel">
        {busy ? "⏳ 处理中..." : "📁 导入"}
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
          title="导出 KMZ"
        >
          💾 导出 KMZ ▾
        </button>
        {openMenu === "export" && (
          <div className="dropdown-menu">
            <div className="dropdown-item" onClick={() => { setOpenMenu(null); onExportAll(); }}>
              导出整库
            </div>
            <div
              className={`dropdown-item ${hasSelection ? "" : "disabled"}`}
              onClick={() => hasSelection && (setOpenMenu(null), onExportSelection())}
              title={hasSelection ? "" : "请先用框选工具绘制选区"}
            >
              导出选区{!hasSelection && "（未绘制选区）"}
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
          ⬛ 框选 ▾{drawMode ? ` · ${drawMode === "polygon" ? "多边形" : "矩形"}` : ""}
        </button>
        {openMenu === "draw" && (
          <div className="dropdown-menu">
            <div className="dropdown-item" onClick={() => { setOpenMenu(null); onStartDraw("polygon"); }}>
              自由多边形
            </div>
            <div className="dropdown-item" onClick={() => { setOpenMenu(null); onStartDraw("rectangle"); }}>
              矩形
            </div>
            {(drawMode || hasSelection) && (
              <div
                className="dropdown-item danger"
                onClick={() => { setOpenMenu(null); onClearSelection(); }}
              >
                清除选区
              </div>
            )}
          </div>
        )}
      </div>

      <button onClick={onRefresh} disabled={busy} title="重载数据 + 重连 DB 状态">
        🔄 刷新
      </button>

      <div className="search">
        <input
          placeholder="🔍 搜索 Site / Road / Lessor..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") submitSearch();
          }}
        />
        <button onClick={submitSearch} disabled={!query.trim()} title="按 Enter 也可搜索">
          搜
        </button>
      </div>

      {/* F14 清除基线（调试 / 主基准误固化后兜底）*/}
      <button
        className="danger"
        disabled={busy}
        onClick={onClearBaseline}
        title="清空 site / road / lessor 三表 + 重置主基准"
      >🗑️ 清除基线</button>
    </div>
  );
}
