import { AlertCircle, CalendarDays, GraduationCap } from "lucide-react";
import { useGetSchoolStudentAcademicHistory } from "@workspace/api-client-react";
import type { SchoolStudentAcademicHistory } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { Row } from "./schoolApi";
import { useSchoolContext } from "./schoolApi";

const formatDate = (value: string) => {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("ar-EG");
};

const enrollmentStatus = (status: string) => ({
  active: "نشط",
  transferred: "منقول",
  withdrawn: "منسحب",
  completed: "مكتمل",
}[status] ?? status);

function HistoryContent({ history }: { history: SchoolStudentAcademicHistory }) {
  if (history.enrollments.length === 0) {
    return <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">لا توجد قيود دراسية مسجلة لهذا الطالب.</div>;
  }

  return <div className="space-y-4">
    {history.enrollments.map((enrollment) => (
      <article key={enrollment.id} className="overflow-hidden rounded-xl border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/20 px-4 py-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <GraduationCap className="h-5 w-5" />
            </span>
            <div>
              <h3 className="font-semibold">{enrollment.yearName}</h3>
              <p className="text-sm text-muted-foreground">{enrollment.className}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded-full px-2.5 py-1 font-medium ${enrollment.status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground"}`}>
              {enrollmentStatus(enrollment.status)}
            </span>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              قيد {formatDate(enrollment.enrollmentDate)}
            </span>
          </div>
        </header>

        <div className="grid gap-4 p-4 md:grid-cols-[220px_1fr]">
          <section aria-label="ملخص الحضور" className="rounded-lg border bg-muted/10 p-3">
            <h4 className="mb-2 text-sm font-semibold">الحضور</h4>
            <p className="mb-2 text-xs text-muted-foreground">إجمالي السجلات: {enrollment.attendance.total}</p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <span>حاضر <b>{enrollment.attendance.present}</b></span>
              <span>غائب <b>{enrollment.attendance.absent}</b></span>
              <span>متأخر <b>{enrollment.attendance.late}</b></span>
              <span>بعذر <b>{enrollment.attendance.excused}</b></span>
              {enrollment.attendance.other > 0 && <span>أخرى <b>{enrollment.attendance.other}</b></span>}
            </div>
          </section>

          <section className="min-w-0">
            <h4 className="mb-2 text-sm font-semibold">نتائج الاختبارات</h4>
            {enrollment.results.length === 0
              ? <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">لا توجد نتائج اختبارات مسجلة لهذه السنة.</p>
              : <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-start">الاختبار</th>
                      <th className="px-3 py-2 text-start">المادة</th>
                      <th className="px-3 py-2 text-start">التاريخ</th>
                      <th className="px-3 py-2 text-center">النتيجة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {enrollment.results.map((result) => (
                      <tr key={result.examId}>
                        <td className="px-3 py-2">{result.examName}</td>
                        <td className="px-3 py-2">{result.subjectName}</td>
                        <td className="px-3 py-2">{formatDate(result.examDate)}</td>
                        <td className="px-3 py-2 text-center">
                          {result.score} / {result.maxScore}
                          <span className="ms-2 text-xs text-muted-foreground">
                            {result.percentage == null ? "—" : `${result.percentage}%`}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>}
          </section>
        </div>
      </article>
    ))}
  </div>;
}

export function StudentAcademicHistoryDialog({
  student,
  open,
  onOpenChange,
}: {
  student: Row | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { companyId } = useSchoolContext();
  const history = useGetSchoolStudentAcademicHistory(
    Number(student?.id ?? 0),
    { companyId: Number(companyId ?? 0) },
    {
      query: {
        queryKey: ["school-student-academic-history", companyId, student?.id],
        enabled: open && !!student?.id && !!companyId,
      },
    },
  );

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto" dir="rtl">
      <DialogHeader>
        <DialogTitle>السجل الدراسي للطالب</DialogTitle>
        <DialogDescription>
          {student ? `${student.fullNameAr || student.studentNumber} · ${student.studentNumber || `#${student.id}`}` : "عرض القيود والنتائج والحضور عبر السنوات الدراسية."}
        </DialogDescription>
      </DialogHeader>

      {history.isLoading
        ? <div className="space-y-3 py-2" aria-label="جارٍ تحميل السجل الدراسي">
          {[1, 2].map((item) => <div key={item} className="h-24 animate-pulse rounded-xl bg-muted" />)}
        </div>
        : history.isError
          ? <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <div className="mb-2 flex items-center gap-2"><AlertCircle className="h-4 w-4" />تعذر تحميل السجل الدراسي.</div>
            <p>{(history.error as Error)?.message}</p>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => void history.refetch()}>إعادة المحاولة</Button>
          </div>
          : history.data
            ? <HistoryContent history={history.data} />
            : <div className="py-8 text-center text-sm text-muted-foreground">اختر طالباً لعرض سجله الدراسي.</div>}
    </DialogContent>
  </Dialog>;
}
