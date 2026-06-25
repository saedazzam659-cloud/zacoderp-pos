import { Router } from "express";
import { db } from "@workspace/db";
import { employeesTable, employeeContractsTable, employeeLeavesTable, employeeAttendanceTable, employeeLoansTable, payrollRunsTable, payrollLinesTable, branchesTable, accountsTable } from "@workspace/db";
import { and, eq, asc, desc, sql, lte, gte, or, isNotNull } from "drizzle-orm";
import { extractAuth, resolveCompanyId, intersectBranchRequest } from "../middleware/auth.js";
import { nextSequenceOrFallback } from "../lib/sequences.js";
import { requireAdminRole } from "../middleware/permissions.js";
import { buildPayrollJournal, buildLoanDisbursementJournal, buildEosPaymentJournal } from "../lib/hr-journals.js";
import { journalEntriesTable, journalEntryLinesTable } from "@workspace/db";

const router = Router();
router.use(extractAuth);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

const N = (v: any) => (v == null || v === "" ? null : v);

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

// ─── EMPLOYEES ───────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(employeesTable)
      .where(eq(employeesTable.companyId, cid))
      .orderBy(asc(employeesTable.code));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/alerts", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const today = new Date();
    const in90 = new Date(today.getTime() + 90 * 86400000);
    const todayStr = today.toISOString().slice(0, 10);
    const in90Str = in90.toISOString().slice(0, 10);

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
        lte(employeeContractsTable.endDate, in90Str),
      )).orderBy(asc(employeeContractsTable.endDate));

    const expPassports = await db.select({
      id: employeesTable.id, code: employeesTable.code, nameAr: employeesTable.nameAr,
      passportExpiry: employeesTable.passportExpiry, passportNumber: employeesTable.passportNumber,
    }).from(employeesTable)
      .where(and(
        eq(employeesTable.companyId, cid),
        isNotNull(employeesTable.passportExpiry),
        lte(employeesTable.passportExpiry, in90Str),
        eq(employeesTable.status, "active"),
      )).orderBy(asc(employeesTable.passportExpiry));

    const daysLeft = (d: string) => Math.ceil((new Date(d).getTime() - today.getTime()) / 86400000);
    const tag = (rows: any[], field: string) =>
      rows.map(r => ({ ...r, daysLeft: daysLeft(r[field]) }));

    res.json({
      expiringIqamas:    tag(expIqamas, "iqamaExpiry"),
      expiringContracts: tag(expContracts, "endDate"),
      expiringPassports: tag(expPassports, "passportExpiry"),
      todayStr, in90Str,
    });
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
    res.json({ ...row, contracts, leaves });
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
    if (b.idNumber) {
      const dup = await db.select({ id: employeesTable.id }).from(employeesTable)
        .where(and(eq(employeesTable.companyId, cid), eq(employeesTable.idNumber, String(b.idNumber))));
      if (dup.length) { res.status(400).json({ error: "رقم الهوية/الإقامة مكرر" }); return; }
    }
    const [row] = await db.insert(employeesTable).values({
      companyId: cid,
      branchId: N(b.branchId) ? Number(b.branchId) : null,
      code,
      nameAr: String(b.nameAr).trim(),
      nameEn: N(b.nameEn),
      idType: b.idType || "iqama",
      idNumber: N(b.idNumber),
      iqamaExpiry: N(b.iqamaExpiry),
      passportNumber: N(b.passportNumber),
      passportExpiry: N(b.passportExpiry),
      nationality: N(b.nationality),
      gender: N(b.gender),
      birthDate: N(b.birthDate),
      mobile: N(b.mobile),
      email: N(b.email),
      hireDate: N(b.hireDate),
      endDate: N(b.endDate),
      department: N(b.department),
      jobTitle: N(b.jobTitle),
      sponsor: N(b.sponsor),
      profession: N(b.profession),
      status: b.status || "active",
      basicSalary: String(b.basicSalary ?? 0),
      housingAllow: String(b.housingAllow ?? 0),
      transportAllow: String(b.transportAllow ?? 0),
      otherAllow: String(b.otherAllow ?? 0),
      bankAccountIban: N(b.bankAccountIban),
      bankName: N(b.bankName),
      payableAccountId: N(b.payableAccountId) ? Number(b.payableAccountId) : null,
      photoUrl: N(b.photoUrl),
      notes: N(b.notes),
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message).includes("uq_employees_company_idnumber"))
      return res.status(400).json({ error: "رقم الهوية/الإقامة مكرر" });
    if (String(e?.message).includes("uq_employees_company_code"))
      return res.status(400).json({ error: "كود الموظف مكرر" });
    res.status(500).json({ error: e.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    if (b.idNumber) {
      const dup = await db.select({ id: employeesTable.id }).from(employeesTable)
        .where(and(eq(employeesTable.companyId, cid), eq(employeesTable.idNumber, String(b.idNumber))));
      if (dup.some((d: any) => d.id !== id)) { res.status(400).json({ error: "رقم الهوية/الإقامة مكرر" }); return; }
    }
    const updates: any = { updatedAt: new Date() };
    const fields = ["branchId","nameAr","nameEn","idType","idNumber","iqamaExpiry","passportNumber","passportExpiry",
      "nationality","gender","birthDate","mobile","email","hireDate","endDate","department","jobTitle","sponsor",
      "profession","status","bankAccountIban","bankName","photoUrl","notes"];
    for (const f of fields) if (f in b) updates[f] = N(b[f]);
    for (const f of ["basicSalary","housingAllow","transportAllow","otherAllow"])
      if (f in b) updates[f] = String(b[f] ?? 0);
    if ("payableAccountId" in b) updates.payableAccountId = N(b.payableAccountId) ? Number(b.payableAccountId) : null;
    if ("branchId" in b) updates.branchId = N(b.branchId) ? Number(b.branchId) : null;

    const [row] = await db.update(employeesTable).set(updates)
      .where(and(eq(employeesTable.id, id), eq(employeesTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json(row);
  } catch (e: any) {
    if (String(e?.message).includes("uq_employees_company_idnumber"))
      return res.status(400).json({ error: "رقم الهوية/الإقامة مكرر" });
    res.status(500).json({ error: e.message });
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

    const [row] = await db.insert(employeeContractsTable).values({
      companyId: cid,
      employeeId: empId,
      contractNumber: cn,
      contractType: b.contractType || "fixed",
      startDate: b.startDate,
      endDate: N(b.endDate),
      basicSalary: String(b.basicSalary ?? 0),
      housingAllow: String(b.housingAllow ?? 0),
      transportAllow: String(b.transportAllow ?? 0),
      otherAllow: String(b.otherAllow ?? 0),
      workingHours: Number(b.workingHours ?? 8),
      probationDays: Number(b.probationDays ?? 90),
      noticePeriod: Number(b.noticePeriod ?? 60),
      vacationDays: Number(b.vacationDays ?? 21),
      terms: N(b.terms),
      status: b.status || "active",
      renewedFromId: N(b.renewedFromId) ? Number(b.renewedFromId) : null,
      notes: N(b.notes),
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
      startDate: b.startDate || new Date().toISOString().slice(0, 10),
      endDate: N(b.endDate),
      basicSalary: b.basicSalary ?? old.basicSalary,
      housingAllow: b.housingAllow ?? old.housingAllow,
      transportAllow: b.transportAllow ?? old.transportAllow,
      otherAllow: b.otherAllow ?? old.otherAllow,
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/:id/contracts/:contractId", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const cnId = Number(req.params.contractId);
    const b = req.body || {};
    const updates: any = { updatedAt: new Date() };
    const fields = ["contractType","startDate","endDate","status","terms","notes"];
    for (const f of fields) if (f in b) updates[f] = N(b[f]);
    for (const f of ["basicSalary","housingAllow","transportAllow","otherAllow"])
      if (f in b) updates[f] = String(b[f] ?? 0);
    for (const f of ["workingHours","probationDays","noticePeriod","vacationDays"])
      if (f in b) updates[f] = Number(b[f] ?? 0);
    const [row] = await db.update(employeeContractsTable).set(updates)
      .where(and(eq(employeeContractsTable.id, cnId), eq(employeeContractsTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
    const start = new Date(b.startDate);
    const end = new Date(b.endDate);
    const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1);
    const [row] = await db.insert(employeeLeavesTable).values({
      companyId: cid,
      employeeId: empId,
      leaveType: b.leaveType || "annual",
      startDate: b.startDate,
      endDate: b.endDate,
      days: Number(b.days ?? days),
      paid: b.paid !== false,
      status: b.status || "pending",
      reason: N(b.reason),
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
    const { worked, overtime } = calcWorkedHours(b.checkIn, b.checkOut);
    const status = b.status || (b.checkIn ? "present" : "absent");
    try {
      const [row] = await db.insert(employeeAttendanceTable).values({
        companyId: cid,
        employeeId: Number(b.employeeId),
        date: b.date,
        checkIn: N(b.checkIn),
        checkOut: N(b.checkOut),
        workedHours: String(worked),
        overtimeHours: String(overtime),
        lateMinutes: Number(b.lateMinutes || 0),
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/attendance/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    const { worked, overtime } = calcWorkedHours(b.checkIn, b.checkOut);
    const [row] = await db.update(employeeAttendanceTable).set({
      checkIn: N(b.checkIn),
      checkOut: N(b.checkOut),
      workedHours: String(worked),
      overtimeHours: String(overtime),
      lateMinutes: Number(b.lateMinutes || 0),
      status: b.status || "present",
      notes: N(b.notes),
      updatedAt: new Date(),
    }).where(and(eq(employeeAttendanceTable.id, id), eq(employeeAttendanceTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/attendance/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    await db.delete(employeeAttendanceTable)
      .where(and(eq(employeeAttendanceTable.id, Number(req.params.id)), eq(employeeAttendanceTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/attendance/bulk", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { date: d, records } = req.body as any;
    if (!d || !Array.isArray(records)) { res.status(400).json({ error: "التاريخ والسجلات مطلوبة" }); return; }
    const out: any[] = [];
    for (const r of records) {
      if (!r.employeeId) continue;
      const { worked, overtime } = calcWorkedHours(r.checkIn, r.checkOut);
      const status = r.status || (r.checkIn ? "present" : "absent");
      try {
        const [row] = await db.insert(employeeAttendanceTable).values({
          companyId: cid,
          employeeId: Number(r.employeeId),
          date: d,
          checkIn: N(r.checkIn),
          checkOut: N(r.checkOut),
          workedHours: String(worked),
          overtimeHours: String(overtime),
          lateMinutes: Number(r.lateMinutes || 0),
          status,
          notes: N(r.notes),
        }).onConflictDoUpdate({
          target: [employeeAttendanceTable.employeeId, employeeAttendanceTable.date],
          set: {
            checkIn: N(r.checkIn),
            checkOut: N(r.checkOut),
            workedHours: String(worked),
            overtimeHours: String(overtime),
            lateMinutes: Number(r.lateMinutes || 0),
            status,
            notes: N(r.notes),
            updatedAt: new Date(),
          },
        }).returning();
        out.push(row);
      } catch {}
    }
    res.json({ saved: out.length, records: out });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
    const installments = Math.max(1, Number(b.installments || 1));
    const amt = Number(b.amount);
    const inst = Number(b.installmentAmt) > 0 ? Number(b.installmentAmt) : +(amt / installments).toFixed(2);
    const loanAccountId = await validateLoanAccount(cid, b.loanAccountId);
    const [row] = await db.insert(employeeLoansTable).values({
      companyId: cid,
      employeeId: Number(b.employeeId),
      loanDate: b.loanDate,
      loanType: b.loanType || "loan",
      amount: String(amt),
      installments,
      installmentAmt: String(inst),
      installmentStartDate: N(b.installmentStartDate),
      installmentEndDate: N(b.installmentEndDate),
      paidAmount: "0",
      status: "active",
      reason: N(b.reason),
      notes: N(b.notes),
      loanAccountId,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(e?.code === "BAD_LOAN_ACCOUNT" ? 400 : 500).json({ error: e.message }); }
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
    const amount = Number(b.amount);
    const payDate = String(b.payDate || new Date().toISOString().slice(0, 10));
    const useProvision = !!b.useProvision;
    if (!(amount > 0)) { res.status(400).json({ error: "قيمة المكافأة مطلوبة" }); return; }
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
  } catch (e: any) { res.status(400).json({ error: e.message }); }
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
    if (b.paidAmount != null) upd.paidAmount = String(b.paidAmount);
    // Full edit-form fields.
    if (b.employeeId != null) upd.employeeId = Number(b.employeeId);
    if (b.loanDate != null) upd.loanDate = b.loanDate;
    if (b.loanType != null) upd.loanType = b.loanType;
    if (b.amount != null) upd.amount = String(Number(b.amount));
    if (b.installments != null) upd.installments = Math.max(1, Number(b.installments));
    if (b.installmentAmt != null) upd.installmentAmt = String(b.installmentAmt);
    if (b.installmentStartDate !== undefined) upd.installmentStartDate = N(b.installmentStartDate);
    if (b.installmentEndDate !== undefined) upd.installmentEndDate = N(b.installmentEndDate);
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
    const y = Number(year), m = Number(month);
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

      // GOSI: Saudis only — 10% employee on (basic + housing), capped at 45,000 base
      const isSaudi = /(سعود|saudi)/i.test(e.nationality || "");
      let gosiEmployee = 0;
      if (isSaudi) {
        const base = Math.min(basic + housing, 45000);
        gosiEmployee = +(base * 0.10).toFixed(2);
      }

      const gross = +(basic + housing + transport + other + overtimeAmount).toFixed(2);
      const totalDeductions = +(gosiEmployee + loanDeduction + absenceDeduction).toFixed(2);
      const net = +(gross - totalDeductions).toFixed(2);

      lines.push({
        employeeId: e.id,
        empCode: e.code, empNameAr: e.nameAr, iban: e.bankAccountIban,
        basicSalary: basic, housingAllow: housing, transportAllow: transport, otherAllow: other,
        overtimeAmount, bonusAmount: 0,
        grossSalary: gross,
        gosiEmployee, loanDeduction, absenceDeduction, otherDeduction: 0,
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/payroll/runs", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body || {};
    const { year, month, lines, payDate, notes, branchId } = b;
    if (!year || !month || !Array.isArray(lines)) { res.status(400).json({ error: "بيانات غير مكتملة" }); return; }
    const y = Number(year), m = Number(month);
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

    let totalGross = 0, totalDed = 0, totalNet = 0;
    for (const l of lines) {
      totalGross += Number(l.grossSalary || 0);
      totalDed += Number(l.totalDeductions || 0);
      totalNet += Number(l.netSalary || 0);
    }

    try {
      const [run] = await db.insert(payrollRunsTable).values({
        companyId: cid,
        branchId: resolvedBranchId,
        code,
        year: y, month: m,
        periodStart, periodEnd,
        payDate: N(payDate),
        totalGross: String(totalGross.toFixed(2)),
        totalDeductions: String(totalDed.toFixed(2)),
        totalNet: String(totalNet.toFixed(2)),
        employeesCount: lines.length,
        status: "draft",
        notes: N(notes),
      }).returning();

      for (const l of lines) {
        await db.insert(payrollLinesTable).values({
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
          absenceDeduction: String(l.absenceDeduction || 0),
          otherDeduction: String(l.otherDeduction || 0),
          totalDeductions: String(l.totalDeductions || 0),
          netSalary: String(l.netSalary || 0),
          workedDays: Number(l.workedDays || 30),
          absentDays: Number(l.absentDays || 0),
          notes: N(l.notes),
        });
      }
      res.status(201).json(run);
    } catch (e: any) {
      if (String(e.message).includes("uq_payroll_company_period")) {
        res.status(409).json({ error: "يوجد مسير لهذا الشهر بالفعل" }); return;
      }
      throw e;
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/payroll/runs/:id/post", async (req, res) => {
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
router.post("/payroll/runs/:id/unpost", requireAdminRole, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [run] = await db.select().from(payrollRunsTable)
      .where(and(eq(payrollRunsTable.id, id), eq(payrollRunsTable.companyId, cid)));
    if (!run) { res.status(404).json({ error: "غير موجود" }); return; }
    if (run.status !== "posted") { res.status(400).json({ error: "المسير ليس معتمداً" }); return; }

    // Reverse loan paidAmounts
    const lines = await db.select().from(payrollLinesTable).where(eq(payrollLinesTable.payrollRunId, id));
    for (const l of lines) {
      if (Number(l.loanDeduction) > 0) {
        const loans = await db.select().from(employeeLoansTable)
          .where(and(eq(employeeLoansTable.companyId, cid), eq(employeeLoansTable.employeeId, l.employeeId)))
          .orderBy(desc(employeeLoansTable.loanDate));
        let toReverse = Number(l.loanDeduction);
        for (const loan of loans) {
          if (toReverse <= 0) break;
          const paid = Number(loan.paidAmount);
          const give = Math.min(toReverse, paid);
          const newPaid = +(paid - give).toFixed(2);
          await db.update(employeeLoansTable)
            .set({ paidAmount: String(newPaid), status: newPaid >= Number(loan.amount) ? "completed" : "active", updatedAt: new Date() })
            .where(eq(employeeLoansTable.id, loan.id));
          toReverse -= give;
        }
      }
    }
    if (run.postedJournalId) {
      await db.delete(journalEntriesTable).where(eq(journalEntriesTable.id, run.postedJournalId));
    }
    const [upd] = await db.update(payrollRunsTable)
      .set({ status: "draft", postedJournalId: null, updatedAt: new Date() })
      .where(eq(payrollRunsTable.id, id)).returning();
    res.json(upd);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/payroll/runs/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [run] = await db.select().from(payrollRunsTable)
      .where(and(eq(payrollRunsTable.id, id), eq(payrollRunsTable.companyId, cid)));
    if (!run) { res.status(404).json({ error: "غير موجود" }); return; }
    if (run.status !== "draft") { res.status(400).json({ error: "لا يمكن حذف مسير معتمد" }); return; }
    await db.delete(payrollRunsTable).where(eq(payrollRunsTable.id, id));
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
