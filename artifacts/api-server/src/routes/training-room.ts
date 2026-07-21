import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { db, trainingSessionsTable, trainingAttendanceTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { livekitConfigured, livekitWsUrl, mintToken, setParticipantMic, deleteRoom } from "../lib/livekit.js";

// ─────────────────────────────────────────────────────────────────────────
// قاعة التدريب المباشر — LiveKit training-room endpoints.
//
// Module key: `training_room` (company gate + per-user perms — kept in sync
// with frontend companyModuleGate.ts / Layout.tsx / MenuPermissions.tsx).
//
// Roles are enforced by TOKEN GRANTS server-side:
//   trainer  → publisher (screen + cam + mic)
//   trainee  → subscribe-only (+ data channel for chat / raise-hand)
//   raise-hand approval → temporary MIC-ONLY grant via RoomService.
//
// PUBLIC entry (Zoom-like link) is per-session opt-in: /public/* endpoints
// are unauthenticated by design and expose ONLY that one session.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

function newPublicToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function noLivekit(res: Response): boolean {
  if (!livekitConfigured()) {
    res.status(503).json({ error: "خدمة البث المباشر غير مهيأة على الخادم" });
    return true;
  }
  return false;
}

// ═══ PUBLIC endpoints (no auth) — MUST be registered before extractAuth ═══

// Landing-page lookup for a public link.
router.get("/public/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  if (token.length < 16 || token.length > 200) { res.status(400).json({ error: "رابط غير صالح" }); return; }
  const [s] = await db.select({
    id: trainingSessionsTable.id,
    title: trainingSessionsTable.title,
    description: trainingSessionsTable.description,
    trainerName: trainingSessionsTable.trainerName,
    status: trainingSessionsTable.status,
    scheduledAt: trainingSessionsTable.scheduledAt,
    startedAt: trainingSessionsTable.startedAt,
  }).from(trainingSessionsTable)
    .where(and(eq(trainingSessionsTable.publicToken, token), eq(trainingSessionsTable.allowPublic, true)))
    .limit(1);
  if (!s) { res.status(404).json({ error: "الجلسة غير موجودة" }); return; }
  res.json(s);
});

// Public join — trainee types a display name, gets a subscribe-only token.
router.post("/public/:token/join", async (req: Request, res: Response) => {
  if (noLivekit(res)) return;
  const token = String(req.params.token ?? "");
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  if (!name || name.length < 2) { res.status(400).json({ error: "يرجى كتابة الاسم" }); return; }
  const [s] = await db.select().from(trainingSessionsTable)
    .where(and(eq(trainingSessionsTable.publicToken, token), eq(trainingSessionsTable.allowPublic, true)))
    .limit(1);
  if (!s) { res.status(404).json({ error: "الجلسة غير موجودة" }); return; }
  if (s.status !== "live") { res.status(409).json({ error: "الجلسة لم تبدأ بعد أو انتهت" }); return; }
  const identity = `pub-${crypto.randomBytes(8).toString("hex")}`;
  const jwt = await mintToken({
    room: s.roomName, identity, name, role: "subscriber",
    metadata: { public: true },
  });
  await db.insert(trainingAttendanceTable).values({
    sessionId: s.id, companyId: s.companyId, userId: null,
    displayName: name, identity, isPublic: true,
  });
  res.json({ token: jwt, wsUrl: livekitWsUrl(), identity, sessionId: s.id, title: s.title });
});

// ═══ Authenticated endpoints ═══
router.use(extractAuth);

// List sessions of my company.
router.get("/sessions", requirePermission("training_room", "view"), async (req: Request, res: Response) => {
  const companyId = resolveCompanyId(req);
  if (!companyId) { res.status(400).json({ error: "شركة غير محددة" }); return; }
  const rows = await db.select().from(trainingSessionsTable)
    .where(eq(trainingSessionsTable.companyId, companyId))
    .orderBy(desc(trainingSessionsTable.createdAt))
    .limit(200);
  res.json(rows);
});

// Create a session (trainer).
router.post("/sessions", requirePermission("training_room", "create"), async (req: Request, res: Response) => {
  const u = req.authUser!;
  const companyId = resolveCompanyId(req);
  if (!companyId) { res.status(400).json({ error: "شركة غير محددة" }); return; }
  const title = String(req.body?.title ?? "").trim().slice(0, 200);
  if (!title || title.length < 3) { res.status(400).json({ error: "عنوان الجلسة مطلوب (3 أحرف على الأقل)" }); return; }
  const description = String(req.body?.description ?? "").trim().slice(0, 2000) || null;
  const allowRegistered = req.body?.allowRegistered !== false;
  const allowPublic = req.body?.allowPublic === true;
  if (!allowRegistered && !allowPublic) {
    res.status(400).json({ error: "يجب تفعيل طريقة دخول واحدة على الأقل" }); return;
  }
  const scheduledAt = req.body?.scheduledAt ? new Date(String(req.body.scheduledAt)) : null;
  const roomName = `training-${companyId}-${crypto.randomBytes(6).toString("hex")}`;
  const [row] = await db.insert(trainingSessionsTable).values({
    companyId, trainerUserId: u.id, trainerName: u.username ?? null,
    title, description, roomName,
    allowRegistered, allowPublic,
    publicToken: allowPublic ? newPublicToken() : null,
    scheduledAt: scheduledAt && !isNaN(scheduledAt.getTime()) ? scheduledAt : null,
  }).returning();
  res.status(201).json(row);
});

async function loadOwnSession(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return null; }
  const companyId = resolveCompanyId(req);
  if (!companyId) { res.status(400).json({ error: "شركة غير محددة" }); return null; }
  const [s] = await db.select().from(trainingSessionsTable)
    .where(and(eq(trainingSessionsTable.id, id), eq(trainingSessionsTable.companyId, companyId)))
    .limit(1);
  if (!s) { res.status(404).json({ error: "الجلسة غير موجودة" }); return null; }
  return s;
}

// Update entry modes / regenerate public link (trainer, before or during).
router.patch("/sessions/:id", requirePermission("training_room", "edit"), async (req: Request, res: Response) => {
  const s = await loadOwnSession(req, res);
  if (!s) return;
  if (s.status === "ended") { res.status(409).json({ error: "الجلسة انتهت" }); return; }
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.title === "string" && req.body.title.trim().length >= 3) patch.title = req.body.title.trim().slice(0, 200);
  if (typeof req.body?.description === "string") patch.description = req.body.description.trim().slice(0, 2000) || null;
  if (typeof req.body?.allowRegistered === "boolean") patch.allowRegistered = req.body.allowRegistered;
  if (typeof req.body?.allowPublic === "boolean") {
    patch.allowPublic = req.body.allowPublic;
    if (req.body.allowPublic && !s.publicToken) patch.publicToken = newPublicToken();
  }
  if (req.body?.regeneratePublicToken === true) patch.publicToken = newPublicToken();
  const nextReg = (patch.allowRegistered as boolean | undefined) ?? s.allowRegistered;
  const nextPub = (patch.allowPublic as boolean | undefined) ?? s.allowPublic;
  if (!nextReg && !nextPub) { res.status(400).json({ error: "يجب تفعيل طريقة دخول واحدة على الأقل" }); return; }
  if (!Object.keys(patch).length) { res.json(s); return; }
  const [row] = await db.update(trainingSessionsTable).set(patch)
    .where(eq(trainingSessionsTable.id, s.id)).returning();
  res.json(row);
});

// Start broadcasting — returns the trainer's PUBLISHER token.
router.post("/sessions/:id/start", requirePermission("training_room", "edit"), async (req: Request, res: Response) => {
  if (noLivekit(res)) return;
  const u = req.authUser!;
  const s = await loadOwnSession(req, res);
  if (!s) return;
  if (s.status === "ended") { res.status(409).json({ error: "الجلسة انتهت — أنشئ جلسة جديدة" }); return; }
  if (s.trainerUserId !== u.id && u.role !== "admin" && u.role !== "superadmin") {
    res.status(403).json({ error: "المدرب فقط يمكنه بدء البث" }); return;
  }
  if (s.status !== "live") {
    await db.update(trainingSessionsTable)
      .set({ status: "live", startedAt: s.startedAt ?? new Date() })
      .where(eq(trainingSessionsTable.id, s.id));
  }
  const identity = `trainer-${u.id}`;
  const jwt = await mintToken({
    room: s.roomName, identity, name: u.username ?? `مدرب ${u.id}`, role: "publisher",
    metadata: { trainer: true },
  });
  res.json({ token: jwt, wsUrl: livekitWsUrl(), identity, roomName: s.roomName });
});

// Registered trainee join — subscribe-only token + attendance row.
router.post("/sessions/:id/join", requirePermission("training_room", "view"), async (req: Request, res: Response) => {
  if (noLivekit(res)) return;
  const u = req.authUser!;
  const s = await loadOwnSession(req, res);
  if (!s) return;
  if (!s.allowRegistered && s.trainerUserId !== u.id) {
    res.status(403).json({ error: "الدخول متاح عبر الرابط العام فقط لهذه الجلسة" }); return;
  }
  if (s.status !== "live") { res.status(409).json({ error: "الجلسة لم تبدأ بعد أو انتهت" }); return; }
  const identity = `user-${u.id}`;
  const jwt = await mintToken({
    room: s.roomName, identity, name: u.username ?? `مستخدم ${u.id}`, role: "subscriber",
    metadata: { userId: u.id },
  });
  await db.insert(trainingAttendanceTable).values({
    sessionId: s.id, companyId: s.companyId, userId: u.id,
    displayName: u.username ?? `مستخدم ${u.id}`, identity, isPublic: false,
  });
  res.json({ token: jwt, wsUrl: livekitWsUrl(), identity, sessionId: s.id, title: s.title });
});

// Trainer grants / revokes a raised-hand trainee's mic (server-enforced).
router.post("/sessions/:id/mic", requirePermission("training_room", "edit"), async (req: Request, res: Response) => {
  if (noLivekit(res)) return;
  const u = req.authUser!;
  const s = await loadOwnSession(req, res);
  if (!s) return;
  if (s.trainerUserId !== u.id && u.role !== "admin" && u.role !== "superadmin") {
    res.status(403).json({ error: "المدرب فقط يتحكم في الميكروفون" }); return;
  }
  const identity = String(req.body?.identity ?? "");
  const allow = req.body?.allow === true;
  if (!identity) { res.status(400).json({ error: "identity مطلوب" }); return; }
  try {
    await setParticipantMic(s.roomName, identity, allow);
    res.json({ ok: true, identity, allow });
  } catch (e: any) {
    res.status(502).json({ error: "تعذر تحديث صلاحية الميكروفون", detail: String(e?.message ?? e) });
  }
});

// End the session.
router.post("/sessions/:id/end", requirePermission("training_room", "edit"), async (req: Request, res: Response) => {
  const u = req.authUser!;
  const s = await loadOwnSession(req, res);
  if (!s) return;
  if (s.trainerUserId !== u.id && u.role !== "admin" && u.role !== "superadmin") {
    res.status(403).json({ error: "المدرب فقط يمكنه إنهاء الجلسة" }); return;
  }
  if (s.status === "ended") { res.json(s); return; }
  const [row] = await db.update(trainingSessionsTable)
    .set({ status: "ended", endedAt: new Date() })
    .where(eq(trainingSessionsTable.id, s.id)).returning();
  await deleteRoom(s.roomName);
  res.json(row);
});

// Attendance log.
router.get("/sessions/:id/attendance", requirePermission("training_room", "view"), async (req: Request, res: Response) => {
  const s = await loadOwnSession(req, res);
  if (!s) return;
  const rows = await db.select().from(trainingAttendanceTable)
    .where(eq(trainingAttendanceTable.sessionId, s.id))
    .orderBy(desc(trainingAttendanceTable.joinedAt))
    .limit(2000);
  res.json(rows);
});

export default router;
