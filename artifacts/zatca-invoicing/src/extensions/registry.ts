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
export interface ExtensionScreenDef {
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
}

export interface CatalogExtension extends InstalledExtension {
  permissions: string[];
  publicKeyId?: string;
  verified: boolean;
  hasHandler: boolean;
  enabled: boolean;
}

// ── Query keys ───────────────────────────────────────────────────────────
export const extKeys = {
  installed: ["ext", "installed"] as const,
  catalog: ["ext", "catalog"] as const,
};

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
