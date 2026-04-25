import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
    case "skipped":
    case "snoozed":        return "متخطّاة (مكتومة)";
    case "rate_limited":   return "متخطّاة (ضمن فترة التهدئة)";
    case "failed":         return "فشل الإرسال";
    default:               return status ?? "—";
  }
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

  const historyQ = useQuery({
    queryKey: ["maintenance-history", companyId, historyTick],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/maintenance/history?companyId=${companyId}&limit=50`, { headers });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل جلب السجل");
      return r.json() as Promise<{ count: number; items: any[] }>;
    },
    enabled: !!companyId && historyOpen,
    refetchOnWindowFocus: false,
  });

  // CSV export — calls the same history endpoint with `?format=csv` so admins
  // get the FULL audit-logged history (not just the on-screen 50 rows). The
  // server writes a maintenance audit-log row for the export itself.
  const historyCsvMut = useMutation({
    mutationFn: async () => {
      if (!companyId) throw new Error("اختر الشركة أولاً");
      const r = await fetch(
        `${API}/api/admin/maintenance/history?companyId=${companyId}&format=csv`,
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
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Append-only email-dispatch history (last 20 attempts) — surfaces every
  // success, failure, and suppression so SuperAdmins can audit deliveries
  // without trawling server logs. Refreshed alongside the schedule card after
  // any send attempt (test, manual run-now, scheduled sweep).
  const emailHistoryQ = useQuery({
    queryKey: ["maintenance-email-history"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/maintenance/email-history?limit=20`, { headers });
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
        }>;
      }>;
    },
    refetchOnWindowFocus: false,
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

  // 14-day trend per tool — drives the sparkline beneath each card's "آخر فحص".
  // Shares the same `companyId` filter so a fleet operator sees the trend for
  // whichever tenant they're inspecting. Re-runs after a manual sweep flips
  // the latest results so the sparkline updates immediately.
  const TREND_DAYS = 14;
  const trendQ = useQuery({
    queryKey: ["maintenance-trend", companyId, TREND_DAYS],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/maintenance/trend?companyId=${companyId}&days=${TREND_DAYS}`, { headers });
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
    days: TREND_DAYS,
    points: trendByTool.get(toolKey) ?? [],
  });

  // Fleet view — top 5 active companies with the most critical findings in
  // the same window. Always available to SuperAdmins regardless of which
  // company is currently selected, so they can spot recurring offenders.
  const fleetQ = useQuery({
    queryKey: ["maintenance-trend-fleet", TREND_DAYS],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/maintenance/trend?days=${TREND_DAYS}`, { headers });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل جلب لوحة الأسطول");
      return r.json() as Promise<{
        days: number;
        fleet: Array<{ companyId: number; companyName: string; criticalCount: number; criticalRuns: number; toolCount: number; lastRunAt: string | null }>;
      }>;
    },
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
            "was the email actually sent?" alongside the most recent status. */}
        {emailHistoryQ.data && (
          <div className="border border-violet-200 rounded p-3 bg-white">
            <div className="flex items-center gap-2 mb-2">
              <History className="h-4 w-4 text-violet-700" />
              <span className="text-sm font-medium text-violet-900">سجل تنبيهات البريد</span>
              <span className="text-[11px] text-muted-foreground">
                آخر {emailHistoryQ.data.items.length} محاولة إرسال (نجاح أو فشل أو متخطّاة)
              </span>
            </div>
            {emailHistoryQ.data.items.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">لا توجد محاولات إرسال بعد.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-violet-50 text-violet-900">
                    <tr>
                      <th className="px-2 py-1 text-right">الوقت</th>
                      <th className="px-2 py-1 text-right">المصدر</th>
                      <th className="px-2 py-1 text-right">الحالة</th>
                      <th className="px-2 py-1 text-right">المستلمون</th>
                      <th className="px-2 py-1 text-right">صفوف حرجة</th>
                      <th className="px-2 py-1 text-right">تفاصيل</th>
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
                      return (
                        <tr key={row.id}>
                          <td className="px-2 py-1 text-muted-foreground whitespace-nowrap">
                            {new Date(row.ranAt).toLocaleString("ar-SA")}
                          </td>
                          <td className="px-2 py-1">{triggerLabel}</td>
                          <td className={`px-2 py-1 ${statusClass}`}>{emailStatusLabelAr(row.status)}</td>
                          <td className="px-2 py-1 font-mono">{row.recipients}</td>
                          <td className="px-2 py-1 font-mono">{row.criticalCount}</td>
                          <td className="px-2 py-1 text-muted-foreground" title={row.error ?? ""}>
                            {row.error ? <span className="text-red-700">{row.error}</span> : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
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
            description="سجلات تدقيق أقدم من سنة (audit_log) — حذفها يقلّص حجم الجدول دون التأثير على الإجراءات الحديثة."
            icon={ScrollText}
            checkEndpoint="maintenance/old-audit-logs"
            fixEndpoint="maintenance/old-audit-logs/fix"
            companyId={companyId}
            onFixed={onFixed}
            destructive
            latestScan={latestByTool.get("old-audit-logs") ?? null}
            trend={trendForTool("old-audit-logs")}
            confirmTitle="حذف سجلات التدقيق القديمة"
            confirmDescription={(n) => `سيتم حذف ${n} سجل تدقيق أقدم من 365 يوماً نهائياً. متابعة؟`}
            buildFixBody={(cid) => ({ companyId: cid, days: 365 })}
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
            description="نتائج فحص صيانة أقدم من 90 يوماً (maintenance_runs) — حذفها يحافظ على لوحة المؤشرات سريعة."
            icon={Trash2}
            checkEndpoint="maintenance/old-maintenance-runs"
            fixEndpoint="maintenance/old-maintenance-runs/fix"
            companyId={companyId}
            onFixed={onFixed}
            destructive
            latestScan={latestByTool.get("old-maintenance-runs") ?? null}
            trend={trendForTool("old-maintenance-runs")}
            confirmTitle="حذف سجلات تشغيل الصيانة القديمة"
            confirmDescription={(n) => `سيتم حذف ${n} نتيجة فحص أقدم من 90 يوماً نهائياً. متابعة؟`}
            buildFixBody={(cid) => ({ companyId: cid, days: 90 })}
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
        </div>

        {/* History panel — last 50 maintenance actions for the selected company */}
        <div className="border rounded">
          <div className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm font-medium bg-muted/40 hover:bg-muted/60 rounded-t">
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
                title="تنزيل سجل الإصلاحات الكامل كملف CSV"
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
              {historyQ.data && historyQ.data.items.length === 0 && (
                <p className="text-xs text-muted-foreground">لا توجد عمليات صيانة مسجّلة لهذه الشركة بعد.</p>
              )}
              {historyQ.data && historyQ.data.items.length > 0 && (
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
                      {historyQ.data.items.map((row: any) => (
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
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
