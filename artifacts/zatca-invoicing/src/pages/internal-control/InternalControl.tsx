import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck, RefreshCw, Download, Printer, Search, ExternalLink, AlertTriangle, FileWarning,
  UserX, Boxes, Landmark, HardHat, History, Settings2, ChevronRight, ChevronLeft, Eye, X,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { usePermission } from "@/hooks/usePermission";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  icApi, SEVERITY_LABEL, STATUS_LABEL, ACTION_LABEL,
  type IcFilters, type IcCase, type IcRule, type IcSeverity, type IcStatus, type IcAction,
} from "@/lib/internalControlApi";

// Sub-view → case `category` filter value. Values follow backend rule categories.
const VIEWS: Record<string, { title: string; hint: string; category?: string; icon: any }> = {
  cases:       { title: "العمليات التي تحتاج مراجعة", hint: "كل الحالات المسجلة من قواعد الرقابة المفعلة", icon: ShieldCheck },
  permissions: { title: "مخالفات الصلاحيات", hint: "إنشاء واعتماد بنفس المستخدم، عمليات خارج الصلاحية", category: "permissions", icon: UserX },
  documents:   { title: "التعديلات على المستندات", hint: "تعديل أو إلغاء بعد الاعتماد، تغيير قيم مالية", category: "documents", icon: FileWarning },
  anomalies:   { title: "العمليات غير الطبيعية", hint: "قيم أو توقيتات خارج النمط المعتاد", category: "anomalies", icon: AlertTriangle },
  projects:    { title: "تنبيهات المشاريع والمقاولات", hint: "المستخلصات، خطابات الضمان، الدفعات المقدمة والمحتجزات", category: "project_alerts", icon: HardHat },
  inventory:   { title: "تنبيهات المخزون", hint: "تحويلات وتسويات وأرصدة تحتاج مراجعة", category: "inventory", icon: Boxes },
  finance:     { title: "تنبيهات المالية", hint: "قيود وسندات وحسابات مرتبطة", category: "finance", icon: Landmark },
};

const SEV_TONE: Record<IcSeverity, string> = {
  low: "bg-slate-100 text-slate-700 border-slate-200",
  medium: "bg-amber-50 text-amber-800 border-amber-200",
  high: "bg-orange-100 text-orange-800 border-orange-300",
  critical: "bg-rose-100 text-rose-800 border-rose-300",
};
const SEV_BAR: Record<IcSeverity, string> = { low: "bg-slate-300", medium: "bg-amber-400", high: "bg-orange-500", critical: "bg-rose-600" };
const STATUS_TONE: Record<IcStatus, string> = {
  open: "text-sky-800 bg-sky-50 border-sky-200",
  in_review: "text-violet-800 bg-violet-50 border-violet-200",
  resolved: "text-emerald-800 bg-emerald-50 border-emerald-200",
  ignored: "text-stone-600 bg-stone-100 border-stone-200",
};

function fmtDate(s?: string | null) {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(+d) ? s : d.toLocaleString("ar-SA-u-nu-latn", { dateStyle: "medium", timeStyle: "short" });
}
function ageDays(c: IcCase): number {
  const base = new Date(c.occurredAt || c.createdAt).getTime();
  const end = c.resolvedAt ? new Date(c.resolvedAt).getTime() : Date.now();
  return Math.max(0, Math.floor((end - base) / 86400000));
}

// Users/branches lookups for filters and reviewer names. Failures degrade to ids.
function useLookups(cid: number | undefined) {
  const lookup = useQuery({
    queryKey: ["ic", cid, "lookups"],
    enabled: !!cid,
    queryFn: icApi.lookups,
  });
  const users = { data: lookup.data?.users };
  const branches = { data: lookup.data?.branches };
  const userName = (id?: number | null) => {
    if (id == null) return "—";
    const u = (users.data ?? []).find((x: any) => x.id === id);
    return u ? (u.fullName || u.name || u.username || u.email || `#${id}`) : `مستخدم #${id}`;
  };
  const branchName = (id?: number | null) => {
    if (id == null) return "بدون فرع";
    const b = (branches.data ?? []).find((x: any) => x.id === id);
    return b ? (b.nameAr || b.name || `#${id}`) : `فرع #${id}`;
  };
  return { users: users.data ?? [], branches: branches.data ?? [], userName, branchName, error: lookup.error };
}

// Filters persist per company + view in sessionStorage so navigating to a case and back keeps them.
function usePersistedFilters(cid: number | undefined, view: string) {
  const { user } = useAuth();
  const search = useSearch();
  const key = `ic-filters:${user?.id}:${cid ?? "x"}:${view}:${search}`;
  const read = (): IcFilters => {
    try { const saved=JSON.parse(sessionStorage.getItem(key) || "null"); if(saved && typeof saved==="object" && !Array.isArray(saved)) return saved; } catch { /* fresh filters */ }
    const params=new URLSearchParams(search);
    const initial:IcFilters={page:1,limit:25};
    for(const k of ["category","status","severity","branchId","userId","projectId","customerId","supplierId","from","to"] as const) {
      const value=params.get(k); if(value)initial[k]=value;
    }
    return initial;
  };
  const [stored, setStored] = useState(() => ({key,value:read()}));
  const f=stored.key===key?stored.value:read();
  const setF=(value:IcFilters)=> {
    setStored({key,value});
    try {sessionStorage.setItem(key,JSON.stringify(value));} catch { /* storage unavailable */ }
  };
  return [f, setF] as const;
}

export default function InternalControl() {
  const [location] = useLocation();
  const { user } = useAuth() as any;
  const cid: number | undefined = user?.company?.id ?? user?.companyId ?? undefined;
  const qc = useQueryClient();
  const accessScope = JSON.stringify([user?.id, cid, user?.permissions, user?.branchIds, user?.viewAllBranches]);
  useEffect(() => { void qc.resetQueries({ queryKey: ["ic"] }); }, [qc, accessScope]);
  const parts = location.replace(/^\/internal-control\/?/, "").split("/").filter(Boolean);
  const view = parts[0] === "cases" && parts[1] ? "case" : (parts[0] || "dashboard");
  const lookups = useLookups(cid);

  return (
    <div dir="rtl" className="ic-root min-h-[100dvh] bg-[hsl(40_30%_97%)] -m-4 md:-m-6 p-4 md:p-8">
      <style>{`
        .ic-root { font-feature-settings: "tnum"; }
        .ic-rule { background-image: repeating-linear-gradient(0deg, transparent 0 27px, hsl(200 20% 88% / .5) 27px 28px); }
        @keyframes icIn { from { opacity:0; transform: translateY(6px) } to { opacity:1; transform:none } }
        .ic-in > * { animation: icIn .35s ease-out both; }
        .ic-in > *:nth-child(2){animation-delay:.04s}.ic-in > *:nth-child(3){animation-delay:.08s}.ic-in > *:nth-child(4){animation-delay:.12s}
        @media print { .ic-noprint { display:none !important } .ic-root { background:white; margin:0; padding:0 } }
      `}</style>
      <Header view={view} />
      {lookups.error && <p role="alert" className="text-sm text-rose-800 mt-3">تعذر تحميل المستخدمين والفروع. أعد تحميل الصفحة للمحاولة مجددًا.</p>}
      <div className="mt-6">
        {view === "dashboard" && <Dashboard cid={cid} lookups={lookups} />}
        {view === "case" && <CaseDetail cid={cid} id={parts[1]} lookups={lookups} />}
        {view === "log" && <LogView cid={cid} lookups={lookups} />}
        {view === "rules" && <RulesView cid={cid} lookups={lookups} />}
        {VIEWS[view] && <CasesView cid={cid} view={view} lookups={lookups} />}
        {!VIEWS[view] && !["dashboard", "case", "log", "rules"].includes(view) && (
          <EmptyBlock title="صفحة غير معروفة" text="هذا القسم غير موجود ضمن الرقابة الداخلية." />
        )}
      </div>
    </div>
  );
}

function Header({ view }: { view: string }) {
  const canCases = usePermission("internal_control_cases");
  const canLog = usePermission("internal_control_log");
  const canRules = usePermission("internal_control_rules");
  const tabs: { href: string; label: string; show: boolean; key: string }[] = [
    { key: "dashboard", href: "/internal-control", label: "اللوحة", show: true },
    ...Object.entries(VIEWS).map(([k, v]) => ({ key: k, href: `/internal-control/${k}`, label: v.title, show: canCases })),
    { key: "log", href: "/internal-control/log", label: "السجل", show: canLog },
    { key: "rules", href: "/internal-control/rules", label: "القواعد", show: canRules },
  ];
  return (
    <header className="ic-noprint">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[11px] tracking-[0.2em] text-[hsl(196_45%_32%)] font-semibold">التقارير · الرقابة الداخلية</p>
          <h1 className="text-2xl md:text-[28px] font-bold text-[hsl(205_40%_14%)] mt-1">دفتر المراجعة</h1>
          <p className="text-sm text-[hsl(205_12%_42%)] mt-1 max-w-xl">
            مراقبة وتنبيه فقط. التنبيه دعوة للمراجعة وليس حكمًا بوجود مخالفة، ولا يُعدَّل أي مستند من هنا.
          </p>
        </div>
      </div>
      <nav className="mt-5 flex gap-1 overflow-x-auto border-b border-[hsl(200_20%_86%)] pb-px">
        {tabs.filter(t => t.show).map(t => {
          const on = view === t.key || (view === "case" && t.key === "cases");
          return (
            <Link key={t.key} href={t.href}
              className={`whitespace-nowrap px-3 py-2 text-[13px] border-b-2 -mb-px transition-colors ${on
                ? "border-[hsl(196_60%_30%)] text-[hsl(196_60%_22%)] font-semibold"
                : "border-transparent text-[hsl(205_12%_45%)] hover:text-[hsl(205_40%_20%)]"}`}>
              {t.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

// ─── Dashboard ─────────────────────────────────────────────────────────────
function Dashboard({ cid, lookups }: { cid?: number; lookups: ReturnType<typeof useLookups> }) {
  const [f, setF] = usePersistedFilters(cid, "dashboard");
  const canCases = usePermission("internal_control_cases");
  const canScan = usePermission("internal_control_rules", "edit");
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["ic", cid, "dashboard", f], queryFn: () => icApi.dashboard(f), enabled: !!cid });
  const urgent = useQuery({
    queryKey: ["ic", cid, "cases", "urgent", f],
    enabled: !!cid && canCases,
    queryFn: () => icApi.cases({ ...f, severity: "critical", status: "open", page: 1, limit: 6 }),
  });
  const scan = useMutation({
    mutationFn: icApi.scan,
    onSuccess: r => {
      toast({ title: "اكتمل الفحص", description: `تم تقييم ${r.evaluated ?? 0} وإنشاء ${r.created ?? 0} حالة جديدة` });
      qc.invalidateQueries({ queryKey: ["ic", cid] });
    },
    onError: (e: any) => toast({ title: "تعذر الفحص", description: e.message, variant: "destructive" }),
  });
  const m = q.data?.metrics;
  const tiles: { k: keyof NonNullable<typeof m>; label: string; href?: string; tone?: string }[] = [
    { k: "open", label: "حالات مفتوحة", href: "/internal-control/cases?status=open" },
    { k: "highRisk", label: "عالية الخطورة", tone: "text-rose-700" },
    { k: "inReview", label: "قيد المراجعة" },
    { k: "resolved", label: "تمت معالجتها", tone: "text-emerald-700" },
    { k: "postApproval", label: "تعديلات بعد الاعتماد", href: "/internal-control/cases?category=post_approval" },
    { k: "permissions", label: "خارج الصلاحيات", href: "/internal-control/permissions" },
    { k: "cancelled", label: "ملغاة أو محذوفة", href: "/internal-control/cases?category=cancelled" },
    { k: "projects", label: "تنبيهات المشاريع", href: "/internal-control/projects" },
    { k: "inventory", label: "تنبيهات المخزون", href: "/internal-control/inventory" },
    { k: "finance", label: "تنبيهات الحسابات", href: "/internal-control/finance" },
    { k: "guarantees", label: "خطابات الضمان", href: "/internal-control/cases?category=guarantees" },
    { k: "advances", label: "الدفعات المقدمة", href: "/internal-control/cases?category=advances" },
  ];
  const caps = q.data?.capabilities ?? {};
  return (
    <div className="space-y-6">
      <FilterBar f={f} setF={setF} lookups={lookups} compact
        extra={canScan && (
          <Button size="sm" variant="outline" onClick={() => scan.mutate()} disabled={scan.isPending} className="gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${scan.isPending ? "animate-spin" : ""}`} /> تشغيل الفحص
          </Button>
        )} />
      {q.isError ? <ErrorBlock e={q.error} retry={() => q.refetch()} /> : (
        <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-px bg-[hsl(200_20%_86%)] border border-[hsl(200_20%_86%)] rounded-lg overflow-hidden ic-in">
          <div className="col-span-2 row-span-2 bg-[hsl(205_40%_14%)] text-[hsl(40_30%_96%)] p-5 flex flex-col justify-between">
            <span className="text-xs opacity-70">إجمالي الحالات</span>
            {q.isLoading ? <Skeleton className="h-14 w-28 bg-white/10" /> : <span className="text-6xl font-bold leading-none">{m?.total ?? 0}</span>}
            <span className="text-xs opacity-70">الأرقام من الحالات المسجلة فعليًا ضمن نطاق الفلاتر</span>
          </div>
          {tiles.map(t => {
            const body = (
              <div className="bg-white/80 hover:bg-white p-4 h-full transition-colors">
                <div className="text-[11px] text-[hsl(205_12%_45%)]">{t.label}</div>
                {q.isLoading ? <Skeleton className="h-7 w-12 mt-2" /> : <div className={`text-2xl font-bold mt-1 ${t.tone ?? "text-[hsl(205_40%_14%)]"}`}>{m?.[t.k] ?? 0}</div>}
              </div>
            );
            return t.href && canCases ? <Link key={t.k} href={t.href} className="block">{body}</Link> : <div key={t.k}>{body}</div>;
          })}
        </section>
      )}
      <div className="grid lg:grid-cols-[1.6fr_1fr] gap-6">
        <section className="bg-white/80 border border-[hsl(200_20%_86%)] rounded-lg">
          <div className="px-4 py-3 border-b border-[hsl(200_20%_90%)] flex items-center justify-between">
            <h2 className="font-semibold text-sm">حرجة ومفتوحة — تحتاج مراجعة الآن</h2>
            {canCases && <Link href="/internal-control/cases" className="text-xs text-[hsl(196_60%_28%)]">كل الحالات</Link>}
          </div>
          {!canCases ? <p className="p-4 text-sm text-muted-foreground">لا تملك صلاحية عرض الحالات.</p>
            : urgent.isLoading ? <RowsSkeleton n={4} />
            : urgent.isError ? <ErrorBlock e={urgent.error} retry={() => urgent.refetch()} />
            : (urgent.data?.items.length ?? 0) === 0 ? <EmptyBlock title="لا توجد حالات حرجة مفتوحة" text="لم تسجل القواعد المفعلة أي حالة حرجة بانتظار المراجعة." />
            : <ul className="divide-y divide-[hsl(200_20%_92%)]">{urgent.data!.items.map(c => <CaseLine key={c.id} c={c} lookups={lookups} />)}</ul>}
        </section>
        <section className="bg-white/80 border border-[hsl(200_20%_86%)] rounded-lg p-4">
          <h2 className="font-semibold text-sm">صلاحيات الرقابة الحالية</h2>
          <p className="text-xs text-muted-foreground mt-1">صلاحيات حسابك؛ دعم مصادر الأدلة موضح في صفحة القواعد.</p>
          <ul className="mt-3 space-y-1.5 text-[13px]">
            {Object.keys(caps).length === 0 && <li className="text-muted-foreground text-xs">لم يُرجع الخادم تفاصيل القدرات.</li>}
            {Object.entries(caps).map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-[hsl(205_20%_30%)]">{({internal_control:"الرقابة الداخلية",internal_control_cases:"الحالات",internal_control_review:"المراجعة والإسناد",internal_control_ignore:"التجاهل",internal_control_reopen:"إعادة الفتح",internal_control_rules:"عرض القواعد",internal_control_rules_edit:"تعديل القواعد والفحص",internal_control_log:"السجل",internal_control_export:"التصدير"} as Record<string,string>)[k] ?? k}</span>
                {typeof v === "boolean"
                  ? <span className={`text-[11px] px-2 py-0.5 rounded border ${v ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-stone-100 border-stone-200 text-stone-600"}`}>{v ? "مسموح" : "غير مسموح"}</span>
                  : <span className="text-[11px] text-muted-foreground">{String(v)}</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function CaseLine({ c, lookups }: { c: IcCase; lookups: ReturnType<typeof useLookups> }) {
  return (
    <li>
      <Link href={`/internal-control/cases/${c.id}`} className="flex items-stretch gap-3 px-4 py-3 hover:bg-[hsl(40_30%_97%)]">
        <span className={`w-1 rounded-full ${SEV_BAR[c.severity]}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{c.description || c.ruleKey}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            #{c.id} · {c.documentType ?? "—"} {c.documentNumber ?? ""} · {lookups.userName(c.userId)} · منذ {ageDays(c)} يوم
          </div>
        </div>
        <ChevronLeft className="h-4 w-4 self-center text-muted-foreground" />
      </Link>
    </li>
  );
}

// ─── Filters ───────────────────────────────────────────────────────────────
const sel = "h-9 rounded-md border border-[hsl(200_20%_84%)] bg-white px-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-[hsl(196_60%_30%/.3)]";
function FilterBar({ f, setF, lookups, compact, hideCategory, extra }: {
  f: IcFilters; setF: (f: IcFilters) => void; lookups: ReturnType<typeof useLookups>;
  compact?: boolean; hideCategory?: boolean; extra?: React.ReactNode;
}) {
  const set = (k: keyof IcFilters, v: string) => setF({ ...f, [k]: v || undefined, page: 1 });
  const active = Object.entries(f).filter(([k, v]) => !["page", "limit"].includes(k) && v).length;
  return (
    <div className="ic-noprint bg-white/70 border border-[hsl(200_20%_86%)] rounded-lg p-3 flex flex-wrap items-end gap-2">
      <label className="text-[11px] text-muted-foreground flex flex-col gap-1">من<input type="date" className={sel} value={f.from ?? ""} onChange={e => set("from", e.target.value)} /></label>
      <label className="text-[11px] text-muted-foreground flex flex-col gap-1">إلى<input type="date" className={sel} value={f.to ?? ""} onChange={e => set("to", e.target.value)} /></label>
      <label className="text-[11px] text-muted-foreground flex flex-col gap-1">الفرع
        <select className={sel} value={f.branchId ?? ""} onChange={e => set("branchId", e.target.value)}>
          <option value="">الكل</option>
          {lookups.branches.map((b: any) => <option key={b.id} value={b.id}>{b.nameAr || b.name}</option>)}
        </select>
      </label>
      <label className="text-[11px] text-muted-foreground flex flex-col gap-1">المستخدم
        <select className={sel} value={f.userId ?? ""} onChange={e => set("userId", e.target.value)}>
          <option value="">الكل</option>
          {lookups.users.map((u: any) => <option key={u.id} value={u.id}>{u.fullName || u.name || u.username}</option>)}
        </select>
      </label>
      <label className="text-[11px] text-muted-foreground flex flex-col gap-1">الخطورة
        <select className={sel} value={f.severity ?? ""} onChange={e => set("severity", e.target.value)}>
          <option value="">الكل</option>
          {(Object.keys(SEVERITY_LABEL) as IcSeverity[]).map(s => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
        </select>
      </label>
      <label className="text-[11px] text-muted-foreground flex flex-col gap-1">الحالة
        <select className={sel} value={f.status ?? ""} onChange={e => set("status", e.target.value)}>
          <option value="">الكل</option>
          {(Object.keys(STATUS_LABEL) as IcStatus[]).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </label>
      {!compact && !hideCategory && (
        <label className="text-[11px] text-muted-foreground flex flex-col gap-1">نوع العملية
          <select className={sel} value={f.category ?? ""} onChange={e => set("category", e.target.value)}>
            <option value="">الكل</option>
            {Object.entries(VIEWS).filter(([, v]) => v.category).map(([, v]) => <option key={v.category} value={v.category}>{v.title}</option>)}
            {Object.entries({post_approval:"بعد الاعتماد",cancelled:"إلغاء وحذف",master_data:"بيانات أساسية",sales:"المبيعات",purchases:"المشتريات",guarantees:"خطابات الضمان",advances:"دفعات مقدمة",projects:"مستخلصات",operations:"عمليات"}).map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      )}
      {!compact && (<>
        <label className="text-[11px] text-muted-foreground flex flex-col gap-1">رقم المشروع<Input className="h-9 w-24" inputMode="numeric" value={f.projectId ?? ""} onChange={e => set("projectId", e.target.value.replace(/\D/g, ""))} /></label>
        <label className="text-[11px] text-muted-foreground flex flex-col gap-1">رقم العميل<Input className="h-9 w-24" inputMode="numeric" value={f.customerId ?? ""} onChange={e => set("customerId", e.target.value.replace(/\D/g, ""))} /></label>
        <label className="text-[11px] text-muted-foreground flex flex-col gap-1">رقم المورد<Input className="h-9 w-24" inputMode="numeric" value={f.supplierId ?? ""} onChange={e => set("supplierId", e.target.value.replace(/\D/g, ""))} /></label>
      </>)}
      {active > 0 && (
        <Button size="sm" variant="ghost" className="gap-1 text-xs" onClick={() => setF({ page: 1, limit: f.limit ?? 25 })}>
          <X className="h-3.5 w-3.5" /> مسح ({active})
        </Button>
      )}
      <div className="ms-auto flex gap-2">{extra}</div>
    </div>
  );
}

// ─── Case list ─────────────────────────────────────────────────────────────
function CasesView({ cid, view, lookups }: { cid?: number; view: string; lookups: ReturnType<typeof useLookups> }) {
  const def = VIEWS[view];
  const [f, setF] = usePersistedFilters(cid, view);
  const canExport = usePermission("internal_control_export", "export");
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const eff: IcFilters = { ...f, category: def.category ?? f.category, page: f.page ?? 1, limit: f.limit ?? 25 };
  const q = useQuery({ queryKey: ["ic", cid, "cases", view, eff], queryFn: () => icApi.cases(eff), enabled: !!cid });
  const items = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = q.data?.items ?? [];
    if (!s) return list;
    return list.filter(c => [c.description, c.documentNumber, c.ruleKey, c.reason, String(c.id)].some(x => (x ?? "").toLowerCase().includes(s)));
  }, [q.data, search]);
  const exp = useMutation({
    mutationFn: () => icApi.exportCsv(eff),
    onError: (e: any) => toast({ title: "تعذر التصدير", description: e.message, variant: "destructive" }),
  });
  const Icon = def.icon;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="h-9 w-9 rounded-md bg-[hsl(196_45%_92%)] text-[hsl(196_60%_26%)] grid place-items-center"><Icon className="h-4.5 w-4.5" /></span>
        <div><h2 className="font-bold text-lg">{def.title}</h2><p className="text-xs text-muted-foreground">{def.hint}</p></div>
      </div>
      <FilterBar f={f} setF={setF} lookups={lookups} hideCategory={!!def.category}
        extra={<>
          <div className="relative"><Search className="h-3.5 w-3.5 absolute top-2.5 start-2 text-muted-foreground" />
            <Input className="h-9 w-44 ps-7" placeholder="بحث في الصفحة" value={search} onChange={e => setSearch(e.target.value)} /></div>
          <Button size="sm" variant="outline" className="gap-1.5 h-9" onClick={() => window.print()}><Printer className="h-3.5 w-3.5" /> طباعة</Button>
          {canExport && <Button size="sm" variant="outline" className="gap-1.5 h-9" disabled={exp.isPending} onClick={() => exp.mutate()}><Download className="h-3.5 w-3.5" /> CSV</Button>}
        </>} />
      <div className="hidden print:block text-sm mb-2">{def.title} — {new Date().toLocaleDateString("ar-SA-u-nu-latn")}</div>
      <section className="bg-white/85 border border-[hsl(200_20%_86%)] rounded-lg overflow-hidden">
        {q.isLoading ? <RowsSkeleton n={8} /> : q.isError ? <ErrorBlock e={q.error} retry={() => q.refetch()} /> : items.length === 0 ? (
          <EmptyBlock title="لا توجد حالات مطابقة" text="لم تسجل قواعد الرقابة أي حالة ضمن هذه الفلاتر. غياب الحالات لا يعني بالضرورة غياب الأدلة إذا كانت القاعدة غير مدعومة أو معطلة." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-[hsl(200_25%_95%)] text-[hsl(205_20%_35%)] text-[11px]">
                <tr>{["#", "الخطورة", "الوصف", "المستند", "الفرع", "المنفذ", "التاريخ", "العمر", "الحالة", "المراجع", ""].map(h => <th key={h} className="text-start font-semibold px-3 py-2 whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-[hsl(200_20%_92%)]">
                {items.map(c => {
                  const age = ageDays(c);
                  const stale = !["resolved", "ignored"].includes(c.status) && age > 7;
                  return (
                    <tr key={c.id} className="hover:bg-[hsl(40_30%_97%)]">
                      <td className="px-3 py-2 font-mono text-[12px] text-muted-foreground">{c.id}</td>
                      <td className="px-3 py-2"><SevChip s={c.severity} /></td>
                      <td className="px-3 py-2 max-w-[320px]"><div className="truncate font-medium">{c.description || c.ruleKey}</div><div className="truncate text-[11px] text-muted-foreground">{c.reason}</div></td>
                      <td className="px-3 py-2 whitespace-nowrap">{c.documentType ?? "—"} <span className="font-mono text-[12px]">{c.documentNumber ?? ""}</span></td>
                      <td className="px-3 py-2 whitespace-nowrap">{lookups.branchName(c.branchId)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{lookups.userName(c.userId)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-[12px]">{fmtDate(c.occurredAt || c.createdAt)}</td>
                      <td className={`px-3 py-2 whitespace-nowrap text-[12px] ${stale ? "text-rose-700 font-semibold" : ""}`}>{age} يوم</td>
                      <td className="px-3 py-2"><StatusChip s={c.status} /></td>
                      <td className="px-3 py-2 whitespace-nowrap">{c.reviewerId ? lookups.userName(c.reviewerId) : <span className="text-muted-foreground">غير مسند</span>}</td>
                      <td className="px-3 py-2 ic-noprint"><Link href={`/internal-control/cases/${c.id}`} className="inline-flex items-center gap-1 text-[hsl(196_60%_28%)] text-xs"><Eye className="h-3.5 w-3.5" /> فتح</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {q.data && <Pager page={eff.page!} limit={eff.limit!} total={q.data.total} onPage={p => setF({ ...f, page: p })} />}
      </section>
    </div>
  );
}

function Pager({ page, limit, total, onPage }: { page: number; limit: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="ic-noprint flex items-center justify-between px-4 py-2 border-t border-[hsl(200_20%_90%)] text-xs text-muted-foreground">
      <span>{total} سجل · صفحة {page} من {pages}</span>
      <div className="flex gap-1">
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronRight className="h-4 w-4" /></Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={page >= pages} onClick={() => onPage(page + 1)}><ChevronLeft className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

// ─── Case detail ───────────────────────────────────────────────────────────
function CaseDetail({ cid, id, lookups }: { cid?: number; id: string; lookups: ReturnType<typeof useLookups> }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const canReview = usePermission("internal_control_review", "edit");
  const canIgnore = usePermission("internal_control_ignore", "edit");
  const canReopen = usePermission("internal_control_reopen", "edit");
  const q = useQuery({ queryKey: ["ic", cid, "case", id], queryFn: () => icApi.case(id), enabled: !!cid && !!id });
  const [dlg, setDlg] = useState<IcAction | null>(null);
  const [note, setNote] = useState("");
  const [actionTaken, setActionTaken] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const act = useMutation({
    mutationFn: (body: Parameters<typeof icApi.act>[1]) => icApi.act(Number(id), body),
    onSuccess: () => {
      toast({ title: "تم حفظ الإجراء" });
      setDlg(null); setNote(""); setActionTaken(""); setReviewerId("");
      qc.invalidateQueries({ queryKey: ["ic", cid] });
    },
    onError: (e: any) => toast({ title: "تعذر تنفيذ الإجراء", description: e.message, variant: "destructive" }),
  });
  if (q.isLoading) return <RowsSkeleton n={6} />;
  if (q.isError) return <ErrorBlock e={q.error} retry={() => q.refetch()} />;
  const c = q.data!.case;
  const history = q.data!.history ?? [];
  const evidence = q.data!.evidence;
  const closed = c.status === "resolved" || c.status === "ignored";
  const needsReason = dlg === "ignore" || dlg === "reopen" || dlg === "note";
  const submit = () => {
    if (!dlg) return;
    if (needsReason && !note.trim()) { toast({ title: "السبب مطلوب", variant: "destructive" }); return; }
    if (dlg === "assign" && !reviewerId) { toast({ title: "اختر المراجع", variant: "destructive" }); return; }
    if (dlg === "resolve" && !actionTaken.trim()) { toast({ title: "اذكر الإجراء المتخذ", variant: "destructive" }); return; }
    act.mutate({
      action: dlg, note: note.trim() || undefined,
      reviewerId: dlg === "assign" ? Number(reviewerId) : undefined,
      actionTaken: dlg === "resolve" ? actionTaken.trim() : undefined,
    });
  };
  const docLink = c.documentUrl?.startsWith("/") && !c.documentUrl.startsWith("//") && !c.documentUrl.includes("\\") ? c.documentUrl : null;
  const age = ageDays(c);
  const fields: [string, React.ReactNode][] = [
    ["القاعدة", <span className="font-mono text-[12px]">{c.ruleKey}</span>],
    ["نوع الرقابة", c.category ?? "—"], ["مصدر العملية", c.source ?? "—"],
    ["المستند", `${c.documentType ?? "—"} ${c.documentNumber ?? ""}`],
    ["الفرع", lookups.branchName(c.branchId)], ["المشروع", c.projectId ?? "—"],
    ["العميل", c.customerId ?? "—"], ["المورد", c.supplierId ?? "—"],
    ["المنفذ", lookups.userName(c.userId)], ["المعتمد", c.approverId ? lookups.userName(c.approverId) : "—"],
    ["تاريخ العملية", fmtDate(c.occurredAt)], ["تاريخ التسجيل", fmtDate(c.createdAt)],
    ["المراجع المسؤول", c.reviewerId ? lookups.userName(c.reviewerId) : "غير مسند"],
    ["تاريخ المعالجة", fmtDate(c.resolvedAt)], ["الإجراء المتخذ", c.actionTaken ?? "—"],
  ];
  return (
    <div className="space-y-5">
      <Link href="/internal-control/cases" className="ic-noprint inline-flex items-center gap-1 text-xs text-[hsl(196_60%_28%)]"><ChevronRight className="h-3.5 w-3.5" /> العودة للحالات</Link>
      <div className="bg-white/90 border border-[hsl(200_20%_86%)] rounded-lg overflow-hidden">
        <div className={`h-1 ${SEV_BAR[c.severity]}`} />
        <div className="p-5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap"><span className="font-mono text-xs text-muted-foreground">حالة #{c.id}</span><SevChip s={c.severity} /><StatusChip s={c.status} />
              <span className={`text-[11px] px-2 py-0.5 rounded border ${!closed && age > 7 ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-stone-50 border-stone-200 text-stone-600"}`}>العمر {age} يوم</span></div>
            <h2 className="text-xl font-bold mt-2">{c.description || c.ruleKey}</h2>
            {c.reason && <p className="text-sm text-[hsl(205_12%_40%)] mt-1">سبب التنبيه: {c.reason}</p>}
          </div>
          <div className="ic-noprint flex flex-wrap gap-2">
            {docLink && (docLink.startsWith("/")
              ? <Link href={docLink} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm bg-white hover:bg-muted"><ExternalLink className="h-3.5 w-3.5" /> المستند الأصلي</Link>
              : <a href={docLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm bg-white hover:bg-muted"><ExternalLink className="h-3.5 w-3.5" /> المستند الأصلي</a>)}
            <Button size="sm" variant="outline" className="h-9 gap-1.5" onClick={() => window.print()}><Printer className="h-3.5 w-3.5" /> طباعة</Button>
          </div>
        </div>
        <div className="ic-noprint px-5 pb-4 flex flex-wrap gap-2">
          {canReview && c.status === "open" && <Button size="sm" onClick={() => setDlg("review")} className="bg-[hsl(196_60%_28%)] hover:bg-[hsl(196_60%_22%)]">بدء المراجعة</Button>}
          {canReview && !closed && <Button size="sm" variant="outline" onClick={() => setDlg("assign")}>إسناد</Button>}
          {canReview && <Button size="sm" variant="outline" onClick={() => setDlg("note")}>إضافة ملاحظة</Button>}
          {canReview && !closed && <Button size="sm" variant="outline" className="border-emerald-300 text-emerald-800" onClick={() => setDlg("resolve")}>تمت المعالجة</Button>}
          {canIgnore && !closed && <Button size="sm" variant="outline" className="border-stone-300 text-stone-700" onClick={() => setDlg("ignore")}>تجاهل</Button>}
          {canReopen && closed && <Button size="sm" variant="outline" onClick={() => setDlg("reopen")}>إعادة فتح</Button>}
          {!canReview && !canIgnore && !canReopen && <span className="text-xs text-muted-foreground">عرض فقط — لا تملك صلاحيات إجراء على الحالات.</span>}
        </div>
      </div>
      <div className="grid lg:grid-cols-[1fr_1fr] gap-5">
        <section className="bg-white/85 border border-[hsl(200_20%_86%)] rounded-lg p-5">
          <h3 className="font-semibold text-sm mb-3">بيانات الحالة</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
            {fields.map(([k, v]) => (<Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></Fragment>))}
          </dl>
          {c.reviewerNotes && <div className="mt-4 p-3 rounded bg-[hsl(40_40%_95%)] text-[13px] border border-[hsl(40_30%_86%)]"><div className="text-[11px] text-muted-foreground mb-1">ملاحظات المراجع</div>{c.reviewerNotes}</div>}
        </section>
        <section className="bg-white/85 border border-[hsl(200_20%_86%)] rounded-lg p-5">
          <h3 className="font-semibold text-sm mb-1">الأدلة الملتقطة</h3>
          <p className="text-[11px] text-muted-foreground mb-3">قيم فعلية التُقطت من المصدر وقت التسجيل. لا يتم توليد قيم قبل/بعد غير موجودة.</p>
          {!evidence || Object.keys(evidence).length === 0 ? (
            <div className="p-4 rounded border border-dashed text-[13px] text-muted-foreground">لا توجد أدلة تدقيق ملتقطة لهذه الحالة — سجل التدقيق للمصدر غير متاح.</div>
          ) : <EvidenceTable data={evidence} />}
        </section>
      </div>
      <section className="bg-white/85 border border-[hsl(200_20%_86%)] rounded-lg p-5">
        <h3 className="font-semibold text-sm mb-3">سجل الحالة</h3>
        {history.length === 0 ? <p className="text-[13px] text-muted-foreground">لا توجد إجراءات مسجلة بعد.</p> : (
          <ol className="relative border-s border-[hsl(200_20%_84%)] ms-2 space-y-4">
            {history.map(h => (
              <li key={h.id} className="ms-4">
                <span className="absolute -start-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-[hsl(196_60%_30%)]" />
                <div className="text-[13px]"><b>{ACTION_LABEL[h.action] ?? h.action}</b> · {lookups.userName(h.userId)}
                  {h.fromStatus && h.toStatus && h.fromStatus !== h.toStatus && <span className="text-muted-foreground"> · {STATUS_LABEL[h.fromStatus as IcStatus] ?? h.fromStatus} ← {STATUS_LABEL[h.toStatus as IcStatus] ?? h.toStatus}</span>}</div>
                <div className="text-[11px] text-muted-foreground">{fmtDate(h.createdAt)}</div>
                {h.note && <p className="text-[13px] mt-1 bg-[hsl(40_30%_97%)] rounded px-2 py-1">{historyNote(h.note, lookups.userName)}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>
      <Dialog open={!!dlg} onOpenChange={o => !o && setDlg(null)}>
        <DialogContent dir="rtl" className="max-w-md">
          <DialogHeader><DialogTitle>{dlg ? ACTION_LABEL[dlg] : ""} — حالة #{c.id}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {dlg === "assign" && (
              <label className="text-xs flex flex-col gap-1">المراجع المسؤول
                <select className={sel} value={reviewerId} onChange={e => setReviewerId(e.target.value)}>
                  <option value="">اختر مستخدمًا</option>
                  {lookups.users.filter((u: any) => u.canReview && (u.viewAllBranches || (c.branchId != null && u.branchIds.includes(c.branchId)))).map((u: any) => <option key={u.id} value={u.id}>{u.fullName || u.name || u.username}</option>)}
                </select>
              </label>
            )}
            {dlg === "resolve" && (
              <label className="text-xs flex flex-col gap-1">الإجراء المتخذ (مطلوب)<Input value={actionTaken} onChange={e => setActionTaken(e.target.value)} placeholder="مثال: تمت مطابقة المستند مع الاعتماد الورقي" /></label>
            )}
            <label className="text-xs flex flex-col gap-1">
              {dlg === "ignore" ? "سبب التجاهل (مطلوب)" : dlg === "reopen" ? "سبب إعادة الفتح (مطلوب)" : dlg === "note" ? "الملاحظة (مطلوبة)" : "ملاحظة (اختياري)"}
              <Textarea rows={4} value={note} onChange={e => setNote(e.target.value)} />
            </label>
            <p className="text-[11px] text-muted-foreground">هذا الإجراء يغير حالة المراجعة فقط ولا يعدّل المستند المالي.</p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setDlg(null)}>إلغاء</Button>
            <Button onClick={submit} disabled={act.isPending}>{act.isPending ? "جارٍ الحفظ..." : "تأكيد"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EvidenceTable({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="rounded border border-[hsl(200_20%_88%)] overflow-hidden ic-rule">
      <table className="w-full text-[12.5px]">
        <tbody className="divide-y divide-[hsl(200_20%_90%)]">
          {Object.entries(data).map(([k, v]) => (
            <tr key={k}>
              <td className="px-3 py-1.5 font-mono text-[11.5px] text-[hsl(205_20%_35%)] bg-white/70 align-top w-1/3">{k}</td>
              <td className="px-3 py-1.5 bg-white/70 break-all">
                {v === null || v === undefined ? <span className="text-muted-foreground">غير متاح</span>
                  : typeof v === "object" ? <pre className="whitespace-pre-wrap text-[11.5px] font-mono">{JSON.stringify(v, null, 2)}</pre>
                  : String(v)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Log ───────────────────────────────────────────────────────────────────
function LogView({ cid, lookups }: { cid?: number; lookups: ReturnType<typeof useLookups> }) {
  const [f, setF] = usePersistedFilters(cid, "log");
  const eff = { ...f, page: f.page ?? 1, limit: f.limit ?? 25 };
  const q = useQuery({ queryKey: ["ic", cid, "log", eff], queryFn: () => icApi.log(eff), enabled: !!cid });
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3"><span className="h-9 w-9 rounded-md bg-[hsl(196_45%_92%)] text-[hsl(196_60%_26%)] grid place-items-center"><History className="h-4 w-4" /></span>
        <div><h2 className="font-bold text-lg">سجل الرقابة الداخلية</h2><p className="text-xs text-muted-foreground">كل إجراء مراجعة تم على الحالات، بترتيب زمني</p></div></div>
      <FilterBar f={f} setF={setF} lookups={lookups}
        extra={<Button size="sm" variant="outline" className="gap-1.5 h-9" onClick={() => window.print()}><Printer className="h-3.5 w-3.5" /> طباعة</Button>} />
      <section className="bg-white/85 border border-[hsl(200_20%_86%)] rounded-lg overflow-hidden">
        {q.isLoading ? <RowsSkeleton n={8} /> : q.isError ? <ErrorBlock e={q.error} retry={() => q.refetch()} /> : (q.data?.items.length ?? 0) === 0 ? (
          <EmptyBlock title="السجل فارغ" text="لم يتم تنفيذ أي إجراء مراجعة ضمن هذه الفلاتر." />
        ) : (
          <div className="overflow-x-auto"><table className="w-full text-[13px]">
            <thead className="bg-[hsl(200_25%_95%)] text-[11px] text-[hsl(205_20%_35%)]"><tr>{["التاريخ", "الحالة", "الإجراء", "المستخدم", "من", "إلى", "الملاحظة"].map(h => <th key={h} className="text-start px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-[hsl(200_20%_92%)]">
              {q.data!.items.map(h => (
                <tr key={h.id}>
                  <td className="px-3 py-2 whitespace-nowrap text-[12px]">{fmtDate(h.createdAt)}</td>
                  <td className="px-3 py-2">{h.caseId == null ? "إعدادات القواعد" : <Link href={`/internal-control/cases/${h.caseId}`} className="font-mono text-[hsl(196_60%_28%)]">#{h.caseId}</Link>}</td>
                  <td className="px-3 py-2">{ACTION_LABEL[h.action] ?? h.action}</td>
                  <td className="px-3 py-2">{lookups.userName(h.userId)}</td>
                  <td className="px-3 py-2">{h.fromStatus ? STATUS_LABEL[h.fromStatus as IcStatus] ?? h.fromStatus : "—"}</td>
                  <td className="px-3 py-2">{h.toStatus ? STATUS_LABEL[h.toStatus as IcStatus] ?? h.toStatus : "—"}</td>
                  <td className="px-3 py-2 max-w-[320px]">{historyNote(h.note, lookups.userName)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {q.data && <Pager page={eff.page} limit={eff.limit} total={q.data.total} onPage={p => setF({ ...f, page: p })} />}
      </section>
    </div>
  );
}

// ─── Rules ─────────────────────────────────────────────────────────────────
function RulesView({ cid, lookups }: { cid?: number; lookups: ReturnType<typeof useLookups> }) {
  const canEdit = usePermission("internal_control_rules", "edit");
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["ic", cid, "rules"], queryFn: icApi.rules, enabled: !!cid });
  const scan = useMutation({
    mutationFn: icApi.scan,
    onSuccess: r => { toast({ title: "اكتمل الفحص", description: `تم تقييم ${r.evaluated ?? 0} وإنشاء ${r.created ?? 0} حالة` }); qc.invalidateQueries({ queryKey: ["ic", cid] }); },
    onError: (e: any) => toast({ title: "تعذر الفحص", description: e.message, variant: "destructive" }),
  });
  const items = q.data?.items ?? [];
  const supported = items.filter(r => r.supported);
  const unsupported = items.filter(r => !r.supported);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3"><span className="h-9 w-9 rounded-md bg-[hsl(196_45%_92%)] text-[hsl(196_60%_26%)] grid place-items-center"><Settings2 className="h-4 w-4" /></span>
          <div><h2 className="font-bold text-lg">قواعد الرقابة</h2><p className="text-xs text-muted-foreground">الحدود، الاستثناءات، الخطورة والتفعيل. الخطورة تتحدد بالقاعدة وليس عشوائيًا.</p></div></div>
        {canEdit && <Button size="sm" variant="outline" className="gap-1.5" disabled={scan.isPending} onClick={() => scan.mutate()}><RefreshCw className={`h-3.5 w-3.5 ${scan.isPending ? "animate-spin" : ""}`} /> تشغيل الفحص الآن</Button>}
      </div>
      {q.isLoading ? <RowsSkeleton n={6} /> : q.isError ? <ErrorBlock e={q.error} retry={() => q.refetch()} /> : items.length === 0 ? (
        <EmptyBlock title="لا توجد قواعد" text="لم يُرجع الخادم أي قاعدة رقابة." />
      ) : (
        <>
          <div className="space-y-2">{supported.map(r => <RuleRow key={r.key} r={r} cid={cid} canEdit={canEdit} lookups={lookups} />)}</div>
          {unsupported.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mt-4 mb-2 text-stone-700">قواعد غير مدعومة حاليًا</h3>
              <p className="text-xs text-muted-foreground mb-2">لا تتوفر لها بيانات أو سجلات تدقيق في النظام، لذلك لا تنشئ حالات مهما كانت إعداداتها.</p>
              <div className="space-y-2">{unsupported.map(r => (
                <div key={r.key} className="border border-dashed border-stone-300 rounded-lg p-3 bg-stone-50/70 flex flex-wrap items-center justify-between gap-2">
                  <div><div className="text-sm font-medium text-stone-700">{r.name}</div><div className="text-[11px] font-mono text-stone-500">{r.key}</div></div>
                  <span className="text-xs text-stone-600">{r.unsupportedReason ?? "غير مدعوم"}</span>
                </div>
              ))}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function RuleRow({ r, cid, canEdit, lookups }: { r: IcRule; cid?: number; canEdit: boolean; lookups: ReturnType<typeof useLookups> }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [sev, setSev] = useState<IcSeverity>(r.severity);
  const [thr, setThr] = useState(r.threshold == null ? "" : String(r.threshold));
  const [users, setUsers] = useState<number[]>(r.excludedUserIds ?? []);
  const [roles, setRoles] = useState((r.excludedRoles ?? []).join("، "));
  useEffect(() => {
    setSev(r.severity); setThr(r.threshold == null ? "" : String(r.threshold));
    setUsers(r.excludedUserIds ?? []); setRoles((r.excludedRoles ?? []).join("، "));
  }, [r]);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof icApi.saveRule>[1]) => icApi.saveRule(r.key, body),
    onSuccess: () => { toast({ title: "تم حفظ القاعدة" }); qc.invalidateQueries({ queryKey: ["ic", cid] }); },
    onError: (e: any) => toast({ title: "تعذر حفظ القاعدة", description: e.message, variant: "destructive" }),
  });
  const dirty = sev !== r.severity || thr !== (r.threshold == null ? "" : String(r.threshold))
    || JSON.stringify(users) !== JSON.stringify(r.excludedUserIds ?? []) || roles !== (r.excludedRoles ?? []).join("، ");
  const persist = () => {
    const t = thr.trim() === "" ? null : Number(thr);
    if (t !== null && !Number.isFinite(t)) { toast({ title: "قيمة الحد غير صحيحة", variant: "destructive" }); return; }
    save.mutate({
      severity: sev, threshold: t, excludedUserIds: users,
      excludedRoles: roles.split(/[،,]/).map(s => s.trim()).filter(Boolean),
    });
  };
  return (
    <div className={`border rounded-lg bg-white/85 p-4 ${r.enabled ? "border-[hsl(200_20%_84%)]" : "border-[hsl(200_20%_90%)] opacity-80"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><span className="font-medium text-sm">{r.name}</span><SevChip s={r.severity} /></div>
          <div className="text-[11px] text-muted-foreground font-mono mt-0.5">{r.key} · {r.module ?? "—"} · {r.category ?? "—"}</div>
        </div>
        <label className="flex items-center gap-2 text-xs">{r.enabled ? "مفعلة" : "معطلة"}
          <Switch checked={r.enabled} disabled={!canEdit || save.isPending} onCheckedChange={v => save.mutate({ enabled: v })} /></label>
      </div>
      <div className="mt-3 grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="text-[11px] text-muted-foreground flex flex-col gap-1">الخطورة
          <select className={sel} disabled={!canEdit} value={sev} onChange={e => setSev(e.target.value as IcSeverity)}>
            {(Object.keys(SEVERITY_LABEL) as IcSeverity[]).map(s => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
          </select></label>
        <label className="text-[11px] text-muted-foreground flex flex-col gap-1">الحد {r.thresholdUnit ? `(${r.thresholdUnit})` : ""}
          <Input className="h-9" disabled={!canEdit} inputMode="decimal" value={thr} onChange={e => setThr(e.target.value)} placeholder="بدون حد" /></label>
        <label className="text-[11px] text-muted-foreground flex flex-col gap-1">استثناء مستخدمين
          <select className={sel} disabled={!canEdit} value="" onChange={e => { const v = Number(e.target.value); if (v && !users.includes(v)) setUsers([...users, v]); }}>
            <option value="">إضافة مستخدم...</option>
            {lookups.users.filter((u: any) => !users.includes(u.id)).map((u: any) => <option key={u.id} value={u.id}>{u.fullName || u.name || u.username}</option>)}
          </select>
          <div className="flex flex-wrap gap-1">{users.map(id => (
            <span key={id} className="inline-flex items-center gap-1 text-[11px] bg-[hsl(196_45%_94%)] rounded px-1.5 py-0.5">{lookups.userName(id)}
              {canEdit && <button type="button" onClick={() => setUsers(users.filter(x => x !== id))}><X className="h-3 w-3" /></button>}</span>
          ))}</div>
        </label>
        <label className="text-[11px] text-muted-foreground flex flex-col gap-1">استثناء أدوار (مفصولة بفاصلة)
          <Input className="h-9" disabled={!canEdit} value={roles} onChange={e => setRoles(e.target.value)} placeholder="admin، accountant" /></label>
      </div>
      {canEdit && dirty && (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => { setSev(r.severity); setThr(r.threshold == null ? "" : String(r.threshold)); setUsers(r.excludedUserIds ?? []); setRoles((r.excludedRoles ?? []).join("، ")); }}>تراجع</Button>
          <Button size="sm" disabled={save.isPending} onClick={persist}>حفظ التغييرات</Button>
        </div>
      )}
    </div>
  );
}

// ─── Primitives ────────────────────────────────────────────────────────────
function historyNote(note: string | null, name: (id?: number | null) => string): string {
  if (!note) return "";
  try {
    const value = JSON.parse(note);
    if (!value || typeof value !== "object") return note;
    return [value.note, value.actionTaken && `الإجراء: ${value.actionTaken}`,
      value.reviewerId && `المراجع: ${name(value.reviewerId)}`,
      value.previousReviewerId && `المراجع السابق: ${name(value.previousReviewerId)}`,
      value.key && `القاعدة: ${value.key}`,
      value.config && JSON.stringify(value.config)].filter(Boolean).join(" · ");
  } catch { return note; }
}
function SevChip({ s }: { s: IcSeverity }) {
  return <span className={`text-[11px] px-2 py-0.5 rounded border whitespace-nowrap ${SEV_TONE[s] ?? SEV_TONE.low}`}>{SEVERITY_LABEL[s] ?? s}</span>;
}
function StatusChip({ s }: { s: IcStatus }) {
  return <span className={`text-[11px] px-2 py-0.5 rounded border whitespace-nowrap ${STATUS_TONE[s] ?? STATUS_TONE.open}`}>{STATUS_LABEL[s] ?? s}</span>;
}
function RowsSkeleton({ n }: { n: number }) {
  return <div className="p-4 space-y-3">{Array.from({ length: n }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>;
}
function EmptyBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="py-14 px-6 text-center">
      <div className="mx-auto h-12 w-12 rounded-full border-2 border-dashed border-[hsl(196_30%_75%)] grid place-items-center text-[hsl(196_40%_40%)]"><ShieldCheck className="h-5 w-5" /></div>
      <h3 className="mt-3 font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">{text}</p>
    </div>
  );
}
function ErrorBlock({ e, retry }: { e: unknown; retry: () => void }) {
  const status = (e as any)?.status;
  return (
    <div className="p-6 text-center">
      <p className="font-semibold text-rose-800">{status === 403 ? "غير مصرح" : status === 404 ? "غير موجود أو خارج نطاقك" : "تعذر تحميل البيانات"}</p>
      <p className="text-xs text-muted-foreground mt-1">{(e as any)?.message}</p>
      {status !== 403 && status !== 404 && <Button size="sm" variant="outline" className="mt-3" onClick={retry}>إعادة المحاولة</Button>}
    </div>
  );
}
