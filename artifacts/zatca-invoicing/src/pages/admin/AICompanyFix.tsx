import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sparkles, Search, AlertTriangle, AlertCircle, Info, CheckCircle2, Loader2, Send,
  Network, RefreshCw, Server, Database, LayoutGrid, MonitorSmartphone, ChevronDown, ChevronRight,
} from "lucide-react";

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

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">اختر الشركة وافحص</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
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
