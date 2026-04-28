import { Router } from "express";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import {
  attendanceCamerasTable,
  employeeFaceEnrollmentsTable,
  faceRecognitionLogsTable,
  attendanceAiSettingsTable,
  employeeAttendanceTable,
  employeesTable,
  branchesTable,
  kioskTokensTable,
  usersTable,
} from "@workspace/db";
import { and, eq, desc, asc, sql, gte, isNotNull, isNull } from "drizzle-orm";
import { extractAuth, resolveCompanyId, denyKiosk, hashKioskToken } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

const N = (v: any) => (v == null || v === "" ? null : v);

// ─── Crypto helpers ─────────────────────────────────────
// Derive 32-byte keys from SESSION_SECRET (mandatory in this deployment).
// Fail-closed: if SESSION_SECRET is missing or weak, we refuse to derive a key.
// This prevents an attacker from forging recognition tickets or decrypting
// camera passwords against a known fallback secret.
function deriveKey(label: string): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "SESSION_SECRET must be set (>= 16 chars) for face-attendance crypto. Refusing to start with insecure key.",
    );
  }
  return crypto.createHash("sha256").update(`${label}:${secret}`).digest();
}
const TICKET_KEY = deriveKey("face-recognition-ticket-v1");
const CAM_KEY = deriveKey("attendance-camera-secret-v1");

// AES-256-GCM encryption for camera credentials (passwordEnc).
function encryptSecret(plain: string | null): string | null {
  if (plain == null || plain === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", CAM_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}
// Mask returned to clients — never expose plaintext or ciphertext.
function maskSecret(stored: string | null): string | null {
  if (!stored) return null;
  return "********";
}

// Strip embedded credentials (user:pass@) from a stream URL before storage or display.
// Returns { url: cleaned URL or original input, password: extracted password if any }.
function scrubStreamUrl(input: string | null | undefined): { url: string | null; password: string | null } {
  if (!input || typeof input !== "string") return { url: null, password: null };
  const trimmed = input.trim();
  if (!trimmed) return { url: null, password: null };
  // Match scheme://user:pass@host…  capture user, password, and the rest after @
  const m = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s:]+)(?::([^@\s]*))?@(.+)$/);
  if (!m) return { url: trimmed, password: null };
  const [, scheme, , pass, rest] = m;
  return { url: `${scheme}${rest}`, password: pass ? decodeURIComponent(pass) : null };
}

// HMAC-signed recognition ticket: binds employeeId+confidence+liveness+camera+company+expiry.
// Prevents /check from being called with arbitrary client-supplied identity.
type TicketPayload = {
  c: number;        // companyId
  e: number;        // employeeId
  cf: number;       // confidence 0-1
  l: 0 | 1;         // livenessPassed
  cm: number | null;// cameraId
  exp: number;      // expiry epoch ms
  n: string;        // nonce
};
function signTicket(p: Omit<TicketPayload, "exp" | "n">): string {
  const payload: TicketPayload = {
    ...p,
    exp: Date.now() + 60_000, // 60 second TTL
    n: crypto.randomBytes(8).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", TICKET_KEY).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyTicket(token: string | undefined | null): TicketPayload | null {
  if (!token || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = crypto.createHmac("sha256", TICKET_KEY).update(body).digest("base64url");
  // timing-safe compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TicketPayload;
    if (typeof p.exp !== "number" || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

function parseDescriptor(json: string): number[] | null {
  try {
    const a = JSON.parse(json);
    if (Array.isArray(a) && a.length === 128 && a.every((x) => typeof x === "number")) return a;
  } catch {}
  return null;
}

function euclidean(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

async function getSettings(companyId: number) {
  const [row] = await db.select().from(attendanceAiSettingsTable)
    .where(eq(attendanceAiSettingsTable.companyId, companyId)).limit(1);
  if (row) return row;
  const [created] = await db.insert(attendanceAiSettingsTable)
    .values({ companyId }).returning();
  return created;
}

// ─── SETTINGS ───────────────────────────────────────────
router.get("/settings", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const s = await getSettings(cid);
    res.json(s);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/settings", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    await getSettings(cid);
    const b = req.body ?? {};
    const [updated] = await db.update(attendanceAiSettingsTable)
      .set({
        matchThreshold: b.matchThreshold != null ? String(b.matchThreshold) : undefined,
        cooldownSeconds: b.cooldownSeconds ?? undefined,
        requireLiveness: typeof b.requireLiveness === "boolean" ? b.requireLiveness : undefined,
        autoCheckOut: typeof b.autoCheckOut === "boolean" ? b.autoCheckOut : undefined,
        lateToleranceMin: b.lateToleranceMin ?? undefined,
        workdayStart: N(b.workdayStart),
        workdayEnd: N(b.workdayEnd),
        notifyOnUnknown: typeof b.notifyOnUnknown === "boolean" ? b.notifyOnUnknown : undefined,
        minQualityScore: b.minQualityScore != null ? String(b.minQualityScore) : undefined,
        updatedAt: new Date(),
      })
      .where(eq(attendanceAiSettingsTable.companyId, cid))
      .returning();
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── CAMERAS CRUD ───────────────────────────────────────
router.get("/cameras", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select({
      id: attendanceCamerasTable.id,
      name: attendanceCamerasTable.name,
      location: attendanceCamerasTable.location,
      kind: attendanceCamerasTable.kind,
      branchId: attendanceCamerasTable.branchId,
      branchName: branchesTable.nameAr,
      dvrIp: attendanceCamerasTable.dvrIp,
      port: attendanceCamerasTable.port,
      channel: attendanceCamerasTable.channel,
      protocol: attendanceCamerasTable.protocol,
      username: attendanceCamerasTable.username,
      passwordSet: sql<boolean>`(${attendanceCamerasTable.passwordEnc} is not null)`,
      streamUrl: attendanceCamerasTable.streamUrl,
      aiEnabled: attendanceCamerasTable.aiEnabled,
      status: attendanceCamerasTable.status,
      lastSeenAt: attendanceCamerasTable.lastSeenAt,
      notes: attendanceCamerasTable.notes,
      createdAt: attendanceCamerasTable.createdAt,
    }).from(attendanceCamerasTable)
      .leftJoin(branchesTable, and(
        eq(attendanceCamerasTable.branchId, branchesTable.id),
        eq(branchesTable.companyId, cid),
      ))
      .where(eq(attendanceCamerasTable.companyId, cid))
      .orderBy(asc(attendanceCamerasTable.name));
    // Defense-in-depth: even if an older row has user:pass@ baked into streamUrl,
    // scrub it out before returning to the client.
    const safe = rows.map((r) => ({ ...r, streamUrl: scrubStreamUrl(r.streamUrl).url }));
    res.json(safe);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/cameras", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    if (!b.name) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
    // Strip embedded user:pass@ from streamUrl. If the URL carried a password and
    // none was given separately, hoist that password into passwordEnc.
    const scrubbed = scrubStreamUrl(N(b.streamUrl));
    const finalPassword = N(b.password) ?? scrubbed.password;
    const [row] = await db.insert(attendanceCamerasTable).values({
      companyId: cid,
      branchId: N(b.branchId),
      name: b.name,
      location: N(b.location),
      kind: b.kind ?? "webcam",
      dvrIp: N(b.dvrIp),
      port: b.port != null && b.port !== "" ? Number(b.port) : null,
      channel: b.channel != null && b.channel !== "" ? Number(b.channel) : null,
      protocol: N(b.protocol) ?? "rtsp",
      username: N(b.username),
      passwordEnc: encryptSecret(finalPassword),
      streamUrl: scrubbed.url,
      aiEnabled: b.aiEnabled !== false,
      status: b.status ?? "active",
      notes: N(b.notes),
    }).returning();
    res.json({ ...row, passwordEnc: undefined, password: undefined, passwordSet: !!row.passwordEnc });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/cameras/:id", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    let streamUrlUpdate: string | null | undefined = undefined;
    let passwordUpdate: string | null | undefined = undefined;
    if (b.streamUrl !== undefined) {
      const scrubbed = scrubStreamUrl(N(b.streamUrl));
      streamUrlUpdate = scrubbed.url;
      if (scrubbed.password && b.password === undefined) {
        // Hoist embedded password to passwordEnc when client didn't provide one.
        passwordUpdate = encryptSecret(scrubbed.password);
      }
    }
    if (b.password !== undefined) passwordUpdate = encryptSecret(N(b.password));
    const [row] = await db.update(attendanceCamerasTable).set({
      branchId: b.branchId !== undefined ? N(b.branchId) : undefined,
      name: b.name ?? undefined,
      location: b.location !== undefined ? N(b.location) : undefined,
      kind: b.kind ?? undefined,
      dvrIp: b.dvrIp !== undefined ? N(b.dvrIp) : undefined,
      port: b.port !== undefined ? (b.port === "" ? null : Number(b.port)) : undefined,
      channel: b.channel !== undefined ? (b.channel === "" ? null : Number(b.channel)) : undefined,
      protocol: b.protocol !== undefined ? N(b.protocol) : undefined,
      username: b.username !== undefined ? N(b.username) : undefined,
      passwordEnc: passwordUpdate,
      streamUrl: streamUrlUpdate,
      aiEnabled: typeof b.aiEnabled === "boolean" ? b.aiEnabled : undefined,
      status: b.status ?? undefined,
      notes: b.notes !== undefined ? N(b.notes) : undefined,
      updatedAt: new Date(),
    }).where(and(eq(attendanceCamerasTable.id, id), eq(attendanceCamerasTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json({ ...row, passwordEnc: undefined, password: undefined, passwordSet: !!row.passwordEnc });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/cameras/:id", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(attendanceCamerasTable)
      .where(and(eq(attendanceCamerasTable.id, id), eq(attendanceCamerasTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/cameras/:id/ping", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [cam] = await db.select().from(attendanceCamerasTable)
      .where(and(eq(attendanceCamerasTable.id, id), eq(attendanceCamerasTable.companyId, cid))).limit(1);
    if (!cam) { res.status(404).json({ error: "غير موجود" }); return; }
    await db.update(attendanceCamerasTable).set({ lastSeenAt: new Date() })
      .where(eq(attendanceCamerasTable.id, id));
    if (cam.kind === "webcam") { res.json({ ok: true, message: "كاميرا متصفح — تستعمل webcam المستخدم" }); return; }
    if (!cam.streamUrl && !cam.dvrIp) { res.json({ ok: false, message: "لم يُحدَّد عنوان البث" }); return; }
    res.json({ ok: true, message: "تم تسجيل محاولة الاتصال (يتطلب البث الفعلي بيئة إنتاج)" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ENROLLMENTS ────────────────────────────────────────
router.get("/enrollments", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;
    const where = employeeId
      ? and(eq(employeeFaceEnrollmentsTable.companyId, cid), eq(employeeFaceEnrollmentsTable.employeeId, employeeId))
      : eq(employeeFaceEnrollmentsTable.companyId, cid);
    const rows = await db.select({
      id: employeeFaceEnrollmentsTable.id,
      employeeId: employeeFaceEnrollmentsTable.employeeId,
      employeeName: employeesTable.nameAr,
      employeeCode: employeesTable.code,
      qualityScore: employeeFaceEnrollmentsTable.qualityScore,
      pose: employeeFaceEnrollmentsTable.pose,
      livenessPassed: employeeFaceEnrollmentsTable.livenessPassed,
      isPrimary: employeeFaceEnrollmentsTable.isPrimary,
      capturedAt: employeeFaceEnrollmentsTable.capturedAt,
      imageUrl: employeeFaceEnrollmentsTable.imageUrl,
    }).from(employeeFaceEnrollmentsTable)
      .innerJoin(employeesTable, and(
        eq(employeeFaceEnrollmentsTable.employeeId, employeesTable.id),
        eq(employeesTable.companyId, cid),
      ))
      .where(where)
      .orderBy(desc(employeeFaceEnrollmentsTable.capturedAt));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/enrollments", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    if (!b.employeeId) { res.status(400).json({ error: "الموظف مطلوب" }); return; }
    if (!b.descriptor || !Array.isArray(b.descriptor) || b.descriptor.length !== 128) {
      res.status(400).json({ error: "بصمة الوجه غير صالحة" }); return;
    }
    // Sanity: verify employee belongs to company
    const [emp] = await db.select({ id: employeesTable.id }).from(employeesTable)
      .where(and(eq(employeesTable.id, Number(b.employeeId)), eq(employeesTable.companyId, cid))).limit(1);
    if (!emp) { res.status(404).json({ error: "موظف غير موجود" }); return; }

    const settings = await getSettings(cid);
    const minQ = Number(settings.minQualityScore ?? "0.5");
    const q = Number(b.qualityScore ?? 0);
    if (q < minQ) {
      res.status(400).json({ error: `جودة الصورة منخفضة (${q.toFixed(2)} < ${minQ})` }); return;
    }
    if (settings.requireLiveness && !b.livenessPassed) {
      res.status(400).json({ error: "فشل اختبار الكشف الحي (Liveness)" }); return;
    }

    // First enrollment for this employee → mark primary
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(employeeFaceEnrollmentsTable)
      .where(and(
        eq(employeeFaceEnrollmentsTable.companyId, cid),
        eq(employeeFaceEnrollmentsTable.employeeId, Number(b.employeeId)),
      ));

    const [row] = await db.insert(employeeFaceEnrollmentsTable).values({
      companyId: cid,
      employeeId: Number(b.employeeId),
      descriptorJson: JSON.stringify(b.descriptor),
      qualityScore: String(q),
      pose: N(b.pose) ?? "frontal",
      livenessPassed: !!b.livenessPassed,
      imageUrl: N(b.imageUrl),
      isPrimary: count === 0,
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/enrollments/:id", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(employeeFaceEnrollmentsTable)
      .where(and(eq(employeeFaceEnrollmentsTable.id, id), eq(employeeFaceEnrollmentsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── RECOGNITION ────────────────────────────────────────
router.post("/recognize", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const desc: number[] | null = Array.isArray(b.descriptor) && b.descriptor.length === 128 ? b.descriptor : null;
    if (!desc) { res.status(400).json({ error: "بصمة الوجه غير صالحة" }); return; }

    const settings = await getSettings(cid);
    const threshold = Number(settings.matchThreshold ?? "0.6");

    const cameraId = req.body?.cameraId != null && req.body.cameraId !== "" ? Number(req.body.cameraId) : null;
    const livenessPassedRaw = !!req.body?.livenessPassed;
    if (cameraId != null) {
      const [okCam] = await db.select({ id: attendanceCamerasTable.id }).from(attendanceCamerasTable)
        .where(and(eq(attendanceCamerasTable.id, cameraId), eq(attendanceCamerasTable.companyId, cid))).limit(1);
      if (!okCam) { res.status(400).json({ error: "كاميرا غير صالحة" }); return; }
    }

    const enrolls = await db.select({
      id: employeeFaceEnrollmentsTable.id,
      employeeId: employeeFaceEnrollmentsTable.employeeId,
      descriptorJson: employeeFaceEnrollmentsTable.descriptorJson,
      employeeName: employeesTable.nameAr,
      employeeCode: employeesTable.code,
      employeePhotoUrl: employeesTable.photoUrl,
    }).from(employeeFaceEnrollmentsTable)
      .innerJoin(employeesTable, and(
        eq(employeeFaceEnrollmentsTable.employeeId, employeesTable.id),
        eq(employeesTable.companyId, cid),
      ))
      .where(and(
        eq(employeeFaceEnrollmentsTable.companyId, cid),
        eq(employeesTable.status, "active"),
      ));

    let best: { distance: number; employeeId: number; employeeName: string | null; employeeCode: string | null; employeePhotoUrl: string | null } | null = null;
    for (const e of enrolls) {
      const arr = parseDescriptor(e.descriptorJson);
      if (!arr) continue;
      const d = euclidean(desc, arr);
      if (!best || d < best.distance) {
        best = {
          distance: d,
          employeeId: e.employeeId,
          employeeName: e.employeeName,
          employeeCode: e.employeeCode,
          employeePhotoUrl: e.employeePhotoUrl,
        };
      }
    }

    if (!best) {
      res.json({ matched: false, reason: "no_enrollments" }); return;
    }
    const confidence = Math.max(0, 1 - best.distance);
    const matched = best.distance <= threshold;

    // Issue a short-lived signed ticket only for matched + (optionally liveness-ok) results.
    // /check requires this ticket — preventing bypass via direct employeeId injection.
    const ticket = matched
      ? signTicket({ c: cid, e: best.employeeId, cf: confidence, l: livenessPassedRaw ? 1 : 0, cm: cameraId })
      : null;

    res.json({
      matched,
      employeeId: matched ? best.employeeId : null,
      employeeName: best.employeeName,
      employeeCode: best.employeeCode,
      employeePhotoUrl: best.employeePhotoUrl,
      distance: best.distance,
      confidence,
      threshold,
      ticket,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── CHECK-IN / CHECK-OUT ───────────────────────────────
// Identity (employeeId, confidence, liveness, cameraId) MUST come from a signed
// ticket issued by /recognize. Client-supplied identity fields are ignored.
router.post("/check", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const ticket = verifyTicket(b.ticket);
    if (!ticket) { res.status(400).json({ error: "بطاقة تعرّف غير صالحة أو منتهية" }); return; }
    if (ticket.c !== cid) { res.status(403).json({ error: "بطاقة لا تخص الشركة" }); return; }
    const employeeId = ticket.e;
    const cameraId = ticket.cm;
    const conf = ticket.cf;
    const livenessPassed = ticket.l === 1;
    const deviceInfo = N(b.deviceInfo);

    const settings = await getSettings(cid);
    if (settings.requireLiveness && !livenessPassed) {
      const [logRow] = await db.insert(faceRecognitionLogsTable).values({
        companyId: cid,
        employeeId,
        cameraId,
        matchedConfidence: conf != null ? String(conf) : null,
        action: b.action ?? "auto",
        status: "spoof",
        livenessPassed: false,
        spoofReason: "missing_liveness",
        deviceInfo,
      }).returning();
      res.status(400).json({ error: "فشل الكشف الحي", logId: logRow.id }); return;
    }

    const [emp] = await db.select().from(employeesTable)
      .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid))).limit(1);
    if (!emp) { res.status(404).json({ error: "موظف غير موجود" }); return; }

    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const timeStr = today.toTimeString().slice(0, 8);

    // Cooldown: prevent duplicate within N seconds
    const cooldown = settings.cooldownSeconds ?? 300;
    const since = new Date(today.getTime() - cooldown * 1000);
    const [recent] = await db.select({ id: faceRecognitionLogsTable.id, createdAt: faceRecognitionLogsTable.createdAt, action: faceRecognitionLogsTable.action })
      .from(faceRecognitionLogsTable)
      .where(and(
        eq(faceRecognitionLogsTable.companyId, cid),
        eq(faceRecognitionLogsTable.employeeId, employeeId),
        eq(faceRecognitionLogsTable.status, "ok"),
        gte(faceRecognitionLogsTable.createdAt, since),
      ))
      .orderBy(desc(faceRecognitionLogsTable.createdAt)).limit(1);
    if (recent) {
      const [logRow] = await db.insert(faceRecognitionLogsTable).values({
        companyId: cid, employeeId, cameraId,
        matchedConfidence: conf != null ? String(conf) : null,
        action: "skipped_cooldown",
        status: "low_confidence",
        livenessPassed,
        spoofReason: "cooldown",
        deviceInfo,
      }).returning();
      res.json({ ok: false, reason: "cooldown", cooldownSeconds: cooldown, logId: logRow.id }); return;
    }

    // Find / create today's attendance row
    const [existing] = await db.select().from(employeeAttendanceTable)
      .where(and(
        eq(employeeAttendanceTable.companyId, cid),
        eq(employeeAttendanceTable.employeeId, employeeId),
        eq(employeeAttendanceTable.date, dateStr),
      )).limit(1);

    let action = b.action as string | undefined;
    if (!action || action === "auto") {
      if (!existing || !existing.checkIn) action = "check_in";
      else action = "check_out";
    }

    let attendanceId: number;
    let lateMinutes = existing?.lateMinutes ?? 0;
    if (action === "check_in") {
      // late detection
      if (settings.workdayStart) {
        const [hh, mm] = settings.workdayStart.split(":").map((x) => parseInt(x, 10));
        const dueMin = hh * 60 + mm + (settings.lateToleranceMin ?? 0);
        const nowMin = today.getHours() * 60 + today.getMinutes();
        if (nowMin > dueMin) lateMinutes = nowMin - (hh * 60 + mm);
      }
      if (existing) {
        const [u] = await db.update(employeeAttendanceTable).set({
          checkIn: timeStr,
          aiMethod: "face_recognition",
          aiConfidenceIn: conf != null ? String(conf) : null,
          cameraInId: cameraId,
          lateMinutes,
          status: "present",
          updatedAt: new Date(),
        }).where(eq(employeeAttendanceTable.id, existing.id)).returning();
        attendanceId = u.id;
      } else {
        const [ins] = await db.insert(employeeAttendanceTable).values({
          companyId: cid,
          employeeId,
          date: dateStr,
          checkIn: timeStr,
          aiMethod: "face_recognition",
          aiConfidenceIn: conf != null ? String(conf) : null,
          cameraInId: cameraId,
          lateMinutes,
          status: "present",
        }).returning();
        attendanceId = ins.id;
      }
    } else {
      // check_out
      if (!existing) { res.status(400).json({ error: "لا يوجد تسجيل دخول لهذا اليوم" }); return; }
      // compute worked hours
      let worked = 0;
      if (existing.checkIn) {
        const [h1, m1] = existing.checkIn.split(":").map((x) => parseInt(x, 10));
        const [h2, m2] = timeStr.split(":").map((x) => parseInt(x, 10));
        worked = Math.max(0, (h2 * 60 + m2 - h1 * 60 - m1) / 60);
      }
      const [u] = await db.update(employeeAttendanceTable).set({
        checkOut: timeStr,
        aiConfidenceOut: conf != null ? String(conf) : null,
        cameraOutId: cameraId,
        workedHours: String(worked.toFixed(2)),
        updatedAt: new Date(),
      }).where(eq(employeeAttendanceTable.id, existing.id)).returning();
      attendanceId = u.id;
    }

    const [logRow] = await db.insert(faceRecognitionLogsTable).values({
      companyId: cid,
      employeeId,
      cameraId,
      matchedConfidence: conf != null ? String(conf) : null,
      action,
      status: "ok",
      livenessPassed,
      deviceInfo,
      attendanceId,
    }).returning();

    res.json({ ok: true, action, attendanceId, logId: logRow.id, lateMinutes });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── RECENT EVENTS (live feed for kiosk side panel) ─────
router.get("/recent", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const limit = Math.min(50, Number(req.query.limit ?? 20));
    const rows = await db.select({
      id: faceRecognitionLogsTable.id,
      employeeId: faceRecognitionLogsTable.employeeId,
      employeeName: employeesTable.nameAr,
      employeeCode: employeesTable.code,
      employeePhotoUrl: employeesTable.photoUrl,
      cameraId: faceRecognitionLogsTable.cameraId,
      action: faceRecognitionLogsTable.action,
      status: faceRecognitionLogsTable.status,
      matchedConfidence: faceRecognitionLogsTable.matchedConfidence,
      createdAt: faceRecognitionLogsTable.createdAt,
    }).from(faceRecognitionLogsTable)
      .leftJoin(employeesTable, and(
        eq(faceRecognitionLogsTable.employeeId, employeesTable.id),
        eq(employeesTable.companyId, cid),
      ))
      .where(eq(faceRecognitionLogsTable.companyId, cid))
      .orderBy(desc(faceRecognitionLogsTable.createdAt))
      .limit(limit);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── LOGS (audit) ───────────────────────────────────────
router.get("/logs", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const limit = Math.min(500, Number(req.query.limit ?? 200));
    const status = req.query.status as string | undefined;
    let where: any = eq(faceRecognitionLogsTable.companyId, cid);
    if (status) where = and(where, eq(faceRecognitionLogsTable.status, status));
    const rows = await db.select({
      id: faceRecognitionLogsTable.id,
      employeeId: faceRecognitionLogsTable.employeeId,
      employeeName: employeesTable.nameAr,
      employeeCode: employeesTable.code,
      cameraId: faceRecognitionLogsTable.cameraId,
      cameraName: attendanceCamerasTable.name,
      action: faceRecognitionLogsTable.action,
      status: faceRecognitionLogsTable.status,
      matchedConfidence: faceRecognitionLogsTable.matchedConfidence,
      livenessPassed: faceRecognitionLogsTable.livenessPassed,
      spoofReason: faceRecognitionLogsTable.spoofReason,
      deviceInfo: faceRecognitionLogsTable.deviceInfo,
      createdAt: faceRecognitionLogsTable.createdAt,
    }).from(faceRecognitionLogsTable)
      .leftJoin(employeesTable, and(
        eq(faceRecognitionLogsTable.employeeId, employeesTable.id),
        eq(employeesTable.companyId, cid),
      ))
      .leftJoin(attendanceCamerasTable, and(
        eq(faceRecognitionLogsTable.cameraId, attendanceCamerasTable.id),
        eq(attendanceCamerasTable.companyId, cid),
      ))
      .where(where)
      .orderBy(desc(faceRecognitionLogsTable.createdAt))
      .limit(limit);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ANALYTICS / DASHBOARD ──────────────────────────────
router.get("/analytics", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const weekAgo = new Date(today.getTime() - 7 * 86400000);
    const weekAgoStr = weekAgo.toISOString().slice(0, 10);

    const [{ totalEmployees }] = await db.select({ totalEmployees: sql<number>`count(*)::int` })
      .from(employeesTable)
      .where(and(eq(employeesTable.companyId, cid), eq(employeesTable.status, "active")));

    const [{ enrolledEmployees }] = await db.select({
      enrolledEmployees: sql<number>`count(distinct ${employeeFaceEnrollmentsTable.employeeId})::int`,
    }).from(employeeFaceEnrollmentsTable)
      .where(eq(employeeFaceEnrollmentsTable.companyId, cid));

    const [{ camerasCount }] = await db.select({ camerasCount: sql<number>`count(*)::int` })
      .from(attendanceCamerasTable)
      .where(eq(attendanceCamerasTable.companyId, cid));

    const [{ todayPresent }] = await db.select({ todayPresent: sql<number>`count(*)::int` })
      .from(employeeAttendanceTable)
      .where(and(
        eq(employeeAttendanceTable.companyId, cid),
        eq(employeeAttendanceTable.date, todayStr),
        isNotNull(employeeAttendanceTable.checkIn),
      ));

    const [{ todayLate }] = await db.select({ todayLate: sql<number>`count(*)::int` })
      .from(employeeAttendanceTable)
      .where(and(
        eq(employeeAttendanceTable.companyId, cid),
        eq(employeeAttendanceTable.date, todayStr),
        sql`${employeeAttendanceTable.lateMinutes} > 0`,
      ));

    const [{ weekRecognitions }] = await db.select({ weekRecognitions: sql<number>`count(*)::int` })
      .from(faceRecognitionLogsTable)
      .where(and(
        eq(faceRecognitionLogsTable.companyId, cid),
        eq(faceRecognitionLogsTable.status, "ok"),
        gte(faceRecognitionLogsTable.createdAt, weekAgo),
      ));

    const [{ weekSpoofs }] = await db.select({ weekSpoofs: sql<number>`count(*)::int` })
      .from(faceRecognitionLogsTable)
      .where(and(
        eq(faceRecognitionLogsTable.companyId, cid),
        eq(faceRecognitionLogsTable.status, "spoof"),
        gte(faceRecognitionLogsTable.createdAt, weekAgo),
      ));

    // top late employees this week
    const topLate = await db.select({
      employeeId: employeeAttendanceTable.employeeId,
      employeeName: employeesTable.nameAr,
      employeeCode: employeesTable.code,
      lateDays: sql<number>`count(*)::int`,
      totalLateMin: sql<number>`coalesce(sum(${employeeAttendanceTable.lateMinutes}),0)::int`,
    }).from(employeeAttendanceTable)
      .leftJoin(employeesTable, and(
        eq(employeeAttendanceTable.employeeId, employeesTable.id),
        eq(employeesTable.companyId, cid),
      ))
      .where(and(
        eq(employeeAttendanceTable.companyId, cid),
        gte(employeeAttendanceTable.date, weekAgoStr),
        sql`${employeeAttendanceTable.lateMinutes} > 0`,
      ))
      .groupBy(employeeAttendanceTable.employeeId, employeesTable.nameAr, employeesTable.code)
      .orderBy(desc(sql`coalesce(sum(${employeeAttendanceTable.lateMinutes}),0)`))
      .limit(5);

    // hour heatmap (recognitions count by hour of day, last 7d)
    const heatmap = await db.select({
      hour: sql<number>`extract(hour from ${faceRecognitionLogsTable.createdAt})::int`,
      cnt: sql<number>`count(*)::int`,
    }).from(faceRecognitionLogsTable)
      .where(and(
        eq(faceRecognitionLogsTable.companyId, cid),
        eq(faceRecognitionLogsTable.status, "ok"),
        gte(faceRecognitionLogsTable.createdAt, weekAgo),
      ))
      .groupBy(sql`extract(hour from ${faceRecognitionLogsTable.createdAt})`)
      .orderBy(sql`extract(hour from ${faceRecognitionLogsTable.createdAt})`);

    const presenceRate = totalEmployees > 0 ? todayPresent / totalEmployees : 0;
    const enrollmentRate = totalEmployees > 0 ? enrolledEmployees / totalEmployees : 0;

    res.json({
      totalEmployees,
      enrolledEmployees,
      enrollmentRate,
      camerasCount,
      todayPresent,
      todayLate,
      presenceRate,
      weekRecognitions,
      weekSpoofs,
      topLate,
      heatmap,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── KIOSK DEVICE PAIRING ────────────────────────────────────────────────
// A "kiosk token" is a long random string that lets a tablet at the office
// entrance call the face-attendance endpoints WITHOUT a regular user
// session. The plaintext is shown once at creation time and never stored
// (we keep only its sha256 in the DB). The admin pairs a device by opening
// `/hr/face/kiosk?pair=<token>` on it; the page then stores the token
// locally and uses it for every subsequent call.

function randomKioskToken(): string {
  // 32 bytes = 256 bits of entropy. base64url is URL-safe for the
  // ?pair=<token> handoff so the admin can copy/paste it into the tablet.
  return crypto.randomBytes(32).toString("base64url");
}

// GET /api/hr/face/kiosk-tokens — list paired devices for the company.
router.get("/kiosk-tokens", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const rows = await db
      .select({
        id:              kioskTokensTable.id,
        label:           kioskTokensTable.label,
        scope:           kioskTokensTable.scope,
        createdAt:       kioskTokensTable.createdAt,
        lastUsedAt:      kioskTokensTable.lastUsedAt,
        lastUsedIp:      kioskTokensTable.lastUsedIp,
        revokedAt:       kioskTokensTable.revokedAt,
        createdByUserId: kioskTokensTable.createdByUserId,
        createdByName:   usersTable.username,
      })
      .from(kioskTokensTable)
      .leftJoin(usersTable, eq(usersTable.id, kioskTokensTable.createdByUserId))
      .where(eq(kioskTokensTable.companyId, cid))
      .orderBy(desc(kioskTokensTable.createdAt))
      .limit(200);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/hr/face/kiosk-tokens — create a new pairing token.
// Body: { label: string }. Returns { id, label, token, pairUrl } where
// `token` is the plaintext (shown ONCE). The pairUrl is a deep-link the
// admin can open on the kiosk device to auto-pair it.
router.post("/kiosk-tokens", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const label = String(req.body?.label ?? "").trim().slice(0, 80);
    if (!label) {
      res.status(400).json({ error: "أدخل اسماً للجهاز (مثال: تابلت المدخل الرئيسي)" });
      return;
    }

    // Cap on simultaneously-active kiosks per company — protects against
    // runaway token creation. 50 is well above any realistic deployment.
    const [{ active }] = await db
      .select({ active: sql<number>`count(*)::int` })
      .from(kioskTokensTable)
      .where(and(eq(kioskTokensTable.companyId, cid), isNull(kioskTokensTable.revokedAt)));
    if (active >= 50) {
      res.status(400).json({ error: "تم الوصول للحد الأقصى لعدد أجهزة الكشك (50). ألغِ ربط الأجهزة غير المستخدمة أولاً." });
      return;
    }

    const plain = randomKioskToken();
    const tokenHash = hashKioskToken(plain);
    const [row] = await db
      .insert(kioskTokensTable)
      .values({
        companyId:       cid,
        label,
        tokenHash,
        scope:           "face_attendance",
        createdByUserId: req.authUser?.id ?? null,
      })
      .returning({
        id:        kioskTokensTable.id,
        label:     kioskTokensTable.label,
        scope:     kioskTokensTable.scope,
        createdAt: kioskTokensTable.createdAt,
      });

    // Pair URL — the SPA reads ?pair=<token> on /hr/face/kiosk and stores
    // it in localStorage. We use a relative path so it works on any domain
    // (dev preview, staging, production custom domain, etc.).
    const pairUrl = `/hr/face/kiosk?pair=${encodeURIComponent(plain)}`;
    res.json({ ...row, token: plain, pairUrl });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/hr/face/kiosk-tokens/:id — revoke a paired device.
router.delete("/kiosk-tokens/:id", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const result = await db
      .update(kioskTokensTable)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(kioskTokensTable.id, id),
        eq(kioskTokensTable.companyId, cid),
        isNull(kioskTokensTable.revokedAt),
      ))
      .returning({ id: kioskTokensTable.id });
    if (result.length === 0) { res.status(404).json({ error: "الجهاز غير موجود أو سبق إلغاؤه" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/hr/face/kiosk/me — used by the kiosk page on boot to confirm
// its token is still valid and to discover its company name. Returns 401
// when there's no valid kiosk token; otherwise minimal context.
router.get("/kiosk/me", async (req, res) => {
  try {
    if (!req.isKiosk || !req.kioskTokenId) {
      res.status(401).json({ error: "هذا الجهاز غير مرتبط" });
      return;
    }
    const [row] = await db
      .select({
        id:        kioskTokensTable.id,
        label:     kioskTokensTable.label,
        companyId: kioskTokensTable.companyId,
      })
      .from(kioskTokensTable)
      .where(eq(kioskTokensTable.id, req.kioskTokenId))
      .limit(1);
    if (!row) { res.status(401).json({ error: "غير صالح" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
