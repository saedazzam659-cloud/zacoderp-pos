// Public (no-auth) endpoints used by the report-recipient invitation
// acceptance flow. The token itself is the proof of authorisation, so the
// invitee can accept from any inbox without logging in. The companion admin
// endpoints that *create* / *revoke* invitations live in `routes/admin.ts`.
import { Router, type Request, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  reportEmailInvitationsTable,
  reportEmailSchedulesTable,
} from "@workspace/db";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { ensureScheduleRow, REPORT_SCHEDULE_ID } from "../lib/reportScheduler.js";
import { writeAudit } from "../middleware/permissions.js";

const router: IRouter = Router();

// Tiny in-memory rate limiter for the unauthenticated invitation endpoints.
// Caps each IP at INVITE_RL_MAX requests per INVITE_RL_WINDOW_MS, enough to
// blunt brute-force enumeration even though tokens are 256-bit and hard to
// guess. Acceptable for a single-process api-server; if we ever scale out,
// move this into Redis or the request middleware layer.
const INVITE_RL_WINDOW_MS = 60_000;
const INVITE_RL_MAX = 30;
const inviteRl = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string | null): boolean {
  if (!ip) return false;
  const now = Date.now();
  const entry = inviteRl.get(ip);
  if (!entry || entry.resetAt <= now) {
    inviteRl.set(ip, { count: 1, resetAt: now + INVITE_RL_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > INVITE_RL_MAX;
}

function clientIp(req: Request): string | null {
  const xff = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  return xff || req.ip || (req.socket?.remoteAddress ?? null);
}

function publicShape(row: typeof reportEmailInvitationsTable.$inferSelect, alreadyOnList: boolean) {
  let status: "pending" | "accepted" | "expired" | "revoked" | "already_member";
  if (row.acceptedAt) status = "accepted";
  else if (row.revokedAt) status = "revoked";
  else if (row.expiresAt.getTime() < Date.now()) status = "expired";
  else if (alreadyOnList) status = "already_member";
  else status = "pending";
  return {
    email: row.email,
    invitedByUsername: row.invitedByUsername,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    status,
  };
}

// GET /api/reports-invitations/:token — preview before accepting.
router.get("/:token", async (req, res) => {
  try {
    if (rateLimited(clientIp(req))) {
      res.status(429).json({ error: "محاولات كثيرة، حاول لاحقاً" });
      return;
    }
    const token = String(req.params.token ?? "");
    if (!token) { res.status(400).json({ error: "رمز غير صالح" }); return; }
    const [row] = await db.select().from(reportEmailInvitationsTable)
      .where(eq(reportEmailInvitationsTable.token, token)).limit(1);
    if (!row) { res.status(404).json({ error: "الدعوة غير موجودة أو منتهية" }); return; }
    const cfg = await ensureScheduleRow();
    const recipients = Array.isArray(cfg.recipients) ? cfg.recipients : [];
    const alreadyOnList = recipients.includes(row.email);
    res.json({ invitation: publicShape(row, alreadyOnList) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر جلب الدعوة";
    res.status(500).json({ error: msg });
  }
});

// POST /api/reports-invitations/:token/accept — confirms the invite, adds the
// email to the recipient list, and marks the row accepted.
//
// Concurrency / atomicity model:
//  • Everything happens inside a single DB transaction so that the claim
//    (flipping `accepted_at`) and the recipient append commit or roll back
//    together. We can NOT have a state where the token is marked accepted
//    but the email never made it onto the schedule recipients list — a
//    failure in the append would otherwise leave such an orphan that the
//    idempotent retry path below cannot heal blindly.
//  • The "claim" itself is a conditional UPDATE that flips `accepted_at`
//    only if the row is still pending, unrevoked and unexpired, with
//    `RETURNING`. Either we get the freshly-claimed row (we win) or zero
//    rows (someone else won, or the token is invalid).
//  • The schedule row is then locked `FOR UPDATE` inside the same tx so
//    two concurrent accepts of *different* invitations can't clobber each
//    other's recipient writes.
//  • Idempotency: if the claim returns zero rows AND the invitation is
//    already accepted (not revoked / not expired), we still re-attempt
//    the recipient append under the same lock. That self-heals any
//    prior request that crashed between claim and append.
router.post("/:token/accept", async (req, res) => {
  try {
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      res.status(429).json({ error: "محاولات كثيرة، حاول لاحقاً" });
      return;
    }
    const token = String(req.params.token ?? "");
    if (!token) { res.status(400).json({ error: "رمز غير صالح" }); return; }

    type AcceptResult =
      | { kind: "claimed";          row: typeof reportEmailInvitationsTable.$inferSelect; alreadyOnList: boolean }
      | { kind: "already_accepted"; row: typeof reportEmailInvitationsTable.$inferSelect; alreadyOnList: boolean }
      | { kind: "not_found" }
      | { kind: "revoked" }
      | { kind: "expired" };

    const result: AcceptResult = await db.transaction(async (tx) => {
      // 1. Atomic claim. Only succeeds for a still-pending invitation.
      const [claimed] = await tx.update(reportEmailInvitationsTable).set({
        acceptedAt: new Date(),
        acceptedFromIp: ip,
      }).where(and(
        eq(reportEmailInvitationsTable.token, token),
        isNull(reportEmailInvitationsTable.acceptedAt),
        isNull(reportEmailInvitationsTable.revokedAt),
        gte(reportEmailInvitationsTable.expiresAt, new Date()),
      )).returning();

      // Pick the row we'll work with (either freshly claimed, or pre-existing
      // for the idempotent / error branches).
      let row = claimed;
      let kind: "claimed" | "already_accepted" | "not_found" | "revoked" | "expired";
      if (claimed) {
        kind = "claimed";
      } else {
        const [existing] = await tx.select().from(reportEmailInvitationsTable)
          .where(eq(reportEmailInvitationsTable.token, token)).limit(1);
        if (!existing) return { kind: "not_found" };
        if (existing.revokedAt) return { kind: "revoked" };
        if (!existing.acceptedAt && existing.expiresAt.getTime() < Date.now()) {
          return { kind: "expired" };
        }
        row = existing;
        kind = "already_accepted";
      }

      // 2. Append email to the schedule recipients (lock the schedule row).
      const locked = await tx.execute(sql`
        SELECT recipients FROM ${reportEmailSchedulesTable}
         WHERE id = ${REPORT_SCHEDULE_ID}
         FOR UPDATE
      `);
      const current = Array.isArray((locked as unknown as { rows?: { recipients?: unknown }[] }).rows?.[0]?.recipients)
        ? (locked as unknown as { rows: { recipients: string[] }[] }).rows[0].recipients
        : [];
      const alreadyOnList = current.includes(row.email);
      if (!alreadyOnList) {
        await tx.update(reportEmailSchedulesTable).set({
          recipients: [...current, row.email], updatedAt: new Date(),
        }).where(eq(reportEmailSchedulesTable.id, REPORT_SCHEDULE_ID));
      }

      return kind === "claimed"
        ? { kind: "claimed",          row, alreadyOnList: true }
        : { kind: "already_accepted", row, alreadyOnList: true };
    });

    if (result.kind === "not_found") { res.status(404).json({ error: "الدعوة غير موجودة" }); return; }
    if (result.kind === "revoked")   { res.status(410).json({ error: "تم إلغاء هذه الدعوة" }); return; }
    if (result.kind === "expired")   { res.status(410).json({ error: "انتهت صلاحية الدعوة" }); return; }

    // Audit only on a fresh claim — re-tries shouldn't pile up duplicate audit rows.
    if (result.kind === "claimed") {
      await writeAudit({
        userId:    null,
        username:  null,
        role:      "anonymous",
        companyId: null,
        module: "reports", action: "create",
        entityType: "report_email_invitation_accepted",
        entityId:   String(result.row.id),
        metadata: { email: result.row.email, ip },
      });
    }

    res.json({ ok: true, invitation: publicShape(result.row, true) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر قبول الدعوة";
    res.status(500).json({ error: msg });
  }
});

export default router;
