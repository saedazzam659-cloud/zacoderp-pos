// ─────────────────────────────────────────────────────────────────────────
// Frontend extension registry — the host side of the Extension Platform.
//
// Talks ONLY to the permissioned, tenant-scoped /api/ext surface. It never
// imports partner code; partner UI is rendered exclusively inside a sandboxed
// iframe (see PartnerScreenWrapper). This keeps the core source invisible to
// extensions and the extension code isolated from the host DOM.
//
// Fetch style mirrors uiPrefsApi (plain fetch + Bearer auth) since these are
// isolated endpoints outside the OpenAPI generator.
// ─────────────────────────────────────────────────────────────────────────
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = localStorage.getItem("zatca_token");
  const acting = localStorage.getItem("zatca_acting_company_id");
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (t) h["Authorization"] = `Bearer ${t}`;
  if (acting) h["x-acting-company-id"] = acting;
  return h;
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    let msg = text;
    try { msg = JSON.parse(text)?.error ?? text; } catch { /* keep text */ }
    throw new Error(msg || `HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

// ── Types (mirror the backend response shapes) ───────────────────────────
export type ExtensionScreenKind = "screen" | "report" | "dashboard";

export interface ExtensionScreenDef {
  key: string;
  titleAr: string;
  titleEn?: string;
  icon?: string;
  kind?: ExtensionScreenKind;
}

export interface ExtensionTableDef {
  key: string;
  titleAr: string;
  titleEn?: string;
}

export interface InstalledExtension {
  extensionId: string;
  nameAr: string;
  nameEn?: string;
  version: string;
  vendor?: string;
  screens: ExtensionScreenDef[];
  tables?: ExtensionTableDef[];
  permissions?: string[];
}

export interface CatalogExtension extends InstalledExtension {
  permissions: string[];
  publicKeyId?: string;
  verified: boolean;
  hasHandler: boolean;
  enabled: boolean;
}

// Group an extension's screens by their host surface kind. Screens with no
// explicit kind default to "screen".
export function screensByKind(screens: ExtensionScreenDef[]): Record<ExtensionScreenKind, ExtensionScreenDef[]> {
  const out: Record<ExtensionScreenKind, ExtensionScreenDef[]> = { screen: [], report: [], dashboard: [] };
  for (const s of screens) out[s.kind ?? "screen"].push(s);
  return out;
}

// ── Query keys ───────────────────────────────────────────────────────────
export const extKeys = {
  installed: ["ext", "installed"] as const,
  catalog: ["ext", "catalog"] as const,
  data: (extensionId: string, collection: string) =>
    ["ext", "data", extensionId, collection] as const,
};

// ── Extension OWN-data records (ext_records collections) ──────────────────
// One row of an extension's custom "table". The host never knows the row's
// shape — `data` is whatever JSON the extension stored. The generic data grid
// derives its columns from the keys present across rows.
export interface ExtDataRecord {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

function extDataBase(extensionId: string, collection: string): string {
  return `${API}/api/ext/${encodeURIComponent(extensionId)}/data/${encodeURIComponent(collection)}`;
}

// List the rows of one declared collection (tenant-scoped, manifest-gated by
// the backend). `enabled` lets callers defer the fetch until a table is chosen.
export function useExtDataList(
  extensionId: string,
  collection: string,
  opts: { enabled?: boolean; limit?: number } = {},
) {
  const { enabled = true, limit } = opts;
  return useQuery({
    queryKey: extKeys.data(extensionId, collection),
    enabled: enabled && !!extensionId && !!collection,
    queryFn: async () => {
      const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
      return jsonOrThrow<ExtDataRecord[]>(
        await fetch(`${extDataBase(extensionId, collection)}${qs}`, { headers: authHeaders() }),
      );
    },
  });
}

export function useExtDataCreate(extensionId: string, collection: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) =>
      jsonOrThrow<ExtDataRecord>(
        await fetch(extDataBase(extensionId, collection), {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ data }),
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: extKeys.data(extensionId, collection) });
    },
  });
}

export function useExtDataUpdate(extensionId: string, collection: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      jsonOrThrow<ExtDataRecord>(
        await fetch(`${extDataBase(extensionId, collection)}/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({ data }),
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: extKeys.data(extensionId, collection) });
    },
  });
}

export function useExtDataRemove(extensionId: string, collection: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      jsonOrThrow<{ ok: true; id: string }>(
        await fetch(`${extDataBase(extensionId, collection)}/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: authHeaders(),
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: extKeys.data(extensionId, collection) });
    },
  });
}

// ── Tenant-scoped: extensions enabled for the current company ────────────
export function useInstalledExtensions(enabled = true) {
  return useQuery({
    queryKey: extKeys.installed,
    enabled,
    queryFn: async () =>
      jsonOrThrow<InstalledExtension[]>(
        await fetch(`${API}/api/ext/installed`, { headers: authHeaders() }),
      ),
  });
}

// ── Admin: full platform catalog + per-company enable flag ───────────────
export function useExtensionCatalog(enabled = true) {
  return useQuery({
    queryKey: extKeys.catalog,
    enabled,
    queryFn: async () =>
      jsonOrThrow<CatalogExtension[]>(
        await fetch(`${API}/api/ext/catalog`, { headers: authHeaders() }),
      ),
  });
}

// ── Enable / disable an extension for the current company ────────────────
export function useSetExtensionEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ extensionId, enabled }: { extensionId: string; enabled: boolean }) =>
      jsonOrThrow<{ ok: true; extensionId: string; enabled: boolean }>(
        await fetch(`${API}/api/ext/${encodeURIComponent(extensionId)}/${enabled ? "enable" : "disable"}`, {
          method: "POST",
          headers: authHeaders(),
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: extKeys.catalog });
      void qc.invalidateQueries({ queryKey: extKeys.installed });
    },
  });
}

// ── Sandboxed screen URL ─────────────────────────────────────────────────
// The iframe is sandboxed WITHOUT allow-same-origin, so it cannot read the
// host's localStorage or set an Authorization header. We pass the bearer token
// + acting company as query params (the backend shims them back into auth).
export function buildScreenUrl(extensionId: string, screenKey: string): string {
  const token = localStorage.getItem("zatca_token") ?? "";
  const acting = localStorage.getItem("zatca_acting_company_id") ?? "";
  const params = new URLSearchParams();
  params.set("screenKey", screenKey);
  if (token) params.set("token", token);
  if (acting) params.set("companyId", acting);
  return `${API}/api/ext/${encodeURIComponent(extensionId)}/screen?${params.toString()}`;
}
