// HR Core extension (دورة حياة الموظف الكاملة) — additive endpoints only:
//   • الهيكل التنظيمي: hr_departments / hr_positions
//   • تعديلات الرواتب (سجل تاريخي — لا يستبدل الراتب السابق أبداً)
//   • النقل والتكليف (Effective Date + snapshot سابق/جديد + تطبيق على الملف)
//   • التقييمات، جهات الطوارئ، الأسرة والتابعون، المؤهلات، الشهادات
//   • مستودع المستندات، السجل الوظيفي الموحّد، نهاية الخدمة
// قواعد التنفيذ: append-only للتاريخ؛ أي تغيير جوهري يُسجَّل في employee_history؛
// نهاية الخدمة تغيّر حالة الموظف ولا تحذفه.
// mounted at /api/hr-core (see routes/index.ts). Permission: hr_employees
// (salary adjustments additionally respect hr_payroll on the amounts screen —
// route-level gate kept to hr_employees to mirror the profile screen).
import { Router } from "express";
import { db } from "@workspace/db";
import {
  employeesTable,
  hrDepartmentsTable,
  hrPositionsTable,
  employeeSalaryAdjustmentsTable,
  employeeTransfersTable,
  employeeEvaluationsTable,
  employeeEmergencyContactsTable,
  employeeDependentsTable,
  employeeQualificationsTable,
  employeeCertificatesTable,
  employeeMedicalInsurancePoliciesTable,
  employeeDocumentsTable,
  employeeHistoryTable,
  employeeTerminationsTable,
} from "@workspace/db";
import { and, eq, desc, asc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission, type PermAction } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
// صلاحيات: كل المسارات تحت hr_employees حسب نوع العملية — الـ PermRoute في
// الواجهة ليست حماية؛ الحماية هنا على مستوى الـ API.
router.use((req, res, next) => {
  const action: PermAction =
    req.method === "GET" ? "view"
    : req.method === "POST" ? "create"
    : req.method === "DELETE" ? "delete"
    : "edit";
  return requirePermission("hr_employees", action)(req, res, next);
});
// تعديلات الرواتب حساسة — تتطلب أيضاً صلاحية الرواتب.
router.use("/employees/:employeeId/salary-adjustments", (req, res, next) => {
  if (req.method === "GET") return next();
  return requirePermission("hr_payroll", "edit")(req, res, next);
});

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
const N = (v: any) => (v == null || v === "" ? null : v);
const num = (v: any): number => Number(v ?? 0) || 0;
const uid = (req: any): number | null => req.authUser?.id ?? null;
const isoDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\d$/.test(v) ? v : "";
const validIsoDate = (v: unknown) => {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const date = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === v;
};
const todayIso = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const dayBefore = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

async function assertDept(cid: number, deptId: number) {
  const [d] = await db.select({ id: hrDepartmentsTable.id }).from(hrDepartmentsTable)
    .where(and(eq(hrDepartmentsTable.id, deptId), eq(hrDepartmentsTable.companyId, cid)));
  return !!d;
}

async function getEmployee(cid: number, employeeId: number) {
  const [e] = await db.select().from(employeesTable)
    .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid)));
  return e ?? null;
}

async function logHistory(dx: any, row: {
  companyId: number; employeeId: number; eventType: string; eventDate: string;
  prevValue?: any; newValue?: any; reason?: string | null;
  refTable?: string | null; refId?: number | null; userId?: number | null;
}) {
  await dx.insert(employeeHistoryTable).values({
    companyId: row.companyId, employeeId: row.employeeId,
    eventType: row.eventType, eventDate: row.eventDate,
    prevValue: row.prevValue == null ? null : (typeof row.prevValue === "string" ? row.prevValue : JSON.stringify(row.prevValue)),
    newValue:  row.newValue  == null ? null : (typeof row.newValue  === "string" ? row.newValue  : JSON.stringify(row.newValue)),
    reason: row.reason ?? null, refTable: row.refTable ?? null,
    refId: row.refId ?? null, userId: row.userId ?? null,
  });
}

// ═══ الهيكل التنظيمي ════════════════════════════════════════════════════════
router.get("/departments", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(hrDepartmentsTable)
      .where(eq(hrDepartmentsTable.companyId, cid)).orderBy(asc(hrDepartmentsTable.name));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.post("/departments", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { name, parentId, managerEmployeeId, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "اسم الإدارة مطلوب" });
    if (parentId && !(await assertDept(cid, Number(parentId)))) return res.status(400).json({ error: "الإدارة الأعلى غير موجودة" });
    if (managerEmployeeId && !(await getEmployee(cid, Number(managerEmployeeId)))) return res.status(400).json({ error: "المدير غير موجود" });
    const [row] = await db.insert(hrDepartmentsTable).values({
      companyId: cid, name: name.trim(),
      parentId: parentId ? Number(parentId) : null,
      managerEmployeeId: managerEmployeeId ? Number(managerEmployeeId) : null,
      notes: N(notes),
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.put("/departments/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { name, parentId, managerEmployeeId, isActive, notes } = req.body;
    if (parentId && !(await assertDept(cid, Number(parentId)))) return res.status(400).json({ error: "الإدارة الأعلى غير موجودة" });
    if (managerEmployeeId && !(await getEmployee(cid, Number(managerEmployeeId)))) return res.status(400).json({ error: "المدير غير موجود" });
    const [row] = await db.update(hrDepartmentsTable).set({
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(parentId !== undefined ? { parentId: parentId ? Number(parentId) : null } : {}),
      ...(managerEmployeeId !== undefined ? { managerEmployeeId: managerEmployeeId ? Number(managerEmployeeId) : null } : {}),
      ...(isActive !== undefined ? { isActive: !!isActive } : {}),
      ...(notes !== undefined ? { notes: N(notes) } : {}),
    }).where(and(eq(hrDepartmentsTable.id, Number(req.params.id)), eq(hrDepartmentsTable.companyId, cid))).returning();
    if (!row) return res.status(404).json({ error: "غير موجود" });
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.get("/positions", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(hrPositionsTable)
      .where(eq(hrPositionsTable.companyId, cid)).orderBy(asc(hrPositionsTable.title));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.post("/positions", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { title, departmentId, notes } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "المسمى الوظيفي مطلوب" });
    if (departmentId && !(await assertDept(cid, Number(departmentId)))) return res.status(400).json({ error: "الإدارة غير موجودة" });
    const [row] = await db.insert(hrPositionsTable).values({
      companyId: cid, title: title.trim(),
      departmentId: departmentId ? Number(departmentId) : null, notes: N(notes),
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.put("/positions/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { title, departmentId, isActive, notes } = req.body;
    if (departmentId && !(await assertDept(cid, Number(departmentId)))) return res.status(400).json({ error: "الإدارة غير موجودة" });
    const [row] = await db.update(hrPositionsTable).set({
      ...(title !== undefined ? { title: String(title).trim() } : {}),
      ...(departmentId !== undefined ? { departmentId: departmentId ? Number(departmentId) : null } : {}),
      ...(isActive !== undefined ? { isActive: !!isActive } : {}),
      ...(notes !== undefined ? { notes: N(notes) } : {}),
    }).where(and(eq(hrPositionsTable.id, Number(req.params.id)), eq(hrPositionsTable.companyId, cid))).returning();
    if (!row) return res.status(404).json({ error: "غير موجود" });
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══ Generic per-employee sub-resource CRUD ═════════════════════════════════
// Table-driven to keep the file lean; every op is tenant-scoped and the
// mutating ones verify the employee belongs to the company first.
const SUBRESOURCES: Record<string, {
  table: any;
  build: (b: any) => Record<string, any>;
  historyEvent?: string;                  // append to employee_history on create
  historyDate?: (b: any) => string;
  validate?: (values: Record<string, any>) => string | null;
}> = {
  "emergency-contacts": {
    table: employeeEmergencyContactsTable,
    build: (b) => ({
      name: String(b.name ?? "").trim(), relation: N(b.relation), phone: N(b.phone),
      phone2: N(b.phone2), address: N(b.address), email: N(b.email), isPrimary: !!b.isPrimary,
    }),
  },
  "dependents": {
    table: employeeDependentsTable,
    build: (b) => ({
      name: String(b.name ?? "").trim(), relation: N(b.relation), birthDate: N(b.birthDate),
      gender: N(b.gender), idNumber: N(b.idNumber),
      benefitsEligible: !!b.benefitsEligible, notes: N(b.notes),
    }),
  },
  "qualifications": {
    table: employeeQualificationsTable,
    build: (b) => ({
      degree: String(b.degree ?? "").trim(), specialty: N(b.specialty), institution: N(b.institution),
      gradYear: N(b.gradYear), grade: N(b.grade), attachmentUrl: N(b.attachmentUrl),
    }),
  },
  "certificates": {
    table: employeeCertificatesTable,
    build: (b) => ({
      name: String(b.name ?? "").trim(), issuer: N(b.issuer), certNumber: N(b.certNumber),
      issueDate: N(b.issueDate), expiryDate: N(b.expiryDate),
      attachmentUrl: N(b.attachmentUrl), notes: N(b.notes),
    }),
  },
  "medical-insurance": {
    table: employeeMedicalInsurancePoliciesTable,
    build: (b) => ({
      policyNumber: String(b.policyNumber ?? "").trim(),
      insuranceCompany: String(b.insuranceCompany ?? "").trim(),
      coverageDetails: N(b.coverageDetails),
      startDate: N(b.startDate),
      endDate: N(b.endDate),
    }),
    validate: (values) => {
      if (!values.policyNumber || !values.insuranceCompany) return "رقم الوثيقة وشركة التأمين مطلوبان";
      if (!values.startDate || !values.endDate) return "تاريخا بداية وانتهاء التأمين مطلوبان";
      for (const key of ["startDate", "endDate"]) {
        if (values[key] != null && !validIsoDate(values[key])) return "صيغة التاريخ يجب أن تكون YYYY-MM-DD";
      }
      if (values.startDate && values.endDate && values.endDate < values.startDate) {
        return "تاريخ الانتهاء يجب أن يكون بعد أو مساوياً لتاريخ البدء";
      }
      return null;
    },
  },
  "documents": {
    table: employeeDocumentsTable,
    build: (b) => ({
      docType: String(b.docType ?? "").trim(), docNumber: N(b.docNumber),
      issueDate: N(b.issueDate), expiryDate: N(b.expiryDate),
      fileUrl: N(b.fileUrl), notes: N(b.notes),
    }),
  },
  "evaluations": {
    table: employeeEvaluationsTable,
    build: (b) => ({
      periodFrom: N(b.periodFrom), periodTo: N(b.periodTo), evaluator: N(b.evaluator),
      evalDate: b.evalDate, score: b.score != null && b.score !== "" ? String(num(b.score)) : null,
      maxScore: b.maxScore != null && b.maxScore !== "" ? String(num(b.maxScore)) : "100",
      result: N(b.result), strengths: N(b.strengths), weaknesses: N(b.weaknesses),
      recommendations: N(b.recommendations), nextEvalDate: N(b.nextEvalDate), notes: N(b.notes),
    }),
    historyEvent: "evaluation",
    historyDate: (b) => b.evalDate,
  },
};

for (const [key, cfg] of Object.entries(SUBRESOURCES)) {
  router.get(`/employees/:employeeId/${key}`, async (req, res) => {
    try {
      const cid = guard(req, res); if (!cid) return;
      const rows = await db.select().from(cfg.table)
        .where(and(eq(cfg.table.companyId, cid), eq(cfg.table.employeeId, Number(req.params.employeeId))))
        .orderBy(desc(cfg.table.id));
      res.json(rows);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  router.post(`/employees/:employeeId/${key}`, async (req, res) => {
    try {
      const cid = guard(req, res); if (!cid) return;
      const employeeId = Number(req.params.employeeId);
      const emp = await getEmployee(cid, employeeId);
      if (!emp) return res.status(404).json({ error: "الموظف غير موجود" });
      const vals = cfg.build(req.body);
      const requiredKey = Object.keys(vals)[0];
      if (typeof vals[requiredKey] === "string" && !vals[requiredKey]) {
        return res.status(400).json({ error: "الحقل الأساسي مطلوب" });
      }
      const validationError = cfg.validate?.(vals);
      if (validationError) return res.status(400).json({ error: validationError });
      const row = await db.transaction(async (dx) => {
        const r = ((await dx.insert(cfg.table).values({
          companyId: cid, employeeId, ...vals,
          ...("createdBy" in cfg.table ? { createdBy: uid(req) } : {}),
        }).returning()) as any[])[0];
        if (cfg.historyEvent) {
          await logHistory(dx, {
            companyId: cid, employeeId, eventType: cfg.historyEvent,
            eventDate: cfg.historyDate?.(req.body) ?? new Date().toISOString().slice(0, 10),
            newValue: vals, refTable: key, refId: r.id, userId: uid(req),
          });
        }
        return r;
      });
      res.json(row);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  router.put(`/employees/:employeeId/${key}/:id`, async (req, res) => {
    try {
      const cid = guard(req, res); if (!cid) return;
      const employeeId = Number(req.params.employeeId);
      // Merge against the scoped row before validating so a partial update
      // cannot bypass the required fields or reverse an existing date range.
      const current = (await db.select().from(cfg.table).where(and(
        eq(cfg.table.id, Number(req.params.id)),
        eq(cfg.table.companyId, cid),
        eq(cfg.table.employeeId, employeeId),
      )) as any[])[0];
      if (!current) return res.status(404).json({ error: "غير موجود" });
      const values = cfg.build({ ...current, ...req.body });
      const validationError = cfg.validate?.(values);
      if (validationError) return res.status(400).json({ error: validationError });
      const [row] = await db.update(cfg.table).set({
        ...values,
        ...("updatedAt" in cfg.table ? { updatedAt: new Date() } : {}),
      })
        .where(and(
          eq(cfg.table.id, Number(req.params.id)),
          eq(cfg.table.companyId, cid),
          eq(cfg.table.employeeId, employeeId),
        )).returning();
      if (!row) return res.status(404).json({ error: "غير موجود" });
      res.json(row);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  router.delete(`/employees/:employeeId/${key}/:id`, async (req, res) => {
    try {
      const cid = guard(req, res); if (!cid) return;
      const row = ((await db.delete(cfg.table)
        .where(and(
          eq(cfg.table.id, Number(req.params.id)),
          eq(cfg.table.companyId, cid),
          eq(cfg.table.employeeId, Number(req.params.employeeId)),
        )).returning()) as any[])[0];
      if (!row) return res.status(404).json({ error: "غير موجود" });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
}

// ═══ تعديلات الرواتب — الراتب السابق يُحفظ ولا يُستبدل ═══════════════════════
router.get("/employees/:employeeId/salary-adjustments", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(employeeSalaryAdjustmentsTable)
      .where(and(
        eq(employeeSalaryAdjustmentsTable.companyId, cid),
        eq(employeeSalaryAdjustmentsTable.employeeId, Number(req.params.employeeId)),
      )).orderBy(desc(employeeSalaryAdjustmentsTable.effectiveDate), desc(employeeSalaryAdjustmentsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.post("/employees/:employeeId/salary-adjustments", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const employeeId = Number(req.params.employeeId);
    const b = req.body;
    if (!b.effectiveDate) return res.status(400).json({ error: "تاريخ السريان مطلوب" });
    const newBasic = num(b.newBasic);
    if (newBasic <= 0) return res.status(400).json({ error: "الراتب الأساسي الجديد يجب أن يكون أكبر من صفر" });
    const result = await db.transaction(async (dx) => {
      const [emp] = await dx.select().from(employeesTable)
        .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid))).for("update");
      if (!emp) throw Object.assign(new Error("الموظف غير موجود"), { status: 404 });
      const prevBasic = num(emp.basicSalary);
      const prevTotal = prevBasic + num(emp.housingAllow) + num(emp.transportAllow) + num(emp.otherAllow);
      const newHousing   = b.newHousing   != null && b.newHousing   !== "" ? num(b.newHousing)   : num(emp.housingAllow);
      const newTransport = b.newTransport != null && b.newTransport !== "" ? num(b.newTransport) : num(emp.transportAllow);
      const newOther     = b.newOther     != null && b.newOther     !== "" ? num(b.newOther)     : num(emp.otherAllow);
      const newTotal = newBasic + newHousing + newTransport + newOther;
      const amount = +(newTotal - prevTotal).toFixed(2);
      const percent = prevTotal > 0 ? +((amount / prevTotal) * 100).toFixed(3) : 0;
      const today = new Date().toISOString().slice(0, 10);
      const applyNow = String(b.effectiveDate) <= today;
      const [adj] = await dx.insert(employeeSalaryAdjustmentsTable).values({
        companyId: cid, employeeId,
        adjustmentDate: b.adjustmentDate || today,
        effectiveDate: b.effectiveDate,
        prevBasic: prevBasic.toFixed(2), newBasic: newBasic.toFixed(2),
        prevTotal: prevTotal.toFixed(2), newTotal: newTotal.toFixed(2),
        amount: amount.toFixed(2), percent: String(percent),
        newHousing: newHousing.toFixed(2), newTransport: newTransport.toFixed(2), newOther: newOther.toFixed(2),
        reason: N(b.reason), decisionRef: N(b.decisionRef), notes: N(b.notes),
        status: applyNow ? "applied" : "scheduled",
        createdBy: uid(req),
      }).returning();
      // التطبيق الفوري فقط إذا حان تاريخ السريان — المجدول يُطبَّق يدوياً من الشاشة.
      if (applyNow) {
        await dx.update(employeesTable).set({
          basicSalary: newBasic.toFixed(2),
          housingAllow: newHousing.toFixed(2),
          transportAllow: newTransport.toFixed(2),
          otherAllow: newOther.toFixed(2),
          updatedAt: new Date(),
        }).where(eq(employeesTable.id, employeeId));
      }
      await logHistory(dx, {
        companyId: cid, employeeId, eventType: "salary_adjustment",
        eventDate: b.effectiveDate,
        prevValue: { basic: prevBasic, total: prevTotal },
        newValue: { basic: newBasic, total: newTotal, housing: newHousing, transport: newTransport, other: newOther },
        reason: N(b.reason), refTable: "employee_salary_adjustments", refId: adj.id, userId: uid(req),
      });
      return adj;
    });
    res.json(result);
  } catch (e: any) { res.status(e.status || 500).json({ error: e.message }); }
});
// تطبيق تعديل مجدول عندما يحين تاريخه
router.post("/employees/:employeeId/salary-adjustments/:id/apply", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const employeeId = Number(req.params.employeeId);
    const result = await db.transaction(async (dx) => {
      // قفل صف الموظف أولاً لمنع سباق تطبيقين متزامنين.
      const [emp] = await dx.select().from(employeesTable)
        .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid))).for("update");
      if (!emp) throw Object.assign(new Error("الموظف غير موجود"), { status: 404 });
      const [adj] = await dx.select().from(employeeSalaryAdjustmentsTable)
        .where(and(
          eq(employeeSalaryAdjustmentsTable.id, Number(req.params.id)),
          eq(employeeSalaryAdjustmentsTable.companyId, cid),
          eq(employeeSalaryAdjustmentsTable.employeeId, employeeId),
        )).for("update");
      if (!adj) throw Object.assign(new Error("غير موجود"), { status: 404 });
      if (adj.status !== "scheduled") throw Object.assign(new Error("التعديل مطبَّق أو ملغى بالفعل"), { status: 400 });
      if (String(adj.effectiveDate) > new Date().toISOString().slice(0, 10)) {
        throw Object.assign(new Error("لم يحن تاريخ سريان التعديل بعد"), { status: 400 });
      }
      await dx.update(employeesTable).set({
        basicSalary: adj.newBasic,
        ...(adj.newHousing   != null ? { housingAllow:   adj.newHousing }   : {}),
        ...(adj.newTransport != null ? { transportAllow: adj.newTransport } : {}),
        ...(adj.newOther     != null ? { otherAllow:     adj.newOther }     : {}),
        updatedAt: new Date(),
      }).where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid)));
      const [row] = await dx.update(employeeSalaryAdjustmentsTable).set({ status: "applied" })
        .where(eq(employeeSalaryAdjustmentsTable.id, adj.id)).returning();
      await logHistory(dx, {
        companyId: cid, employeeId, eventType: "salary_adjustment",
        eventDate: String(adj.effectiveDate),
        prevValue: { basic: num(emp.basicSalary) }, newValue: { basic: num(adj.newBasic), appliedScheduled: true },
        reason: adj.reason, refTable: "employee_salary_adjustments", refId: adj.id, userId: uid(req),
      });
      return row;
    });
    res.json(result);
  } catch (e: any) { res.status(e.status || 500).json({ error: e.message }); }
});

// ═══ النقل والتكليف ══════════════════════════════════════════════════════════
// أي حركة تُسجَّل كتاريخ وظيفي (snapshot سابق/جديد) — التكليف المؤقت لا يغيّر
// التبعية الأساسية (لا يُطبَّق على ملف الموظف)، والنقل الدائم يُطبَّق فوراً إذا
// حان تاريخ سريانه.
const MOVE_FIELDS: Record<string, keyof typeof employeesTable.$inferSelect> = {
  department: "department", jobTitle: "jobTitle", branchId: "branchId", status: "status",
};
router.get("/employees/:employeeId/transfers", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(employeeTransfersTable)
      .where(and(
        eq(employeeTransfersTable.companyId, cid),
        eq(employeeTransfersTable.employeeId, Number(req.params.employeeId)),
      )).orderBy(desc(employeeTransfersTable.effectiveFrom), desc(employeeTransfersTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.get("/transfers", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select({
      t: employeeTransfersTable,
      empCode: employeesTable.code,
      empName: employeesTable.nameAr,
    }).from(employeeTransfersTable)
      .innerJoin(employeesTable, eq(employeesTable.id, employeeTransfersTable.employeeId))
      .where(eq(employeeTransfersTable.companyId, cid))
      .orderBy(desc(employeeTransfersTable.id))
      .limit(500);
    res.json(rows.map(r => ({ ...r.t, empCode: r.empCode, empName: r.empName })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.post("/employees/:employeeId/transfers", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const employeeId = Number(req.params.employeeId);
    const b = req.body;
    if (!b.moveType) return res.status(400).json({ error: "نوع الحركة مطلوب" });
    const from = isoDate(b.effectiveFrom), to = b.effectiveTo ? isoDate(b.effectiveTo) : null;
    if (!from || from < todayIso() || (to && (!isoDate(to) || to < from))) {
      return res.status(400).json({ error: "اختر تاريخ سريان من اليوم أو تاريخ لاحق، وتاريخ نهاية صحيحاً إن وجد" });
    }
    const isTemporary = !!b.isTemporary;
    const newValue = b.newValue && typeof b.newValue === "object" ? b.newValue : {};
    const result = await db.transaction(async (dx) => {
      const [emp] = await dx.select().from(employeesTable)
        .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid))).for("update");
      if (!emp) throw Object.assign(new Error("الموظف غير موجود"), { status: 404 });
      await dx.execute(sql`SELECT pg_advisory_xact_lock(${cid}, ${employeeId})`);
      const existing = await dx.select().from(employeeTransfersTable).where(and(
        eq(employeeTransfersTable.companyId, cid), eq(employeeTransfersTable.employeeId, employeeId),
      )).for("update");
      const prior = existing.find(t => String(t.effectiveFrom) < from && t.status !== "cancelled" && (!t.effectiveTo || String(t.effectiveTo) >= from));
      const overlap = existing.find(t => t.id !== prior?.id && t.status !== "cancelled" && String(t.effectiveFrom) <= (to ?? "9999-12-31") && (!t.effectiveTo || String(t.effectiveTo) >= from));
      if (overlap) throw Object.assign(new Error("فترة النقل أو التكليف تتداخل مع حركة قائمة"), { status: 400 });
      if (prior) await dx.update(employeeTransfersTable).set({ effectiveTo: dayBefore(from) })
        .where(eq(employeeTransfersTable.id, prior.id));
      // Snapshot السابق يُبنى من ملف الموظف الحقيقي وقت الحركة.
      const prevValue: Record<string, any> = {
        department: emp.department, jobTitle: emp.jobTitle, branchId: emp.branchId, status: emp.status,
      };
       const applyNow = !isTemporary && from <= todayIso();
      const [row] = await dx.insert(employeeTransfersTable).values({
        companyId: cid, employeeId,
        moveType: String(b.moveType),
        prevValue: JSON.stringify(prevValue),
        newValue: JSON.stringify(newValue),
        decisionDate: N(b.decisionDate),
         effectiveFrom: from,
         effectiveTo: to,
        isTemporary,
        reason: N(b.reason), approvedBy: N(b.approvedBy), notes: N(b.notes),
        status: applyNow ? "applied" : "scheduled",
        createdBy: uid(req),
      }).returning();
      if (applyNow) {
        const patch: Record<string, any> = {};
        for (const [k, col] of Object.entries(MOVE_FIELDS)) {
          if (newValue[k] !== undefined && newValue[k] !== null && newValue[k] !== "") {
            patch[col as string] = k === "branchId" ? Number(newValue[k]) : newValue[k];
          }
        }
        if (Object.keys(patch).length) {
          await dx.update(employeesTable).set({ ...patch, updatedAt: new Date() })
            .where(eq(employeesTable.id, employeeId));
        }
      }
      await logHistory(dx, {
        companyId: cid, employeeId,
        eventType: isTemporary ? "assignment" : (b.moveType === "promotion" ? "promotion" : "transfer"),
         eventDate: from,
        prevValue, newValue, reason: N(b.reason),
        refTable: "employee_transfers", refId: row.id, userId: uid(req),
      });
      return row;
    });
    res.json(result);
  } catch (e: any) { res.status(e.status || 500).json({ error: e.message }); }
});
router.put("/employees/:employeeId/transfers/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const employeeId = Number(req.params.employeeId), id = Number(req.params.id), b = req.body ?? {};
    const from = isoDate(b.effectiveFrom), to = b.effectiveTo ? isoDate(b.effectiveTo) : null;
    if (!from || from < todayIso() || (to && to < from)) return res.status(400).json({ error: "لا يمكن تعديل حركة بدأت في الماضي، وتحقق من التواريخ" });
    const row = await db.transaction(async dx => {
      await dx.execute(sql`SELECT pg_advisory_xact_lock(${cid}, ${employeeId})`);
      const [current] = await dx.select().from(employeeTransfersTable).where(and(eq(employeeTransfersTable.id, id), eq(employeeTransfersTable.companyId, cid), eq(employeeTransfersTable.employeeId, employeeId))).for("update");
      if (!current) throw Object.assign(new Error("الحركة غير موجودة"), { status: 404 });
      if (current.status !== "scheduled") throw Object.assign(new Error("لا يمكن تعديل حركة تم تطبيقها؛ سجّل حركة مستقبلية جديدة"), { status: 400 });
      if (String(current.effectiveFrom) < todayIso()) throw Object.assign(new Error("لا يمكن تعديل حركة بدأت في الماضي"), { status: 400 });
      const peers = await dx.select().from(employeeTransfersTable).where(and(eq(employeeTransfersTable.companyId, cid), eq(employeeTransfersTable.employeeId, employeeId))).for("update");
      if (peers.some(t => t.id !== id && t.status !== "cancelled" && String(t.effectiveFrom) <= (to ?? "9999-12-31") && (!t.effectiveTo || String(t.effectiveTo) >= from))) throw Object.assign(new Error("فترة النقل أو التكليف تتداخل مع حركة قائمة"), { status: 400 });
      const [updated] = await dx.update(employeeTransfersTable).set({ effectiveFrom: from, effectiveTo: to, reason: N(b.reason), approvedBy: N(b.approvedBy), notes: N(b.notes), newValue: b.newValue && typeof b.newValue === "object" ? JSON.stringify(b.newValue) : current.newValue }).where(eq(employeeTransfersTable.id, id)).returning();
      await dx.update(employeeHistoryTable).set({
        eventDate: from,
        newValue: updated.newValue,
        reason: updated.reason,
      }).where(and(
        eq(employeeHistoryTable.companyId, cid),
        eq(employeeHistoryTable.employeeId, employeeId),
        eq(employeeHistoryTable.refTable, "employee_transfers"),
        eq(employeeHistoryTable.refId, id),
      ));
      return updated;
    });
    res.json(row);
  } catch (e: any) { res.status(e.status || 400).json({ error: e.message }); }
});
// تطبيق حركة مجدولة / إنهاء تكليف مؤقت
router.post("/employees/:employeeId/transfers/:id/apply", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const employeeId = Number(req.params.employeeId);
    const result = await db.transaction(async (dx) => {
      // قفل صف الموظف أولاً لمنع سباق تطبيقين متزامنين.
      const [emp] = await dx.select().from(employeesTable)
        .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid))).for("update");
      if (!emp) throw Object.assign(new Error("الموظف غير موجود"), { status: 404 });
      const [t] = await dx.select().from(employeeTransfersTable)
        .where(and(
          eq(employeeTransfersTable.id, Number(req.params.id)),
          eq(employeeTransfersTable.companyId, cid),
          eq(employeeTransfersTable.employeeId, employeeId),
        )).for("update");
      if (!t) throw Object.assign(new Error("غير موجود"), { status: 404 });
      if (t.status !== "scheduled") throw Object.assign(new Error("الحركة مطبَّقة أو منتهية بالفعل"), { status: 400 });
       if (String(t.effectiveFrom) > todayIso()) {
        throw Object.assign(new Error("لم يحن تاريخ سريان الحركة بعد"), { status: 400 });
      }
      if (!t.isTemporary) {
        const newValue = t.newValue ? JSON.parse(t.newValue) : {};
        const patch: Record<string, any> = {};
        for (const [k, col] of Object.entries(MOVE_FIELDS)) {
          if (newValue[k] !== undefined && newValue[k] !== null && newValue[k] !== "") {
            patch[col as string] = k === "branchId" ? Number(newValue[k]) : newValue[k];
          }
        }
        if (Object.keys(patch).length) {
          await dx.update(employeesTable).set({ ...patch, updatedAt: new Date() })
            .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid)));
        }
      }
      const [row] = await dx.update(employeeTransfersTable).set({ status: "applied" })
        .where(eq(employeeTransfersTable.id, t.id)).returning();
      await logHistory(dx, {
        companyId: cid, employeeId,
        eventType: t.isTemporary ? "assignment" : "transfer",
        eventDate: String(t.effectiveFrom),
        prevValue: t.prevValue, newValue: t.newValue,
        reason: t.reason ?? "تطبيق حركة مجدولة",
        refTable: "employee_transfers", refId: t.id, userId: uid(req),
      });
      return row;
    });
    res.json(result);
  } catch (e: any) { res.status(e.status || 500).json({ error: e.message }); }
});
// إنهاء التكليف المؤقت فقط — الحركة الدائمة لا "تنتهي"، تُعالج بحركة جديدة.
router.post("/employees/:employeeId/transfers/:id/end", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const employeeId = Number(req.params.employeeId);
    const result = await db.transaction(async (dx) => {
      const [t] = await dx.select().from(employeeTransfersTable)
        .where(and(
          eq(employeeTransfersTable.id, Number(req.params.id)),
          eq(employeeTransfersTable.companyId, cid),
          eq(employeeTransfersTable.employeeId, employeeId),
        )).for("update");
      if (!t) throw Object.assign(new Error("غير موجود"), { status: 404 });
      if (!t.isTemporary) throw Object.assign(new Error("لا يمكن إنهاء حركة دائمة — سجّل حركة نقل جديدة بدلاً من ذلك"), { status: 400 });
      if (t.status === "ended" || t.status === "cancelled") throw Object.assign(new Error("التكليف منتهٍ بالفعل"), { status: 400 });
       const endDate = req.body?.effectiveTo || todayIso();
       if (!isoDate(endDate) || endDate < todayIso() || endDate < String(t.effectiveFrom)) throw Object.assign(new Error("اختر تاريخ إنهاء من اليوم ولا يسبق بداية التكليف"), { status: 400 });
       const [row] = await dx.update(employeeTransfersTable).set({ status: endDate <= todayIso() ? "ended" : t.status, effectiveTo: endDate })
        .where(eq(employeeTransfersTable.id, t.id)).returning();
      await logHistory(dx, {
        companyId: cid, employeeId, eventType: "assignment",
        eventDate: endDate, prevValue: t.newValue, newValue: null,
        reason: "إنهاء تكليف مؤقت", refTable: "employee_transfers", refId: t.id, userId: uid(req),
      });
      return row;
    });
    res.json(result);
  } catch (e: any) { res.status(e.status || 500).json({ error: e.message }); }
});

// ═══ السجل الوظيفي الموحّد ═══════════════════════════════════════════════════
router.get("/employees/:employeeId/history", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(employeeHistoryTable)
      .where(and(
        eq(employeeHistoryTable.companyId, cid),
        eq(employeeHistoryTable.employeeId, Number(req.params.employeeId)),
      )).orderBy(desc(employeeHistoryTable.eventDate), desc(employeeHistoryTable.id))
      .limit(1000);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══ نهاية الخدمة — الملف يُحفظ بالكامل ولا يُحذف ════════════════════════════
router.get("/employees/:employeeId/termination", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(employeeTerminationsTable)
      .where(and(
        eq(employeeTerminationsTable.companyId, cid),
        eq(employeeTerminationsTable.employeeId, Number(req.params.employeeId)),
      )).orderBy(desc(employeeTerminationsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.post("/employees/:employeeId/termination", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const employeeId = Number(req.params.employeeId);
    const b = req.body;
    if (!b.terminationType) return res.status(400).json({ error: "نوع نهاية الخدمة مطلوب" });
    if (!b.lastWorkDay) return res.status(400).json({ error: "تاريخ آخر يوم عمل مطلوب" });
    const result = await db.transaction(async (dx) => {
      const [emp] = await dx.select().from(employeesTable)
        .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid))).for("update");
      if (!emp) throw Object.assign(new Error("الموظف غير موجود"), { status: 404 });
      const [existing] = await dx.select({ id: employeeTerminationsTable.id }).from(employeeTerminationsTable)
        .where(and(
          eq(employeeTerminationsTable.companyId, cid),
          eq(employeeTerminationsTable.employeeId, employeeId),
          eq(employeeTerminationsTable.status, "active"),
        ));
      if (existing) throw Object.assign(new Error("يوجد سجل نهاية خدمة نشط بالفعل لهذا الموظف"), { status: 400 });
      const [row] = await dx.insert(employeeTerminationsTable).values({
        companyId: cid, employeeId,
        terminationType: String(b.terminationType),
        reason: N(b.reason), lastWorkDay: b.lastWorkDay,
        settlementDone: !!b.settlementDone, custodyReturned: !!b.custodyReturned,
        accessClosed: !!b.accessClosed, documentsUrl: N(b.documentsUrl), notes: N(b.notes),
        createdBy: uid(req),
      }).returning();
      const newStatus = b.terminationType === "resignation" ? "resigned" : "terminated";
      await dx.update(employeesTable).set({
        status: newStatus, endDate: b.lastWorkDay, updatedAt: new Date(),
      }).where(eq(employeesTable.id, employeeId));
      await logHistory(dx, {
        companyId: cid, employeeId, eventType: "termination", eventDate: b.lastWorkDay,
        prevValue: { status: emp.status, endDate: emp.endDate ?? null },
        newValue: { status: newStatus, type: b.terminationType },
        reason: N(b.reason), refTable: "employee_terminations", refId: row.id, userId: uid(req),
      });
      return row;
    });
    res.json(result);
  } catch (e: any) { res.status(e.status || 500).json({ error: e.message }); }
});
router.put("/employees/:employeeId/termination/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body;
    const [row] = await db.update(employeeTerminationsTable).set({
      ...(b.settlementDone  !== undefined ? { settlementDone:  !!b.settlementDone }  : {}),
      ...(b.custodyReturned !== undefined ? { custodyReturned: !!b.custodyReturned } : {}),
      ...(b.accessClosed    !== undefined ? { accessClosed:    !!b.accessClosed }    : {}),
      ...(b.notes           !== undefined ? { notes: N(b.notes) } : {}),
      ...(b.documentsUrl    !== undefined ? { documentsUrl: N(b.documentsUrl) } : {}),
    }).where(and(
      eq(employeeTerminationsTable.id, Number(req.params.id)),
      eq(employeeTerminationsTable.companyId, cid),
      eq(employeeTerminationsTable.employeeId, Number(req.params.employeeId)),
    )).returning();
    if (!row) return res.status(404).json({ error: "غير موجود" });
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
// إلغاء نهاية الخدمة (إعادة الموظف للعمل)
router.post("/employees/:employeeId/termination/:id/cancel", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const employeeId = Number(req.params.employeeId);
    const result = await db.transaction(async (dx) => {
      const [t] = await dx.select().from(employeeTerminationsTable)
        .where(and(
          eq(employeeTerminationsTable.id, Number(req.params.id)),
          eq(employeeTerminationsTable.companyId, cid),
          eq(employeeTerminationsTable.employeeId, employeeId),
          eq(employeeTerminationsTable.status, "active"),
        )).for("update");
      if (!t) throw Object.assign(new Error("غير موجود"), { status: 404 });
      const [row] = await dx.update(employeeTerminationsTable).set({ status: "cancelled" })
        .where(eq(employeeTerminationsTable.id, t.id)).returning();
      // استرجاع الحالة السابقة الفعلية من سجل التاريخ (وليس "active" دائماً).
      const [hist] = await dx.select().from(employeeHistoryTable)
        .where(and(
          eq(employeeHistoryTable.companyId, cid),
          eq(employeeHistoryTable.employeeId, employeeId),
          eq(employeeHistoryTable.eventType, "termination"),
          eq(employeeHistoryTable.refTable, "employee_terminations"),
          eq(employeeHistoryTable.refId, t.id),
        )).orderBy(desc(employeeHistoryTable.id)).limit(1);
      let prevStatus = "active"; let prevEnd: string | null = null;
      try {
        const pv = hist?.prevValue ? JSON.parse(hist.prevValue) : null;
        if (pv?.status) prevStatus = pv.status;
        if (pv?.endDate !== undefined) prevEnd = pv.endDate;
      } catch { /* fallback active/null */ }
      const [empNow] = await dx.select().from(employeesTable)
        .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid))).for("update");
      await dx.update(employeesTable).set({ status: prevStatus, endDate: prevEnd, updatedAt: new Date() })
        .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid)));
      await logHistory(dx, {
        companyId: cid, employeeId, eventType: "status_change",
        eventDate: new Date().toISOString().slice(0, 10),
        prevValue: { status: empNow?.status ?? "terminated" }, newValue: { status: prevStatus },
        reason: "إلغاء نهاية الخدمة", refTable: "employee_terminations", refId: t.id, userId: uid(req),
      });
      return row;
    });
    res.json(result);
  } catch (e: any) { res.status(e.status || 500).json({ error: e.message }); }
});

export default router;
