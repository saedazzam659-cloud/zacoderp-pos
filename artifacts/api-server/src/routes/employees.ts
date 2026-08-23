import { Router } from "express";
import { requirePostRight, requireUnpostRight } from "../lib/postingRights.js";
import { db } from "@workspace/db";
import { employeesTable, employeeContractsTable, employeeLeavesTable, employeeAttendanceTable, employeeLoansTable, payrollRunsTable, payrollLinesTable, payrollAllocationSnapshotsTable, employeeProjectAssignmentsTable, branchesTable, accountsTable, companiesTable, costCentersTable, contractingProjectsTable, employeeViolationsTable, employeeTravelsTable } from "@workspace/db";
import { and, eq, asc, desc, sql, lte, gte, or, isNotNull, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId, intersectBranchRequest } from "../middleware/auth.js";
import { nextSequenceOrFallback, reserveJeNumberFromEntry } from "../lib/sequences.js";
import { requireAdminRole, requirePermission } from "../middleware/permissions.js";
import { buildPayrollJournal, buildLoanDisbursementJournal, buildEosPaymentJournal, buildPayrollPaymentJournal, resolveHrAccounts } from "../lib/hr-journals.js";
import { journalEntriesTable, journalEntryLinesTable } from "@workspace/db";
import {
  dateOrNull, requireDate, assertDateOrder, moneyOrZero, requirePositiveMoney,
  intOrDefault, emailOrNull, mobileOrNull, idNumberOrNull, timeOrNull, respondHrError,
} from "../lib/hrValidate.js";
import { assertDayOpen, assertPeriodNotTransferred } from "../lib/attendanceLocks.js";
import { requireMobilePerm } from "../lib/mobileGuard.js";
import { allocationBuckets, addPayrollDays, isoPayrollDate, assignmentRepresentedBySnapshot } from "../lib/payrollAllocation.js";
import { subscriptionsTable, usersTable } from "@workspace/db";
import bcrypt from "bcryptjs";

const router = Router();
router.use(extractAuth);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

const N = (v: any) => (v == null || v === "" ? null : v);

const isoDate = isoPayrollDate;
const addDays = addPayrollDays;

// Validate + normalize an employee payload (dates → ISO, money → clean numeric
// strings, email/mobile/id formats, cross-field date order). Throws
// HrValidationError (→ 400 Arabic) on any bad input — the class of input that
// previously crashed the INSERT and leaked a raw "Failed query" to the user.
function sanitizeEmployeeBody(b: any): Record<string, any> {
  const out: Record<string, any> = {};
  const dateFields: [string, string][] = [
    ["iqamaExpiry", "تاريخ انتهاء الإقامة"],
    ["passportExpiry", "تاريخ انتهاء الجواز"],
    ["birthDate", "تاريخ الميلاد"],
    ["hireDate", "تاريخ التعيين"],
    ["endDate", "تاريخ انتهاء الخدمة"],
    ["sponsorshipStart", "بداية الكفالة"],
    ["sponsorshipEnd", "نهاية الكفالة"],
    ["workPermitExpiry", "انتهاء رخصة العمل"],
  ];
  for (const [f, label] of dateFields) if (f in b) out[f] = dateOrNull(b[f], label);
  const moneyFields: [string, string][] = [
    ["basicSalary", "الراتب الأساسي"],
    ["housingAllow", "بدل السكن"],
    ["transportAllow", "بدل النقل"],
    ["otherAllow", "بدلات أخرى"],
  ];
  for (const [f, label] of moneyFields) if (f in b) out[f] = moneyOrZero(b[f], label);
  if ("email" in b) out.email = emailOrNull(b.email);
  if ("mobile" in b) out.mobile = mobileOrNull(b.mobile);
  if ("idNumber" in b) out.idNumber = idNumberOrNull(b.idNumber, "رقم الهوية/الإقامة");
  if ("borderNumber" in b) out.borderNumber = idNumberOrNull(b.borderNumber, "رقم الحدود");
  assertDateOrder(out.hireDate ?? null, out.endDate ?? null,
    "تاريخ انتهاء الخدمة لا يمكن أن يسبق تاريخ التعيين");
  assertDateOrder(out.sponsorshipStart ?? null, out.sponsorshipEnd ?? null,
    "تاريخ نهاية الكفالة لا يمكن أن يسبق تاريخ بدايتها");
  return out;
}

// Validate a user-supplied loan COA account: it must exist, belong to THIS
// company, and be a posting account. Returns the numeric id, or null when none
// supplied. Throws a tagged BAD_LOAN_ACCOUNT error (mapped to 400) on a foreign
// or non-posting id, so a disbursement JE can never debit another tenant's GL.
async function validateLoanAccount(cid: number, raw: any): Promise<number | null> {
  if (raw === undefined || raw === null || raw === "") return null;
  const accId = Number(raw);
  if (!Number.isInteger(accId) || accId <= 0)
    throw Object.assign(new Error("حساب السلفة غير صالح"), { code: "BAD_LOAN_ACCOUNT" });
  const [a] = await db.select({ id: accountsTable.id })
    .from(accountsTable)
    .where(and(eq(accountsTable.id, accId), eq(accountsTable.companyId, cid), eq(accountsTable.isPosting, true)));
  if (!a)
    throw Object.assign(new Error("حساب السلفة غير موجود أو ليس حساباً ترحيلياً ضمن الشركة"), { code: "BAD_LOAN_ACCOUNT" });
  return accId;
}

// ── Employee-portal credentials (بوابة الموظف zacodehr) ─────────────────────
// Never leak the bcrypt hash to any client; expose a boolean instead so the
// edit form can show "كلمة المرور محفوظة".
function stripCreds(row: any) {
  if (!row) return row;
  const { loginPasswordHash, ...rest } = row;
  return { ...rest, hasPortalPassword: !!loginPasswordHash };
}

// Portal seats = employees WITH a login username; capped by subscriptions.max_hr_users.
async function hrSeatError(cid: number): Promise<string | null> {
  const [sub] = await db.select({ m: subscriptionsTable.maxHrUsers })
    .from(subscriptionsTable).where(eq(subscriptionsTable.companyId, cid));
  const limit = sub?.m ?? 10;
  const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(employeesTable)
    .where(and(eq(employeesTable.companyId, cid), isNotNull(employeesTable.loginUsername)));
  if ((c ?? 0) >= limit)
    return `تم بلوغ الحد الأقصى لمستخدمي بوابة الموظفين (${limit}) — يمكن زيادة الحد من إدارة التراخيص`;
  return null;
}

// Race guard: two concurrent creations can both pass hrSeatError's pre-check.
// After the write, recount; if the cap is exceeded, revert THIS row's creds.
async function hrSeatOverflowRevert(cid: number, empId: number): Promise<string | null> {
  const err = await (async () => {
    const [sub] = await db.select({ m: subscriptionsTable.maxHrUsers })
      .from(subscriptionsTable).where(eq(subscriptionsTable.companyId, cid));
    const limit = sub?.m ?? 10;
    const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(employeesTable)
      .where(and(eq(employeesTable.companyId, cid), isNotNull(employeesTable.loginUsername)));
    return (c ?? 0) > limit
      ? `تم بلوغ الحد الأقصى لمستخدمي بوابة الموظفين (${limit}) — يمكن زيادة الحد من إدارة التراخيص`
      : null;
  })();
  if (err) {
    await db.update(employeesTable)
      .set({ loginUsername: null, loginPasswordHash: null })
      .where(and(eq(employeesTable.id, empId), eq(employeesTable.companyId, cid)));
  }
  return err;
}

// Validate the mobile-app user link: the user must exist in THIS company.
// Returns the Arabic error, or null when valid / not provided.
async function linkedUserError(cid: number, userId: number | null): Promise<string | null> {
  if (userId == null) return null;
  const [u] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.id, userId), eq(usersTable.companyId, cid)));
  return u ? null : "المستخدم المرتبط غير موجود في هذه الشركة";
}

async function portalUsernameTaken(cid: number, username: string, excludeId?: number): Promise<boolean> {
  const dup = await db.select({ id: employeesTable.id }).from(employeesTable)
    .where(and(eq(employeesTable.companyId, cid), sql`lower(${employeesTable.loginUsername}) = ${username}`));
  return dup.some((d) => d.id !== excludeId);
}

// ─── EMPLOYEES ───────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(employeesTable)
      .where(eq(employeesTable.companyId, cid))
      .orderBy(asc(employeesTable.code));
    res.json(rows.map(stripCreds));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/alerts", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // Per-company alert lead times (days) — configurable from إعدادات التنبيهات.
    const [comp] = await db.select({ th: companiesTable.hrAlertThresholds })
      .from(companiesTable).where(eq(companiesTable.id, cid));
    const th = (comp?.th ?? {}) as Record<string, number>;
    const days = (k: string) => {
      const v = Number(th[k]);
      return Number.isFinite(v) && v >= 1 && v <= 3650 ? Math.round(v) : 90;
    };
    const horizon = (k: string) =>
      new Date(today.getTime() + days(k) * 86400000).toISOString().slice(0, 10);
    const in90Str = horizon("iqama");

    const expIqamas = await db.select({
      id: employeesTable.id, code: employeesTable.code, nameAr: employeesTable.nameAr,
      iqamaExpiry: employeesTable.iqamaExpiry, idNumber: employeesTable.idNumber,
    }).from(employeesTable)
      .where(and(
        eq(employeesTable.companyId, cid),
        isNotNull(employeesTable.iqamaExpiry),
        lte(employeesTable.iqamaExpiry, in90Str),
        eq(employeesTable.status, "active"),
      )).orderBy(asc(employeesTable.iqamaExpiry));

    const expContracts = await db.select({
      id: employeeContractsTable.id,
      employeeId: employeeContractsTable.employeeId,
      contractNumber: employeeContractsTable.contractNumber,
      endDate: employeeContractsTable.endDate,
      employeeName: employeesTable.nameAr,
    }).from(employeeContractsTable)
      .leftJoin(employeesTable, eq(employeeContractsTable.employeeId, employeesTable.id))
      .where(and(
        eq(employeeContractsTable.companyId, cid),
        eq(employeeContractsTable.status, "active"),
        isNotNull(employeeContractsTable.endDate),
        lte(employeeContractsTable.endDate, horizon("contract")),
      )).orderBy(asc(employeeContractsTable.endDate));

    const expPassports = await db.select({
      id: employeesTable.id, code: employeesTable.code, nameAr: employeesTable.nameAr,
      passportExpiry: employeesTable.passportExpiry, passportNumber: employeesTable.passportNumber,
    }).from(employeesTable)
      .where(and(
        eq(employeesTable.companyId, cid),
        isNotNull(employeesTable.passportExpiry),
        lte(employeesTable.passportExpiry, horizon("passport")),
        eq(employeesTable.status, "active"),
      )).orderBy(asc(employeesTable.passportExpiry));

    // انتهاء رخصة العمل — same pattern as iqamas, own configurable window.
    const expWorkPermits = await db.select({
      id: employeesTable.id, code: employeesTable.code, nameAr: employeesTable.nameAr,
      workPermitExpiry: employeesTable.workPermitExpiry, borderNumber: employeesTable.borderNumber,
    }).from(employeesTable)
      .where(and(
        eq(employeesTable.companyId, cid),
        isNotNull(employeesTable.workPermitExpiry),
        lte(employeesTable.workPermitExpiry, horizon("workPermit")),
        eq(employeesTable.status, "active"),
      )).orderBy(asc(employeesTable.workPermitExpiry));

    const daysLeft = (d: string) => Math.ceil((new Date(d).getTime() - today.getTime()) / 86400000);
    const tag = (rows: any[], field: string) =>
      rows.map(r => ({ ...r, daysLeft: daysLeft(r[field]) }));

    // الخروج والعودة — travellers still out whose expected return is within
    // one week (or already overdue).
    const in7Str = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const upcomingReturns = await db.select({
      id: employeeTravelsTable.id,
      employeeId: employeeTravelsTable.employeeId,
      exitDate: employeeTravelsTable.exitDate,
      expectedReturnDate: employeeTravelsTable.expectedReturnDate,
      employeeName: employeesTable.nameAr,
      code: employeesTable.code,
    }).from(employeeTravelsTable)
      .leftJoin(employeesTable, eq(employeesTable.id, employeeTravelsTable.employeeId))
      .where(and(
        eq(employeeTravelsTable.companyId, cid),
        eq(employeeTravelsTable.status, "out"),
        isNotNull(employeeTravelsTable.expectedReturnDate),
        lte(employeeTravelsTable.expectedReturnDate, in7Str),
      )).orderBy(asc(employeeTravelsTable.expectedReturnDate));

    res.json({
      upcomingReturns:     tag(upcomingReturns, "expectedReturnDate"),
      expiringIqamas:      tag(expIqamas, "iqamaExpiry"),
      expiringContracts:   tag(expContracts, "endDate"),
      expiringPassports:   tag(expPassports, "passportExpiry"),
      expiringWorkPermits: tag(expWorkPermits, "workPermitExpiry"),
      thresholds: { iqama: days("iqama"), contract: days("contract"), passport: days("passport"), workPermit: days("workPermit") },
      todayStr, in90Str,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══ المخالفات (registered disciplinary violations) ══════════════════════════
// Defined BEFORE /:id so the "violations" segment never hits it.
router.get("/violations/list", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { employeeId, status, from, to } = req.query as any;
    const conds: any[] = [eq(employeeViolationsTable.companyId, cid)];
    if (employeeId) conds.push(eq(employeeViolationsTable.employeeId, Number(employeeId)));
    if (status) conds.push(eq(employeeViolationsTable.status, String(status)));
    if (from) conds.push(gte(employeeViolationsTable.violationDate, String(from)));
    if (to) conds.push(lte(employeeViolationsTable.violationDate, String(to)));
    const rows = await db.select({
      id: employeeViolationsTable.id,
      employeeId: employeeViolationsTable.employeeId,
      violationType: employeeViolationsTable.violationType,
      violationDate: employeeViolationsTable.violationDate,
      reason: employeeViolationsTable.reason,
      amount: employeeViolationsTable.amount,
      deductFromSalary: employeeViolationsTable.deductFromSalary,
      payrollRunId: employeeViolationsTable.payrollRunId,
      status: employeeViolationsTable.status,
      notes: employeeViolationsTable.notes,
      empCode: employeesTable.code,
      empNameAr: employeesTable.nameAr,
      empNameEn: employeesTable.nameEn,
    }).from(employeeViolationsTable)
      .leftJoin(employeesTable, eq(employeesTable.id, employeeViolationsTable.employeeId))
      .where(and(...conds))
      .orderBy(desc(employeeViolationsTable.id));
    res.json(rows);
  } catch (e: any) { respondHrError(req, res, e); }
});

async function assertEmpInCompany(cid: number, employeeId: number) {
  const [e] = await db.select({ id: employeesTable.id }).from(employeesTable)
    .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid)));
  if (!e) throw Object.assign(new Error("الموظف غير موجود"), { status: 400 });
}

router.post("/violations", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body || {};
    const employeeId = Number(b.employeeId);
    if (!employeeId) { res.status(400).json({ error: "الموظف مطلوب" }); return; }
    await assertEmpInCompany(cid, employeeId);
    if (!String(b.violationType || "").trim()) { res.status(400).json({ error: "نوع المخالفة مطلوب" }); return; }
    const [row] = await db.insert(employeeViolationsTable).values({
      companyId: cid,
      employeeId,
      violationType: String(b.violationType).trim(),
      violationDate: requireDate(b.violationDate, "تاريخ المخالفة"),
      reason: N(b.reason),
      amount: String(moneyOrZero(b.amount, "قيمة المخالفة")),
      deductFromSalary: !!b.deductFromSalary,
      status: b.status === "waived" ? "waived" : "pending",
      notes: N(b.notes),
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

router.put("/violations/:vid", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.vid);
    const b = req.body || {};
    const [v] = await db.select().from(employeeViolationsTable)
      .where(and(eq(employeeViolationsTable.id, id), eq(employeeViolationsTable.companyId, cid)));
    if (!v) { res.status(404).json({ error: "غير موجود" }); return; }
    if (v.status === "deducted") { res.status(400).json({ error: "المخالفة مخصومة في مسير رواتب — لا يمكن تعديلها" }); return; }
    const patch: any = { updatedAt: new Date() };
    if (b.employeeId !== undefined && Number(b.employeeId) !== v.employeeId) {
      await assertEmpInCompany(cid, Number(b.employeeId));
      patch.employeeId = Number(b.employeeId);
    }
    if (b.violationType !== undefined) patch.violationType = String(b.violationType).trim();
    if (b.violationDate !== undefined) patch.violationDate = requireDate(b.violationDate, "تاريخ المخالفة");
    if (b.reason !== undefined) patch.reason = N(b.reason);
    if (b.amount !== undefined) patch.amount = String(moneyOrZero(b.amount, "قيمة المخالفة"));
    if (b.deductFromSalary !== undefined) patch.deductFromSalary = !!b.deductFromSalary;
    if (b.status !== undefined && ["pending", "waived"].includes(String(b.status))) patch.status = String(b.status);
    if (b.notes !== undefined) patch.notes = N(b.notes);
    // Conditional update: a concurrent payroll run may have consumed this
    // violation after the read above — the WHERE re-asserts it's not deducted.
    const [row] = await db.update(employeeViolationsTable).set(patch)
      .where(and(
        eq(employeeViolationsTable.id, id),
        eq(employeeViolationsTable.companyId, cid),
        sql`${employeeViolationsTable.status} <> 'deducted'`,
      ))
      .returning();
    if (!row) { res.status(409).json({ error: "المخالفة خُصمت في مسير رواتب أثناء التعديل — لا يمكن تعديلها" }); return; }
    res.json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

router.delete("/violations/:vid", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.vid);
    const [v] = await db.select().from(employeeViolationsTable)
      .where(and(eq(employeeViolationsTable.id, id), eq(employeeViolationsTable.companyId, cid)));
    if (!v) { res.status(404).json({ error: "غير موجود" }); return; }
    if (v.status === "deducted") { res.status(400).json({ error: "المخالفة مخصومة في مسير رواتب — لا يمكن حذفها" }); return; }
    const deleted = await db.delete(employeeViolationsTable)
      .where(and(
        eq(employeeViolationsTable.id, id),
        eq(employeeViolationsTable.companyId, cid),
        sql`${employeeViolationsTable.status} <> 'deducted'`,
      )).returning({ id: employeeViolationsTable.id });
    if (!deleted.length) { res.status(409).json({ error: "المخالفة خُصمت في مسير رواتب — لا يمكن حذفها" }); return; }
    res.json({ ok: true });
  } catch (e: any) { respondHrError(req, res, e); }
});

// ═══ الخروج والعودة (travel exit/return) ══════════════════════════════════════
router.get("/travels/list", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { employeeId, status } = req.query as any;
    const conds: any[] = [eq(employeeTravelsTable.companyId, cid)];
    if (employeeId) conds.push(eq(employeeTravelsTable.employeeId, Number(employeeId)));
    if (status) conds.push(eq(employeeTravelsTable.status, String(status)));
    const rows = await db.select({
      id: employeeTravelsTable.id,
      employeeId: employeeTravelsTable.employeeId,
      exitDate: employeeTravelsTable.exitDate,
      exitTime: employeeTravelsTable.exitTime,
      expectedReturnDate: employeeTravelsTable.expectedReturnDate,
      expectedReturnTime: employeeTravelsTable.expectedReturnTime,
      actualReturnDate: employeeTravelsTable.actualReturnDate,
      actualReturnTime: employeeTravelsTable.actualReturnTime,
      status: employeeTravelsTable.status,
      notes: employeeTravelsTable.notes,
      empCode: employeesTable.code,
      empNameAr: employeesTable.nameAr,
      empNameEn: employeesTable.nameEn,
    }).from(employeeTravelsTable)
      .leftJoin(employeesTable, eq(employeesTable.id, employeeTravelsTable.employeeId))
      .where(and(...conds))
      .orderBy(desc(employeeTravelsTable.id));
    res.json(rows);
  } catch (e: any) { respondHrError(req, res, e); }
});

router.post("/travels", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body || {};
    const employeeId = Number(b.employeeId);
    if (!employeeId) { res.status(400).json({ error: "الموظف مطلوب" }); return; }
    await assertEmpInCompany(cid, employeeId);
    const [row] = await db.insert(employeeTravelsTable).values({
      companyId: cid,
      employeeId,
      exitDate: requireDate(b.exitDate, "تاريخ الخروج"),
      exitTime: timeOrNull(b.exitTime, "وقت الخروج"),
      expectedReturnDate: dateOrNull(b.expectedReturnDate, "تاريخ العودة المتوقع"),
      expectedReturnTime: timeOrNull(b.expectedReturnTime, "وقت العودة المتوقع"),
      status: "out",
      notes: N(b.notes),
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

router.put("/travels/:tid", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.tid);
    const b = req.body || {};
    const [tRow] = await db.select().from(employeeTravelsTable)
      .where(and(eq(employeeTravelsTable.id, id), eq(employeeTravelsTable.companyId, cid)));
    if (!tRow) { res.status(404).json({ error: "غير موجود" }); return; }
    const patch: any = { updatedAt: new Date() };
    if (b.exitDate !== undefined) patch.exitDate = requireDate(b.exitDate, "تاريخ الخروج");
    if (b.exitTime !== undefined) patch.exitTime = timeOrNull(b.exitTime, "وقت الخروج");
    if (b.expectedReturnDate !== undefined) patch.expectedReturnDate = dateOrNull(b.expectedReturnDate, "تاريخ العودة المتوقع");
    if (b.expectedReturnTime !== undefined) patch.expectedReturnTime = timeOrNull(b.expectedReturnTime, "وقت العودة المتوقع");
    if (b.actualReturnDate !== undefined) {
      patch.actualReturnDate = dateOrNull(b.actualReturnDate, "تاريخ العودة الفعلي");
      patch.status = patch.actualReturnDate ? "returned" : "out";
    }
    if (b.actualReturnTime !== undefined) patch.actualReturnTime = timeOrNull(b.actualReturnTime, "وقت العودة الفعلي");
    if (b.notes !== undefined) patch.notes = N(b.notes);
    const [row] = await db.update(employeeTravelsTable).set(patch)
      .where(and(eq(employeeTravelsTable.id, id), eq(employeeTravelsTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

router.delete("/travels/:tid", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.tid);
    await db.delete(employeeTravelsTable)
      .where(and(eq(employeeTravelsTable.id, Number(req.params.tid)), eq(employeeTravelsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { respondHrError(req, res, e); }
});

// ─── Mobile: my own attendance (تقرير حضوري) ────────────────────────────────
// The logged-in ERP user must be linked to an employee via employees.user_id.
// Gated by mobile permission "hr_attendance_view". Registered BEFORE /:id.
router.get("/my-attendance", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const uid = Number((req as any).authUser?.id);
    if (!Number.isFinite(uid) || uid <= 0) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!(await requireMobilePerm(req, res, cid, "hr_attendance_view", "لا تملك صلاحية عرض تقرير الحضور"))) return;
    const [emp] = await db.select({
      id: employeesTable.id, code: employeesTable.code,
      nameAr: employeesTable.nameAr, jobTitle: employeesTable.jobTitle,
    }).from(employeesTable)
      .where(and(eq(employeesTable.companyId, cid), eq(employeesTable.userId, uid)));
    if (!emp) {
      res.status(404).json({ error: "لا يوجد ملف موظف مرتبط بحسابك — اطلب من الإدارة ربط حسابك من شاشة الموظفين" });
      return;
    }
    const now = new Date();
    const year = Math.min(2100, Math.max(2000, Number(req.query.year) || now.getFullYear()));
    const month = Math.min(12, Math.max(1, Number(req.query.month) || (now.getMonth() + 1)));
    const mm = String(month).padStart(2, "0");
    const from = `${year}-${mm}-01`;
    // Inclusive month end — last real day (Feb/30-day months break with "-31").
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const to = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;
    const rows = await db.select({
      date: employeeAttendanceTable.date,
      checkIn: employeeAttendanceTable.checkIn,
      checkOut: employeeAttendanceTable.checkOut,
      workedHours: employeeAttendanceTable.workedHours,
      overtimeHours: employeeAttendanceTable.overtimeHours,
      lateMinutes: employeeAttendanceTable.lateMinutes,
      earlyLeaveMinutes: employeeAttendanceTable.earlyLeaveMinutes,
      status: employeeAttendanceTable.status,
      notes: employeeAttendanceTable.notes,
    }).from(employeeAttendanceTable)
      .where(and(
        eq(employeeAttendanceTable.companyId, cid),
        eq(employeeAttendanceTable.employeeId, emp.id),
        gte(employeeAttendanceTable.date, from),
        lte(employeeAttendanceTable.date, to),
      ))
      .orderBy(desc(employeeAttendanceTable.date));
    const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const summary = {
      days: rows.length,
      present: rows.filter(r => r.status === "present" || r.status === "late").length,
      absent: rows.filter(r => r.status === "absent").length,
      leave: rows.filter(r => r.status === "leave" || r.status === "vacation").length,
      lateDays: rows.filter(r => num(r.lateMinutes) > 0).length,
      lateMinutes: rows.reduce((s, r) => s + num(r.lateMinutes), 0),
      earlyLeaveMinutes: rows.reduce((s, r) => s + num(r.earlyLeaveMinutes), 0),
      workedHours: Math.round(rows.reduce((s, r) => s + num(r.workedHours), 0) * 100) / 100,
      overtimeHours: Math.round(rows.reduce((s, r) => s + num(r.overtimeHours), 0) * 100) / 100,
    };
    res.json({ employee: emp, year, month, rows, summary });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(employeesTable)
      .where(and(eq(employeesTable.id, id), eq(employeesTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    const contracts = await db.select().from(employeeContractsTable)
      .where(eq(employeeContractsTable.employeeId, id))
      .orderBy(desc(employeeContractsTable.startDate));
    const leaves = await db.select().from(employeeLeavesTable)
      .where(eq(employeeLeavesTable.employeeId, id))
      .orderBy(desc(employeeLeavesTable.startDate));
    res.json({ ...stripCreds(row), contracts, leaves });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body || {};
    if (!b.nameAr || !String(b.nameAr).trim()) {
      res.status(400).json({ error: "اسم الموظف بالعربي مطلوب" }); return;
    }
    let code = String(b.code || "").trim();
    if (!code) {
      code = await nextSequenceOrFallback(
        cid,
        "employee",
        { userId: (req as any).authUser?.id ?? null, refTable: "employees", branchId: N(b.branchId) ? Number(b.branchId) : null },
        async () => {
          const [{ c }] = await db.select({ c: sql<number>`count(*)::int` })
            .from(employeesTable).where(eq(employeesTable.companyId, cid));
          return `EMP-${String((c ?? 0) + 1).padStart(4, "0")}`;
        },
      );
    }
    const clean = sanitizeEmployeeBody(b);
    if (clean.idNumber) {
      const dup = await db.select({ id: employeesTable.id }).from(employeesTable)
        .where(and(eq(employeesTable.companyId, cid), eq(employeesTable.idNumber, String(clean.idNumber))));
      if (dup.length) { res.status(400).json({ error: "رقم الهوية/الإقامة مكرر" }); return; }
    }
    const linkUserId = N(b.userId) ? Number(b.userId) : null;
    {
      const luErr = await linkedUserError(cid, linkUserId);
      if (luErr) { res.status(400).json({ error: luErr }); return; }
    }
    // Portal credentials (optional)
    let credUsername: string | null = null, credHash: string | null = null;
    {
      const u = String(b.loginUsername ?? "").trim().toLowerCase();
      const p = String(b.loginPassword ?? "");
      if (u) {
        if (p.length < 4) { res.status(400).json({ error: "كلمة مرور البوابة مطلوبة (4 أحرف على الأقل)" }); return; }
        const seatErr = await hrSeatError(cid);
        if (seatErr) { res.status(409).json({ error: seatErr }); return; }
        if (await portalUsernameTaken(cid, u)) { res.status(409).json({ error: "اسم المستخدم مستخدم لموظف آخر" }); return; }
        credUsername = u; credHash = await bcrypt.hash(p, 12);
      } else if (p) {
        res.status(400).json({ error: "أدخل اسم مستخدم للبوابة أولاً" }); return;
      }
    }
    const [row] = await db.insert(employeesTable).values({
      companyId: cid,
      branchId: N(b.branchId) ? Number(b.branchId) : null,
      code,
      nameAr: String(b.nameAr).trim(),
      nameEn: N(b.nameEn),
      idType: b.idType || "iqama",
      idNumber: clean.idNumber ?? null,
      iqamaExpiry: clean.iqamaExpiry ?? null,
      passportNumber: N(b.passportNumber),
      passportExpiry: clean.passportExpiry ?? null,
      nationality: N(b.nationality),
      gender: N(b.gender),
      birthDate: clean.birthDate ?? null,
      mobile: clean.mobile ?? null,
      email: clean.email ?? null,
      hireDate: clean.hireDate ?? null,
      endDate: clean.endDate ?? null,
      department: N(b.department),
      jobTitle: N(b.jobTitle),
      sponsor: N(b.sponsor),
      profession: N(b.profession),
      status: b.status || "active",
      basicSalary: clean.basicSalary ?? "0",
      housingAllow: clean.housingAllow ?? "0",
      transportAllow: clean.transportAllow ?? "0",
      otherAllow: clean.otherAllow ?? "0",
      bankAccountIban: N(b.bankAccountIban),
      bankName: N(b.bankName),
      payableAccountId: N(b.payableAccountId) ? Number(b.payableAccountId) : null,
      photoUrl: N(b.photoUrl),
      notes: N(b.notes),
      // Mudad / kafala eligibility
      borderNumber: clean.borderNumber ?? null,
      saudiType: b.saudiType || "non_saudi",
      employmentType: b.employmentType || "regular",
      onSponsorship: b.onSponsorship === false ? false : true,
      establishmentNumber: N(b.establishmentNumber),
      sponsorshipStart: clean.sponsorshipStart ?? null,
      sponsorshipEnd: clean.sponsorshipEnd ?? null,
      workPermitExpiry: clean.workPermitExpiry ?? null,
      bankApproved: b.bankApproved === false ? false : true,
      loginUsername: credUsername,
      loginPasswordHash: credHash,
      userId: linkUserId,
    }).returning();
    if (credUsername) {
      const overflow = await hrSeatOverflowRevert(cid, row.id);
      if (overflow) { res.status(201).json({ ...stripCreds({ ...row, loginUsername: null, loginPasswordHash: null }), seatWarning: overflow }); return; }
    }
    res.status(201).json(stripCreds(row));
  } catch (e: any) {
    if (String(e?.message).includes("uq_employees_company_idnumber"))
      return res.status(400).json({ error: "رقم الهوية/الإقامة مكرر" });
    if (String(e?.message).includes("uq_employees_company_code"))
      return res.status(400).json({ error: "كود الموظف مكرر" });
    if (String(e?.message).includes("employees_company_user_uniq"))
      return res.status(409).json({ error: "هذا المستخدم مرتبط بموظف آخر بالفعل" });
    respondHrError(req, res, e);
  }
});

router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    if ("nameAr" in b && !String(b.nameAr ?? "").trim()) {
      res.status(400).json({ error: "اسم الموظف بالعربي مطلوب" }); return;
    }
    const clean = sanitizeEmployeeBody(b);
    if (clean.idNumber) {
      const dup = await db.select({ id: employeesTable.id }).from(employeesTable)
        .where(and(eq(employeesTable.companyId, cid), eq(employeesTable.idNumber, String(clean.idNumber))));
      if (dup.some((d: any) => d.id !== id)) { res.status(400).json({ error: "رقم الهوية/الإقامة مكرر" }); return; }
    }
    const updates: any = { updatedAt: new Date() };
    const fields = ["branchId","nameAr","nameEn","idType","passportNumber",
      "nationality","gender","department","jobTitle","sponsor",
      "profession","status","bankAccountIban","bankName","photoUrl","notes",
      "saudiType","employmentType","establishmentNumber"];
    for (const f of fields) if (f in b) updates[f] = N(b[f]);
    // Validated/normalized fields (dates → ISO, money → clean numeric strings,
    // email/mobile/id formats) come from sanitizeEmployeeBody.
    for (const f of Object.keys(clean)) updates[f] = clean[f];
    for (const f of ["onSponsorship","bankApproved"])
      if (f in b) updates[f] = b[f] === false ? false : true;
    if ("payableAccountId" in b) updates.payableAccountId = N(b.payableAccountId) ? Number(b.payableAccountId) : null;
    if ("branchId" in b) updates.branchId = N(b.branchId) ? Number(b.branchId) : null;
    if ("userId" in b) {
      const linkUserId = N(b.userId) ? Number(b.userId) : null;
      const luErr = await linkedUserError(cid, linkUserId);
      if (luErr) { res.status(400).json({ error: luErr }); return; }
      updates.userId = linkUserId;
    }

    // Portal credentials (optional). Blank password on edit keeps the old hash.
    if ("loginUsername" in b || "loginPassword" in b || "portalActive" in b) {
      const [cur] = await db.select({
        loginUsername: employeesTable.loginUsername,
        loginPasswordHash: employeesTable.loginPasswordHash,
      }).from(employeesTable)
        .where(and(eq(employeesTable.id, id), eq(employeesTable.companyId, cid)));
      if (!cur) { res.status(404).json({ error: "غير موجود" }); return; }
      if ("portalActive" in b) updates.portalActive = b.portalActive !== false;
      const p = String(b.loginPassword ?? "");
      if ("loginUsername" in b) {
        const u = String(b.loginUsername ?? "").trim().toLowerCase();
        if (!u) {
          updates.loginUsername = null; updates.loginPasswordHash = null;
        } else {
          if (u !== (cur.loginUsername ?? "").toLowerCase()) {
            if (!cur.loginUsername) {
              const seatErr = await hrSeatError(cid);
              if (seatErr) { res.status(409).json({ error: seatErr }); return; }
            }
            if (await portalUsernameTaken(cid, u, id)) { res.status(409).json({ error: "اسم المستخدم مستخدم لموظف آخر" }); return; }
          }
          updates.loginUsername = u;
          if (p) {
            if (p.length < 4) { res.status(400).json({ error: "كلمة المرور قصيرة (4 أحرف على الأقل)" }); return; }
            updates.loginPasswordHash = await bcrypt.hash(p, 12);
          } else if (!cur.loginPasswordHash) {
            res.status(400).json({ error: "كلمة مرور البوابة مطلوبة (4 أحرف على الأقل)" }); return;
          }
        }
      } else if (p) {
        if (!cur.loginUsername) { res.status(400).json({ error: "أدخل اسم مستخدم للبوابة أولاً" }); return; }
        if (p.length < 4) { res.status(400).json({ error: "كلمة المرور قصيرة (4 أحرف على الأقل)" }); return; }
        updates.loginPasswordHash = await bcrypt.hash(p, 12);
      }
    }

    const [row] = await db.update(employeesTable).set(updates)
      .where(and(eq(employeesTable.id, id), eq(employeesTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    // Seat newly consumed on this update? re-verify the cap post-write.
    if (updates.loginUsername && row.loginUsername) {
      const overflow = await hrSeatOverflowRevert(cid, id);
      if (overflow) { res.status(409).json({ error: overflow }); return; }
    }
    res.json(stripCreds(row));
  } catch (e: any) {
    if (String(e?.message).includes("uq_employees_company_idnumber"))
      return res.status(400).json({ error: "رقم الهوية/الإقامة مكرر" });
    if (String(e?.message).includes("employees_company_login_username_uniq"))
      return res.status(409).json({ error: "اسم المستخدم مستخدم لموظف آخر" });
    if (String(e?.message).includes("employees_company_user_uniq"))
      return res.status(409).json({ error: "هذا المستخدم مرتبط بموظف آخر بالفعل" });
    respondHrError(req, res, e);
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(employeesTable)
      .where(and(eq(employeesTable.id, id), eq(employeesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── CONTRACTS ───────────────────────────────────────────────
router.get("/:id/contracts", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const empId = Number(req.params.id);
    const rows = await db.select().from(employeeContractsTable)
      .where(and(eq(employeeContractsTable.employeeId, empId), eq(employeeContractsTable.companyId, cid)))
      .orderBy(desc(employeeContractsTable.startDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/:id/contracts", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const empId = Number(req.params.id);
    const b = req.body || {};
    const [emp] = await db.select({ id: employeesTable.id }).from(employeesTable)
      .where(and(eq(employeesTable.id, empId), eq(employeesTable.companyId, cid)));
    if (!emp) { res.status(404).json({ error: "الموظف غير موجود" }); return; }

    let cn = String(b.contractNumber || "").trim();
    if (!cn) {
      cn = await nextSequenceOrFallback(
        cid,
        "hr_contract",
        { userId: (req as any).authUser?.id ?? null, refTable: "employee_contracts" },
        async () => {
          const [{ c }] = await db.select({ c: sql<number>`count(*)::int` })
            .from(employeeContractsTable).where(eq(employeeContractsTable.companyId, cid));
          return `CON-${String((c ?? 0) + 1).padStart(5, "0")}`;
        },
      );
    }

    const startDate = requireDate(b.startDate, "تاريخ بداية العقد");
    const endDate = dateOrNull(b.endDate, "تاريخ نهاية العقد");
    assertDateOrder(startDate, endDate, "تاريخ نهاية العقد لا يمكن أن يسبق تاريخ بدايته");
    const [row] = await db.insert(employeeContractsTable).values({
      companyId: cid,
      employeeId: empId,
      contractNumber: cn,
      contractType: b.contractType || "fixed",
      startDate,
      endDate,
      basicSalary: moneyOrZero(b.basicSalary, "الراتب الأساسي"),
      housingAllow: moneyOrZero(b.housingAllow, "بدل السكن"),
      transportAllow: moneyOrZero(b.transportAllow, "بدل النقل"),
      otherAllow: moneyOrZero(b.otherAllow, "بدلات أخرى"),
      workingHours: intOrDefault(b.workingHours, 8, "ساعات العمل", 1, 24),
      probationDays: intOrDefault(b.probationDays, 90, "فترة التجربة (يوم)", 0, 365),
      noticePeriod: intOrDefault(b.noticePeriod, 60, "فترة الإشعار (يوم)", 0, 365),
      vacationDays: intOrDefault(b.vacationDays, 21, "أيام الإجازة السنوية", 0, 365),
      terms: N(b.terms),
      status: b.status || "active",
      renewedFromId: N(b.renewedFromId) ? Number(b.renewedFromId) : null,
      notes: N(b.notes),
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

router.post("/:id/contracts/:contractId/renew", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const empId = Number(req.params.id);
    const cnId = Number(req.params.contractId);
    const b = req.body || {};
    const [old] = await db.select().from(employeeContractsTable)
      .where(and(eq(employeeContractsTable.id, cnId), eq(employeeContractsTable.companyId, cid)));
    if (!old) { res.status(404).json({ error: "العقد غير موجود" }); return; }

    const newStartDate = dateOrNull(b.startDate, "تاريخ بداية العقد") || new Date().toISOString().slice(0, 10);
    const newEndDate = dateOrNull(b.endDate, "تاريخ نهاية العقد");
    assertDateOrder(newStartDate, newEndDate, "تاريخ نهاية العقد لا يمكن أن يسبق تاريخ بدايته");

    await db.update(employeeContractsTable).set({ status: "renewed", updatedAt: new Date() })
      .where(eq(employeeContractsTable.id, cnId));

    const cn = await nextSequenceOrFallback(
      cid,
      "hr_contract",
      { userId: (req as any).authUser?.id ?? null, refTable: "employee_contracts" },
      async () => {
        const [{ c }] = await db.select({ c: sql<number>`count(*)::int` })
          .from(employeeContractsTable).where(eq(employeeContractsTable.companyId, cid));
        return `CON-${String((c ?? 0) + 1).padStart(5, "0")}`;
      },
    );

    const [row] = await db.insert(employeeContractsTable).values({
      companyId: cid,
      employeeId: empId,
      contractNumber: cn,
      contractType: old.contractType,
      startDate: newStartDate,
      endDate: newEndDate,
      basicSalary: b.basicSalary != null ? moneyOrZero(b.basicSalary, "الراتب الأساسي") : old.basicSalary,
      housingAllow: b.housingAllow != null ? moneyOrZero(b.housingAllow, "بدل السكن") : old.housingAllow,
      transportAllow: b.transportAllow != null ? moneyOrZero(b.transportAllow, "بدل النقل") : old.transportAllow,
      otherAllow: b.otherAllow != null ? moneyOrZero(b.otherAllow, "بدلات أخرى") : old.otherAllow,
      workingHours: old.workingHours,
      probationDays: 0,
      noticePeriod: old.noticePeriod,
      vacationDays: old.vacationDays,
      terms: old.terms,
      status: "active",
      renewedFromId: old.id,
      notes: `مجدد من العقد ${old.contractNumber}`,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

router.put("/:id/contracts/:contractId", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const cnId = Number(req.params.contractId);
    const b = req.body || {};
    const updates: any = { updatedAt: new Date() };
    const fields = ["contractType","status","terms","notes"];
    for (const f of fields) if (f in b) updates[f] = N(b[f]);
    if ("startDate" in b) updates.startDate = requireDate(b.startDate, "تاريخ بداية العقد");
    if ("endDate" in b) updates.endDate = dateOrNull(b.endDate, "تاريخ نهاية العقد");
    if ("startDate" in b || "endDate" in b) {
      const [existing] = await db.select({
        startDate: employeeContractsTable.startDate,
        endDate: employeeContractsTable.endDate,
      }).from(employeeContractsTable)
        .where(and(eq(employeeContractsTable.id, cnId), eq(employeeContractsTable.companyId, cid)));
      if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
      const effStart = "startDate" in b ? updates.startDate : existing.startDate;
      const effEnd = "endDate" in b ? updates.endDate : existing.endDate;
      assertDateOrder(effStart ?? null, effEnd ?? null, "تاريخ نهاية العقد لا يمكن أن يسبق تاريخ بدايته");
    }
    const moneyLabels: Record<string, string> = { basicSalary: "الراتب الأساسي", housingAllow: "بدل السكن", transportAllow: "بدل النقل", otherAllow: "بدلات أخرى" };
    for (const f of Object.keys(moneyLabels))
      if (f in b) updates[f] = moneyOrZero(b[f], moneyLabels[f]);
    const intDefs: Record<string, [number, string, number, number]> = {
      workingHours: [8, "ساعات العمل", 1, 24],
      probationDays: [0, "فترة التجربة (يوم)", 0, 365],
      noticePeriod: [0, "فترة الإشعار (يوم)", 0, 365],
      vacationDays: [0, "أيام الإجازة السنوية", 0, 365],
    };
    for (const f of Object.keys(intDefs))
      if (f in b) updates[f] = intOrDefault(b[f], intDefs[f][0], intDefs[f][1], intDefs[f][2], intDefs[f][3]);
    const [row] = await db.update(employeeContractsTable).set(updates)
      .where(and(eq(employeeContractsTable.id, cnId), eq(employeeContractsTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

router.delete("/:id/contracts/:contractId", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const cnId = Number(req.params.contractId);
    await db.delete(employeeContractsTable)
      .where(and(eq(employeeContractsTable.id, cnId), eq(employeeContractsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── LEAVES ──────────────────────────────────────────────────
router.get("/:id/leaves", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const empId = Number(req.params.id);
    const rows = await db.select().from(employeeLeavesTable)
      .where(and(eq(employeeLeavesTable.employeeId, empId), eq(employeeLeavesTable.companyId, cid)))
      .orderBy(desc(employeeLeavesTable.startDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/:id/leaves", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const empId = Number(req.params.id);
    const b = req.body || {};
    const startDate = requireDate(b.startDate, "تاريخ بداية الإجازة");
    const endDate = requireDate(b.endDate, "تاريخ نهاية الإجازة");
    assertDateOrder(startDate, endDate, "تاريخ نهاية الإجازة لا يمكن أن يسبق تاريخ بدايتها");
    const start = new Date(startDate);
    const end = new Date(endDate);
    const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1);
    const [row] = await db.insert(employeeLeavesTable).values({
      companyId: cid,
      employeeId: empId,
      leaveType: b.leaveType || "annual",
      startDate,
      endDate,
      days: intOrDefault(b.days, days, "عدد الأيام", 1, 3660),
      paid: b.paid !== false,
      status: b.status || "pending",
      reason: N(b.reason),
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

router.put("/:id/leaves/:leaveId", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const lid = Number(req.params.leaveId);
    const b = req.body || {};
    const updates: any = { updatedAt: new Date() };
    if (b.status === "approved") { updates.status = "approved"; updates.approvedAt = new Date(); updates.approvedBy = req.authUser?.username || "—"; }
    else if (b.status === "rejected") { updates.status = "rejected"; updates.approvedAt = new Date(); updates.approvedBy = req.authUser?.username || "—"; }
    else if (b.status) updates.status = b.status;
    const [row] = await db.update(employeeLeavesTable).set(updates)
      .where(and(eq(employeeLeavesTable.id, lid), eq(employeeLeavesTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/:id/leaves/:leaveId", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const lid = Number(req.params.leaveId);
    await db.delete(employeeLeavesTable)
      .where(and(eq(employeeLeavesTable.id, lid), eq(employeeLeavesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ALL CONTRACTS (across employees) ────────────────────────
router.get("/contracts/all", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { status, expiringDays } = req.query as any;
    const conds: any[] = [eq(employeeContractsTable.companyId, cid)];
    if (status) conds.push(eq(employeeContractsTable.status, String(status)));
    if (expiringDays) {
      const limit = new Date(Date.now() + Number(expiringDays) * 86400000).toISOString().slice(0, 10);
      conds.push(isNotNull(employeeContractsTable.endDate));
      conds.push(lte(employeeContractsTable.endDate, limit));
    }
    const rows = await db.select({
      id: employeeContractsTable.id,
      employeeId: employeeContractsTable.employeeId,
      contractNumber: employeeContractsTable.contractNumber,
      contractType: employeeContractsTable.contractType,
      startDate: employeeContractsTable.startDate,
      endDate: employeeContractsTable.endDate,
      basicSalary: employeeContractsTable.basicSalary,
      housingAllow: employeeContractsTable.housingAllow,
      transportAllow: employeeContractsTable.transportAllow,
      otherAllow: employeeContractsTable.otherAllow,
      vacationDays: employeeContractsTable.vacationDays,
      probationDays: employeeContractsTable.probationDays,
      noticePeriod: employeeContractsTable.noticePeriod,
      status: employeeContractsTable.status,
      empCode: employeesTable.code,
      empNameAr: employeesTable.nameAr,
      jobTitle: employeesTable.jobTitle,
      nationality: employeesTable.nationality,
    }).from(employeeContractsTable)
      .leftJoin(employeesTable, eq(employeesTable.id, employeeContractsTable.employeeId))
      .where(and(...conds))
      .orderBy(desc(employeeContractsTable.startDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ATTENDANCE ───────────────────────────────────────────────
function calcWorkedHours(checkIn?: string, checkOut?: string): { worked: number; overtime: number } {
  if (!checkIn || !checkOut) return { worked: 0, overtime: 0 };
  const [h1, m1] = checkIn.split(":").map(Number);
  const [h2, m2] = checkOut.split(":").map(Number);
  if (isNaN(h1) || isNaN(h2)) return { worked: 0, overtime: 0 };
  let mins = (h2 * 60 + (m2 || 0)) - (h1 * 60 + (m1 || 0));
  if (mins < 0) mins += 24 * 60;
  const worked = +(mins / 60).toFixed(2);
  const overtime = +Math.max(0, worked - 8).toFixed(2);
  return { worked: Math.min(worked, 8), overtime };
}

router.get("/attendance/list", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { date: d, employeeId, from, to } = req.query as any;
    const conds: any[] = [eq(employeeAttendanceTable.companyId, cid)];
    if (d) conds.push(eq(employeeAttendanceTable.date, String(d)));
    if (employeeId) conds.push(eq(employeeAttendanceTable.employeeId, Number(employeeId)));
    if (from) conds.push(gte(employeeAttendanceTable.date, String(from)));
    if (to) conds.push(lte(employeeAttendanceTable.date, String(to)));
    const rows = await db.select({
      id: employeeAttendanceTable.id,
      employeeId: employeeAttendanceTable.employeeId,
      date: employeeAttendanceTable.date,
      checkIn: employeeAttendanceTable.checkIn,
      checkOut: employeeAttendanceTable.checkOut,
      workedHours: employeeAttendanceTable.workedHours,
      overtimeHours: employeeAttendanceTable.overtimeHours,
      lateMinutes: employeeAttendanceTable.lateMinutes,
      status: employeeAttendanceTable.status,
      notes: employeeAttendanceTable.notes,
      empCode: employeesTable.code,
      empNameAr: employeesTable.nameAr,
    }).from(employeeAttendanceTable)
      .leftJoin(employeesTable, eq(employeesTable.id, employeeAttendanceTable.employeeId))
      .where(and(...conds))
      .orderBy(desc(employeeAttendanceTable.date), asc(employeeAttendanceTable.employeeId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/attendance", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body || {};
    if (!b.employeeId || !b.date) { res.status(400).json({ error: "الموظف والتاريخ مطلوبان" }); return; }
    const date = requireDate(b.date, "تاريخ الحضور");
    await assertDayOpen(cid, date);
    await assertPeriodNotTransferred(cid, date);
    const checkIn = timeOrNull(b.checkIn, "وقت الحضور");
    const checkOut = timeOrNull(b.checkOut, "وقت الانصراف");
    const { worked, overtime } = calcWorkedHours(checkIn ?? undefined, checkOut ?? undefined);
    const status = b.status || (checkIn ? "present" : "absent");
    try {
      const [row] = await db.insert(employeeAttendanceTable).values({
        companyId: cid,
        employeeId: Number(b.employeeId),
        date,
        checkIn,
        checkOut,
        workedHours: String(worked),
        overtimeHours: String(overtime),
        lateMinutes: intOrDefault(b.lateMinutes, 0, "دقائق التأخير", 0, 1440),
        status,
        notes: N(b.notes),
      }).returning();
      res.status(201).json(row);
    } catch (e: any) {
      if (String(e.message).includes("uq_attendance_emp_date")) {
        res.status(409).json({ error: "يوجد سجل حضور لهذا الموظف في هذا التاريخ" }); return;
      }
      throw e;
    }
  } catch (e: any) { respondHrError(req, res, e); }
});

router.put("/attendance/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    const [existingAtt] = await db.select({ date: employeeAttendanceTable.date }).from(employeeAttendanceTable)
      .where(and(eq(employeeAttendanceTable.id, id), eq(employeeAttendanceTable.companyId, cid)));
    if (!existingAtt) { res.status(404).json({ error: "سجل الحضور غير موجود" }); return; }
    await assertDayOpen(cid, existingAtt.date);
    await assertPeriodNotTransferred(cid, existingAtt.date);
    const checkIn = timeOrNull(b.checkIn, "وقت الحضور");
    const checkOut = timeOrNull(b.checkOut, "وقت الانصراف");
    const { worked, overtime } = calcWorkedHours(checkIn ?? undefined, checkOut ?? undefined);
    const [row] = await db.update(employeeAttendanceTable).set({
      checkIn,
      checkOut,
      workedHours: String(worked),
      overtimeHours: String(overtime),
      lateMinutes: intOrDefault(b.lateMinutes, 0, "دقائق التأخير", 0, 1440),
      status: b.status || "present",
      notes: N(b.notes),
      updatedAt: new Date(),
    }).where(and(eq(employeeAttendanceTable.id, id), eq(employeeAttendanceTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

router.delete("/attendance/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const [attRow] = await db.select({ date: employeeAttendanceTable.date }).from(employeeAttendanceTable)
      .where(and(eq(employeeAttendanceTable.id, Number(req.params.id)), eq(employeeAttendanceTable.companyId, cid)));
    if (attRow) {
      await assertDayOpen(cid, attRow.date);
      await assertPeriodNotTransferred(cid, attRow.date);
    }
    await db.delete(employeeAttendanceTable)
      .where(and(eq(employeeAttendanceTable.id, Number(req.params.id)), eq(employeeAttendanceTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { respondHrError(req, res, e); }
});

router.post("/attendance/bulk", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { date: rawDate, records } = req.body as any;
    if (!rawDate || !Array.isArray(records)) { res.status(400).json({ error: "التاريخ والسجلات مطلوبة" }); return; }
    const d = requireDate(rawDate, "تاريخ الحضور");
    await assertDayOpen(cid, d);
    await assertPeriodNotTransferred(cid, d);
    const out: any[] = [];
    for (const r of records) {
      if (!r.employeeId) continue;
      const rIn = timeOrNull(r.checkIn, "وقت الحضور");
      const rOut = timeOrNull(r.checkOut, "وقت الانصراف");
      const { worked, overtime } = calcWorkedHours(rIn ?? undefined, rOut ?? undefined);
      const status = r.status || (rIn ? "present" : "absent");
      try {
        const [row] = await db.insert(employeeAttendanceTable).values({
          companyId: cid,
          employeeId: Number(r.employeeId),
          date: d,
          checkIn: rIn,
          checkOut: rOut,
          workedHours: String(worked),
          overtimeHours: String(overtime),
          lateMinutes: intOrDefault(r.lateMinutes, 0, "دقائق التأخير", 0, 1440),
          status,
          notes: N(r.notes),
        }).onConflictDoUpdate({
          target: [employeeAttendanceTable.employeeId, employeeAttendanceTable.date],
          set: {
            checkIn: rIn,
            checkOut: rOut,
            workedHours: String(worked),
            overtimeHours: String(overtime),
            lateMinutes: intOrDefault(r.lateMinutes, 0, "دقائق التأخير", 0, 1440),
            status,
            notes: N(r.notes),
            updatedAt: new Date(),
          },
        }).returning();
        out.push(row);
      } catch {}
    }
    res.json({ saved: out.length, records: out });
  } catch (e: any) { respondHrError(req, res, e); }
});

// ─── LOANS ────────────────────────────────────────────────────
router.get("/loans/list", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { employeeId, status } = req.query as any;
    const conds: any[] = [eq(employeeLoansTable.companyId, cid)];
    if (employeeId) conds.push(eq(employeeLoansTable.employeeId, Number(employeeId)));
    if (status) conds.push(eq(employeeLoansTable.status, String(status)));
    const rows = await db.select({
      id: employeeLoansTable.id,
      employeeId: employeeLoansTable.employeeId,
      loanDate: employeeLoansTable.loanDate,
      loanType: employeeLoansTable.loanType,
      amount: employeeLoansTable.amount,
      installments: employeeLoansTable.installments,
      installmentAmt: employeeLoansTable.installmentAmt,
      installmentStartDate: employeeLoansTable.installmentStartDate,
      installmentEndDate: employeeLoansTable.installmentEndDate,
      paidAmount: employeeLoansTable.paidAmount,
      status: employeeLoansTable.status,
      reason: employeeLoansTable.reason,
      notes: employeeLoansTable.notes,
      loanAccountId: employeeLoansTable.loanAccountId,
      empCode: employeesTable.code,
      empNameAr: employeesTable.nameAr,
      empNameEn: employeesTable.nameEn,
      empBankName: employeesTable.bankName,
      empBankIban: employeesTable.bankAccountIban,
    }).from(employeeLoansTable)
      .leftJoin(employeesTable, eq(employeesTable.id, employeeLoansTable.employeeId))
      .where(and(...conds))
      .orderBy(desc(employeeLoansTable.loanDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/loans", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body || {};
    if (!b.employeeId || !b.amount || !b.loanDate) { res.status(400).json({ error: "الموظف والمبلغ والتاريخ مطلوبة" }); return; }
    const loanDate = requireDate(b.loanDate, "تاريخ السلفة");
    const amtStr = requirePositiveMoney(b.amount, "مبلغ السلفة");
    const amt = Number(amtStr);
    const installments = intOrDefault(b.installments, 1, "عدد الأقساط", 1, 600);
    const instRaw = b.installmentAmt != null && b.installmentAmt !== "" ? Number(moneyOrZero(b.installmentAmt, "قيمة القسط")) : 0;
    const inst = instRaw > 0 ? instRaw : +(amt / installments).toFixed(2);
    const instStart = dateOrNull(b.installmentStartDate, "تاريخ بداية الأقساط");
    const instEnd = dateOrNull(b.installmentEndDate, "تاريخ نهاية الأقساط");
    assertDateOrder(instStart, instEnd, "تاريخ نهاية الأقساط لا يمكن أن يسبق تاريخ بدايتها");
    const loanAccountId = await validateLoanAccount(cid, b.loanAccountId);
    const [row] = await db.insert(employeeLoansTable).values({
      companyId: cid,
      employeeId: Number(b.employeeId),
      loanDate,
      loanType: b.loanType || "loan",
      amount: String(amt),
      installments,
      installmentAmt: String(inst),
      installmentStartDate: instStart,
      installmentEndDate: instEnd,
      paidAmount: "0",
      status: "active",
      reason: N(b.reason),
      notes: N(b.notes),
      loanAccountId,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === "BAD_LOAN_ACCOUNT") return res.status(400).json({ error: e.message });
    respondHrError(req, res, e);
  }
});

// Disburse an existing loan — creates a journal entry (DR loans receivable / CR cash or bank)
router.post("/loans/:id/disburse", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    const result = await db.transaction(async (tx) => {
      const [loan] = await tx.select().from(employeeLoansTable)
        .where(and(eq(employeeLoansTable.id, id), eq(employeeLoansTable.companyId, cid)));
      if (!loan) throw Object.assign(new Error("السلفة غير موجودة"), { status: 404 });
      if ((loan.notes || "").includes("JE#")) throw new Error("تم صرف هذه السلفة بالفعل");
      const journalId = await buildLoanDisbursementJournal(cid, id, {
        cashBoxId:     b.cashBoxId     ? Number(b.cashBoxId)     : null,
        bankAccountId: b.bankAccountId ? Number(b.bankAccountId) : null,
      }, tx);
      const [upd] = await tx.update(employeeLoansTable)
        .set({ notes: `JE#${journalId}${loan.notes ? " — " + loan.notes : ""}`, updatedAt: new Date() })
        .where(eq(employeeLoansTable.id, id)).returning();
      return { ...upd, journalId };
    });
    res.json(result);
  } catch (e: any) { res.status(e?.status || 400).json({ error: e.message }); }
});

// EOS payment — creates a journal entry and stamps the employee end date
router.post("/:id/eos-pay", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const empId = Number(req.params.id);
    const b = req.body || {};
    const amount = Number(requirePositiveMoney(b.amount, "قيمة المكافأة"));
    const payDate = dateOrNull(b.payDate, "تاريخ الصرف") || new Date().toISOString().slice(0, 10);
    const useProvision = !!b.useProvision;
    const result = await db.transaction(async (tx) => {
      const journalId = await buildEosPaymentJournal(cid, empId, amount, payDate, {
        cashBoxId:     b.cashBoxId     ? Number(b.cashBoxId)     : null,
        bankAccountId: b.bankAccountId ? Number(b.bankAccountId) : null,
      }, { useProvision, description: b.description }, tx);
      if (b.endEmployment) {
        await tx.update(employeesTable)
          .set({ status: "terminated", endDate: payDate, updatedAt: new Date() })
          .where(and(eq(employeesTable.id, empId), eq(employeesTable.companyId, cid)));
      }
      return { ok: true, journalId };
    });
    res.json(result);
  } catch (e: any) {
    if (e?.name === "HrValidationError" || e?.status) return respondHrError(req, res, e);
    res.status(400).json({ error: e.message });
  }
});

router.put("/loans/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    const [existing] = await db.select().from(employeeLoansTable)
      .where(and(eq(employeeLoansTable.id, id), eq(employeeLoansTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "السلفة غير موجودة" }); return; }

    // ── Integrity guard ──────────────────────────────────────────────
    // Once a loan is disbursed (notes carry the JE# marker) its posted
    // disbursement journal entry debited loans-receivable for the original
    // principal/employee — changing those would desync the GL. A closed
    // (cancelled/completed) loan is terminal: its whole schedule is frozen.
    // We only reject fields that ACTUALLY change vs. the stored value, so the
    // form can still resend unchanged values while editing the allowed ones.
    const isDisbursed = (existing.notes || "").includes("JE#");
    const isClosed = existing.status === "cancelled" || existing.status === "completed";
    const numChanged = (key: keyof typeof existing, v: any) =>
      v != null && Number(v) !== Number((existing as any)[key] ?? 0);
    const strChanged = (key: keyof typeof existing, v: any) =>
      v !== undefined && (v == null ? "" : String(v)) !== ((existing as any)[key] ?? "");
    const violations: string[] = [];
    if (isDisbursed || isClosed) {
      if (numChanged("amount", b.amount)) violations.push("amount");
      if (numChanged("employeeId", b.employeeId)) violations.push("employeeId");
      if (strChanged("loanDate", b.loanDate)) violations.push("loanDate");
      if (strChanged("loanType", b.loanType)) violations.push("loanType");
      if (numChanged("loanAccountId", b.loanAccountId)) violations.push("loanAccountId");
    }
    if (isClosed) {
      if (numChanged("installments", b.installments)) violations.push("installments");
      if (numChanged("installmentAmt", b.installmentAmt)) violations.push("installmentAmt");
      if (strChanged("installmentStartDate", b.installmentStartDate)) violations.push("installmentStartDate");
      if (strChanged("installmentEndDate", b.installmentEndDate)) violations.push("installmentEndDate");
    }
    if (violations.length) {
      res.status(409).json({
        error: isClosed
          ? "لا يمكن تعديل سلفة مُلغاة أو منتهية."
          : "لا يمكن تعديل المبلغ أو الموظف أو التاريخ بعد صرف السلفة (لارتباطها بقيد محاسبي). يمكنك تعديل جدول الأقساط والملاحظات فقط.",
        code: "LOAN_EDIT_LOCKED",
        fields: violations,
      });
      return;
    }

    const upd: any = { updatedAt: new Date() };
    // Quick status/payment patches (used by cancel + payroll deduction).
    if (b.status) upd.status = b.status;
    if (b.paidAmount != null) upd.paidAmount = moneyOrZero(b.paidAmount, "المبلغ المسدد");
    // Full edit-form fields.
    if (b.employeeId != null) upd.employeeId = Number(b.employeeId);
    if (b.loanDate != null) upd.loanDate = requireDate(b.loanDate, "تاريخ السلفة");
    if (b.loanType != null) upd.loanType = b.loanType;
    if (b.amount != null) upd.amount = requirePositiveMoney(b.amount, "مبلغ السلفة");
    if (b.installments != null) upd.installments = intOrDefault(b.installments, 1, "عدد الأقساط", 1, 600);
    if (b.installmentAmt != null) upd.installmentAmt = moneyOrZero(b.installmentAmt, "قيمة القسط");
    if (b.installmentStartDate !== undefined) upd.installmentStartDate = dateOrNull(b.installmentStartDate, "تاريخ بداية الأقساط");
    if (b.installmentEndDate !== undefined) upd.installmentEndDate = dateOrNull(b.installmentEndDate, "تاريخ نهاية الأقساط");
    assertDateOrder(upd.installmentStartDate ?? null, upd.installmentEndDate ?? null, "تاريخ نهاية الأقساط لا يمكن أن يسبق تاريخ بدايتها");
    if (b.loanAccountId !== undefined) upd.loanAccountId = await validateLoanAccount(cid, b.loanAccountId);
    if (b.reason !== undefined) upd.reason = N(b.reason);
    // Preserve the disbursement marker (JE#…) so editing the loan from the
    // form never strips the link to its disbursement journal entry.
    if (b.notes !== undefined) {
      let notes = b.notes == null ? null : String(b.notes);
      const jeMatch = (existing.notes || "").match(/JE#\d+/);
      if (jeMatch && !(notes || "").includes(jeMatch[0])) {
        notes = notes ? `${jeMatch[0]} — ${notes}` : jeMatch[0];
      }
      upd.notes = notes;
    }
    const [row] = await db.update(employeeLoansTable).set(upd)
      .where(and(eq(employeeLoansTable.id, id), eq(employeeLoansTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) {
    if (e?.code === "BAD_LOAN_ACCOUNT") return res.status(400).json({ error: e.message });
    respondHrError(req, res, e);
  }
});

router.delete("/loans/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    await db.delete(employeeLoansTable)
      .where(and(eq(employeeLoansTable.id, Number(req.params.id)), eq(employeeLoansTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── END OF SERVICE CALC (Saudi Labor Law Article 84) ─────────
router.get("/:id/end-of-service", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const empId = Number(req.params.id);
    const reason = String((req.query as any).reason || "resignation"); // resignation | termination
    const [emp] = await db.select().from(employeesTable)
      .where(and(eq(employeesTable.id, empId), eq(employeesTable.companyId, cid)));
    if (!emp) { res.status(404).json({ error: "غير موجود" }); return; }
    if (!emp.hireDate) { res.status(400).json({ error: "تاريخ التعيين غير مسجل" }); return; }

    const hire = new Date(emp.hireDate);
    const end = emp.endDate ? new Date(emp.endDate) : new Date();
    const ms = end.getTime() - hire.getTime();
    const years = ms / (365.25 * 86400000);
    const basic = Number(emp.basicSalary || 0);
    const housing = Number(emp.housingAllow || 0);
    const transport = Number(emp.transportAllow || 0);
    const monthly = basic + housing + transport; // الأجر الشامل لاحتساب المكافأة
    const halfMonth = monthly / 2;

    // المادة 84: نصف شهر عن كل سنة من السنوات الخمس الأولى + شهر كامل عن كل سنة بعد ذلك
    let firstFive = Math.min(years, 5);
    let after = Math.max(0, years - 5);
    let gross = (firstFive * halfMonth) + (after * monthly);

    // المادة 85: عند الاستقالة — أقل من سنتين: لا شيء، 2-5: ثلث، 5-10: ثلثان، 10+: كاملة
    let factor = 1;
    let factorReason = "إنهاء من قِبَل صاحب العمل: المكافأة كاملة (المادة 84).";
    if (reason === "resignation") {
      if (years < 2) { factor = 0; factorReason = "استقالة قبل سنتين: لا توجد مكافأة (المادة 85)."; }
      else if (years < 5) { factor = 1/3; factorReason = "استقالة بين 2-5 سنوات: ثلث المكافأة (المادة 85)."; }
      else if (years < 10) { factor = 2/3; factorReason = "استقالة بين 5-10 سنوات: ثلثا المكافأة (المادة 85)."; }
      else { factor = 1; factorReason = "استقالة بعد 10 سنوات: المكافأة كاملة (المادة 85)."; }
    }
    const net = +(gross * factor).toFixed(2);

    res.json({
      hireDate: emp.hireDate,
      endDate: emp.endDate || end.toISOString().slice(0, 10),
      yearsOfService: +years.toFixed(2),
      basicSalary: basic,
      housingAllow: housing,
      transportAllow: transport,
      monthlySalary: monthly,
      grossEntitlement: +gross.toFixed(2),
      reason,
      factor,
      factorReason,
      netAmount: net,
      breakdown: {
        firstFiveYears: +firstFive.toFixed(2),
        afterFiveYears: +after.toFixed(2),
        firstFiveAmount: +(firstFive * halfMonth).toFixed(2),
        afterFiveAmount: +(after * monthly).toFixed(2),
      },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Effective-dated project / cost-center assignments ─────────────────────
router.get("/:id/assignments", requirePermission("hr_employees", "view"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const employeeId = Number(req.params.id);
    const rows = await db.select({
      id: employeeProjectAssignmentsTable.id, companyId: employeeProjectAssignmentsTable.companyId,
      employeeId: employeeProjectAssignmentsTable.employeeId, projectId: employeeProjectAssignmentsTable.projectId,
      costCenterId: employeeProjectAssignmentsTable.costCenterId, effectiveFrom: employeeProjectAssignmentsTable.effectiveFrom,
      effectiveTo: employeeProjectAssignmentsTable.effectiveTo, notes: employeeProjectAssignmentsTable.notes,
      createdAt: employeeProjectAssignmentsTable.createdAt, updatedAt: employeeProjectAssignmentsTable.updatedAt,
      projectCode: contractingProjectsTable.code, projectNameAr: contractingProjectsTable.nameAr,
      projectNameEn: contractingProjectsTable.nameEn, costCenterCode: costCentersTable.code,
      costCenterNameAr: costCentersTable.nameAr, costCenterNameEn: costCentersTable.nameEn,
    }).from(employeeProjectAssignmentsTable)
      .leftJoin(contractingProjectsTable, eq(employeeProjectAssignmentsTable.projectId, contractingProjectsTable.id))
      .leftJoin(costCentersTable, eq(employeeProjectAssignmentsTable.costCenterId, costCentersTable.id))
      .where(and(eq(employeeProjectAssignmentsTable.companyId, cid), eq(employeeProjectAssignmentsTable.employeeId, employeeId)))
      .orderBy(desc(employeeProjectAssignmentsTable.effectiveFrom));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/:id/assignments", requirePermission("hr_employees", "edit"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const employeeId = Number(req.params.id), b = req.body || {};
    const from = isoDate(b.effectiveFrom), to = b.effectiveTo ? isoDate(b.effectiveTo) : null;
    const projectId = b.projectId == null || b.projectId === "" ? null : Number(b.projectId);
    const costCenterId = b.costCenterId == null || b.costCenterId === "" ? null : Number(b.costCenterId);
    if (!employeeId || !/^\d{4}-\d\d-\d\d$/.test(from) || (to && (!/^\d{4}-\d\d-\d\d$/.test(to) || to < from)) || (!projectId && !costCenterId)) {
      res.status(400).json({ error: "بيانات التكليف أو التواريخ غير صالحة" }); return;
    }
    const row = await db.transaction(async (tx) => {
      // Serializes two admins moving the same employee at once.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${cid}, ${employeeId})`);
      const [employee] = await tx.select({ id: employeesTable.id }).from(employeesTable)
        .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid)));
      if (!employee) throw Object.assign(new Error("الموظف غير موجود في هذه الشركة"), { status: 404 });
      if (projectId) {
        const [p] = await tx.select({ id: contractingProjectsTable.id }).from(contractingProjectsTable)
          .where(and(eq(contractingProjectsTable.id, projectId), eq(contractingProjectsTable.companyId, cid)));
        if (!p) throw new Error("المشروع لا يتبع الشركة");
      }
      if (costCenterId) {
        const [c] = await tx.select({ id: costCentersTable.id }).from(costCentersTable)
          .where(and(eq(costCentersTable.id, costCenterId), eq(costCentersTable.companyId, cid)));
        if (!c) throw new Error("مركز التكلفة لا يتبع الشركة");
      }
      const existing = await tx.select().from(employeeProjectAssignmentsTable).where(and(
        eq(employeeProjectAssignmentsTable.companyId, cid), eq(employeeProjectAssignmentsTable.employeeId, employeeId),
      )).for("update");
      // A new transfer closes a prior assignment; future/contained periods are
      // still rejected rather than silently corrupting their effective dates.
      const previous = existing.find(a => isoDate(a.effectiveFrom) < from && (!a.effectiveTo || isoDate(a.effectiveTo) >= from));
      if (previous) {
        if (to && previous.effectiveTo && isoDate(previous.effectiveTo) <= to) throw new Error("فترة التكليف تتداخل مع تكليف قائم");
        await tx.update(employeeProjectAssignmentsTable).set({ effectiveTo: addDays(from, -1), updatedAt: new Date() })
          .where(eq(employeeProjectAssignmentsTable.id, previous.id));
      }
      const overlap = existing.find(a => a.id !== previous?.id && isoDate(a.effectiveFrom) <= (to || "9999-12-31") && (!a.effectiveTo || isoDate(a.effectiveTo) >= from));
      if (overlap) throw new Error("فترة التكليف تتداخل مع تكليف قائم");
      const [created] = await tx.insert(employeeProjectAssignmentsTable).values({
        companyId: cid, employeeId, projectId, costCenterId, effectiveFrom: from, effectiveTo: to, notes: N(b.notes),
      }).returning();
      return created;
    });
    res.status(201).json(row);
  } catch (e: any) { res.status(e?.status || 400).json({ error: e.message }); }
});

router.delete("/:id/assignments/:assignmentId", requirePermission("hr_employees", "edit"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const employeeId = Number(req.params.id), assignmentId = Number(req.params.assignmentId);
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${cid}, ${employeeId})`);
      const [assignment] = await tx.select().from(employeeProjectAssignmentsTable).where(and(
        eq(employeeProjectAssignmentsTable.id, assignmentId), eq(employeeProjectAssignmentsTable.employeeId, employeeId),
        eq(employeeProjectAssignmentsTable.companyId, cid),
      )).for("update");
      if (!assignment) throw Object.assign(new Error("التكليف غير موجود"), { status: 404 });
      const snapshots = await tx.select().from(payrollAllocationSnapshotsTable).where(and(
        eq(payrollAllocationSnapshotsTable.companyId, cid), eq(payrollAllocationSnapshotsTable.employeeId, employeeId),
      ));
      const used = snapshots.some(s => assignmentRepresentedBySnapshot(assignment, s));
      if (used) throw new Error("لا يمكن حذف تكليف ممثل في لقطة مسير رواتب؛ استخدم مسار تصحيح/فك ترحيل المسير");
      const [deleted] = await tx.delete(employeeProjectAssignmentsTable).where(eq(employeeProjectAssignmentsTable.id, assignmentId)).returning();
      return deleted;
    });
    res.json(row);
  } catch (e: any) { res.status(e?.status || 400).json({ error: e.message }); }
});

// ─── PAYROLL ──────────────────────────────────────────────────
router.get("/payroll/runs", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(payrollRunsTable)
      .where(eq(payrollRunsTable.companyId, cid))
      .orderBy(desc(payrollRunsTable.year), desc(payrollRunsTable.month));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/payroll/runs/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [run] = await db.select().from(payrollRunsTable)
      .where(and(eq(payrollRunsTable.id, id), eq(payrollRunsTable.companyId, cid)));
    if (!run) { res.status(404).json({ error: "غير موجود" }); return; }
    const lines = await db.select({
      id: payrollLinesTable.id,
      employeeId: payrollLinesTable.employeeId,
      basicSalary: payrollLinesTable.basicSalary,
      housingAllow: payrollLinesTable.housingAllow,
      transportAllow: payrollLinesTable.transportAllow,
      otherAllow: payrollLinesTable.otherAllow,
      overtimeAmount: payrollLinesTable.overtimeAmount,
      bonusAmount: payrollLinesTable.bonusAmount,
      grossSalary: payrollLinesTable.grossSalary,
      gosiEmployee: payrollLinesTable.gosiEmployee,
      loanDeduction: payrollLinesTable.loanDeduction,
      violationDeduction: payrollLinesTable.violationDeduction,
      absenceDeduction: payrollLinesTable.absenceDeduction,
      otherDeduction: payrollLinesTable.otherDeduction,
      totalDeductions: payrollLinesTable.totalDeductions,
      netSalary: payrollLinesTable.netSalary,
      workedDays: payrollLinesTable.workedDays,
      absentDays: payrollLinesTable.absentDays,
      notes: payrollLinesTable.notes,
      empCode: employeesTable.code,
      empNameAr: employeesTable.nameAr,
      iban: employeesTable.bankAccountIban,
    }).from(payrollLinesTable)
      .leftJoin(employeesTable, eq(employeesTable.id, payrollLinesTable.employeeId))
      .where(eq(payrollLinesTable.payrollRunId, id))
      .orderBy(asc(employeesTable.code));
    res.json({ ...run, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/payroll/preview", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { year, month } = req.body || {};
    if (!year || !month) { res.status(400).json({ error: "السنة والشهر مطلوبان" }); return; }
    const y = intOrDefault(year, 0, "السنة", 2000, 2100);
    const m = intOrDefault(month, 0, "الشهر", 1, 12);
    const periodStart = `${y}-${String(m).padStart(2,"0")}-01`;
    const periodEnd = new Date(y, m, 0).toISOString().slice(0, 10);
    const monthDays = new Date(y, m, 0).getDate();

    const emps = await db.select().from(employeesTable)
      .where(and(eq(employeesTable.companyId, cid), eq(employeesTable.status, "active")))
      .orderBy(asc(employeesTable.code));

    const lines = [];
    let totalGross = 0, totalDed = 0, totalNet = 0;

    for (const e of emps) {
      const basic = Number(e.basicSalary || 0);
      const housing = Number(e.housingAllow || 0);
      const transport = Number(e.transportAllow || 0);
      const other = Number(e.otherAllow || 0);

      // Attendance: count absent days + overtime
      const att = await db.select({
        status: employeeAttendanceTable.status,
        overtimeHours: employeeAttendanceTable.overtimeHours,
      }).from(employeeAttendanceTable)
        .where(and(
          eq(employeeAttendanceTable.companyId, cid),
          eq(employeeAttendanceTable.employeeId, e.id),
          gte(employeeAttendanceTable.date, periodStart),
          lte(employeeAttendanceTable.date, periodEnd),
        ));
      const absentDays = att.filter(a => a.status === "absent").length;
      const overtimeHours = att.reduce((s, a) => s + Number(a.overtimeHours || 0), 0);
      const workedDays = monthDays - absentDays;

      // Saudi labor: overtime = hourly rate × 1.5
      const hourlyRate = basic / (monthDays * 8);
      const overtimeAmount = +(overtimeHours * hourlyRate * 1.5).toFixed(2);

      // Absence deduction = (basic / monthDays) × absentDays
      const absenceDeduction = +((basic / monthDays) * absentDays).toFixed(2);

      // Active loans: sum of installmentAmt for active loans
      const activeLoans = await db.select({
        amount: employeeLoansTable.amount,
        installmentAmt: employeeLoansTable.installmentAmt,
        paidAmount: employeeLoansTable.paidAmount,
      }).from(employeeLoansTable)
        .where(and(
          eq(employeeLoansTable.companyId, cid),
          eq(employeeLoansTable.employeeId, e.id),
          eq(employeeLoansTable.status, "active"),
        ));
      let loanDeduction = 0;
      for (const l of activeLoans) {
        const remaining = Number(l.amount) - Number(l.paidAmount);
        loanDeduction += Math.min(Number(l.installmentAmt), remaining);
      }
      loanDeduction = +loanDeduction.toFixed(2);

      // Registered violations flagged "خصم من الراتب" and not yet deducted.
      const pendingViolations = await db.select({ amount: employeeViolationsTable.amount })
        .from(employeeViolationsTable)
        .where(and(
          eq(employeeViolationsTable.companyId, cid),
          eq(employeeViolationsTable.employeeId, e.id),
          eq(employeeViolationsTable.status, "pending"),
          eq(employeeViolationsTable.deductFromSalary, true),
        ));
      const violationDeduction = +pendingViolations.reduce((s, v) => s + Number(v.amount || 0), 0).toFixed(2);

      // GOSI: Saudis only — 10% employee on (basic + housing), capped at 45,000 base
      const isSaudi = /(سعود|saudi)/i.test(e.nationality || "");
      let gosiEmployee = 0;
      if (isSaudi) {
        const base = Math.min(basic + housing, 45000);
        gosiEmployee = +(base * 0.10).toFixed(2);
      }

      const gross = +(basic + housing + transport + other + overtimeAmount).toFixed(2);
      const totalDeductions = +(gosiEmployee + loanDeduction + violationDeduction + absenceDeduction).toFixed(2);
      const net = +(gross - totalDeductions).toFixed(2);

      lines.push({
        employeeId: e.id,
        empCode: e.code, empNameAr: e.nameAr, iban: e.bankAccountIban,
        basicSalary: basic, housingAllow: housing, transportAllow: transport, otherAllow: other,
        overtimeAmount, bonusAmount: 0,
        grossSalary: gross,
        gosiEmployee, loanDeduction, violationDeduction, absenceDeduction, otherDeduction: 0,
        totalDeductions, netSalary: net,
        workedDays, absentDays,
        overtimeHours: +overtimeHours.toFixed(2),
        isSaudi,
      });
      totalGross += gross; totalDed += totalDeductions; totalNet += net;
    }

    res.json({
      year: y, month: m, periodStart, periodEnd, monthDays,
      lines,
      totals: { gross: +totalGross.toFixed(2), deductions: +totalDed.toFixed(2), net: +totalNet.toFixed(2), employeesCount: lines.length },
    });
  } catch (e: any) { respondHrError(req, res, e); }
});

router.post("/payroll/runs", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body || {};
    const { year, month, lines, payDate, notes, branchId } = b;
    if (!year || !month || !Array.isArray(lines)) { res.status(400).json({ error: "بيانات غير مكتملة" }); return; }
    const y = intOrDefault(year, 0, "السنة", 2000, 2100);
    const m = intOrDefault(month, 0, "الشهر", 1, 12);
    const periodStart = `${y}-${String(m).padStart(2,"0")}-01`;
    const periodEnd = new Date(y, m, 0).toISOString().slice(0, 10);
    const code = `PR-${y}${String(m).padStart(2,"0")}`;
    // Default branch: stamp it on the run so the JE that posting later builds
    // is visible in branch-scoped reports. Resolution rules:
    //   - If the caller passed branchId, intersect against their allowed scope
    //     (a restricted user picking a forbidden branch is rejected with 403).
    //   - If they didn't pass one and they're restricted to a single branch,
    //     use that branch implicitly.
    //   - Always verify the chosen branch belongs to this company.
    const requestedRaw = (branchId == null || branchId === "") ? undefined : Number(branchId);
    const intersected = intersectBranchRequest(req as any, requestedRaw ?? null);
    if (intersected === "deny") { res.status(403).json({ error: "غير مصرح بالوصول إلى هذا الفرع" }); return; }
    const allowedBranches = (req as any).authUser?.branchIds as number[] | undefined;
    const viewAll = (req as any).authUser?.viewAllBranches === true
      || ["admin","superadmin"].includes((req as any).authUser?.role);
    let resolvedBranchId: number | null = null;
    if (typeof intersected === "number") {
      resolvedBranchId = intersected;
    } else if (!viewAll && allowedBranches?.length === 1) {
      resolvedBranchId = allowedBranches[0];
    }
    if (resolvedBranchId != null) {
      const [br] = await db.select({ id: branchesTable.id }).from(branchesTable)
        .where(and(eq(branchesTable.id, resolvedBranchId), eq(branchesTable.companyId, cid)));
      if (!br) { res.status(400).json({ error: "الفرع غير موجود في هذه الشركة" }); return; }
    }

    try {
      const run = await db.transaction(async (tx) => {
      // Server-authoritative violation consumption: lock the pending
      // salary-deduction violations of the run's employees (FOR UPDATE) and
      // derive each line's violationDeduction from the LOCKED rows — never
      // trust the client's previewed figure (a violation may have been
      // edited/waived between preview and save). Line totals/net are adjusted
      // by the delta so the run always reconciles with what gets consumed.
      const empIds = lines.map((l: any) => Number(l.employeeId)).filter(Number.isInteger);
      const uniqueEmpIds = [...new Set(empIds)];
      if (!lines.length || empIds.length !== lines.length || uniqueEmpIds.length !== lines.length) {
        throw Object.assign(new Error("يجب أن يحتوي المسير على سطر واحد صالح لكل موظف"), { status: 400 });
      }
      const ownedEmployees = await tx.select({ id: employeesTable.id }).from(employeesTable)
        .where(and(
          eq(employeesTable.companyId, cid),
          inArray(employeesTable.id, uniqueEmpIds),
        ));
      if (ownedEmployees.length !== uniqueEmpIds.length) {
        throw Object.assign(new Error("أحد الموظفين لا يتبع هذه الشركة"), { status: 400 });
      }
      const lockedViolations = empIds.length
        ? await tx.select({ id: employeeViolationsTable.id, employeeId: employeeViolationsTable.employeeId, amount: employeeViolationsTable.amount })
            .from(employeeViolationsTable)
            .where(and(
              eq(employeeViolationsTable.companyId, cid),
              eq(employeeViolationsTable.status, "pending"),
              eq(employeeViolationsTable.deductFromSalary, true),
              inArray(employeeViolationsTable.employeeId, empIds),
            )).for("update")
        : [];
      const violByEmp = new Map<number, number>();
      for (const v of lockedViolations) {
        violByEmp.set(v.employeeId, +( (violByEmp.get(v.employeeId) || 0) + Number(v.amount || 0) ).toFixed(2));
      }
      for (const l of lines) {
        const server = violByEmp.get(Number(l.employeeId)) || 0;
        const client = Number(l.violationDeduction || 0);
        const delta = +(server - client).toFixed(2);
        l.violationDeduction = server;
        l.totalDeductions = +(Number(l.totalDeductions || 0) + delta).toFixed(2);
        l.netSalary = +(Number(l.netSalary || 0) - delta).toFixed(2);
      }

      let totalGross = 0, totalDed = 0, totalNet = 0;
      for (const l of lines) {
        totalGross += Number(l.grossSalary || 0);
        totalDed += Number(l.totalDeductions || 0);
        totalNet += Number(l.netSalary || 0);
      }

      const [run] = await tx.insert(payrollRunsTable).values({
        companyId: cid,
        branchId: resolvedBranchId,
        code,
        year: y, month: m,
        periodStart, periodEnd,
        payDate: dateOrNull(payDate, "تاريخ الصرف"),
        totalGross: String(totalGross.toFixed(2)),
        totalDeductions: String(totalDed.toFixed(2)),
        totalNet: String(totalNet.toFixed(2)),
        employeesCount: lines.length,
        status: "draft",
        notes: N(notes),
      }).returning();
      const [company] = await tx.select({ payrollCostBasis: companiesTable.payrollCostBasis })
        .from(companiesTable).where(eq(companiesTable.id, cid));
      const costBasis = ["gross", "net", "basic"].includes(company?.payrollCostBasis || "")
        ? company!.payrollCostBasis! : "gross";

      for (const l of lines) {
        const [payrollLine] = await tx.insert(payrollLinesTable).values({
          payrollRunId: run.id,
          employeeId: Number(l.employeeId),
          basicSalary: String(l.basicSalary || 0),
          housingAllow: String(l.housingAllow || 0),
          transportAllow: String(l.transportAllow || 0),
          otherAllow: String(l.otherAllow || 0),
          overtimeAmount: String(l.overtimeAmount || 0),
          bonusAmount: String(l.bonusAmount || 0),
          grossSalary: String(l.grossSalary || 0),
          gosiEmployee: String(l.gosiEmployee || 0),
          loanDeduction: String(l.loanDeduction || 0),
          violationDeduction: String(l.violationDeduction || 0),
          absenceDeduction: String(l.absenceDeduction || 0),
          otherDeduction: String(l.otherDeduction || 0),
          totalDeductions: String(l.totalDeductions || 0),
          netSalary: String(l.netSalary || 0),
          workedDays: Number(l.workedDays || 30),
          absentDays: Number(l.absentDays || 0),
          notes: N(l.notes),
        }).returning();
        const assignments = await tx.select().from(employeeProjectAssignmentsTable).where(and(
          eq(employeeProjectAssignmentsTable.companyId, cid),
          eq(employeeProjectAssignmentsTable.employeeId, Number(l.employeeId)),
          lte(employeeProjectAssignmentsTable.effectiveFrom, periodEnd),
        ));
        // The final date condition is expressed in JS too so NULL (open ended)
        // is handled uniformly by all supported Drizzle/Postgres versions.
        const activeAssignments = assignments.filter(a => !a.effectiveTo || isoDate(a.effectiveTo) >= periodStart);
        const basisAmount = costBasis === "basic" ? Number(l.basicSalary || 0)
          : costBasis === "net" ? Number(l.netSalary || 0)
          : Number(l.grossSalary || 0);
        const snapshots = allocationBuckets(activeAssignments, periodStart, periodEnd, basisAmount);
        for (const s of snapshots) {
          await tx.insert(payrollAllocationSnapshotsTable).values({
            companyId: cid, payrollRunId: run.id, payrollLineId: payrollLine.id, employeeId: Number(l.employeeId),
            projectId: s.projectId, costCenterId: s.costCenterId, periodStart: s.periodStart, periodEnd: s.periodEnd,
            days: s.days, costBasis, basisAmount: String(basisAmount.toFixed(2)), allocatedAmount: s.allocatedAmount,
          });
        }
      }
      // Consume EXACTLY the locked violations (reverted if the draft run is
      // deleted). Marking by id keeps the run-line ↔ violation reconciliation
      // exact even under concurrent violation creation.
      if (lockedViolations.length) {
        await tx.update(employeeViolationsTable)
          .set({ status: "deducted", payrollRunId: run.id, updatedAt: new Date() })
          .where(inArray(employeeViolationsTable.id, lockedViolations.map((v) => v.id)));
      }
      return run;
      });
      res.status(201).json(run);
    } catch (e: any) {
      if (String(e.message).includes("uq_payroll_company_period")) {
        res.status(409).json({ error: "يوجد مسير لهذا الشهر بالفعل" }); return;
      }
      throw e;
    }
  } catch (e: any) { respondHrError(req, res, e); }
});

router.post("/payroll/runs/:id/post", requirePostRight("payroll"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const result = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(payrollRunsTable)
        .where(and(eq(payrollRunsTable.id, id), eq(payrollRunsTable.companyId, cid)));
      if (!run) throw Object.assign(new Error("غير موجود"), { status: 404 });
      if (run.status !== "draft") throw new Error("المسير ليس مسودة");

      // Update loan paidAmounts
      const lines = await tx.select().from(payrollLinesTable)
        .where(eq(payrollLinesTable.payrollRunId, id));
      for (const l of lines) {
        if (Number(l.loanDeduction) > 0) {
          const activeLoans = await tx.select().from(employeeLoansTable)
            .where(and(
              eq(employeeLoansTable.companyId, cid),
              eq(employeeLoansTable.employeeId, l.employeeId),
              eq(employeeLoansTable.status, "active"),
            )).orderBy(asc(employeeLoansTable.loanDate));
          let remaining = Number(l.loanDeduction);
          for (const loan of activeLoans) {
            if (remaining <= 0) break;
            const loanRemain = Number(loan.amount) - Number(loan.paidAmount);
            const pay = Math.min(remaining, loanRemain);
            const newPaid = +(Number(loan.paidAmount) + pay).toFixed(2);
            const status = newPaid >= Number(loan.amount) ? "completed" : "active";
            await tx.update(employeeLoansTable)
              .set({ paidAmount: String(newPaid), status, updatedAt: new Date() })
              .where(eq(employeeLoansTable.id, loan.id));
            remaining -= pay;
          }
        }
      }

      // Build the accounting journal entry — any error rolls back loan updates too
      const journalId = await buildPayrollJournal(cid, id, tx);
      const [upd] = await tx.update(payrollRunsTable)
        .set({ status: "posted", postedJournalId: journalId, updatedAt: new Date() })
        .where(eq(payrollRunsTable.id, id)).returning();
      return { ...upd, journalId };
    });
    res.json(result);
  } catch (e: any) {
    res.status(e?.status || 400).json({ error: e.message });
  }
});

// Get the JE attached to a payroll run (if posted)
router.get("/payroll/runs/:id/journal", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [run] = await db.select().from(payrollRunsTable)
      .where(and(eq(payrollRunsTable.id, id), eq(payrollRunsTable.companyId, cid)));
    if (!run?.postedJournalId) { res.status(404).json({ error: "لا يوجد قيد لهذا المسير" }); return; }
    const [entry] = await db.select().from(journalEntriesTable)
      .where(eq(journalEntriesTable.id, run.postedJournalId));
    const lines = await db.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, run.postedJournalId))
      .orderBy(asc(journalEntryLinesTable.sortOrder));
    res.json({ entry, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Unpost a payroll run — deletes its JE and reverts loan paidAmounts
router.post("/payroll/runs/:id/unpost", requireUnpostRight("payroll"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // One transaction with a FOR UPDATE row lock: serializes against a
    // concurrent /pay so a payment JE can never attach to a run that is
    // being reverted to draft (and vice-versa). Loan reversal rides the
    // same tx so a failure rolls everything back together.
    const upd = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(payrollRunsTable)
        .where(and(eq(payrollRunsTable.id, id), eq(payrollRunsTable.companyId, cid)))
        .for("update");
      if (!run) throw Object.assign(new Error("غير موجود"), { status: 404 });
      if (run.status !== "posted") throw Object.assign(new Error("المسير ليس معتمداً"), { status: 400 });
      if (run.paymentJournalId) throw Object.assign(new Error("تم صرف رواتب هذا المسير — قم بفك ترحيل قيد الصرف أولاً"), { status: 409 });

      // Reverse loan paidAmounts
      const lines = await tx.select().from(payrollLinesTable).where(eq(payrollLinesTable.payrollRunId, id));
      for (const l of lines) {
        if (Number(l.loanDeduction) > 0) {
          const loans = await tx.select().from(employeeLoansTable)
            .where(and(eq(employeeLoansTable.companyId, cid), eq(employeeLoansTable.employeeId, l.employeeId)))
            .orderBy(desc(employeeLoansTable.loanDate));
          let toReverse = Number(l.loanDeduction);
          for (const loan of loans) {
            if (toReverse <= 0) break;
            const paid = Number(loan.paidAmount);
            const give = Math.min(toReverse, paid);
            const newPaid = +(paid - give).toFixed(2);
            await tx.update(employeeLoansTable)
              .set({ paidAmount: String(newPaid), status: newPaid >= Number(loan.amount) ? "completed" : "active", updatedAt: new Date() })
              .where(eq(employeeLoansTable.id, loan.id));
            toReverse -= give;
          }
        }
      }
      if (run.postedJournalId) {
        // Stash the JE number so re-approving the run reuses it (no sequence gap).
        await reserveJeNumberFromEntry(cid, "payroll_run", id, run.postedJournalId, tx as any);
        await tx.delete(journalEntriesTable).where(eq(journalEntriesTable.id, run.postedJournalId));
      }
      const [row] = await tx.update(payrollRunsTable)
        .set({ status: "draft", postedJournalId: null, updatedAt: new Date() })
        .where(eq(payrollRunsTable.id, id)).returning();
      return row;
    });
    res.json(upd);
  } catch (e: any) { res.status(e?.status || 500).json({ error: e.message }); }
});

// ─── PAY (صرف الرواتب) — DR salaries payable / CR cash|bank ─────────────────
router.post("/payroll/runs/:id/pay", requirePostRight("payroll"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    const result = await db.transaction(async (tx) => {
      // FOR UPDATE lock: prevents two concurrent pay clicks double-posting.
      const [run] = await tx.select().from(payrollRunsTable)
        .where(and(eq(payrollRunsTable.id, id), eq(payrollRunsTable.companyId, cid)))
        .for("update");
      if (!run) throw Object.assign(new Error("غير موجود"), { status: 404 });
      if (run.status !== "posted") throw Object.assign(new Error("يجب اعتماد المسير أولاً"), { status: 400 });
      if (run.paymentJournalId) throw Object.assign(new Error("تم صرف رواتب هذا المسير بالفعل"), { status: 409 });

      // Payment source: explicit body wins, else the HR default cash box/bank.
      let source = {
        cashBoxId:     b.cashBoxId     ? Number(b.cashBoxId)     : null,
        bankAccountId: b.bankAccountId ? Number(b.bankAccountId) : null,
      };
      if (!source.cashBoxId && !source.bankAccountId) {
        const accounts = await resolveHrAccounts(cid, false, tx);
        source = { cashBoxId: accounts.defaultPayCashBoxId, bankAccountId: accounts.defaultPayBankAccountId };
        // If both defaults are set, prefer the bank (salaries are normally bank-paid).
        if (source.cashBoxId && source.bankAccountId) source = { cashBoxId: null, bankAccountId: source.bankAccountId };
      }

      const payDate = typeof b.payDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.payDate)
        ? b.payDate
        : new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10); // KSA today

      const journalId = await buildPayrollPaymentJournal(cid, id, payDate, source, tx);
      const [upd] = await tx.update(payrollRunsTable)
        .set({ paymentJournalId: journalId, payDate, updatedAt: new Date() })
        .where(eq(payrollRunsTable.id, id)).returning();
      return { ...upd, journalId };
    });
    res.json(result);
  } catch (e: any) {
    res.status(e?.status || 400).json({ error: e.message });
  }
});

// ─── UNPAY (فك ترحيل قيد صرف الرواتب) ────────────────────────────────────────
router.post("/payroll/runs/:id/unpay", requireUnpostRight("payroll"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const result = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(payrollRunsTable)
        .where(and(eq(payrollRunsTable.id, id), eq(payrollRunsTable.companyId, cid)))
        .for("update");
      if (!run) throw Object.assign(new Error("غير موجود"), { status: 404 });
      if (!run.paymentJournalId) throw Object.assign(new Error("لا يوجد قيد صرف لهذا المسير"), { status: 400 });
      // Stash the JE number so re-paying reuses it (no sequence gap).
      await reserveJeNumberFromEntry(cid, "payroll_pay", id, run.paymentJournalId, tx as any);
      await tx.delete(journalEntriesTable).where(and(
        eq(journalEntriesTable.id, run.paymentJournalId),
        eq(journalEntriesTable.companyId, cid),
      ));
      const [upd] = await tx.update(payrollRunsTable)
        .set({ paymentJournalId: null, updatedAt: new Date() })
        .where(eq(payrollRunsTable.id, id)).returning();
      return upd;
    });
    res.json(result);
  } catch (e: any) {
    res.status(e?.status || 400).json({ error: e.message });
  }
});

router.delete("/payroll/runs/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [run] = await db.select().from(payrollRunsTable)
      .where(and(eq(payrollRunsTable.id, id), eq(payrollRunsTable.companyId, cid)));
    if (!run) { res.status(404).json({ error: "غير موجود" }); return; }
    if (run.status !== "draft") { res.status(400).json({ error: "لا يمكن حذف مسير معتمد" }); return; }
    // Release the violations this draft run had consumed + delete atomically.
    await db.transaction(async (tx) => {
      await tx.update(employeeViolationsTable)
        .set({ status: "pending", payrollRunId: null, updatedAt: new Date() })
        .where(and(
          eq(employeeViolationsTable.companyId, cid),
          eq(employeeViolationsTable.payrollRunId, id),
        ));
      await tx.delete(payrollRunsTable).where(eq(payrollRunsTable.id, id));
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── HR CALCULATORS (Saudi Labor Law) ─────────────────────────
const round2 = (n: number) => Math.round(n * 100) / 100;

// Annual leave (Article 109): 21 days < 5y, 30 days >= 5y, pro-rated
router.post("/calc/annual-leave", async (req, res) => {
  try {
    const { hireDate, asOfDate, daysTaken = 0, basicSalary = 0, housingAllow = 0, transportAllow = 0 } = req.body as any;
    if (!hireDate) { res.status(400).json({ error: "تاريخ التعيين مطلوب" }); return; }
    const hire = new Date(hireDate);
    const asOf = asOfDate ? new Date(asOfDate) : new Date();
    if (asOf < hire) { res.status(400).json({ error: "التاريخ يجب أن يكون بعد تاريخ التعيين" }); return; }
    const totalDays = (asOf.getTime() - hire.getTime()) / 86400000;
    const totalYears = totalDays / 365.25;
    const fullYears = Math.floor(totalYears);
    const yearStart = new Date(hire); yearStart.setFullYear(hire.getFullYear() + fullYears);
    const daysInCurrent = (asOf.getTime() - yearStart.getTime()) / 86400000;
    const ratePerYear = totalYears >= 5 ? 30 : 21;
    const ratePerYearAfter5 = 30;
    const accruedFull = (totalYears < 5)
      ? totalYears * 21
      : (5 * 21) + ((totalYears - 5) * 30);
    const dailyWage = (Number(basicSalary) + Number(housingAllow) + Number(transportAllow)) / 30;
    const remaining = round2(accruedFull - Number(daysTaken));
    const cashValue = round2(remaining > 0 ? remaining * dailyWage : 0);
    res.json({
      hireDate, asOfDate: asOf.toISOString().slice(0, 10),
      yearsOfService: round2(totalYears),
      ratePerYearCurrent: ratePerYear,
      noteTransition: totalYears >= 5 ? "تجاوز 5 سنوات → 30 يوم/سنة" : `أقل من 5 سنوات → 21 يوم/سنة (يتحول إلى 30 بعد ${(5 - totalYears).toFixed(2)} سنة)`,
      accruedDaysTotal: round2(accruedFull),
      daysTaken: Number(daysTaken),
      remainingDays: remaining,
      currentYearAccrual: round2((daysInCurrent / 365.25) * (totalYears < 5 ? 21 : ratePerYearAfter5)),
      dailyWage: round2(dailyWage),
      cashValueIfPaid: cashValue,
      legalRef: "المادة 109 من نظام العمل السعودي",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Sick leave (Article 117): year window 30 full + 60 at 75% + 30 unpaid
router.post("/calc/sick-leave", async (req, res) => {
  try {
    const { daysTaken, basicSalary = 0, housingAllow = 0 } = req.body as any;
    const d = Math.max(0, Number(daysTaken || 0));
    const dailyWage = (Number(basicSalary) + Number(housingAllow)) / 30;
    const fullPaidDays = Math.min(d, 30);
    const partialPaidDays = Math.min(Math.max(d - 30, 0), 60);
    const unpaidDays = Math.min(Math.max(d - 90, 0), 30);
    const beyondLimit = Math.max(d - 120, 0);
    const fullPay = round2(fullPaidDays * dailyWage);
    const partialPay = round2(partialPaidDays * dailyWage * 0.75);
    const totalPay = round2(fullPay + partialPay);
    const lostWages = round2(unpaidDays * dailyWage + (partialPaidDays * dailyWage * 0.25));
    res.json({
      daysTaken: d,
      dailyWage: round2(dailyWage),
      fullPaidDays, partialPaidDays, unpaidDays, beyondLimit,
      fullPay, partialPay, totalPay, lostWages,
      remainingFull: Math.max(0, 30 - d),
      remainingPartial: Math.max(0, 90 - d),
      remainingTotal: Math.max(0, 120 - d),
      warning: beyondLimit > 0 ? `تجاوز 120 يوم — لصاحب العمل الحق في إنهاء العقد وفق المادة 82.` : null,
      legalRef: "المادة 117 من نظام العمل السعودي",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Overtime (Article 107)
router.post("/calc/overtime", async (req, res) => {
  try {
    const { basicSalary = 0, housingAllow = 0, transportAllow = 0,
            workingDaysPerMonth = 30, hoursPerDay = 8, overtimeHours = 0,
            isHoliday = false } = req.body as any;
    const monthlyWage = Number(basicSalary) + Number(housingAllow) + Number(transportAllow);
    const dailyWage = monthlyWage / Number(workingDaysPerMonth);
    const hourlyWage = dailyWage / Number(hoursPerDay);
    const multiplier = isHoliday ? 1.5 : 1.5;
    const overtimeAmount = round2(Number(overtimeHours) * hourlyWage * multiplier);
    res.json({
      monthlyWage: round2(monthlyWage),
      dailyWage: round2(dailyWage),
      hourlyWage: round2(hourlyWage),
      overtimeHours: Number(overtimeHours),
      multiplier,
      overtimeAmount,
      formula: `${Number(overtimeHours)} × ${round2(hourlyWage)} × ${multiplier} = ${overtimeAmount} ر.س`,
      legalRef: "المادة 107 — أجر الساعة الإضافية = أجر الساعة العادية + 50% منه",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GOSI (full breakdown)
router.post("/calc/gosi", async (req, res) => {
  try {
    const { basicSalary = 0, housingAllow = 0, isSaudi = false } = req.body as any;
    const wage = Number(basicSalary) + Number(housingAllow);
    const cap = 45000;
    const gosiWage = Math.min(wage, cap);
    const employeeShare = isSaudi ? round2(gosiWage * 0.10) : 0;
    const employerAnnuities = isSaudi ? round2(gosiWage * 0.12) : 0;
    const employerOH = round2(gosiWage * 0.02);
    const totalEmployer = round2(employerAnnuities + employerOH);
    res.json({
      wageBeforeCap: round2(wage),
      gosiWage: round2(gosiWage),
      cap, isSaudi,
      employeeShare,
      employerAnnuities,
      employerOccupationalHazards: employerOH,
      totalEmployer,
      totalCost: round2(employeeShare + totalEmployer),
      netToEmployee: round2(wage - employeeShare),
      capApplied: wage > cap,
      legalRef: isSaudi
        ? "10% خصم من الموظف + 12% معاشات + 2% أخطار مهنية على صاحب العمل (سعودي)."
        : "2% فقط أخطار مهنية على صاحب العمل (غير سعودي)، لا خصم على الموظف.",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Notice period compensation (Article 75)
router.post("/calc/notice-period", async (req, res) => {
  try {
    const { basicSalary = 0, housingAllow = 0, transportAllow = 0,
            requiredNoticeDays = 60, daysActuallyGiven = 0 } = req.body as any;
    const monthlyWage = Number(basicSalary) + Number(housingAllow) + Number(transportAllow);
    const dailyWage = monthlyWage / 30;
    const compensationDays = Math.max(0, Number(requiredNoticeDays) - Number(daysActuallyGiven));
    const compensationAmount = round2(compensationDays * dailyWage);
    res.json({
      monthlyWage: round2(monthlyWage),
      dailyWage: round2(dailyWage),
      requiredNoticeDays: Number(requiredNoticeDays),
      daysActuallyGiven: Number(daysActuallyGiven),
      compensationDays,
      compensationAmount,
      formula: `${compensationDays} يوم × ${round2(dailyWage)} ر.س = ${compensationAmount} ر.س`,
      legalRef: "المادة 75 — العقد غير محدد المدة يُنهى بإشعار 60 يوم من صاحب العمل، 30 يوم من العامل.",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Probation period status (Article 53)
router.post("/calc/probation", async (req, res) => {
  try {
    const { hireDate, probationDays = 90, asOfDate } = req.body as any;
    if (!hireDate) { res.status(400).json({ error: "تاريخ التعيين مطلوب" }); return; }
    const pd = Math.min(Number(probationDays), 180);
    const hire = new Date(hireDate);
    const asOf = asOfDate ? new Date(asOfDate) : new Date();
    const probationEnd = new Date(hire); probationEnd.setDate(hire.getDate() + pd);
    const elapsed = Math.floor((asOf.getTime() - hire.getTime()) / 86400000);
    const remaining = Math.floor((probationEnd.getTime() - asOf.getTime()) / 86400000);
    const status = remaining > 0 ? "underProbation" : "completed";
    res.json({
      hireDate, probationDays: pd,
      probationEndDate: probationEnd.toISOString().slice(0, 10),
      daysElapsed: elapsed,
      daysRemaining: Math.max(0, remaining),
      status,
      statusLabel: status === "underProbation" ? `تحت التجربة — متبقي ${Math.max(0, remaining)} يوم` : `أكملت فترة التجربة منذ ${Math.abs(remaining)} يوم`,
      legalRef: "المادة 53 — الحد الأقصى لفترة التجربة 90 يوماً، يجوز تمديدها باتفاق كتابي حتى 180 يوماً.",
      warning: pd > 90 ? "⚠ فترة التجربة تتجاوز 90 يوماً — تتطلب اتفاقاً كتابياً صريحاً." : null,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
