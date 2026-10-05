import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowUpRight, CheckCircle2, GraduationCap, RotateCw, Search } from "lucide-react";
import {
  useGetSchoolEnrollmentPromotionPlan,
  usePromoteSchoolEnrollments,
  type SchoolEnrollmentPromotionCandidate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePermission } from "@/hooks/usePermission";
import { useSchoolContext, useSchoolList, type Row } from "./schoolApi";

const PAGE_SIZE = 20;

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function EnrollmentPromotionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { companyId } = useSchoolContext();
  const canCreate = usePermission("school", "create");
  const queryClient = useQueryClient();
  const [sourceYearId, setSourceYearId] = useState("");
  const [targetYearId, setTargetYearId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [groupTargets, setGroupTargets] = useState<Record<number, number>>({});
  const [rowTargets, setRowTargets] = useState<Record<number, number>>({});
  const [excludedIds, setExcludedIds] = useState<Set<number>>(new Set());
  const [enrollmentDate, setEnrollmentDate] = useState("");
  const [copyFeeValues, setCopyFeeValues] = useState(false);
  const [completed, setCompleted] = useState<{ created: number; skippedExisting: number } | null>(null);

  const years = useSchoolList<Row>("academic-years", { page: 1, limit: 100 });
  const classes = useSchoolList<Row>("classes", {
    page: 1,
    limit: 100,
    ...(targetYearId ? { academicYearId: Number(targetYearId) } : {}),
  });
  const grades = useSchoolList<Row>("grades", { page: 1, limit: 100 });
  const sourceId = Number(sourceYearId || 0);
  const targetId = Number(targetYearId || 0);
  const promotionPlan = useGetSchoolEnrollmentPromotionPlan(
    {
      companyId: Number(companyId ?? 0),
      sourceYearId: sourceId,
      targetYearId: targetId,
    },
    {
      query: {
        queryKey: ["school-promotion-plan", companyId, sourceId, targetId],
        enabled: open && !!companyId && sourceId > 0 && targetId > 0 && sourceId !== targetId,
      },
    },
  );
  const promote = usePromoteSchoolEnrollments();

  useEffect(() => {
    setGroupTargets({});
    setRowTargets({});
    setExcludedIds(new Set());
    setPage(1);
    setSearch("");
    setEnrollmentDate("");
    setCompleted(null);
  }, [sourceYearId, targetYearId]);

  useEffect(() => {
    if (!open) {
      setSourceYearId("");
      setTargetYearId("");
      setCopyFeeValues(false);
      setCompleted(null);
    }
  }, [open]);

  useEffect(() => {
    if (promotionPlan.data?.targetYearStartDate && !enrollmentDate) {
      setEnrollmentDate(promotionPlan.data.targetYearStartDate);
    }
  }, [promotionPlan.data?.targetYearStartDate, enrollmentDate]);

  const candidates = promotionPlan.data?.candidates ?? [];
  const eligibleCandidates = useMemo(() => candidates.filter((candidate) => candidate.eligible), [candidates]);
  const yearItems = years.data?.items ?? [];
  const targetClasses = (classes.data?.items ?? []).filter((item) => item.isActive !== false);
  const gradeItems = grades.data?.items ?? [];

  const suggestions = useMemo(() => {
    const result: Record<number, number> = {};
    const groups = new Map<number, SchoolEnrollmentPromotionCandidate>();
    for (const candidate of eligibleCandidates) {
      if (!groups.has(candidate.sourceClassId)) groups.set(candidate.sourceClassId, candidate);
    }
    for (const [sourceClassId, source] of groups) {
      const nextGrades = gradeItems
        .filter((grade) => grade.stage === source.sourceStage && numberValue(grade.orderNo) > source.sourceGradeOrderNo)
        .sort((a, b) => numberValue(a.orderNo) - numberValue(b.orderNo));
      const nextOrder = nextGrades[0] ? numberValue(nextGrades[0].orderNo) : null;
      if (nextOrder == null) continue;
      const nextGrade = nextGrades.filter((grade) => numberValue(grade.orderNo) === nextOrder);
      if (nextGrade.length !== 1) continue;
      const matchingClasses = targetClasses.filter((item) => Number(item.gradeId) === Number(nextGrade[0].id));
      const sameCampus = source.sourceCampusId == null
        ? []
        : matchingClasses.filter((item) => Number(item.campusId) === source.sourceCampusId);
      const suggested = sameCampus.length === 1
        ? sameCampus[0]
        : matchingClasses.length === 1
          ? matchingClasses[0]
          : null;
      if (suggested) result[sourceClassId] = Number(suggested.id);
    }
    return result;
  }, [eligibleCandidates, gradeItems, targetClasses]);

  const destinationFor = (candidate: SchoolEnrollmentPromotionCandidate) =>
    rowTargets[candidate.enrollmentId] || groupTargets[candidate.sourceClassId] || suggestions[candidate.sourceClassId] || 0;
  const selectedCandidates = eligibleCandidates.filter((candidate) => !excludedIds.has(candidate.enrollmentId));
  const missingDestinationCount = selectedCandidates.filter((candidate) => !destinationFor(candidate)).length;
  const filteredCandidates = candidates.filter((candidate) => {
    const normalized = search.trim().toLocaleLowerCase();
    return !normalized
      || candidate.studentName.toLocaleLowerCase().includes(normalized)
      || candidate.studentNumber.toLocaleLowerCase().includes(normalized)
      || candidate.sourceClassName.toLocaleLowerCase().includes(normalized)
      || candidate.sourceGradeName.toLocaleLowerCase().includes(normalized);
  });
  const totalPages = Math.max(1, Math.ceil(filteredCandidates.length / PAGE_SIZE));
  const pageCandidates = filteredCandidates.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const groups = useMemo(() => {
    const grouped = new Map<number, { candidate: SchoolEnrollmentPromotionCandidate; count: number }>();
    for (const candidate of eligibleCandidates) {
      const existing = grouped.get(candidate.sourceClassId);
      if (existing) existing.count += 1;
      else grouped.set(candidate.sourceClassId, { candidate, count: 1 });
    }
    return [...grouped.values()];
  }, [eligibleCandidates]);

  const classLabel = (item: Row) => {
    const grade = gradeItems.find((candidate) => Number(candidate.id) === Number(item.gradeId));
    const label = [grade?.nameAr, item.name || item.code || `فصل ${item.id}`].filter(Boolean).join(" · ");
    return item.code ? `${label} (${item.code})` : label;
  };

  const toggleExcluded = (enrollmentId: number) => {
    setExcludedIds((previous) => {
      const next = new Set(previous);
      if (next.has(enrollmentId)) next.delete(enrollmentId);
      else next.add(enrollmentId);
      return next;
    });
  };

  const setRowDestination = (enrollmentId: number, value: string) => {
    setRowTargets((previous) => {
      const next = { ...previous };
      if (!value) delete next[enrollmentId];
      else next[enrollmentId] = Number(value);
      return next;
    });
  };

  const submitPromotion = () => {
    if (!companyId || !sourceId || !targetId || !enrollmentDate || !canCreate
      || selectedCandidates.length === 0 || missingDestinationCount > 0 || completed) return;
    promote.mutate({
      data: {
        companyId: Number(companyId),
        sourceYearId: sourceId,
        targetYearId: targetId,
        enrollmentDate,
        copyFeeValues,
        assignments: selectedCandidates.map((candidate) => ({
          enrollmentId: candidate.enrollmentId,
          targetClassId: destinationFor(candidate),
        })),
      },
    }, {
      onSuccess: async (result) => {
        setCompleted(result);
        await queryClient.invalidateQueries({ queryKey: ["school", companyId] });
        await promotionPlan.refetch();
      },
    });
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-h-[94dvh] max-w-none overflow-y-auto" dir="rtl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><GraduationCap className="h-5 w-5 text-primary" />ترحيل الطلاب إلى سنة دراسية جديدة</DialogTitle>
        <DialogDescription>
          راجع الفصول المقترحة، وعدّل وجهة أي طالب أو استثنه قبل إنشاء القيود الجديدة. قيود السنوات السابقة لا تتغير.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 rounded-xl border bg-muted/10 p-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-medium">
          <span>السنة المصدر</span>
          <select aria-label="السنة المصدر" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={sourceYearId} onChange={(event) => setSourceYearId(event.target.value)}>
            <option value="">اختر السنة الحالية</option>
            {yearItems.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium">
          <span>السنة المستهدفة</span>
          <select aria-label="السنة المستهدفة" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={targetYearId} onChange={(event) => setTargetYearId(event.target.value)}>
            <option value="">اختر السنة الجديدة</option>
            {yearItems.filter((year) => String(year.id) !== sourceYearId).map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}
          </select>
        </label>
      </div>

      {years.isLoading && <p className="text-sm text-muted-foreground">جارٍ تحميل السنوات الدراسية...</p>}
      {years.isError && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">تعذر تحميل السنوات الدراسية.</div>}
      {sourceYearId && targetYearId && sourceYearId === targetYearId && <p role="alert" className="text-sm text-destructive">اختر سنتين مختلفتين.</p>}

      {promotionPlan.isLoading && <div className="space-y-3"><div className="h-12 animate-pulse rounded bg-muted" /><div className="h-48 animate-pulse rounded bg-muted" /></div>}
      {promotionPlan.isError && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <div className="flex items-center gap-2"><AlertCircle className="h-4 w-4" />تعذر إعداد معاينة الترحيل.</div>
        <p className="mt-1">{(promotionPlan.error as Error)?.message}</p>
        <Button className="mt-3" size="sm" variant="outline" onClick={() => void promotionPlan.refetch()}>إعادة المحاولة</Button>
      </div>}

      {promotionPlan.data && <>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
          <div>
            <p className="font-semibold">{promotionPlan.data.sourceYearName} <ArrowUpRight className="mx-1 inline h-4 w-4" /> {promotionPlan.data.targetYearName}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {eligibleCandidates.length} طالب مؤهل · {candidates.length - eligibleCandidates.length} مستثنى أو مسجل مسبقاً · {selectedCandidates.length} محدد للترحيل
            </p>
          </div>
          <Button size="sm" variant="outline" className="gap-2" onClick={() => void promotionPlan.refetch()} aria-label="تحديث المعاينة"><RotateCw className="h-4 w-4" />تحديث</Button>
        </div>

        {groups.length > 0 && <section className="space-y-2 rounded-xl border p-3">
          <div>
            <h3 className="text-sm font-semibold">اقتراح الفصل حسب الفصل الحالي</h3>
            <p className="text-xs text-muted-foreground">اختيار هنا يطبّق على المجموعة؛ ويمكن تغيير فصل طالب بعينه في الجدول أدناه.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map(({ candidate, count }) => (
              <label key={candidate.sourceClassId} className="space-y-1 rounded-lg border bg-muted/10 p-2 text-xs">
                <span className="block font-medium">{candidate.sourceGradeName} · {candidate.sourceClassName} ({count})</span>
                <select
                  aria-label={`الفصل المقترح لمجموعة ${candidate.sourceClassName}`}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={groupTargets[candidate.sourceClassId] || suggestions[candidate.sourceClassId] || ""}
                  onChange={(event) => setGroupTargets((previous) => ({
                    ...previous,
                    [candidate.sourceClassId]: Number(event.target.value),
                  }))}
                >
                  <option value="">اختر الفصل المستهدف</option>
                  {targetClasses.map((item) => <option key={item.id} value={item.id}>{classLabel(item)}</option>)}
                </select>
              </label>
            ))}
          </div>
          {classes.isLoading && <p className="text-xs text-muted-foreground">جارٍ تحميل فصول السنة المستهدفة...</p>}
          {classes.isError && <p role="alert" className="text-xs text-destructive">تعذر تحميل فصول السنة المستهدفة.</p>}
          {targetYearId && !classes.isLoading && targetClasses.length === 0 && <p className="text-xs text-amber-700">لا توجد فصول نشطة في السنة المستهدفة. أنشئ الفصول أولاً ثم أعد المعاينة.</p>}
          {(classes.data?.total ?? 0) > (classes.data?.items.length ?? 0) && <p className="text-xs text-amber-700">تعرض القائمة أول 100 فصل فقط؛ راجع إعدادات السنة إذا كانت تحتوي على عدد أكبر.</p>}
        </section>}

        <section className="space-y-3 rounded-xl border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">مراجعة الطلاب والوجهات</h3>
              <p className="text-xs text-muted-foreground">المكررون في السنة المستهدفة وغير النشطين لا يمكن اختيارهم.</p>
            </div>
            <div className="relative w-full max-w-xs">
              <Search className="absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="بحث في طلاب الترحيل" className="pe-9" placeholder="ابحث بالاسم أو الرقم أو الفصل" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[850px] text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="w-12 px-3 py-2 text-center">اختيار</th>
                  <th className="px-3 py-2 text-start">الطالب</th>
                  <th className="px-3 py-2 text-start">الفصل الحالي</th>
                  <th className="px-3 py-2 text-start">الفصل المستهدف</th>
                  <th className="px-3 py-2 text-start">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pageCandidates.map((candidate) => {
                  const checked = candidate.eligible && !excludedIds.has(candidate.enrollmentId);
                  const reason = candidate.alreadyEnrolledTargetYear
                    ? "مسجل مسبقاً في السنة الهدف"
                    : candidate.enrollmentStatus !== "active"
                      ? "قيد السنة السابقة غير نشط"
                      : candidate.studentStatus !== "active"
                        ? "ملف الطالب غير نشط"
                        : "جاهز للمراجعة";
                  return <tr key={candidate.enrollmentId} className={checked ? "bg-primary/[0.025]" : ""}>
                    <td className="px-3 py-2 text-center">
                      <input type="checkbox" aria-label={`اختيار ${candidate.studentName}`} checked={checked} disabled={!candidate.eligible || !!completed} onChange={() => toggleExcluded(candidate.enrollmentId)} />
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-medium">{candidate.studentName}</p>
                      <p className="text-xs text-muted-foreground">{candidate.studentNumber}</p>
                    </td>
                    <td className="px-3 py-2">{candidate.sourceGradeName} · {candidate.sourceClassName}</td>
                    <td className="px-3 py-2">
                      <select
                        aria-label={`الفصل المستهدف للطالب ${candidate.studentName}`}
                        className="h-8 w-full max-w-[300px] rounded-md border border-input bg-background px-2 text-xs"
                        value={destinationFor(candidate) || ""}
                        disabled={!candidate.eligible || !!completed || classes.isLoading || classes.isError}
                        onChange={(event) => setRowDestination(candidate.enrollmentId, event.target.value)}
                      >
                        <option value="">اختر الفصل</option>
                        {targetClasses.map((item) => <option key={item.id} value={item.id}>{classLabel(item)}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${candidate.eligible ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground"}`}>{reason}</span>
                    </td>
                  </tr>;
                })}
                {pageCandidates.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">لا توجد نتائج مطابقة.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{filteredCandidates.length} طالب · صفحة {page} من {totalPages}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>السابق</Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>التالي</Button>
            </div>
          </div>
        </section>

        <div className="grid gap-3 rounded-xl border bg-muted/10 p-3 sm:grid-cols-[1fr_220px]">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={copyFeeValues} disabled={!!completed} onChange={(event) => setCopyFeeValues(event.target.checked)} />
            <span>
              نسخ الرسوم والخصم السابقين كقيم مبدئية قابلة للتعديل.
              <span className="mt-1 block text-xs text-muted-foreground">لن ينشئ الترحيل مطالبة رسوم أو فاتورة.</span>
            </span>
          </label>
          <label className="space-y-1 text-xs font-medium">
            <span>تاريخ القيد الجديد</span>
            <Input type="date" value={enrollmentDate} disabled={!!completed} onChange={(event) => setEnrollmentDate(event.target.value)} />
          </label>
        </div>
      </>}

      {completed && <div role="status" className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <span>اكتمل الترحيل: أُنشئ {completed.created} قيداً جديداً، وتُجاوز {completed.skippedExisting} لوجود قيد مسبق. لم تتغير قيود السنوات السابقة.</span>
      </div>}
      {promote.isError && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{(promote.error as Error)?.message || "تعذر تنفيذ الترحيل."}</div>}

      <DialogFooter className="gap-2 sm:justify-between">
        <p className={`self-center text-xs ${missingDestinationCount > 0 ? "text-amber-700" : "text-muted-foreground"}`}>
          {selectedCandidates.length === 0
            ? "حدد طالباً مؤهلاً واحداً على الأقل."
            : missingDestinationCount > 0
              ? `اختر فصلاً مستهدفاً لـ ${missingDestinationCount} طالباً محدداً.`
              : `${selectedCandidates.length} قيداً جاهزاً للمراجعة والإنشاء.`}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>إغلاق</Button>
          <Button
            className="gap-2"
            disabled={!promotionPlan.data || !canCreate || selectedCandidates.length === 0 || missingDestinationCount > 0 || !enrollmentDate || promote.isPending || !!completed || classes.isLoading || classes.isError}
            onClick={submitPromotion}
          >
            <GraduationCap className="h-4 w-4" />
            {promote.isPending ? "جارٍ إنشاء القيود..." : "اعتماد الترحيل وإنشاء القيود"}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
