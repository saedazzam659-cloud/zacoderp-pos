import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePermission } from "@/hooks/usePermission";
import {
  useGetSchoolAcademicPeriods, useCreateSchoolAcademicPeriod, useUpdateSchoolAcademicPeriod, useDeleteSchoolAcademicPeriod,
  useGetSchoolSubjectOfferings, useCreateSchoolSubjectOffering, useUpdateSchoolSubjectOffering, useDeleteSchoolSubjectOffering,
  useGetSchoolGradeSubjectPolicies, useSaveSchoolGradeSubjectPolicy,
  useGetSchoolGradebook, useSaveSchoolGradebookMarks,
  useGetSchoolDailyAssessments, useSaveSchoolDailyAssessments,
  useGetSchoolResultApprovals, useApproveSchoolResults, useReopenSchoolResults,
  useGetSchoolAcademicReport, useGetSchoolGradeAudit,
  getGetSchoolAcademicPeriodsQueryKey, getGetSchoolSubjectOfferingsQueryKey, getGetSchoolGradeSubjectPoliciesQueryKey,
  getGetSchoolGradebookQueryKey, getGetSchoolDailyAssessmentsQueryKey, getGetSchoolResultApprovalsQueryKey,
  getGetSchoolAcademicReportQueryKey, getGetSchoolGradeAuditQueryKey,
} from "@workspace/api-client-react";
import type { SchoolAcademicPeriod, SchoolGradebookStudent, SchoolDailyAssessmentRow, SchoolGradeSubjectPolicy } from "@workspace/api-client-react";
import { useSchoolLists, type Row } from "./schoolApi";
import { SchoolCrudPage, type CrudConfig } from "./SchoolCrud";
import SchoolExportMenu from "./SchoolExportMenu";
import type { ExportColumn } from "@/lib/export";
import "./academic-control.css";

const examConfig: CrudConfig = {
  resource: "exams", title: "الاختبارات", singular: "اختبار", description: "تعريف الاختبارات حسب السنة والفصل والمادة.",
  fields: [
    { key: "academicYearId", label: "السنة الدراسية", type: "relation", resource: "academic-years", labelKey: "name", required: true },
    { key: "classId", label: "الفصل", type: "relation", resource: "classes", labelKey: "name", required: true },
    { key: "subjectId", label: "المادة", type: "relation", resource: "subjects", labelKey: "nameAr", required: true },
    { key: "name", label: "اسم الاختبار", required: true }, { key: "examDate", label: "التاريخ", type: "date", required: true },
    { key: "maxScore", label: "الدرجة القصوى", type: "number", required: true }, { key: "status", label: "الحالة", type: "select", options: [["planned", "مجدول"], ["open", "مفتوح"], ["closed", "مغلق"]] }, { key: "notes", label: "ملاحظات", type: "textarea" },
  ],
  defaultValues: { maxScore: 100, status: "planned" },
  columns: [{ key: "name", label: "الاختبار" }, { key: "examDate", label: "التاريخ", type: "date" }, { key: "classId", label: "الفصل", type: "relation", resource: "classes", labelKey: "name" }, { key: "subjectId", label: "المادة", type: "relation", resource: "subjects", labelKey: "nameAr" }, { key: "maxScore", label: "الدرجة القصوى", type: "number" }, { key: "status", label: "الحالة", type: "status", options: [["planned", "مجدول"], ["open", "مفتوح"], ["closed", "مغلق"]] }],
};
const resultConfig: CrudConfig = {
  resource: "results", title: "نتائج الطلاب", singular: "نتيجة", description: "إدخال ومراجعة درجات الطلاب لكل اختبار.",
  fields: [{ key: "examId", label: "الاختبار", type: "relation", resource: "exams", labelKey: "name", required: true }, { key: "enrollmentId", label: "قيد الطالب", type: "relation", resource: "enrollments", required: true }, { key: "score", label: "الدرجة", type: "number", required: true }, { key: "notes", label: "ملاحظات", type: "textarea" }],
  columns: [{ key: "examId", label: "الاختبار", type: "relation", resource: "exams", labelKey: "name" }, { key: "enrollmentId", label: "القيد", type: "relation", resource: "enrollments" }, { key: "score", label: "الدرجة", type: "number" }, { key: "notes", label: "ملاحظات" }],
};
const NAV = [
  ["periods", "الفترات الدراسية"], ["offerings", "توزيع المواد"], ["policies", "سياسة التقييم"], ["gradebook", "دفتر الدرجات"],
  ["daily", "التقييم اليومي"], ["approvals", "اعتماد النتائج"], ["reports", "التقارير"], ["audit", "سجل التغييرات"], ["exams", "الاختبارات"], ["results", "نتائج الاختبارات"],
] as const;
type Section = typeof NAV[number][0];
const today = new Date().toISOString().slice(0, 10);
const inp = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => e.target.value;
const field = (label: string, child: React.ReactNode, span = false) => <div className={`ac-field${span ? " md:col-span-2" : ""}`} key={label}><label>{label}</label>{child}</div>;
const errorText = (e: unknown) => e instanceof Error ? e.message : "تعذر إتمام العملية";

export default function Assessments() {
  const qc = useQueryClient();
  const [section, setSection] = useState<Section>("periods");
  const [tab, setTab] = useState<"exams" | "results">("exams");
  const [academicYearId, setYear] = useState("");
  const [classId, setClass] = useState("");
  const [subjectId, setSubject] = useState("");
  const [gradeId, setGrade] = useState("");
  const [periodId, setPeriod] = useState("");
  const [date, setDate] = useState(today);
  const [periodForm, setPeriodForm] = useState({ name: "", periodType: "term", startDate: "", endDate: "", sortOrder: "1" });
  const [editingPeriod, setEditingPeriod] = useState<number | null>(null);
  const [offeringForm, setOfferingForm] = useState({ teacherEmployeeId: "", notes: "" });
  const [editingOffering, setEditingOffering] = useState<number | null>(null);
  const [marks, setMarks] = useState<Record<string, { score: string; notes: string }>>({});
  const [gradebookAssessmentId, setGradebookAssessmentId] = useState("");
  const [dailyScores, setDailyScores] = useState<Record<string, Record<string, string>>>({});
  const [dailyNotes, setDailyNotes] = useState<Record<string, string>>({});
  const [policyDraft, setPolicyDraft] = useState<Partial<SchoolGradeSubjectPolicy>>({});
  const [approvalType, setApprovalType] = useState<"midyear" | "year_end">("midyear");
  const [reportType, setReportType] = useState<"weekly" | "monthly" | "monthly_exams" | "midyear" | "year_end" | "student_progress">("weekly");
  const [reportDate, setReportDate] = useState({ startDate: "", endDate: "" });
  const canCreate = usePermission("school", "create");
  const canEdit = usePermission("school", "edit");
  const canDelete = usePermission("school", "delete");
  const lookups = useSchoolLists<Row>(["academic-years", "classes", "subjects", "employees", "grades"], { page: 1, limit: 200 });
  const years = lookups[0]?.data?.items ?? [], classes = lookups[1]?.data?.items ?? [], subjects = lookups[2]?.data?.items ?? [], teachers = lookups[3]?.data?.items ?? [], grades = lookups[4]?.data?.items ?? [];
  const year = Number(academicYearId) || Number(years.find((r) => r.isActive)?.id) || Number(years[0]?.id) || 0;
  const cls = Number(classId) || 0, subj = Number(subjectId) || 0, grd = Number(gradeId) || 0, period = Number(periodId) || 0;
  const yearClasses = classes.filter((r) => !r.academicYearId || Number(r.academicYearId) === year);
  const periodsParams = { academicYearId: year || 1 };
  const periodsQuery = useGetSchoolAcademicPeriods(periodsParams, { query: { enabled: !!year, queryKey: getGetSchoolAcademicPeriodsQueryKey(periodsParams) } });
  const periods = periodsQuery.data ?? [];
  const selectedPeriod = period || periods.find((p) => p.isActive)?.id || periods[0]?.id || 0;
  const offeringParams = { academicYearId: year || 1, classId: cls || undefined };
  const offeringsQuery = useGetSchoolSubjectOfferings(offeringParams, { query: { enabled: !!year, queryKey: getGetSchoolSubjectOfferingsQueryKey(offeringParams) } });
  const offerings = offeringsQuery.data ?? [];
  const policyParams = { gradeId: grd || 1 };
  const policiesQuery = useGetSchoolGradeSubjectPolicies(policyParams, { query: { enabled: !!grd, queryKey: getGetSchoolGradeSubjectPoliciesQueryKey(policyParams) } });
  const policies = policiesQuery.data ?? [];
  const gradebookParams = { academicYearId: year || 1, periodId: selectedPeriod || 1, classId: cls || 1, subjectId: subj || 1 };
  const gradebookQuery = useGetSchoolGradebook(gradebookParams, { query: { enabled: !!(year && selectedPeriod && cls && subj), queryKey: getGetSchoolGradebookQueryKey(gradebookParams) } });
  const dailyParams = { ...gradebookParams, assessmentDate: date };
  const dailyQuery = useGetSchoolDailyAssessments(dailyParams, { query: { enabled: !!(year && selectedPeriod && cls && subj && date), queryKey: getGetSchoolDailyAssessmentsQueryKey(dailyParams) } });
  const approvalParams = { academicYearId: year || 1, classId: cls || undefined };
  const approvalsQuery = useGetSchoolResultApprovals(approvalParams, { query: { enabled: !!year, queryKey: getGetSchoolResultApprovalsQueryKey(approvalParams) } });
  const reportParams = { reportType, academicYearId: year || undefined, periodId: selectedPeriod || undefined, classId: cls || undefined, subjectId: subj || undefined, startDate: reportDate.startDate || undefined, endDate: reportDate.endDate || undefined };
  const reportQuery = useGetSchoolAcademicReport(reportParams, { query: { enabled: !!year, queryKey: getGetSchoolAcademicReportQueryKey(reportParams) } });
  const auditParams = { limit: 100 };
  const auditQuery = useGetSchoolGradeAudit(auditParams, { query: { queryKey: getGetSchoolGradeAuditQueryKey(auditParams) } });
  const createPeriod = useCreateSchoolAcademicPeriod(), updatePeriod = useUpdateSchoolAcademicPeriod(), deletePeriod = useDeleteSchoolAcademicPeriod();
  const createOffering = useCreateSchoolSubjectOffering(), updateOffering = useUpdateSchoolSubjectOffering(), deleteOffering = useDeleteSchoolSubjectOffering();
  const savePolicy = useSaveSchoolGradeSubjectPolicy(), saveMarks = useSaveSchoolGradebookMarks(), saveDaily = useSaveSchoolDailyAssessments();
  const approve = useApproveSchoolResults(), reopen = useReopenSchoolResults();
  const invalidate = (key: readonly unknown[]) => void qc.invalidateQueries({ queryKey: key });
  const selectedOffering = offerings.find((o) => o.subjectId === subj);
  const students: SchoolGradebookStudent[] = gradebookQuery.data?.students ?? [];
  const activeAssessment = gradebookQuery.data?.assessments?.find((exam) => exam.id === Number(gradebookAssessmentId)) ?? gradebookQuery.data?.assessments?.[0];
  const dailyRows: SchoolDailyAssessmentRow[] = dailyQuery.data ?? [];
  const filteredPolicies = useMemo(() => policies, [policies]);
  const periodColumns: ExportColumn[] = [
    { key: "name", header: "الفترة", width: 24 }, { key: "type", header: "النوع", width: 18 },
    { key: "startDate", header: "من تاريخ", width: 16 }, { key: "endDate", header: "إلى تاريخ", width: 16 },
    { key: "sortOrder", header: "الترتيب", width: 12 }, { key: "status", header: "الحالة", width: 14 },
  ];
  const periodExportRows = periods.map(period => ({
    id: period.id,
    name: period.name,
    type: period.periodType === "midyear" ? "منتصف العام" : period.periodType === "year_end" ? "نهاية العام" : "فصل دراسي",
    startDate: period.startDate,
    endDate: period.endDate,
    sortOrder: period.sortOrder,
    status: period.isActive ? "نشطة" : "غير نشطة",
  }));
  const offeringColumns: ExportColumn[] = [
    { key: "className", header: "الفصل", width: 22 }, { key: "subjectName", header: "المادة", width: 22 },
    { key: "teacherName", header: "المعلم", width: 24 }, { key: "status", header: "الحالة", width: 14 },
    { key: "notes", header: "ملاحظات", width: 30 },
  ];
  const offeringExportRows = offerings.map(offering => ({
    id: offering.id,
    className: offering.className,
    subjectName: offering.subjectNameAr,
    teacherName: offering.teacherNameAr || "غير محدد",
    status: offering.isActive ? "نشط" : "غير نشط",
    notes: offering.notes || "—",
  }));
  const policyColumns: ExportColumn[] = [
    { key: "subject", header: "المادة", width: 22 }, { key: "subjectType", header: "النوع", width: 16 },
    { key: "maximumScore", header: "الحد الأقصى", width: 16 }, { key: "minimumScore", header: "الحد الأدنى", width: 16 },
    { key: "passMarkPercent", header: "نسبة النجاح", width: 16 }, { key: "secondRoundPercent", header: "حد الدور الثاني", width: 18 },
    { key: "dailyVisibility", header: "ظهور التقييم اليومي", width: 20 }, { key: "status", header: "التفعيل", width: 14 },
  ];
  const policyExportRows = filteredPolicies.map(policy => ({
    id: policy.id,
    subject: subjects.find(subject => subject.id === policy.subjectId)?.nameAr || `#${policy.subjectId}`,
    subjectType: policy.subjectType,
    maximumScore: policy.maximumScore,
    minimumScore: policy.minimumScore,
    passMarkPercent: `${policy.passMarkPercent}%`,
    secondRoundPercent: `${policy.secondRoundPercent}%`,
    dailyVisibility: policy.showDailyAssessmentsToGuardians ? "ظاهر" : "مخفي",
    status: policy.isActive ? "نشطة" : "متوقفة",
  }));
  const gradebookColumns: ExportColumn[] = [
    { key: "student", header: "الطالب", width: 28 }, { key: "studentNumber", header: "رقم الطالب", width: 18 },
    { key: "exam", header: "الاختبار", width: 26 }, { key: "score", header: "الدرجة", width: 14 },
    { key: "maximumScore", header: "الدرجة القصوى", width: 16 }, { key: "notes", header: "ملاحظة المعلم", width: 32 },
  ];
  const gradebookExportRows = students.map(student => {
    const result = student.marks.find(mark => mark.examId === activeAssessment?.id);
    return {
      id: student.enrollmentId,
      student: student.fullNameAr,
      studentNumber: student.studentNumber,
      exam: activeAssessment?.name || "لا يوجد اختبار",
      score: marks[student.enrollmentId]?.score ?? result?.score ?? "—",
      maximumScore: activeAssessment?.maxScore ?? "—",
      notes: marks[student.enrollmentId]?.notes ?? result?.notes ?? "—",
    };
  });
  const dailyColumns: ExportColumn[] = [
    { key: "student", header: "الطالب", width: 26 }, { key: "attendance", header: "الحضور", width: 16 },
    { key: "discipline", header: "انضباط", width: 14 }, { key: "participation", header: "مشاركة", width: 14 },
    { key: "homework", header: "واجب", width: 14 }, { key: "activity", header: "نشاط", width: 14 },
    { key: "behavior", header: "سلوك", width: 14 }, { key: "teacherEvaluation", header: "تقييم المعلم", width: 16 },
    { key: "notes", header: "ملاحظات", width: 30 },
  ];
  const dailyExportRows = dailyRows.map(row => ({
    id: row.enrollmentId,
    student: row.fullNameAr,
    attendance: row.attendanceStatus || "—",
    discipline: dailyScores[row.enrollmentId]?.attendanceDiscipline ?? row.scores.attendanceDiscipline ?? "—",
    participation: dailyScores[row.enrollmentId]?.participation ?? row.scores.participation ?? "—",
    homework: dailyScores[row.enrollmentId]?.homework ?? row.scores.homework ?? "—",
    activity: dailyScores[row.enrollmentId]?.activity ?? row.scores.activity ?? "—",
    behavior: dailyScores[row.enrollmentId]?.behavior ?? row.scores.behavior ?? "—",
    teacherEvaluation: dailyScores[row.enrollmentId]?.teacherEvaluation ?? row.scores.teacherEvaluation ?? "—",
    notes: dailyNotes[row.enrollmentId] ?? row.notes ?? "—",
  }));
  const approvalColumns: ExportColumn[] = [
    { key: "period", header: "الفترة", width: 22 }, { key: "className", header: "الفصل", width: 20 },
    { key: "subjectName", header: "المادة", width: 20 }, { key: "publicationType", header: "نوع النشر", width: 18 },
    { key: "status", header: "الحالة", width: 16 }, { key: "approvedAt", header: "تاريخ الاعتماد", width: 18 },
  ];
  const approvalExportRows = (approvalsQuery.data ?? []).map(approval => ({
    id: approval.id,
    period: periods.find(period => period.id === approval.periodId)?.name || `#${approval.periodId}`,
    className: classes.find(schoolClass => schoolClass.id === approval.classId)?.name || `#${approval.classId}`,
    subjectName: subjects.find(subject => subject.id === approval.subjectId)?.nameAr || `#${approval.subjectId}`,
    publicationType: approval.publicationType === "midyear" ? "منتصف العام" : "نهاية العام",
    status: approval.status === "approved" ? "معتمد" : "أعيد فتحه",
    approvedAt: approval.approvedAt ? new Date(approval.approvedAt).toLocaleDateString("ar-EG") : "—",
  }));
  const reportColumns: ExportColumn[] = [
    { key: "student", header: "الطالب", width: 26 }, { key: "subject", header: "المادة", width: 22 },
    { key: "assessmentCount", header: "عدد التقييمات", width: 16 }, { key: "average", header: "المتوسط", width: 14 },
    { key: "score", header: "الدرجة", width: 16 }, { key: "grade", header: "التقدير", width: 16 },
    { key: "status", header: "الحالة", width: 16 }, { key: "notes", header: "ملاحظات", width: 30 },
  ];
  const reportExportRows = (reportQuery.data?.rows ?? []).map((row, index) => ({
    id: `${row.enrollmentId}-${row.subjectId}-${index}`,
    student: row.fullNameAr,
    subject: row.subjectNameAr,
    assessmentCount: row.assessmentCount,
    average: row.averagePercent == null ? "—" : `${row.averagePercent}%`,
    score: row.score == null ? "—" : `${row.score}/${row.maximumScore}`,
    grade: row.grade || "—",
    status: row.status || "—",
    notes: row.teacherNotes || "—",
  }));
  const auditColumns: ExportColumn[] = [
    { key: "occurredAt", header: "الوقت", width: 22 }, { key: "entityType", header: "نوع السجل", width: 18 },
    { key: "entityId", header: "المعرف", width: 14 }, { key: "action", header: "العملية", width: 16 },
    { key: "beforeValue", header: "قبل", width: 32 }, { key: "afterValue", header: "بعد", width: 32 },
    { key: "actorId", header: "المنفذ", width: 14 },
  ];
  const auditExportRows = (auditQuery.data ?? []).map(event => ({
    id: event.id,
    occurredAt: new Date(event.occurredAt).toLocaleString("ar-EG"),
    entityType: event.entityType,
    entityId: event.entityId ?? "—",
    action: event.action,
    beforeValue: JSON.stringify(event.beforeValue ?? "—"),
    afterValue: JSON.stringify(event.afterValue ?? "—"),
    actorId: event.actorId ?? "—",
  }));
  const activeMutating = createPeriod.isPending || updatePeriod.isPending || createOffering.isPending || updateOffering.isPending || savePolicy.isPending || saveMarks.isPending || saveDaily.isPending;
  const refreshAudit = () => invalidate(getGetSchoolGradeAuditQueryKey(auditParams));
  const setMark = (enrollmentId: number, key: "score" | "notes", value: string) => setMarks((s) => ({ ...s, [enrollmentId]: { ...s[enrollmentId], [key]: value } }));
  const saveGradeMarks = () => {
    if (!subj || !students.length) return;
    const exam = activeAssessment;
    if (!exam) return;
    saveMarks.mutate({ data: { examId: exam.id, records: students.map((student) => { const existingMark = student.marks.find((mark) => mark.examId === exam.id); return { enrollmentId: student.enrollmentId, score: marks[student.enrollmentId]?.score === "" ? null : Number(marks[student.enrollmentId]?.score ?? existingMark?.score ?? NaN), notes: marks[student.enrollmentId]?.notes ?? existingMark?.notes ?? null }; }).filter((record) => Number.isFinite(record.score) || record.score === null) } }, { onSuccess: () => { invalidate(getGetSchoolGradebookQueryKey(gradebookParams)); invalidate(getGetSchoolAcademicReportQueryKey(reportParams)); refreshAudit(); } });
  };
  const saveDailyRows = () => {
    if (!subj || !dailyRows.length) return;
    const criteria = ["attendanceDiscipline", "participation", "homework", "activity", "behavior", "teacherEvaluation"];
    saveDaily.mutate({ data: { academicYearId: year, periodId: selectedPeriod, classId: cls, subjectId: subj, assessmentDate: date, records: dailyRows.map((row) => ({ enrollmentId: row.enrollmentId, scores: Object.fromEntries(criteria.map((key) => [key, dailyScores[row.enrollmentId]?.[key] === "" ? null : Number(dailyScores[row.enrollmentId]?.[key] ?? row.scores[key as keyof typeof row.scores] ?? "")]).filter(([, value]) => value !== "")) as Record<string, number | null>, notes: dailyNotes[row.enrollmentId] ?? row.notes ?? null })) } }, { onSuccess: () => { invalidate(getGetSchoolDailyAssessmentsQueryKey(dailyParams)); invalidate(getGetSchoolAcademicReportQueryKey(reportParams)); refreshAudit(); } });
  };
  const savePolicyDraft = () => {
    if (!grd || !subj) return;
    const base = policies.find((p) => p.subjectId === subj);
    const input = {
      gradeId: grd, subjectType: String(policyDraft.subjectType ?? base?.subjectType ?? "أساسي"),
      maximumScore: Number(policyDraft.maximumScore ?? base?.maximumScore ?? 100), minimumScore: Number(policyDraft.minimumScore ?? base?.minimumScore ?? 0),
      passMarkPercent: Number(policyDraft.passMarkPercent ?? base?.passMarkPercent ?? 50), secondRoundPercent: Number(policyDraft.secondRoundPercent ?? base?.secondRoundPercent ?? 30),
      gradeBands: policyDraft.gradeBands ?? base?.gradeBands ?? [{ minimumPercent: 90, label: "ممتاز" }, { minimumPercent: 80, label: "جيد جداً" }, { minimumPercent: 70, label: "جيد" }, { minimumPercent: 50, label: "مقبول" }],
      midyearWeights: policyDraft.midyearWeights ?? base?.midyearWeights ?? { coursework: 40, monthly: 20, midyear: 40 },
      yearEndWeights: policyDraft.yearEndWeights ?? base?.yearEndWeights ?? { coursework: 30, monthly: 20, year_end: 50 },
      showDailyAssessmentsToGuardians: Boolean(policyDraft.showDailyAssessmentsToGuardians ?? base?.showDailyAssessmentsToGuardians ?? false), isActive: true,
    };
    savePolicy.mutate({ subjectId: subj, data: input }, { onSuccess: () => { invalidate(getGetSchoolGradeSubjectPoliciesQueryKey(policyParams)); refreshAudit(); } });
  };
  const classPicker = <select value={classId} onChange={(e) => { setClass(inp(e)); setSubject(""); }}><option value="">اختر الفصل</option>{yearClasses.map((r) => <option key={r.id} value={r.id}>{r.name || r.code || `#${r.id}`}</option>)}</select>;
  const subjectPicker = <select value={subjectId} onChange={(e) => setSubject(inp(e))}><option value="">اختر المادة</option>{(cls ? offerings.map((o) => ({ id: o.subjectId, label: o.subjectNameAr })) : subjects.map((r) => ({ id: r.id, label: String(r.nameAr || r.name || `#${r.id}`) }))).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>;
  const periodPicker = <select value={selectedPeriod || ""} onChange={(e) => setPeriod(inp(e))}><option value="">اختر الفترة</option>{periods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>;
  const pickers = <div className="ac-panel"><div className="ac-title"><div><h2>نطاق العمل</h2><p>اختر العام والفصل والفترة والمادة للبيانات الأكاديمية.</p></div></div><div className="ac-fields">
    {field("السنة الدراسية", <select value={year || ""} onChange={(e) => { setYear(inp(e)); setPeriod(""); }}><option value="">اختر السنة</option>{years.map((r) => <option key={r.id} value={r.id}>{r.name || r.yearName || `#${r.id}`}</option>)}</select>)}
    {field("الفصل", classPicker)}{field("الفترة", periodPicker)}{field("المادة", subjectPicker)}
  </div></div>;

  const renderPeriods = () => <div className="ac-panel">
    <div className="ac-title"><div><h2>الفترات الدراسية</h2><p>إدارة فترات العام وترتيبها وتحديد الفترة النشطة.</p></div><span className="ac-badge">{periods.length} فترة</span><SchoolExportMenu rows={periodExportRows} columns={periodColumns} filename={`school-periods-${year || "all"}`} title="الفترات الدراسية" subtitle={`السنة الدراسية ${years.find(r => r.id === year)?.name || year || "—"}`} disabled={periodsQuery.isLoading || periodsQuery.isError} /></div>
    {!year && <div className="ac-alert">اختر سنة دراسية من نطاق العمل قبل إدارة الفترات.</div>}
    {!!year && <form className="ac-fields" onSubmit={(e) => { e.preventDefault(); const data = { academicYearId: year, name: periodForm.name, periodType: periodForm.periodType as "term" | "midyear" | "year_end", startDate: periodForm.startDate, endDate: periodForm.endDate, sortOrder: Number(periodForm.sortOrder) }; const done = () => { setPeriodForm({ name: "", periodType: "term", startDate: "", endDate: "", sortOrder: String(periods.length + 1) }); setEditingPeriod(null); invalidate(getGetSchoolAcademicPeriodsQueryKey(periodsParams)); refreshAudit(); }; editingPeriod ? updatePeriod.mutate({ periodId: editingPeriod, data: { name: data.name, periodType: data.periodType, startDate: data.startDate, endDate: data.endDate, sortOrder: data.sortOrder } }, { onSuccess: done }) : createPeriod.mutate({ data }, { onSuccess: done }); }}>
      {field("اسم الفترة", <input required value={periodForm.name} onChange={(e) => setPeriodForm({ ...periodForm, name: inp(e) })} placeholder="الفصل الدراسي الأول" />)}
      {field("نوع الفترة", <select value={periodForm.periodType} onChange={(e) => setPeriodForm({ ...periodForm, periodType: inp(e) })}><option value="term">فصل دراسي</option><option value="midyear">منتصف العام</option><option value="year_end">نهاية العام</option></select>)}
      {field("من تاريخ", <input type="date" required value={periodForm.startDate} onChange={(e) => setPeriodForm({ ...periodForm, startDate: inp(e) })} />)}
      {field("إلى تاريخ", <input type="date" required value={periodForm.endDate} onChange={(e) => setPeriodForm({ ...periodForm, endDate: inp(e) })} />)}
      {field("الترتيب", <input type="number" min="1" value={periodForm.sortOrder} onChange={(e) => setPeriodForm({ ...periodForm, sortOrder: inp(e) })} />)}
      <div className="ac-actions" style={{ alignSelf: "end" }}>{(!editingPeriod && canCreate || editingPeriod && canEdit) && <button disabled={activeMutating} className="ac-btn primary">{editingPeriod ? "حفظ التعديل" : "إضافة الفترة"}</button>}{editingPeriod && <button type="button" className="ac-btn" onClick={() => { setEditingPeriod(null); setPeriodForm({ name: "", periodType: "term", startDate: "", endDate: "", sortOrder: "1" }); }}>إلغاء</button>}</div>
    </form>}
    {(createPeriod.isError || updatePeriod.isError || deletePeriod.isError) && <p className="ac-alert">{errorText(createPeriod.error || updatePeriod.error || deletePeriod.error)}</p>}
    <div className="ac-table-wrap" style={{ marginTop: 16 }}><table className="ac-table"><thead><tr><th>الفترة</th><th>النوع</th><th>التاريخ</th><th>الترتيب</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>{periods.map((p: SchoolAcademicPeriod) => <tr key={p.id}><td>{p.name}</td><td>{p.periodType === "midyear" ? "منتصف العام" : p.periodType === "year_end" ? "نهاية العام" : "فصل دراسي"}</td><td>{p.startDate} — {p.endDate}</td><td>{p.sortOrder}</td><td><span className="ac-badge">{p.isActive ? "نشطة" : "غير نشطة"}</span></td><td><div className="ac-actions"><SchoolExportMenu rows={periodExportRows.filter(row => row.id === p.id)} columns={periodColumns} filename={`school-period-${p.id}`} title={`الفترة الدراسية: ${p.name}`} label="مستند" />{canEdit && <button className="ac-btn" onClick={() => { setEditingPeriod(p.id); setPeriodForm({ name: p.name, periodType: p.periodType, startDate: p.startDate.slice(0, 10), endDate: p.endDate.slice(0, 10), sortOrder: String(p.sortOrder) }); }}>تعديل</button>}{canDelete && <button className="ac-btn danger" disabled={deletePeriod.isPending} onClick={() => { if (window.confirm("حذف هذه الفترة؟")) deletePeriod.mutate({ periodId: p.id }, { onSuccess: () => { invalidate(getGetSchoolAcademicPeriodsQueryKey(periodsParams)); refreshAudit(); } }); }}>حذف</button>}</div></td></tr>)}</tbody></table>{periodsQuery.isLoading && <div className="ac-state"><div className="ac-load" /></div>}{periodsQuery.isError && <div className="ac-state">{errorText(periodsQuery.error)} <button className="ac-btn" onClick={() => void periodsQuery.refetch()}>إعادة المحاولة</button></div>}{!periodsQuery.isLoading && periods.length === 0 && <div className="ac-empty">لا توجد فترات بعد. أضف أول فترة لهذا العام.</div>}</div>
  </div>;
  const renderOfferings = () => <div className="ac-panel">
    <div className="ac-title"><div><h2>توزيع المواد والمعلمين</h2><p>إسناد مواد العام إلى الفصول والمعلمين من سجلات المدرسة الحالية.</p></div><span className="ac-badge">{offerings.length} إسناد</span><SchoolExportMenu rows={offeringExportRows} columns={offeringColumns} filename={`school-subject-offerings-${year || "all"}`} title="توزيع المواد والمعلمين" subtitle={`السنة الدراسية ${years.find(r => r.id === year)?.name || year || "—"}`} disabled={offeringsQuery.isLoading || offeringsQuery.isError} /></div>
    <form className="ac-fields" onSubmit={(e) => { e.preventDefault(); if (!year || !cls || !subj) return; const complete = () => { setEditingOffering(null); setOfferingForm({ teacherEmployeeId: "", notes: "" }); invalidate(getGetSchoolSubjectOfferingsQueryKey(offeringParams)); refreshAudit(); }; editingOffering ? updateOffering.mutate({ offeringId: editingOffering, data: { teacherEmployeeId: offeringForm.teacherEmployeeId ? Number(offeringForm.teacherEmployeeId) : null, notes: offeringForm.notes || null } }, { onSuccess: complete }) : createOffering.mutate({ data: { academicYearId: year, classId: cls, subjectId: subj, teacherEmployeeId: offeringForm.teacherEmployeeId ? Number(offeringForm.teacherEmployeeId) : null, isActive: true, notes: offeringForm.notes || null } }, { onSuccess: complete }); }}>
      {field("الفصل", classPicker)}{field("المادة", <select value={subjectId} onChange={(e) => setSubject(inp(e))}><option value="">اختر المادة</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.nameAr || s.name}</option>)}</select>)}
      {field("المعلم", <select value={offeringForm.teacherEmployeeId} onChange={(e) => setOfferingForm({ ...offeringForm, teacherEmployeeId: inp(e) })}><option value="">غير محدد</option>{teachers.map((t) => <option key={t.id} value={t.id}>{t.fullNameAr || t.nameAr || t.name}</option>)}</select>)}
      {field("ملاحظات", <input value={offeringForm.notes} onChange={(e) => setOfferingForm({ ...offeringForm, notes: inp(e) })} />)}
      <div className="ac-actions" style={{ alignSelf: "end" }}>{(!editingOffering && canCreate || editingOffering && canEdit) && <button className="ac-btn primary" disabled={!year || !cls || !subj || activeMutating}>{editingOffering ? "حفظ الإسناد" : "إسناد المادة"}</button>}</div>
    </form>
    {(createOffering.isError || updateOffering.isError || deleteOffering.isError) && <p className="ac-alert">{errorText(createOffering.error || updateOffering.error || deleteOffering.error)}</p>}
    <div className="ac-table-wrap" style={{ marginTop: 16 }}><table className="ac-table"><thead><tr><th>الفصل</th><th>المادة</th><th>المعلم</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>{offerings.map((o) => <tr key={o.id}><td>{o.className}</td><td>{o.subjectNameAr}</td><td>{o.teacherNameAr || "غير محدد"}</td><td>{o.isActive ? "نشط" : "غير نشط"}</td><td><div className="ac-actions"><SchoolExportMenu rows={offeringExportRows.filter(row => row.id === o.id)} columns={offeringColumns} filename={`school-subject-offering-${o.id}`} title={`إسناد مادة: ${o.subjectNameAr}`} label="مستند" />{canEdit && <button className="ac-btn" onClick={() => { setClass(String(o.classId)); setSubject(String(o.subjectId)); setEditingOffering(o.id); setOfferingForm({ teacherEmployeeId: o.teacherEmployeeId ? String(o.teacherEmployeeId) : "", notes: o.notes || "" }); }}>تعديل</button>}{canDelete && <button className="ac-btn danger" onClick={() => { if (window.confirm("حذف إسناد المادة؟")) deleteOffering.mutate({ offeringId: o.id }, { onSuccess: () => { invalidate(getGetSchoolSubjectOfferingsQueryKey(offeringParams)); refreshAudit(); } }); }}>حذف</button>}</div></td></tr>)}</tbody></table>{offeringsQuery.isLoading && <div className="ac-state"><div className="ac-load" /></div>}{offeringsQuery.isError && <div className="ac-state">{errorText(offeringsQuery.error)} <button className="ac-btn" onClick={() => void offeringsQuery.refetch()}>إعادة المحاولة</button></div>}{!offerings.length && !offeringsQuery.isLoading && <div className="ac-empty">لا توجد إسنادات ضمن هذه السنة.</div>}</div>
  </div>;
  const renderPolicies = () => {
    const activePolicy = policies.find((p) => p.subjectId === subj);
    const changePolicy = (key: keyof SchoolGradeSubjectPolicy, value: unknown) => setPolicyDraft((d) => ({ ...d, [key]: value }));
    return <div className="ac-panel"><div className="ac-title"><div><h2>سياسة التقييم حسب الصف والمادة</h2><p>ضبط حدود الدرجات والأوزان وظهور التقييم اليومي لولي الأمر.</p></div><SchoolExportMenu rows={policyExportRows} columns={policyColumns} filename={`school-grade-subject-policies-${gradeId || "all"}`} title="سياسات تقييم الصفوف والمواد" subtitle={`الصف ${grades.find(g => String(g.id) === gradeId)?.nameAr || gradeId || "—"}`} disabled={policiesQuery.isLoading || policiesQuery.isError} /></div>
      <div className="ac-fields">{field("الصف", <select value={gradeId} onChange={(e) => { setGrade(inp(e)); setSubject(""); setPolicyDraft({}); }}><option value="">اختر الصف</option>{grades.map((g) => <option key={g.id} value={g.id}>{g.nameAr || g.name}</option>)}</select>)}{field("المادة", <select value={subjectId} onChange={(e) => { setSubject(inp(e)); setPolicyDraft({}); }}><option value="">اختر المادة</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.nameAr || s.name}</option>)}</select>)}
      {field("نوع المادة", <input value={String(policyDraft.subjectType ?? activePolicy?.subjectType ?? "أساسي")} onChange={(e) => changePolicy("subjectType", inp(e))} />)}
      {field("الدرجة القصوى", <input type="number" min="0.01" value={Number(policyDraft.maximumScore ?? activePolicy?.maximumScore ?? 100)} onChange={(e) => changePolicy("maximumScore", Number(inp(e)))} />)}
      {field("الحد الأدنى", <input type="number" min="0" value={Number(policyDraft.minimumScore ?? activePolicy?.minimumScore ?? 0)} onChange={(e) => changePolicy("minimumScore", Number(inp(e)))} />)}
      {field("نسبة النجاح %", <input type="number" min="0" max="100" value={Number(policyDraft.passMarkPercent ?? activePolicy?.passMarkPercent ?? 50)} onChange={(e) => changePolicy("passMarkPercent", Number(inp(e)))} />)}
      {field("دور ثانٍ عند %", <input type="number" min="0" max="100" value={Number(policyDraft.secondRoundPercent ?? activePolicy?.secondRoundPercent ?? 30)} onChange={(e) => changePolicy("secondRoundPercent", Number(inp(e)))} />)}
      {field("أوزان منتصف العام (JSON)", <input dir="ltr" value={JSON.stringify(policyDraft.midyearWeights ?? activePolicy?.midyearWeights ?? { coursework: 40, monthly: 20, midyear: 40 })} onChange={(e) => { try { changePolicy("midyearWeights", JSON.parse(inp(e))); } catch { /* preserve the last valid value while typing */ } }} />)}
      {field("أوزان نهاية العام (JSON)", <input dir="ltr" value={JSON.stringify(policyDraft.yearEndWeights ?? activePolicy?.yearEndWeights ?? { coursework: 30, monthly: 20, year_end: 50 })} onChange={(e) => { try { changePolicy("yearEndWeights", JSON.parse(inp(e))); } catch { /* preserve valid JSON */ } }} />)}
      {field("شرائح التقدير (JSON)", <input dir="ltr" value={JSON.stringify(policyDraft.gradeBands ?? activePolicy?.gradeBands ?? [{ minimumPercent: 90, label: "ممتاز" }, { minimumPercent: 80, label: "جيد جداً" }, { minimumPercent: 70, label: "جيد" }, { minimumPercent: 50, label: "مقبول" }])} onChange={(e) => { try { changePolicy("gradeBands", JSON.parse(inp(e))); } catch { /* preserve valid JSON */ } }} />)}
      {field("عرض التقييم اليومي للولي", <select value={String(policyDraft.showDailyAssessmentsToGuardians ?? activePolicy?.showDailyAssessmentsToGuardians ?? false)} onChange={(e) => changePolicy("showDailyAssessmentsToGuardians", inp(e) === "true")}><option value="false">مخفي</option><option value="true">ظاهر</option></select>)}
      </div><div className="ac-actions" style={{ marginTop: 14 }}>{canEdit && <button className="ac-btn primary" disabled={!grd || !subj || savePolicy.isPending} onClick={savePolicyDraft}>{savePolicy.isPending ? "جارٍ الحفظ…" : "حفظ سياسة المادة"}</button>}{savePolicy.isError && <span className="ac-alert">{errorText(savePolicy.error)}</span>}</div>
      <div className="ac-table-wrap" style={{ marginTop: 17 }}><table className="ac-table"><thead><tr><th>المادة</th><th>النوع</th><th>الحد الأقصى</th><th>النجاح</th><th>ظهور اليومي</th><th>التفعيل</th><th>مستند</th></tr></thead><tbody>{filteredPolicies.map((p) => <tr key={p.id}><td>{subjects.find((s) => s.id === p.subjectId)?.nameAr || `#${p.subjectId}`}</td><td>{p.subjectType}</td><td>{p.maximumScore}</td><td>{p.passMarkPercent}%</td><td>{p.showDailyAssessmentsToGuardians ? "ظاهر" : "مخفي"}</td><td>{p.isActive ? "نشطة" : "متوقفة"}</td><td><SchoolExportMenu rows={policyExportRows.filter(row => row.id === p.id)} columns={policyColumns} filename={`school-grade-subject-policy-${p.id}`} title={`سياسة المادة #${p.id}`} label="مستند" /></td></tr>)}</tbody></table>{policiesQuery.isLoading && <div className="ac-state"><div className="ac-load" /></div>}{!filteredPolicies.length && !policiesQuery.isLoading && <div className="ac-empty">اختر صفاً لعرض سياسة المواد القائمة.</div>}</div>
    </div>;
  };
  const renderGradebook = () => <div className="ac-panel"><div className="ac-title"><div><h2>دفتر الدرجات</h2><p>إدخال الدرجات دفعة واحدة على الاختبارات المعرفة في سجل المدرسة.</p></div>{gradebookQuery.data?.locked && <span className="ac-badge">مقفل بعد الاعتماد</span>}<SchoolExportMenu rows={gradebookExportRows} columns={gradebookColumns} filename={`school-gradebook-${cls || "class"}-${subj || "subject"}-${selectedPeriod || "period"}`} title="دفتر الدرجات" subtitle={`${classes.find(c => c.id === cls)?.name || cls || "—"} · ${subjects.find(s => s.id === subj)?.nameAr || subj || "—"} · ${activeAssessment?.name || "الاختبار الحالي"}`} disabled={!activeAssessment || gradebookQuery.isLoading || gradebookQuery.isError} /></div>
    {!cls || !subj || !selectedPeriod ? <div className="ac-empty">اختر الفصل والفترة والمادة لفتح دفتر الدرجات.</div> : gradebookQuery.isLoading ? <div className="ac-state"><div className="ac-load" /><div className="ac-load" /></div> : gradebookQuery.isError ? <div className="ac-state">{errorText(gradebookQuery.error)} <button className="ac-btn" onClick={() => void gradebookQuery.refetch()}>إعادة المحاولة</button></div> : <>
      {gradebookQuery.data?.policy && <div className="ac-alert">الدرجة القصوى لهذه المادة {gradebookQuery.data.policy.maximumScore} — النجاح من {gradebookQuery.data.policy.passMarkPercent}%</div>}
      <div className="ac-fields" style={{ marginTop: 12 }}>{field("الاختبار", <select value={activeAssessment?.id ?? ""} onChange={(e) => { setGradebookAssessmentId(inp(e)); setMarks({}); }}><option value="">اختر اختباراً</option>{(gradebookQuery.data?.assessments ?? []).map((exam) => <option key={exam.id} value={exam.id}>{exam.name} · {exam.examDate}</option>)}</select>)}</div>
      <div className="ac-table-wrap" style={{ marginTop: 12 }}><table className="ac-table"><thead><tr><th>الطالب</th><th>رقم الطالب</th><th>الاختبار الحالي</th><th>الدرجة</th><th>ملاحظة المعلم</th><th>مستند</th></tr></thead><tbody>{students.map((student) => { const result = student.marks.find((mark) => mark.examId === activeAssessment?.id); return <tr key={student.enrollmentId}><td>{student.fullNameAr}</td><td>{student.studentNumber}</td><td>{activeAssessment?.name || "لا يوجد اختبار"}</td><td><input type="number" min="0" max={activeAssessment?.maxScore ?? 100} disabled={gradebookQuery.data?.locked || !activeAssessment} value={marks[student.enrollmentId]?.score ?? result?.score ?? ""} onChange={(e) => setMark(student.enrollmentId, "score", inp(e))} /></td><td><input disabled={gradebookQuery.data?.locked || !activeAssessment} value={marks[student.enrollmentId]?.notes ?? result?.notes ?? ""} onChange={(e) => setMark(student.enrollmentId, "notes", inp(e))} /></td><td><SchoolExportMenu rows={gradebookExportRows.filter(row => row.id === student.enrollmentId)} columns={gradebookColumns} filename={`school-grade-${student.enrollmentId}-${activeAssessment?.id || "assessment"}`} title={`درجة الطالب: ${student.fullNameAr}`} label="مستند" disabled={!activeAssessment} /></td></tr>; })}</tbody></table>{!students.length && <div className="ac-empty">لا يوجد طلاب مقيدون لهذا الفصل.</div>}</div>
      {(saveMarks.isError || saveMarks.isSuccess) && <p className={saveMarks.isError ? "ac-alert" : "ac-badge"}>{saveMarks.isError ? errorText(saveMarks.error) : `تم حفظ درجات ${saveMarks.data?.saved ?? 0} طالب`}</p>}
      <div className="ac-actions" style={{ marginTop: 12 }}>{canEdit && <button className="ac-btn primary" disabled={!students.length || !activeAssessment || gradebookQuery.data?.locked || saveMarks.isPending} onClick={saveGradeMarks}>{saveMarks.isPending ? "جارٍ الحفظ…" : "حفظ الدرجات دفعة واحدة"}</button>}<span style={{ fontSize: 11, color: "#647675" }}>{activeAssessment ? `الاختبار: ${activeAssessment.name} · الحد الأعلى ${activeAssessment.maxScore}` : "أضف اختباراً من سجل الاختبارات أولاً."}</span></div>
    </>}</div>;
  const renderDaily = () => <div className="ac-panel"><div className="ac-title"><div><h2>التقييم اليومي</h2><p>تسجيل معايير المتابعة وملاحظات الطالب مع إبقاء حالة الحضور الحالية مرئية.</p></div><SchoolExportMenu rows={dailyExportRows} columns={dailyColumns} filename={`school-daily-assessment-${date}-${cls || "class"}`} title="التقييم اليومي للطلاب" subtitle={`${classes.find(c => c.id === cls)?.name || cls || "—"} · ${date}`} disabled={!cls || !subj || !selectedPeriod || dailyQuery.isLoading || dailyQuery.isError} /></div>
    <div className="ac-fields">{field("تاريخ التقييم", <input type="date" value={date} onChange={(e) => setDate(inp(e))} />)}</div>
    {!cls || !subj || !selectedPeriod ? <div className="ac-empty">اختر الفصل والفترة والمادة.</div> : dailyQuery.isLoading ? <div className="ac-state"><div className="ac-load" /><div className="ac-load" /></div> : dailyQuery.isError ? <div className="ac-state">{errorText(dailyQuery.error)} <button className="ac-btn" onClick={() => void dailyQuery.refetch()}>إعادة المحاولة</button></div> : <div className="ac-table-wrap" style={{ marginTop: 13 }}><table className="ac-table"><thead><tr><th>الطالب</th><th>الحضور</th><th>انضباط</th><th>مشاركة</th><th>واجب</th><th>نشاط</th><th>سلوك</th><th>تقييم المعلم</th><th>ملاحظات</th><th>مستند</th></tr></thead><tbody>{dailyRows.map((r) => <tr key={r.enrollmentId}><td>{r.fullNameAr}</td><td><span className="ac-badge">{r.attendanceStatus || "—"}</span></td>{(["attendanceDiscipline", "participation", "homework", "activity", "behavior", "teacherEvaluation"] as const).map((key) => <td key={key}><input aria-label={key} type="number" min="0" max="100" value={dailyScores[r.enrollmentId]?.[key] ?? r.scores[key] ?? ""} onChange={(e) => setDailyScores((s) => ({ ...s, [r.enrollmentId]: { ...s[r.enrollmentId], [key]: inp(e) } }))} /></td>)}<td><input value={dailyNotes[r.enrollmentId] ?? r.notes ?? ""} onChange={(e) => setDailyNotes((s) => ({ ...s, [r.enrollmentId]: inp(e) }))} /></td><td><SchoolExportMenu rows={dailyExportRows.filter(row => row.id === r.enrollmentId)} columns={dailyColumns} filename={`school-daily-assessment-${date}-${r.enrollmentId}`} title={`تقييم يومي: ${r.fullNameAr}`} label="مستند" /></td></tr>)}</tbody></table>{!dailyRows.length && <div className="ac-empty">لا توجد بيانات تقييم لهذا اليوم. ستظهر سجلات الطلاب الموجودة عند توفيرها من النظام.</div>}</div>}
    {dailyRows.length > 0 && <div className="ac-actions" style={{ marginTop: 12 }}>{canEdit && <button className="ac-btn primary" disabled={saveDaily.isPending} onClick={saveDailyRows}>{saveDaily.isPending ? "جارٍ الحفظ…" : "حفظ التقييمات اليومية"}</button>}{(saveDaily.isError || saveDaily.isSuccess) && <span className={saveDaily.isError ? "ac-alert" : "ac-badge"}>{saveDaily.isError ? errorText(saveDaily.error) : `تم حفظ ${saveDaily.data?.saved ?? 0} سجل`}</span>}</div>}
  </div>;
  const renderApprovals = () => <div className="ac-panel"><div className="ac-title"><div><h2>اعتماد النتائج وإعادة فتحها</h2><p>النشر ينشئ لقطة معتمدة ثابتة؛ إعادة الفتح تسحبها من العرض النهائي.</p></div><SchoolExportMenu rows={approvalExportRows} columns={approvalColumns} filename={`school-result-approvals-${year || "all"}`} title="اعتمادات النتائج الأكاديمية" subtitle={`السنة الدراسية ${years.find(r => r.id === year)?.name || year || "—"}`} disabled={approvalsQuery.isLoading || approvalsQuery.isError} /></div>
    <div className="ac-fields">{field("نوع النشر", <select value={approvalType} onChange={(e) => setApprovalType(inp(e) as "midyear" | "year_end")}><option value="midyear">نتائج منتصف العام</option><option value="year_end">نتائج نهاية العام</option></select>)}</div>
    <div className="ac-actions" style={{ margin: "12px 0" }}>{canEdit && <button className="ac-btn primary" disabled={!year || !cls || !subj || !selectedPeriod || approve.isPending} onClick={() => approve.mutate({ data: { academicYearId: year, periodId: selectedPeriod, classId: cls, subjectId: subj, publicationType: approvalType } }, { onSuccess: () => { invalidate(getGetSchoolResultApprovalsQueryKey(approvalParams)); invalidate(getGetSchoolAcademicReportQueryKey(reportParams)); refreshAudit(); } })}>{approve.isPending ? "جارٍ الاعتماد…" : "اعتماد ونشر اللقطة"}</button>}</div>
    {(approve.isError || reopen.isError) && <p className="ac-alert">{errorText(approve.error || reopen.error)}</p>}
     <div className="ac-table-wrap"><table className="ac-table"><thead><tr><th>الفترة</th><th>الفصل</th><th>المادة</th><th>النشر</th><th>الحالة</th><th>الاعتماد</th><th>مستند</th><th>إجراء</th></tr></thead><tbody>{(approvalsQuery.data ?? []).map((a) => <tr key={a.id}><td>{periods.find((p) => p.id === a.periodId)?.name || `#${a.periodId}`}</td><td>{classes.find((c) => c.id === a.classId)?.name || `#${a.classId}`}</td><td>{subjects.find((s) => s.id === a.subjectId)?.nameAr || `#${a.subjectId}`}</td><td>{a.publicationType === "midyear" ? "منتصف العام" : "نهاية العام"}</td><td><span className="ac-badge">{a.status === "approved" ? "معتمد" : "أعيد فتحه"}</span></td><td>{a.approvedAt ? new Date(a.approvedAt).toLocaleDateString("ar-SA") : "—"}</td><td><SchoolExportMenu rows={approvalExportRows.filter(row => row.id === a.id)} columns={approvalColumns} filename={`school-result-approval-${a.id}`} title={`اعتماد نتيجة #${a.id}`} label="مستند" /></td><td>{canEdit && a.status === "approved" && <button className="ac-btn danger" disabled={reopen.isPending} onClick={() => { if (window.confirm("إعادة فتح هذه النتيجة؟ لن تظهر للولي كحالة منشورة بعد إعادة الفتح.")) reopen.mutate({ approvalId: a.id }, { onSuccess: () => { invalidate(getGetSchoolResultApprovalsQueryKey(approvalParams)); invalidate(getGetSchoolAcademicReportQueryKey(reportParams)); refreshAudit(); } }); }}>إعادة فتح</button>}</td></tr>)}</tbody></table>{approvalsQuery.isLoading && <div className="ac-state"><div className="ac-load" /></div>}{approvalsQuery.isError && <div className="ac-state">{errorText(approvalsQuery.error)} <button className="ac-btn" onClick={() => void approvalsQuery.refetch()}>إعادة المحاولة</button></div>}{!approvalsQuery.isLoading && !approvalsQuery.data?.length && <div className="ac-empty">لا توجد لقطات نتائج لهذا العام.</div>}</div>
  </div>;
  const renderReports = () => <div className="ac-panel"><div className="ac-title"><div><h2>التقارير الأكاديمية الداخلية</h2><p>ملخصات أسبوعية وشهرية وتقارير الاختبارات والتقدم الدراسي.</p></div><SchoolExportMenu rows={reportExportRows} columns={reportColumns} filename={`school-academic-report-${reportType}-${reportDate.startDate}`} title="التقرير الأكاديمي" subtitle={`${reportType} · ${reportDate.startDate} — ${reportDate.endDate}`} disabled={reportQuery.isLoading || reportQuery.isError} /></div>
    <div className="ac-fields">{field("نوع التقرير", <select value={reportType} onChange={(e) => setReportType(inp(e) as typeof reportType)}><option value="weekly">أسبوعي</option><option value="monthly">شهري</option><option value="monthly_exams">اختبارات شهرية</option><option value="midyear">منتصف العام</option><option value="year_end">نهاية العام</option><option value="student_progress">تقدم الطالب</option></select>)}{field("من تاريخ", <input type="date" value={reportDate.startDate} onChange={(e) => setReportDate({ ...reportDate, startDate: inp(e) })} />)}{field("إلى تاريخ", <input type="date" value={reportDate.endDate} onChange={(e) => setReportDate({ ...reportDate, endDate: inp(e) })} />)}</div>
     <div className="ac-table-wrap" style={{ marginTop: 14 }}><table className="ac-table"><thead><tr><th>الطالب</th><th>المادة</th><th>عدد التقييمات</th><th>المتوسط</th><th>الدرجة</th><th>التقدير</th><th>الحالة</th><th>ملاحظات</th><th>مستند</th></tr></thead><tbody>{(reportQuery.data?.rows ?? []).map((r, i) => <tr key={`${r.enrollmentId}-${r.subjectId}-${i}`}><td>{r.fullNameAr}</td><td>{r.subjectNameAr}</td><td>{r.assessmentCount}</td><td>{r.averagePercent == null ? "—" : `${r.averagePercent}%`}</td><td>{r.score == null ? "—" : `${r.score}/${r.maximumScore}`}</td><td>{r.grade || "—"}</td><td>{r.status || "—"}</td><td>{r.teacherNotes || "—"}</td><td><SchoolExportMenu rows={reportExportRows.filter(row => row.id === `${r.enrollmentId}-${r.subjectId}-${i}`)} columns={reportColumns} filename={`school-academic-report-row-${r.enrollmentId}-${r.subjectId}`} title={`نتيجة الطالب ${r.fullNameAr}`} label="مستند" /></td></tr>)}</tbody></table>{reportQuery.isLoading && <div className="ac-state"><div className="ac-load" /></div>}{reportQuery.isError && <div className="ac-state">{errorText(reportQuery.error)} <button className="ac-btn" onClick={() => void reportQuery.refetch()}>إعادة المحاولة</button></div>}{!reportQuery.isLoading && !reportQuery.data?.rows?.length && <div className="ac-empty">لا توجد نتائج تقرير ضمن المحددات.</div>}</div>
  </div>;
  const renderAudit = () => <div className="ac-panel"><div className="ac-title"><div><h2>سجل التغييرات الأكاديمية</h2><p>تتبّع تعديلات الدرجات والسياسات والاعتمادات حسب سجل التدقيق.</p></div><SchoolExportMenu rows={auditExportRows} columns={auditColumns} filename={`school-academic-audit-${year || "all"}`} title="سجل التغييرات الأكاديمية" subtitle={`السنة الدراسية ${years.find(r => r.id === year)?.name || year || "—"}`} disabled={auditQuery.isLoading || auditQuery.isError} /><button className="ac-btn" onClick={() => void auditQuery.refetch()}>تحديث السجل</button></div>
    <div className="ac-table-wrap"><table className="ac-table"><thead><tr><th>الوقت</th><th>نوع السجل</th><th>المعرف</th><th>العملية</th><th>قبل</th><th>بعد</th><th>المنفذ</th><th>مستند</th></tr></thead><tbody>{(auditQuery.data ?? []).map((a) => <tr key={a.id}><td>{new Date(a.occurredAt).toLocaleString("ar-SA")}</td><td>{a.entityType}</td><td>{a.entityId ?? "—"}</td><td>{a.action}</td><td><code>{JSON.stringify(a.beforeValue ?? "—")}</code></td><td><code>{JSON.stringify(a.afterValue ?? "—")}</code></td><td>{a.actorId ?? "—"}</td><td><SchoolExportMenu rows={auditExportRows.filter(row => row.id === a.id)} columns={auditColumns} filename={`school-academic-audit-event-${a.id}`} title={`تغيير أكاديمي #${a.id}`} label="مستند" /></td></tr>)}</tbody></table>{auditQuery.isLoading && <div className="ac-state"><div className="ac-load" /></div>}{auditQuery.isError && <div className="ac-state">{errorText(auditQuery.error)} <button className="ac-btn" onClick={() => void auditQuery.refetch()}>إعادة المحاولة</button></div>}{!auditQuery.isLoading && !auditQuery.data?.length && <div className="ac-empty">لا توجد تغييرات مسجلة.</div>}</div>
  </div>;

  return <main className="academic-workspace space-y-4 p-4 sm:p-5" dir="rtl">
    <header className="ac-head"><span className="ac-kicker">إدارة المدرسة / الرقابة الأكاديمية</span><h1>التحكم الأكاديمي</h1><p>من تنظيم الفترات إلى اعتماد النتائج المنشورة — مساحة واحدة مرتبطة بسجلات المدرسة الحالية.</p></header>
    <nav className="ac-nav" aria-label="أقسام التحكم الأكاديمي">{NAV.map(([key, label]) => <button key={key} aria-current={section === key} onClick={() => { setSection(key); if (key === "exams" || key === "results") setTab(key); }}>{label}</button>)}</nav>
    {section !== "exams" && section !== "results" && pickers}
    {section === "periods" && renderPeriods()}
    {section === "offerings" && renderOfferings()}
    {section === "policies" && renderPolicies()}
    {section === "gradebook" && renderGradebook()}
    {section === "daily" && renderDaily()}
    {section === "approvals" && renderApprovals()}
    {section === "reports" && renderReports()}
    {section === "audit" && renderAudit()}
    {(section === "exams" || section === "results") && <div dir="rtl"><div className="flex gap-2 px-1 pt-2 pb-1"><button className={`ac-btn ${tab === "exams" ? "primary" : ""}`} onClick={() => { setTab("exams"); setSection("exams"); }}>الاختبارات</button><button className={`ac-btn ${tab === "results" ? "primary" : ""}`} onClick={() => { setTab("results"); setSection("results"); }}>النتائج</button></div><SchoolCrudPage key={tab} config={tab === "exams" ? examConfig : resultConfig} /></div>}
  </main>;
}
