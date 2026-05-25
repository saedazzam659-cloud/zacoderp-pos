// Lightweight push queue for create/update/delete operations on customers,
// items, returns, etc. Stored in localStorage so it survives reloads but is
// scoped per-device.
//
// Each entry mirrors PushItem from api.ts. The actual flush is the existing
// sync.ts pushPendingInvoices() — extended in a follow-up to drain this queue
// too. For now we just persist the intent so no work is lost.

import { LS_KEYS, lsRead, lsWrite } from "./localStore";

export interface QueuedOp {
  clientId: string;
  entityType: string;
  operation: "create" | "update" | "delete";
  payload: Record<string, unknown>;
  occurredAt: string;
}

export function enqueuePush(op: Omit<QueuedOp, "occurredAt">): void {
  const q = lsRead<QueuedOp[]>(LS_KEYS.pushQueue, []);
  q.push({ ...op, occurredAt: new Date().toISOString() });
  lsWrite(LS_KEYS.pushQueue, q);
}

export function listPushQueue(): QueuedOp[] {
  return lsRead<QueuedOp[]>(LS_KEYS.pushQueue, []);
}

export function clearPushQueue(clientIds: string[]): void {
  const set = new Set(clientIds);
  const q = lsRead<QueuedOp[]>(LS_KEYS.pushQueue, []);
  lsWrite(LS_KEYS.pushQueue, q.filter((op) => !set.has(op.clientId)));
}

export function countPushQueue(): number {
  return lsRead<QueuedOp[]>(LS_KEYS.pushQueue, []).length;
}
