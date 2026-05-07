import { Router } from "express";
import { db, cobrowseSessionsTable, auditLogTable, usersTable } from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { extractAuth } from "../middleware/auth.js";
import { newInviteToken } from "../lib/cobrowseHub.js";
import { emitToUser } from "../lib/sessionEvents.js";

// ─────────────────────────────────────────────────────────────────────────
// Cobrowse REST endpoints (companion to the WS hub).
//
// POST   /api/cobrowse/sessions          → agent creates a session
// GET    /api/cobrowse/sessions/:id      → poll session state (both sides)
// GET    /api/cobrowse/sessions/by-token/:token → customer landing-page lookup
// POST   /api/cobrowse/sessions/:id/end  → end (either side, or admin)
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

// Helper: common audit log writer.
async function audit(opts: {
  userId: number | null; username: string | null; companyId: number | null;
  action: string; sessionId: number; meta?: Record<string, unknown>;
  req: { ip?: string; method?: string; originalUrl?: string; headers: Record<string, any>; };
  statusCode: number;
}) {
  try {
    await db.insert(auditLogTable).values({
      userId: opts.userId, username: opts.username, role: null,
      companyId: opts.companyId,
      module: "support_cobrowse",
      action: opts.action,
      method: opts.req.method ?? null,
      path:   opts.req.originalUrl ?? null,
      entityType: "cobrowse_session",
      entityId:   String(opts.sessionId),
      statusCode: opts.statusCode,
      ip:         opts.req.ip ?? null,
      userAgent:  String(opts.req.headers["user-agent"] ?? "").slice(0, 500),
      metadata:   opts.meta ?? null,
    });
  } catch { /* never break business logic on audit failure */ }
}

// Public lookup by invite token — used by the customer-side widget on
// landing. We deliberately expose minimal info (no agent ip, no audit
// metadata) and ONLY for non-ended sessions.
router.get("/sessions/by-token/:token", async (req, res) => {
  const token = String(req.params.token ?? "");
  if (token.length < 8 || token.length > 200) {
    res.status(400).json({ error: "invalid token" }); return;
  }
  const [s] = await db.select({
    id: cobrowseSessionsTable.id,
    state: cobrowseSessionsTable.state,
    agentUsername: cobrowseSessionsTable.agentUsername,
    controlState: cobrowseSessionsTable.controlState,
    createdAt: cobrowseSessionsTable.createdAt,
    endedAt: cobrowseSessionsTable.endedAt,
  }).from(cobrowseSessionsTable)
    .where(eq(cobrowseSessionsTable.inviteToken, token)).limit(1);
  if (!s) { res.status(404).json({ error: "not found" }); return; }
  if (s.state === "ended") { res.status(410).json({ error: "ended" }); return; }
  res.json(s);
});

// Authenticated below.
router.use(extractAuth);

// Lite list of users in the agent's company — used by the agent UI to pick
// who to push the invite to. Returns only id / username / display name and
// is restricted to the same tenant as the caller. Available to ANY signed-
// in user (the broader /api/users endpoint requires admin); we expose this
// minimal projection so a support agent without admin role can still pick
// a target.
router.get("/eligible-users", async (req, res) => {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (u.companyId == null) { res.json([]); return; }
  const rows = await db.select({
    id: usersTable.id,
    username: usersTable.username,
    nameAr: usersTable.nameAr,
    nameEn: usersTable.nameEn,
    role: usersTable.role,
    isActive: usersTable.isActive,
  }).from(usersTable)
    .where(and(eq(usersTable.companyId, u.companyId), eq(usersTable.isActive, true)));
  // Exclude the agent themselves from the picker.
  res.json(rows.filter(r => r.id !== u.id));
});

// Create a new session (agent).
router.post("/sessions", async (req, res) => {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }

  const customerLabel = typeof req.body?.customerLabel === "string"
    ? req.body.customerLabel.slice(0, 200) : null;
  // Optional: when provided, we push the invite live to that specific
  // signed-in user via SSE so the consent dialog appears on their screen
  // without them having to click a link. Validated to be in the same tenant.
  const targetUserIdRaw = req.body?.targetUserId;
  const targetUserId = Number.isFinite(Number(targetUserIdRaw)) ? Number(targetUserIdRaw) : null;
  let targetUser: { id: number; companyId: number | null; username: string } | null = null;
  if (targetUserId != null) {
    const [tu] = await db.select({
      id: usersTable.id, companyId: usersTable.companyId, username: usersTable.username,
    }).from(usersTable).where(eq(usersTable.id, targetUserId)).limit(1);
    if (!tu) { res.status(404).json({ error: "المستخدم المستهدف غير موجود" }); return; }
    if (u.role !== "superadmin" && tu.companyId !== u.companyId) {
      res.status(403).json({ error: "لا يمكن دعوة مستخدم من شركة أخرى" }); return;
    }
    targetUser = tu;
  }

  const inviteToken = newInviteToken();
  const [row] = await db.insert(cobrowseSessionsTable).values({
    inviteToken,
    agentUserId: u.id,
    agentUsername: u.username,
    customerUserId: targetUser?.id ?? null,
    customerCompanyId: targetUser?.companyId ?? null,
    customerLabel: customerLabel ?? targetUser?.username ?? null,
    state: "pending",
    controlState: "none",
  }).returning();

  // Push the invite directly to the target user's SSE stream so the
  // consent dialog appears on their screen without copy-pasting a link.
  if (targetUser) {
    emitToUser(targetUser.id, targetUser.companyId, "cobrowse_invite", {
      sessionId: row!.id,
      inviteToken,
      agentUsername: u.username,
      customerLabel: row!.customerLabel,
    });
  }

  await audit({
    userId: u.id, username: u.username, companyId: u.companyId ?? null,
    action: "create", sessionId: row!.id, statusCode: 201,
    meta: { customerLabel, targetUserId: targetUser?.id ?? null, pushed: !!targetUser },
    req: { ip: req.ip, method: req.method, originalUrl: req.originalUrl, headers: req.headers },
  });

  res.status(201).json(row);
});

// Poll status. Both agent (by id) and the agent-side polling are allowed.
router.get("/sessions/:id", async (req, res) => {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }

  const [s] = await db.select().from(cobrowseSessionsTable)
    .where(eq(cobrowseSessionsTable.id, id)).limit(1);
  if (!s) { res.status(404).json({ error: "not found" }); return; }

  // Only the agent who owns it (or any superadmin) may poll authenticated.
  if (u.role !== "superadmin" && s.agentUserId !== u.id) {
    res.status(403).json({ error: "ممنوع" }); return;
  }
  res.json(s);
});

// List my recent sessions (for the agent's history panel).
router.get("/sessions", async (req, res) => {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
  const rows = await db.select().from(cobrowseSessionsTable)
    .where(eq(cobrowseSessionsTable.agentUserId, u.id))
    .orderBy(desc(cobrowseSessionsTable.createdAt))
    .limit(25);
  res.json(rows);
});

// End the session (either party + superadmin).
router.post("/sessions/:id/end", async (req, res) => {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const [s] = await db.select().from(cobrowseSessionsTable)
    .where(eq(cobrowseSessionsTable.id, id)).limit(1);
  if (!s) { res.status(404).json({ error: "not found" }); return; }
  if (u.role !== "superadmin" && s.agentUserId !== u.id) {
    res.status(403).json({ error: "ممنوع" }); return;
  }
  if (s.state === "ended") { res.json(s); return; }
  const [updated] = await db.update(cobrowseSessionsTable).set({
    state: "ended", endedAt: new Date(),
    endReason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : "agent_ended",
    controlState: "none",
    controlEndedAt: s.controlGrantedAt && !s.controlEndedAt ? new Date() : s.controlEndedAt,
  }).where(eq(cobrowseSessionsTable.id, id)).returning();
  // If the invite was pushed but never accepted, dismiss the dialog on the
  // target user's screen so they don't see a stale prompt.
  if (s.customerUserId && s.state === "pending") {
    emitToUser(s.customerUserId, s.customerCompanyId, "cobrowse_invite_cancelled", {
      sessionId: id,
    });
  }
  await audit({
    userId: u.id, username: u.username, companyId: u.companyId ?? null,
    action: "end", sessionId: id, statusCode: 200,
    req: { ip: req.ip, method: req.method, originalUrl: req.originalUrl, headers: req.headers },
  });
  res.json(updated);
});

// (Optional) auto-cleanup: end pending sessions older than 60 minutes.
// Fire-and-forget, called from index.ts schedulers if needed later.
export async function cleanupStaleCobrowseSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const stale = await db.select({ id: cobrowseSessionsTable.id })
    .from(cobrowseSessionsTable)
    .where(and(
      eq(cobrowseSessionsTable.state, "pending"),
      isNull(cobrowseSessionsTable.endedAt),
    ));
  if (!stale.length) return 0;
  let n = 0;
  for (const row of stale) {
    const [s] = await db.select().from(cobrowseSessionsTable)
      .where(eq(cobrowseSessionsTable.id, row.id)).limit(1);
    if (!s) continue;
    if (s.createdAt && s.createdAt < cutoff) {
      await db.update(cobrowseSessionsTable)
        .set({ state: "ended", endedAt: new Date(), endReason: "stale_timeout" })
        .where(eq(cobrowseSessionsTable.id, row.id));
      n++;
    }
  }
  return n;
}

export default router;
