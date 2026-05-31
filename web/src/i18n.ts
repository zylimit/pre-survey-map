/**
 * F18 · 双语界面（Spec V1.x #21）
 * 模块级 t() 供 state.ts 等非组件代码调用；
 * LangProvider + useT() 供 React 组件调用（变更时触发重渲染）。
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

export type Lang = "en" | "zh";
type Vars = Record<string, string | number>;

// ---------- 字典 ----------

const en = {
  // Toolbar
  "tb.import.tip":         "Import KML / KMZ / Excel",
  "tb.import.busy":        "⏳ Processing...",
  "tb.import.label":       "📁 Import",
  "tb.export.label":       "💾 Export KMZ ▾",
  "tb.export.all":         "Export All",
  "tb.export.selection":   "Export Selection",
  "tb.export.nosel.tip":   "Draw a selection area first",
  "tb.export.nosel.txt":   "Export Selection (no area drawn)",
  "tb.draw.label":         "⬛ Selection ▾",
  "tb.draw.polygon":       "Free Polygon",
  "tb.draw.rect":          "Rectangle",
  "tb.draw.clear":         "Clear Selection",
  "tb.draw.active.poly":   "⬛ Selection · Polygon",
  "tb.draw.active.rect":   "⬛ Selection · Rectangle",
  "tb.refresh.label":      "🔄 Refresh",
  "tb.refresh.tip":        "Reload data + reconnect DB",
  "tb.search.placeholder": "🔍 Search Site / Road / Lessor...",
  "tb.search.tip":         "Press Enter to search",
  "tb.search.btn":         "Go",
  "tb.clear.label":        "🗑️ Clear Baseline",
  "tb.clear.tip":          "Truncate site / road / lessor + reset baseline",
  "tb.restore.label":      "🕘 Restore Points",
  "tb.restore.tip":        "View / create / rollback restore points",
  "tb.theme.to_light":     "Switch to light mode",
  "tb.theme.to_dark":      "Switch to dark mode",
  "tb.lang.label":         "中",
  "tb.lang.tip":           "Switch to Chinese",

  // MapView basemap labels + drag
  "map.basemap.esri":      "Esri Sat",
  "map.basemap.google":    "Google Sat",
  "map.drop.hint":         "Drop to import file",

  // LayerTree
  "lt.filter.placeholder": "🔍 Filter nodes...",
  "lt.folder.toggle.tip":  "Toggle all on/off",
  "lt.folder.expand":      "Expand",
  "lt.folder.collapse":    "Collapse",
  "lt.node.show":          "Show",
  "lt.node.hide":          "Hide",
  "lt.empty":              "No data",

  // BaselineStatusBar
  "bs.pending":            "Baseline not established · Will lock after first import",
  "bs.country":            "Baseline:",
  "bs.established":        "est.",
  "bs.coverage":           "coverage",
  "bs.points":             "pts",

  // OutputPanel phases
  "phase.idle":            "Ready",
  "phase.loading":         "Loading data...",
  "phase.uploading":       "Uploading + parsing...",
  "phase.cleaning":        "Awaiting cleaning decisions",
  "phase.conflicts":       "Awaiting conflict decisions",
  "phase.committing":      "Committing...",
  "phase.exporting":       "Exporting...",

  // OutputPanel misc
  "op.db.checking":        "DB checking",
  "op.db.ok":              "DB connected",
  "op.db.error":           "DB disconnected",
  "op.search.summary":     "🔍 {count} results · flying to first",
  "op.search.header":      "Search Results",
  "op.search.clear.tip":   "Clear results only, keep logs",
  "op.search.clear.btn":   "✖ Clear Results",
  "op.search.none":        "No matching features",
  "op.search.capped":      "Showing first {cap} results — refine your query",
  "op.logs.header":        "Logs (last 50)",
  "op.logs.clear":         "Clear",
  "op.logs.empty":         "No logs yet",

  // RestorePointDialog
  "rp.title":              "🕘 Restore Points",
  "rp.create":             "+ Create Restore Point",
  "rp.undo":               "↩ Undo Last Import",
  "rp.undo.tip":           "Roll back to state before last import",
  "rp.undo.none.tip":      "No import record to undo",
  "rp.loading":            "Loading...",
  "rp.empty":              "No restore points yet",
  "rp.rollback":           "Rollback",
  "rp.delete":             "Delete",
  "rp.reason.pre_import":  "Before Import",
  "rp.reason.pre_clear":   "Before Clear",
  "rp.reason.pre_rollback":"Before Rollback",
  "rp.reason.manual":      "Manual",
  "rp.confirm.title":      "Overwrite Rollback",
  "rp.confirm.body":       "Roll back to [{reason}] restore point\n({time}, site {s} · road {r} · lessor {l})\n\nCurrent data will be completely replaced.\nA [Before Rollback] point will be auto-created so you can undo.\n\nContinue?",
  "rp.confirm.ok":         "Confirm Rollback",
  "rp.confirm.cancel":     "Cancel",

  // CleaningDialog
  "cl.step":               "Step 1: Data Cleaning · {file}",
  "cl.baseline.none":      "Baseline region: unidentified (no country detected from DB or file)",
  "cl.baseline.db":        "Baseline region: {name} (from baseline {used}/{total} pts, {pct}%)",
  "cl.baseline.file":      "Baseline region: {name} (from file {used}/{total} pts, {pct}% · will lock on first import)",
  "cl.warn.all_outside":   "⚠️ All {count} points are outside baseline country ({iso}) · likely wrong file",
  "cl.warn.change":        "To change baseline click [🗑️ Clear Baseline].",
  "cl.banner.parsed":      "Parsed {site} site / {road} road / {lessor} lessor",
  "cl.banner.dedup":       "Intra-file dedup: site {siteG} groups (−{siteD}) · lessor {lessorG} groups (−{lessorD})",
  "cl.banner.issues":      "Cleaning issues: {n}",
  "cl.issue.swap":         "Lat/Lng Swapped",
  "cl.issue.decimal":      "Missing Decimal",
  "cl.issue.sea":          "In the Sea",
  "cl.issue.baseline":     "Outside Baseline",
  "cl.batch.fix":          "Fix All",
  "cl.batch.keep":         "Keep All",
  "cl.batch.discard":      "Discard All",
  "cl.batch.reset":        "Reset to Default",
  "cl.batch.status":       "Selected: fix {fix} · keep {keep} · discard {discard}",
  "cl.col.type":           "Type",
  "cl.col.name":           "Name",
  "cl.col.file":           "Source File",
  "cl.col.issue":          "Issue",
  "cl.col.coord":          "Current Coord",
  "cl.col.preview":        "Fixed Preview",
  "cl.col.default":        "Default",
  "cl.col.action":         "Action",
  "cl.no_issues":          "✓ No cleaning issues — proceed to next step",
  "cl.action.fix":         "Auto-fix",
  "cl.action.keep":        "Keep",
  "cl.action.force_keep":  "Force Keep",
  "cl.action.discard":     "Discard",
  "cl.cancel":             "Cancel Import",
  "cl.next":               "Next: Conflict Check →",

  // ConflictDialog
  "co.step":               "Step 2:",
  "co.title":              "⚠️ Conflicts ({count})",
  "co.batch.overwrite":    "Overwrite All",
  "co.batch.ignore":       "Ignore All",
  "co.batch.toggle":       "Toggle",
  "co.batch.status":       "Selected: overwrite {ov} · ignore {ig}",
  "co.col.type":           "Type",
  "co.col.name":           "Name",
  "co.col.existing":       "In DB",
  "co.col.incoming":       "From File",
  "co.col.file":           "Source File",
  "co.col.action":         "Action",
  "co.action.overwrite":   "Overwrite",
  "co.action.ignore":      "Ignore",
  "co.back":               "← Back to Step 1",
  "co.cancel":             "Cancel (Download Conflicts Excel)",
  "co.confirm":            "Confirm Import (overwrite {ov} · ignore {ig})",

  // ImportStepper
  "is.step1":              "1. Data Cleaning",
  "is.step2":              "2. Conflict Check",

  // AttributePanel
  "ap.title":              "📋 Attributes",
  "ap.placeholder":        "Click a map feature or tree node to view attributes",
  "ap.source":             "Source File",
  "ap.coord_warn":         "⚠️ Coordinate anomaly (Lat/Lng swapped or missing decimal) — check source file",
  "ap.core":               "Core Fields",
  "ap.extras":             "Extra Fields ({n})",
  "ap.close":              "Close",
  "ap.feature":            "Feature",

  // ConfirmDialog defaults
  "dlg.ok":                "OK",
  "dlg.cancel":            "Cancel",

  // App — clear baseline confirm
  "app.clear.title":       "Clear Baseline Data",
  "app.clear.body":        "This will delete ALL data in site / road / lessor tables.\nThe baseline country will also be reset.\nThis cannot be undone. Continue?",
  "app.clear.confirm":     "Clear",
  "app.clear.cancel":      "Cancel",

  // state.ts log messages
  "log.baseline_err":      "Baseline state fetch failed: {msg}",
  "log.multi_file":        "Ignored {n} extra file(s) (V1 accepts one at a time): {names}",
  "log.file_too_large":    "File {name} ({size}MB) exceeds {limit}MB limit, rejected",
  "log.upload_start":      "Uploading: {name}",
  "log.parse_ok":          "Parsed {count} rows; dedup {groups} groups (−{discarded}); {cleanings} cleaning issues pending",
  "log.upload_err":        "Upload failed: {msg}",
  "log.cleaning_saved":    "Cleaning saved (fix {af} / keep {k} / discard {d}); {count} conflicts pending; not committed yet",
  "log.conflict_err":      "Conflict detection failed: {msg}",
  "log.back_err":          "Back to cleaning failed: {msg}",
  "log.committing":        "Committing ({file})...",
  "log.commit_ok":         "Commit done: fix {af}/discard {d}; site {si}+{su}/{sn}, road {ri}/—, lessor {li}+{lu}/{ln}",
  "log.baseline_fixed":    "✅ Baseline locked: {name} ({iso}) · {pct}% coverage",
  "log.commit_err":        "Commit failed: {msg}",
  "log.cancel_ok":         "Import cancelled ({file}), DB unchanged{extra}",
  "log.cancel_err":        "Cancel import failed: {msg}",
  "log.clear_ok":          "Baseline cleared: site −{s} / road −{r} / lessor −{l}",
  "log.clear_err":         "Clear baseline failed: {msg}",
  "log.coord_err":         "{id} coordinate anomaly, cannot locate (fix source file and re-import)",
  "log.selection_drawn":   "Selection drawn — click [Export KMZ ▾ → Export Selection] to download",
  "log.export_all_start":  "Exporting all...",
  "log.export_all_ok":     "Full KMZ download triggered",
  "log.export_all_err":    "Export failed: {msg}",
  "log.no_selection":      "No selection drawn",
  "log.export_sel_start":  "Exporting selection...",
  "log.export_sel_ok":     "Selection KMZ download triggered",
  "log.export_sel_err":    "Selection export failed: {msg}",
  "log.refresh_start":     "Refreshing data...",
  "log.refresh_ok":        "Refresh done: site {s} · road {r} · lessor {l}",
  "log.refresh_err":       "Refresh failed: {msg}",
  "log.search_err":        "Search failed: {msg}",
  "log.load_err":          "Initial load failed: {msg}",
  "log.cancel_ok_extra":   ", conflict list also downloaded as Excel",
  "log.cancel_excel_err":  "Download conflict Excel failed: {msg}",
  "log.clear_ok_reset":    " (baseline reset)",
  "cl.banner.summary":     "Parsed {total}; dedup {groups} groups (−{discarded}); {cleanings} cleaning issues",
  "co.no_coord":           "(no coord)",
} as const;

const zh: Record<keyof typeof en, string> = {
  "tb.import.tip":         "导入 KML / KMZ / Excel",
  "tb.import.busy":        "⏳ 处理中...",
  "tb.import.label":       "📁 导入",
  "tb.export.label":       "💾 导出 KMZ ▾",
  "tb.export.all":         "导出整库",
  "tb.export.selection":   "导出选区",
  "tb.export.nosel.tip":   "请先用框选工具绘制选区",
  "tb.export.nosel.txt":   "导出选区（未绘制选区）",
  "tb.draw.label":         "⬛ 框选 ▾",
  "tb.draw.polygon":       "自由多边形",
  "tb.draw.rect":          "矩形",
  "tb.draw.clear":         "清除选区",
  "tb.draw.active.poly":   "⬛ 框选 ▾ · 多边形",
  "tb.draw.active.rect":   "⬛ 框选 ▾ · 矩形",
  "tb.refresh.label":      "🔄 刷新",
  "tb.refresh.tip":        "重载数据 + 重连 DB 状态",
  "tb.search.placeholder": "🔍 搜索 Site / Road / Lessor...",
  "tb.search.tip":         "按 Enter 也可搜索",
  "tb.search.btn":         "搜",
  "tb.clear.label":        "🗑️ 清除基线",
  "tb.clear.tip":          "清空 site / road / lessor 三表 + 重置主基准",
  "tb.restore.label":      "🕘 恢复点",
  "tb.restore.tip":        "查看 / 创建 / 回滚恢复点",
  "tb.theme.to_light":     "切换到亮色",
  "tb.theme.to_dark":      "切换到暗色",
  "tb.lang.label":         "EN",
  "tb.lang.tip":           "切换到英文",

  // MapView basemap labels + drag
  "map.basemap.esri":      "Esri 卫星",
  "map.basemap.google":    "Google 卫星",
  "map.drop.hint":         "释放鼠标导入文件",

  // LayerTree
  "lt.filter.placeholder": "🔍 过滤节点...",
  "lt.folder.toggle.tip":  "点击全选/全关",
  "lt.folder.expand":      "展开",
  "lt.folder.collapse":    "折叠",
  "lt.node.show":          "勾选显示",
  "lt.node.hide":          "取消勾选隐藏",
  "lt.empty":              "暂无数据",

  "bs.pending":            "基线未确立 · 首次导入完成后将自动锁定",
  "bs.country":            "基线国家：",
  "bs.established":        "固化于",
  "bs.coverage":           "覆盖",
  "bs.points":             "点",

  "phase.idle":            "就绪",
  "phase.loading":         "加载数据中...",
  "phase.uploading":       "上传 + 解析中...",
  "phase.cleaning":        "等待用户处理清洗",
  "phase.conflicts":       "等待用户处理冲突",
  "phase.committing":      "入库中...",
  "phase.exporting":       "导出中...",

  "op.db.checking":        "DB 检测中",
  "op.db.ok":              "DB 已连接",
  "op.db.error":           "DB 断开",
  "op.search.summary":     "🔍 搜索匹配 {count} 条，飞到第一条",
  "op.search.header":      "搜索结果",
  "op.search.clear.tip":   "只清搜索结果，不动日志",
  "op.search.clear.btn":   "✖ 清空结果",
  "op.search.none":        "未匹配到任何要素",
  "op.search.capped":      "仅显示前 {cap} 条，请细化关键词",
  "op.logs.header":        "日志（最近 50 条）",
  "op.logs.clear":         "清空",
  "op.logs.empty":         "暂无日志",

  "rp.title":              "🕘 恢复点",
  "rp.create":             "+ 手动建恢复点",
  "rp.undo":               "↩ 撤销上一次导入",
  "rp.undo.tip":           "回滚到最近一次导入前的状态",
  "rp.undo.none.tip":      "没有可撤销的导入记录",
  "rp.loading":            "加载中...",
  "rp.empty":              "暂无恢复点",
  "rp.rollback":           "回滚",
  "rp.delete":             "删除",
  "rp.reason.pre_import":  "导入前",
  "rp.reason.pre_clear":   "清除前",
  "rp.reason.pre_rollback":"回滚前",
  "rp.reason.manual":      "手动",
  "rp.confirm.title":      "覆盖式回滚",
  "rp.confirm.body":       "回滚到「{reason}」恢复点\n（{time}，site {s} · road {r} · lessor {l}）\n\n当前数据将被完全替换。\n回滚前会自动建一个「回滚前」恢复点，可再退回。\n\n确定继续？",
  "rp.confirm.ok":         "确定回滚",
  "rp.confirm.cancel":     "取消",

  "cl.step":               "步骤 1：数据清洗 · {file}",
  "cl.baseline.none":      "基准区域：未识别（库与本文件都无法定位到任何国家）",
  "cl.baseline.db":        "基准区域：{name}（来自基线 {used}/{total} 个点，{pct}%）",
  "cl.baseline.file":      "基准区域：{name}（来自本文件 {used}/{total} 个点，{pct}% · 首次导入将固化为基线）",
  "cl.warn.all_outside":   "⚠️ 全部 {count} 个点均不在基线国家（{iso}）内 · 可能文件有误",
  "cl.warn.change":        "要换基线请点 [🗑️ 清除基线]。",
  "cl.banner.parsed":      "文件解析 {site} 个 site / {road} 条 road / {lessor} 个 lessor",
  "cl.banner.dedup":       "文件内重复去重：site {siteG} 组（丢弃 {siteD}）· lessor {lessorG} 组（丢弃 {lessorD}）",
  "cl.banner.issues":      "待清洗 {n} 条异常",
  "cl.issue.swap":         "坐标写反",
  "cl.issue.decimal":      "漏小数点",
  "cl.issue.sea":          "在海里",
  "cl.issue.baseline":     "不在主基准",
  "cl.batch.fix":          "全部自动修复",
  "cl.batch.keep":         "全部保留",
  "cl.batch.discard":      "全部丢弃",
  "cl.batch.reset":        "按默认动作重置",
  "cl.batch.status":       "已选：自动修复 {fix} · 保留 {keep} · 丢弃 {discard}",
  "cl.col.type":           "类型",
  "cl.col.name":           "名称",
  "cl.col.file":           "来源文件",
  "cl.col.issue":          "问题",
  "cl.col.coord":          "当前坐标",
  "cl.col.preview":        "修复后预览",
  "cl.col.default":        "默认",
  "cl.col.action":         "操作",
  "cl.no_issues":          "✓ 未检测到清洗异常，直接进入下一步",
  "cl.action.fix":         "自动修复",
  "cl.action.keep":        "原样保留",
  "cl.action.force_keep":  "强制保留",
  "cl.action.discard":     "丢弃",
  "cl.cancel":             "取消导入",
  "cl.next":               "下一步：冲突检测 →",

  "co.step":               "步骤 2：",
  "co.title":              "⚠️ 冲突列表（共 {count} 条）",
  "co.batch.overwrite":    "全部覆盖",
  "co.batch.ignore":       "全部忽略",
  "co.batch.toggle":       "反选",
  "co.batch.status":       "已选：覆盖 {ov} · 忽略 {ig}",
  "co.col.type":           "类型",
  "co.col.name":           "名称",
  "co.col.existing":       "库里现状",
  "co.col.incoming":       "导入文件",
  "co.col.file":           "来源文件名",
  "co.col.action":         "操作",
  "co.action.overwrite":   "覆盖",
  "co.action.ignore":      "忽略",
  "co.back":               "← 返回步骤 1",
  "co.cancel":             "取消（下载冲突 Excel）",
  "co.confirm":            "确认导入（覆盖 {ov} · 忽略 {ig}）",

  "is.step1":              "1. 数据清洗",
  "is.step2":              "2. 冲突检测",

  "ap.title":              "📋 属性面板",
  "ap.placeholder":        "点击地图要素或左侧树节点查看属性",
  "ap.source":             "来源文件",
  "ap.coord_warn":         "⚠️ 坐标异常（LATI/LONGI 写反或漏小数点），请核对源文件",
  "ap.core":               "核心字段",
  "ap.extras":             "扩展字段（{n}）",
  "ap.close":              "关闭",
  "ap.feature":            "要素",

  "dlg.ok":                "确定",
  "dlg.cancel":            "取消",

  "app.clear.title":       "清除基线数据",
  "app.clear.body":        "此操作将清空 site / road / lessor 三表的所有数据。\n本操作不可撤销，主基准区域也会被重置。\n确定继续吗?",
  "app.clear.confirm":     "确定清除",
  "app.clear.cancel":      "取消",

  "log.baseline_err":      "获取基线状态失败：{msg}",
  "log.multi_file":        "已忽略其他 {n} 个文件（V1 一次只能传一个）：{names}",
  "log.file_too_large":    "文件 {name}（{size}MB）超过 {limit}MB 上限，已拒绝",
  "log.upload_start":      "开始上传：{name}",
  "log.parse_ok":          "解析 {count} 条；文件内重复去重 {groups} 组（丢弃 {discarded}）；检测异常 {cleanings} 条，等待用户决策（尚未写库）",
  "log.upload_err":        "导入失败：{msg}",
  "log.cleaning_saved":    "清洗决策已暂存（自动修复 {af} / 保留 {k} / 丢弃 {d}）；待处理冲突 {count} 条；尚未写库",
  "log.conflict_err":      "进入冲突检测失败：{msg}",
  "log.back_err":          "返回清洗步骤失败：{msg}",
  "log.committing":        "正在入库（{file}）...",
  "log.commit_ok":         "入库完成：清洗 fix {af}/丢弃 {d}；site {si}+{su}/{sn}，road {ri}/—，lessor {li}+{lu}/{ln}",
  "log.baseline_fixed":    "✅ 主基准已固化：{name}（{iso}）· {pct}% 覆盖",
  "log.commit_err":        "入库失败：{msg}",
  "log.cancel_ok":         "已取消导入（{file}），数据库未变动{extra}",
  "log.cancel_err":        "取消导入失败：{msg}",
  "log.clear_ok":          "基线已清空：site −{s} / road −{r} / lessor −{l}",
  "log.clear_err":         "清除基线失败：{msg}",
  "log.coord_err":         "{id} 坐标异常，无法定位（请修源文件后重新导入）",
  "log.selection_drawn":   "已绘制选区，可点 [导出 KMZ ▾ → 导出选区] 下载",
  "log.export_all_start":  "整库导出中...",
  "log.export_all_ok":     "整库 KMZ 下载已触发",
  "log.export_all_err":    "整库导出失败：{msg}",
  "log.no_selection":      "未绘制选区",
  "log.export_sel_start":  "选区导出中...",
  "log.export_sel_ok":     "选区 KMZ 下载已触发",
  "log.export_sel_err":    "选区导出失败：{msg}",
  "log.refresh_start":     "刷新数据...",
  "log.refresh_ok":        "刷新完成：site {s} · road {r} · lessor {l}",
  "log.refresh_err":       "刷新失败：{msg}",
  "log.search_err":        "搜索失败：{msg}",
  "log.load_err":          "首次加载失败：{msg}",
  "log.cancel_ok_extra":   "，冲突列表已下载为 Excel",
  "log.cancel_excel_err":  "下载冲突 Excel 失败：{msg}",
  "log.clear_ok_reset":    "（主基准已重置）",
  "cl.banner.summary":     "文件解析 {total} 条；文件内重复去重 {groups} 组（丢弃 {discarded} 个）；检测异常 {cleanings} 条",
  "co.no_coord":           "(无坐标)",
};

// ---------- 模块级状态 ----------

let _lang: Lang = (() => {
  try { return (localStorage.getItem("presurvey.lang") as Lang) || "en"; }
  catch { return "en"; }
})();

function _translate(key: keyof typeof en, lang: Lang, vars?: Vars): string {
  const dict = lang === "zh" ? zh : en;
  let s: string = dict[key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}

export type I18nKey = keyof typeof en;

/** 模块级翻译函数，可在 state.ts 等非 React 代码中直接调用 */
export function t(key: I18nKey, vars?: Vars): string {
  return _translate(key, _lang, vars);
}

export function getLang(): Lang { return _lang; }

// ---------- React Context ----------

type LangCtxType = { lang: Lang; toggleLang: () => void };

const LangCtx = createContext<LangCtxType>({ lang: "en", toggleLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(_lang);

  const toggleLang = useCallback(() => {
    const next: Lang = lang === "en" ? "zh" : "en";
    _lang = next;
    try { localStorage.setItem("presurvey.lang", next); } catch {}
    document.documentElement.setAttribute("data-lang", next);
    setLangState(next);
  }, [lang]);

  return createElement(LangCtx.Provider, { value: { lang, toggleLang } }, children);
}

export function useLang(): LangCtxType {
  return useContext(LangCtx);
}

/** React 组件用：返回翻译函数，lang 变化时组件自动重渲染 */
export function useT(): (key: I18nKey, vars?: Vars) => string {
  const { lang } = useLang();
  return useCallback(
    (key: I18nKey, vars?: Vars) => _translate(key, lang, vars),
    [lang],
  );
}
