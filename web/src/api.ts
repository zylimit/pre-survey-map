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

// ---------- Import 协议（两阶段） ----------

export type Decision = "overwrite" | "ignore";

export interface ConflictRow {
  key: string;
  kind: "site" | "lessor";
  name: string;
  existing: Record<string, unknown>;
  incoming: Record<string, unknown>;
  source_file: string;
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

export interface CoordWarning {
  key: string;
  name: string;
  source_file: string;
  message: string;
}

export interface ImportSessionResponse {
  session_id: string;
  files: FileReport[];
  summary: { site: ImportSummaryRow; road: ImportSummaryRow; lessor: ImportSummaryRow };
  conflicts: ConflictRow[];
  warnings: CoordWarning[];
}

export interface CommitStat {
  inserted: number;
  updated: number;
  ignored: number;
}

export interface CommitResponse {
  stats: { site: CommitStat; road: CommitStat; lessor: CommitStat };
}

export async function uploadFiles(files: File[]): Promise<ImportSessionResponse> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const res = await fetch("/api/import", { method: "POST", body: fd });
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
