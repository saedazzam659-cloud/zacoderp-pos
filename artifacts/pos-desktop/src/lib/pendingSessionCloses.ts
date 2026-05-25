// Offline-retry queue for /api/pos-sessions/:id/close calls. When a cashier
// logs out without network, the cloud-side close fails and the session
// would otherwise sit "open" forever — blocking the same user from opening
// a session on any terminal next time (the server-side janitor handles the
// fully-abandoned case, but a deferred-close from the device produces a
// cleaner status='closed' + accurate closedAt, vs the janitor's
// force_closed at the last heartbeat).
//
// Storage: localStorage (so it survives reloads). Scoped per browser/device
// — no cross-device leakage. Drained from PosShell's heartbeat tick via
// flushPendingSessionCloses().

import { lsRead, lsWrite } from "./localStore";
import type { ApiClient } from "./api";

const KEY = "pos_desktop_pending_session_closes_v1";

export interface PendingClose {
  posSessionId: number;
  closingCash?: number;
  notes?: string;
  // Wall-clock time on the device when the cashier hit logout. Sent to the
  // server so reports reflect when the cashier actually stopped, not when
  // the device finally got back online.
  closedAt: string;
  attempts: number;
}

export function enqueuePendingClose(p: Omit<PendingClose, "attempts" | "closedAt"> & { closedAt?: string }): void {
  const q = lsRead<PendingClose[]>(KEY, []);
  // Dedup: if the same session is already queued, keep the existing entry
  // (its closedAt is closer to the original logout time).
  if (q.some((e) => e.posSessionId === p.posSessionId)) return;
  q.push({
    posSessionId: p.posSessionId,
    closingCash: p.closingCash,
    notes: p.notes,
    closedAt: p.closedAt ?? new Date().toISOString(),
    attempts: 0,
  });
  lsWrite(KEY, q);
}

export function listPendingCloses(): PendingClose[] {
  return lsRead<PendingClose[]>(KEY, []);
}

export function countPendingCloses(): number {
  return listPendingCloses().length;
}

function removePendingClose(posSessionId: number): void {
  const q = lsRead<PendingClose[]>(KEY, []);
  lsWrite(KEY, q.filter((e) => e.posSessionId !== posSessionId));
}

function bumpAttempts(posSessionId: number): void {
  const q = lsRead<PendingClose[]>(KEY, []);
  lsWrite(KEY, q.map((e) => e.posSessionId === posSessionId ? { ...e, attempts: e.attempts + 1 } : e));
}

// Drain the queue. Best-effort: any item that still fails (network down,
// server 5xx) is left in the queue with attempts++ and will be retried on
// the next call. Items that 404 (session no longer exists — DB rewound,
// company deleted) are dropped so the queue can't get permanently stuck.
// Returns the count actually closed for surfacing in the UI.
export async function flushPendingSessionCloses(api: ApiClient): Promise<{ flushed: number; remaining: number }> {
  const q = listPendingCloses();
  if (q.length === 0) return { flushed: 0, remaining: 0 };
  let flushed = 0;
  for (const p of q) {
    try {
      await api.deferredClosePosSession({
        posSessionId: p.posSessionId,
        closingCash: p.closingCash,
        notes: p.notes,
        closedAt: p.closedAt,
      });
      removePendingClose(p.posSessionId);
      flushed += 1;
    } catch (e: any) {
      if (e?.status === 404) {
        // Session vanished on the server — drop to unblock the queue.
        removePendingClose(p.posSessionId);
      } else {
        bumpAttempts(p.posSessionId);
        // Continue to the next item; one bad entry should not block others.
      }
    }
  }
  return { flushed, remaining: countPendingCloses() };
}
