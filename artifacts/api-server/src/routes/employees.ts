import { Router } from "express";
import { db } from "@workspace/db";
import { employeesTable, employeeContractsTable, employeeLeavesTable } from "@workspace/db";
import { and, eq, asc, desc, sql, lte, gte, or, isNotNull } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

const N = (v: any) => (v == null || v === "" ? null : v);

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
      const [{ c }] = await db.select({ c: sql<number>`count(*)::int` })
        .from(employeesTable).where(eq(employeesTable.companyId, cid));
      code = `EMP-${String((c ?? 0) + 1).padStart(4, "0")}`;
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
      const [{ c }] = await db.select({ c: sql<number>`count(*)::int` })
        .from(employeeContractsTable).where(eq(employeeContractsTable.companyId, cid));
      cn = `CON-${String((c ?? 0) + 1).padStart(5, "0")}`;
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

    const [{ c }] = await db.select({ c: sql<number>`count(*)::int` })
      .from(employeeContractsTable).where(eq(employeeContractsTable.companyId, cid));
    const cn = `CON-${String((c ?? 0) + 1).padStart(5, "0")}`;

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

export default router;
