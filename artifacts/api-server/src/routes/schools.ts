import { Router } from "express";
import {
  db,
  branchesTable,
  customersTable,
  employeesTable,
  salesInvoicesTable,
} from "@workspace/db";
import {
  schoolAcademicYearsTable,
  schoolAttendanceTable,
  schoolCampusesTable,
  schoolClassesTable,
  schoolEnrollmentsTable,
  schoolExamResultsTable,
  schoolExamsTable,
  schoolFeesTable,
  schoolGradesTable,
  schoolStudentGuardiansTable,
  schoolStudentsTable,
  schoolSubjectsTable,
} from "@workspace/db/schema";
import {
  and, asc, count, desc, eq, gte, ilike, inArray, or, sql,
} from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission, requirePermission } from "../middleware/permissions.js";

type FieldKind = "string" | "integer" | "number" | "boolean" | "date";
type FieldSpec = {
  kind: FieldKind;
  required?: boolean;
  values?: readonly string[];
};
type EntityConfig = {
  table: any;
  fields: Record<string, FieldSpec>;
  references?: Record<string, any>;
  searchFields: string[];
  filterFields?: Record<string, string>;
  sortFields: string[];
};

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("school"));
router.use(requirePermission("school", "view"));
router.use(moduleAudit("school"));

const S = (required = false, values?: readonly string[]): FieldSpec => ({ kind: "string", required, values });
const I = (required = false): FieldSpec => ({ kind: "integer", required });
const N = (required = false): FieldSpec => ({ kind: "number", required });
const B = (required = false): FieldSpec => ({ kind: "boolean", required });
const D = (required = false): FieldSpec => ({ kind: "date", required });

const STAGES = ["kindergarten", "primary", "middle", "secondary"] as const;
const ENTITIES: Record<string, EntityConfig> = {
  campuses: {
    table: schoolCampusesTable,
    fields: {
      branchId: I(), code: S(true), nameAr: S(true), nameEn: S(), address: S(), city: S(),
      phone: S(), email: S(), managerEmployeeId: I(), isActive: B(), notes: S(),
    },
    references: { branchId: branchesTable, managerEmployeeId: employeesTable },
    searchFields: ["code", "nameAr", "nameEn", "city"],
    sortFields: ["id", "code", "nameAr", "city", "isActive", "createdAt"],
  },
  "academic-years": {
    table: schoolAcademicYearsTable,
    fields: {
      name: S(true), startDate: D(true), endDate: D(true),
      status: S(false, ["planned", "active", "closed"]), isCurrent: B(), notes: S(),
    },
    searchFields: ["name", "status"],
    sortFields: ["id", "name", "startDate", "endDate", "status", "isCurrent"],
  },
  grades: {
    table: schoolGradesTable,
    fields: {
      stage: S(true, STAGES), nameAr: S(true), nameEn: S(),
      orderNo: I(true), isActive: B(),
    },
    searchFields: ["nameAr", "nameEn", "stage"],
    sortFields: ["id", "stage", "nameAr", "orderNo", "isActive"],
  },
  classes: {
    table: schoolClassesTable,
    fields: {
      campusId: I(), academicYearId: I(true), gradeId: I(true),
      code: S(true), name: S(true), capacity: I(), classTeacherEmployeeId: I(),
      isActive: B(), notes: S(),
    },
    references: {
      campusId: schoolCampusesTable,
      academicYearId: schoolAcademicYearsTable,
      gradeId: schoolGradesTable,
      classTeacherEmployeeId: employeesTable,
    },
    searchFields: ["code", "name"],
    filterFields: { academicYearId: "academicYearId", gradeId: "gradeId", campusId: "campusId" },
    sortFields: ["id", "code", "name", "capacity", "isActive", "createdAt"],
  },
  students: {
    table: schoolStudentsTable,
    fields: {
      studentNumber: S(true), fullNameAr: S(true), fullNameEn: S(), nationalId: S(),
      gender: S(false, ["male", "female", "unspecified"]), birthDate: D(),
      phone: S(), email: S(), address: S(),
      status: S(false, ["active", "withdrawn", "graduated", "suspended"]), notes: S(),
    },
    searchFields: ["studentNumber", "fullNameAr", "fullNameEn", "nationalId", "phone"],
    filterFields: { status: "status" },
    sortFields: ["id", "studentNumber", "fullNameAr", "birthDate", "status", "createdAt"],
  },
  guardians: {
    table: schoolStudentGuardiansTable,
    fields: {
      studentId: I(true), customerId: I(), name: S(true), relationship: S(true),
      phone: S(), email: S(), isPrimary: B(), isInvoicePayer: B(), notes: S(),
    },
    references: { studentId: schoolStudentsTable, customerId: customersTable },
    searchFields: ["name", "relationship", "phone", "email"],
    filterFields: { studentId: "studentId", customerId: "customerId" },
    sortFields: ["id", "name", "relationship", "isPrimary", "isInvoicePayer", "createdAt"],
  },
  enrollments: {
    table: schoolEnrollmentsTable,
    fields: {
      studentId: I(true), academicYearId: I(true), classId: I(true),
      enrollmentDate: D(true), status: S(false, ["active", "withdrawn", "transferred", "completed"]),
      annualFee: N(), discountAmount: N(), notes: S(),
    },
    references: {
      studentId: schoolStudentsTable,
      academicYearId: schoolAcademicYearsTable,
      classId: schoolClassesTable,
    },
    searchFields: [],
    filterFields: { studentId: "studentId", academicYearId: "academicYearId", classId: "classId", status: "status" },
    sortFields: ["id", "enrollmentDate", "status", "annualFee", "createdAt"],
  },
  attendance: {
    table: schoolAttendanceTable,
    fields: {
      enrollmentId: I(true), attendanceDate: D(true), period: S(),
      status: S(true, ["present", "absent", "late", "excused"]), note: S(),
    },
    references: { enrollmentId: schoolEnrollmentsTable },
    searchFields: ["status", "period", "note"],
    filterFields: { enrollmentId: "enrollmentId", attendanceDate: "attendanceDate", period: "period", status: "status" },
    sortFields: ["id", "attendanceDate", "period", "status", "createdAt"],
  },
  subjects: {
    table: schoolSubjectsTable,
    fields: {
      code: S(true), nameAr: S(true), nameEn: S(), gradeId: I(),
      teacherEmployeeId: I(), isActive: B(), notes: S(),
    },
    references: { gradeId: schoolGradesTable, teacherEmployeeId: employeesTable },
    searchFields: ["code", "nameAr", "nameEn"],
    filterFields: { gradeId: "gradeId", isActive: "isActive" },
    sortFields: ["id", "code", "nameAr", "isActive", "createdAt"],
  },
  exams: {
    table: schoolExamsTable,
    fields: {
      academicYearId: I(true), classId: I(true), subjectId: I(true),
      name: S(true), examDate: D(true), maxScore: N(true),
      status: S(false, ["planned", "open", "closed"]), notes: S(),
    },
    references: {
      academicYearId: schoolAcademicYearsTable,
      classId: schoolClassesTable,
      subjectId: schoolSubjectsTable,
    },
    searchFields: ["name", "status"],
    filterFields: { academicYearId: "academicYearId", classId: "classId", subjectId: "subjectId", status: "status" },
    sortFields: ["id", "name", "examDate", "maxScore", "status", "createdAt"],
  },
  results: {
    table: schoolExamResultsTable,
    fields: { examId: I(true), enrollmentId: I(true), score: N(true), notes: S() },
    references: { examId: schoolExamsTable, enrollmentId: schoolEnrollmentsTable },
    searchFields: ["notes"],
    filterFields: { examId: "examId", enrollmentId: "enrollmentId" },
    sortFields: ["id", "score", "createdAt"],
  },
  fees: {
    table: schoolFeesTable,
    fields: {
      enrollmentId: I(true), guardianId: I(), salesInvoiceId: I(),
      description: S(true), amount: N(true), dueDate: D(),
      status: S(false, ["planned", "invoiced", "waived"]), notes: S(),
    },
    references: {
      enrollmentId: schoolEnrollmentsTable,
      guardianId: schoolStudentGuardiansTable,
      salesInvoiceId: salesInvoicesTable,
    },
    searchFields: ["description", "status", "notes"],
    filterFields: { enrollmentId: "enrollmentId", guardianId: "guardianId", salesInvoiceId: "salesInvoiceId", status: "status" },
    sortFields: ["id", "description", "amount", "dueDate", "status", "createdAt"],
  },
};

function errorMessage(error: unknown): { status: number; message: string } {
  const code = String((error as any)?.code ?? "");
  if (code === "23505") return { status: 409, message: "يوجد سجل آخر بالقيمة نفسها" };
  if (code === "23503" || code === "23502") return { status: 409, message: "تعذّر تنفيذ العملية لارتباط السجل ببيانات أخرى" };
  return { status: 500, message: "حدث خطأ أثناء معالجة الطلب" };
}

function fail(res: any, error: unknown) {
  const result = errorMessage(error);
  res.status(result.status).json({ error: result.message });
}

function companyIdFor(req: any, res: any, inputCompanyId?: unknown): number | null {
  const candidate = inputCompanyId ?? req.query?.companyId;
  const parsed = candidate == null || candidate === "" ? undefined : Number(candidate);
  const companyId = resolveCompanyId(req, Number.isFinite(parsed) ? parsed : undefined);
  if (!companyId) {
    res.status(401).json({ error: "غير مصرح" });
    return null;
  }
  return companyId;
}

async function ownsRow(table: any, id: number, companyId: number): Promise<boolean> {
  if (!Number.isSafeInteger(id) || id < 1) return false;
  const [row] = await db.select({ id: table.id }).from(table)
    .where(and(eq(table.id, id), eq(table.companyId, companyId))).limit(1);
  return !!row;
}

function parseField(value: unknown, spec: FieldSpec): { valid: boolean; value?: any } {
  if (value == null || value === "") {
    return spec.required ? { valid: false } : { valid: true, value: null };
  }
  if (spec.kind === "string") {
    const parsed = String(value).trim();
    if (!parsed || (spec.values && !spec.values.includes(parsed))) return { valid: false };
    return { valid: true, value: parsed };
  }
  if (spec.kind === "boolean") {
    if (typeof value === "boolean") return { valid: true, value };
    if (value === "true" || value === 1) return { valid: true, value: true };
    if (value === "false" || value === 0) return { valid: true, value: false };
    return { valid: false };
  }
  if (spec.kind === "date") {
    const parsed = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) return { valid: false };
    const check = new Date(`${parsed}T00:00:00.000Z`);
    if (!Number.isFinite(check.getTime()) || check.toISOString().slice(0, 10) !== parsed) return { valid: false };
    return { valid: true, value: parsed };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return { valid: false };
  if (spec.kind === "integer" && !Number.isSafeInteger(parsed)) return { valid: false };
  return { valid: true, value: spec.kind === "integer" ? parsed : String(parsed) };
}

function normalizeBody(body: unknown, config: EntityConfig, isUpdate: boolean): { ok: boolean; values?: Record<string, any>; error?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "بيانات الطلب غير صالحة" };
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set([...Object.keys(config.fields), "companyId"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return { ok: false, error: "يحتوي الطلب على حقول غير معتمدة" };
  }
  const values: Record<string, any> = {};
  for (const [field, spec] of Object.entries(config.fields)) {
    if (input[field] === undefined) {
      if (!isUpdate && spec.required) return { ok: false, error: `الحقل ${field} مطلوب` };
      continue;
    }
    const parsed = parseField(input[field], spec);
    if (!parsed.valid) return { ok: false, error: `قيمة الحقل ${field} غير صالحة` };
    values[field] = parsed.value;
  }
  return { ok: true, values };
}

async function validateReferences(
  res: any,
  config: EntityConfig,
  values: Record<string, any>,
  companyId: number,
): Promise<boolean> {
  for (const [field, table] of Object.entries(config.references ?? {})) {
    const id = values[field];
    if (id == null) continue;
    if (!await ownsRow(table, Number(id), companyId)) {
      res.status(400).json({ error: "إحدى البيانات المرتبطة غير موجودة في هذه الشركة" });
      return false;
    }
  }
  return true;
}

async function validateBusinessRules(
  res: any,
  name: string,
  values: Record<string, any>,
  companyId: number,
): Promise<boolean> {
  if (name === "academic-years" && values.startDate > values.endDate) {
    res.status(400).json({ error: "تاريخ بداية العام يجب أن يسبق تاريخ نهايته" });
    return false;
  }
  if (name === "enrollments") {
    const [schoolClass] = await db.select({
      academicYearId: schoolClassesTable.academicYearId,
    }).from(schoolClassesTable).where(and(
      eq(schoolClassesTable.id, values.classId),
      eq(schoolClassesTable.companyId, companyId),
    )).limit(1);
    if (!schoolClass || schoolClass.academicYearId !== values.academicYearId) {
      res.status(400).json({ error: "الفصل لا يتبع العام الدراسي المحدد" });
      return false;
    }
    if (Number(values.discountAmount ?? 0) > Number(values.annualFee ?? 0)) {
      res.status(400).json({ error: "قيمة الخصم لا يمكن أن تتجاوز الرسوم السنوية" });
      return false;
    }
  }
  if (name === "exams") {
    const [schoolClass] = await db.select({
      academicYearId: schoolClassesTable.academicYearId,
      gradeId: schoolClassesTable.gradeId,
    }).from(schoolClassesTable).where(and(
      eq(schoolClassesTable.id, values.classId),
      eq(schoolClassesTable.companyId, companyId),
    )).limit(1);
    const [subject] = await db.select({ gradeId: schoolSubjectsTable.gradeId })
      .from(schoolSubjectsTable).where(and(
        eq(schoolSubjectsTable.id, values.subjectId),
        eq(schoolSubjectsTable.companyId, companyId),
      )).limit(1);
    if (!schoolClass || schoolClass.academicYearId !== values.academicYearId) {
      res.status(400).json({ error: "الفصل لا يتبع العام الدراسي المحدد" });
      return false;
    }
    if (subject?.gradeId != null && subject.gradeId !== schoolClass.gradeId) {
      res.status(400).json({ error: "المادة غير مخصصة للصف المحدد" });
      return false;
    }
  }
  if (name === "results") {
    const [exam] = await db.select({
      classId: schoolExamsTable.classId,
      maxScore: schoolExamsTable.maxScore,
    }).from(schoolExamsTable).where(and(
      eq(schoolExamsTable.id, values.examId),
      eq(schoolExamsTable.companyId, companyId),
    )).limit(1);
    const [enrollment] = await db.select({ classId: schoolEnrollmentsTable.classId })
      .from(schoolEnrollmentsTable).where(and(
        eq(schoolEnrollmentsTable.id, values.enrollmentId),
        eq(schoolEnrollmentsTable.companyId, companyId),
      )).limit(1);
    if (!exam || !enrollment || exam.classId !== enrollment.classId) {
      res.status(400).json({ error: "الطالب المسجل لا ينتمي إلى فصل الاختبار" });
      return false;
    }
    if (Number(values.score) > Number(exam.maxScore)) {
      res.status(400).json({ error: "درجة الطالب تتجاوز الدرجة النهائية للاختبار" });
      return false;
    }
  }
  if (name === "fees") {
    if (values.status === "invoiced" && !values.salesInvoiceId) {
      res.status(400).json({ error: "اربط الفاتورة من مسار فواتير المبيعات قبل تغيير الحالة إلى مفوتر" });
      return false;
    }
    if (values.guardianId != null) {
      const [guardian] = await db.select({
        studentId: schoolStudentGuardiansTable.studentId,
        customerId: schoolStudentGuardiansTable.customerId,
      }).from(schoolStudentGuardiansTable).where(and(
        eq(schoolStudentGuardiansTable.id, values.guardianId),
        eq(schoolStudentGuardiansTable.companyId, companyId),
      )).limit(1);
      const [enrollment] = await db.select({ studentId: schoolEnrollmentsTable.studentId })
        .from(schoolEnrollmentsTable).where(and(
          eq(schoolEnrollmentsTable.id, values.enrollmentId),
          eq(schoolEnrollmentsTable.companyId, companyId),
        )).limit(1);
      if (!guardian || !enrollment || guardian.studentId !== enrollment.studentId) {
        res.status(400).json({ error: "ولي الأمر المحدد لا يتبع الطالب في هذا القيد" });
        return false;
      }
      if (values.salesInvoiceId && guardian.customerId != null) {
        const [invoice] = await db.select({ customerId: salesInvoicesTable.customerId })
          .from(salesInvoicesTable).where(and(
            eq(salesInvoicesTable.id, values.salesInvoiceId),
            eq(salesInvoicesTable.companyId, companyId),
          )).limit(1);
        if (!invoice || invoice.customerId !== guardian.customerId) {
          res.status(400).json({ error: "فاتورة المبيعات يجب أن تكون على حساب عميل ولي الأمر المحدد" });
          return false;
        }
      }
    }
  }
  return true;
}

function queryValue(req: any, key: string): string | undefined {
  const value = req.query?.[key];
  if (Array.isArray(value)) return String(value[0] ?? "");
  return value == null ? undefined : String(value);
}

const LOOKUPS: Record<string, { table: any; columns: Record<string, any>; searchFields: string[]; sortField: string }> = {
  "company-branches": {
    table: branchesTable,
    columns: { id: branchesTable.id, code: branchesTable.code, nameAr: branchesTable.nameAr, nameEn: branchesTable.nameEn, city: branchesTable.city },
    searchFields: ["code", "nameAr", "nameEn", "city"],
    sortField: "nameAr",
  },
  employees: {
    table: employeesTable,
    columns: { id: employeesTable.id, code: employeesTable.code, nameAr: employeesTable.nameAr, nameEn: employeesTable.nameEn, jobTitle: employeesTable.jobTitle },
    searchFields: ["code", "nameAr", "nameEn", "jobTitle"],
    sortField: "nameAr",
  },
  customers: {
    table: customersTable,
    columns: { id: customersTable.id, nameAr: customersTable.nameAr, nameEn: customersTable.nameEn, phone: customersTable.phone },
    searchFields: ["nameAr", "nameEn", "phone"],
    sortField: "nameAr",
  },
  "sales-invoices": {
    table: salesInvoicesTable,
    columns: { id: salesInvoicesTable.id, docNumber: salesInvoicesTable.docNumber, invoiceDate: salesInvoicesTable.invoiceDate, customerId: salesInvoicesTable.customerId },
    searchFields: ["docNumber"],
    sortField: "id",
  },
};

router.get("/lookups/:resource", async (req, res) => {
  try {
    const resource = Array.isArray(req.params.resource) ? req.params.resource[0] : req.params.resource;
    const lookup = LOOKUPS[resource];
    if (!lookup) {
      res.status(404).json({ error: "قائمة البيانات المطلوبة غير متاحة" });
      return;
    }
    const companyId = companyIdFor(req, res);
    if (!companyId) return;
    const page = Math.max(1, Math.min(100_000, Math.trunc(Number(queryValue(req, "page")) || 1)));
    const pageSize = Math.max(1, Math.min(100, Math.trunc(Number(queryValue(req, "limit")) || 50)));
    const conditions: any[] = [eq(lookup.table.companyId, companyId)];
    const q = queryValue(req, "q")?.trim().slice(0, 120);
    if (q) conditions.push(or(...lookup.searchFields.map(field => ilike(lookup.table[field], `%${q}%`))));
    const where = and(...conditions);
    const [items, totals] = await Promise.all([
      db.select(lookup.columns).from(lookup.table).where(where)
        .orderBy(asc(lookup.table[lookup.sortField]))
        .limit(pageSize).offset((page - 1) * pageSize),
      db.select({ total: count() }).from(lookup.table).where(where),
    ]);
    res.json({ items, total: Number(totals[0]?.total ?? 0), page, pageSize });
  } catch (error) {
    fail(res, error);
  }
});

for (const [name, config] of Object.entries(ENTITIES)) {
  router.get(`/${name}`, async (req, res) => {
    try {
      const companyId = companyIdFor(req, res);
      if (!companyId) return;
      const page = Math.max(1, Math.min(100_000, Math.trunc(Number(queryValue(req, "page")) || 1)));
      const pageSize = Math.max(1, Math.min(100, Math.trunc(Number(queryValue(req, "limit")) || 50)));
      const conditions: any[] = [eq(config.table.companyId, companyId)];
      const q = queryValue(req, "q")?.trim().slice(0, 120);
      if (q && config.searchFields.length) {
        conditions.push(or(...config.searchFields.map((field) => ilike(config.table[field], `%${q}%`))));
      }
      for (const [queryKey, field] of Object.entries(config.filterFields ?? {})) {
        const raw = queryValue(req, queryKey);
        if (raw == null || raw === "") continue;
        const spec = config.fields[field];
        if (!spec) continue;
        const parsed = parseField(raw, { ...spec, required: true });
        if (!parsed.valid) {
          res.status(400).json({ error: `مرشح ${queryKey} غير صالح` });
          return;
        }
        conditions.push(eq(config.table[field], parsed.value));
      }
      if (name === "attendance" && queryValue(req, "classId")) {
        const classId = Number(queryValue(req, "classId"));
        if (!Number.isSafeInteger(classId) || classId < 1) {
          res.status(400).json({ error: "رقم الفصل غير صالح" });
          return;
        }
        const enrollments = await db.select({ id: schoolEnrollmentsTable.id })
          .from(schoolEnrollmentsTable).where(and(
            eq(schoolEnrollmentsTable.companyId, companyId),
            eq(schoolEnrollmentsTable.classId, classId),
          ));
        conditions.push(enrollments.length
          ? inArray(config.table.enrollmentId, enrollments.map((row) => row.id))
          : sql`false`);
      }
      const where = and(...conditions);
      const requestedSort = queryValue(req, "sort");
      const sortField = requestedSort && config.sortFields.includes(requestedSort)
        ? requestedSort
        : "id";
      const sortDirection = queryValue(req, "dir") === "asc" ? asc : desc;
      const [items, totals] = await Promise.all([
        db.select().from(config.table).where(where)
          .orderBy(sortDirection(config.table[sortField]))
          .limit(pageSize).offset((page - 1) * pageSize),
        db.select({ total: count() }).from(config.table).where(where),
      ]);
      res.json({ items, total: Number(totals[0]?.total ?? 0), page, pageSize });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post(`/${name}`, requirePermission("school", "create"), async (req, res) => {
    try {
      const companyId = companyIdFor(req, res, req.body?.companyId);
      if (!companyId) return;
      const normalized = normalizeBody(req.body, config, false);
      if (!normalized.ok) {
        res.status(400).json({ error: normalized.error });
        return;
      }
      const values = normalized.values!;
      if (!await validateReferences(res, config, values, companyId)) return;
      if (!await validateBusinessRules(res, name, values, companyId)) return;
      const saved = await db.transaction(async (tx: any) => {
        if (name === "academic-years" && values.isCurrent === true) {
          await tx.update(schoolAcademicYearsTable)
            .set({ isCurrent: false, updatedAt: new Date() })
            .where(eq(schoolAcademicYearsTable.companyId, companyId));
        }
        const [row] = await tx.insert(config.table)
          .values({ ...values, companyId }).returning();
        return row;
      });
      res.status(201).json(saved);
    } catch (error) {
      fail(res, error);
    }
  });

  router.put(`/${name}/:id`, requirePermission("school", "edit"), async (req, res) => {
    try {
      const companyId = companyIdFor(req, res, req.body?.companyId);
      if (!companyId) return;
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        res.status(400).json({ error: "رقم السجل غير صالح" });
        return;
      }
      const [existing] = await db.select().from(config.table).where(and(
        eq(config.table.id, id), eq(config.table.companyId, companyId),
      )).limit(1);
      if (!existing) {
        res.status(404).json({ error: "السجل غير موجود" });
        return;
      }
      const normalized = normalizeBody(req.body, config, true);
      if (!normalized.ok) {
        res.status(400).json({ error: normalized.error });
        return;
      }
      const values = normalized.values!;
      const merged = { ...existing, ...values };
      if (!await validateReferences(res, config, merged, companyId)) return;
      if (!await validateBusinessRules(res, name, merged, companyId)) return;
      const saved = await db.transaction(async (tx: any) => {
        if (name === "academic-years" && values.isCurrent === true) {
          await tx.update(schoolAcademicYearsTable)
            .set({ isCurrent: false, updatedAt: new Date() })
            .where(and(
              eq(schoolAcademicYearsTable.companyId, companyId),
              sql`${schoolAcademicYearsTable.id} <> ${id}`,
            ));
        }
        const [row] = await tx.update(config.table)
          .set({ ...values, updatedAt: new Date() })
          .where(and(eq(config.table.id, id), eq(config.table.companyId, companyId)))
          .returning();
        return row;
      });
      res.json(saved);
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete(`/${name}/:id`, requirePermission("school", "delete"), async (req, res) => {
    try {
      const companyId = companyIdFor(req, res);
      if (!companyId) return;
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        res.status(400).json({ error: "رقم السجل غير صالح" });
        return;
      }
      if (!await ownsRow(config.table, id, companyId)) {
        res.status(404).json({ error: "السجل غير موجود" });
        return;
      }
      await db.delete(config.table).where(and(
        eq(config.table.id, id), eq(config.table.companyId, companyId),
      ));
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });
}

router.post(
  "/attendance/bulk",
  requirePermission("school", "create"),
  requirePermission("school", "edit"),
  async (req, res) => {
  try {
    const companyId = companyIdFor(req, res, req.body?.companyId);
    if (!companyId) return;
    const body = req.body ?? {};
    const date = parseField(body.attendanceDate, D(true));
    const period = parseField(body.period ?? "full_day", S(true));
    const records = body.records;
    if (!date.valid || !period.valid || !Array.isArray(records) || records.length < 1 || records.length > 1000) {
      res.status(400).json({ error: "بيانات تسجيل الحضور غير صالحة" });
      return;
    }
    const normalized: Array<{ enrollmentId: number; status: string; note: string | null }> = [];
    const seen = new Set<number>();
    for (const record of records) {
      if (!record || typeof record !== "object") {
        res.status(400).json({ error: "يحتوي سجل الحضور على بيانات غير صالحة" });
        return;
      }
      const enrollment = parseField(record.enrollmentId, I(true));
      const status = parseField(record.status, S(true, ["present", "absent", "late", "excused"]));
      const note = record.note == null || record.note === "" ? null : String(record.note).trim().slice(0, 500);
      if (!enrollment.valid || !status.valid || seen.has(enrollment.value)) {
        res.status(400).json({ error: "توجد بيانات حضور غير صالحة أو مكررة" });
        return;
      }
      seen.add(enrollment.value);
      normalized.push({ enrollmentId: enrollment.value, status: status.value, note });
    }
    const validRows = await db.select({ id: schoolEnrollmentsTable.id })
      .from(schoolEnrollmentsTable).where(and(
        eq(schoolEnrollmentsTable.companyId, companyId),
        inArray(schoolEnrollmentsTable.id, normalized.map((row) => row.enrollmentId)),
      ));
    if (validRows.length !== normalized.length) {
      res.status(400).json({ error: "تتضمن القائمة تسجيلًا غير موجود في هذه الشركة" });
      return;
    }
    const rows = normalized.map((row) => ({
      ...row,
      companyId,
      attendanceDate: date.value,
      period: period.value,
      updatedAt: new Date(),
    }));
    await db.insert(schoolAttendanceTable).values(rows).onConflictDoUpdate({
      target: [
        schoolAttendanceTable.companyId,
        schoolAttendanceTable.enrollmentId,
        schoolAttendanceTable.attendanceDate,
        schoolAttendanceTable.period,
      ],
      set: {
        status: sql`excluded.status`,
        note: sql`excluded.note`,
        updatedAt: new Date(),
      },
    });
    res.json({ saved: rows.length });
  } catch (error) {
    fail(res, error);
  }
  },
);

router.get("/dashboard", async (req, res) => {
  try {
    const companyId = companyIdFor(req, res);
    if (!companyId) return;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
    const total = async (table: any, ...extra: any[]) => {
      const [row] = await db.select({ value: count() }).from(table)
        .where(and(eq(table.companyId, companyId), ...extra));
      return Number(row?.value ?? 0);
    };
    const [
      campuses, students, activeEnrollments, activeClasses,
      present, absent, late, excused, unlinkedFees, linkedInvoices,
      upcomingExams,
    ] = await Promise.all([
      total(schoolCampusesTable),
      total(schoolStudentsTable),
      total(schoolEnrollmentsTable, eq(schoolEnrollmentsTable.status, "active")),
      total(schoolClassesTable, eq(schoolClassesTable.isActive, true)),
      total(schoolAttendanceTable, eq(schoolAttendanceTable.attendanceDate, today), eq(schoolAttendanceTable.status, "present")),
      total(schoolAttendanceTable, eq(schoolAttendanceTable.attendanceDate, today), eq(schoolAttendanceTable.status, "absent")),
      total(schoolAttendanceTable, eq(schoolAttendanceTable.attendanceDate, today), eq(schoolAttendanceTable.status, "late")),
      total(schoolAttendanceTable, eq(schoolAttendanceTable.attendanceDate, today), eq(schoolAttendanceTable.status, "excused")),
      total(schoolFeesTable, eq(schoolFeesTable.status, "planned"), sql`${schoolFeesTable.salesInvoiceId} IS NULL`),
      total(schoolFeesTable, sql`${schoolFeesTable.salesInvoiceId} IS NOT NULL`),
      db.select().from(schoolExamsTable).where(and(
        eq(schoolExamsTable.companyId, companyId),
        gte(schoolExamsTable.examDate, today),
        sql`${schoolExamsTable.status} <> 'closed'`,
      )).orderBy(asc(schoolExamsTable.examDate)).limit(5),
    ]);
    res.json({
      campuses, students, activeEnrollments, activeClasses,
      attendanceToday: { present, absent, late, excused },
      upcomingExams, unlinkedFees, linkedInvoices,
    });
  } catch (error) {
    fail(res, error);
  }
});

export default router;
