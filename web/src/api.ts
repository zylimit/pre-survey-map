// ---------- GeoJSON ----------

export interface Feature {
  type: "Feature";
  id?: string | number;
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}

export type FeatureCollection = {
  type: "FeatureCollection";
  features: Feature[];
};

// ---------- Import 协议（三阶段，Spec #12）----------

export type Decision = "overwrite" | "ignore";
export type CleaningAction = "auto_fix" | "keep" | "discard";
export type CleaningIssue = "swap_latlong" | "missing_decimal" | "in_sea" | "not_in_baseline";

export interface ConflictRow {
  key: string;
  kind: "site" | "lessor";
  name: string;
  existing: Record<string, unknown>;
  incoming: Record<string, unknown>;
  source_file: string;
}

export interface CleaningRow {
  row_id: string;
  kind: "site" | "road" | "lessor";
  name: string;
  file_name: string;
  issue: CleaningIssue;
  current_coord: { lat: number | null; lng: number | null };
  fixed_coord_preview: { lat: number; lng: number } | null;
  default_action: CleaningAction;
  country_iso_a2?: string | null;
  country_name_zh?: string | null;
  country_name_en?: string | null;
}

export interface BaselineRegion {
  country_iso_a2: string | null;
  country_name_zh: string | null;
  country_name_en?: string | null;
  source: "baseline" | "current_file";
  coverage_pct: number;
  points_used: number;
  points_total: number;
}

export interface FileReport {
  name: string;
  type: string;
  parsed?: { site: number; road: number; lessor: number };
  error?: string;
}

export interface ImportSummaryRow {
  non_conflict: number;
  conflict: number;
}

export interface Phase1Summary {
  total_parsed: number;
  intra_file_duplicates: {
    site_groups: number;
    site_discarded: number;
    lessor_groups: number;
    lessor_discarded: number;
  };
  after_dedup: { site: number; road: number; lessor: number };
  cleanings_count: number;
}

export interface Phase1Response {
  session_id: string;
  file: FileReport;
  summary: Phase1Summary;
  baseline_region: BaselineRegion | null;
  cleanings: CleaningRow[];
  warn_all_outside_baseline?: boolean;  // Spec #15 雷 29
}

export interface Phase2Response {
  session_id: string;
  summary: { site: ImportSummaryRow; road: ImportSummaryRow; lessor: ImportSummaryRow };
  conflicts: ConflictRow[];
  cleaning_stats: { auto_fixed: number; kept: number; discarded: number };
}

export interface CommitStat {
  inserted: number;
  updated: number;
  ignored: number;
}

export interface CommitResponse {
  stats: { site: CommitStat; road: CommitStat; lessor: CommitStat };
  cleaning_stats: { auto_fixed: number; kept: number; discarded: number };
  baseline_established: {
    iso_a2: string;
    name_zh: string | null;
    name_en?: string | null;
    coverage_pct: number | null;
    points_used: number | null;
  } | null;
}

// 单文件上传（Spec F1 #12）
export async function uploadFile(file: File): Promise<Phase1Response> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/import", { method: "POST", body: fd });
  if (!res.ok) {
    if (res.status === 413) {
      throw new Error("服务端拒绝：文件超过 100MB 上限");
    }
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function proceedToConflicts(
  sessionId: string,
  decisions: { row_id: string; action: CleaningAction }[]
): Promise<Phase2Response> {
  const res = await fetch(`/api/import/${sessionId}/proceed-to-conflicts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisions }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function backToCleaning(sessionId: string): Promise<{
  session_id: string;
  cleanings: CleaningRow[];
  baseline_region: BaselineRegion | null;
  cleaning_decisions: Record<string, CleaningAction>;
}> {
  const res = await fetch(`/api/import/${sessionId}/back-to-cleaning`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function commitImport(
  sessionId: string,
  decisions: { key: string; action: Decision }[]
): Promise<CommitResponse> {
  const res = await fetch(`/api/import/${sessionId}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisions }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function cancelImport(sessionId: string): Promise<void> {
  await fetch(`/api/import/${sessionId}`, { method: "DELETE" });
}

// F14 清除基线（Spec #15：truncate 范围扩到 4 张表，含 baseline_state）
export async function clearBaseline(): Promise<{
  deleted: { site: number; road: number; lessor: number; baseline_state: number };
}> {
  const res = await fetch("/api/baseline", { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// F15 全局基线状态栏数据
export interface BaselineState {
  established: boolean;
  iso_a2?: string;
  name_zh?: string;
  name_en?: string;
  coverage_pct?: number;
  points_used?: number;
  established_at?: string;
}

export async function fetchBaselineState(): Promise<BaselineState> {
  const res = await fetch("/api/baseline-state");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function downloadConflictsXlsx(sessionId: string): Promise<void> {
  const res = await fetch(`/api/import/${sessionId}/conflicts.xlsx`);
  await downloadResponse(res, "conflicts.xlsx");
}

export async function fetchAll(): Promise<{
  sites: FeatureCollection;
  roads: FeatureCollection;
  lessors: FeatureCollection;
}> {
  const [sites, roads, lessors] = await Promise.all([
    fetch("/api/sites").then(r => r.json()),
    fetch("/api/roads").then(r => r.json()),
    fetch("/api/lessors").then(r => r.json()),
  ]);
  return { sites, roads, lessors };
}

// ---------- F17 恢复点 ----------

export interface RestorePoint {
  id: number;
  created_at: string;
  reason: "pre_import" | "pre_clear" | "pre_rollback" | "manual";
  note: string | null;
  site_count: number | null;
  road_count: number | null;
  lessor_count: number | null;
  baseline_iso_a2: string | null;
}

export async function listRestorePoints(): Promise<RestorePoint[]> {
  const res = await fetch("/api/restore-points");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createRestorePoint(note?: string): Promise<RestorePoint> {
  const res = await fetch("/api/restore-points", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: note ?? null }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function rollbackToPoint(id: number): Promise<void> {
  const res = await fetch(`/api/restore-points/${id}/rollback`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function deleteRestorePoint(id: number): Promise<void> {
  const res = await fetch(`/api/restore-points/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ---------- F19 审计日志（Spec V1.x #23）----------

export type AuditAction =
  | "open"
  | "import"
  | "export_full"
  | "export_region"
  | "export_conflicts"
  | "restore_point_create_auto"
  | "restore_point_create_manual"
  | "restore_point_delete"
  | "restore_point_rollback"
  | "restore_point_undo_last_import"
  | "clear_baseline"
  | "audit_log_export";

export interface AuditLogItem {
  id: number;
  ts: string;
  session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  action: AuditAction;
  details: Record<string, unknown> | null;
  result: string;
  error_msg: string | null;
}

export interface AuditLogPage {
  items: AuditLogItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface AuditFilters {
  action?: string;
  from?: string;   // ISO datetime
  to?: string;
}

function buildAuditQuery(f: AuditFilters, page: number, pageSize: number): string {
  const q = new URLSearchParams();
  if (f.action) q.set("action", f.action);
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  q.set("page", String(page));
  q.set("page_size", String(pageSize));
  return q.toString();
}

export async function listAuditLog(
  filters: AuditFilters,
  page = 1,
  pageSize = 50,
): Promise<AuditLogPage> {
  const res = await fetch(`/api/audit-log?${buildAuditQuery(filters, page, pageSize)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function exportAuditLog(filters: AuditFilters): Promise<void> {
  const q = new URLSearchParams();
  if (filters.action) q.set("action", filters.action);
  if (filters.from) q.set("from", filters.from);
  if (filters.to) q.set("to", filters.to);
  const res = await fetch(`/api/audit-log/export?${q.toString()}`);
  await downloadResponse(res, "audit_log.xlsx");
}

// ---------- Export ----------

export interface GeoJSONPolygon {
  type: "Polygon";
  coordinates: number[][][];
}

// 拿到 blob + 文件名后触发浏览器下载
async function downloadResponse(res: Response, fallback: string): Promise<void> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const disp = res.headers.get("X-Filename") || res.headers.get("Content-Disposition") || "";
  const m = disp.match(/filename="?([^"]+)"?/);
  const filename = m ? m[1] : fallback;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function exportAll(): Promise<void> {
  const res = await fetch("/api/export/all");
  await downloadResponse(res, "export_full.kmz");
}

export async function exportSelection(polygon: GeoJSONPolygon): Promise<void> {
  const res = await fetch("/api/export/selection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ polygon }),
  });
  await downloadResponse(res, "export_region.kmz");
}
