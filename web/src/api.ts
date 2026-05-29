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
}

export interface BaselineRegion {
  country_iso_a2: string | null;
  country_name_zh: string | null;
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

// F14 清除基线
export async function clearBaseline(): Promise<{
  deleted: { site: number; road: number; lessor: number };
}> {
  const res = await fetch("/api/baseline", { method: "DELETE" });
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
