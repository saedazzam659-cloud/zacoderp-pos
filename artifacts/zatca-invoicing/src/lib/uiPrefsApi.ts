// Tiny REST client for durable per-user UI preferences.
// Mirrors the lightweight `accountNotesApi` style — plain fetch + Bearer auth
// so we don't need the OpenAPI generator for this isolated endpoint.
//
// Reading prefs does NOT go through here: they ride along on GET /api/auth/me
// (AuthUser.uiPreferences) so a freshly-loaded session restores its saved
// layout in one round-trip. This module only handles the WRITE side.
const API = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = localStorage.getItem("zatca_token");
  const acting = localStorage.getItem("zatca_acting_company_id");
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (t) h["Authorization"] = `Bearer ${t}`;
  if (acting) h["x-acting-company-id"] = acting;
  return h;
}

/**
 * Persist one screen's UI layout blob to the server (durable, survives a
 * browser cache wipe). Best-effort: callers should keep localStorage as the
 * fast local cache and treat a rejected promise as non-fatal.
 *
 * @param screen  Stable per-screen slug, e.g. "salesAuditGrid".
 * @param layout  Plain JSON object — the client owns the shape per screen.
 */
export async function saveUiPrefs(screen: string, layout: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${API}/api/auth/me/ui-prefs`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ screen, layout }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    let msg = text;
    try { msg = JSON.parse(text)?.error ?? text; } catch { /* keep text */ }
    throw new Error(msg || `HTTP ${r.status}`);
  }
}
