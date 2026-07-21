import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { db, supportCallLogsTable, usersTable } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { extractAuth } from "../middleware/auth.js";
import { emitToUser } from "../lib/sessionEvents.js";
import { livekitConfigured, livekitWsUrl, mintToken, deleteRoom } from "../lib/livekit.js";

// ─────────────────────────────────────────────────────────────────────────
// غرفة الدعم الفني — LiveKit support room (replaces the Jitsi popup).
//
//   POST /api/support-room/calls            → SA agent opens a call (optionally
//                                             targeting a user → SSE ring)
//   POST /api/support-room/calls/:id/join   → either side gets its token
//   POST /api/support-room/calls/:id/end    → end + log duration
//   GET  /api/support-room/calls            → SA call log
//
// Agent endpoints are SuperAdmin-only. The target user may ONLY join/end a
// call addressed to them.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();
router.use(extractAuth);

function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.authUser?.role !== "superadmin") { res.status(403).json({ error: "صلاحية السوبر أدمن مطلوبة" }); return; }
  next();
}

function noLivekit(res: Response): boolean {
  if (!livekitConfigured()) {
    res.status(503).json({ error: "خدمة البث المباشر غير مهيأة على الخادم" });
    return true;
  }
  return false;
}

// Agent opens a call. If targetUserId is provided, that user is "rung" via SSE.
router.post("/calls", requireSuperAdmin, async (req: Request, res: Response) => {
  if (noLivekit(res)) return;
  const u = req.authUser!;
  const targetUserId = Number(req.body?.targetUserId) || null;
  let targetCompanyId: number | null = null;
  let targetLabel: string | null = null;
  if (targetUserId) {
    const [t] = await db.select({ id: usersTable.id, username: usersTable.username, companyId: usersTable.companyId })
      .from(usersTable).where(eq(usersTable.id, targetUserId)).limit(1);
    if (!t) { res.status(404).json({ error: "المستخدم غير موجود" }); return; }
    targetCompanyId = t.companyId ?? null;
    targetLabel = t.username ?? null;
  }
  const roomName = `support-${crypto.randomBytes(6).toString("hex")}`;
  const [call] = await db.insert(supportCallLogsTable).values({
    agentUserId: u.id, agentUsername: u.username ?? null,
    targetUserId, targetCompanyId, targetLabel,
    roomName, status: "pending",
  }).returning();
  if (targetUserId) {
    emitToUser(targetUserId, targetCompanyId, "support_call_invite", {
      callId: call.id, agentUsername: u.username ?? "الدعم الفني",
    });
  }
  const jwt = await mintToken({
    room: roomName, identity: `agent-${u.id}`,
    name: u.username ?? "الدعم الفني", role: "publisher",
    metadata: { supportAgent: true },
  });
  res.status(201).json({ call, token: jwt, wsUrl: livekitWsUrl(), identity: `agent-${u.id}` });
});

// Either side joins (agent re-join or target user answering).
router.post("/calls/:id/join", async (req: Request, res: Response) => {
  if (noLivekit(res)) return;
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [call] = await db.select().from(supportCallLogsTable).where(eq(supportCallLogsTable.id, id)).limit(1);
  if (!call) { res.status(404).json({ error: "المكالمة غير موجودة" }); return; }
  if (call.status === "ended") { res.status(409).json({ error: "المكالمة انتهت" }); return; }
  // العميل المصرَّح له هو صاحب المكالمة فقط — سوبر أدمن آخر لا يجوز له
  // الانضمام لمكالمة زميله (منع التنصّت بين حسابات SA).
  const isAgent = u.role === "superadmin" && call.agentUserId === u.id;
  const isTarget = call.targetUserId != null && call.targetUserId === u.id;
  if (!isAgent && !isTarget) { res.status(403).json({ error: "غير مصرح بهذه المكالمة" }); return; }
  if (!isAgent && call.status === "pending") {
    await db.update(supportCallLogsTable)
      .set({ status: "active", joinedAt: call.joinedAt ?? new Date() })
      .where(eq(supportCallLogsTable.id, call.id));
  }
  const identity = isAgent ? `agent-${u.id}` : `user-${u.id}`;
  const jwt = await mintToken({
    room: call.roomName, identity,
    name: u.username ?? identity, role: "publisher", // both sides can share cam/mic/screen
  });
  res.json({ token: jwt, wsUrl: livekitWsUrl(), identity, roomName: call.roomName });
});

// End a call (agent or target).
router.post("/calls/:id/end", async (req: Request, res: Response) => {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [call] = await db.select().from(supportCallLogsTable).where(eq(supportCallLogsTable.id, id)).limit(1);
  if (!call) { res.status(404).json({ error: "المكالمة غير موجودة" }); return; }
  // نفس قاعدة الانضمام: صاحب المكالمة فقط (وليس أي سوبر أدمن) أو المستهدف.
  const isAgent = u.role === "superadmin" && call.agentUserId === u.id;
  const isTarget = call.targetUserId != null && call.targetUserId === u.id;
  if (!isAgent && !isTarget) { res.status(403).json({ error: "غير مصرح" }); return; }
  if (call.status === "ended") { res.json(call); return; }
  const [row] = await db.update(supportCallLogsTable)
    .set({ status: "ended", endedAt: new Date(), endReason: isAgent ? "agent_ended" : "user_ended" })
    .where(eq(supportCallLogsTable.id, call.id)).returning();
  if (call.status === "pending" && call.targetUserId && isAgent) {
    emitToUser(call.targetUserId, call.targetCompanyId, "support_call_cancelled", { callId: call.id });
  }
  await deleteRoom(call.roomName);
  res.json(row);
});

// SA call log.
router.get("/calls", requireSuperAdmin, async (req: Request, res: Response) => {
  const status = String(req.query.status ?? "");
  const where = ["pending", "active", "ended"].includes(status)
    ? eq(supportCallLogsTable.status, status)
    : inArray(supportCallLogsTable.status, ["pending", "active", "ended"]);
  const rows = await db.select().from(supportCallLogsTable)
    .where(where)
    .orderBy(desc(supportCallLogsTable.createdAt))
    .limit(300);
  res.json(rows);
});

export default router;
