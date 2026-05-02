import { EventEmitter } from "node:events";

export type SessionEventType =
  | "subscription_changed"
  | "company_changed"
  | "permissions_changed";

export interface SessionEvent {
  type: SessionEventType;
  companyId: number | null;
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
