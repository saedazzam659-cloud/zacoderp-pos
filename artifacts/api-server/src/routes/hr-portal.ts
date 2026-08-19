/**
 * ZacodeHR employee self-service portal API (بوابة الموظف).
 *
 * Mounted at /api/hr-portal. This is a SEPARATE auth realm from users:
 * employees sign in with company code + login_username + password
 * (credentials live on the employees row; seats capped by
 * subscriptions.max_hr_users). Tokens are stateless HMAC tokens signed with
 * SESSION_SECRET — kind "hr_portal", claims { employeeId, companyId, exp }.
 *
 * No HR engine duplication: punches insert into attendance_movements
 * (source "mobile") and reuse attendance-plus recalcDay; permissions/leaves
 * are created as PENDING rows that HR approves from the existing screens.
 */
import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import {
  employeesTable, companiesTable, subscriptionsTable,
  employeeAttendanceTable, attendanceMovementsTable,
  exitPermissionsTable, employeeLeavesTable,
  payrollRunsTable, payrollLinesTable,
  employeeFaceEnrollmentsTable,
} from "@workspace/db";
// Face logic reused from the admin face-attendance module — single source of
// truth for descriptors/matching/settings (no duplication).
import { getFaceSettings, parseDescriptor, euclidean } from "./faceAttendance.js";
import { and, eq, desc, asc, gte, lte, sql } from "drizzle-orm";
import { requireDate, timeOrNull, oneOf, respondHrError, HrValidationError } from "../lib/hrValidate.js";
import { assertDayOpen, assertPeriodNotTransferred } from "../lib/attendanceLocks.js";
import { recalcDay } from "./attendance-plus.js";

const router = Router();

// ── Stateless portal token (HMAC-SHA256, SESSION_SECRET) ────────────────────
const SECRET = process.env.SESSION_SECRET || "";
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function signToken(employeeId: number, companyId: number): string {
  if (!SECRET) throw new Error("SESSION_SECRET غير مضبوط");
  const payload = Buffer.from(JSON.stringify({
    k: "hr_portal", e: employeeId, c: companyId, x: Date.now() + TOKEN_TTL_MS,
  })).toString("base64url");
  const mac = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function verifyToken(token: string): { employeeId: number; companyId: number } | null {
  if (!SECRET) return null; // fail closed — never verify HMACs with an empty key
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot), mac = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (p?.k !== "hr_portal" || !Number(p.e) || !Number(p.c)) return null;
    if (!Number.isFinite(p.x) || Date.now() > p.x) return null;
    return { employeeId: Number(p.e), companyId: Number(p.c) };
  } catch { return null; }
}

type PortalCtx = { employee: any; companyId: number };

async function portalAuth(req: any, res: any): Promise<PortalCtx | null> {
  const h = String(req.headers.authorization ?? "");
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const claims = token ? verifyToken(token) : null;
  if (!claims) { res.status(401).json({ error: "غير مصرح — سجّل الدخول من جديد" }); return null; }
  const [emp] = await db.select().from(employeesTable)
    .where(and(eq(employeesTable.id, claims.employeeId), eq(employeesTable.companyId, claims.companyId)));
  if (!emp || !emp.loginUsername || emp.portalActive === false || emp.status !== "active") {
    res.status(401).json({ error: "تم إيقاف الوصول للبوابة — تواصل مع إدارة الموارد البشرية" });
    return null;
  }
  return { employee: emp, companyId: claims.companyId };
}

const empPublic = (e: any) => ({
  id: e.id, code: e.code, nameAr: e.nameAr, nameEn: e.nameEn,
  jobTitle: e.jobTitle, department: e.department, photoUrl: e.photoUrl,
});

// ── Login rate limiting (in-memory; per IP and per company+username) ────────
const loginFails = new Map<string, { n: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
function loginBlocked(key: string): boolean {
  const e = loginFails.get(key);
  if (!e || Date.now() > e.resetAt) return false;
  return e.n >= LOGIN_MAX_FAILS;
}
function noteLoginFail(key: string) {
  const e = loginFails.get(key);
  if (!e || Date.now() > e.resetAt) loginFails.set(key, { n: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else e.n += 1;
  if (loginFails.size > 10000) {
    for (const [k, v] of loginFails) if (Date.now() > v.resetAt) loginFails.delete(k);
  }
}

// ── POST /login ──────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const companyCode = String(req.body?.companyCode ?? "").trim().toUpperCase();
    const username = String(req.body?.username ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    if (!companyCode || !username || !password) {
      res.status(400).json({ error: "كود الشركة واسم المستخدم وكلمة المرور مطلوبة" }); return;
    }
    if (!SECRET) { res.status(500).json({ error: "إعداد الخادم غير مكتمل" }); return; }
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim();
    const ipKey = `ip:${ip}`, userKey = `u:${companyCode}:${username}`;
    if (loginBlocked(ipKey) || loginBlocked(userKey)) {
      res.status(429).json({ error: "محاولات كثيرة — انتظر 10 دقائق ثم أعد المحاولة" }); return;
    }
    const fail = () => { noteLoginFail(ipKey); noteLoginFail(userKey); res.status(401).json({ error: "بيانات الدخول غير صحيحة" }); };
    const [company] = await db.select({ id: companiesTable.id, nameAr: companiesTable.nameAr, code: companiesTable.code })
      .from(companiesTable).where(sql`upper(${companiesTable.code}) = ${companyCode}`);
    if (!company) return fail();
    const [emp] = await db.select().from(employeesTable)
      .where(and(eq(employeesTable.companyId, company.id), sql`lower(${employeesTable.loginUsername}) = ${username}`));
    if (!emp || !emp.loginPasswordHash) return fail();
    if (!(await bcrypt.compare(password, emp.loginPasswordHash))) return fail();
    if (emp.portalActive === false || emp.status !== "active") {
      res.status(403).json({ error: "تم إيقاف الوصول للبوابة — تواصل مع إدارة الموارد البشرية" }); return;
    }
    res.json({
      token: signToken(emp.id, company.id),
      employee: empPublic(emp),
      company: { nameAr: company.nameAr, code: company.code },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GET /me — dashboard header data ─────────────────────────────────────────
router.get("/me", async (req, res) => {
  try {
    const ctx = await portalAuth(req, res); if (!ctx) return;
    const { employee: emp, companyId: cid } = ctx;
    const [company] = await db.select({ nameAr: companiesTable.nameAr, code: companiesTable.code })
      .from(companiesTable).where(eq(companiesTable.id, cid));
    // Same local-date convention as /punch — toISOString() is UTC and shifts
    // the calendar date around midnight, desyncing "today" from the punch row.
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    const today = local.toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + "01";
    const [todayRow] = await db.select().from(employeeAttendanceTable)
      .where(and(eq(employeeAttendanceTable.companyId, cid), eq(employeeAttendanceTable.employeeId, emp.id), eq(employeeAttendanceTable.date, today)));
    const monthRows = await db.select({ status: employeeAttendanceTable.status, late: employeeAttendanceTable.lateMinutes })
      .from(employeeAttendanceTable)
      .where(and(
        eq(employeeAttendanceTable.companyId, cid), eq(employeeAttendanceTable.employeeId, emp.id),
        gte(employeeAttendanceTable.date, monthStart), lte(employeeAttendanceTable.date, today),
      ));
    const [pendPerm] = await db.select({ c: sql<number>`count(*)::int` }).from(exitPermissionsTable)
      .where(and(eq(exitPermissionsTable.companyId, cid), eq(exitPermissionsTable.employeeId, emp.id), eq(exitPermissionsTable.status, "pending")));
    const [pendLeave] = await db.select({ c: sql<number>`count(*)::int` }).from(employeeLeavesTable)
      .where(and(eq(employeeLeavesTable.companyId, cid), eq(employeeLeavesTable.employeeId, emp.id), eq(employeeLeavesTable.status, "pending")));
    const faceSettings = await getFaceSettings(cid);
    res.json({
      employee: empPublic(emp),
      company: company ?? null,
      shift: {
        start: (faceSettings as any).workdayStart ?? "08:00",
        end: (faceSettings as any).workdayEnd ?? "17:00",
      },
      // Geofence info for the live in/out-of-range indicator (null = no
      // work location pinned → punch allowed anywhere).
      work: emp.workLat != null && emp.workLng != null
        ? { lat: Number(emp.workLat), lng: Number(emp.workLng), radiusM: emp.workRadiusM ?? 200 }
        : null,
      today: {
        date: today,
        checkIn: todayRow?.checkIn ?? null,
        checkOut: todayRow?.checkOut ?? null,
        status: todayRow?.status ?? null,
      },
      month: {
        presentDays: monthRows.filter((r) => ["present", "late"].includes(String(r.status))).length,
        absentDays: monthRows.filter((r) => r.status === "absent").length,
        lateCount: monthRows.filter((r) => (r.late ?? 0) > 0).length,
        pendingRequests: (pendPerm?.c ?? 0) + (pendLeave?.c ?? 0),
      },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── POST /punch — GPS punch in/out ──────────────────────────────────────────
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Face (بصمة الوجه) ────────────────────────────────────────────────────────
// Rebuild a data URL server-side from raw base64 + mime. The prod edge WAF
// blocks request bodies containing `data:<mime>;base64,` — clients must send
// the two parts separately.
const SELFIE_MAX_B64 = 300_000; // ~220KB image
function selfieDataUrl(b64: unknown, mime: unknown): string | null {
  const b = typeof b64 === "string" ? b64.trim() : "";
  const m = typeof mime === "string" ? mime.trim().toLowerCase() : "";
  if (!b || !m) return null;
  if (b.length > SELFIE_MAX_B64) throw new HrValidationError("الصورة كبيرة جداً");
  if (!/^image\/(jpeg|png|webp)$/.test(m)) throw new HrValidationError("نوع الصورة غير مدعوم");
  if (!/^[A-Za-z0-9+/=]+$/.test(b)) throw new HrValidationError("صورة غير صالحة");
  return `data:${m};base64,${b}`;
}

function descriptorOrNull(v: unknown): number[] | null {
  return Array.isArray(v) && v.length === 128 && v.every((x) => typeof x === "number" && Number.isFinite(x))
    ? (v as number[]) : null;
}

async function loadEnrollments(cid: number, employeeId: number) {
  return db.select({
    id: employeeFaceEnrollmentsTable.id,
    descriptorJson: employeeFaceEnrollmentsTable.descriptorJson,
  }).from(employeeFaceEnrollmentsTable)
    .where(and(eq(employeeFaceEnrollmentsTable.companyId, cid), eq(employeeFaceEnrollmentsTable.employeeId, employeeId)));
}

// GET /face/status — is this employee enrolled + what the client must enforce
router.get("/face/status", async (req, res) => {
  try {
    const ctx = await portalAuth(req, res); if (!ctx) return;
    const settings = await getFaceSettings(ctx.companyId);
    const enrollments = await loadEnrollments(ctx.companyId, ctx.employee.id);
    res.json({
      enrolled: enrollments.length > 0,
      required: !!(settings as any).portalFaceRequired,
      requireLiveness: !!settings.requireLiveness,
      minQuality: Number(settings.minQualityScore ?? "0.5"),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /face/enroll — first-time self-enrollment from the portal camera.
// Allowed ONLY while the employee has no enrollment yet; re-enrollment is an
// HR/admin action from the web screen (prevents an employee swapping faces).
router.post("/face/enroll", async (req, res) => {
  try {
    const ctx = await portalAuth(req, res); if (!ctx) return;
    const { employee: emp, companyId: cid } = ctx;
    const b = req.body ?? {};
    const descriptor = descriptorOrNull(b.descriptor);
    if (!descriptor) { res.status(400).json({ error: "بصمة الوجه غير صالحة — أعد المحاولة" }); return; }
    const settings = await getFaceSettings(cid);
    const q = Number(b.qualityScore ?? 0);
    const minQ = Number(settings.minQualityScore ?? "0.5");
    if (!Number.isFinite(q) || q < minQ) { res.status(400).json({ error: "جودة الصورة منخفضة — حاول في إضاءة أفضل" }); return; }
    if (settings.requireLiveness && !b.livenessPassed) { res.status(400).json({ error: "فشل اختبار الكشف الحي — ارمش بعينيك أمام الكاميرا" }); return; }
    const imageUrl = selfieDataUrl(b.imageB64, b.imageMime);
    if (!imageUrl) { res.status(400).json({ error: "الصورة مطلوبة للتسجيل — أعد الالتقاط" }); return; }
    // Atomic "only while un-enrolled": advisory lock closes the race where two
    // concurrent requests both pass the emptiness check. (No unique index —
    // HR-side enrollment legitimately stores multiple poses per employee.)
    const conflict = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`face-enroll:${cid}:${emp.id}`}))`);
      const [{ c }] = await tx.select({ c: sql<number>`count(*)::int` }).from(employeeFaceEnrollmentsTable)
        .where(and(eq(employeeFaceEnrollmentsTable.companyId, cid), eq(employeeFaceEnrollmentsTable.employeeId, emp.id)));
      if (c > 0) return true;
      await tx.insert(employeeFaceEnrollmentsTable).values({
        companyId: cid, employeeId: emp.id,
        descriptorJson: JSON.stringify(descriptor),
        qualityScore: String(q),
        pose: "frontal",
        livenessPassed: !!b.livenessPassed,
        imageUrl,
        isPrimary: true,
      });
      return false;
    });
    if (conflict) { res.status(409).json({ error: "وجهك مسجّل بالفعل — التعديل يتم عن طريق إدارة الموارد البشرية" }); return; }
    if (!emp.photoUrl && imageUrl) {
      await db.update(employeesTable).set({ photoUrl: imageUrl })
        .where(and(eq(employeesTable.id, emp.id), eq(employeesTable.companyId, cid)));
    }
    res.status(201).json({ ok: true });
  } catch (e: any) { respondHrError(req, res, e); }
});

router.post("/punch", async (req, res) => {
  try {
    const ctx = await portalAuth(req, res); if (!ctx) return;
    const { employee: emp, companyId: cid } = ctx;
    const type = oneOf(req.body?.type, ["in", "out"], "", "نوع الحركة");
    const lat = Number(req.body?.lat), lng = Number(req.body?.lng);
    const hasGps = Number.isFinite(lat) && Number.isFinite(lng)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

    // Geofence: employees with workLat/workLng MUST punch inside the radius.
    let gpsStatus: "ok" | "out_of_range" | "no_gps" = "no_gps";
    if (emp.workLat != null && emp.workLng != null) {
      if (!hasGps) { res.status(400).json({ error: "يجب تفعيل خدمة الموقع (GPS) لتسجيل الحضور" }); return; }
      const dist = distanceMeters(lat, lng, Number(emp.workLat), Number(emp.workLng));
      const radius = emp.workRadiusM ?? 200;
      if (dist > radius) {
        res.status(400).json({ error: `أنت خارج نطاق موقع العمل (البعد ${Math.round(dist)} متر، المسموح ${radius} متر)` });
        return;
      }
      gpsStatus = "ok";
    } else if (hasGps) {
      gpsStatus = "ok";
    }

    // Face verification: enrolled employees ALWAYS verify; un-enrolled ones are
    // blocked only when the company turned portalFaceRequired on.
    const settings = await getFaceSettings(cid);
    const enrollments = await loadEnrollments(cid, emp.id);
    let faceVerified: boolean | null = null;
    let selfieUrl: string | null = null;
    if (enrollments.length > 0) {
      const descriptor = descriptorOrNull(req.body?.descriptor);
      if (!descriptor) { res.status(400).json({ error: "التحقق بالوجه مطلوب — افتح الكاميرا وأعد المحاولة" }); return; }
      if (settings.requireLiveness && !req.body?.livenessPassed) {
        res.status(400).json({ error: "فشل اختبار الكشف الحي — ارمش بعينيك أمام الكاميرا" }); return;
      }
      const threshold = Number(settings.matchThreshold ?? "0.6");
      let best = Infinity;
      for (const e of enrollments) {
        const arr = parseDescriptor(e.descriptorJson);
        if (arr) best = Math.min(best, euclidean(descriptor, arr));
      }
      if (!(best <= threshold)) {
        res.status(400).json({ error: "الوجه غير مطابق للوجه المسجّل — أعد المحاولة" }); return;
      }
      selfieUrl = selfieDataUrl(req.body?.imageB64, req.body?.imageMime);
      if (!selfieUrl) { res.status(400).json({ error: "الصورة الحية مطلوبة — أعد المحاولة" }); return; }
      faceVerified = true;
    } else if ((settings as any).portalFaceRequired) {
      res.status(428).json({ error: "يجب تسجيل وجهك أولاً قبل تسجيل الحضور", code: "FACE_ENROLL_REQUIRED" });
      return;
    }

    // Local date + local time from the SAME instant — toISOString() is UTC and
    // records a punch around midnight under the wrong attendance date.
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    const date = local.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 5);
    await assertDayOpen(cid, date);
    await assertPeriodNotTransferred(cid, date);

    const location = hasGps ? `${lat.toFixed(6)},${lng.toFixed(6)}` : null;
    const r = await db.insert(attendanceMovementsTable).values({
      companyId: cid, employeeId: emp.id, date, time, type,
      source: "mobile", location, selfieUrl, faceVerified,
    }).onConflictDoNothing({
      target: [attendanceMovementsTable.employeeId, attendanceMovementsTable.date, attendanceMovementsTable.time, attendanceMovementsTable.type],
    }).returning({ id: attendanceMovementsTable.id });
    if (r.length) await recalcDay(cid, date, [emp.id]);
    res.json({ ok: true, time, gpsStatus });
  } catch (e: any) { respondHrError(req, res, e); }
});

// ── GET /attendance?year&month ───────────────────────────────────────────────
router.get("/attendance", async (req, res) => {
  try {
    const ctx = await portalAuth(req, res); if (!ctx) return;
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = Number(req.query.month) || now.getMonth() + 1;
    if (year < 2000 || year > 2100 || month < 1 || month > 12) {
      res.status(400).json({ error: "شهر أو سنة غير صالحة" }); return;
    }
    const from = `${year}-${String(month).padStart(2, "0")}-01`;
    const to = `${year}-${String(month).padStart(2, "0")}-31`;
    const rows = await db.select().from(employeeAttendanceTable)
      .where(and(
        eq(employeeAttendanceTable.companyId, ctx.companyId),
        eq(employeeAttendanceTable.employeeId, ctx.employee.id),
        gte(employeeAttendanceTable.date, from), lte(employeeAttendanceTable.date, to),
      )).orderBy(desc(employeeAttendanceTable.date));
    res.json({
      rows: rows.map((r) => ({
        date: r.date, checkIn: r.checkIn, checkOut: r.checkOut, status: r.status,
        lateMinutes: r.lateMinutes ?? 0, workedHours: r.workedHours ?? "0",
      })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GET /movements?year&month — raw punches with selfie + GPS evidence ──────
router.get("/movements", async (req, res) => {
  try {
    const ctx = await portalAuth(req, res); if (!ctx) return;
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = Number(req.query.month) || now.getMonth() + 1;
    if (year < 2000 || year > 2100 || month < 1 || month > 12) {
      res.status(400).json({ error: "شهر أو سنة غير صالحة" }); return;
    }
    const from = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    const rows = await db.select({
      id: attendanceMovementsTable.id,
      date: attendanceMovementsTable.date,
      time: attendanceMovementsTable.time,
      type: attendanceMovementsTable.type,
      location: attendanceMovementsTable.location,
      selfieUrl: attendanceMovementsTable.selfieUrl,
      faceVerified: attendanceMovementsTable.faceVerified,
    }).from(attendanceMovementsTable)
      .where(and(
        eq(attendanceMovementsTable.companyId, ctx.companyId),
        eq(attendanceMovementsTable.employeeId, ctx.employee.id),
        gte(attendanceMovementsTable.date, from), lte(attendanceMovementsTable.date, to),
      ))
      .orderBy(desc(attendanceMovementsTable.date), attendanceMovementsTable.time)
      .limit(200);
    res.json({ rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Permissions (استئذان) ────────────────────────────────────────────────────
router.get("/permissions", async (req, res) => {
  try {
    const ctx = await portalAuth(req, res); if (!ctx) return;
    const rows = await db.select().from(exitPermissionsTable)
      .where(and(eq(exitPermissionsTable.companyId, ctx.companyId), eq(exitPermissionsTable.employeeId, ctx.employee.id)))
      .orderBy(desc(exitPermissionsTable.date), desc(exitPermissionsTable.id))
      .limit(100);
    res.json({
      rows: rows.map((p) => ({
        id: p.id, permissionDate: p.date, startTime: p.startTime, endTime: p.endTime,
        minutes: p.minutes, permissionType: p.permissionType, reason: p.reason, status: p.status,
      })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/permissions", async (req, res) => {
  try {
    const ctx = await portalAuth(req, res); if (!ctx) return;
    const b = req.body ?? {};
    const date = requireDate(b.permissionDate, "تاريخ الاستئذان");
    const startTime = timeOrNull(b.startTime, "وقت البداية");
    const endTime = timeOrNull(b.endTime, "وقت النهاية");
    if (!startTime || !endTime) throw new HrValidationError("وقت البداية والنهاية مطلوبان");
    if (endTime <= startTime) throw new HrValidationError("وقت النهاية يجب أن يكون بعد وقت البداية");
    const permissionType = oneOf(b.permissionType, ["personal", "official", "medical", "other"], "personal", "نوع الاستئذان");
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    const minutes = (eh * 60 + em) - (sh * 60 + sm);
    await assertDayOpen(ctx.companyId, date);
    await assertPeriodNotTransferred(ctx.companyId, date);
    const [row] = await db.insert(exitPermissionsTable).values({
      companyId: ctx.companyId, employeeId: ctx.employee.id,
      date, startTime, endTime, minutes, permissionType,
      reason: String(b.reason ?? "").trim() || null,
      status: "pending",
    }).returning();
    res.status(201).json({
      id: row.id, permissionDate: row.date, startTime: row.startTime, endTime: row.endTime,
      minutes: row.minutes, permissionType: row.permissionType, reason: row.reason, status: row.status,
    });
  } catch (e: any) { respondHrError(req, res, e); }
});

// ── Leaves (إجازات) ──────────────────────────────────────────────────────────
router.get("/leaves", async (req, res) => {
  try {
    const ctx = await portalAuth(req, res); if (!ctx) return;
    const rows = await db.select().from(employeeLeavesTable)
      .where(and(eq(employeeLeavesTable.companyId, ctx.companyId), eq(employeeLeavesTable.employeeId, ctx.employee.id)))
      .orderBy(desc(employeeLeavesTable.startDate), desc(employeeLeavesTable.id))
      .limit(100);
    res.json({
      rows: rows.map((l) => ({
        id: l.id, leaveType: l.leaveType, startDate: l.startDate, endDate: l.endDate,
        days: l.days, reason: l.reason, status: l.status,
      })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/leaves", async (req, res) => {
  try {
    const ctx = await portalAuth(req, res); if (!ctx) return;
    const b = req.body ?? {};
    const startDate = requireDate(b.startDate, "تاريخ البداية");
    const endDate = requireDate(b.endDate, "تاريخ النهاية");
    if (endDate < startDate) throw new HrValidationError("تاريخ النهاية يجب ألا يسبق تاريخ البداية");
    const leaveType = oneOf(b.leaveType, ["annual", "sick", "unpaid", "other"], "annual", "نوع الإجازة");
    const days = Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1;
    const [row] = await db.insert(employeeLeavesTable).values({
      companyId: ctx.companyId, employeeId: ctx.employee.id,
      leaveType, startDate, endDate, days,
      paid: leaveType !== "unpaid",
      reason: String(b.reason ?? "").trim() || null,
      status: "pending",
    }).returning();
    res.status(201).json({
      id: row.id, leaveType: row.leaveType, startDate: row.startDate, endDate: row.endDate,
      days: row.days, reason: row.reason, status: row.status,
    });
  } catch (e: any) { respondHrError(req, res, e); }
});

// ── Payslips ─────────────────────────────────────────────────────────────────
router.get("/payslips", async (req, res) => {
  try {
    const ctx = await portalAuth(req, res); if (!ctx) return;
    const rows = await db.select({
      id: payrollLinesTable.id,
      year: payrollRunsTable.year,
      month: payrollRunsTable.month,
      grossSalary: payrollLinesTable.grossSalary,
      totalDeductions: payrollLinesTable.totalDeductions,
      netSalary: payrollLinesTable.netSalary,
      status: payrollRunsTable.status,
    }).from(payrollLinesTable)
      .innerJoin(payrollRunsTable, eq(payrollLinesTable.payrollRunId, payrollRunsTable.id))
      .where(and(
        eq(payrollRunsTable.companyId, ctx.companyId),
        eq(payrollLinesTable.employeeId, ctx.employee.id),
        sql`${payrollRunsTable.status} <> 'draft'`,
      ))
      .orderBy(desc(payrollRunsTable.year), desc(payrollRunsTable.month))
      .limit(36);
    res.json({ rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
