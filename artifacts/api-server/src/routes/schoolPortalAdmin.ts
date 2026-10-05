import { Router } from "express";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  attendanceCamerasTable,
  db,
  schoolAcademicYearsTable,
  schoolAttendanceTable,
  schoolBiometricConsentEventsTable,
  schoolClassesTable,
  schoolEnrollmentsTable,
  schoolExamResultsTable,
  schoolExamsTable,
  schoolFeesTable,
  schoolGradesTable,
  schoolGuardianPortalAccountsTable,
  schoolGuardianPortalLinksTable,
  schoolStudentAttendanceEventsTable,
  schoolStudentBiometricConsentsTable,
  schoolStudentFaceTemplatesTable,
  schoolStudentGuardiansTable,
  schoolStudentsTable,
  schoolSubjectsTable,
} from "@workspace/db";
import { resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { decryptSecret, encryptSecret } from "../lib/encryption.js";
import { ensureSchoolPortalSchema, lockStudentBiometrics } from "../lib/schoolPortalSchema.js";
import { euclidean, getFaceSettings, parseDescriptor } from "./faceAttendance.js";

const router = Router();
const POLICY_VERSION = "school-face-v1";
const MIN_BETWEEN_FACE_EVENTS_MS = 30 * 60 * 1000;

router.use(async (_req, res, next) => {
  try {
    await ensureSchoolPortalSchema();
    next();
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "School portal schema is unavailable" });
  }
});

function companyIdFor(req: any): number | null {
  const raw = String(req.query?.companyId ?? "").trim();
  const requestedId = raw ? Number(raw) : undefined;
  if (requestedId !== undefined && (!Number.isInteger(requestedId) || requestedId < 1)) return null;
  const id = resolveCompanyId(req, requestedId);
  return Number.isInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
}

function numberId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeGuardianIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) return null;
  const ids = value.map(numberId);
  if (ids.some((id) => id === null)) return null;
  const normalized = ids as number[];
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function validFaceDescriptor(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 128) return null;
  if (!value.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return value as number[];
}

function isUniqueViolation(error: any): boolean {
  return error?.code === "23505" || error?.cause?.code === "23505";
}

async function accountView(companyId: number, accountId: number) {
  const [account] = await db.select({
    id: schoolGuardianPortalAccountsTable.id,
    username: schoolGuardianPortalAccountsTable.username,
    displayName: schoolGuardianPortalAccountsTable.displayName,
    isActive: schoolGuardianPortalAccountsTable.isActive,
    createdAt: schoolGuardianPortalAccountsTable.createdAt,
  }).from(schoolGuardianPortalAccountsTable).where(and(
    eq(schoolGuardianPortalAccountsTable.id, accountId),
    eq(schoolGuardianPortalAccountsTable.companyId, companyId),
  )).limit(1);
  if (!account) return null;
  const guardians = await db.select({
    guardianId: schoolGuardianPortalLinksTable.guardianId,
    studentId: schoolStudentGuardiansTable.studentId,
    studentNameAr: schoolStudentsTable.fullNameAr,
  }).from(schoolGuardianPortalLinksTable)
    .innerJoin(schoolStudentGuardiansTable, and(
      eq(schoolStudentGuardiansTable.id, schoolGuardianPortalLinksTable.guardianId),
      eq(schoolStudentGuardiansTable.companyId, companyId),
    ))
    .innerJoin(schoolStudentsTable, and(
      eq(schoolStudentsTable.id, schoolStudentGuardiansTable.studentId),
      eq(schoolStudentsTable.companyId, companyId),
    ))
    .where(and(
      eq(schoolGuardianPortalLinksTable.companyId, companyId),
      eq(schoolGuardianPortalLinksTable.accountId, accountId),
    )).orderBy(asc(schoolStudentsTable.fullNameAr));
  return {
    ...account,
    createdAt: account.createdAt instanceof Date ? account.createdAt.toISOString() : null,
    guardians,
  };
}

async function validActiveConsentStudentIds(queryDb: any, companyId: number): Promise<Set<number>> {
  const rows = await queryDb.select({
    studentId: schoolStudentBiometricConsentsTable.studentId,
  }).from(schoolStudentBiometricConsentsTable)
    .innerJoin(schoolGuardianPortalAccountsTable, and(
      eq(schoolGuardianPortalAccountsTable.id, schoolStudentBiometricConsentsTable.guardianAccountId),
      eq(schoolGuardianPortalAccountsTable.companyId, companyId),
      eq(schoolGuardianPortalAccountsTable.isActive, true),
    ))
    .innerJoin(schoolGuardianPortalLinksTable, and(
      eq(schoolGuardianPortalLinksTable.accountId, schoolGuardianPortalAccountsTable.id),
      eq(schoolGuardianPortalLinksTable.companyId, companyId),
    ))
    .innerJoin(schoolStudentGuardiansTable, and(
      eq(schoolStudentGuardiansTable.id, schoolGuardianPortalLinksTable.guardianId),
      eq(schoolStudentGuardiansTable.companyId, companyId),
      eq(schoolStudentGuardiansTable.studentId, schoolStudentBiometricConsentsTable.studentId),
    ))
    .where(and(
      eq(schoolStudentBiometricConsentsTable.companyId, companyId),
      eq(schoolStudentBiometricConsentsTable.isActive, true),
    ));
  return new Set(rows.map((row: { studentId: number }) => row.studentId));
}

async function activeConsentIdForStudent(
  queryDb: any,
  companyId: number,
  studentId: number,
) : Promise<number | null> {
  const [row] = await queryDb.select({
    consentId: schoolStudentBiometricConsentsTable.id,
  }).from(schoolStudentBiometricConsentsTable)
    .innerJoin(schoolGuardianPortalAccountsTable, and(
      eq(schoolGuardianPortalAccountsTable.id, schoolStudentBiometricConsentsTable.guardianAccountId),
      eq(schoolGuardianPortalAccountsTable.companyId, companyId),
      eq(schoolGuardianPortalAccountsTable.isActive, true),
    ))
    .innerJoin(schoolGuardianPortalLinksTable, and(
      eq(schoolGuardianPortalLinksTable.accountId, schoolGuardianPortalAccountsTable.id),
      eq(schoolGuardianPortalLinksTable.companyId, companyId),
    ))
    .innerJoin(schoolStudentGuardiansTable, and(
      eq(schoolStudentGuardiansTable.id, schoolGuardianPortalLinksTable.guardianId),
      eq(schoolStudentGuardiansTable.companyId, companyId),
      eq(schoolStudentGuardiansTable.studentId, schoolStudentBiometricConsentsTable.studentId),
    ))
    .where(and(
      eq(schoolStudentBiometricConsentsTable.companyId, companyId),
      eq(schoolStudentBiometricConsentsTable.studentId, studentId),
      eq(schoolStudentBiometricConsentsTable.isActive, true),
    ))
    .orderBy(desc(schoolStudentBiometricConsentsTable.consentedAt))
    .limit(1);
  return row?.consentId ?? null;
}

async function revokeAccountConsents(
  tx: any,
  companyId: number,
  accountId: number,
  studentIds: number[],
  now = new Date(),
) {
  if (studentIds.length === 0) return;
  for (const studentId of [...new Set(studentIds)].sort((a, b) => a - b)) {
    await lockStudentBiometrics(tx, companyId, studentId);
  }
  const activeRows = await tx.select({
    id: schoolStudentBiometricConsentsTable.id,
    studentId: schoolStudentBiometricConsentsTable.studentId,
    policyVersion: schoolStudentBiometricConsentsTable.policyVersion,
  }).from(schoolStudentBiometricConsentsTable).where(and(
    eq(schoolStudentBiometricConsentsTable.companyId, companyId),
    eq(schoolStudentBiometricConsentsTable.guardianAccountId, accountId),
    eq(schoolStudentBiometricConsentsTable.isActive, true),
    inArray(schoolStudentBiometricConsentsTable.studentId, studentIds),
  ));
  if (activeRows.length === 0) return;
  await tx.update(schoolStudentBiometricConsentsTable).set({
    isActive: false,
    revokedAt: now,
    updatedAt: now,
  }).where(inArray(
    schoolStudentBiometricConsentsTable.id,
    activeRows.map((row: any) => row.id),
  ));
  await tx.insert(schoolBiometricConsentEventsTable).values(activeRows.map((row: any) => ({
    companyId,
    studentId: row.studentId,
    guardianAccountId: accountId,
    action: "revoked",
    policyVersion: row.policyVersion,
    occurredAt: now,
  })));
  const affected: number[] = Array.from(new Set<number>(
    activeRows.map((row: any) => Number(row.studentId)),
  ));
  const stillConsented = await validActiveConsentStudentIds(tx, companyId);
  const studentsWithoutConsent: number[] = affected.filter((id: number) => !stillConsented.has(id));
  if (studentsWithoutConsent.length > 0) {
    await tx.delete(schoolStudentFaceTemplatesTable).where(and(
      eq(schoolStudentFaceTemplatesTable.companyId, companyId),
      inArray(schoolStudentFaceTemplatesTable.studentId, studentsWithoutConsent),
    ));
  }
}

async function validateGuardianIds(
  companyId: number,
  guardianIds: number[],
  exceptAccountId?: number,
) {
  const guardians = await db.select({
    id: schoolStudentGuardiansTable.id,
  }).from(schoolStudentGuardiansTable).where(and(
    eq(schoolStudentGuardiansTable.companyId, companyId),
    inArray(schoolStudentGuardiansTable.id, guardianIds),
  ));
  if (guardians.length !== guardianIds.length) return "One or more guardian records do not belong to this company";
  const currentLinks = await db.select({
    guardianId: schoolGuardianPortalLinksTable.guardianId,
    accountId: schoolGuardianPortalLinksTable.accountId,
  }).from(schoolGuardianPortalLinksTable)
    .where(inArray(schoolGuardianPortalLinksTable.guardianId, guardianIds));
  if (currentLinks.some((row) => row.accountId !== exceptAccountId)) {
    return "A guardian record is already linked to another portal account";
  }
  return null;
}

router.get("/guardian-accounts", async (req, res) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) { res.status(400).json({ error: "Invalid company" }); return; }
    const accounts = await db.select({ id: schoolGuardianPortalAccountsTable.id })
      .from(schoolGuardianPortalAccountsTable)
      .where(eq(schoolGuardianPortalAccountsTable.companyId, companyId))
      .orderBy(asc(schoolGuardianPortalAccountsTable.displayName));
    const result = await Promise.all(accounts.map((account) => accountView(companyId, account.id)));
    res.json(result.filter(Boolean));
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Could not load guardian accounts" });
  }
});

router.post("/guardian-accounts", requirePermission("school", "create"), async (req, res) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) { res.status(400).json({ error: "Invalid company" }); return; }
    const username = String(req.body?.username ?? "").trim().toLowerCase();
    const displayName = String(req.body?.displayName ?? "").trim();
    const password = String(req.body?.password ?? "");
    const guardianIds = normalizeGuardianIds(req.body?.guardianIds);
    if (!/^[a-z0-9][a-z0-9._-]{2,119}$/.test(username)) {
      res.status(400).json({ error: "Username must be 3–120 lowercase letters, numbers, dots, underscores, or hyphens" }); return;
    }
    if (!displayName || displayName.length > 160 || password.length < 10 || password.length > 200 || !guardianIds) {
      res.status(400).json({ error: "Display name, a password of at least 10 characters, and valid guardian links are required" }); return;
    }
    const linkError = await validateGuardianIds(companyId, guardianIds);
    if (linkError) { res.status(409).json({ error: linkError }); return; }
    const passwordHash = await bcrypt.hash(password, 12);
    const id = await db.transaction(async (tx) => {
      const [account] = await tx.insert(schoolGuardianPortalAccountsTable).values({
        companyId,
        username,
        displayName,
        passwordHash,
        createdById: numberId(req.authUser?.id),
      }).returning({ id: schoolGuardianPortalAccountsTable.id });
      await tx.insert(schoolGuardianPortalLinksTable).values(guardianIds.map((guardianId) => ({
        companyId,
        accountId: account.id,
        guardianId,
      })));
      return account.id;
    });
    res.status(201).json(await accountView(companyId, id));
  } catch (error: any) {
    if (isUniqueViolation(error)) { res.status(409).json({ error: "Username or guardian link is already in use" }); return; }
    res.status(500).json({ error: error?.message ?? "Could not create guardian account" });
  }
});

router.patch("/guardian-accounts/:id", requirePermission("school", "edit"), async (req, res) => {
  try {
    const companyId = companyIdFor(req);
    const accountId = numberId(req.params.id);
    if (!companyId || !accountId) { res.status(400).json({ error: "Invalid company or account" }); return; }
    const [current] = await db.select({
      id: schoolGuardianPortalAccountsTable.id,
      isActive: schoolGuardianPortalAccountsTable.isActive,
    }).from(schoolGuardianPortalAccountsTable).where(and(
      eq(schoolGuardianPortalAccountsTable.id, accountId),
      eq(schoolGuardianPortalAccountsTable.companyId, companyId),
    )).limit(1);
    if (!current) { res.status(404).json({ error: "Guardian account not found" }); return; }
    const body = req.body ?? {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.username !== undefined) {
      const username = String(body.username).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{2,119}$/.test(username)) {
        res.status(400).json({ error: "Invalid username" }); return;
      }
      updates.username = username;
    }
    if (body.displayName !== undefined) {
      const displayName = String(body.displayName).trim();
      if (!displayName || displayName.length > 160) { res.status(400).json({ error: "Invalid display name" }); return; }
      updates.displayName = displayName;
    }
    if (body.password !== undefined) {
      const password = String(body.password);
      if (password.length < 10 || password.length > 200) { res.status(400).json({ error: "Password must be at least 10 characters" }); return; }
      updates.passwordHash = await bcrypt.hash(password, 12);
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") { res.status(400).json({ error: "Invalid active state" }); return; }
      updates.isActive = body.isActive;
    }
    const guardianIds = body.guardianIds === undefined ? undefined : normalizeGuardianIds(body.guardianIds);
    if (body.guardianIds !== undefined && !guardianIds) {
      res.status(400).json({ error: "Invalid guardian links" }); return;
    }
    if (guardianIds) {
      const linkError = await validateGuardianIds(companyId, guardianIds, accountId);
      if (linkError) { res.status(409).json({ error: linkError }); return; }
    }
    if (Object.keys(updates).length === 1 && guardianIds === undefined) {
      res.status(400).json({ error: "No account changes were supplied" }); return;
    }
    const oldLinks = guardianIds
      ? await db.select({ guardianId: schoolGuardianPortalLinksTable.guardianId })
        .from(schoolGuardianPortalLinksTable)
        .where(and(
          eq(schoolGuardianPortalLinksTable.companyId, companyId),
          eq(schoolGuardianPortalLinksTable.accountId, accountId),
        ))
      : [];
    const newIdSet = new Set(guardianIds ?? []);
    const removedGuardianIds = oldLinks.map((row) => row.guardianId).filter((id) => !newIdSet.has(id));
    const removedGuardians = removedGuardianIds.length > 0
      ? await db.select({ studentId: schoolStudentGuardiansTable.studentId })
        .from(schoolStudentGuardiansTable)
        .where(and(
          eq(schoolStudentGuardiansTable.companyId, companyId),
          inArray(schoolStudentGuardiansTable.id, removedGuardianIds),
        ))
      : [];
    const removedStudentIds = [...new Set(removedGuardians.map((row) => row.studentId))];
    await db.transaction(async (tx) => {
      if (Object.keys(updates).length > 1) {
        await tx.update(schoolGuardianPortalAccountsTable).set(updates as any).where(and(
          eq(schoolGuardianPortalAccountsTable.id, accountId),
          eq(schoolGuardianPortalAccountsTable.companyId, companyId),
        ));
      }
      if (guardianIds) {
        await tx.delete(schoolGuardianPortalLinksTable).where(and(
          eq(schoolGuardianPortalLinksTable.companyId, companyId),
          eq(schoolGuardianPortalLinksTable.accountId, accountId),
        ));
        await tx.insert(schoolGuardianPortalLinksTable).values(guardianIds.map((guardianId) => ({
          companyId,
          accountId,
          guardianId,
        })));
        await revokeAccountConsents(tx, companyId, accountId, removedStudentIds);
      }
      if (body.isActive === false && current.isActive) {
        const consentRows = await tx.select({ studentId: schoolStudentBiometricConsentsTable.studentId })
          .from(schoolStudentBiometricConsentsTable)
          .where(and(
            eq(schoolStudentBiometricConsentsTable.companyId, companyId),
            eq(schoolStudentBiometricConsentsTable.guardianAccountId, accountId),
            eq(schoolStudentBiometricConsentsTable.isActive, true),
          ));
        await revokeAccountConsents(tx, companyId, accountId, consentRows.map((row: any) => row.studentId));
      }
    });
    res.json(await accountView(companyId, accountId));
  } catch (error: any) {
    if (isUniqueViolation(error)) { res.status(409).json({ error: "Username or guardian link is already in use" }); return; }
    res.status(500).json({ error: error?.message ?? "Could not update guardian account" });
  }
});

router.get("/face-enrollment-status", async (req, res) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) { res.status(400).json({ error: "Invalid company" }); return; }
    const [students, templates, activeConsentStudents] = await Promise.all([
      db.select({
        studentId: schoolStudentsTable.id,
        studentNumber: schoolStudentsTable.studentNumber,
        fullNameAr: schoolStudentsTable.fullNameAr,
      }).from(schoolStudentsTable)
        .where(eq(schoolStudentsTable.companyId, companyId))
        .orderBy(asc(schoolStudentsTable.fullNameAr)),
      db.select({
        studentId: schoolStudentFaceTemplatesTable.studentId,
        enrolledAt: schoolStudentFaceTemplatesTable.updatedAt,
      }).from(schoolStudentFaceTemplatesTable)
        .where(eq(schoolStudentFaceTemplatesTable.companyId, companyId)),
      validActiveConsentStudentIds(db, companyId),
    ]);
    const templateByStudent = new Map(templates.map((row) => [row.studentId, row.enrolledAt]));
    res.json(students.map((student) => {
      const consentActive = activeConsentStudents.has(student.studentId);
      const enrolledAt = consentActive ? templateByStudent.get(student.studentId) : null;
      return {
        ...student,
        consentActive,
        enrolled: !!enrolledAt,
        enrolledAt: enrolledAt instanceof Date ? enrolledAt.toISOString() : null,
      };
    }));
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Could not load face-enrollment status" });
  }
});

router.post("/students/:studentId/face-enrollment", requirePermission("school", "edit"), async (req, res) => {
  try {
    const companyId = companyIdFor(req);
    const studentId = numberId(req.params.studentId);
    const descriptor = validFaceDescriptor(req.body?.descriptor);
    const qualityScore = Number(req.body?.qualityScore);
    if (!companyId || !studentId) { res.status(400).json({ error: "Invalid company or student" }); return; }
    if (!descriptor || !Number.isFinite(qualityScore) || qualityScore < 0 || qualityScore > 1) {
      res.status(400).json({ error: "Invalid face descriptor or quality score" }); return;
    }
    const [student] = await db.select({ id: schoolStudentsTable.id })
      .from(schoolStudentsTable).where(and(
        eq(schoolStudentsTable.id, studentId),
        eq(schoolStudentsTable.companyId, companyId),
      )).limit(1);
    if (!student) { res.status(404).json({ error: "Student not found" }); return; }
    const settings = await getFaceSettings(companyId);
    const minQuality = Number(settings.minQualityScore ?? "0.5");
    if (qualityScore < minQuality) {
      res.status(400).json({ error: `Image quality is too low (${qualityScore.toFixed(2)} < ${minQuality})` }); return;
    }
    if (settings.requireLiveness && req.body?.livenessPassed !== true) {
      res.status(400).json({ error: "A successful liveness check is required" }); return;
    }
    const now = new Date();
    const encryptedDescriptor = encryptSecret(JSON.stringify(descriptor));
    const template = await db.transaction(async (tx) => {
      await lockStudentBiometrics(tx, companyId, studentId);
      const consentId = await activeConsentIdForStudent(tx, companyId, studentId);
      if (!consentId) return null;
      const [saved] = await tx.insert(schoolStudentFaceTemplatesTable).values({
        companyId,
        studentId,
        consentId,
        descriptorCiphertext: encryptedDescriptor,
        qualityScore: String(qualityScore),
        enrolledById: numberId(req.authUser?.id),
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [schoolStudentFaceTemplatesTable.companyId, schoolStudentFaceTemplatesTable.studentId],
        set: {
          consentId,
          descriptorCiphertext: encryptedDescriptor,
          qualityScore: String(qualityScore),
          enrolledById: numberId(req.authUser?.id),
          updatedAt: now,
        },
      }).returning({ updatedAt: schoolStudentFaceTemplatesTable.updatedAt });
      return saved;
    });
    if (!template) {
      res.status(403).json({ error: "Active guardian biometric consent is required before face enrollment" });
      return;
    }
    res.json({ ok: true, enrolled: true, enrolledAt: template.updatedAt.toISOString() });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Could not enroll student face" });
  }
});

router.delete("/students/:studentId/face-enrollment", requirePermission("school", "edit"), async (req, res) => {
  try {
    const companyId = companyIdFor(req);
    const studentId = numberId(req.params.studentId);
    if (!companyId || !studentId) { res.status(400).json({ error: "Invalid company or student" }); return; }
    const [student] = await db.select({ id: schoolStudentsTable.id }).from(schoolStudentsTable).where(and(
      eq(schoolStudentsTable.id, studentId),
      eq(schoolStudentsTable.companyId, companyId),
    )).limit(1);
    if (!student) { res.status(404).json({ error: "Student not found" }); return; }
    const deleted = await db.delete(schoolStudentFaceTemplatesTable).where(and(
      eq(schoolStudentFaceTemplatesTable.companyId, companyId),
      eq(schoolStudentFaceTemplatesTable.studentId, studentId),
    )).returning({ id: schoolStudentFaceTemplatesTable.id });
    if (deleted.length === 0) { res.status(404).json({ error: "Face enrollment not found" }); return; }
    res.json({ ok: true, enrolled: false, enrolledAt: null });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Could not remove face enrollment" });
  }
});

router.post("/face-attendance/recognize", requirePermission("school", "edit"), async (req, res) => {
  try {
    const companyId = companyIdFor(req);
    const descriptor = validFaceDescriptor(req.body?.descriptor);
    if (!companyId || !descriptor) { res.status(400).json({ error: "Invalid company or face descriptor" }); return; }
    const settings = await getFaceSettings(companyId);
    if (settings.requireLiveness && req.body?.livenessPassed !== true) {
      res.status(400).json({ error: "A successful liveness check is required" }); return;
    }
    const cameraId = req.body?.cameraId == null ? null : numberId(req.body.cameraId);
    if (req.body?.cameraId != null && !cameraId) { res.status(400).json({ error: "Invalid camera" }); return; }
    if (cameraId) {
      const [camera] = await db.select({ id: attendanceCamerasTable.id }).from(attendanceCamerasTable).where(and(
        eq(attendanceCamerasTable.id, cameraId),
        eq(attendanceCamerasTable.companyId, companyId),
      )).limit(1);
      if (!camera) { res.status(400).json({ error: "Camera does not belong to this company" }); return; }
    }
    const [templates, activeConsentStudents] = await Promise.all([
      db.select({
        studentId: schoolStudentFaceTemplatesTable.studentId,
        descriptorCiphertext: schoolStudentFaceTemplatesTable.descriptorCiphertext,
        name: schoolStudentsTable.fullNameAr,
      }).from(schoolStudentFaceTemplatesTable)
        .innerJoin(schoolStudentsTable, and(
          eq(schoolStudentsTable.id, schoolStudentFaceTemplatesTable.studentId),
          eq(schoolStudentsTable.companyId, companyId),
          eq(schoolStudentsTable.status, "active"),
        ))
        .where(eq(schoolStudentFaceTemplatesTable.companyId, companyId)),
      validActiveConsentStudentIds(db, companyId),
    ]);
    const threshold = Number(settings.matchThreshold ?? "0.6");
    let best: { studentId: number; name: string; distance: number } | null = null;
    for (const template of templates) {
      if (!activeConsentStudents.has(template.studentId)) continue;
      const serialized = decryptSecret(template.descriptorCiphertext);
      const savedDescriptor = parseDescriptor(serialized ?? "");
      if (!savedDescriptor) continue;
      const distance = euclidean(descriptor, savedDescriptor);
      if (!best || distance < best.distance) {
        best = { studentId: template.studentId, name: template.name, distance };
      }
    }
    if (!best || best.distance > threshold) {
      res.json({
        matched: false,
        message: "لم يتم التعرف على الطالب",
        studentId: null,
        studentNameAr: null,
        eventType: null,
        occurredAt: null,
        attendanceStatus: null,
      });
      return;
    }
    const [enrollment] = await db.select({
      id: schoolEnrollmentsTable.id,
    }).from(schoolEnrollmentsTable)
      .innerJoin(schoolAcademicYearsTable, and(
        eq(schoolAcademicYearsTable.id, schoolEnrollmentsTable.academicYearId),
        eq(schoolAcademicYearsTable.companyId, companyId),
      ))
      .where(and(
        eq(schoolEnrollmentsTable.companyId, companyId),
        eq(schoolEnrollmentsTable.studentId, best.studentId),
        eq(schoolEnrollmentsTable.status, "active"),
        or(
          eq(schoolAcademicYearsTable.isCurrent, true),
          eq(schoolAcademicYearsTable.status, "active"),
        ),
      ))
      .orderBy(desc(schoolAcademicYearsTable.isCurrent), desc(schoolAcademicYearsTable.startDate))
      .limit(1);
    if (!enrollment) {
      res.json({
        matched: false,
        message: "لا يوجد قيد دراسي نشط لهذا الطالب",
        studentId: best.studentId,
        studentNameAr: best.name,
        eventType: null,
        occurredAt: null,
        attendanceStatus: null,
      });
      return;
    }
    const now = new Date();
    const attendanceDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(now);
    const confidence = Math.max(0, Math.min(1, 1 - best.distance));
    const lockKey = `school-face:${companyId}:${enrollment.id}:${attendanceDate}`;
    const outcome = await db.transaction(async (tx) => {
      await lockStudentBiometrics(tx, companyId, best.studentId);
      const consentId = await activeConsentIdForStudent(tx, companyId, best.studentId);
      if (!consentId) {
        return { revoked: true, eventType: null, occurredAt: null, message: "تم إلغاء موافقة ولي الأمر" };
      }
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const events = await tx.select({
        eventType: schoolStudentAttendanceEventsTable.eventType,
        occurredAt: schoolStudentAttendanceEventsTable.occurredAt,
      }).from(schoolStudentAttendanceEventsTable).where(and(
        eq(schoolStudentAttendanceEventsTable.companyId, companyId),
        eq(schoolStudentAttendanceEventsTable.enrollmentId, enrollment.id),
        eq(schoolStudentAttendanceEventsTable.attendanceDate, attendanceDate),
      )).orderBy(asc(schoolStudentAttendanceEventsTable.occurredAt));
      const arrival = events.find((event) => event.eventType === "arrival");
      if (events.some((event) => event.eventType === "departure")) {
        return { revoked: false, eventType: null, occurredAt: null, message: "تم تسجيل الحضور والانصراف لهذا اليوم" };
      }
      let eventType: "arrival" | "departure" = "arrival";
      if (arrival) {
        if (now.getTime() - new Date(arrival.occurredAt).getTime() < MIN_BETWEEN_FACE_EVENTS_MS) {
          return {
            revoked: false,
            eventType: null,
            occurredAt: arrival.occurredAt,
            message: "تم تسجيل الحضور مسبقاً؛ يمكن تسجيل الانصراف بعد مرور 30 دقيقة",
          };
        }
        eventType = "departure";
      }
      const [event] = await tx.insert(schoolStudentAttendanceEventsTable).values({
        companyId,
        enrollmentId: enrollment.id,
        attendanceDate,
        eventType,
        source: "face",
        cameraId,
        confidence: String(confidence),
        occurredAt: now,
      }).returning({
        eventType: schoolStudentAttendanceEventsTable.eventType,
        occurredAt: schoolStudentAttendanceEventsTable.occurredAt,
      });
      if (eventType === "arrival") {
        const [manualOrExisting] = await tx.select({ id: schoolAttendanceTable.id })
          .from(schoolAttendanceTable).where(and(
            eq(schoolAttendanceTable.companyId, companyId),
            eq(schoolAttendanceTable.enrollmentId, enrollment.id),
            eq(schoolAttendanceTable.attendanceDate, attendanceDate),
            eq(schoolAttendanceTable.period, "full_day"),
          )).limit(1);
        if (!manualOrExisting) {
          await tx.insert(schoolAttendanceTable).values({
            companyId,
            enrollmentId: enrollment.id,
            attendanceDate,
            period: "full_day",
            status: "present",
            note: "Recorded by student face attendance",
            recordedById: numberId(req.authUser?.id),
            createdAt: now,
            updatedAt: now,
          }).onConflictDoNothing();
        }
      }
      return {
        revoked: false,
        eventType: event.eventType as "arrival" | "departure",
        occurredAt: event.occurredAt,
        message: eventType === "arrival" ? "تم تسجيل حضور الطالب" : "تم تسجيل انصراف الطالب",
      };
    });
    if (outcome.revoked) {
      res.status(403).json({
        error: outcome.message,
        matched: false,
        studentId: null,
        studentNameAr: null,
        eventType: null,
        occurredAt: null,
        attendanceStatus: null,
      });
      return;
    }
    res.json({
      matched: true,
      message: outcome.message,
      studentId: best.studentId,
      studentNameAr: best.name,
      eventType: outcome.eventType,
      occurredAt: outcome.occurredAt instanceof Date ? outcome.occurredAt.toISOString() : null,
      attendanceStatus: outcome.eventType === "arrival" ? "present" : null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Could not recognize student face" });
  }
});

export default router;
