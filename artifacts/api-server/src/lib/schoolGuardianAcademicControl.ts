import {
  db,
  schoolAcademicPeriodsTable,
  schoolAcademicYearsTable,
  schoolDailyAssessmentsTable,
  schoolExamResultsTable,
  schoolExamsTable,
  schoolGradeSubjectPoliciesTable,
  schoolResultApprovalsTable,
  schoolSubjectsTable,
} from "@workspace/db";
import { and, desc, eq, gte, lte, inArray } from "drizzle-orm";
import { addIsoDays } from "./portalAttendanceState.js";
import { ensureSchoolAcademicControlSchema } from "./schoolAcademicControlSchema.js";

const DAILY_FIELDS = [
  "attendanceDiscipline",
  "participation",
  "homework",
  "activity",
  "behavior",
  "teacherEvaluation",
] as const;

function dateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function dateInCairo(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

function average(values: number[]): number | null {
  return values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100
    : null;
}

export async function getGuardianAcademicControl(
  companyId: number,
  enrollment: { id: number; academicYearId: number; classId: number; gradeId: number },
) {
  await ensureSchoolAcademicControlSchema();
  const today = dateInCairo();
  const weekStart = addIsoDays(today, -6);
  const monthStart = `${today.slice(0, 7)}-01`;

  const [visibleDailyRows, approvedRows, progressExams] = await Promise.all([
    db.select({
      id: schoolDailyAssessmentsTable.id,
      assessmentDate: schoolDailyAssessmentsTable.assessmentDate,
      subjectId: schoolDailyAssessmentsTable.subjectId,
      subject: schoolSubjectsTable.nameAr,
      attendanceDiscipline: schoolDailyAssessmentsTable.attendanceDiscipline,
      participation: schoolDailyAssessmentsTable.participation,
      homework: schoolDailyAssessmentsTable.homework,
      activity: schoolDailyAssessmentsTable.activity,
      behavior: schoolDailyAssessmentsTable.behavior,
      teacherEvaluation: schoolDailyAssessmentsTable.teacherEvaluation,
      notes: schoolDailyAssessmentsTable.notes,
    }).from(schoolDailyAssessmentsTable)
      .innerJoin(schoolSubjectsTable, and(
        eq(schoolSubjectsTable.id, schoolDailyAssessmentsTable.subjectId),
        eq(schoolSubjectsTable.companyId, companyId),
      ))
      .innerJoin(schoolGradeSubjectPoliciesTable, and(
        eq(schoolGradeSubjectPoliciesTable.companyId, companyId),
        eq(schoolGradeSubjectPoliciesTable.gradeId, enrollment.gradeId),
        eq(schoolGradeSubjectPoliciesTable.subjectId, schoolDailyAssessmentsTable.subjectId),
        eq(schoolGradeSubjectPoliciesTable.isActive, true),
        eq(schoolGradeSubjectPoliciesTable.showDailyAssessmentsToGuardians, true),
      ))
      .where(and(
        eq(schoolDailyAssessmentsTable.companyId, companyId),
        eq(schoolDailyAssessmentsTable.enrollmentId, enrollment.id),
        gte(schoolDailyAssessmentsTable.assessmentDate, monthStart),
        lte(schoolDailyAssessmentsTable.assessmentDate, today),
      ))
      .orderBy(desc(schoolDailyAssessmentsTable.assessmentDate))
      .limit(90),
    db.select({
      id: schoolResultApprovalsTable.id,
      academicYear: schoolAcademicYearsTable.name,
      periodName: schoolAcademicPeriodsTable.name,
      publicationType: schoolResultApprovalsTable.publicationType,
      approvedAt: schoolResultApprovalsTable.approvedAt,
      resultsSnapshot: schoolResultApprovalsTable.resultsSnapshot,
      subject: schoolSubjectsTable.nameAr,
    }).from(schoolResultApprovalsTable)
      .innerJoin(schoolAcademicYearsTable, and(
        eq(schoolAcademicYearsTable.id, schoolResultApprovalsTable.academicYearId),
        eq(schoolAcademicYearsTable.companyId, companyId),
      ))
      .innerJoin(schoolAcademicPeriodsTable, and(
        eq(schoolAcademicPeriodsTable.id, schoolResultApprovalsTable.periodId),
        eq(schoolAcademicPeriodsTable.companyId, companyId),
      ))
      .innerJoin(schoolSubjectsTable, and(
        eq(schoolSubjectsTable.id, schoolResultApprovalsTable.subjectId),
        eq(schoolSubjectsTable.companyId, companyId),
      ))
      .where(and(
        eq(schoolResultApprovalsTable.companyId, companyId),
        eq(schoolResultApprovalsTable.academicYearId, enrollment.academicYearId),
        eq(schoolResultApprovalsTable.classId, enrollment.classId),
        eq(schoolResultApprovalsTable.status, "approved"),
      ))
      .orderBy(desc(schoolResultApprovalsTable.approvedAt)),
    db.select({
      subjectId: schoolExamsTable.subjectId,
      subject: schoolSubjectsTable.nameAr,
      examDate: schoolExamsTable.examDate,
      score: schoolExamResultsTable.score,
      maxScore: schoolExamsTable.maxScore,
      notes: schoolExamResultsTable.notes,
    }).from(schoolExamResultsTable)
      .innerJoin(schoolExamsTable, and(
        eq(schoolExamsTable.id, schoolExamResultsTable.examId),
        eq(schoolExamsTable.companyId, companyId),
        inArray(schoolExamsTable.assessmentType, ["coursework", "monthly"]),
      ))
      .innerJoin(schoolSubjectsTable, and(
        eq(schoolSubjectsTable.id, schoolExamsTable.subjectId),
        eq(schoolSubjectsTable.companyId, companyId),
      ))
      .where(and(
        eq(schoolExamResultsTable.companyId, companyId),
        eq(schoolExamResultsTable.enrollmentId, enrollment.id),
        gte(schoolExamsTable.examDate, monthStart),
        lte(schoolExamsTable.examDate, today),
      ))
      .orderBy(desc(schoolExamsTable.examDate)),
  ]);

  const publishedResults = approvedRows.flatMap((row) => {
    const snapshot = Array.isArray(row.resultsSnapshot) ? row.resultsSnapshot as any[] : [];
    const result = snapshot.find((entry) => Number(entry.enrollmentId) === enrollment.id);
    return result ? [{
      approvalId: row.id,
      academicYear: row.academicYear,
      periodName: row.periodName,
      subject: row.subject,
      publicationType: row.publicationType,
      approvedAt: row.approvedAt instanceof Date ? row.approvedAt.toISOString() : row.approvedAt,
      result,
    }] : [];
  });

  const makeSummary = (start: string) => {
    const daily = visibleDailyRows.filter((row) => dateOnly(row.assessmentDate) >= start);
    const exams = progressExams.filter((row) => dateOnly(row.examDate) >= start);
    const percentages = [
      ...daily.map((row) => {
        const values = DAILY_FIELDS.map((field) => row[field] == null ? null : Number(row[field]))
          .filter((value): value is number => value != null);
        return average(values);
      }).filter((value): value is number => value != null),
      ...exams.map((row) => Number(row.maxScore) > 0
        ? Number(row.score) / Number(row.maxScore) * 100
        : null).filter((value): value is number => value != null),
    ];
    return {
      assessmentCount: daily.length + exams.length,
      averagePercent: average(percentages),
      teacherNotes: [...new Set([
        ...daily.map((row) => row.notes),
        ...exams.map((row) => row.notes),
      ].filter((note): note is string => typeof note === "string" && !!note.trim()))].slice(0, 10),
    };
  };

  const subjectProgress = new Map<number, { subjectId: number; subject: string; values: number[]; latestDate: string }>();
  const addProgress = (subjectId: number, subject: string, value: number | null, date: string) => {
    const row = subjectProgress.get(subjectId) ?? { subjectId, subject, values: [], latestDate: dateOnly(date) };
    if (value != null && Number.isFinite(value)) row.values.push(value);
    if (dateOnly(date) > row.latestDate) row.latestDate = dateOnly(date);
    subjectProgress.set(subjectId, row);
  };
  for (const row of progressExams) {
    const max = Number(row.maxScore);
    addProgress(row.subjectId, row.subject, max > 0 ? Number(row.score) / max * 100 : null, dateOnly(row.examDate));
  }
  for (const row of visibleDailyRows) {
    const values = DAILY_FIELDS.map((field) => row[field] == null ? null : Number(row[field]))
      .filter((value): value is number => value != null);
    addProgress(row.subjectId, row.subject, average(values), dateOnly(row.assessmentDate));
  }

  return {
    dailyAssessments: visibleDailyRows.map((row) => ({
      id: row.id,
      assessmentDate: dateOnly(row.assessmentDate),
      subject: row.subject,
      scores: Object.fromEntries(DAILY_FIELDS.map((field) => [
        field,
        row[field] == null ? null : Number(row[field]),
      ])),
      notes: row.notes ?? null,
    })),
    publishedResults,
    weeklySummary: makeSummary(weekStart),
    monthlySummary: makeSummary(monthStart),
    subjectProgress: [...subjectProgress.values()].filter((row) => row.values.length > 0).map((row) => ({
      subjectId: row.subjectId,
      subject: row.subject,
      assessmentCount: row.values.length,
      averagePercent: average(row.values),
      latestDate: row.latestDate,
    })),
  };
}
