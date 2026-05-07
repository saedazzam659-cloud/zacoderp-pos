import { EventEmitter } from "node:events";

export type SessionEventType =
  | "subscription_changed"
  | "company_changed"
  | "permissions_changed"
  // Push from a support agent to a specific signed-in user asking permission
  // to view/control their screen. Carries the invite token + agent identity
  // in `meta`; targeted via `userId` so other users in the same company are
  // not notified.
  | "cobrowse_invite"
  | "cobrowse_invite_cancelled";

export interface SessionEvent {
  type: SessionEventType;
  companyId: number | null;
  /** When set, the SSE handler delivers the event ONLY to this user. */
  userId?: number | null;
  meta?: Record<string, unknown>;
}

class SessionEventBus extends EventEmitter {}

export const sessionEvents: SessionEventBus = new SessionEventBus();
sessionEvents.setMaxListeners(10_000);

export function emitSessionRefresh(
  companyId: number | null | undefined,
  type: SessionEventType = "subscription_changed",
  meta?: Record<string, unknown>,
): void {
  if (companyId == null) return;
  const payload: SessionEvent = { type, companyId, meta };
  sessionEvents.emit("event", payload);
}

/** Push an event to a SPECIFIC user (filtered server-side in realtime.ts). */
export function emitToUser(
  userId: number,
  companyId: number | null | undefined,
  type: SessionEventType,
  meta?: Record<string, unknown>,
): void {
  const payload: SessionEvent = { type, companyId: companyId ?? null, userId, meta };
  sessionEvents.emit("event", payload);
}

export function emitSessionRefreshMany(
  companyIds: Array<number | null | undefined>,
  type: SessionEventType = "subscription_changed",
  meta?: Record<string, unknown>,
): void {
  const seen = new Set<number>();
  for (const cid of companyIds) {
    if (cid == null || seen.has(cid)) continue;
    seen.add(cid);
    emitSessionRefresh(cid, type, meta);
  }
}
