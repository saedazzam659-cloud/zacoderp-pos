// Server-side fallback for POS sessions whose cashier desktop never made it
// back online to close cleanly. The desktop fires /api/pos-sessions/:id/close
// at logout, but if the network is down (or the app was killed via Task
// Manager / a hard power-off) the call never lands and the session sits
// "open" forever. The next time the same cashier tries to open a session
// the open-session guard refuses them.
//
// This janitor runs every TICK_MS and force-closes any session whose last
// heartbeat (or, for legacy rows with no heartbeat, openedAt) is older than
// STALE_AFTER_MS. The closedAt is set to the *last heartbeat* — NOT now —
// so shift reports reflect when the cashier actually stopped working, not
// when the cleanup happened to run. Status is set to `force_closed` and
// closeReason to `auto_closed_stale_heartbeat` so admins can tell auto-
// closures apart from explicit ones in the SuperAdmin UI.
//
// Cash reconciliation: we compute expectedCash from posted cash invoices
// against the session (same formula as the manual /close path) and use that
// as both expected and closing cash. The cashier can never physically count
// the till on an abandoned session, so any difference would be guesswork —
// recording diff=0 with the auto-close reason is the truthful representation.

import { db } from "@workspace/db";
import { posSessionsTable, salesInvoicesTable } from "@workspace/db";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { logger } from "./logger.js";

const TICK_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 60_000;
// 30 min default; can be tuned per deployment via env var without a code
// change. Kept conservative — a cashier who steps away for a smoke break
// must not have their session reaped under them. The desktop heartbeat
// fires every 30s so even a flaky network has plenty of grace.
const STALE_AFTER_MS = Math.max(
  60_000,
  Number(process.env.POS_SESSION_STALE_AFTER_MS) || 30 * 60_000,
);

export async function runPosSessionAutoCloseOnce(): Promise<{
  scanned: number;
  closed: number;
}> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  // Candidates: open sessions whose effective last-seen (lastHeartbeatAt
  // ?? openedAt) is older than cutoff. Done in one query so we don't pull
  // every open session into memory.
  const candidates = await db.select({
    id: posSessionsTable.id,
    companyId: posSessionsTable.companyId,
    openingCash: posSessionsTable.openingCash,
    openedAt: posSessionsTable.openedAt,
    lastHeartbeatAt: posSessionsTable.lastHeartbeatAt,
  }).from(posSessionsTable)
    .where(and(
      eq(posSessionsTable.status, "open"),
      or(
        and(isNull(posSessionsTable.lastHeartbeatAt), lt(posSessionsTable.openedAt, cutoff)),
        lt(posSessionsTable.lastHeartbeatAt, cutoff),
      ),
    ))
    .limit(500);

  let closed = 0;
  for (const s of candidates) {
    try {
      const [{ totalCash } = { totalCash: "0" }] = await db.select({
        totalCash: sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}), 0)`,
      }).from(salesInvoicesTable).where(and(
        eq(salesInvoicesTable.posSessionId, s.id),
        eq(salesInvoicesTable.companyId, s.companyId),
        eq(salesInvoicesTable.status, "posted"),
        eq(salesInvoicesTable.paymentType, "cash"),
      ));
      const expected = Number(s.openingCash || 0) + Number(totalCash || 0);
      // closedAt reflects when the cashier actually stopped working — the
      // last heartbeat we saw, or openedAt for legacy sessions that never
      // heartbeated at all.
      const closedAt = s.lastHeartbeatAt ?? s.openedAt;
      // Conditional UPDATE: status=open guard prevents us from clobbering
      // a row that the desktop happened to close in the same tick window.
      const result = await db.update(posSessionsTable).set({
        status: "force_closed",
        closingCash: String(expected.toFixed(2)),
        expectedCash: String(expected.toFixed(2)),
        difference: "0.00",
        closedAt,
        closeReason: "auto_closed_stale_heartbeat",
        closedNotes: "تم الإغلاق التلقائي: لم تستلم نبضات حياة من الجهاز لفترة طويلة",
      }).where(and(
        eq(posSessionsTable.id, s.id),
        eq(posSessionsTable.status, "open"),
      )).returning({ id: posSessionsTable.id });
      if (result.length > 0) {
        closed += 1;
        logger.info({
          sessionId: s.id,
          companyId: s.companyId,
          closedAt,
          expectedCash: expected,
        }, "pos-session-janitor: auto-closed stale session");
      }
    } catch (err) {
      logger.error({ err, sessionId: s.id }, "pos-session-janitor: failed to close session");
    }
  }
  return { scanned: candidates.length, closed };
}

let started = false;
export function startPosSessionAutoCloseScheduler() {
  if (started) return;
  started = true;
  setTimeout(() => {
    void tick();
    setInterval(() => { void tick(); }, TICK_MS);
  }, STARTUP_DELAY_MS);
  async function tick() {
    try {
      const summary = await runPosSessionAutoCloseOnce();
      if (summary.closed > 0) {
        logger.info({ summary }, "pos-session-janitor: tick");
      }
    } catch (err) {
      logger.error({ err }, "pos-session-janitor: tick failed");
    }
  }
}
