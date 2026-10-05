import { Link } from "wouter";
import { ArrowLeft, BookOpen, Building2, CalendarCheck, ClipboardList, FileText, GraduationCap, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSchoolDashboard } from "./schoolApi";
const tiles = [
  { href: "/school/campuses", label: "المجمّعات", key: "campuses", icon: Building2, tone: "teal" },
  { href: "/school/students", label: "الطلاب", key: "students", icon: UsersRound, tone: "blue" },
  { href: "/school/enrollments", label: "القيود النشطة", key: "activeEnrollments", icon: GraduationCap, tone: "violet" },
  { href: "/school/academic", label: "الفصول النشطة", key: "activeClasses", icon: BookOpen, tone: "amber" },
];
const attendance = [["present", "حاضرون"], ["absent", "غائبون"], ["late", "متأخرون"], ["excused", "بعذر"]] as const;
export default function SchoolDashboard() {
  const { data, isLoading, isError, error, refetch } = useSchoolDashboard();
  return <main dir="rtl" className="space-y-5 p-4 sm:p-5">
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 sm:p-5">
      <div><p className="text-xs font-semibold tracking-wide text-primary">إدارة المدرسة</p><h1 className="mt-1 text-2xl font-bold tracking-tight">ملخص العمليات المدرسية</h1><p className="mt-1 text-sm text-muted-foreground">صورة تشغيلية مباشرة للسجلات الأكاديمية والحضور والاختبارات.</p></div>
      <div className="flex gap-2"><Link href="/school/attendance" className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"><CalendarCheck className="h-4 w-4" />تسجيل الحضور</Link><Link href="/school/students" className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"><UsersRound className="h-4 w-4" />سجل الطلاب</Link></div>
    </header>
    {isError ? <section className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center"><p className="font-medium">تعذر تحميل ملخص المدرسة</p><p className="mt-1 text-sm text-muted-foreground">{(error as Error).message}</p><Button className="mt-3" variant="outline" size="sm" onClick={() => refetch()}>إعادة المحاولة</Button></section> : <>
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map(t => <Link key={t.key} href={t.href} className="group rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-primary/[0.025]">
          <div className="flex items-center justify-between"><span className={`flex h-10 w-10 items-center justify-center rounded-xl ${t.tone === "teal" ? "bg-teal-100 text-teal-800" : t.tone === "blue" ? "bg-sky-100 text-sky-800" : t.tone === "violet" ? "bg-violet-100 text-violet-800" : "bg-amber-100 text-amber-800"}`}><t.icon className="h-5 w-5" /></span><ArrowLeft className="h-4 w-4 text-muted-foreground transition-transform group-hover:-translate-x-1" /></div><p className="mt-4 text-sm text-muted-foreground">{t.label}</p><p className="mt-1 font-mono text-2xl font-bold">{isLoading ? <span className="inline-block h-7 w-16 animate-pulse rounded bg-muted" /> : data?.[t.key] ?? 0}</p>
        </Link>)}
      </section>
      <section className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
        <article className="rounded-xl border bg-card"><div className="flex items-center justify-between border-b p-4"><div><h2 className="font-semibold">حضور اليوم</h2><p className="mt-1 text-xs text-muted-foreground">ملخص الحالات المسجلة لهذا اليوم</p></div><Link href="/school/attendance" className="text-xs font-medium text-primary hover:underline">فتح التحضير</Link></div><div className="grid grid-cols-2 gap-3 p-4">{attendance.map(([key, label]) => <div key={key} className="rounded-lg border bg-muted/15 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-mono text-xl font-semibold">{isLoading ? "—" : data?.attendanceToday?.[key] ?? 0}</p></div>)}</div></article>
        <article className="rounded-xl border bg-card"><div className="flex items-center justify-between border-b p-4"><div><h2 className="font-semibold">الاختبارات القادمة</h2><p className="mt-1 text-xs text-muted-foreground">حسب السجلات الأكاديمية</p></div><Link href="/school/assessments" className="text-xs font-medium text-primary hover:underline">إدارة الاختبارات</Link></div>
          {isLoading ? <div className="space-y-3 p-4">{[1, 2, 3].map(n => <div key={n} className="h-10 animate-pulse rounded bg-muted" />)}</div> : data?.upcomingExams?.length ? <div className="divide-y">{data.upcomingExams.slice(0, 5).map((exam: any) => <div key={exam.id} className="flex items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{exam.name}</p><p className="text-xs text-muted-foreground">{exam.className || (exam.classId ? `الفصل ${exam.classId}` : "—")}</p></div><span className="shrink-0 rounded-md bg-muted px-2 py-1 text-xs">{exam.examDate ? new Date(exam.examDate).toLocaleDateString("ar-SA") : "—"}</span></div>)}</div> : <div className="p-10 text-center text-sm text-muted-foreground"><ClipboardList className="mx-auto mb-2 h-5 w-5" />لا توجد اختبارات قادمة مسجلة.</div>}
        </article>
      </section>
      <section className="grid gap-4 sm:grid-cols-2">
        <Link href="/school/fees" className="flex items-center justify-between rounded-xl border bg-card p-4 hover:bg-muted/20"><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-800"><FileText className="h-5 w-5" /></span><div><h2 className="font-semibold">رسوم بانتظار ربط الفواتير</h2><p className="mt-1 text-xs text-muted-foreground">التحصيل والترحيل عبر فواتير ERP وإيصالاته</p></div></div><span className="font-mono text-xl font-bold">{isLoading ? "—" : data?.unlinkedFees ?? 0}</span></Link>
        <Link href="/school/fees" className="flex items-center justify-between rounded-xl border bg-card p-4 hover:bg-muted/20"><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-800"><FileText className="h-5 w-5" /></span><div><h2 className="font-semibold">رسوم مرتبطة بفواتير</h2><p className="mt-1 text-xs text-muted-foreground">مرجع تشغيلي لفواتير المبيعات الموجودة</p></div></div><span className="font-mono text-xl font-bold">{isLoading ? "—" : data?.linkedInvoices ?? 0}</span></Link>
      </section>
    </>}
  </main>;
}
