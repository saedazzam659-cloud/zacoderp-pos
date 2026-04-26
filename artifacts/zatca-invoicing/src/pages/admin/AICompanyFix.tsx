import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import MaintenanceTool from "@/components/admin/MaintenanceTool";
import {
  Sparkles, Search, AlertTriangle, AlertCircle, Info, CheckCircle2, Loader2, Send,
  Network, RefreshCw, Server, Database, LayoutGrid, MonitorSmartphone, ChevronDown, ChevronRight,
  Wrench, FileText, Link2, Unlink, ListOrdered, UserX, PackageX, History,
  CalendarClock, Play, Mail, Download,
  // Toolbox expansion (F): inventory / accounting / logs categories.
  TrendingDown, Scale, Calculator, ScrollText, Trash2, Boxes, BookOpen, ClipboardList,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type CheckResult = {
  key: string; label: string; severity: "high" | "medium" | "low";
  count: number; samples: any[];
};

type SystemTree = {
  generatedAt: string;
  scopeFilter: "superadmin" | "tenant" | "shared" | "all";
  apiModules:       Array<{ mount: string; scope: string; endpoints: Array<{ method: string; path: string; scope: string }> }>;
  dbDomains:        Array<{ table: string; rowCountApprox: number | null }>;
  screens:          Array<{ file: string; route: string; scope: string; category: string }>;
  dashboardWidgets: Array<{ title: string; kind: "kpi" | "card" | "section"; source: string }>;
  totals: { apiModules: number; apiEndpoints: number; dbTables: number; screens: number; dashboardWidgets: number };
};

const SEV_STYLE: Record<string, { bg: string; border: string; text: string; icon: any; label: string }> = {
  high:   { bg: "bg-red-50",    border: "border-red-200",    text: "text-red-800",    icon: AlertCircle,    label: "خطورة عالية" },
  medium: { bg: "bg-amber-50",  border: "border-amber-200",  text: "text-amber-900",  icon: AlertTriangle,  label: "خطورة متوسطة" },
  low:    { bg: "bg-blue-50",   border: "border-blue-200",   text: "text-blue-900",   icon: Info,           label: "خطورة منخفضة" },
};

// Friendly Arabic labels for the values stored in maintenance_schedule.last_email_status.
// Mirrors the strings the backend returns in dispatchCriticalDigest.
function emailStatusLabelAr(status: string | null): string {
  switch (status) {
    case "ok":             return "تم الإرسال";
    case "no_critical":    return "لا توجد نتائج حرجة";
    case "no_recipients":  return "لا يوجد مستلمون";
    case "no_transport":   return "البريد غير مهيأ";
    case "skipped":        return "متخطّاة";
    case "snoozed":        return "متخطّاة (مكتومة)";
    case "rate_limited":   return "متخطّاة (ضمن فترة التهدئة)";
    case "failed":         return "فشل الإرسال";
    default:               return status ?? "—";
  }
}

// Friendly Arabic translation of the machine-readable `reason` token written
// alongside each email-runs row by recordEmailOutcome. Lets SuperAdmins read
// the audit trail without parsing tokens like
// "cooldown_active_24h_signature_unchanged".
function emailReasonLabelAr(reason: string | null): string {
  if (!reason) return "—";
  // Cooldown reasons embed the configured hours, e.g. cooldown_active_24h_signature_unchanged.
  const cooldownMatch = reason.match(/^cooldown_active_(\d+)h_signature_unchanged$/);
  if (cooldownMatch) {
    return `ضمن فترة التهدئة (${cooldownMatch[1]} ساعة) — القائمة الحرجة لم تتغيّر`;
  }
  switch (reason) {
    case "digest_sent":                   return "أُرسل التنبيه";
    case "test_sent":                     return "بريد تجريبي أُرسل";
    case "no_alerting_findings":          return "لا توجد نتائج تستدعي إشعاراً";
    // Legacy label — kept so historical schedule rows still localise. Newer
    // dispatches use `no_alerting_findings` to reflect that warn/error
    // sweeps are now also considered before short-circuiting.
    case "no_critical_findings":          return "لا توجد نتائج حرجة";
    case "no_superadmin_email_configured":return "لا يوجد سوبر أدمن لديه بريد مفعّل";
    case "email_transport_unconfigured":  return "إعدادات البريد غير مهيأة (SMTP/Outlook)";
    case "alerts_snoozed":                return "التنبيهات مكتومة حالياً";
    case "send_failed":                   return "تعذّر الإرسال";
    case "cooldown_cleared":              return "تم مسح فترة التهدئة يدوياً";
    default:                              return reason;
  }
}

// Friendly Arabic labels for the `action` and `entity_type` values written to
// `audit_log` by maintenance code paths. Used by the history filter dropdowns
// (task #47) — the dropdown options themselves come from the live audit log,
// these maps just decorate known values with a friendly label. Anything not
// listed falls back to the raw machine value, which is still useful (the new
// option appears in the dropdown the moment it is logged for the first time).
const HISTORY_ACTION_LABELS_AR: Record<string, string> = {
  fix:              "إصلاح",
  export_csv:       "تصدير CSV",
  run_now_one:      "تشغيل لشركة",
  run_now_all:      "تشغيل للكل",
  edit_schedule:    "تعديل الجدولة",
  send_test_email:  "بريد تجريبي",
  edit_retention:   "تعديل مدة الاحتفاظ",
};
const HISTORY_ENTITY_TYPE_LABELS_AR: Record<string, string> = {
  journal_pending:                 "قيود معلّقة",
  broken_refs:                     "مراجع مكسورة",
  unlinked_accounts:               "حسابات غير مربوطة",
  sequence_gaps:                   "فجوات التسلسل",
  dormant_users:                   "مستخدمون خاملون",
  negative_stock:                  "رصيد سالب",
  stock_balance_drift:             "انحراف رصيد المخزون",
  unbalanced_entries:              "قيود غير متوازنة",
  old_audit_logs:                  "سجلات تدقيق قديمة",
  old_maintenance_runs:            "عمليات صيانة قديمة",
  old_maintenance_email_runs:      "سجل بريد الصيانة القديم",
  old_report_email_runs:           "سجل بريد التقارير القديم",
  maintenance_history:             "سجل الصيانة",
  maintenance_schedule:            "جدولة الصيانة",
  maintenance_runs:                "تشغيل الصيانة",
  maintenance_retention:           "مدة الاحتفاظ بالسجلات",
};
function historyActionLabelAr(value: string): string {
  return HISTORY_ACTION_LABELS_AR[value] ?? value;
}
function historyEntityTypeLabelAr(value: string): string {
  return HISTORY_ENTITY_TYPE_LABELS_AR[value] ?? value;
}

function renderMarkdown(md: string) {
  // Lightweight markdown: headings, bold, lists. No code blocks needed.
  const html = md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, '<h3 class="font-bold text-base mt-3 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2 class="font-bold text-lg mt-4 mb-2">$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1 class="font-bold text-xl mt-4 mb-2">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*\d+\.\s+(.+)$/gm, '<li class="ml-5 list-decimal">$1</li>')
    .replace(/^\s*[-*]\s+(.+)$/gm,  '<li class="ml-5 list-disc">$1</li>')
    .replace(/\n\n/g, '<br/><br/>');
  return { __html: html };
}

export default function AICompanyFix() {
  const { token, user } = useAuth();
  const { toast } = useToast();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const isSuperAdmin = user?.role === "superadmin";

  const [companyId, setCompanyId] = useState<string>("");
  const [aiSummary, setAiSummary] = useState<string>("");
  const [sysSummary, setSysSummary] = useState<string>("");
  const [openCat, setOpenCat] = useState<string | null>("apiModules");

  // Auto-discovered system tree — fetched eagerly when a SuperAdmin opens the
  // page so they immediately see the full SuperAdmin scope (modules, screens,
  // tables, dashboard widgets) without any manual registration.
  const sysTreeQ = useQuery<SystemTree>({
    queryKey: ["ai-fix-system-tree", "superadmin"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/ai-fix/system-tree?scope=superadmin`, { headers });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل اكتشاف هيكل النظام");
      return r.json();
    },
    enabled: isSuperAdmin,
    staleTime: 5 * 60 * 1000,
  });
  const sysSummarizeMut = useMutation({
    mutationFn: async () => {
      setSysSummary("");
      if (!sysTreeQ.data) throw new Error("لم يتم تحميل هيكل النظام بعد");
      const r = await fetch(`${API}/api/admin/ai-fix/system-summarize`, {
        method: "POST", headers,
        body: JSON.stringify({ tree: sysTreeQ.data }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل التحليل");
      return r.json() as Promise<{ summary: string }>;
    },
    onSuccess: (d) => setSysSummary(d.summary || ""),
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const { data: companies = [] } = useQuery({
    queryKey: ["admin-companies"],
    queryFn: async () => (await fetch(`${API}/api/admin/companies`, { headers })).json(),
  });

  const { data: diag, refetch, isFetching } = useQuery<{ checks: CheckResult[]; totalIssues: number }>({
    queryKey: ["ai-fix-diagnose", companyId],
    queryFn: async () => (await fetch(`${API}/api/admin/ai-fix/diagnose?companyId=${companyId}`, { headers })).json(),
    enabled: false,
  });

  const notifyMut = useMutation({
    mutationFn: async (checkKey: string) => {
      const r = await fetch(`${API}/api/admin/ai-fix/notify`, {
        method: "POST", headers,
        body: JSON.stringify({ companyId: Number(companyId), checkKey }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل إرسال التنبيه");
      return r.json() as Promise<{ ok: boolean; recipients: number }>;
    },
    onSuccess: (data) => toast({
      title: "تم إرسال التنبيه",
      description: `سيظهر التنبيه لعدد ${data.recipients} مستخدم(ين) في هذه الشركة.`,
    }),
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });
  const [notifyingKey, setNotifyingKey] = useState<string | null>(null);

  const summarizeMut = useMutation({
    mutationFn: async () => {
      setAiSummary("");
      const r = await fetch(`${API}/api/admin/ai-fix/summarize`, {
        method: "POST", headers,
        body: JSON.stringify({ companyId: Number(companyId), checks: diag?.checks ?? [] }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل التلخيص");
      return r.json();
    },
    onSuccess: (data) => setAiSummary(data.summary || ""),
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const handleScan = async () => {
    setAiSummary("");
    const res = await refetch();
    // After scan completes, trigger AI summary automatically
    if (res.data) summarizeMut.mutate();
  };

  const checks = diag?.checks ?? [];
  const totalIssues = diag?.totalIssues ?? 0;

  // Helpers for the system-tree section.
  const tree   = sysTreeQ.data;
  const totals = tree?.totals;
  const cats: Array<{ key: string; label: string; icon: any; count: number; render: () => any }> = tree ? [
    {
      key: "apiModules", label: "الموديولات (Backend APIs)", icon: Server, count: totals!.apiModules,
      render: () => (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {tree.apiModules.map((m, i) => (
            <div key={`${m.mount}#${i}`} className="border rounded p-2 text-xs bg-muted/30">
              <div className="flex items-center justify-between gap-2">
                <code className="font-mono text-violet-700">{m.mount || "/"}</code>
                <span className="text-muted-foreground tabular-nums">{m.endpoints.length}</span>
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                {Array.from(new Set(m.endpoints.flatMap(e => e.method.split("|")))).join(" · ")}
              </div>
            </div>
          ))}
        </div>
      ),
    },
    {
      key: "screens", label: "الشاشات (Frontend Pages)", icon: MonitorSmartphone, count: totals!.screens,
      render: () => {
        const byCat = new Map<string, typeof tree.screens>();
        for (const s of tree.screens) {
          const k = s.category || "general";
          if (!byCat.has(k)) byCat.set(k, []);
          byCat.get(k)!.push(s);
        }
        return (
          <div className="space-y-2">
            {Array.from(byCat.entries()).map(([cat, items]) => (
              <div key={cat} className="border rounded p-2 bg-muted/30">
                <div className="text-xs font-semibold mb-1.5 flex items-center justify-between">
                  <span>{cat}</span>
                  <span className="text-muted-foreground tabular-nums">{items.length}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {items.map(s => (
                    <code key={s.file} className="text-[11px] bg-background border rounded px-1.5 py-0.5 font-mono">
                      {s.file}
                    </code>
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      },
    },
    {
      key: "dashboardWidgets", label: "عناصر لوحة تحكم SuperAdmin", icon: LayoutGrid, count: totals!.dashboardWidgets,
      render: () => (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
          {tree.dashboardWidgets.map((w, i) => (
            <div key={i} className="text-xs border rounded px-2 py-1.5 bg-muted/30 flex items-center justify-between gap-2">
              <span className="truncate">{w.title}</span>
              <span className="text-[10px] text-muted-foreground shrink-0">{w.kind} · {w.source}</span>
            </div>
          ))}
        </div>
      ),
    },
    {
      key: "dbDomains", label: "جداول قاعدة البيانات", icon: Database, count: totals!.dbTables,
      render: () => (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
          {tree.dbDomains.map(d => (
            <div key={d.table} className="text-[11px] border rounded px-2 py-1 bg-muted/30 flex items-center justify-between gap-1">
              <code className="font-mono truncate">{d.table}</code>
              <span className="text-muted-foreground tabular-nums shrink-0">
                {d.rowCountApprox == null ? "—" : Intl.NumberFormat("ar").format(d.rowCountApprox)}
              </span>
            </div>
          ))}
        </div>
      ),
    },
  ] : [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-violet-600" />
          إصلاح مشاكل الشركات بالذكاء الاصطناعي
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          فحص تشخيصي شامل لبيانات الشركة (محاسبة، مخزون، فواتير، أصناف) ثم ملخص وتوصيات بالعربية يكتبها الذكاء الاصطناعي.
          هذه الصفحة <strong>للقراءة فقط</strong> ولا تنفذ أي تعديل تلقائي.
        </p>
      </div>

      {/* SuperAdmin-only: auto-discovered system tree (Modules + Screens +
          Dashboard Widgets + DB Domains). Updates itself with no code changes
          whenever a new router, page, table, or widget is added. */}
      {isSuperAdmin && (
        <Card className="border-violet-200">
          <CardHeader className="pb-3 bg-violet-50/40">
            <CardTitle className="text-base flex items-center justify-between gap-2 text-violet-900">
              <span className="flex items-center gap-2">
                <Network className="h-4 w-4" />
                هيكل النظام (اكتشاف تلقائي · نطاق المشرف العام)
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm" variant="ghost"
                  className="h-7 text-xs gap-1"
                  onClick={() => sysTreeQ.refetch()}
                  disabled={sysTreeQ.isFetching}
                  title="إعادة اكتشاف الهيكل من الكود الفعلي"
                >
                  {sysTreeQ.isFetching
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <RefreshCw className="h-3 w-3" />}
                  تحديث
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs gap-1 bg-violet-600 hover:bg-violet-700"
                  disabled={!tree || sysSummarizeMut.isPending}
                  onClick={() => sysSummarizeMut.mutate()}
                  title="تحليل الهيكل المكتشف بالذكاء الاصطناعي"
                >
                  {sysSummarizeMut.isPending
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <Sparkles className="h-3 w-3" />}
                  تحليل بالذكاء الاصطناعي
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-3">
            {sysTreeQ.isLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> جارٍ اكتشاف هيكل النظام...
              </div>
            )}
            {sysTreeQ.isError && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
                {(sysTreeQ.error as any)?.message || "فشل اكتشاف هيكل النظام"}
              </div>
            )}
            {tree && (
              <>
                {/* KPI strip */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  {[
                    { l: "الموديولات",  v: totals!.apiModules,       i: Server,            c: "text-violet-700"  },
                    { l: "نقاط الـAPI", v: totals!.apiEndpoints,     i: Network,           c: "text-violet-700"  },
                    { l: "الشاشات",     v: totals!.screens,          i: MonitorSmartphone, c: "text-blue-700"    },
                    { l: "عناصر لوحة التحكم", v: totals!.dashboardWidgets, i: LayoutGrid,    c: "text-amber-700"   },
                    { l: "جداول DB",   v: totals!.dbTables,         i: Database,          c: "text-emerald-700" },
                  ].map(s => (
                    <div key={s.l} className="border rounded p-2 bg-background flex items-center gap-2">
                      <s.i className={`h-4 w-4 ${s.c} shrink-0`} />
                      <div className="min-w-0">
                        <p className="text-[11px] text-muted-foreground truncate">{s.l}</p>
                        <p className={`text-lg font-bold leading-tight ${s.c} tabular-nums`}>{s.v}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Collapsible category sections */}
                <div className="space-y-1.5">
                  {cats.map(c => {
                    const open = openCat === c.key;
                    const Chev = open ? ChevronDown : ChevronRight;
                    return (
                      <div key={c.key} className="border rounded">
                        <button
                          type="button"
                          onClick={() => setOpenCat(open ? null : c.key)}
                          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm font-medium bg-muted/40 hover:bg-muted/60 rounded-t"
                        >
                          <span className="flex items-center gap-2"><c.icon className="h-4 w-4" />{c.label}</span>
                          <span className="flex items-center gap-2 text-muted-foreground">
                            <span className="tabular-nums">{c.count}</span>
                            <Chev className="h-4 w-4" />
                          </span>
                        </button>
                        {open && <div className="p-2.5">{c.render()}</div>}
                      </div>
                    );
                  })}
                </div>

                <p className="text-[11px] text-muted-foreground italic">
                  مصدر البيانات: انعكاس على Express router stack + جداول pg_class + مسح ملفات pages/ + استخراج عناصر SuperAdmin*.tsx — لا تسجيل يدوي.
                  آخر اكتشاف: {new Date(tree.generatedAt).toLocaleString("ar")}.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* AI summary of the discovered system tree */}
      {isSuperAdmin && (sysSummarizeMut.isPending || sysSummary) && (
        <Card className="border-violet-200">
          <CardHeader className="pb-3 bg-violet-50/50">
            <CardTitle className="text-base flex items-center gap-2 text-violet-900">
              <Sparkles className="h-4 w-4" />
              تحليل النظام بالذكاء الاصطناعي
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {sysSummarizeMut.isPending ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                جارٍ توليد التحليل...
              </div>
            ) : (
              <div className="prose prose-sm max-w-none text-sm leading-7 [&_li]:my-0.5"
                   dir="rtl"
                   dangerouslySetInnerHTML={renderMarkdown(sysSummary)} />
            )}
          </CardContent>
        </Card>
      )}

      {/* Company selector — shared by maintenance toolbox and AI scanner. */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">اختر الشركة</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">الشركة</label>
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="— اختر الشركة —" /></SelectTrigger>
              <SelectContent>
                {companies.map((c: any) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.nameAr || c.nameEn || `#${c.id}`}
                    {c.status !== "active" && <span className="text-muted-foreground"> ({c.status})</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Deterministic maintenance toolbox — sits above the AI scanner. */}
      <MaintenanceSection
        companyId={companyId ? Number(companyId) : null}
        onSelectCompany={(id) => setCompanyId(String(id))}
      />

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">فحص بالذكاء الاصطناعي</CardTitle></CardHeader>
        <CardContent>
          <div className="flex justify-end">
            <Button
              onClick={handleScan}
              disabled={!companyId || isFetching || summarizeMut.isPending}
              className="gap-1.5 bg-violet-600 hover:bg-violet-700"
            >
              {(isFetching || summarizeMut.isPending) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {isFetching ? "جارٍ الفحص..." : summarizeMut.isPending ? "الذكاء الاصطناعي يحلل..." : "فحص بالذكاء الاصطناعي"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {diag && (
        <>
          {totalIssues === 0 ? (
            <Card className="border-green-200 bg-green-50/30">
              <CardContent className="pt-5 pb-4 text-center">
                <CheckCircle2 className="h-8 w-8 text-green-600 mx-auto mb-2" />
                <p className="text-green-800 font-medium">لا توجد مشاكل في بيانات هذه الشركة</p>
                <p className="text-sm text-green-700 mt-1">جميع الفحوصات الـ {checks.length} اجتازت بنجاح</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  <span>نتائج الفحص ({checks.length} فحص)</span>
                  <span className="text-sm font-normal text-muted-foreground">
                    إجمالي المشاكل: <strong className="text-red-600">{totalIssues}</strong>
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {checks
                  .slice()
                  .sort((a, b) => {
                    const order = { high: 0, medium: 1, low: 2 } as any;
                    if (a.count === 0 && b.count > 0) return 1;
                    if (b.count === 0 && a.count > 0) return -1;
                    return order[a.severity] - order[b.severity];
                  })
                  .map((c) => {
                    const sev = SEV_STYLE[c.severity];
                    const Icon = sev.icon;
                    const isOk = c.count === 0;
                    const isThisNotifying = notifyMut.isPending && notifyingKey === c.key;
                    return (
                      <div
                        key={c.key}
                        className={`flex items-center justify-between gap-3 p-3 rounded-md border ${
                          isOk ? "bg-green-50 border-green-200" : `${sev.bg} ${sev.border}`
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          {isOk
                            ? <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                            : <Icon className={`h-4 w-4 shrink-0 ${sev.text}`} />
                          }
                          <div className="min-w-0">
                            <p className={`text-sm font-medium ${isOk ? "text-green-800" : sev.text}`}>{c.label}</p>
                            {!isOk && <p className="text-xs text-muted-foreground mt-0.5">{sev.label}</p>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-sm font-bold tabular-nums ${
                            isOk ? "text-green-700" : sev.text
                          }`}>
                            {c.count}
                          </span>
                          {!isOk && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs gap-1 bg-white"
                              disabled={notifyMut.isPending}
                              onClick={() => { setNotifyingKey(c.key); notifyMut.mutate(c.key); }}
                              title="إرسال تنبيه لمدير الشركة بشرح المشكلة وحلها"
                            >
                              {isThisNotifying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                              إبلاغ المدير
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {(summarizeMut.isPending || aiSummary) && (
        <Card className="border-violet-200">
          <CardHeader className="pb-3 bg-violet-50/50">
            <CardTitle className="text-base flex items-center gap-2 text-violet-900">
              <Sparkles className="h-4 w-4" />
              ملخص الذكاء الاصطناعي
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {summarizeMut.isPending ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                جارٍ توليد الملخص والتوصيات...
              </div>
            ) : (
              <div className="prose prose-sm max-w-none text-sm leading-7 [&_li]:my-0.5"
                   dir="rtl"
                   dangerouslySetInnerHTML={renderMarkdown(aiSummary)} />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Maintenance Toolbox section + History panel ─────────────────────────────
// One-click deterministic data-integrity checkers for the SuperAdmin. Each
// card runs an independent backend probe and lets the operator inspect /
// remediate inline (no popup modals). All fix actions are audit-logged with
// `module='maintenance'` and replayed in the history panel below.
function MaintenanceSection({ companyId, onSelectCompany }: {
  companyId: number | null;
  onSelectCompany: (id: number) => void;
}) {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);   // bump after fixes
  // Optional filters for the history table + CSV export. Empty string = no
  // filter, which preserves the original behaviour (latest 50 on screen / full
  // history in the CSV).
  const [historyFrom, setHistoryFrom]             = useState<string>("");
  const [historyTo, setHistoryTo]                 = useState<string>("");
  const [historyAction, setHistoryAction]         = useState<string>("");
  const [historyEntityType, setHistoryEntityType] = useState<string>("");

  // Builds the shared `?from=&to=&action=&entityType=` suffix used by BOTH
  // the JSON view (`historyQ`) and the CSV download (`historyCsvMut`) so the
  // file always matches what's on screen.
  const historyFilterParams = (): string => {
    const parts: string[] = [];
    if (historyFrom)       parts.push(`from=${encodeURIComponent(historyFrom)}`);
    if (historyTo)         parts.push(`to=${encodeURIComponent(historyTo)}`);
    if (historyAction)     parts.push(`action=${encodeURIComponent(historyAction)}`);
    if (historyEntityType) parts.push(`entityType=${encodeURIComponent(historyEntityType)}`);
    return parts.length ? `&${parts.join("&")}` : "";
  };

  // Paged history (task #46). The page size matches the previous on-screen
  // cap (50) so admins still see the same first screenful, but a "تحميل
  // المزيد" button below the table now appends the next page in-place
  // instead of forcing a CSV download. The query key intentionally excludes
  // the offset so changing any filter naturally resets pagination via React
  // Query's normal cache-keying — `useInfiniteQuery` rebuilds page 0 from
  // scratch when the key changes.
  const HISTORY_PAGE_SIZE = 50;
  const historyQ = useInfiniteQuery({
    queryKey: [
      "maintenance-history", companyId, historyTick,
      historyFrom, historyTo, historyAction, historyEntityType,
    ],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const offset = typeof pageParam === "number" ? pageParam : 0;
      const r = await fetch(
        `${API}/api/admin/maintenance/history?companyId=${companyId}`
          + `&limit=${HISTORY_PAGE_SIZE}&offset=${offset}${historyFilterParams()}`,
        { headers },
      );
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل جلب السجل");
      return r.json() as Promise<{
        count: number; items: any[];
        offset: number; limit: number;
        hasMore: boolean; nextOffset: number | null;
      }>;
    },
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset : undefined),
    enabled: !!companyId && historyOpen,
    refetchOnWindowFocus: false,
  });
  // Flatten all loaded pages into a single list for the table — this also
  // keeps the empty-state / error-state checks below readable.
  const historyItems: any[] = (historyQ.data?.pages ?? []).flatMap((p) => p.items);

  // CSV export — calls the same history endpoint with `?format=csv` so admins
  // get the FULL audit-logged history (not just the on-screen 50 rows). The
  // same on-screen filters are forwarded so the file always matches what the
  // admin saw. The server writes a maintenance audit-log row for the export
  // itself.
  const historyCsvMut = useMutation({
    mutationFn: async () => {
      if (!companyId) throw new Error("اختر الشركة أولاً");
      const r = await fetch(
        `${API}/api/admin/maintenance/history?companyId=${companyId}&format=csv${historyFilterParams()}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!r.ok) {
        const msg = await r.json().catch(() => ({} as any));
        throw new Error(msg?.error || "فشل تصدير الملف");
      }
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition") ?? "";
      const m = cd.match(/filename="?([^";]+)"?/i);
      const filename = m?.[1] ? decodeURIComponent(m[1]) : `maintenance-history-${companyId}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      toast({ title: "تم تنزيل ملف CSV" });
      // Refresh the history panel so the export entry shows up.
      setHistoryTick((t) => t + 1);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Filter-dropdown options driven by the actual values currently present in
  // `audit_log` for the selected company (task #47). Without this, every new
  // maintenance check or admin operation would silently disappear from the
  // dropdowns until someone remembered to add a hard-coded `<SelectItem>`.
  // The 5-minute staleTime keeps typing in adjacent inputs from triggering a
  // refetch while still reflecting freshly-logged actions on the next visit.
  const historyFacetsQ = useQuery<{ actions: string[]; entityTypes: string[] }>({
    queryKey: ["maintenance-history-facets", companyId, historyTick],
    queryFn: async () => {
      const r = await fetch(
        `${API}/api/admin/maintenance/history/facets?companyId=${companyId}`,
        { headers },
      );
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل جلب الخيارات");
      return r.json();
    },
    enabled: !!companyId && historyOpen,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
  });
  const facetActions     = historyFacetsQ.data?.actions     ?? [];
  const facetEntityTypes = historyFacetsQ.data?.entityTypes ?? [];

  // Schedule config (single global row) — drives the auto-scan toggle / time.
  const scheduleQ = useQuery({
    queryKey: ["maintenance-schedule"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/maintenance/schedule`, { headers });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل جلب الجدولة");
      return r.json() as Promise<{ schedule: {
        enabled: boolean; hourOfDay: number; minuteOfHour: number;
        lastRunAt: string | null; lastRunStatus: string | null;
        lastRunCompanies: number; lastRunCriticalCount: number;
        lastError: string | null;
        lastEmailAt: string | null; lastEmailStatus: string | null;
        lastEmailError: string | null; lastEmailRecipients: number;
        lastEmailCriticalCount: number;
        emailMinIntervalHours: number;
      } }>;
    },
    refetchOnWindowFocus: false,
  });
  const updateScheduleMut = useMutation({
    mutationFn: async (patch: Partial<{ enabled: boolean; hourOfDay: number; minuteOfHour: number; emailMinIntervalHours: number }>) => {
      const r = await fetch(`${API}/api/admin/maintenance/schedule`, {
        method: "PUT", headers, body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل التحديث");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["maintenance-schedule"] }),
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });
  // Sends a one-off SuperAdmin digest using the current critical findings
  // (or a placeholder row when nothing is critical) so we can verify SMTP/
  // Outlook delivery without waiting for the next sweep.
  const testEmailMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/maintenance/schedule/test-email`, {
        method: "POST", headers, body: "{}",
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "فشل إرسال البريد التجريبي");
      return data as { ok: boolean; outcome: { recipients: number; rows: number } };
    },
    onSuccess: (data) => {
      toast({
        title: "تم إرسال البريد التجريبي",
        description: `إلى ${data.outcome.recipients} مستلم • ${data.outcome.rows} صف`,
      });
      qc.invalidateQueries({ queryKey: ["maintenance-schedule"] });
      qc.invalidateQueries({ queryKey: ["maintenance-email-history"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
    // Always refresh the schedule card + history so the new lastEmailStatus
    // and the new history row show up, even when the send failed (no
    // recipients, no SMTP, etc.).
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["maintenance-schedule"] });
      qc.invalidateQueries({ queryKey: ["maintenance-email-history"] });
    },
  });
  const runNowMut = useMutation({
    mutationFn: async (scope: "all" | "one") => {
      const body = scope === "one" && companyId ? { companyId } : {};
      const r = await fetch(`${API}/api/admin/maintenance/run-now`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل التشغيل");
      return r.json() as Promise<{ ok: boolean; summary: { companies: number; toolsRun: number; criticalCount: number; warnCount: number; errorCount: number } }>;
    },
    onSuccess: (data) => {
      toast({
        title: "اكتمل الفحص",
        description: `${data.summary.companies} شركة • أدوات: ${data.summary.toolsRun} • حرج: ${data.summary.criticalCount} • تحذير: ${data.summary.warnCount}`,
      });
      qc.invalidateQueries({ queryKey: ["maintenance-schedule"] });
      qc.invalidateQueries({ queryKey: ["maintenance-latest"] });
      qc.invalidateQueries({ queryKey: ["maintenance-tool"] });
      qc.invalidateQueries({ queryKey: ["maintenance-trend"] });
      qc.invalidateQueries({ queryKey: ["maintenance-trend-fleet"] });
      qc.invalidateQueries({ queryKey: ["maintenance-email-history"] });
      // Errored-tool panel reflects the latest per-(company, tool) status,
      // so a manual sweep that recovers (or newly breaks) a tool must
      // refresh it too — otherwise the panel keeps showing stale rows.
      qc.invalidateQueries({ queryKey: ["maintenance-error-summary"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Filters for the email-dispatch audit panel. Empty string = no filter
  // (preserves the original "latest 20 attempts" behaviour). All four are
  // forwarded to BOTH the JSON view (`emailHistoryQ`) and the CSV download
  // so the file always matches what the admin saw on screen. The status
  // bucket vocabulary (ok / failed / suppressed) mirrors the colour groups
  // the table itself renders — see `statusClass` below.
  const [emailHistFrom, setEmailHistFrom]       = useState<string>("");
  const [emailHistTo, setEmailHistTo]           = useState<string>("");
  const [emailHistTrigger, setEmailHistTrigger] = useState<string>("");
  const [emailHistStatus, setEmailHistStatus]   = useState<string>("");

  const emailHistoryFilterParams = (): string => {
    const parts: string[] = [];
    if (emailHistFrom)    parts.push(`from=${encodeURIComponent(emailHistFrom)}`);
    if (emailHistTo)      parts.push(`to=${encodeURIComponent(emailHistTo)}`);
    if (emailHistTrigger) parts.push(`trigger=${encodeURIComponent(emailHistTrigger)}`);
    if (emailHistStatus)  parts.push(`status=${encodeURIComponent(emailHistStatus)}`);
    return parts.length ? `&${parts.join("&")}` : "";
  };

  // Append-only email-dispatch history (last 20 attempts by default — narrow
  // further with the filter controls above the table). Surfaces every
  // success, failure, and suppression so SuperAdmins can audit deliveries
  // without trawling server logs. Refreshed alongside the schedule card after
  // any send attempt (test, manual run-now, scheduled sweep).
  // `reason` + `criticalSignature` were added so SuperAdmins can tell *why*
  // a sweep was skipped (cooldown vs snooze vs no recipients) and verify
  // which critical fingerprint the dispatcher was acting on.
  const emailHistoryQ = useQuery({
    queryKey: [
      "maintenance-email-history",
      emailHistFrom, emailHistTo, emailHistTrigger, emailHistStatus,
    ],
    queryFn: async () => {
      const r = await fetch(
        `${API}/api/admin/maintenance/email-history?limit=20${emailHistoryFilterParams()}`,
        { headers },
      );
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل جلب سجل البريد");
      return r.json() as Promise<{
        items: Array<{
          id: number;
          ranAt: string;
          trigger: "scheduled" | "manual" | "test";
          status: string;
          recipients: number;
          criticalCount: number;
          error: string | null;
          reason: string | null;
          criticalSignature: string | null;
        }>;
      }>;
    },
    refetchOnWindowFocus: false,
  });

  // CSV export — calls the same email-history endpoint with `?format=csv`
  // and forwards the on-screen filters so the downloaded file matches what
  // the admin sees. The server writes a maintenance audit-log row for the
  // export itself.
  const emailHistoryCsvMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(
        `${API}/api/admin/maintenance/email-history?format=csv${emailHistoryFilterParams()}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!r.ok) {
        const msg = await r.json().catch(() => ({} as any));
        throw new Error(msg?.error || "فشل تصدير الملف");
      }
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition") ?? "";
      const m = cd.match(/filename="?([^";]+)"?/i);
      const filename = m?.[1] ? decodeURIComponent(m[1]) : `maintenance-email-history-${Date.now()}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast({ title: "تم تنزيل ملف CSV" }),
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });
  // Wipe the cooldown anchor so the next sweep fires immediately regardless of
  // the configured cadence. Refreshes the schedule card + history so the
  // bypass marker row shows up in the audit table.
  const clearCooldownMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/maintenance/schedule/clear-cooldown`, {
        method: "POST", headers, body: "{}",
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "فشل مسح فترة التهدئة");
      return data as { ok: boolean };
    },
    onSuccess: () => {
      toast({
        title: "تم مسح فترة التهدئة",
        description: "سيُرسَل التنبيه التالي فوراً عند ظهور نتائج حرجة.",
      });
      qc.invalidateQueries({ queryKey: ["maintenance-schedule"] });
      qc.invalidateQueries({ queryKey: ["maintenance-email-history"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Latest scheduled-scan result per tool — drives the small badge in each card.
  const latestQ = useQuery({
    queryKey: ["maintenance-latest", companyId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/maintenance/latest?companyId=${companyId}`, { headers });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل جلب آخر فحص");
      return r.json() as Promise<{ items: Array<{ toolKey: string; status: "ok"|"warn"|"critical"|"error"; count: number; runAt: string; trigger: "scheduled"|"manual" }> }>;
    },
    enabled: !!companyId,
    refetchOnWindowFocus: false,
  });
  const latestByTool = new Map((latestQ.data?.items ?? []).map(i => [i.toolKey, i]));

  // Trend window per tool — drives the sparkline beneath each card's "آخر فحص".
  // Shares the same `companyId` filter so a fleet operator sees the trend for
  // whichever tenant they're inspecting. Re-runs after a manual sweep flips
  // the latest results so the sparkline updates immediately. SuperAdmins can
  // pick the window via the segmented selector above the toolbox; the choice
  // is persisted in localStorage so it sticks across sessions.
  const TREND_DAYS_OPTIONS = [7, 14, 30, 90] as const;
  const TREND_DAYS_STORAGE_KEY = "maintenance.trendDays";
  const [trendDays, setTrendDays] = useState<number>(() => {
    if (typeof window === "undefined") return 14;
    const raw = Number(window.localStorage.getItem(TREND_DAYS_STORAGE_KEY));
    return (TREND_DAYS_OPTIONS as readonly number[]).includes(raw) ? raw : 14;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(TREND_DAYS_STORAGE_KEY, String(trendDays));
  }, [trendDays]);
  const trendQ = useQuery({
    queryKey: ["maintenance-trend", companyId, trendDays],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/maintenance/trend?companyId=${companyId}&days=${trendDays}`, { headers });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل جلب الاتجاه");
      return r.json() as Promise<{
        days: number;
        items: Array<{ toolKey: string; day: string; count: number; status: "ok"|"warn"|"critical"|"error" }>;
      }>;
    },
    enabled: !!companyId,
    refetchOnWindowFocus: false,
  });
  // Group trend points by toolKey so the card just receives its own slice.
  const trendByTool = (() => {
    const m = new Map<string, Array<{ day: string; count: number; status: "ok"|"warn"|"critical"|"error" }>>();
    for (const r of trendQ.data?.items ?? []) {
      if (!m.has(r.toolKey)) m.set(r.toolKey, []);
      m.get(r.toolKey)!.push({ day: r.day, count: r.count, status: r.status });
    }
    return m;
  })();
  const trendForTool = (toolKey: string) => ({
    days: trendDays,
    points: trendByTool.get(toolKey) ?? [],
  });

  // Tools whose latest run threw within the recency window (default 7 days).
  // A tool that errors silently doesn't lift criticalCount and would otherwise
  // stay invisible behind a green "no critical findings" banner — this panel
  // surfaces it explicitly so admins notice when a check stops working. The
  // window is server-defined (TOOL_ERROR_WINDOW_DAYS) and returned in the
  // payload so the panel can label its retention policy honestly.
  const errorSummaryQ = useQuery({
    queryKey: ["maintenance-error-summary"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/maintenance/error-summary?limit=50`, { headers });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل جلب أخطاء الأدوات");
      return r.json() as Promise<{
        count: number;
        windowDays: number;
        items: Array<{ companyId: number; companyName: string; toolKey: string; error: string | null; runAt: string }>;
      }>;
    },
    refetchOnWindowFocus: false,
  });

  // Fleet view — top 5 active companies with the most critical findings in
  // the same window. Always available to SuperAdmins regardless of which
  // company is currently selected, so they can spot recurring offenders.
  const fleetQ = useQuery({
    queryKey: ["maintenance-trend-fleet", trendDays],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/maintenance/trend?days=${trendDays}`, { headers });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل جلب لوحة الأسطول");
      return r.json() as Promise<{
        days: number;
        fleet: Array<{ companyId: number; companyName: string; criticalCount: number; criticalRuns: number; toolCount: number; lastRunAt: string | null }>;
      }>;
    },
    refetchOnWindowFocus: false,
  });

  // Tool-history drill-down — clicking a tool key in the broken-tool panel
  // opens a modal listing the most recent runs for that (company, tool) pair
  // across all days, so SuperAdmins can diagnose a recurring failure without
  // leaving the page.
  const [toolHistoryTarget, setToolHistoryTarget] = useState<
    { companyId: number; companyName: string; toolKey: string } | null
  >(null);
  const toolHistoryQ = useQuery({
    queryKey: ["maintenance-tool-history", toolHistoryTarget?.companyId, toolHistoryTarget?.toolKey],
    queryFn: async () => {
      const t = toolHistoryTarget!;
      const r = await fetch(
        `${API}/api/admin/maintenance/tool-history?companyId=${t.companyId}&toolKey=${encodeURIComponent(t.toolKey)}&limit=20`,
        { headers },
      );
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل جلب سجل الأداة");
      return r.json() as Promise<{
        companyId: number;
        toolKey: string;
        limit: number;
        items: Array<{
          id: number;
          runAt: string;
          trigger: "scheduled" | "manual";
          status: "ok" | "warn" | "critical" | "error";
          count: number;
          durationMs: number;
          error: string | null;
          details: unknown;
        }>;
      }>;
    },
    enabled: !!toolHistoryTarget,
    refetchOnWindowFocus: false,
  });

  const onFixed = () => setHistoryTick((t) => t + 1);

  return (
    <Card className="border-violet-200">
      <CardHeader className="pb-3 bg-violet-50/40">
        <CardTitle className="text-base flex items-center gap-2 text-violet-900">
          <Wrench className="h-4 w-4" />
          أدوات الصيانة
          <span className="text-xs font-normal text-muted-foreground mr-2">
            فحوصات حتمية بنقرة واحدة (تعمل قبل الذكاء الاصطناعي وتُسجَّل في سجل التدقيق)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        {/* ── Auto-scan schedule ───────────────────────────────────────── */}
        {scheduleQ.data && (() => {
          const s = scheduleQ.data.schedule;
          const hh = String(s.hourOfDay).padStart(2, "0");
          const mm = String(s.minuteOfHour).padStart(2, "0");
          return (
            <div className="border border-violet-200 rounded p-3 bg-white">
              <div className="flex flex-wrap items-center gap-3 justify-between">
                <div className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-violet-700" />
                  <span className="text-sm font-medium">الفحص التلقائي اليومي</span>
                  <span className="text-[11px] text-muted-foreground">
                    يفحص كل الشركات النشطة ويُنبّه عند نتائج حرجة
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="maint-enabled" className="text-xs">مفعّل</Label>
                  <Switch
                    id="maint-enabled"
                    checked={s.enabled}
                    disabled={updateScheduleMut.isPending}
                    onCheckedChange={(v) => updateScheduleMut.mutate({ enabled: v })}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 mt-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="maint-time" className="text-xs whitespace-nowrap">وقت التشغيل (KSA)</Label>
                  <input
                    id="maint-time"
                    type="time"
                    value={`${hh}:${mm}`}
                    disabled={!s.enabled || updateScheduleMut.isPending}
                    className="h-7 text-xs border rounded px-2 bg-background"
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(":").map(Number);
                      if (Number.isFinite(h) && Number.isFinite(m)) {
                        updateScheduleMut.mutate({ hourOfDay: h, minuteOfHour: m });
                      }
                    }}
                  />
                </div>
                <div className="flex items-center gap-2 mr-auto">
                  <Button
                    size="sm" variant="outline" className="h-7 text-xs gap-1"
                    onClick={() => runNowMut.mutate("one")}
                    disabled={!companyId || runNowMut.isPending}
                  >
                    {runNowMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                    تشغيل لهذه الشركة
                  </Button>
                  <Button
                    size="sm" className="h-7 text-xs gap-1 bg-violet-600 hover:bg-violet-700"
                    onClick={() => runNowMut.mutate("all")}
                    disabled={runNowMut.isPending}
                  >
                    {runNowMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                    تشغيل لكل الشركات الآن
                  </Button>
                </div>
              </div>
              {s.lastRunAt && (
                <p className="text-[11px] text-muted-foreground mt-2">
                  آخر تشغيل: {new Date(s.lastRunAt).toLocaleString("ar-SA")} — {s.lastRunCompanies} شركة •{" "}
                  <span className={s.lastRunCriticalCount > 0 ? "text-red-700 font-medium" : "text-emerald-700"}>
                    {s.lastRunCriticalCount} نتيجة حرجة
                  </span>
                  {s.lastRunStatus === "partial" && <span className="text-amber-800"> • جزئي</span>}
                </p>
              )}
              {s.lastError && (
                <p className="text-[11px] text-red-700 mt-1">آخر خطأ: {s.lastError}</p>
              )}
              {/* ── Email digest status ──────────────────────────────────
                  Shows the result of the last alert dispatch (auto or test)
                  and lets SuperAdmins verify SMTP/Outlook end-to-end. */}
              <div className="mt-3 pt-2 border-t border-violet-100 flex flex-wrap items-center gap-2">
                <Mail className="h-3.5 w-3.5 text-violet-700" />
                <span className="text-[11px] font-medium text-violet-900">تنبيهات البريد للسوبر أدمن</span>
                {s.lastEmailAt ? (
                  <span className="text-[11px] text-muted-foreground">
                    آخر إرسال: {new Date(s.lastEmailAt).toLocaleString("ar-SA")} •{" "}
                    <span className={
                      s.lastEmailStatus === "ok" ? "text-emerald-700 font-medium" :
                      s.lastEmailStatus === "no_critical" ? "text-emerald-700" :
                      s.lastEmailStatus === "skipped" || s.lastEmailStatus === "snoozed" || s.lastEmailStatus === "rate_limited" ? "text-amber-800" :
                      "text-red-700 font-medium"
                    }>
                      {emailStatusLabelAr(s.lastEmailStatus)}
                    </span>
                    {s.lastEmailStatus === "ok" && (
                      <> • {s.lastEmailRecipients} مستلم • {s.lastEmailCriticalCount} صف</>
                    )}
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">لم يُرسَل بعد</span>
                )}
                {/* Cadence — minimum hours between successive critical-digest emails
                    when the underlying critical set is unchanged. 0 = always send.
                    Committed onBlur so each keystroke doesn't fire a PUT, and
                    capped client-side at 720h to mirror the server bound. */}
                <div className="flex items-center gap-1.5 ml-1">
                  <Label htmlFor="maint-email-interval" className="text-[11px] whitespace-nowrap text-muted-foreground">
                    تهدئة التنبيهات (ساعات)
                  </Label>
                  {/* Keyed by the persisted value so the input remounts whenever
                      the server returns a clamped/changed cadence (e.g. user
                      enters 1000, server clamps to 720). Without the key the
                      uncontrolled defaultValue would never re-sync and the
                      field would keep showing the stale entry. */}
                  <input
                    key={s.emailMinIntervalHours ?? 24}
                    id="maint-email-interval"
                    type="number"
                    min={0}
                    max={720}
                    step={1}
                    defaultValue={s.emailMinIntervalHours ?? 24}
                    disabled={updateScheduleMut.isPending}
                    className="h-7 w-20 text-xs border rounded px-2 bg-background text-center"
                    title="الحد الأدنى من الساعات بين الرسائل عندما لا تتغير القائمة الحرجة. صفر = إرسال بعد كل فحص."
                    onBlur={(e) => {
                      const raw = Number(e.target.value);
                      const next = Number.isFinite(raw) ? Math.max(0, Math.min(720, Math.trunc(raw))) : (s.emailMinIntervalHours ?? 24);
                      if (next !== (s.emailMinIntervalHours ?? 24)) {
                        updateScheduleMut.mutate({ emailMinIntervalHours: next });
                      } else if (raw !== next) {
                        // Snap the displayed value back to the clamped one so
                        // the user sees what was actually persisted.
                        e.target.value = String(next);
                      }
                    }}
                  />
                </div>
                <Button
                  size="sm" variant="outline"
                  className="h-7 text-xs gap-1 mr-auto"
                  onClick={() => testEmailMut.mutate()}
                  disabled={testEmailMut.isPending}
                >
                  {testEmailMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  إرسال بريد تجريبي
                </Button>
                {/* Force the very next sweep to send by clearing the cooldown
                    anchor + signature. Useful when an admin has fixed an alert
                    config and wants to confirm delivery before the next
                    cadence window opens. Disabled when the cadence is set to
                    fire-every-sweep (0h) — there is no cooldown to clear in
                    that mode. The server still no-ops gracefully if the
                    cooldown isn't armed yet. */}
                <Button
                  size="sm" variant="outline"
                  className="h-7 text-xs gap-1"
                  onClick={() => clearCooldownMut.mutate()}
                  disabled={clearCooldownMut.isPending || (s.emailMinIntervalHours ?? 24) === 0}
                  title={(s.emailMinIntervalHours ?? 24) === 0
                    ? "التهدئة معطّلة (0 ساعة) — كل فحص يُرسل تنبيهاً مباشرةً"
                    : "يلغي فترة التهدئة فيُرسَل التنبيه التالي مباشرةً عند ظهور نتائج حرجة"}
                >
                  {clearCooldownMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  إلغاء التهدئة
                </Button>
              </div>
              {s.lastEmailError && s.lastEmailStatus !== "ok" && s.lastEmailStatus !== "no_critical" && (
                <p className="text-[11px] text-red-700 mt-1">تفاصيل الخطأ: {s.lastEmailError}</p>
              )}
            </div>
          );
        })()}

        {/* ── Email dispatch history (last 20 attempts) ───────────────────
            Append-only audit table backed by maintenance_email_runs. Lives
            directly beneath the schedule card so SuperAdmins can verify
            "was the email actually sent?" alongside the most recent status.
            Filters (trigger / status / date range) and CSV export let admins
            answer long-form audit questions ("show every failed send last
            quarter", "give the auditor a CSV") without leaving the page. */}
        {emailHistoryQ.data && (() => {
          const hasFilters = !!(emailHistFrom || emailHistTo || emailHistTrigger || emailHistStatus);
          return (
          <div className="border border-violet-200 rounded p-3 bg-white">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <History className="h-4 w-4 text-violet-700" />
              <span className="text-sm font-medium text-violet-900">سجل تنبيهات البريد</span>
              <span className="text-[11px] text-muted-foreground">
                {hasFilters
                  ? `${emailHistoryQ.data.items.length} محاولة مطابقة للفلاتر (حتى 20)`
                  : `آخر ${emailHistoryQ.data.items.length} محاولة إرسال (نجاح أو فشل أو متخطّاة)`}
              </span>
              <div className="mr-auto flex items-center gap-1.5">
                <Button
                  size="sm" variant="ghost" className="h-7 text-xs gap-1"
                  onClick={() => emailHistoryCsvMut.mutate()}
                  disabled={emailHistoryCsvMut.isPending}
                  title="تنزيل سجل البريد الكامل كملف CSV (يحترم الفلاتر أدناه)"
                >
                  {emailHistoryCsvMut.isPending
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <Download className="h-3 w-3" />}
                  تصدير CSV
                </Button>
              </div>
            </div>
            {/* Lightweight filters — apply to BOTH the on-screen table and
                the CSV export. Empty inputs preserve original behaviour. */}
            <div className="pb-2 pt-0.5 flex flex-wrap items-end gap-2 text-[11px]">
              <div className="flex flex-col gap-0.5">
                <label className="text-muted-foreground">من تاريخ</label>
                <Input
                  type="date" value={emailHistFrom}
                  onChange={(e) => setEmailHistFrom(e.target.value)}
                  className="h-7 w-[130px] text-xs"
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-muted-foreground">إلى تاريخ</label>
                <Input
                  type="date" value={emailHistTo}
                  onChange={(e) => setEmailHistTo(e.target.value)}
                  className="h-7 w-[130px] text-xs"
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-muted-foreground">المصدر</label>
                <Select
                  value={emailHistTrigger || "__all"}
                  onValueChange={(v) => setEmailHistTrigger(v === "__all" ? "" : v)}
                >
                  <SelectTrigger className="h-7 w-[140px] text-xs">
                    <SelectValue placeholder="كل المصادر" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all">كل المصادر</SelectItem>
                    <SelectItem value="scheduled">تلقائي</SelectItem>
                    <SelectItem value="manual">يدوي</SelectItem>
                    <SelectItem value="test">تجريبي</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-muted-foreground">الحالة</label>
                <Select
                  value={emailHistStatus || "__all"}
                  onValueChange={(v) => setEmailHistStatus(v === "__all" ? "" : v)}
                >
                  <SelectTrigger className="h-7 w-[160px] text-xs">
                    <SelectValue placeholder="كل الحالات" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all">كل الحالات</SelectItem>
                    <SelectItem value="ok">ناجحة</SelectItem>
                    <SelectItem value="failed">فاشلة</SelectItem>
                    <SelectItem value="suppressed">متخطّاة</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {hasFilters && (
                <Button
                  size="sm" variant="ghost"
                  className="h-7 text-[11px] px-2"
                  onClick={() => {
                    setEmailHistFrom(""); setEmailHistTo("");
                    setEmailHistTrigger(""); setEmailHistStatus("");
                  }}
                  title="مسح كل الفلاتر"
                >
                  مسح الفلاتر
                </Button>
              )}
            </div>
            {emailHistoryQ.data.items.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {hasFilters
                  ? "لا توجد محاولات إرسال مطابقة للفلاتر."
                  : "لا توجد محاولات إرسال بعد."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-violet-50 text-violet-900">
                    <tr>
                      <th className="px-2 py-1 text-right">الوقت</th>
                      <th className="px-2 py-1 text-right">المصدر</th>
                      <th className="px-2 py-1 text-right">الحالة</th>
                      <th className="px-2 py-1 text-right">السبب</th>
                      <th className="px-2 py-1 text-right">المستلمون</th>
                      <th className="px-2 py-1 text-right">صفوف حرجة</th>
                      <th className="px-2 py-1 text-right">بصمة القائمة الحرجة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-violet-100">
                    {emailHistoryQ.data.items.map((row) => {
                      const triggerLabel =
                        row.trigger === "scheduled" ? "تلقائي" :
                        row.trigger === "manual"    ? "يدوي" :
                        row.trigger === "test"      ? "تجريبي" :
                        row.trigger;
                      const statusClass =
                        row.status === "ok" ? "text-emerald-700 font-medium" :
                        row.status === "no_critical" ? "text-emerald-700" :
                        row.status === "skipped" || row.status === "snoozed" || row.status === "rate_limited" ? "text-amber-800" :
                        "text-red-700 font-medium";
                      // Short signature preview — full SHA-1 lives in the title
                      // tooltip so SuperAdmins can copy/paste the whole string
                      // without overflowing the table column.
                      const sigPreview = row.criticalSignature
                        ? (row.criticalSignature.length > 0
                            ? `${row.criticalSignature.slice(0, 8)}…`
                            : "—")
                        : "—";
                      return (
                        <tr key={row.id}>
                          <td className="px-2 py-1 text-muted-foreground whitespace-nowrap">
                            {new Date(row.ranAt).toLocaleString("ar-SA")}
                          </td>
                          <td className="px-2 py-1">{triggerLabel}</td>
                          <td className={`px-2 py-1 ${statusClass}`}>{emailStatusLabelAr(row.status)}</td>
                          <td
                            className="px-2 py-1 text-muted-foreground"
                            title={row.error ? `${row.reason ?? ""} — ${row.error}` : (row.reason ?? "")}
                          >
                            {emailReasonLabelAr(row.reason)}
                            {row.error && row.error !== row.reason && (
                              <span className="text-red-700 block text-[10px] font-mono" title={row.error}>
                                {row.error.length > 60 ? `${row.error.slice(0, 60)}…` : row.error}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1 font-mono">{row.recipients}</td>
                          <td className="px-2 py-1 font-mono">{row.criticalCount}</td>
                          <td
                            className="px-2 py-1 font-mono text-[10px] text-muted-foreground"
                            title={row.criticalSignature ?? ""}
                          >
                            {sigPreview}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          );
        })()}

        {/* ── Broken-tool panel: latest per-(company, tool) "error" rows ──
            Surfaces silently-broken checks distinct from "critical findings"
            so a tool whose latest run threw — and therefore contributes 0 to
            criticalCount — still gets noticed. The 7-day window matches the
            server's TOOL_ERROR_WINDOW_DAYS so a transient failure that has
            since recovered (any non-error run later wins) drops off
            automatically. */}
        {errorSummaryQ.data && errorSummaryQ.data.items.length > 0 && (
          <div className="border border-amber-200 rounded p-3 bg-amber-50/40">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="h-4 w-4 text-amber-700" />
              <span className="text-sm font-medium text-amber-900">
                أدوات صيانة تعطّلت آخر {errorSummaryQ.data.windowDays} أيام
                <span className="font-normal text-amber-800/80 mr-1">
                  ({errorSummaryQ.data.items.length} حالة)
                </span>
              </span>
              <span className="text-[11px] text-muted-foreground mr-auto">
                هذه الفحوصات لم تكتمل بسبب خطأ — لا تظهر ضمن النتائج الحرجة وتحتاج مراجعة فنية. تُحفظ آخر {errorSummaryQ.data.windowDays} أيام فقط.
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-amber-100/60 text-amber-900">
                  <tr>
                    <th className="px-2 py-1 text-right">الشركة</th>
                    <th className="px-2 py-1 text-right">الأداة</th>
                    <th className="px-2 py-1 text-right">رسالة الخطأ</th>
                    <th className="px-2 py-1 text-right">وقت آخر فشل</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-100">
                  {errorSummaryQ.data.items.map((row) => (
                    <tr key={`${row.companyId}:${row.toolKey}`}>
                      <td className="px-2 py-1">
                        <button
                          type="button"
                          className="text-violet-700 hover:underline font-medium"
                          onClick={() => onSelectCompany(row.companyId)}
                          title={`اختيار ${row.companyName} (#${row.companyId})`}
                        >
                          {row.companyName || `#${row.companyId}`}
                        </button>
                      </td>
                      <td className="px-2 py-1 font-mono text-[11px]">
                        <button
                          type="button"
                          className="text-violet-700 hover:underline"
                          onClick={() => setToolHistoryTarget({
                            companyId: row.companyId,
                            companyName: row.companyName || `#${row.companyId}`,
                            toolKey: row.toolKey,
                          })}
                          title={`عرض آخر التشغيلات لـ ${row.toolKey} (${row.companyName || `#${row.companyId}`})`}
                        >
                          {row.toolKey}
                        </button>
                      </td>
                      <td className="px-2 py-1 text-amber-900 font-mono text-[11px]" title={row.error ?? ""}>
                        {row.error
                          ? (row.error.length > 80 ? `${row.error.slice(0, 80)}…` : row.error)
                          : "—"}
                      </td>
                      <td className="px-2 py-1 text-muted-foreground whitespace-nowrap">
                        {new Date(row.runAt).toLocaleString("ar-SA")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Fleet view: top 5 companies with most critical findings ───── */}
        {fleetQ.data && fleetQ.data.fleet.length > 0 && (
          <div className="border border-red-200 rounded p-3 bg-red-50/40">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="h-4 w-4 text-red-700" />
              <span className="text-sm font-medium text-red-900">
                أكثر الشركات نتائج حرجة آخر {fleetQ.data.days} يوماً
              </span>
              <span className="text-[11px] text-muted-foreground mr-auto">
                اضغط على اسم الشركة لاختيارها
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-red-100/60 text-red-900">
                  <tr>
                    <th className="px-2 py-1 text-right">#</th>
                    <th className="px-2 py-1 text-right">الشركة</th>
                    <th className="px-2 py-1 text-right">إجمالي الحرج</th>
                    <th className="px-2 py-1 text-right">أيام × أدوات</th>
                    <th className="px-2 py-1 text-right">عدد الأدوات</th>
                    <th className="px-2 py-1 text-right">آخر نتيجة حرجة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-red-100">
                  {fleetQ.data.fleet.map((c, i) => (
                    <tr key={c.companyId} className={c.companyId === companyId ? "bg-red-100/40" : ""}>
                      <td className="px-2 py-1 text-muted-foreground tabular-nums">{i + 1}</td>
                      <td className="px-2 py-1">
                        <button
                          type="button"
                          className="text-violet-700 hover:underline font-medium"
                          onClick={() => onSelectCompany(c.companyId)}
                          title={`اختيار ${c.companyName} (#${c.companyId})`}
                        >
                          {c.companyName || `#${c.companyId}`}
                        </button>
                      </td>
                      <td className="px-2 py-1 font-mono text-red-700">{c.criticalCount}</td>
                      <td className="px-2 py-1 font-mono">{c.criticalRuns}</td>
                      <td className="px-2 py-1 font-mono">{c.toolCount}</td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {c.lastRunAt ? new Date(c.lastRunAt).toLocaleString("ar-SA") : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!companyId && (
          <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded p-2">
            اختر شركة من الأعلى لبدء الفحص.
          </p>
        )}

        {/* ── Trend window selector ───────────────────────────────────────
            Drives the sparkline window on every maintenance card AND the
            fleet-view header above. The choice is persisted in localStorage
            so each operator's preference sticks across sessions. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground">نافذة الاتجاه:</span>
          <div className="inline-flex rounded-md border border-violet-200 overflow-hidden bg-white"
               role="group" aria-label="اختيار نافذة الاتجاه بالأيام">
            {TREND_DAYS_OPTIONS.map((d) => {
              const active = d === trendDays;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setTrendDays(d)}
                  aria-pressed={active}
                  className={
                    "h-7 px-2.5 text-xs border-l border-violet-200 first:border-l-0 transition-colors " +
                    (active
                      ? "bg-violet-600 text-white"
                      : "bg-white text-violet-900 hover:bg-violet-50")
                  }
                  title={`عرض اتجاه آخر ${d} يوم`}
                >
                  {d}ي
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {/* 1. القيود المعلقة (drafts older than 30 days) */}
          <MaintenanceTool
            toolKey="journal-pending"
            label="القيود المعلقة"
            description="قيود يومية مسوّدة لم تُرحَّل منذ أكثر من 30 يوماً — رحّلها بالجملة أو احذفها."
            icon={FileText}
            checkEndpoint="maintenance/journal-pending"
            fixEndpoint="maintenance/journal-pending/fix"
            companyId={companyId}
            onFixed={onFixed}
            latestScan={latestByTool.get("journal-pending") ?? null}
            trend={trendForTool("journal-pending")}
            buildFixBody={(cid, ids) => ({ companyId: cid, ids, action: "post" })}
            confirmTitle="ترحيل القيود المختارة"
            confirmDescription={(n) => `سيتم ترحيل ${n} قيد محاسبي (المتوازن منها فقط). متابعة؟`}
            fixActions={[{
              key: "delete",
              label: "حذف",
              destructive: true,
              confirmTitle: "حذف القيود المسوّدة نهائياً",
              confirmDescription: (n) => `سيتم حذف ${n} قيد ومسوّدته نهائياً ولا يمكن التراجع. متابعة؟`,
              buildBody: (cid, ids) => ({ companyId: cid, ids, action: "delete" }),
            }]}
            renderDetails={({ data, selectedIds, toggle, toggleAll, allSelected }) => {
              const items = data.items ?? [];
              const ids = items.map((it: any) => it.id);
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-2 py-1 text-right">
                          <input type="checkbox" checked={allSelected} onChange={() => toggleAll(ids)} />
                        </th>
                        <th className="px-2 py-1 text-right">#</th>
                        <th className="px-2 py-1 text-right">رقم المستند</th>
                        <th className="px-2 py-1 text-right">التاريخ</th>
                        <th className="px-2 py-1 text-right">مدين</th>
                        <th className="px-2 py-1 text-right">دائن</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {items.slice(0, 30).map((it: any) => (
                        <tr key={it.id}>
                          <td className="px-2 py-1">
                            <input type="checkbox" checked={selectedIds.includes(it.id)} onChange={() => toggle(it.id)} />
                          </td>
                          <td className="px-2 py-1 text-muted-foreground">{it.id}</td>
                          <td className="px-2 py-1 font-mono">{it.docNumber || "—"}</td>
                          <td className="px-2 py-1">{it.entryDate}</td>
                          <td className="px-2 py-1 font-mono">{Number(it.totalDebit).toFixed(2)}</td>
                          <td className="px-2 py-1 font-mono">{Number(it.totalCredit).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {items.length > 30 && <p className="text-[11px] text-muted-foreground p-1">عرض أول 30 من {items.length} نتيجة.</p>}
                </div>
              );
            }}
          />

          {/* 2. مرجعيات مكسورة */}
          <MaintenanceTool
            toolKey="broken-refs"
            label="مرجعيات مكسورة"
            description="فواتير مرحّلة بدون قيد محاسبي أو ترتبط بقيد محذوف — يعيدها لمسوّدة لإعادة الترحيل."
            icon={Link2}
            checkEndpoint="maintenance/broken-refs"
            fixEndpoint="maintenance/broken-refs/fix"
            companyId={companyId}
            onFixed={onFixed}
            latestScan={latestByTool.get("broken-refs") ?? null}
            trend={trendForTool("broken-refs")}
            buildFixBody={(cid, ids) => {
              // Selected ids may be plain numeric ids of items; we need to
              // re-attach `kind`. The render-prop passes composite "kind:id"
              // strings to disambiguate sales vs purchase.
              const items = ids.map((raw) => {
                const s = String(raw);
                const [kind, id] = s.includes(":") ? s.split(":") : ["sales", s];
                return { kind, id: Number(id) };
              });
              return { companyId: cid, items };
            }}
            confirmTitle="إعادة الفواتير لمسوّدة"
            confirmDescription={(n) => `سيتم تحويل ${n} فاتورة لحالة "مسوّدة" حتى تعيد ترحيلها وإنشاء قيدها يدوياً. متابعة؟`}
            renderDetails={({ data, selectedIds, toggle, toggleAll, allSelected }) => {
              const items = data.items ?? [];
              const composite: string[] = items.map((it: any) => `${it.kind}:${it.id}`);
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-2 py-1 text-right">
                          <input type="checkbox" checked={allSelected} onChange={() => toggleAll(composite)} />
                        </th>
                        <th className="px-2 py-1 text-right">النوع</th>
                        <th className="px-2 py-1 text-right">رقم</th>
                        <th className="px-2 py-1 text-right">التاريخ</th>
                        <th className="px-2 py-1 text-right">المبلغ</th>
                        <th className="px-2 py-1 text-right">السبب</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {items.slice(0, 30).map((it: any) => {
                        const k = `${it.kind}:${it.id}`;
                        return (
                          <tr key={k}>
                            <td className="px-2 py-1">
                              <input type="checkbox" checked={selectedIds.includes(k)} onChange={() => toggle(k)} />
                            </td>
                            <td className="px-2 py-1">{it.kind === "sales" ? "مبيعات" : "مشتريات"}</td>
                            <td className="px-2 py-1 font-mono">{it.docNumber || `#${it.id}`}</td>
                            <td className="px-2 py-1">{it.invoiceDate}</td>
                            <td className="px-2 py-1 font-mono">{Number(it.totalAmount ?? 0).toFixed(2)}</td>
                            <td className="px-2 py-1">{it.reason === "missing" ? "بدون قيد" : "قيد محذوف"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {items.length > 30 && <p className="text-[11px] text-muted-foreground p-1">عرض أول 30 من {items.length} نتيجة.</p>}
                </div>
              );
            }}
          />

          {/* 3. حسابات غير مربوطة (read-only) */}
          <MaintenanceTool
            toolKey="unlinked-accounts"
            label="حسابات غير مربوطة"
            description="حسابات مشار إليها في القيود ولكنها غير موجودة في دليل الحسابات للشركة — قائمة فحص فقط."
            icon={Unlink}
            checkEndpoint="maintenance/unlinked-accounts"
            companyId={companyId}
            latestScan={latestByTool.get("unlinked-accounts") ?? null}
            trend={trendForTool("unlinked-accounts")}
            renderDetails={({ data }) => {
              const items = data.items ?? [];
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-2 py-1 text-right">معرّف الحساب</th>
                        <th className="px-2 py-1 text-right">عدد السطور</th>
                        <th className="px-2 py-1 text-right">قيد عيّنة</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {items.slice(0, 30).map((it: any) => (
                        <tr key={it.accountId}>
                          <td className="px-2 py-1 font-mono">#{it.accountId}</td>
                          <td className="px-2 py-1 font-mono tabular-nums">{it.lineCount}</td>
                          <td className="px-2 py-1 font-mono">{it.sampleDocNumber || `#${it.sampleEntryId}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {items.length > 30 && <p className="text-[11px] text-muted-foreground p-1">عرض أول 30 من {items.length} نتيجة.</p>}
                </div>
              );
            }}
          />

          {/* 4. فجوات في المسلسلات (read-only) */}
          <MaintenanceTool
            toolKey="sequence-gaps"
            label="فجوات في المسلسلات"
            description="أرقام داخل نطاق المسلسلات لا يقابلها سجل في sequence_logs — قد تشير لتعديل يدوي."
            icon={ListOrdered}
            checkEndpoint="maintenance/sequence-gaps"
            companyId={companyId}
            latestScan={latestByTool.get("sequence-gaps") ?? null}
            trend={trendForTool("sequence-gaps")}
            renderDetails={({ data }) => {
              const items = data.items ?? [];
              return (
                <div className="space-y-2">
                  {items.map((seq: any) => (
                    <div key={seq.sequenceId} className="border rounded p-2 bg-muted/30">
                      <div className="flex items-center justify-between text-xs font-medium mb-1">
                        <span>{seq.nameAr} <span className="text-muted-foreground">({seq.code})</span></span>
                        <span className="text-amber-900">عدد الفجوات: {seq.gapCount}</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {seq.sampleGaps.map((g: any) => (
                          <code key={g.number} className="text-[11px] bg-background border rounded px-1.5 py-0.5 font-mono">
                            {g.formatted}
                          </code>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            }}
          />

          {/* 5. مستخدمون خاملون */}
          <MaintenanceTool
            toolKey="dormant-users"
            label="مستخدمون خاملون"
            description="مستخدمون لم يدخلوا للنظام منذ أكثر من 90 يوماً أو لم يدخلوا أبداً — يمكن تعطيلهم."
            icon={UserX}
            checkEndpoint="maintenance/dormant-users"
            fixEndpoint="maintenance/dormant-users/fix"
            destructive
            companyId={companyId}
            onFixed={onFixed}
            latestScan={latestByTool.get("dormant-users") ?? null}
            trend={trendForTool("dormant-users")}
            buildFixBody={(cid, ids) => ({ companyId: cid, ids })}
            confirmTitle="تعطيل المستخدمين المختارين"
            confirmDescription={(n) => `سيتم تعطيل ${n} مستخدم وإلغاء جلساتهم. يمكن إعادة تفعيلهم لاحقاً من إدارة المستخدمين. متابعة؟`}
            renderDetails={({ data, selectedIds, toggle, toggleAll, allSelected }) => {
              const items = data.items ?? [];
              const ids = items.map((it: any) => it.id);
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-2 py-1 text-right">
                          <input type="checkbox" checked={allSelected} onChange={() => toggleAll(ids)} />
                        </th>
                        <th className="px-2 py-1 text-right">المستخدم</th>
                        <th className="px-2 py-1 text-right">الاسم</th>
                        <th className="px-2 py-1 text-right">الدور</th>
                        <th className="px-2 py-1 text-right">آخر دخول</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {items.slice(0, 30).map((u: any) => (
                        <tr key={u.id}>
                          <td className="px-2 py-1">
                            <input type="checkbox" checked={selectedIds.includes(u.id)} onChange={() => toggle(u.id)} />
                          </td>
                          <td className="px-2 py-1 font-mono">{u.username}</td>
                          <td className="px-2 py-1">{u.nameAr || "—"}</td>
                          <td className="px-2 py-1 text-muted-foreground">{u.role}</td>
                          <td className="px-2 py-1">
                            {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString("ar") : <span className="text-amber-700">لم يدخل أبداً</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {items.length > 30 && <p className="text-[11px] text-muted-foreground p-1">عرض أول 30 من {items.length} مستخدم.</p>}
                </div>
              );
            }}
          />

          {/* 6. حركات مخزون يتيمة — يستخدم الصفحة المخصّصة */}
          <MaintenanceTool
            toolKey="orphan-stock-link"
            label="حركات مخزون يتيمة"
            description="حركات مخزون مرتبطة بفواتير محذوفة — يتم إصلاحها من شاشة تنظيف حركات المخزون اليتيمة المخصّصة."
            icon={PackageX}
            checkEndpoint="orphan-stock"
            companyId={companyId}
            latestScan={latestByTool.get("orphan-stock") ?? null}
            trend={trendForTool("orphan-stock")}
            externalCta={{ label: "فتح صفحة التنظيف", href: "/admin/orphan-stock" }}
          />
        </div>

        {/* ── Category: المخزون ─────────────────────────────────────────── */}
        <div className="flex items-center gap-2 mt-3 pt-3 border-t">
          <Boxes className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">المخزون</h3>
          <span className="text-[11px] text-muted-foreground">— أدوات فحص وإصلاح أرصدة وحركات المخزون.</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {/* أرصدة سالبة — read-only diagnostic. */}
          <MaintenanceTool
            toolKey="negative-stock"
            label="أرصدة مخزون سالبة"
            description="أصناف ذات رصيد أقل من صفر في أحد المستودعات — تتطلب تسوية يدوية (شراء أو تعديل)."
            icon={TrendingDown}
            checkEndpoint="maintenance/negative-stock"
            companyId={companyId}
            onFixed={onFixed}
            latestScan={latestByTool.get("negative-stock") ?? null}
            trend={trendForTool("negative-stock")}
            renderDetails={({ data }) => {
              const items = data.items ?? [];
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-2 py-1 text-right">كود</th>
                        <th className="px-2 py-1 text-right">الصنف</th>
                        <th className="px-2 py-1 text-right">المستودع</th>
                        <th className="px-2 py-1 text-right">الكمية</th>
                        <th className="px-2 py-1 text-right">متوسط التكلفة</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {items.slice(0, 30).map((it: any) => (
                        <tr key={`${it.itemId}:${it.warehouseId}`}>
                          <td className="px-2 py-1 font-mono">{it.itemCode || "—"}</td>
                          <td className="px-2 py-1">{it.itemName || `#${it.itemId}`}</td>
                          <td className="px-2 py-1">{it.warehouseName || `#${it.warehouseId}`}</td>
                          <td className="px-2 py-1 font-mono text-red-700">{Number(it.qty).toFixed(4)}</td>
                          <td className="px-2 py-1 font-mono">{Number(it.avgCost).toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {items.length > 30 && <p className="text-[11px] text-muted-foreground p-1">عرض أول 30 من {items.length} نتيجة.</p>}
                </div>
              );
            }}
          />

          {/* انحراف رصيد — fix recomputes from ledger. */}
          <MaintenanceTool
            toolKey="stock-balance-drift"
            label="انحراف رصيد المخزون"
            description="فروقات بين الرصيد المخزّن ومجموع الحركات في دفتر الأستاذ — يعيد الحساب من الحركات."
            icon={Scale}
            checkEndpoint="maintenance/stock-balance-drift"
            fixEndpoint="maintenance/stock-balance-drift/fix"
            companyId={companyId}
            onFixed={onFixed}
            latestScan={latestByTool.get("stock-balance-drift") ?? null}
            trend={trendForTool("stock-balance-drift")}
            confirmTitle="إعادة حساب الأرصدة"
            confirmDescription={(n) => `سيتم تحديث ${n} رصيد مخزون من واقع الحركات. متابعة؟`}
            buildFixBody={(cid, ids) => {
              // Composite ids "itemId:warehouseId" → resolve back to objects
              // by walking the latest scan items the user selected.
              const items = ids.map((raw) => {
                const [itemId, warehouseId] = String(raw).split(":");
                return { itemId: Number(itemId), warehouseId: Number(warehouseId) };
              });
              return { companyId: cid, items };
            }}
            renderDetails={({ data, selectedIds, toggle, toggleAll, allSelected }) => {
              const items = data.items ?? [];
              // Compose a stable id per (item, warehouse) so the parent's
              // selectedIds set can disambiguate. Also stash ledgerQty on the
              // body — but the parent only forwards ids; the fix route in
              // turn re-derives the ledger sum server-side, so dropping
              // ledgerQty from the wire is intentional and safe.
              const ids = items.map((it: any) => `${it.itemId}:${it.warehouseId}`);
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-2 py-1 text-right">
                          <input type="checkbox" checked={allSelected} onChange={() => toggleAll(ids)} />
                        </th>
                        <th className="px-2 py-1 text-right">كود</th>
                        <th className="px-2 py-1 text-right">الصنف</th>
                        <th className="px-2 py-1 text-right">المستودع</th>
                        <th className="px-2 py-1 text-right">المخزّن</th>
                        <th className="px-2 py-1 text-right">من الحركات</th>
                        <th className="px-2 py-1 text-right">الفارق</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {items.slice(0, 30).map((it: any) => {
                        const id = `${it.itemId}:${it.warehouseId}`;
                        return (
                          <tr key={id}>
                            <td className="px-2 py-1">
                              <input type="checkbox" checked={selectedIds.includes(id)} onChange={() => toggle(id)} />
                            </td>
                            <td className="px-2 py-1 font-mono">{it.itemCode || "—"}</td>
                            <td className="px-2 py-1">{it.itemName || `#${it.itemId}`}</td>
                            <td className="px-2 py-1">{it.warehouseName || `#${it.warehouseId}`}</td>
                            <td className="px-2 py-1 font-mono">{Number(it.storedQty).toFixed(4)}</td>
                            <td className="px-2 py-1 font-mono">{Number(it.ledgerQty).toFixed(4)}</td>
                            <td className="px-2 py-1 font-mono text-amber-700">{Number(it.drift).toFixed(4)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {items.length > 30 && <p className="text-[11px] text-muted-foreground p-1">عرض أول 30 من {items.length} نتيجة.</p>}
                </div>
              );
            }}
          />
        </div>

        {/* ── Category: القيود المحاسبية ────────────────────────────────── */}
        <div className="flex items-center gap-2 mt-3 pt-3 border-t">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">القيود المحاسبية</h3>
          <span className="text-[11px] text-muted-foreground">— تحقّق من سلامة دفتر اليومية والتوازن المحاسبي.</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {/* قيود غير متوازنة — read-only. */}
          <MaintenanceTool
            toolKey="unbalanced-entries"
            label="قيود مرحّلة غير متوازنة"
            description="قيود يومية مرحّلة مجموع المدين فيها لا يساوي مجموع الدائن — تتطلب مراجعة المحاسب."
            icon={Calculator}
            checkEndpoint="maintenance/unbalanced-entries"
            companyId={companyId}
            onFixed={onFixed}
            latestScan={latestByTool.get("unbalanced-entries") ?? null}
            trend={trendForTool("unbalanced-entries")}
            renderDetails={({ data }) => {
              const items = data.items ?? [];
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-2 py-1 text-right">#</th>
                        <th className="px-2 py-1 text-right">رقم المستند</th>
                        <th className="px-2 py-1 text-right">التاريخ</th>
                        <th className="px-2 py-1 text-right">مدين</th>
                        <th className="px-2 py-1 text-right">دائن</th>
                        <th className="px-2 py-1 text-right">الفارق</th>
                        <th className="px-2 py-1 text-right">عدد السطور</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {items.slice(0, 30).map((it: any) => (
                        <tr key={it.id}>
                          <td className="px-2 py-1 text-muted-foreground">{it.id}</td>
                          <td className="px-2 py-1 font-mono">{it.docNumber || "—"}</td>
                          <td className="px-2 py-1">{it.entryDate}</td>
                          <td className="px-2 py-1 font-mono">{Number(it.totalDebit).toFixed(2)}</td>
                          <td className="px-2 py-1 font-mono">{Number(it.totalCredit).toFixed(2)}</td>
                          <td className="px-2 py-1 font-mono text-red-700">{Number(it.diff).toFixed(2)}</td>
                          <td className="px-2 py-1">{it.lineCount ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {items.length > 30 && <p className="text-[11px] text-muted-foreground p-1">عرض أول 30 من {items.length} نتيجة.</p>}
                </div>
              );
            }}
          />
        </div>

        {/* ── Category: السجلات ─────────────────────────────────────────── */}
        <div className="flex items-center gap-2 mt-3 pt-3 border-t">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">السجلات</h3>
          <span className="text-[11px] text-muted-foreground">— أرشفة السجلات القديمة لتقليص حجم الجداول.</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {/* سجلات تدقيق قديمة — fix deletes. */}
          <MaintenanceTool
            toolKey="old-audit-logs"
            label="سجل التدقيق القديم"
            description="سجلات تدقيق أقدم من مدة الاحتفاظ المحدّدة (audit_log) — حذفها يقلّص حجم الجدول دون التأثير على الإجراءات الحديثة."
            icon={ScrollText}
            checkEndpoint="maintenance/old-audit-logs"
            fixEndpoint="maintenance/old-audit-logs/fix"
            companyId={companyId}
            onFixed={onFixed}
            destructive
            latestScan={latestByTool.get("old-audit-logs") ?? null}
            trend={trendForTool("old-audit-logs")}
            retentionConfig={{ defaultDays: 365, min: 30, max: 3650 }}
            confirmTitle="حذف سجلات التدقيق القديمة"
            confirmDescription={(n) => `سيتم حذف ${n} سجل تدقيق ضمن مدة الاحتفاظ المحدّدة نهائياً. متابعة؟`}
            buildFixBody={(cid) => ({ companyId: cid })}
            renderDetails={({ data }) => {
              const items = data.items ?? [];
              return (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground px-1">
                    أقدم سجل: {data.oldest ? String(data.oldest).slice(0, 16).replace("T", " ") : "—"} ·
                    أحدث ضمن النطاق: {data.newest ? String(data.newest).slice(0, 16).replace("T", " ") : "—"}
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="px-2 py-1 text-right">#</th>
                          <th className="px-2 py-1 text-right">المستخدم</th>
                          <th className="px-2 py-1 text-right">الوحدة</th>
                          <th className="px-2 py-1 text-right">الإجراء</th>
                          <th className="px-2 py-1 text-right">التاريخ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {items.slice(0, 30).map((it: any) => (
                          <tr key={it.id}>
                            <td className="px-2 py-1 text-muted-foreground">{it.id}</td>
                            <td className="px-2 py-1">{it.username || "—"}</td>
                            <td className="px-2 py-1 font-mono">{it.module}</td>
                            <td className="px-2 py-1">{it.action}</td>
                            <td className="px-2 py-1">{String(it.createdAt ?? "").slice(0, 16).replace("T", " ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {items.length > 30 && <p className="text-[11px] text-muted-foreground p-1">عرض أول 30 من {items.length} نتيجة.</p>}
                  </div>
                </div>
              );
            }}
          />

          {/* سجلات تشغيل صيانة قديمة — fix deletes. */}
          <MaintenanceTool
            toolKey="old-maintenance-runs"
            label="سجل تشغيل الصيانة القديم"
            description="نتائج فحص صيانة أقدم من مدة الاحتفاظ المحدّدة (maintenance_runs) — حذفها يحافظ على لوحة المؤشرات سريعة."
            icon={Trash2}
            checkEndpoint="maintenance/old-maintenance-runs"
            fixEndpoint="maintenance/old-maintenance-runs/fix"
            companyId={companyId}
            onFixed={onFixed}
            destructive
            latestScan={latestByTool.get("old-maintenance-runs") ?? null}
            trend={trendForTool("old-maintenance-runs")}
            retentionConfig={{ defaultDays: 90, min: 7, max: 3650 }}
            confirmTitle="حذف سجلات تشغيل الصيانة القديمة"
            confirmDescription={(n) => `سيتم حذف ${n} نتيجة فحص ضمن مدة الاحتفاظ المحدّدة نهائياً. متابعة؟`}
            buildFixBody={(cid) => ({ companyId: cid })}
            renderDetails={({ data }) => {
              const items = data.items ?? [];
              return (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground px-1">
                    أقدم سجل: {data.oldest ? String(data.oldest).slice(0, 16).replace("T", " ") : "—"} ·
                    أحدث ضمن النطاق: {data.newest ? String(data.newest).slice(0, 16).replace("T", " ") : "—"}
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="px-2 py-1 text-right">#</th>
                          <th className="px-2 py-1 text-right">الأداة</th>
                          <th className="px-2 py-1 text-right">الحالة</th>
                          <th className="px-2 py-1 text-right">العدد</th>
                          <th className="px-2 py-1 text-right">المصدر</th>
                          <th className="px-2 py-1 text-right">التاريخ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {items.slice(0, 30).map((it: any) => (
                          <tr key={it.id}>
                            <td className="px-2 py-1 text-muted-foreground">{it.id}</td>
                            <td className="px-2 py-1 font-mono">{it.toolKey}</td>
                            <td className="px-2 py-1">{it.status}</td>
                            <td className="px-2 py-1 font-mono">{it.count}</td>
                            <td className="px-2 py-1">{it.trigger}</td>
                            <td className="px-2 py-1">{String(it.runAt ?? "").slice(0, 16).replace("T", " ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {items.length > 30 && <p className="text-[11px] text-muted-foreground p-1">عرض أول 30 من {items.length} نتيجة.</p>}
                  </div>
                </div>
              );
            }}
          />

          {/* سجل بريد الصيانة القديم — fix deletes. The maintenance_email_runs
              table is global (no company_id), so the count shown here is the
              same regardless of the selected company; we still render the card
              under each company so the audit-log entry for the prune is
              attributed to the SuperAdmin who ran it. No latestScan/trend
              because this tool isn't part of the per-company sweep. */}
          <MaintenanceTool
            toolKey="old-maintenance-email-runs"
            label="سجل بريد الصيانة القديم"
            description="محاولات إرسال تنبيهات الصيانة (maintenance_email_runs) أقدم من مدة الاحتفاظ المحدّدة — حذفها يقلّص حجم سجل التدقيق دون التأثير على المحاولات الحديثة. السجل مشترك بين كل الشركات."
            icon={Trash2}
            checkEndpoint="maintenance/old-maintenance-email-runs"
            fixEndpoint="maintenance/old-maintenance-email-runs/fix"
            companyId={companyId}
            onFixed={onFixed}
            destructive
            latestScan={null}
            trend={undefined}
            retentionConfig={{ defaultDays: 90, min: 7, max: 3650 }}
            confirmTitle="حذف سجل بريد الصيانة القديم"
            confirmDescription={(n) => `سيتم حذف ${n} محاولة إرسال ضمن مدة الاحتفاظ المحدّدة نهائياً (سجل عام لكل الشركات). متابعة؟`}
            buildFixBody={(cid) => ({ companyId: cid })}
            renderDetails={({ data }) => {
              const items = data.items ?? [];
              return (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground px-1">
                    أقدم محاولة: {data.oldest ? String(data.oldest).slice(0, 16).replace("T", " ") : "—"} ·
                    أحدث ضمن النطاق: {data.newest ? String(data.newest).slice(0, 16).replace("T", " ") : "—"}
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="px-2 py-1 text-right">#</th>
                          <th className="px-2 py-1 text-right">المصدر</th>
                          <th className="px-2 py-1 text-right">الحالة</th>
                          <th className="px-2 py-1 text-right">المستلمون</th>
                          <th className="px-2 py-1 text-right">عدد الحرجة</th>
                          <th className="px-2 py-1 text-right">السبب</th>
                          <th className="px-2 py-1 text-right">التاريخ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {items.slice(0, 30).map((it: any) => (
                          <tr key={it.id}>
                            <td className="px-2 py-1 text-muted-foreground">{it.id}</td>
                            <td className="px-2 py-1">{it.trigger}</td>
                            <td className="px-2 py-1">{it.status}</td>
                            <td className="px-2 py-1 font-mono">{it.recipients ?? 0}</td>
                            <td className="px-2 py-1 font-mono">{it.criticalCount ?? 0}</td>
                            <td className="px-2 py-1 font-mono text-[10px] truncate max-w-[180px]" title={it.reason ?? ""}>{it.reason || "—"}</td>
                            <td className="px-2 py-1">{String(it.ranAt ?? "").slice(0, 16).replace("T", " ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {items.length > 30 && <p className="text-[11px] text-muted-foreground p-1">عرض أول 30 من {items.length} نتيجة.</p>}
                  </div>
                </div>
              );
            }}
          />

          {/* سجل بريد التقارير القديم — fix deletes. The
              report_email_schedule_runs table is the parallel append-only
              history for the cross-company "Reports Hub" scheduler. Like
              maintenance_email_runs it is global (no company_id), so the
              count is the same regardless of the selected company; rendering
              under each company keeps the audit-log entry attributed to the
              SuperAdmin who pruned. No latestScan/trend because this tool
              isn't part of the per-company sweep. */}
          <MaintenanceTool
            toolKey="old-report-email-runs"
            label="سجل بريد التقارير القديم"
            description="محاولات إرسال تقارير الـSuperAdmin (report_email_schedule_runs) أقدم من مدة الاحتفاظ المحدّدة — حذفها يقلّص حجم سجل التدقيق دون التأثير على المحاولات الحديثة. السجل مشترك بين كل الشركات."
            icon={Trash2}
            checkEndpoint="maintenance/old-report-email-runs"
            fixEndpoint="maintenance/old-report-email-runs/fix"
            companyId={companyId}
            onFixed={onFixed}
            destructive
            latestScan={null}
            trend={undefined}
            retentionConfig={{ defaultDays: 90, min: 7, max: 3650 }}
            confirmTitle="حذف سجل بريد التقارير القديم"
            confirmDescription={(n) => `سيتم حذف ${n} محاولة إرسال ضمن مدة الاحتفاظ المحدّدة نهائياً (سجل عام لكل الشركات). متابعة؟`}
            buildFixBody={(cid) => ({ companyId: cid })}
            renderDetails={({ data }) => {
              const items = data.items ?? [];
              return (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground px-1">
                    أقدم محاولة: {data.oldest ? String(data.oldest).slice(0, 16).replace("T", " ") : "—"} ·
                    أحدث ضمن النطاق: {data.newest ? String(data.newest).slice(0, 16).replace("T", " ") : "—"}
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="px-2 py-1 text-right">#</th>
                          <th className="px-2 py-1 text-right">المصدر</th>
                          <th className="px-2 py-1 text-right">الحالة</th>
                          <th className="px-2 py-1 text-right">المستلمون</th>
                          <th className="px-2 py-1 text-right">التقارير</th>
                          <th className="px-2 py-1 text-right">الرسالة</th>
                          <th className="px-2 py-1 text-right">التاريخ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {items.slice(0, 30).map((it: any) => (
                          <tr key={it.id}>
                            <td className="px-2 py-1 text-muted-foreground">{it.id}</td>
                            <td className="px-2 py-1">{it.trigger}</td>
                            <td className="px-2 py-1">{it.status}</td>
                            <td className="px-2 py-1 font-mono">{it.recipients ?? 0}</td>
                            <td className="px-2 py-1 font-mono text-[10px] truncate max-w-[160px]" title={Array.isArray(it.reports) ? it.reports.join(", ") : ""}>{Array.isArray(it.reports) && it.reports.length ? it.reports.join(", ") : "—"}</td>
                            <td className="px-2 py-1 font-mono text-[10px] truncate max-w-[180px]" title={it.message ?? ""}>{it.message || "—"}</td>
                            <td className="px-2 py-1">{String(it.ranAt ?? "").slice(0, 16).replace("T", " ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {items.length > 30 && <p className="text-[11px] text-muted-foreground p-1">عرض أول 30 من {items.length} نتيجة.</p>}
                  </div>
                </div>
              );
            }}
          />
        </div>

        {/* History panel — last 50 maintenance actions for the selected company */}
        <div className="border rounded">
          <div className="bg-muted/40 hover:bg-muted/60 rounded-t">
            <div className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm font-medium">
              <button
                type="button"
                onClick={() => setHistoryOpen(o => !o)}
                disabled={!companyId}
                className="flex items-center gap-2 flex-1 min-w-0 py-1 text-right disabled:opacity-50"
              >
                <span className="flex items-center gap-2"><History className="h-4 w-4" /> سجل الإصلاحات</span>
              </button>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm" variant="ghost" className="h-7 text-xs gap-1"
                  onClick={() => historyCsvMut.mutate()}
                  disabled={!companyId || historyCsvMut.isPending}
                  title="تنزيل سجل الإصلاحات الكامل كملف CSV (يحترم الفلاتر أدناه)"
                >
                  {historyCsvMut.isPending
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <Download className="h-3 w-3" />}
                  تصدير CSV
                </Button>
                <button
                  type="button"
                  onClick={() => setHistoryOpen(o => !o)}
                  disabled={!companyId}
                  className="p-1 disabled:opacity-50"
                  aria-label={historyOpen ? "طي السجل" : "فتح السجل"}
                >
                  {historyOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
              </div>
            </div>
            {/* Lightweight filters — apply to BOTH the on-screen table and the
                CSV export. Empty inputs preserve original behaviour. */}
            <div className="px-3 pb-2 pt-0.5 flex flex-wrap items-end gap-2 text-[11px]">
              <div className="flex flex-col gap-0.5">
                <label className="text-muted-foreground">من تاريخ</label>
                <Input
                  type="date" value={historyFrom}
                  onChange={(e) => setHistoryFrom(e.target.value)}
                  disabled={!companyId}
                  className="h-7 w-[130px] text-xs"
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-muted-foreground">إلى تاريخ</label>
                <Input
                  type="date" value={historyTo}
                  onChange={(e) => setHistoryTo(e.target.value)}
                  disabled={!companyId}
                  className="h-7 w-[130px] text-xs"
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-muted-foreground">الإجراء</label>
                <Select
                  value={historyAction || "__all"}
                  onValueChange={(v) => setHistoryAction(v === "__all" ? "" : v)}
                  disabled={!companyId}
                >
                  <SelectTrigger className="h-7 w-[140px] text-xs">
                    <SelectValue placeholder="كل الإجراءات" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all">كل الإجراءات</SelectItem>
                    {/* Options come from the company's actual audit log so a
                        new logMaint("…") call surfaces here automatically.
                        We union in the currently-selected value so a stale
                        filter still renders its label even when no row in
                        the visible window matches it any more. */}
                    {Array.from(new Set([...facetActions, ...(historyAction ? [historyAction] : [])]))
                      .sort((a, b) => a.localeCompare(b))
                      .map((a) => (
                        <SelectItem key={a} value={a}>{historyActionLabelAr(a)}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-muted-foreground">الفئة</label>
                <Select
                  value={historyEntityType || "__all"}
                  onValueChange={(v) => setHistoryEntityType(v === "__all" ? "" : v)}
                  disabled={!companyId}
                >
                  <SelectTrigger className="h-7 w-[180px] text-xs">
                    <SelectValue placeholder="كل الفئات" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all">كل الفئات</SelectItem>
                    {Array.from(new Set([...facetEntityTypes, ...(historyEntityType ? [historyEntityType] : [])]))
                      .sort((a, b) => a.localeCompare(b))
                      .map((e) => (
                        <SelectItem key={e} value={e}>{historyEntityTypeLabelAr(e)}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              {(historyFrom || historyTo || historyAction || historyEntityType) && (
                <Button
                  size="sm" variant="ghost"
                  className="h-7 text-[11px] px-2"
                  onClick={() => {
                    setHistoryFrom(""); setHistoryTo("");
                    setHistoryAction(""); setHistoryEntityType("");
                  }}
                  title="مسح كل الفلاتر"
                >
                  مسح الفلاتر
                </Button>
              )}
            </div>
          </div>
          {historyOpen && (
            <div className="p-2.5">
              {historyQ.isLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> جارٍ تحميل السجل...
                </div>
              )}
              {historyQ.isError && (
                <p className="text-xs text-red-700">{(historyQ.error as any)?.message || "فشل جلب السجل"}</p>
              )}
              {!historyQ.isLoading && !historyQ.isError && historyItems.length === 0 && (
                <p className="text-xs text-muted-foreground">لا توجد عمليات صيانة مسجّلة لهذه الشركة بعد.</p>
              )}
              {historyItems.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-2 py-1 text-right">التاريخ</th>
                        <th className="px-2 py-1 text-right">المستخدم</th>
                        <th className="px-2 py-1 text-right">الفئة</th>
                        <th className="px-2 py-1 text-right">الإجراء</th>
                        <th className="px-2 py-1 text-right">التفاصيل</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {historyItems.map((row: any) => (
                        <tr key={row.id}>
                          <td className="px-2 py-1 whitespace-nowrap">{new Date(row.createdAt).toLocaleString("ar")}</td>
                          <td className="px-2 py-1 font-mono">{row.username || "—"}</td>
                          <td className="px-2 py-1">{row.entityType || "—"}</td>
                          <td className="px-2 py-1">{row.action}</td>
                          <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground truncate max-w-[280px]">
                            {row.metadata ? JSON.stringify(row.metadata) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {/* "Load more" pager (task #46). Only shown once we have at
                  least one row and the server signalled there's another
                  page; otherwise the row count line stands on its own so
                  admins know they're at the end of the filtered set. */}
              {historyItems.length > 0 && (
                <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>
                    {historyQ.hasNextPage
                      ? `تم عرض ${historyItems.length} صفًا`
                      : `تم عرض كل النتائج (${historyItems.length} صفًا)`}
                  </span>
                  {historyQ.hasNextPage && (
                    <Button
                      size="sm" variant="outline"
                      className="h-7 text-[11px] px-2 gap-1"
                      onClick={() => historyQ.fetchNextPage()}
                      disabled={historyQ.isFetchingNextPage}
                      title="تحميل الصفحة التالية من السجل"
                    >
                      {historyQ.isFetchingNextPage
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : null}
                      تحميل المزيد
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Tool-history drill-down modal ────────────────────────────────
            Opens when a SuperAdmin clicks a tool key in the broken-tool
            panel above. Lists the most recent 20 maintenance_runs for that
            (company, tool) pair so the operator can see whether the failure
            is recurring, intermittent, or already recovered without leaving
            the page or running an ad-hoc DB query. */}
        <Dialog
          open={!!toolHistoryTarget}
          onOpenChange={(o) => { if (!o) setToolHistoryTarget(null); }}
        >
          <DialogContent dir="rtl" className="max-w-3xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-amber-900">
                <History className="h-4 w-4" />
                آخر تشغيلات الأداة
                {toolHistoryTarget && (
                  <span className="font-mono text-xs text-amber-800">
                    {toolHistoryTarget.toolKey}
                  </span>
                )}
              </DialogTitle>
              <DialogDescription>
                {toolHistoryTarget && (
                  <span className="text-xs">
                    آخر 20 تشغيلاً لهذه الأداة على شركة{" "}
                    <span className="font-medium">
                      {toolHistoryTarget.companyName}
                    </span>{" "}
                    (#{toolHistoryTarget.companyId}). مرّر فوق رسالة الخطأ لرؤية النص الكامل.
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-2">
              {toolHistoryQ.isLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> جارٍ تحميل السجل...
                </div>
              )}
              {toolHistoryQ.isError && (
                <p className="text-xs text-red-700">
                  {(toolHistoryQ.error as any)?.message || "فشل جلب سجل الأداة"}
                </p>
              )}
              {toolHistoryQ.data && toolHistoryQ.data.items.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  لا توجد تشغيلات مسجّلة لهذه الأداة بعد.
                </p>
              )}
              {toolHistoryQ.data && toolHistoryQ.data.items.length > 0 && (
                <div className="overflow-x-auto max-h-[60vh] overflow-y-auto border rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 sticky top-0">
                      <tr>
                        <th className="px-2 py-1 text-right">الحالة</th>
                        <th className="px-2 py-1 text-right">التشغيل</th>
                        <th className="px-2 py-1 text-right">عدد النتائج</th>
                        <th className="px-2 py-1 text-right">المدة (مللي ث)</th>
                        <th className="px-2 py-1 text-right">وقت التشغيل</th>
                        <th className="px-2 py-1 text-right">رسالة الخطأ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {toolHistoryQ.data.items.map((row) => {
                        const sev =
                          row.status === "ok"       ? "bg-emerald-100 text-emerald-800" :
                          row.status === "warn"     ? "bg-amber-100  text-amber-900" :
                          row.status === "critical" ? "bg-red-100    text-red-800" :
                                                      "bg-rose-200   text-rose-900";
                        return (
                          <tr key={row.id}>
                            <td className="px-2 py-1">
                              <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${sev}`}>
                                {row.status}
                              </span>
                            </td>
                            <td className="px-2 py-1 text-[11px] text-muted-foreground">
                              {row.trigger === "manual" ? "يدوي" : "مجدول"}
                            </td>
                            <td className="px-2 py-1 font-mono">{row.count}</td>
                            <td className="px-2 py-1 font-mono">{row.durationMs}</td>
                            <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">
                              {new Date(row.runAt).toLocaleString("ar-SA")}
                            </td>
                            <td
                              className="px-2 py-1 text-amber-900 font-mono text-[10px] max-w-[260px] truncate"
                              title={row.error ?? ""}
                            >
                              {row.error
                                ? (row.error.length > 60 ? `${row.error.slice(0, 60)}…` : row.error)
                                : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
