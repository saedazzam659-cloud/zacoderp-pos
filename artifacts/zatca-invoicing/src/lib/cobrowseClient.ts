// Tiny shared helper for the cobrowse customer & agent widgets.
//
// Both sides talk over a single WebSocket relayed through the api-server.
// Messages are JSON. The hub validates control permissions on the server,
// so the client only needs to react to peer/state events and stream rrweb
// events.

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export type CobrowseRole = "agent" | "customer";

export interface CobrowseMsg {
  type: string;
  [k: string]: any;
}

/** Returns the websocket URL for /api/cobrowse/ws under the artifact base.
 *  Agent connections MUST include the user's bearer token via `auth=` so
 *  the server can verify ownership of the session and audit accordingly. */
export function buildCobrowseWsUrl(token: string, role: CobrowseRole): string {
  const base = window.location.origin
    .replace(/^http/, "ws") + `${API_BASE}/api/cobrowse/ws`;
  const u = new URL(base);
  u.searchParams.set("token", token);
  u.searchParams.set("role", role);
  if (role === "agent") {
    const auth = localStorage.getItem("zatca_token");
    if (auth) u.searchParams.set("auth", auth);
  }
  return u.toString();
}

/** Public lookup of a session by invite token (no auth required). */
export async function fetchCobrowseSessionByToken(token: string): Promise<{
  id: number; state: string; agentUsername: string | null; controlState: string;
  createdAt: string; endedAt: string | null;
} | null> {
  try {
    const r = await fetch(`${API_BASE}/api/cobrowse/sessions/by-token/${encodeURIComponent(token)}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Authenticated REST helper for the agent side. */
export async function apiCobrowse<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const tok = localStorage.getItem("zatca_token");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const r = await fetch(`${API_BASE}/api/cobrowse${path}`, { ...opts, headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`cobrowse ${path} → ${r.status}: ${txt}`);
  }
  return r.json();
}
