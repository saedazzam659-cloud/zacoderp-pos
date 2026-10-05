import { Router } from "express";
import {
  db,
  employeesTable,
  schoolAcademicYearsTable,
  schoolAttendanceTable,
  schoolClassesTable,
  schoolEnrollmentsTable,
  schoolExamsTable,
  schoolExamResultsTable,
  schoolGradesTable,
  schoolStudentsTable,
  schoolSubjectsTable,
} from "@workspace/db";
import {
  schoolAcademicPeriodsTable,
  schoolDailyAssessmentsTable,
  schoolGradeAuditEventsTable,
  schoolGradeSubjectPoliciesTable,
  schoolResultApprovalsTable,
  schoolSubjectOfferingsTable,
} from "@workspace/db/schema";
import {
  ApproveSchoolResultsBody,
  CreateSchoolAcademicPeriodBody,
  CreateSchoolSubjectOfferingBody,
  SaveSchoolDailyAssessmentsBody,
  SaveSchoolGradebookMarksBody,
  SaveSchoolGradeSubjectPolicyBody,
  UpdateSchoolAcademicPeriodBody,
  UpdateSchoolSubjectOfferingBody,
} from "@workspace/api-zod";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { requireAdminRole, requirePermission } from "../middleware/permissions.js";
import { resolveCompanyId } from "../middleware/auth.js";
import { ensureSchoolAcademicControlSchema } from "../lib/schoolAcademicControlSchema.js";
import {
  calculateWeightedPercentage,
  gradeLabel,
  resultStatus,
  validateWeights,
} from "../lib/schoolAcademicGrading.js";

const router = Router();
const DAILY_SCORE_FIELDS = [
  "attendanceDiscipline",
  "participation",
  "homework",
  "activity",
  "behavior",
  "teacherEvaluation",
] as const;
const MIDYEAR_COMPONENTS = new Set<string>([
  ...DAILY_SCORE_FIELDS,
  "coursework",
  "monthly",
  "midyear",
]);
const YEAR_END_COMPONENTS = new Set<string>([
  ...DAILY_SCORE_FIELDS,
  "coursework",
  "monthly",
  "midyear",
  "yearEnd",
]);

router.use(async (_req, _res, next) => {
  try {
    await ensureSchoolAcademicControlSchema();
    next();
  } catch (error) {
    next(error);
  }
});

function companyFor(req: any, res: any): number | null {
  const companyId = resolveCompanyId(req);
  if (!companyId) {
    res.status(401).json({ error: "غير مصرح" });
    return null;
  }
  return companyId;
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function actorId(req: any): number | null {
  const value = Number(req.authUser?.id ?? req.authUser?.userId ?? req.user?.id ?? req.auth?.userId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function numeric(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function nullableNumeric(value: unknown): number | null {
  if (value == null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function dateString(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizePolicy(row: any) {
  if (!row) return null;
  return {
    ...row,
    maximumScore: numeric(row.maximumScore),
    minimumScore: numeric(row.minimumScore),
    passMarkPercent: numeric(row.passMarkPercent),
    secondRoundPercent: numeric(row.secondRoundPercent),
  };
}

function normalizeApproval(row: any) {
  return {
    ...row,
    resultsSnapshot: Array.isArray(row.resultsSnapshot) ? row.resultsSnapshot : [],
    approvedAt: row.approvedAt instanceof Date ? row.approvedAt.toISOString() : row.approvedAt,
    approvedById: row.approvedById ?? null,
  };
}

function handleError(res: any, error: any): void {
  const code = String(error?.code ?? "");
  if (code === "23505") {
    res.status(409).json({ error: "يوجد سجل آخر بالقيمة نفسها" });
    return;
  }
  if (code === "23503" || code === "23502") {
    res.status(409).json({ error: "تعذّر تنفيذ العملية لارتباط السجل ببيانات أخرى" });
    return;
  }
  res.status(500).json({ error: "حدث خطأ أثناء معالجة الكنترول الأكاديمي" });
}

async function owns(table: any, id: number, companyId: number): Promise<boolean> {
  const [row] = await db.select({ id: table.id }).from(table).where(and(
    eq(table.id, id),
    eq(table.companyId, companyId),
  )).limit(1);
  return !!row;
}

async function readScope(companyId: number, academicYearId: number, periodId: number, classId: number, subjectId: number) {
  const [year, period, schoolClass, subject] = await Promise.all([
    db.select().from(schoolAcademicYearsTable).where(and(
      eq(schoolAcademicYearsTable.id, academicYearId),
      eq(schoolAcademicYearsTable.companyId, companyId),
    )).limit(1),
    db.select().from(schoolAcademicPeriodsTable).where(and(
      eq(schoolAcademicPeriodsTable.id, periodId),
      eq(schoolAcademicPeriodsTable.companyId, companyId),
      eq(schoolAcademicPeriodsTable.academicYearId, academicYearId),
    )).limit(1),
    db.select().from(schoolClassesTable).where(and(
      eq(schoolClassesTable.id, classId),
      eq(schoolClassesTable.companyId, companyId),
      eq(schoolClassesTable.academicYearId, academicYearId),
    )).limit(1),
    db.select().from(schoolSubjectsTable).where(and(
      eq(schoolSubjectsTable.id, subjectId),
      eq(schoolSubjectsTable.companyId, companyId),
    )).limit(1),
  ]);
  if (!year[0] || !period[0] || !schoolClass[0] || !subject[0]) return null;
  if (subject[0].gradeId != null && subject[0].gradeId !== schoolClass[0].gradeId) return null;
  return { year: year[0], period: period[0], schoolClass: schoolClass[0], subject: subject[0] };
}

async function activeApproval(companyId: number, academicYearId: number, periodId: number, classId: number, subjectId: number) {
  const [row] = await db.select({ id: schoolResultApprovalsTable.id }).from(schoolResultApprovalsTable).where(and(
    eq(schoolResultApprovalsTable.companyId, companyId),
    eq(schoolResultApprovalsTable.academicYearId, academicYearId),
    eq(schoolResultApprovalsTable.periodId, periodId),
    eq(schoolResultApprovalsTable.classId, classId),
    eq(schoolResultApprovalsTable.subjectId, subjectId),
    eq(schoolResultApprovalsTable.status, "approved"),
  )).limit(1);
  return row ?? null;
}

async function audit(tx: any, input: {
  companyId: number;
  enrollmentId?: number | null;
  subjectId?: number | null;
  entityType: string;
  entityId?: number | null;
  action: string;
  beforeValue?: unknown;
  afterValue?: unknown;
  actorId?: number | null;
}) {
  await tx.insert(schoolGradeAuditEventsTable).values({
    companyId: input.companyId,
    enrollmentId: input.enrollmentId ?? null,
    subjectId: input.subjectId ?? null,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    action: input.action,
    beforeValue: input.beforeValue ?? null,
    afterValue: input.afterValue ?? null,
    actorId: input.actorId ?? null,
  });
}

router.get("/periods", async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const academicYearId = positiveInt(req.query.academicYearId);
    if (!companyId) return;
    if (!academicYearId) return void res.status(400).json({ error: "السنة الدراسية غير صالحة" });
    if (!await owns(schoolAcademicYearsTable, academicYearId, companyId)) {
      return void res.status(404).json({ error: "السنة الدراسية غير موجودة" });
    }
    const rows = await db.select().from(schoolAcademicPeriodsTable).where(and(
      eq(schoolAcademicPeriodsTable.companyId, companyId),
      eq(schoolAcademicPeriodsTable.academicYearId, academicYearId),
    )).orderBy(asc(schoolAcademicPeriodsTable.sortOrder), asc(schoolAcademicPeriodsTable.startDate));
    res.json(rows);
  } catch (error) { handleError(res, error); }
});

router.post("/periods", requirePermission("school", "create"), async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const parsed = CreateSchoolAcademicPeriodBody.safeParse(req.body);
    if (!companyId) return;
    if (!parsed.success) return void res.status(400).json({ error: "بيانات الفترة الدراسية غير صالحة" });
    const input = parsed.data;
    const startDate = dateString(input.startDate);
    const endDate = dateString(input.endDate);
    if (startDate > endDate || !await owns(schoolAcademicYearsTable, input.academicYearId, companyId)) {
      return void res.status(400).json({ error: "تحقق من السنة وتاريخي بداية الفترة ونهايتها" });
    }
    const [year] = await db.select().from(schoolAcademicYearsTable).where(and(
      eq(schoolAcademicYearsTable.id, input.academicYearId),
      eq(schoolAcademicYearsTable.companyId, companyId),
    )).limit(1);
    if (!year || startDate < year.startDate || endDate > year.endDate) {
      return void res.status(400).json({ error: "يجب أن تقع الفترة داخل حدود العام الدراسي" });
    }
    const row = await db.transaction(async (tx) => {
      const [saved] = await tx.insert(schoolAcademicPeriodsTable).values({
        ...input,
        companyId,
        startDate,
        endDate,
        sortOrder: input.sortOrder ?? 1,
      }).returning();
      await audit(tx, {
        companyId,
        entityType: "academic_period",
        entityId: saved.id,
        action: "create",
        afterValue: saved,
        actorId: actorId(req),
      });
      return saved;
    });
    res.status(201).json(row);
  } catch (error) { handleError(res, error); }
});

router.put("/periods/:periodId", requirePermission("school", "edit"), async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const periodId = positiveInt(req.params.periodId);
    const parsed = UpdateSchoolAcademicPeriodBody.safeParse(req.body);
    if (!companyId) return;
    if (!periodId || !parsed.success) return void res.status(400).json({ error: "بيانات الفترة غير صالحة" });
    const [current] = await db.select().from(schoolAcademicPeriodsTable).where(and(
      eq(schoolAcademicPeriodsTable.id, periodId),
      eq(schoolAcademicPeriodsTable.companyId, companyId),
    )).limit(1);
    if (!current) return void res.status(404).json({ error: "الفترة الدراسية غير موجودة" });
    const values: any = { ...parsed.data, updatedAt: new Date() };
    if (parsed.data.startDate) values.startDate = dateString(parsed.data.startDate);
    if (parsed.data.endDate) values.endDate = dateString(parsed.data.endDate);
    const startDate = values.startDate ?? current.startDate;
    const endDate = values.endDate ?? current.endDate;
    if (startDate > endDate) return void res.status(400).json({ error: "تاريخ البداية يجب أن يسبق تاريخ النهاية" });
    const [year] = await db.select().from(schoolAcademicYearsTable).where(and(
      eq(schoolAcademicYearsTable.id, current.academicYearId),
      eq(schoolAcademicYearsTable.companyId, companyId),
    )).limit(1);
    if (!year || startDate < year.startDate || endDate > year.endDate) {
      return void res.status(400).json({ error: "يجب أن تقع الفترة داخل حدود العام الدراسي" });
    }
    const academicScopeChanged = startDate !== current.startDate
      || endDate !== current.endDate
      || (values.periodType != null && values.periodType !== current.periodType);
    if (academicScopeChanged) {
      const [exam] = await db.select({ id: schoolExamsTable.id }).from(schoolExamsTable).where(and(
        eq(schoolExamsTable.companyId, companyId),
        eq(schoolExamsTable.academicYearId, current.academicYearId),
        or(
          eq(schoolExamsTable.periodId, periodId),
          and(
            isNull(schoolExamsTable.periodId),
            gte(schoolExamsTable.examDate, current.startDate),
            lte(schoolExamsTable.examDate, current.endDate),
          ),
        ),
      )).limit(1);
      const [daily] = await db.select({ id: schoolDailyAssessmentsTable.id }).from(schoolDailyAssessmentsTable).where(and(
        eq(schoolDailyAssessmentsTable.companyId, companyId),
        eq(schoolDailyAssessmentsTable.periodId, periodId),
      )).limit(1);
      const [approval] = await db.select({ id: schoolResultApprovalsTable.id }).from(schoolResultApprovalsTable).where(and(
        eq(schoolResultApprovalsTable.companyId, companyId),
        eq(schoolResultApprovalsTable.periodId, periodId),
      )).limit(1);
      if (exam || daily || approval) {
        return void res.status(409).json({ error: "لا يمكن تغيير نطاق فترة مرتبطة باختبارات أو تقييمات أو نتائج معتمدة" });
      }
    }
    const row = await db.transaction(async (tx) => {
      const [saved] = await tx.update(schoolAcademicPeriodsTable).set(values).where(and(
        eq(schoolAcademicPeriodsTable.id, periodId),
        eq(schoolAcademicPeriodsTable.companyId, companyId),
      )).returning();
      await audit(tx, {
        companyId,
        entityType: "academic_period",
        entityId: periodId,
        action: "update",
        beforeValue: current,
        afterValue: saved,
        actorId: actorId(req),
      });
      return saved;
    });
    res.json(row);
  } catch (error) { handleError(res, error); }
});

router.delete("/periods/:periodId", requirePermission("school", "delete"), async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const periodId = positiveInt(req.params.periodId);
    if (!companyId) return;
    if (!periodId) return void res.status(400).json({ error: "رقم الفترة غير صالح" });
    const [period] = await db.select().from(schoolAcademicPeriodsTable).where(and(
      eq(schoolAcademicPeriodsTable.id, periodId),
      eq(schoolAcademicPeriodsTable.companyId, companyId),
    )).limit(1);
    if (!period) return void res.status(404).json({ error: "الفترة الدراسية غير موجودة" });
    const [exam] = await db.select({ id: schoolExamsTable.id }).from(schoolExamsTable).where(and(
      eq(schoolExamsTable.companyId, companyId),
      eq(schoolExamsTable.periodId, periodId),
    )).limit(1);
    const [approval] = await db.select({ id: schoolResultApprovalsTable.id }).from(schoolResultApprovalsTable).where(and(
      eq(schoolResultApprovalsTable.companyId, companyId),
      eq(schoolResultApprovalsTable.periodId, periodId),
    )).limit(1);
    const [daily] = await db.select({ id: schoolDailyAssessmentsTable.id }).from(schoolDailyAssessmentsTable).where(and(
      eq(schoolDailyAssessmentsTable.companyId, companyId),
      eq(schoolDailyAssessmentsTable.periodId, periodId),
    )).limit(1);
    if (exam || approval || daily) return void res.status(409).json({ error: "لا يمكن حذف فترة مرتبطة بسجلات أكاديمية" });
    await db.transaction(async (tx) => {
      await tx.delete(schoolAcademicPeriodsTable).where(and(
        eq(schoolAcademicPeriodsTable.id, periodId),
        eq(schoolAcademicPeriodsTable.companyId, companyId),
      ));
      await audit(tx, {
        companyId,
        entityType: "academic_period",
        entityId: periodId,
        action: "delete",
        beforeValue: period,
        actorId: actorId(req),
      });
    });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

router.get("/offerings", async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const academicYearId = positiveInt(req.query.academicYearId);
    const classId = req.query.classId == null ? null : positiveInt(req.query.classId);
    if (!companyId) return;
    if (!academicYearId || (req.query.classId != null && !classId)) {
      return void res.status(400).json({ error: "السنة أو الفصل غير صالح" });
    }
    const filters = [
      eq(schoolSubjectOfferingsTable.companyId, companyId),
      eq(schoolSubjectOfferingsTable.academicYearId, academicYearId),
    ];
    if (classId) filters.push(eq(schoolSubjectOfferingsTable.classId, classId));
    const rows = await db.select({
      id: schoolSubjectOfferingsTable.id,
      academicYearId: schoolSubjectOfferingsTable.academicYearId,
      classId: schoolSubjectOfferingsTable.classId,
      className: schoolClassesTable.name,
      subjectId: schoolSubjectOfferingsTable.subjectId,
      subjectNameAr: schoolSubjectsTable.nameAr,
      teacherEmployeeId: schoolSubjectOfferingsTable.teacherEmployeeId,
      teacherNameAr: employeesTable.nameAr,
      isActive: schoolSubjectOfferingsTable.isActive,
      notes: schoolSubjectOfferingsTable.notes,
    }).from(schoolSubjectOfferingsTable)
      .innerJoin(schoolClassesTable, and(
        eq(schoolClassesTable.id, schoolSubjectOfferingsTable.classId),
        eq(schoolClassesTable.companyId, companyId),
      ))
      .innerJoin(schoolSubjectsTable, and(
        eq(schoolSubjectsTable.id, schoolSubjectOfferingsTable.subjectId),
        eq(schoolSubjectsTable.companyId, companyId),
      ))
      .leftJoin(employeesTable, and(
        eq(employeesTable.id, schoolSubjectOfferingsTable.teacherEmployeeId),
        eq(employeesTable.companyId, companyId),
      ))
      .where(and(...filters))
      .orderBy(asc(schoolClassesTable.name), asc(schoolSubjectsTable.nameAr));
    res.json(rows);
  } catch (error) { handleError(res, error); }
});

router.post("/offerings", requirePermission("school", "create"), async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const parsed = CreateSchoolSubjectOfferingBody.safeParse(req.body);
    if (!companyId) return;
    if (!parsed.success) return void res.status(400).json({ error: "بيانات إسناد المادة غير صالحة" });
    const input = parsed.data;
    const [schoolClass] = await db.select().from(schoolClassesTable).where(and(
      eq(schoolClassesTable.id, input.classId),
      eq(schoolClassesTable.companyId, companyId),
      eq(schoolClassesTable.academicYearId, input.academicYearId),
    )).limit(1);
    const [subject] = await db.select().from(schoolSubjectsTable).where(and(
      eq(schoolSubjectsTable.id, input.subjectId),
      eq(schoolSubjectsTable.companyId, companyId),
    )).limit(1);
    if (!schoolClass || !subject || (subject.gradeId != null && subject.gradeId !== schoolClass.gradeId)) {
      return void res.status(400).json({ error: "الفصل والمادة يجب أن يتبعا الصف والسنة المحددين" });
    }
    if (input.teacherEmployeeId && !await owns(employeesTable, input.teacherEmployeeId, companyId)) {
      return void res.status(400).json({ error: "المعلم غير موجود في الشركة الحالية" });
    }
    const row = await db.transaction(async (tx) => {
      const [saved] = await tx.insert(schoolSubjectOfferingsTable).values({
        ...input,
        companyId,
        isActive: input.isActive ?? true,
      }).returning();
      await audit(tx, {
        companyId,
        subjectId: input.subjectId,
        entityType: "subject_offering",
        entityId: saved.id,
        action: "create",
        afterValue: saved,
        actorId: actorId(req),
      });
      return saved;
    });
    res.status(201).json({
      ...row,
      className: schoolClass.name,
      subjectNameAr: subject.nameAr,
      teacherNameAr: input.teacherEmployeeId
        ? (await db.select({ nameAr: employeesTable.nameAr }).from(employeesTable)
          .where(eq(employeesTable.id, input.teacherEmployeeId)).limit(1))[0]?.nameAr ?? null
        : null,
    });
  } catch (error) { handleError(res, error); }
});

router.put("/offerings/:offeringId", requirePermission("school", "edit"), async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const offeringId = positiveInt(req.params.offeringId);
    const parsed = UpdateSchoolSubjectOfferingBody.safeParse(req.body);
    if (!companyId) return;
    if (!offeringId || !parsed.success) return void res.status(400).json({ error: "بيانات الإسناد غير صالحة" });
    const [current] = await db.select().from(schoolSubjectOfferingsTable).where(and(
      eq(schoolSubjectOfferingsTable.id, offeringId),
      eq(schoolSubjectOfferingsTable.companyId, companyId),
    )).limit(1);
    if (!current) return void res.status(404).json({ error: "إسناد المادة غير موجود" });
    if (parsed.data.teacherEmployeeId && !await owns(employeesTable, parsed.data.teacherEmployeeId, companyId)) {
      return void res.status(400).json({ error: "المعلم غير موجود في الشركة الحالية" });
    }
    const row = await db.transaction(async (tx) => {
      const [saved] = await tx.update(schoolSubjectOfferingsTable).set({
        ...parsed.data,
        updatedAt: new Date(),
      }).where(and(
        eq(schoolSubjectOfferingsTable.id, offeringId),
        eq(schoolSubjectOfferingsTable.companyId, companyId),
      )).returning();
      await audit(tx, {
        companyId,
        subjectId: current.subjectId,
        entityType: "subject_offering",
        entityId: offeringId,
        action: "update",
        beforeValue: current,
        afterValue: saved,
        actorId: actorId(req),
      });
      return saved;
    });
    res.json({
      ...row,
      className: (await db.select({ name: schoolClassesTable.name }).from(schoolClassesTable)
        .where(eq(schoolClassesTable.id, row.classId)).limit(1))[0]?.name ?? "",
      subjectNameAr: (await db.select({ nameAr: schoolSubjectsTable.nameAr }).from(schoolSubjectsTable)
        .where(eq(schoolSubjectsTable.id, row.subjectId)).limit(1))[0]?.nameAr ?? "",
      teacherNameAr: row.teacherEmployeeId
        ? (await db.select({ nameAr: employeesTable.nameAr }).from(employeesTable)
          .where(eq(employeesTable.id, row.teacherEmployeeId)).limit(1))[0]?.nameAr ?? null
        : null,
    });
  } catch (error) { handleError(res, error); }
});

router.delete("/offerings/:offeringId", requirePermission("school", "delete"), async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const offeringId = positiveInt(req.params.offeringId);
    if (!companyId) return;
    if (!offeringId) return void res.status(400).json({ error: "رقم الإسناد غير صالح" });
    const [row] = await db.select().from(schoolSubjectOfferingsTable).where(and(
      eq(schoolSubjectOfferingsTable.id, offeringId),
      eq(schoolSubjectOfferingsTable.companyId, companyId),
    )).limit(1);
    if (!row) return void res.status(404).json({ error: "إسناد المادة غير موجود" });
    const [exam] = await db.select({ id: schoolExamsTable.id }).from(schoolExamsTable).where(and(
      eq(schoolExamsTable.companyId, companyId),
      eq(schoolExamsTable.academicYearId, row.academicYearId),
      eq(schoolExamsTable.classId, row.classId),
      eq(schoolExamsTable.subjectId, row.subjectId),
    )).limit(1);
    if (exam) return void res.status(409).json({ error: "لا يمكن حذف إسناد له اختبارات مسجلة؛ عطّله بدلًا من ذلك" });
    await db.transaction(async (tx) => {
      await tx.delete(schoolSubjectOfferingsTable).where(and(
        eq(schoolSubjectOfferingsTable.id, offeringId),
        eq(schoolSubjectOfferingsTable.companyId, companyId),
      ));
      await audit(tx, {
        companyId,
        subjectId: row.subjectId,
        entityType: "subject_offering",
        entityId: offeringId,
        action: "delete",
        beforeValue: row,
        actorId: actorId(req),
      });
    });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

router.get("/policies", async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const gradeId = positiveInt(req.query.gradeId);
    if (!companyId) return;
    if (!gradeId) return void res.status(400).json({ error: "الصف غير صالح" });
    const rows = await db.select().from(schoolGradeSubjectPoliciesTable).where(and(
      eq(schoolGradeSubjectPoliciesTable.companyId, companyId),
      eq(schoolGradeSubjectPoliciesTable.gradeId, gradeId),
    )).orderBy(asc(schoolGradeSubjectPoliciesTable.subjectId));
    res.json(rows.map(normalizePolicy));
  } catch (error) { handleError(res, error); }
});

router.put("/policies/:subjectId", requirePermission("school", "edit"), async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const subjectId = positiveInt(req.params.subjectId);
    const parsed = SaveSchoolGradeSubjectPolicyBody.safeParse(req.body);
    if (!companyId) return;
    if (!subjectId || !parsed.success) return void res.status(400).json({ error: "إعدادات المادة غير صالحة" });
    const input = parsed.data;
    const midyearWeights = input.midyearWeights as Record<string, number>;
    const yearEndWeights = input.yearEndWeights as Record<string, number>;
    const minimumScore = Number(input.minimumScore);
    const maximumScore = Number(input.maximumScore);
    if (!validateWeights(midyearWeights, MIDYEAR_COMPONENTS)
      || !validateWeights(yearEndWeights, YEAR_END_COMPONENTS)
      || minimumScore >= maximumScore
      || Number(input.secondRoundPercent) > Number(input.passMarkPercent)) {
      return void res.status(400).json({ error: "تحقق من مجموع الأوزان والحدود؛ يجب أن يساوي كل مجموع 100%" });
    }
    const bands = input.gradeBands ?? [];
    if (bands.some((band: any) => !String(band.label ?? "").trim())
      || new Set(bands.map((band: any) => Number(band.minimumPercent))).size !== bands.length) {
      return void res.status(400).json({ error: "حدود التقدير يجب أن تكون فريدة ولها مسميات" });
    }
    const [subject] = await db.select().from(schoolSubjectsTable).where(and(
      eq(schoolSubjectsTable.id, subjectId),
      eq(schoolSubjectsTable.companyId, companyId),
    )).limit(1);
    const [grade] = await db.select().from(schoolGradesTable).where(and(
      eq(schoolGradesTable.id, input.gradeId),
      eq(schoolGradesTable.companyId, companyId),
    )).limit(1);
    if (!subject || !grade || (subject.gradeId != null && subject.gradeId !== input.gradeId)) {
      return void res.status(400).json({ error: "المادة والصف غير متوافقين" });
    }
    const [previous] = await db.select().from(schoolGradeSubjectPoliciesTable).where(and(
      eq(schoolGradeSubjectPoliciesTable.companyId, companyId),
      eq(schoolGradeSubjectPoliciesTable.gradeId, input.gradeId),
      eq(schoolGradeSubjectPoliciesTable.subjectId, subjectId),
    )).limit(1);
    const row = await db.transaction(async (tx) => {
      const [saved] = await tx.insert(schoolGradeSubjectPoliciesTable).values({
        companyId,
        gradeId: input.gradeId,
        subjectId,
        subjectType: input.subjectType.trim(),
        maximumScore: String(maximumScore),
        minimumScore: String(minimumScore),
        passMarkPercent: String(input.passMarkPercent),
        secondRoundPercent: String(input.secondRoundPercent),
        gradeBands: bands,
        midyearWeights,
        yearEndWeights,
        showDailyAssessmentsToGuardians: input.showDailyAssessmentsToGuardians,
        isActive: input.isActive ?? true,
      }).onConflictDoUpdate({
        target: [
          schoolGradeSubjectPoliciesTable.companyId,
          schoolGradeSubjectPoliciesTable.gradeId,
          schoolGradeSubjectPoliciesTable.subjectId,
        ],
        set: {
          subjectType: input.subjectType.trim(),
          maximumScore: String(maximumScore),
          minimumScore: String(minimumScore),
          passMarkPercent: String(input.passMarkPercent),
          secondRoundPercent: String(input.secondRoundPercent),
          gradeBands: bands,
          midyearWeights,
          yearEndWeights,
          showDailyAssessmentsToGuardians: input.showDailyAssessmentsToGuardians,
          isActive: input.isActive ?? true,
          updatedAt: new Date(),
        },
      }).returning();
      await audit(tx, {
        companyId,
        subjectId,
        entityType: "grading_policy",
        entityId: saved.id,
        action: previous ? "update" : "create",
        beforeValue: previous ?? null,
        afterValue: saved,
        actorId: actorId(req),
      });
      return saved;
    });
    res.json(normalizePolicy(row));
  } catch (error) { handleError(res, error); }
});

router.get("/gradebook", async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const academicYearId = positiveInt(req.query.academicYearId);
    const periodId = positiveInt(req.query.periodId);
    const classId = positiveInt(req.query.classId);
    const subjectId = positiveInt(req.query.subjectId);
    if (!companyId) return;
    if (!academicYearId || !periodId || !classId || !subjectId) {
      return void res.status(400).json({ error: "حدد السنة والفترة والفصل والمادة" });
    }
    const scope = await readScope(companyId, academicYearId, periodId, classId, subjectId);
    if (!scope) return void res.status(400).json({ error: "نطاق دفتر الدرجات غير متوافق" });
    const [students, exams, policy] = await Promise.all([
      db.select({
        enrollmentId: schoolEnrollmentsTable.id,
        studentId: schoolStudentsTable.id,
        studentNumber: schoolStudentsTable.studentNumber,
        fullNameAr: schoolStudentsTable.fullNameAr,
      }).from(schoolEnrollmentsTable)
        .innerJoin(schoolStudentsTable, and(
          eq(schoolStudentsTable.id, schoolEnrollmentsTable.studentId),
          eq(schoolStudentsTable.companyId, companyId),
        ))
        .where(and(
          eq(schoolEnrollmentsTable.companyId, companyId),
          eq(schoolEnrollmentsTable.academicYearId, academicYearId),
          eq(schoolEnrollmentsTable.classId, classId),
          eq(schoolEnrollmentsTable.status, "active"),
        )).orderBy(asc(schoolStudentsTable.fullNameAr)),
      db.select({
        id: schoolExamsTable.id,
        name: schoolExamsTable.name,
        examDate: schoolExamsTable.examDate,
        maxScore: schoolExamsTable.maxScore,
        assessmentType: schoolExamsTable.assessmentType,
        status: schoolExamsTable.status,
      }).from(schoolExamsTable).where(and(
        eq(schoolExamsTable.companyId, companyId),
        eq(schoolExamsTable.academicYearId, academicYearId),
        eq(schoolExamsTable.classId, classId),
        eq(schoolExamsTable.subjectId, subjectId),
        or(
          eq(schoolExamsTable.periodId, periodId),
          and(
            isNull(schoolExamsTable.periodId),
            gte(schoolExamsTable.examDate, scope.period.startDate),
            lte(schoolExamsTable.examDate, scope.period.endDate),
          ),
        ),
      )).orderBy(asc(schoolExamsTable.examDate), asc(schoolExamsTable.id)),
      db.select().from(schoolGradeSubjectPoliciesTable).where(and(
        eq(schoolGradeSubjectPoliciesTable.companyId, companyId),
        eq(schoolGradeSubjectPoliciesTable.gradeId, scope.schoolClass.gradeId),
        eq(schoolGradeSubjectPoliciesTable.subjectId, subjectId),
      )).limit(1),
    ]);
    const examIds = exams.map((exam) => exam.id);
    const resultRows = examIds.length ? await db.select({
      id: schoolExamResultsTable.id,
      examId: schoolExamResultsTable.examId,
      enrollmentId: schoolExamResultsTable.enrollmentId,
      score: schoolExamResultsTable.score,
      notes: schoolExamResultsTable.notes,
    }).from(schoolExamResultsTable).where(and(
      eq(schoolExamResultsTable.companyId, companyId),
      inArray(schoolExamResultsTable.examId, examIds),
    )) : [];
    const byEnrollment = new Map<number, Array<{ enrollmentId: number; resultId: number; examId: number; score: number; notes: string | null }>>();
    for (const result of resultRows) {
      const rows = byEnrollment.get(result.enrollmentId) ?? [];
      rows.push({
        enrollmentId: result.enrollmentId,
        resultId: result.id,
        examId: result.examId,
        score: numeric(result.score),
        notes: result.notes ?? null,
      });
      byEnrollment.set(result.enrollmentId, rows);
    }
    const locked = !!await activeApproval(companyId, academicYearId, periodId, classId, subjectId);
    res.json({
      students: students.map((student) => ({
        ...student,
        marks: byEnrollment.get(student.enrollmentId) ?? [],
      })),
      assessments: exams.map((exam) => ({ ...exam, maxScore: numeric(exam.maxScore) })),
      policy: normalizePolicy(policy[0]),
      locked,
    });
  } catch (error) { handleError(res, error); }
});

router.post("/gradebook", requirePermission("school", "edit"), async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const parsed = SaveSchoolGradebookMarksBody.safeParse(req.body);
    if (!companyId) return;
    if (!parsed.success) return void res.status(400).json({ error: "درجات الطلاب غير صالحة" });
    const { examId, records } = parsed.data;
    if (new Set(records.map((record) => record.enrollmentId)).size !== records.length) {
      return void res.status(400).json({ error: "لا تكرر الطالب في الدفعة نفسها" });
    }
    const [exam] = await db.select().from(schoolExamsTable).where(and(
      eq(schoolExamsTable.id, examId),
      eq(schoolExamsTable.companyId, companyId),
    )).limit(1);
    if (!exam) return void res.status(404).json({ error: "الاختبار غير موجود" });
    const periodId = exam.periodId;
    if (periodId) {
      const locked = await activeApproval(companyId, exam.academicYearId, periodId, exam.classId, exam.subjectId);
      if (locked) return void res.status(423).json({ error: "النتائج معتمدة. يجب إعادة فتحها بصلاحية إدارية قبل التعديل" });
    }
    const [scopePeriod] = periodId
      ? await db.select().from(schoolAcademicPeriodsTable).where(and(
        eq(schoolAcademicPeriodsTable.id, periodId),
        eq(schoolAcademicPeriodsTable.companyId, companyId),
      )).limit(1)
      : await db.select().from(schoolAcademicPeriodsTable).where(and(
        eq(schoolAcademicPeriodsTable.companyId, companyId),
        eq(schoolAcademicPeriodsTable.academicYearId, exam.academicYearId),
        lte(schoolAcademicPeriodsTable.startDate, exam.examDate),
        gte(schoolAcademicPeriodsTable.endDate, exam.examDate),
      )).limit(1);
    if (scopePeriod) {
      const locked = await activeApproval(companyId, exam.academicYearId, scopePeriod.id, exam.classId, exam.subjectId);
      if (locked) return void res.status(423).json({ error: "النتائج معتمدة. يجب إعادة فتحها بصلاحية إدارية قبل التعديل" });
    }
    const [policy] = await db.select({ maximumScore: schoolGradeSubjectPoliciesTable.maximumScore })
      .from(schoolGradeSubjectPoliciesTable).innerJoin(schoolClassesTable, and(
        eq(schoolClassesTable.gradeId, schoolGradeSubjectPoliciesTable.gradeId),
        eq(schoolClassesTable.id, exam.classId),
        eq(schoolClassesTable.companyId, companyId),
      )).where(and(
        eq(schoolGradeSubjectPoliciesTable.companyId, companyId),
        eq(schoolGradeSubjectPoliciesTable.subjectId, exam.subjectId),
      )).limit(1);
    for (const record of records) {
      const [enrollment] = await db.select().from(schoolEnrollmentsTable).where(and(
        eq(schoolEnrollmentsTable.id, record.enrollmentId),
        eq(schoolEnrollmentsTable.companyId, companyId),
        eq(schoolEnrollmentsTable.academicYearId, exam.academicYearId),
        eq(schoolEnrollmentsTable.classId, exam.classId),
      )).limit(1);
      if (!enrollment) return void res.status(400).json({ error: "أحد الطلاب لا ينتمي إلى فصل الاختبار" });
      if (record.score != null && record.score > numeric(exam.maxScore)) {
        return void res.status(400).json({ error: "درجة الطالب تتجاوز الدرجة القصوى للاختبار" });
      }
      if (record.score != null && policy && record.score > numeric(policy.maximumScore)) {
        return void res.status(400).json({ error: "الدرجة تتجاوز الحد الأعلى المحدد للمادة" });
      }
    }
    const saved = await db.transaction(async (tx) => {
      let changed = 0;
      for (const record of records) {
        const [previous] = await tx.select().from(schoolExamResultsTable).where(and(
          eq(schoolExamResultsTable.companyId, companyId),
          eq(schoolExamResultsTable.examId, examId),
          eq(schoolExamResultsTable.enrollmentId, record.enrollmentId),
        )).limit(1);
        if (record.score == null) {
          if (previous) {
            await tx.delete(schoolExamResultsTable).where(eq(schoolExamResultsTable.id, previous.id));
            await audit(tx, {
              companyId, enrollmentId: record.enrollmentId, subjectId: exam.subjectId,
              entityType: "exam_result", entityId: previous.id, action: "delete",
              beforeValue: previous, actorId: actorId(req),
            });
            changed++;
          }
          continue;
        }
        const [row] = await tx.insert(schoolExamResultsTable).values({
          companyId,
          examId,
          enrollmentId: record.enrollmentId,
          score: String(record.score),
          notes: record.notes ?? null,
        }).onConflictDoUpdate({
          target: [
            schoolExamResultsTable.companyId,
            schoolExamResultsTable.examId,
            schoolExamResultsTable.enrollmentId,
          ],
          set: { score: String(record.score), notes: record.notes ?? null, updatedAt: new Date() },
        }).returning();
        await audit(tx, {
          companyId, enrollmentId: record.enrollmentId, subjectId: exam.subjectId,
          entityType: "exam_result", entityId: row.id,
          action: previous ? "update" : "create",
          beforeValue: previous ?? null,
          afterValue: row,
          actorId: actorId(req),
        });
        changed++;
      }
      return changed;
    });
    res.json({ saved });
  } catch (error) { handleError(res, error); }
});

router.get("/daily-assessments", async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const academicYearId = positiveInt(req.query.academicYearId);
    const periodId = positiveInt(req.query.periodId);
    const classId = positiveInt(req.query.classId);
    const subjectId = positiveInt(req.query.subjectId);
    const assessmentDate = String(req.query.assessmentDate ?? "");
    if (!companyId) return;
    if (!academicYearId || !periodId || !classId || !subjectId || !/^\d{4}-\d{2}-\d{2}$/.test(assessmentDate)) {
      return void res.status(400).json({ error: "حدد السنة والفترة والفصل والمادة والتاريخ" });
    }
    const scope = await readScope(companyId, academicYearId, periodId, classId, subjectId);
    if (!scope || assessmentDate < scope.period.startDate || assessmentDate > scope.period.endDate) {
      return void res.status(400).json({ error: "تاريخ التقييم خارج الفترة المحددة" });
    }
    const rows = await db.select({
      enrollmentId: schoolEnrollmentsTable.id,
      studentId: schoolStudentsTable.id,
      studentNumber: schoolStudentsTable.studentNumber,
      fullNameAr: schoolStudentsTable.fullNameAr,
      attendanceStatus: schoolAttendanceTable.status,
      assessmentId: schoolDailyAssessmentsTable.id,
      attendanceDiscipline: schoolDailyAssessmentsTable.attendanceDiscipline,
      participation: schoolDailyAssessmentsTable.participation,
      homework: schoolDailyAssessmentsTable.homework,
      activity: schoolDailyAssessmentsTable.activity,
      behavior: schoolDailyAssessmentsTable.behavior,
      teacherEvaluation: schoolDailyAssessmentsTable.teacherEvaluation,
      notes: schoolDailyAssessmentsTable.notes,
    }).from(schoolEnrollmentsTable)
      .innerJoin(schoolStudentsTable, and(
        eq(schoolStudentsTable.id, schoolEnrollmentsTable.studentId),
        eq(schoolStudentsTable.companyId, companyId),
      ))
      .leftJoin(schoolAttendanceTable, and(
        eq(schoolAttendanceTable.enrollmentId, schoolEnrollmentsTable.id),
        eq(schoolAttendanceTable.companyId, companyId),
        eq(schoolAttendanceTable.attendanceDate, assessmentDate),
        eq(schoolAttendanceTable.period, "full_day"),
      ))
      .leftJoin(schoolDailyAssessmentsTable, and(
        eq(schoolDailyAssessmentsTable.enrollmentId, schoolEnrollmentsTable.id),
        eq(schoolDailyAssessmentsTable.companyId, companyId),
        eq(schoolDailyAssessmentsTable.subjectId, subjectId),
        eq(schoolDailyAssessmentsTable.assessmentDate, assessmentDate),
      ))
      .where(and(
        eq(schoolEnrollmentsTable.companyId, companyId),
        eq(schoolEnrollmentsTable.academicYearId, academicYearId),
        eq(schoolEnrollmentsTable.classId, classId),
        eq(schoolEnrollmentsTable.status, "active"),
      )).orderBy(asc(schoolStudentsTable.fullNameAr));
    res.json(rows.map((row) => ({
      enrollmentId: row.enrollmentId,
      studentId: row.studentId,
      studentNumber: row.studentNumber,
      fullNameAr: row.fullNameAr,
      attendanceStatus: row.attendanceStatus ?? null,
      assessmentId: row.assessmentId ?? null,
      scores: Object.fromEntries(DAILY_SCORE_FIELDS.map((field) => [field, nullableNumeric(row[field])])),
      notes: row.notes ?? null,
    })));
  } catch (error) { handleError(res, error); }
});

router.put("/daily-assessments", requirePermission("school", "edit"), async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const parsed = SaveSchoolDailyAssessmentsBody.safeParse(req.body);
    if (!companyId) return;
    if (!parsed.success) return void res.status(400).json({ error: "التقييمات اليومية غير صالحة" });
    const input = parsed.data;
    const assessmentDate = dateString(input.assessmentDate);
    const scope = await readScope(companyId, input.academicYearId, input.periodId, input.classId, input.subjectId);
    if (!scope || assessmentDate < scope.period.startDate || assessmentDate > scope.period.endDate) {
      return void res.status(400).json({ error: "تاريخ التقييم أو النطاق غير صالح" });
    }
    const locked = await activeApproval(companyId, input.academicYearId, input.periodId, input.classId, input.subjectId);
    if (locked) return void res.status(423).json({ error: "النتائج معتمدة. يجب إعادة فتحها بصلاحية إدارية قبل التعديل" });
    if (new Set(input.records.map((record) => record.enrollmentId)).size !== input.records.length) {
      return void res.status(400).json({ error: "لا تكرر الطالب في الدفعة نفسها" });
    }
    const [offering] = await db.select({ teacherEmployeeId: schoolSubjectOfferingsTable.teacherEmployeeId })
      .from(schoolSubjectOfferingsTable).where(and(
        eq(schoolSubjectOfferingsTable.companyId, companyId),
        eq(schoolSubjectOfferingsTable.academicYearId, input.academicYearId),
        eq(schoolSubjectOfferingsTable.classId, input.classId),
        eq(schoolSubjectOfferingsTable.subjectId, input.subjectId),
      )).limit(1);
    for (const record of input.records) {
      if (DAILY_SCORE_FIELDS.some((field) => record.scores[field] != null
        && (Number(record.scores[field]) < 0 || Number(record.scores[field]) > 100))) {
        return void res.status(400).json({ error: "كل قيمة تقييم يجب أن تكون بين صفر و100" });
      }
      const [enrollment] = await db.select({ id: schoolEnrollmentsTable.id }).from(schoolEnrollmentsTable).where(and(
        eq(schoolEnrollmentsTable.companyId, companyId),
        eq(schoolEnrollmentsTable.id, record.enrollmentId),
        eq(schoolEnrollmentsTable.academicYearId, input.academicYearId),
        eq(schoolEnrollmentsTable.classId, input.classId),
      )).limit(1);
      if (!enrollment) return void res.status(400).json({ error: "أحد الطلاب لا ينتمي إلى الفصل المحدد" });
    }
    const saved = await db.transaction(async (tx) => {
      for (const record of input.records) {
        const [previous] = await tx.select().from(schoolDailyAssessmentsTable).where(and(
          eq(schoolDailyAssessmentsTable.companyId, companyId),
          eq(schoolDailyAssessmentsTable.enrollmentId, record.enrollmentId),
          eq(schoolDailyAssessmentsTable.subjectId, input.subjectId),
          eq(schoolDailyAssessmentsTable.assessmentDate, assessmentDate),
        )).limit(1);
        const values: any = {
          companyId,
          enrollmentId: record.enrollmentId,
          subjectId: input.subjectId,
          periodId: input.periodId,
          teacherEmployeeId: offering?.teacherEmployeeId ?? null,
          assessmentDate,
          notes: record.notes ?? null,
          updatedAt: new Date(),
        };
        for (const field of DAILY_SCORE_FIELDS) {
          values[field] = record.scores[field] == null ? null : String(record.scores[field]);
        }
        const [row] = await tx.insert(schoolDailyAssessmentsTable).values(values).onConflictDoUpdate({
          target: [
            schoolDailyAssessmentsTable.companyId,
            schoolDailyAssessmentsTable.enrollmentId,
            schoolDailyAssessmentsTable.subjectId,
            schoolDailyAssessmentsTable.assessmentDate,
          ],
          set: {
            periodId: input.periodId,
            teacherEmployeeId: offering?.teacherEmployeeId ?? null,
            attendanceDiscipline: values.attendanceDiscipline,
            participation: values.participation,
            homework: values.homework,
            activity: values.activity,
            behavior: values.behavior,
            teacherEvaluation: values.teacherEvaluation,
            notes: values.notes,
            updatedAt: new Date(),
          },
        }).returning();
        await audit(tx, {
          companyId,
          enrollmentId: record.enrollmentId,
          subjectId: input.subjectId,
          entityType: "daily_assessment",
          entityId: row.id,
          action: previous ? "update" : "create",
          beforeValue: previous ?? null,
          afterValue: row,
          actorId: actorId(req),
        });
      }
      return input.records.length;
    });
    res.json({ saved });
  } catch (error) { handleError(res, error); }
});

async function componentScoresForScope(
  companyId: number,
  academicYearId: number,
  periodId: number,
  classId: number,
  subjectId: number,
  enrollmentIds: number[],
  publicationType: "midyear" | "year_end",
  period: any,
) {
  const exams = await db.select({
    assessmentType: schoolExamsTable.assessmentType,
    enrollmentId: schoolExamResultsTable.enrollmentId,
    score: schoolExamResultsTable.score,
    maxScore: schoolExamsTable.maxScore,
    notes: schoolExamResultsTable.notes,
  }).from(schoolExamResultsTable).innerJoin(schoolExamsTable, and(
    eq(schoolExamsTable.id, schoolExamResultsTable.examId),
    eq(schoolExamsTable.companyId, companyId),
  )).where(and(
    eq(schoolExamResultsTable.companyId, companyId),
    eq(schoolExamsTable.academicYearId, academicYearId),
    eq(schoolExamsTable.classId, classId),
    eq(schoolExamsTable.subjectId, subjectId),
    or(
      eq(schoolExamsTable.periodId, periodId),
      and(
        isNull(schoolExamsTable.periodId),
        gte(schoolExamsTable.examDate, period.startDate),
        lte(schoolExamsTable.examDate, period.endDate),
      ),
    ),
    inArray(schoolExamResultsTable.enrollmentId, enrollmentIds),
  ));
  const daily = await db.select().from(schoolDailyAssessmentsTable).where(and(
    eq(schoolDailyAssessmentsTable.companyId, companyId),
    eq(schoolDailyAssessmentsTable.subjectId, subjectId),
    gte(schoolDailyAssessmentsTable.assessmentDate, period.startDate),
    lte(schoolDailyAssessmentsTable.assessmentDate, period.endDate),
    inArray(schoolDailyAssessmentsTable.enrollmentId, enrollmentIds),
  ));
  const midyearRows = publicationType === "year_end"
    ? await db.select({ resultsSnapshot: schoolResultApprovalsTable.resultsSnapshot })
      .from(schoolResultApprovalsTable).where(and(
        eq(schoolResultApprovalsTable.companyId, companyId),
        eq(schoolResultApprovalsTable.academicYearId, academicYearId),
        eq(schoolResultApprovalsTable.classId, classId),
        eq(schoolResultApprovalsTable.subjectId, subjectId),
        eq(schoolResultApprovalsTable.publicationType, "midyear"),
        eq(schoolResultApprovalsTable.status, "approved"),
      )).orderBy(desc(schoolResultApprovalsTable.approvedAt)).limit(1)
    : [];
  const previousMidyear = new Map<number, number>();
  for (const row of (midyearRows[0]?.resultsSnapshot as any[] | undefined) ?? []) {
    if (Number.isSafeInteger(Number(row.enrollmentId))) previousMidyear.set(Number(row.enrollmentId), numeric(row.percentage));
  }
  const result = new Map<number, { scores: Record<string, number | null>; notes: string[] }>();
  for (const enrollmentId of enrollmentIds) {
    result.set(enrollmentId, {
      scores: Object.fromEntries([...DAILY_SCORE_FIELDS, "coursework", "monthly", "midyear", "yearEnd"].map((key) => [key, null])),
      notes: [],
    });
  }
  const examValues = new Map<number, Map<string, number[]>>();
  for (const row of exams) {
    const key = row.assessmentType === "year_end" ? "yearEnd" : row.assessmentType;
    const scores = examValues.get(row.enrollmentId) ?? new Map<string, number[]>();
    const values = scores.get(key) ?? [];
    if (numeric(row.maxScore) > 0) values.push(numeric(row.score) / numeric(row.maxScore) * 100);
    scores.set(key, values);
    examValues.set(row.enrollmentId, scores);
    if (row.notes) result.get(row.enrollmentId)?.notes.push(row.notes);
  }
  for (const [enrollmentId, categories] of examValues) {
    const row = result.get(enrollmentId);
    if (!row) continue;
    for (const [category, values] of categories) {
      row.scores[category] = values.length
        ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length)
        : null;
    }
  }
  const dailyValues = new Map<number, Map<string, number[]>>();
  for (const row of daily as any[]) {
    const valuesByField = dailyValues.get(row.enrollmentId) ?? new Map<string, number[]>();
    for (const field of DAILY_SCORE_FIELDS) {
      const value = nullableNumeric(row[field]);
      if (value == null) continue;
      const values = valuesByField.get(field) ?? [];
      values.push(value);
      valuesByField.set(field, values);
    }
    dailyValues.set(row.enrollmentId, valuesByField);
    if (row.notes) result.get(row.enrollmentId)?.notes.push(row.notes);
  }
  for (const [enrollmentId, valuesByField] of dailyValues) {
    const row = result.get(enrollmentId);
    if (!row) continue;
    for (const [field, values] of valuesByField) {
      row.scores[field] = values.length
        ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length)
        : null;
    }
  }
  if (publicationType === "year_end") {
    for (const [enrollmentId, percentage] of previousMidyear) {
      const row = result.get(enrollmentId);
      if (row) row.scores.midyear = percentage;
    }
  }
  return result;
}

router.get("/approvals", async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const academicYearId = positiveInt(req.query.academicYearId);
    const classId = req.query.classId == null ? null : positiveInt(req.query.classId);
    if (!companyId) return;
    if (!academicYearId || (req.query.classId != null && !classId)) {
      return void res.status(400).json({ error: "السنة أو الفصل غير صالح" });
    }
    const filters = [
      eq(schoolResultApprovalsTable.companyId, companyId),
      eq(schoolResultApprovalsTable.academicYearId, academicYearId),
    ];
    if (classId) filters.push(eq(schoolResultApprovalsTable.classId, classId));
    const rows = await db.select().from(schoolResultApprovalsTable).where(and(...filters))
      .orderBy(desc(schoolResultApprovalsTable.approvedAt));
    res.json(rows.map(normalizeApproval));
  } catch (error) { handleError(res, error); }
});

router.post("/approvals", requirePermission("school", "edit"), requireAdminRole, async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const parsed = ApproveSchoolResultsBody.safeParse(req.body);
    if (!companyId) return;
    if (!parsed.success) return void res.status(400).json({ error: "بيانات اعتماد النتيجة غير صالحة" });
    const input = parsed.data;
    const scope = await readScope(companyId, input.academicYearId, input.periodId, input.classId, input.subjectId);
    if (!scope || scope.period.periodType !== input.publicationType) {
      return void res.status(400).json({ error: "يجب أن تتوافق فترة الاعتماد مع نوع النتيجة" });
    }
    const [policyRow] = await db.select().from(schoolGradeSubjectPoliciesTable).where(and(
      eq(schoolGradeSubjectPoliciesTable.companyId, companyId),
      eq(schoolGradeSubjectPoliciesTable.gradeId, scope.schoolClass.gradeId),
      eq(schoolGradeSubjectPoliciesTable.subjectId, input.subjectId),
      eq(schoolGradeSubjectPoliciesTable.isActive, true),
    )).limit(1);
    const policy = normalizePolicy(policyRow);
    if (!policy) return void res.status(400).json({ error: "يجب إعداد أوزان ودرجات نجاح للمادة قبل الاعتماد" });
    const weights = input.publicationType === "midyear" ? policy.midyearWeights : policy.yearEndWeights;
    const allowed = input.publicationType === "midyear" ? MIDYEAR_COMPONENTS : YEAR_END_COMPONENTS;
    if (!validateWeights(weights, allowed)) {
      return void res.status(400).json({ error: "أوزان المادة غير مكتملة أو لا يساوي مجموعها 100%" });
    }
    const enrollments = await db.select({
      enrollmentId: schoolEnrollmentsTable.id,
      studentId: schoolStudentsTable.id,
      studentNumber: schoolStudentsTable.studentNumber,
      fullNameAr: schoolStudentsTable.fullNameAr,
    }).from(schoolEnrollmentsTable).innerJoin(schoolStudentsTable, and(
      eq(schoolStudentsTable.id, schoolEnrollmentsTable.studentId),
      eq(schoolStudentsTable.companyId, companyId),
    )).where(and(
      eq(schoolEnrollmentsTable.companyId, companyId),
      eq(schoolEnrollmentsTable.academicYearId, input.academicYearId),
      eq(schoolEnrollmentsTable.classId, input.classId),
      eq(schoolEnrollmentsTable.status, "active"),
    ));
    if (!enrollments.length) return void res.status(409).json({ error: "لا يوجد طلاب نشطون في الفصل لاعتماد النتائج" });
    const components = await componentScoresForScope(
      companyId, input.academicYearId, input.periodId, input.classId, input.subjectId,
      enrollments.map((row) => row.enrollmentId), input.publicationType, scope.period,
    );
    const snapshots: any[] = [];
    const incomplete: Array<{ enrollmentId: number; missing: string[] }> = [];
    for (const enrollment of enrollments) {
      const component = components.get(enrollment.enrollmentId)!;
      const calculated = calculateWeightedPercentage(weights, component.scores);
      if (!calculated.complete || calculated.percentage == null) {
        incomplete.push({ enrollmentId: enrollment.enrollmentId, missing: calculated.missing });
        continue;
      }
      const percentage = calculated.percentage;
      const score = rounded(policy.minimumScore + (policy.maximumScore - policy.minimumScore) * percentage / 100);
      snapshots.push({
        ...enrollment,
        score,
        maximumScore: policy.maximumScore,
        percentage,
        grade: gradeLabel(percentage, policy.gradeBands ?? []),
        status: resultStatus(percentage, policy.passMarkPercent, policy.secondRoundPercent),
        teacherNotes: [...new Set(component.notes)].join(" · ").slice(0, 2000),
      });
    }
    if (incomplete.length) {
      return void res.status(409).json({
        error: "تعذر اعتماد النتيجة قبل استكمال جميع مكونات الدرجة الموزونة",
        incomplete,
      });
    }
    const approval = await db.transaction(async (tx) => {
      const lockKey = `school-result:${companyId}:${input.academicYearId}:${input.periodId}:${input.classId}:${input.subjectId}:${input.publicationType}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      await tx.update(schoolResultApprovalsTable).set({
        status: "reopened",
        reopenedById: actorId(req),
        reopenedAt: new Date(),
      }).where(and(
        eq(schoolResultApprovalsTable.companyId, companyId),
        eq(schoolResultApprovalsTable.academicYearId, input.academicYearId),
        eq(schoolResultApprovalsTable.periodId, input.periodId),
        eq(schoolResultApprovalsTable.classId, input.classId),
        eq(schoolResultApprovalsTable.subjectId, input.subjectId),
        eq(schoolResultApprovalsTable.publicationType, input.publicationType),
        eq(schoolResultApprovalsTable.status, "approved"),
      ));
      const [row] = await tx.insert(schoolResultApprovalsTable).values({
        companyId,
        academicYearId: input.academicYearId,
        periodId: input.periodId,
        classId: input.classId,
        subjectId: input.subjectId,
        publicationType: input.publicationType,
        status: "approved",
        resultsSnapshot: snapshots,
        approvedById: actorId(req),
      }).returning();
      await audit(tx, {
        companyId,
        subjectId: input.subjectId,
        entityType: "result_approval",
        entityId: row.id,
        action: "approve",
        afterValue: row,
        actorId: actorId(req),
      });
      return row;
    });
    res.status(201).json(normalizeApproval(approval));
  } catch (error) { handleError(res, error); }
});

router.post("/approvals/:approvalId/reopen", requirePermission("school", "edit"), requireAdminRole, async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const approvalId = positiveInt(req.params.approvalId);
    if (!companyId) return;
    if (!approvalId) return void res.status(400).json({ error: "رقم الاعتماد غير صالح" });
    const [previous] = await db.select().from(schoolResultApprovalsTable).where(and(
      eq(schoolResultApprovalsTable.id, approvalId),
      eq(schoolResultApprovalsTable.companyId, companyId),
      eq(schoolResultApprovalsTable.status, "approved"),
    )).limit(1);
    if (!previous) return void res.status(404).json({ error: "الاعتماد غير موجود أو سبق إعادة فتحه" });
    const row = await db.transaction(async (tx) => {
      const [reopened] = await tx.update(schoolResultApprovalsTable).set({
        status: "reopened",
        reopenedById: actorId(req),
        reopenedAt: new Date(),
      }).where(and(
        eq(schoolResultApprovalsTable.id, approvalId),
        eq(schoolResultApprovalsTable.companyId, companyId),
        eq(schoolResultApprovalsTable.status, "approved"),
      )).returning();
      if (!reopened) throw new Error("تعذر إعادة فتح النتائج المعتمدة");
      await audit(tx, {
        companyId,
        subjectId: previous.subjectId,
        entityType: "result_approval",
        entityId: previous.id,
        action: "reopen",
        beforeValue: previous,
        afterValue: reopened,
        actorId: actorId(req),
      });
      return reopened;
    });
    res.json(normalizeApproval(row));
  } catch (error) { handleError(res, error); }
});

router.get("/reports", async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const reportType = String(req.query.reportType ?? "");
    const allowed = new Set(["weekly", "monthly", "monthly_exams", "midyear", "year_end", "student_progress"]);
    if (!companyId) return;
    if (!allowed.has(reportType)) return void res.status(400).json({ error: "نوع التقرير غير صالح" });
    const academicYearId = req.query.academicYearId == null ? null : positiveInt(req.query.academicYearId);
    const periodId = req.query.periodId == null ? null : positiveInt(req.query.periodId);
    const classId = req.query.classId == null ? null : positiveInt(req.query.classId);
    const subjectId = req.query.subjectId == null ? null : positiveInt(req.query.subjectId);
    const enrollmentId = req.query.enrollmentId == null ? null : positiveInt(req.query.enrollmentId);
    if (["midyear", "year_end"].includes(reportType) && !academicYearId) {
      return void res.status(400).json({ error: "اختر السنة الدراسية للتقرير" });
    }
    let startDate = String(req.query.startDate ?? "");
    let endDate = String(req.query.endDate ?? "");
    if (periodId) {
      const [period] = await db.select().from(schoolAcademicPeriodsTable).where(and(
        eq(schoolAcademicPeriodsTable.companyId, companyId),
        eq(schoolAcademicPeriodsTable.id, periodId),
      )).limit(1);
      if (!period) return void res.status(404).json({ error: "الفترة الدراسية غير موجودة" });
      startDate ||= period.startDate;
      endDate ||= period.endDate;
    }
    if (!startDate || !endDate) {
      const end = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
      const days = reportType === "weekly" ? 6 : 29;
      const start = new Date(`${end}T12:00:00.000Z`);
      start.setUTCDate(start.getUTCDate() - days);
      startDate ||= start.toISOString().slice(0, 10);
      endDate ||= end;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
      return void res.status(400).json({ error: "نطاق التاريخ غير صالح" });
    }
    if (reportType === "midyear" || reportType === "year_end") {
      const filters = [
        eq(schoolResultApprovalsTable.companyId, companyId),
        eq(schoolResultApprovalsTable.academicYearId, academicYearId!),
        eq(schoolResultApprovalsTable.publicationType, reportType),
        eq(schoolResultApprovalsTable.status, "approved"),
      ];
      if (classId) filters.push(eq(schoolResultApprovalsTable.classId, classId));
      if (subjectId) filters.push(eq(schoolResultApprovalsTable.subjectId, subjectId));
      const approvals = await db.select().from(schoolResultApprovalsTable).where(and(...filters))
        .orderBy(desc(schoolResultApprovalsTable.approvedAt));
      const rows = approvals.flatMap((approval) => (approval.resultsSnapshot as any[]).map((result) => ({
        enrollmentId: result.enrollmentId,
        studentId: result.studentId,
        studentNumber: result.studentNumber,
        fullNameAr: result.fullNameAr,
        subjectId: approval.subjectId,
        subjectNameAr: (awaitableSubjectName(companyId, approval.subjectId)),
        assessmentCount: 1,
        averagePercent: result.percentage,
        score: result.score,
        maximumScore: result.maximumScore,
        grade: result.grade,
        status: result.status,
        teacherNotes: result.teacherNotes ?? "",
      })));
      const resolvedRows = await Promise.all(rows.map(async (row) => ({
        ...row,
        subjectNameAr: await row.subjectNameAr,
      })));
      return void res.json({ reportType, startDate, endDate, rows: resolvedRows });
    }
    const filters: any[] = [
      eq(schoolExamResultsTable.companyId, companyId),
      gte(schoolExamsTable.examDate, startDate),
      lte(schoolExamsTable.examDate, endDate),
    ];
    if (academicYearId) filters.push(eq(schoolExamsTable.academicYearId, academicYearId));
    if (classId) filters.push(eq(schoolExamsTable.classId, classId));
    if (subjectId) filters.push(eq(schoolExamsTable.subjectId, subjectId));
    if (enrollmentId) filters.push(eq(schoolExamResultsTable.enrollmentId, enrollmentId));
    if (reportType === "monthly_exams") filters.push(eq(schoolExamsTable.assessmentType, "monthly"));
    const examRows = await db.select({
      enrollmentId: schoolExamResultsTable.enrollmentId,
      studentId: schoolStudentsTable.id,
      studentNumber: schoolStudentsTable.studentNumber,
      fullNameAr: schoolStudentsTable.fullNameAr,
      subjectId: schoolExamsTable.subjectId,
      subjectNameAr: schoolSubjectsTable.nameAr,
      score: schoolExamResultsTable.score,
      maxScore: schoolExamsTable.maxScore,
      notes: schoolExamResultsTable.notes,
      examDate: schoolExamsTable.examDate,
    }).from(schoolExamResultsTable)
      .innerJoin(schoolExamsTable, and(
        eq(schoolExamsTable.id, schoolExamResultsTable.examId),
        eq(schoolExamsTable.companyId, companyId),
      ))
      .innerJoin(schoolEnrollmentsTable, and(
        eq(schoolEnrollmentsTable.id, schoolExamResultsTable.enrollmentId),
        eq(schoolEnrollmentsTable.companyId, companyId),
      ))
      .innerJoin(schoolStudentsTable, and(
        eq(schoolStudentsTable.id, schoolEnrollmentsTable.studentId),
        eq(schoolStudentsTable.companyId, companyId),
      ))
      .innerJoin(schoolSubjectsTable, and(
        eq(schoolSubjectsTable.id, schoolExamsTable.subjectId),
        eq(schoolSubjectsTable.companyId, companyId),
      ))
      .where(and(...filters));
    const dailyFilters: any[] = [
      eq(schoolDailyAssessmentsTable.companyId, companyId),
      gte(schoolDailyAssessmentsTable.assessmentDate, startDate),
      lte(schoolDailyAssessmentsTable.assessmentDate, endDate),
    ];
    if (subjectId) dailyFilters.push(eq(schoolDailyAssessmentsTable.subjectId, subjectId));
    if (enrollmentId) dailyFilters.push(eq(schoolDailyAssessmentsTable.enrollmentId, enrollmentId));
    if (classId) {
      dailyFilters.push(inArray(schoolDailyAssessmentsTable.enrollmentId, db.select({
        id: schoolEnrollmentsTable.id,
      }).from(schoolEnrollmentsTable).where(and(
        eq(schoolEnrollmentsTable.companyId, companyId),
        eq(schoolEnrollmentsTable.classId, classId),
      ))));
    }
    const dailyRows = await db.select({
      enrollmentId: schoolDailyAssessmentsTable.enrollmentId,
      subjectId: schoolDailyAssessmentsTable.subjectId,
      assessmentDate: schoolDailyAssessmentsTable.assessmentDate,
      attendanceDiscipline: schoolDailyAssessmentsTable.attendanceDiscipline,
      participation: schoolDailyAssessmentsTable.participation,
      homework: schoolDailyAssessmentsTable.homework,
      activity: schoolDailyAssessmentsTable.activity,
      behavior: schoolDailyAssessmentsTable.behavior,
      teacherEvaluation: schoolDailyAssessmentsTable.teacherEvaluation,
      notes: schoolDailyAssessmentsTable.notes,
    }).from(schoolDailyAssessmentsTable).where(and(...dailyFilters));
    const aggregate = new Map<string, any>();
    const ensureRow = (input: any) => {
      const key = `${input.enrollmentId}:${input.subjectId}`;
      const row = aggregate.get(key) ?? {
        enrollmentId: input.enrollmentId,
        studentId: input.studentId,
        studentNumber: input.studentNumber,
        fullNameAr: input.fullNameAr,
        subjectId: input.subjectId,
        subjectNameAr: input.subjectNameAr,
        assessmentCount: 0,
        totalPercent: 0,
        score: null,
        maximumScore: null,
        grade: "",
        status: "in_progress",
        notes: [],
      };
      aggregate.set(key, row);
      return row;
    };
    for (const row of examRows) {
      const target = ensureRow(row);
      const max = numeric(row.maxScore);
      target.assessmentCount++;
      if (max > 0) target.totalPercent += numeric(row.score) / max * 100;
      if (row.notes) target.notes.push(row.notes);
    }
    if (dailyRows.length) {
      const studentRows = await db.select({
        enrollmentId: schoolEnrollmentsTable.id,
        studentId: schoolStudentsTable.id,
        studentNumber: schoolStudentsTable.studentNumber,
        fullNameAr: schoolStudentsTable.fullNameAr,
        subjectId: schoolSubjectsTable.id,
        subjectNameAr: schoolSubjectsTable.nameAr,
      }).from(schoolEnrollmentsTable)
        .innerJoin(schoolStudentsTable, and(
          eq(schoolStudentsTable.id, schoolEnrollmentsTable.studentId),
          eq(schoolStudentsTable.companyId, companyId),
        ))
        .innerJoin(schoolClassesTable, and(
          eq(schoolClassesTable.id, schoolEnrollmentsTable.classId),
          eq(schoolClassesTable.companyId, companyId),
        ))
        .innerJoin(schoolSubjectsTable, and(
          eq(schoolSubjectsTable.companyId, companyId),
          subjectId ? eq(schoolSubjectsTable.id, subjectId) : sql`TRUE`,
        ))
        .where(and(
          eq(schoolEnrollmentsTable.companyId, companyId),
          classId ? eq(schoolEnrollmentsTable.classId, classId) : sql`TRUE`,
          enrollmentId ? eq(schoolEnrollmentsTable.id, enrollmentId) : sql`TRUE`,
          academicYearId ? eq(schoolEnrollmentsTable.academicYearId, academicYearId) : sql`TRUE`,
        ));
      const studentByScope = new Map(studentRows.map((row) => [`${row.enrollmentId}:${row.subjectId}`, row]));
      for (const daily of dailyRows) {
        const identity = studentByScope.get(`${daily.enrollmentId}:${daily.subjectId}`);
        if (!identity) continue;
        const target = ensureRow(identity);
        const vals = DAILY_SCORE_FIELDS.map((field) => nullableNumeric((daily as any)[field])).filter((value): value is number => value != null);
        if (vals.length) {
          target.assessmentCount++;
          target.totalPercent += vals.reduce((sum, value) => sum + value, 0) / vals.length;
        }
        if (daily.notes) target.notes.push(daily.notes);
      }
    }
    const rows = [...aggregate.values()].map((row) => ({
      enrollmentId: row.enrollmentId,
      studentId: row.studentId,
      studentNumber: row.studentNumber,
      fullNameAr: row.fullNameAr,
      subjectId: row.subjectId,
      subjectNameAr: row.subjectNameAr,
      assessmentCount: row.assessmentCount,
      averagePercent: row.assessmentCount ? rounded(row.totalPercent / row.assessmentCount) : null,
      score: row.score,
      maximumScore: row.maximumScore,
      grade: row.grade,
      status: row.status,
      teacherNotes: [...new Set(row.notes)].join(" · ").slice(0, 2000),
    }));
    res.json({ reportType, startDate, endDate, rows });
  } catch (error) { handleError(res, error); }
});

async function awaitableSubjectName(companyId: number, subjectId: number): Promise<string> {
  const [subject] = await db.select({ nameAr: schoolSubjectsTable.nameAr })
    .from(schoolSubjectsTable).where(and(
      eq(schoolSubjectsTable.id, subjectId),
      eq(schoolSubjectsTable.companyId, companyId),
    )).limit(1);
  return subject?.nameAr ?? "";
}

router.get("/audit", async (req, res) => {
  try {
    const companyId = companyFor(req, res);
    const enrollmentId = req.query.enrollmentId == null ? null : positiveInt(req.query.enrollmentId);
    const limit = Math.min(200, Math.max(1, positiveInt(req.query.limit) ?? 100));
    if (!companyId) return;
    if (req.query.enrollmentId != null && !enrollmentId) return void res.status(400).json({ error: "رقم القيد غير صالح" });
    const filters = [eq(schoolGradeAuditEventsTable.companyId, companyId)];
    if (enrollmentId) filters.push(eq(schoolGradeAuditEventsTable.enrollmentId, enrollmentId));
    const rows = await db.select().from(schoolGradeAuditEventsTable).where(and(...filters))
      .orderBy(desc(schoolGradeAuditEventsTable.occurredAt)).limit(limit);
    res.json(rows.map((row) => ({
      ...row,
      occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
    })));
  } catch (error) { handleError(res, error); }
});

export default router;
