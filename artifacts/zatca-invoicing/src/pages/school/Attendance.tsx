import { useState } from "react";
import { CalendarDays, ClipboardCheck, RotateCw, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { usePermission } from "@/hooks/usePermission";
import { JournalScanArchive } from "@/components/JournalScanArchive";
import { useSchoolBulkAttendance, useSchoolContext, useSchoolList, type Row } from "./schoolApi";

const dateToday = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${date.year}-${date.month}-${date.day}`;
};
const attendanceStatuses = [["present", "حاضر"], ["absent", "غائب"], ["late", "متأخر"], ["excused", "بعذر"]] as const;
export default function Attendance() {
  const [classId, setClassId] = useState("");
  const [academicYearId, setAcademicYearId] = useState("");
  const [attendanceDate, setAttendanceDate] = useState(dateToday());
  const [period, setPeriod] = useState("full_day");
  const [status, setStatus] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});
  const canCreate = usePermission("school", "create");
  const canEdit = usePermission("school", "edit");
  const { companyId, companyName } = useSchoolContext();
  const classes = useSchoolList<Row>("classes", { page: 1, limit: 100, ...(academicYearId ? { academicYearId } : {}) });
  const years = useSchoolList<Row>("academic-years", { page: 1, limit: 100 });
  const enrollments = useSchoolList<Row>("enrollments", { page: 1, limit: 100, ...(classId ? { classId } : {}), ...(academicYearId ? { academicYearId } : {}) });
  const existing = useSchoolList<Row>("attendance", { page: 1, limit: 100, attendanceDate, period, ...(classId ? { classId } : {}) });
  const students = useSchoolList<Row>("students", { page: 1, limit: 100 });
  const bulk = useSchoolBulkAttendance();
  const enrolled = enrollments.data?.items ?? [];
  const attendanceByEnrollment = new Map((existing.data?.items ?? []).map(x => [Number(x.enrollmentId), x]));
  const getStatus = (id: number) => status[id] || attendanceByEnrollment.get(id)?.status || "present";
  const classItems = (classes.data?.items ?? []).map(x => ({ value: String(x.id), label: x.name || x.code || `فصل ${x.id}`, description: x.code }));
  const yearItems = (years.data?.items ?? []).map(x => ({ value: String(x.id), label: x.name || `سنة ${x.id}` }));
  return <main className="space-y-4 p-4 sm:p-5" dir="rtl">
    <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-start gap-3"><span className="mt-1 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><ClipboardCheck className="h-5 w-5" /></span><div><h1 className="text-xl font-bold sm:text-2xl">تسجيل الحضور</h1><p className="mt-1 text-sm text-muted-foreground">اختر التاريخ والفصل، ثم احفظ سجل الحضور دفعة واحدة.</p></div></div>
       <Button className="gap-2" disabled={!canCreate || !canEdit || !classId || enrolled.length === 0 || bulk.isPending} onClick={() => bulk.mutate({ attendanceDate, period, records: enrolled.map((e: Row) => ({ enrollmentId: e.id, status: getStatus(e.id), ...(notes[e.id] ? { note: notes[e.id] } : {}) })) })}>{bulk.isPending ? "جارٍ الحفظ..." : "حفظ الحضور"}</Button></header>
    <section className="grid grid-cols-1 gap-3 rounded-xl border bg-card p-3 sm:grid-cols-4">
      <label className="space-y-1 text-xs font-medium"><span>السنة الدراسية</span><SearchCombobox items={yearItems} value={academicYearId} onValueChange={v => { setAcademicYearId(v); setClassId(""); }} placeholder="اختر السنة" /></label>
      <label className="space-y-1 text-xs font-medium"><span>الفصل</span><SearchCombobox items={classItems} value={classId} onValueChange={setClassId} placeholder="اختر الفصل" disabled={!academicYearId} /></label>
       <label className="space-y-1 text-xs font-medium"><span>تاريخ الحضور</span><div className="relative"><CalendarDays className="absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input className="pe-9" type="date" value={attendanceDate} onChange={e => setAttendanceDate(e.target.value)} /></div></label>
       <label className="space-y-1 text-xs font-medium"><span>الفترة</span><select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={period} onChange={e => setPeriod(e.target.value)}><option value="full_day">اليوم الدراسي</option><option value="morning">الفترة الصباحية</option><option value="afternoon">الفترة المسائية</option></select></label>
    </section>
    {bulk.isSuccess && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">تم حفظ سجلات الحضور: {bulk.data.saved}</div>}
    {bulk.isError && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{(bulk.error as Error).message}</div>}
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b bg-muted/20 px-4 py-3"><div><h2 className="font-semibold">قائمة الفصل</h2><p className="text-xs text-muted-foreground">{enrolled.length} طالباً مسجلاً</p></div><Button variant="outline" size="sm" onClick={() => { void enrollments.refetch(); void existing.refetch(); }} aria-label="تحديث القائمة"><RotateCw className="h-4 w-4" /></Button></div>
      {!classId ? <div className="p-12 text-center text-sm text-muted-foreground">حدد السنة والفصل لعرض الطلاب المسجلين.</div>
        : enrollments.isLoading || existing.isLoading ? <div className="space-y-3 p-5">{[1, 2, 3].map(n => <div className="h-10 animate-pulse rounded bg-muted" key={n} />)}</div>
        : enrollments.isError || existing.isError ? <div role="alert" className="p-10 text-center"><AlertCircle className="mx-auto mb-2 h-5 w-5 text-destructive" /><p className="text-sm">تعذر تحميل بيانات الفصل والحضور.</p><Button className="mt-3" size="sm" variant="outline" onClick={() => { void enrollments.refetch(); void existing.refetch(); }}>إعادة المحاولة</Button></div>
        : enrolled.length === 0 ? <div className="p-12 text-center text-sm text-muted-foreground">لا يوجد طلاب مقيدون في هذا الفصل لهذه السنة.</div>
          : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3 text-start">الطالب</th><th className="px-4 py-3 text-start">الرقم الطلابي</th><th className="px-4 py-3 text-start">الحالة</th><th className="px-4 py-3 text-start">ملاحظة</th><th className="px-4 py-3 text-center">المرفقات</th></tr></thead><tbody className="divide-y">{enrolled.map((e: Row) => {
           const student = students.data?.items.find((row: Row) => row.id === e.studentId);
           const studentName = e.studentNameAr || e.fullNameAr || student?.fullNameAr || `طالب رقم ${e.studentId}`;
             const attendanceRecord = attendanceByEnrollment.get(e.id);
             return <tr key={e.id} className="hover:bg-muted/20"><td className="px-4 py-3 font-medium">{studentName}</td><td className="px-4 py-3 font-mono text-xs">{e.studentNumber || student?.studentNumber || e.studentId}</td><td className="px-4 py-3"><select aria-label={`حالة الطالب ${studentName}`} className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={getStatus(e.id)} disabled={!canCreate || !canEdit} onChange={ev => setStatus(prev => ({ ...prev, [e.id]: ev.target.value }))}>{attendanceStatuses.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></td><td className="px-4 py-3"><Input aria-label="ملاحظة الحضور" value={notes[e.id] ?? attendanceRecord?.note ?? ""} disabled={!canCreate || !canEdit} onChange={ev => setNotes(prev => ({ ...prev, [e.id]: ev.target.value }))} className="max-w-xs" placeholder="اختياري" /></td><td className="px-4 py-2 text-center">{attendanceRecord?.id ? <JournalScanArchive compact canEdit={canEdit} companyName={companyName} screenKey="school_records" jeKey={`school:${companyId ?? "none"}:attendance:${attendanceRecord.id}`} /> : <span className="text-xs text-muted-foreground">احفظ الحضور أولاً</span>}</td></tr>;
         })}</tbody></table></div>}
    </section>
  </main>;
}
