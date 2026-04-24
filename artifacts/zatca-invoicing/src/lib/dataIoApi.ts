/**
 * Typed client for /api/data-io/*
 * Used by the Settings → Data Import/Export wizard.
 */
const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(token: string | null): HeadersInit {
  const h: HeadersInit = { "Content-Type": "application/json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

export interface FieldDef {
  name: string;
  labelAr: string;
  labelEn: string;
  type: "string" | "number" | "boolean" | "date" | "fk";
  required: boolean;
  enum?: string[];
}

export interface EntityCatalogItem {
  key: string;
  labelAr: string;
  labelEn: string;
  businessKeys: string[];
  fields: FieldDef[];
}

export interface MappingEntry { field: string | null; confidence: number; }

export interface AnalyzeResult {
  entity: string;
  source: "ai" | "fallback";
  mapping: Record<string, MappingEntry>;
  missingRequired: { field: string; labelAr: string }[];
  stats: { totalHeaders: number; mapped: number; unmapped: number };
}

export interface RowIssue {
  rowIndex: number;
  field: string | null;
  type: "missing_required" | "invalid_format" | "fk_unresolved" | "fk_resolved" | "duplicate" | "value_normalized";
  severity: "error" | "warning" | "info";
  before: any;
  after: any;
  action: string;
  confidence: number;
  message: string;
}

export interface ProcessResult {
  entity: string;
  processed: any[];
  issues: RowIssue[];
  stats: { total: number; errors: number; warnings: number; info: number; duplicates: number };
}

export interface CommitLogEntry {
  rowIndex: number;
  status: "inserted" | "updated" | "skipped" | "error";
  id?: number;
  reason?: string;
}

export interface CommitResult {
  entity: string;
  summary: { inserted: number; updated: number; skipped: number; errors: number; total: number };
  log: CommitLogEntry[];
  committedAt: string;
}

export async function fetchEntities(token: string | null): Promise<EntityCatalogItem[]> {
  const r = await fetch(`${API}/api/data-io/entities`, { headers: authHeaders(token) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "فشل تحميل الجداول");
  return r.json();
}

export async function exportData(token: string | null, body: { companyId?: number; types: string[]; format: "json" | "xlsx" }): Promise<Blob> {
  const r = await fetch(`${API}/api/data-io/export`, {
    method: "POST", headers: authHeaders(token), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "فشل التصدير");
  return r.blob();
}

export async function analyzeImport(token: string | null, body: { entity: string; headers: string[]; sampleRows: any[] }): Promise<AnalyzeResult> {
  const r = await fetch(`${API}/api/data-io/import/analyze`, {
    method: "POST", headers: authHeaders(token), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "فشل التحليل");
  return r.json();
}

export async function processImport(token: string | null, body: { companyId?: number; entity: string; mapping: Record<string, string | null>; rows: any[] }): Promise<ProcessResult> {
  const r = await fetch(`${API}/api/data-io/import/process`, {
    method: "POST", headers: authHeaders(token), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "فشل المعالجة");
  return r.json();
}

export async function commitImport(token: string | null, body: { companyId?: number; entity: string; rows: any[]; options?: { skipErrors?: boolean } }): Promise<CommitResult> {
  const r = await fetch(`${API}/api/data-io/import/commit`, {
    method: "POST", headers: authHeaders(token), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "فشل التنفيذ");
  return r.json();
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
