// Tiny REST helpers for قاعة التدريب المباشر + غرفة الدعم الفني (LiveKit).
const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface JoinInfo { token: string; wsUrl: string; identity: string; roomName?: string; sessionId?: number; title?: string }

async function req<T = any>(path: string, opts: RequestInit = {}, auth = true): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (auth) {
    const tok = localStorage.getItem("zatca_token");
    if (tok) headers.Authorization = `Bearer ${tok}`;
  }
  const r = await fetch(`${API_BASE}/api${path}`, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error ?? `فشل الطلب (${r.status})`);
  return body as T;
}

export const trainingApi = {
  list: () => req<any[]>("/training-room/sessions"),
  create: (p: { title: string; description?: string; allowRegistered: boolean; allowPublic: boolean; scheduledAt?: string | null }) =>
    req("/training-room/sessions", { method: "POST", body: JSON.stringify(p) }),
  patch: (id: number, p: Record<string, unknown>) =>
    req(`/training-room/sessions/${id}`, { method: "PATCH", body: JSON.stringify(p) }),
  start: (id: number) => req<JoinInfo>(`/training-room/sessions/${id}/start`, { method: "POST" }),
  join: (id: number) => req<JoinInfo>(`/training-room/sessions/${id}/join`, { method: "POST" }),
  mic: (id: number, identity: string, allow: boolean) =>
    req(`/training-room/sessions/${id}/mic`, { method: "POST", body: JSON.stringify({ identity, allow }) }),
  end: (id: number) => req(`/training-room/sessions/${id}/end`, { method: "POST" }),
  attendance: (id: number) => req<any[]>(`/training-room/sessions/${id}/attendance`),
  publicInfo: (token: string) => req<any>(`/training-room/public/${encodeURIComponent(token)}`, {}, false),
  publicJoin: (token: string, name: string) =>
    req<JoinInfo>(`/training-room/public/${encodeURIComponent(token)}/join`, { method: "POST", body: JSON.stringify({ name }) }, false),
};

export const supportRoomApi = {
  createCall: (targetUserId?: number | null) =>
    req<{ call: any } & JoinInfo>("/support-room/calls", { method: "POST", body: JSON.stringify({ targetUserId: targetUserId ?? null }) }),
  joinCall: (id: number) => req<JoinInfo>(`/support-room/calls/${id}/join`, { method: "POST" }),
  endCall: (id: number) => req(`/support-room/calls/${id}/end`, { method: "POST" }),
  listCalls: (status?: string) => req<any[]>(`/support-room/calls${status ? `?status=${status}` : ""}`),
};
