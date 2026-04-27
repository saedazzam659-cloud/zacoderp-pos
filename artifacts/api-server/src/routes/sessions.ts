// Sessions router (manual, admin-managed entity).
//
// This is intentionally separate from `/api/work-sessions` which represents
// the per-login auto-created activity windows that feed AI reports. The two
// systems COEXIST per product decision — work_sessions remains untouched.
//
// Endpoints:
//   GET    /                       — admin: paginated list of company sessions
//   POST   /                       — admin: create a session
//   PATCH  /:id                    — admin: rename / change status / notes
//   DELETE /:id                    — admin: soft-archive (status=archived)
//   GET    /:id/users              — admin: users assigned to this session
//   POST   /:id/users              — admin: assign one or many users (bulk)
//   DELETE /:id/users/:userId      — admin: unassign one user
//   GET    /me                     — any auth: my assigned (active) sessions
//   POST   /me/select              — any auth: persist current selection
//   POST   /me/quick-create        — perm `sessions_self_create`: create + auto-assign self
//
// Permission keys used:
//   "sessions"             — manage company sessions (CRUD + assign).
//                            Bypassed by admin/superadmin role.
//   "sessions_self_create" — allowed to create a session for self when no
//                            sessions are pre-assigned at login.

import { Router } from "express";
import { db } from "@workspace/db";
import {
  sessionsTable,
  sessionUsersTable,
  usersTable,
} from "@workspace/db";
import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission, writeAudit } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function getCid(req: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query?.companyId);
  return cid ?? null;
}
function isAdmin(req: any): boolean {
  const r = req.authUser?.role;
  return r === "admin" || r === "superadmin";
}
function clientIp(req: any): string | null {
  return (req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.ip || null) as any;
}

// ─── Admin: list sessions ────────────────────────────────────────────────
router.get("/", requirePermission("sessions", "view"), async (req, res) => {
  const cid = getCid(req);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  const status = (req.query.status as string) || null;
  const limit = Math.min(parseInt((req.query.limit as string) || "100", 10) || 100, 500);
  const offset = parseInt((req.query.offset as string) || "0", 10) || 0;

  const where = status
    ? and(eq(sessionsTable.companyId, cid), eq(sessionsTable.status, status))
    : eq(sessionsTable.companyId, cid);

  const rows = await db.select().from(sessionsTable).where(where)
    .orderBy(desc(sessionsTable.createdAt)).limit(limit).offset(offset);

  // Attach user counts in one round-trip
  const ids = rows.map(r => r.id);
  let counts: Record<number, number> = {};
  if (ids.length) {
    const c = await db.select({
      sessionId: sessionUsersTable.sessionId,
      n: sql<number>`count(*)::int`,
    }).from(sessionUsersTable)
      .where(inArray(sessionUsersTable.sessionId, ids))
      .groupBy(sessionUsersTable.sessionId);
    for (const r of c) counts[r.sessionId] = Number(r.n);
  }
  res.json({ sessions: rows.map(r => ({ ...r, userCount: counts[r.id] ?? 0 })) });
});

// ─── Admin: create session ───────────────────────────────────────────────
router.post("/", requirePermission("sessions", "create"), async (req, res) => {
  const cid = getCid(req);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  const u = (req as any).authUser;
  const name = (req.body?.name || "").toString().trim();
  if (!name) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
  const notes = req.body?.notes ? String(req.body.notes) : null;

  const [row] = await db.insert(sessionsTable).values({
    companyId: cid,
    name,
    notes,
    status: "active",
    createdByUserId: u.id,
  }).returning();

  void writeAudit({
    userId: u.id, username: u.username, role: u.role, companyId: cid,
    module: "sessions", action: "create",
    method: req.method, path: req.originalUrl, statusCode: 200,
    entityType: "sessions", entityId: String(row.id),
    ip: clientIp(req), userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
    metadata: { name },
  });
  res.json({ session: row });
});

// ─── Admin: update session (rename / archive / notes) ────────────────────
router.patch("/:id", requirePermission("sessions", "edit"), async (req, res) => {
  const cid = getCid(req);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  const id = parseInt(req.params.id, 10);
  if (!id) { res.status(400).json({ error: "id غير صالح" }); return; }

  const patch: any = { updatedAt: new Date() };
  if (typeof req.body?.name === "string" && req.body.name.trim()) patch.name = req.body.name.trim();
  if (typeof req.body?.notes === "string") patch.notes = req.body.notes;
  if (req.body?.status === "active" || req.body?.status === "archived") {
    patch.status = req.body.status;
    patch.archivedAt = req.body.status === "archived" ? new Date() : null;
  }

  const [row] = await db.update(sessionsTable).set(patch)
    .where(and(eq(sessionsTable.id, id), eq(sessionsTable.companyId, cid)))
    .returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }

  // If archived, clear current_session_id on every user pointing to it so the
  // picker selection self-heals.
  if (patch.status === "archived") {
    await db.update(usersTable).set({ currentSessionId: null })
      .where(eq(usersTable.currentSessionId, id));
  }

  const u = (req as any).authUser;
  void writeAudit({
    userId: u.id, username: u.username, role: u.role, companyId: cid,
    module: "sessions", action: "edit",
    method: req.method, path: req.originalUrl, statusCode: 200,
    entityType: "sessions", entityId: String(id),
    ip: clientIp(req), userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
    metadata: { patch },
  });
  res.json({ session: row });
});

// ─── Admin: archive (soft-delete) ────────────────────────────────────────
router.delete("/:id", requirePermission("sessions", "delete"), async (req, res) => {
  const cid = getCid(req);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  const id = parseInt(req.params.id, 10);
  if (!id) { res.status(400).json({ error: "id غير صالح" }); return; }

  const [row] = await db.update(sessionsTable).set({
    status: "archived", archivedAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(sessionsTable.id, id), eq(sessionsTable.companyId, cid))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }

  await db.update(usersTable).set({ currentSessionId: null })
    .where(eq(usersTable.currentSessionId, id));

  const u = (req as any).authUser;
  void writeAudit({
    userId: u.id, username: u.username, role: u.role, companyId: cid,
    module: "sessions", action: "delete",
    method: req.method, path: req.originalUrl, statusCode: 200,
    entityType: "sessions", entityId: String(id),
    ip: clientIp(req), userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
    metadata: null,
  });
  res.json({ ok: true, session: row });
});

// ─── Admin: list users assigned to a session ─────────────────────────────
router.get("/:id/users", requirePermission("sessions", "view"), async (req, res) => {
  const cid = getCid(req);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  const id = parseInt(req.params.id, 10);
  if (!id) { res.status(400).json({ error: "id غير صالح" }); return; }

  // Verify the session belongs to the same company
  const [session] = await db.select().from(sessionsTable)
    .where(and(eq(sessionsTable.id, id), eq(sessionsTable.companyId, cid))).limit(1);
  if (!session) { res.status(404).json({ error: "غير موجود" }); return; }

  const rows = await db.select({
    id: usersTable.id,
    username: usersTable.username,
    nameAr: usersTable.nameAr,
    nameEn: usersTable.nameEn,
    role: usersTable.role,
    addedAt: sessionUsersTable.addedAt,
    sessionUserId: sessionUsersTable.id,
  }).from(sessionUsersTable)
    .innerJoin(usersTable, eq(usersTable.id, sessionUsersTable.userId))
    .where(eq(sessionUsersTable.sessionId, id))
    .orderBy(desc(sessionUsersTable.addedAt));

  res.json({ users: rows });
});

// ─── Admin: bulk-assign users to a session ───────────────────────────────
router.post("/:id/users", requirePermission("sessions", "edit"), async (req, res) => {
  const cid = getCid(req);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  const id = parseInt(req.params.id, 10);
  if (!id) { res.status(400).json({ error: "id غير صالح" }); return; }
  const userIds: number[] = Array.isArray(req.body?.userIds)
    ? req.body.userIds.map((x: any) => parseInt(x, 10)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];
  if (!userIds.length) { res.status(400).json({ error: "userIds مطلوب" }); return; }

  // Verify session ownership
  const [session] = await db.select().from(sessionsTable)
    .where(and(eq(sessionsTable.id, id), eq(sessionsTable.companyId, cid))).limit(1);
  if (!session) { res.status(404).json({ error: "غير موجود" }); return; }

  // Restrict to users from the same company
  const validUsers = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(inArray(usersTable.id, userIds), eq(usersTable.companyId, cid)));
  const validIds = validUsers.map(u => u.id);
  if (!validIds.length) { res.json({ added: 0 }); return; }

  const u = (req as any).authUser;
  const rows = validIds.map(uid => ({
    sessionId: id, userId: uid, addedByUserId: u.id,
  }));
  // ON CONFLICT DO NOTHING via unique index — count from returning.
  const inserted = await db.insert(sessionUsersTable).values(rows)
    .onConflictDoNothing({ target: [sessionUsersTable.sessionId, sessionUsersTable.userId] })
    .returning();

  void writeAudit({
    userId: u.id, username: u.username, role: u.role, companyId: cid,
    module: "sessions", action: "edit",
    method: req.method, path: req.originalUrl, statusCode: 200,
    entityType: "session_users", entityId: String(id),
    ip: clientIp(req), userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
    metadata: { added: inserted.length, requestedUserIds: validIds },
  });
  res.json({ added: inserted.length });
});

// ─── Admin: unassign one user ────────────────────────────────────────────
router.delete("/:id/users/:userId", requirePermission("sessions", "edit"), async (req, res) => {
  const cid = getCid(req);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  const id = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  if (!id || !userId) { res.status(400).json({ error: "id/userId غير صالح" }); return; }

  const [session] = await db.select().from(sessionsTable)
    .where(and(eq(sessionsTable.id, id), eq(sessionsTable.companyId, cid))).limit(1);
  if (!session) { res.status(404).json({ error: "غير موجود" }); return; }

  await db.delete(sessionUsersTable)
    .where(and(eq(sessionUsersTable.sessionId, id), eq(sessionUsersTable.userId, userId)));

  // Self-heal user's selection if it was pointing to this session
  await db.update(usersTable).set({ currentSessionId: null })
    .where(and(eq(usersTable.id, userId), eq(usersTable.currentSessionId, id)));

  const u = (req as any).authUser;
  void writeAudit({
    userId: u.id, username: u.username, role: u.role, companyId: cid,
    module: "sessions", action: "delete",
    method: req.method, path: req.originalUrl, statusCode: 200,
    entityType: "session_users", entityId: `${id}:${userId}`,
    ip: clientIp(req), userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
    metadata: null,
  });
  res.json({ ok: true });
});

// ─── Self: list my sessions (active only) ────────────────────────────────
// Helper used by login flow too; exported for reuse.
export async function listSessionsForUser(userId: number, companyId: number) {
  return db.select({
    id: sessionsTable.id,
    name: sessionsTable.name,
    status: sessionsTable.status,
  }).from(sessionsTable)
    .innerJoin(sessionUsersTable, eq(sessionUsersTable.sessionId, sessionsTable.id))
    .where(and(
      eq(sessionUsersTable.userId, userId),
      eq(sessionsTable.companyId, companyId),
      eq(sessionsTable.status, "active"),
    ))
    .orderBy(desc(sessionsTable.createdAt));
}

router.get("/me", async (req, res) => {
  const u = (req as any).authUser;
  if (!u?.companyId) { res.json({ sessions: [], currentSessionId: null }); return; }
  const sessions = await listSessionsForUser(u.id, u.companyId);
  // Pull persisted selection
  const [me] = await db.select({ currentSessionId: usersTable.currentSessionId })
    .from(usersTable).where(eq(usersTable.id, u.id)).limit(1);
  let currentSessionId = me?.currentSessionId ?? null;
  // Self-heal if selection points to a session that's no longer assigned/active.
  if (currentSessionId && !sessions.find(s => s.id === currentSessionId)) {
    currentSessionId = null;
    await db.update(usersTable).set({ currentSessionId: null })
      .where(eq(usersTable.id, u.id));
  }
  res.json({ sessions, currentSessionId });
});

// ─── Self: select / clear current session ────────────────────────────────
router.post("/me/select", async (req, res) => {
  const u = (req as any).authUser;
  if (!u?.companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  const raw = req.body?.sessionId;
  const sessionId = raw == null || raw === "" ? null : parseInt(raw, 10);

  if (sessionId != null) {
    if (!Number.isFinite(sessionId)) { res.status(400).json({ error: "sessionId غير صالح" }); return; }
    // Must be assigned + active
    const sessions = await listSessionsForUser(u.id, u.companyId);
    if (!sessions.find(s => s.id === sessionId)) {
      res.status(403).json({ error: "غير مسموح بالجلسة المحددة" }); return;
    }
  }

  await db.update(usersTable).set({ currentSessionId: sessionId })
    .where(eq(usersTable.id, u.id));
  res.json({ ok: true, currentSessionId: sessionId });
});

// ─── Self: quick-create (perm-gated) ─────────────────────────────────────
router.post("/me/quick-create", requirePermission("sessions_self_create", "create"), async (req, res) => {
  const u = (req as any).authUser;
  if (!u?.companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  const name = (req.body?.name || "").toString().trim();
  if (!name) { res.status(400).json({ error: "الاسم مطلوب" }); return; }

  const [row] = await db.insert(sessionsTable).values({
    companyId: u.companyId, name, status: "active", createdByUserId: u.id,
  }).returning();
  await db.insert(sessionUsersTable).values({
    sessionId: row.id, userId: u.id, addedByUserId: u.id,
  });
  await db.update(usersTable).set({ currentSessionId: row.id })
    .where(eq(usersTable.id, u.id));

  void writeAudit({
    userId: u.id, username: u.username, role: u.role, companyId: u.companyId,
    module: "sessions", action: "create",
    method: req.method, path: req.originalUrl, statusCode: 200,
    entityType: "sessions", entityId: String(row.id),
    ip: clientIp(req), userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
    metadata: { selfCreated: true, name },
  });
  res.json({ session: row, currentSessionId: row.id });
});

export default router;
