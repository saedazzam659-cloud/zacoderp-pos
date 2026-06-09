import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, Search, Building2, KeyRound, Save, Calendar as CalIcon,
  Users as UsersIcon, GitBranch, Warehouse, FileText, DollarSign,
  ShieldCheck, CheckCircle2, XCircle, Sparkles, Crown, Star, Zap,
  AlertTriangle, Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Company = { id: number; nameAr: string; nameEn?: string; vatNumber: string; status?: string };
type Subscription = {
  id: number; companyId: number;
  plan: string; billingCycle: "monthly" | "yearly";
  startDate: string; endDate: string; isActive: boolean;
  price: string;
  maxUsers: number; maxBranches: number; maxWarehouses: number; maxInvoices: number;
};
type SubRow = { subscription: Subscription; company: Pick<Company, "id" | "nameAr" | "vatNumber" | "status"> | null };

// ─── Plan presets ──────────────────────────────────────────────────────
const PLAN_PRESETS: Record<string, {
  label: string; icon: any; color: string; gradient: string;
  maxUsers: number; maxBranches: number; maxWarehouses: number; maxInvoices: number;
  monthly: string; yearly: string;
}> = {
  starter: {
    label: "البداية", icon: Star, color: "text-blue-600",
    gradient: "from-blue-500 to-cyan-500",
    maxUsers: 2, maxBranches: 1, maxWarehouses: 1, maxInvoices: 100,
    monthly: "99", yearly: "990",
  },
  professional: {
    label: "احترافي", icon: Zap, color: "text-purple-600",
    gradient: "from-purple-500 to-pink-500",
    maxUsers: 10, maxBranches: 3, maxWarehouses: 5, maxInvoices: 1000,
    monthly: "299", yearly: "2990",
  },
  enterprise: {
    label: "المؤسسات", icon: Crown, color: "text-amber-600",
    gradient: "from-amber-500 to-orange-500",
    maxUsers: 999, maxBranches: 999, maxWarehouses: 999, maxInvoices: 999999,
    monthly: "899", yearly: "8990",
  },
  custom: {
    label: "مخصص", icon: Sparkles, color: "text-indigo-600",
    gradient: "from-indigo-500 to-purple-600",
    maxUsers: 5, maxBranches: 2, maxWarehouses: 2, maxInvoices: 500,
    monthly: "0", yearly: "0",
  },
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const isValidISO = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
const addMonths = (d: string, m: number) => {
  if (!isValidISO(d)) return d;
  const date = new Date(d); date.setMonth(date.getMonth() + m);
  return isNaN(date.getTime()) ? d : date.toISOString().slice(0, 10);
};

const emptyForm = () => ({
  companyId: 0,
  plan: "professional" as keyof typeof PLAN_PRESETS,
  billingCycle: "monthly" as "monthly" | "yearly",
  startDate: todayISO(),
  endDate: addMonths(todayISO(), 1),
  isActive: true,
  price: PLAN_PRESETS.professional.monthly,
  maxUsers: PLAN_PRESETS.professional.maxUsers,
  maxBranches: PLAN_PRESETS.professional.maxBranches,
  maxWarehouses: PLAN_PRESETS.professional.maxWarehouses,
  maxInvoices: PLAN_PRESETS.professional.maxInvoices,
});

export default function LicenseManagement() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token ?? ""}`,
    "Content-Type": "application/json",
  };

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm());

  // ─── Subscription-notice settings (global, all companies) ───────
  // Pre-expiry banner threshold + post-expiry login grace + contact info
  // shown to tenants with the expiry message. SuperAdmin-only endpoints.
  const { data: notice } = useQuery({
    queryKey: ["admin-subscription-notice"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/system-settings/subscription-notice`, { headers });
      if (!r.ok) throw new Error("failed");
      return r.json() as Promise<{ warningDays: number; graceDays: number; contactInfo: string }>;
    },
  });
  const [noticeForm, setNoticeForm] = useState<{ warningDays: string; graceDays: string; contactInfo: string } | null>(null);
  useEffect(() => {
    if (notice && noticeForm === null) {
      setNoticeForm({
        warningDays: String(notice.warningDays),
        graceDays: String(notice.graceDays),
        contactInfo: notice.contactInfo ?? "",
      });
    }
  }, [notice, noticeForm]);
  const setNoticeField = (k: "warningDays" | "graceDays" | "contactInfo", v: string) =>
    setNoticeForm(f => ({ warningDays: "7", graceDays: "0", contactInfo: "", ...(f ?? {}), [k]: v }));
  const noticeMutation = useMutation({
    mutationFn: async (body: { warningDays: number; graceDays: number; contactInfo: string }) => {
      const r = await fetch(`${API}/api/admin/system-settings/subscription-notice`, {
        method: "PUT", headers, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "حدث خطأ");
      return j;
    },
    onSuccess: () => {
      toast({ title: "✓ تم حفظ إعدادات تنبيه الاشتراك" });
      qc.invalidateQueries({ queryKey: ["admin-subscription-notice"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // ─── Data ────────────────────────────────────────────────────
  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["companies-list"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/companies`, { headers });
      if (!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d) ? d.map((x: any) => x.company ?? x) : [];
    },
  });

  const { data: subs = [], isLoading: subsLoading } = useQuery<SubRow[]>({
    queryKey: ["admin-subscriptions"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/subscriptions`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const subByCompany = useMemo(() => {
    const m = new Map<number, Subscription>();
    for (const row of subs) if (row.subscription) m.set(row.subscription.companyId, row.subscription);
    return m;
  }, [subs]);

  // Auto-select first company
  useEffect(() => {
    if (selectedId == null && companies.length > 0) setSelectedId(companies[0].id);
  }, [companies, selectedId]);

  // Track the last (selectedId + subId) we hydrated, so we re-hydrate
  // when a sub appears for the selected company, but never overwrite user edits otherwise.
  const lastLoadedRef = useRef<string | null>(null);

  const hydrateFromSub = (id: number, ex?: Subscription) => {
    if (ex) {
      setForm({
        companyId: id,
        plan: (ex.plan as any) ?? "custom",
        billingCycle: (ex.billingCycle as any) ?? "monthly",
        startDate: ex.startDate,
        endDate: ex.endDate,
        isActive: ex.isActive,
        price: String(ex.price ?? "0"),
        maxUsers: ex.maxUsers,
        maxBranches: ex.maxBranches ?? 1,
        maxWarehouses: ex.maxWarehouses ?? 1,
        maxInvoices: ex.maxInvoices,
      });
    } else {
      setForm({ ...emptyForm(), companyId: id });
    }
  };

  // Hydrate when company changes, OR when a sub first appears for the selected company.
  // Wait until subs query has settled at least once so we don't hydrate empty.
  useEffect(() => {
    if (!selectedId) return;
    if (subsLoading) return;
    const ex = subByCompany.get(selectedId);
    const key = `${selectedId}:${ex?.id ?? "none"}`;
    if (lastLoadedRef.current === key) return;
    lastLoadedRef.current = key;
    hydrateFromSub(selectedId, ex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, subs, subsLoading]);

  // ─── Helpers ─────────────────────────────────────────────────
  const applyPlan = (planKey: keyof typeof PLAN_PRESETS) => {
    const p = PLAN_PRESETS[planKey];
    setForm(f => ({
      ...f,
      plan: planKey,
      maxUsers: p.maxUsers, maxBranches: p.maxBranches,
      maxWarehouses: p.maxWarehouses, maxInvoices: p.maxInvoices,
      price: f.billingCycle === "yearly" ? p.yearly : p.monthly,
    }));
  };

  const setCycle = (cycle: "monthly" | "yearly") => {
    setForm(f => {
      const months = cycle === "yearly" ? 12 : 1;
      const newEnd = addMonths(f.startDate, months);
      const preset = PLAN_PRESETS[f.plan];
      return {
        ...f,
        billingCycle: cycle,
        endDate: newEnd,
        price: cycle === "yearly" ? preset.yearly : preset.monthly,
      };
    });
  };

  const setStart = (d: string) => {
    setForm(f => ({
      ...f,
      startDate: d,
      endDate: isValidISO(d) ? addMonths(d, f.billingCycle === "yearly" ? 12 : 1) : f.endDate,
    }));
  };

  // Quick-extend buttons
  const extend = (months: number) => {
    setForm(f => ({ ...f, endDate: addMonths(f.endDate, months) }));
  };

  // ─── Save ────────────────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/licenses`, {
        method: "POST",
        headers,
        body: JSON.stringify(form),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "فشل الحفظ");
      return data;
    },
    onSuccess: (d: any) => {
      toast({
        title: d.action === "created" ? "تم إنشاء الترخيص" : "تم تحديث الترخيص",
        description: "تم حفظ بيانات الترخيص بنجاح",
      });
      qc.invalidateQueries({ queryKey: ["admin-subscriptions"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  // ─── Filtered companies ──────────────────────────────────────
  const filteredCompanies = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return companies;
    return companies.filter(c =>
      c.nameAr?.toLowerCase().includes(s) ||
      c.nameEn?.toLowerCase().includes(s) ||
      c.vatNumber?.includes(s),
    );
  }, [companies, search]);

  // ─── Status helpers ──────────────────────────────────────────
  const statusOf = (sub?: Subscription) => {
    if (!sub) return { label: "بدون ترخيص", cls: "bg-gray-100 text-gray-700 border-gray-300" };
    if (!sub.isActive) return { label: "موقوف", cls: "bg-red-100 text-red-700 border-red-300" };
    const days = Math.ceil((new Date(sub.endDate).getTime() - Date.now()) / 86400000);
    if (days < 0) return { label: "منتهي", cls: "bg-red-100 text-red-700 border-red-300" };
    if (days <= 7) return { label: `ينتهي خلال ${days} يوم`, cls: "bg-amber-100 text-amber-800 border-amber-300" };
    return { label: "نشط", cls: "bg-emerald-100 text-emerald-700 border-emerald-300" };
  };

  const selected = useMemo(
    () => companies.find(c => c.id === selectedId) ?? null,
    [companies, selectedId],
  );
  const existingSub = selected ? subByCompany.get(selected.id) : undefined;

  // Days remaining for header
  const daysRemaining = useMemo(() => {
    if (!isValidISO(form.endDate)) return null;
    return Math.ceil((new Date(form.endDate).getTime() - Date.now()) / 86400000);
  }, [form.endDate]);

  return (
    <div className="space-y-5" dir="rtl">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-xl bg-gradient-to-br from-amber-500 via-orange-500 to-red-500 text-white shadow-md">
          <KeyRound className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">ترخيص النسخة</h1>
          <p className="text-sm text-muted-foreground">
            إدارة تراخيص الشركات — المدة، الباقة، وحدود الاستخدام
          </p>
        </div>
      </div>

      {/* ─── Global subscription-notice settings ───────────────── */}
      <Card className="border-amber-200 dark:border-amber-900">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <h2 className="font-semibold text-sm">إعدادات تنبيه انتهاء الاشتراك</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            تتحكم في تنبيه قرب الانتهاء داخل النظام، وفترة السماح بعد الانتهاء قبل منع الدخول،
            وبيانات التواصل التي تظهر للشركات مع رسالة الانتهاء. تُطبَّق على كل الشركات.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">التنبيه قبل الانتهاء (يوم)</Label>
              <Input
                type="number" min={0}
                value={noticeForm?.warningDays ?? ""}
                onChange={e => setNoticeField("warningDays", e.target.value)}
                className="mt-1"
              />
              <p className="text-[11px] text-muted-foreground mt-1">يظهر بانر في الشاشة الرئيسية قبل الانتهاء بهذه المدة.</p>
            </div>
            <div>
              <Label className="text-xs">فترة السماح بعد الانتهاء (يوم)</Label>
              <Input
                type="number" min={0}
                value={noticeForm?.graceDays ?? ""}
                onChange={e => setNoticeField("graceDays", e.target.value)}
                className="mt-1"
              />
              <p className="text-[11px] text-muted-foreground mt-1">٠ = منع الدخول فور انتهاء آخر يوم.</p>
            </div>
          </div>
          <div>
            <Label className="text-xs">بيانات التواصل وأرقام الهواتف (تظهر مع رسالة الانتهاء)</Label>
            <textarea
              rows={3}
              value={noticeForm?.contactInfo ?? ""}
              onChange={e => setNoticeField("contactInfo", e.target.value)}
              placeholder="مثال: للتجديد تواصل مع قسم المبيعات: 0501234567 — sales@example.com"
              className="mt-1 flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!noticeForm || noticeMutation.isPending}
              onClick={() => noticeForm && noticeMutation.mutate({
                warningDays: Math.max(0, Math.floor(Number(noticeForm.warningDays) || 0)),
                graceDays: Math.max(0, Math.floor(Number(noticeForm.graceDays) || 0)),
                contactInfo: noticeForm.contactInfo,
              })}
            >
              <Save className="h-3.5 w-3.5 ml-1" />
              حفظ الإعدادات
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">

        {/* ─── Companies sidebar ─────────────────────────── */}
        <Card className="h-fit lg:sticky lg:top-4 max-h-[calc(100vh-6rem)] overflow-hidden flex flex-col">
          <div className="p-3 border-b bg-muted/30">
            <div className="relative mb-2">
              <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="ابحث عن شركة..."
                className="h-8 pr-8 text-sm"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              <Building2 className="h-3 w-3 inline ml-1" />
              {filteredCompanies.length} شركة
            </p>
          </div>
          <div className="overflow-y-auto flex-1 p-2 space-y-1">
            {filteredCompanies.map(c => {
              const sub = subByCompany.get(c.id);
              const st = statusOf(sub);
              const isSel = c.id === selectedId;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    "w-full text-right p-2.5 rounded-lg border transition-all",
                    isSel
                      ? "bg-gradient-to-l from-amber-50 to-orange-50 border-amber-300 shadow-sm dark:from-amber-950/40 dark:to-orange-950/40"
                      : "bg-card hover:bg-muted/50 border-transparent",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className={cn("font-medium text-sm truncate", isSel && "text-amber-700 dark:text-amber-400")}>
                        {c.nameAr}
                      </p>
                      <p className="text-[11px] font-mono text-muted-foreground truncate" dir="ltr">
                        {c.vatNumber}
                      </p>
                    </div>
                    <Badge variant="outline" className={cn("shrink-0 text-[10px] h-5 px-1.5", st.cls)}>
                      {st.label}
                    </Badge>
                  </div>
                </button>
              );
            })}
            {filteredCompanies.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-8">
                لا توجد نتائج
              </div>
            )}
          </div>
        </Card>

        {/* ─── Editor panel ──────────────────────────────── */}
        {!selected ? (
          <Card><CardContent className="py-20 text-center text-muted-foreground">
            <KeyRound className="h-12 w-12 mx-auto mb-3 opacity-30" />
            اختر شركة من القائمة للبدء
          </CardContent></Card>
        ) : (
          <div className="space-y-5">

            {/* ─── Company header card ────────────────── */}
            <Card className="overflow-hidden border-2 border-amber-200 dark:border-amber-900">
              <div className="bg-gradient-to-l from-amber-50 via-orange-50 to-red-50 dark:from-amber-950/40 dark:via-orange-950/40 dark:to-red-950/40 p-5 border-b border-amber-200 dark:border-amber-900">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-3 rounded-xl bg-white shadow-sm">
                      <Building2 className="h-6 w-6 text-amber-600" />
                    </div>
                    <div className="min-w-0">
                      <h2 className="font-bold text-xl truncate">{selected.nameAr}</h2>
                      <p className="text-xs text-muted-foreground font-mono" dir="ltr">
                        VAT: {selected.vatNumber}
                      </p>
                    </div>
                  </div>
                  {existingSub ? (
                    <Badge className={cn("text-sm px-3 py-1.5", statusOf(existingSub).cls)}>
                      <ShieldCheck className="h-3.5 w-3.5 ml-1" />
                      {statusOf(existingSub).label}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-sm px-3 py-1.5 border-dashed">
                      ترخيص جديد
                    </Badge>
                  )}
                </div>
              </div>

              {/* Plan selector cards */}
              <CardContent className="p-5 space-y-5">
                <div>
                  <Label className="text-sm font-semibold mb-3 block flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-amber-500" /> اختر الباقة
                  </Label>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    {(Object.entries(PLAN_PRESETS) as Array<[keyof typeof PLAN_PRESETS, typeof PLAN_PRESETS[keyof typeof PLAN_PRESETS]]>).map(([key, p]) => {
                      const isOn = form.plan === key;
                      const Icon = p.icon;
                      return (
                        <button
                          key={key}
                          onClick={() => applyPlan(key)}
                          className={cn(
                            "p-3 rounded-xl border-2 text-right transition-all",
                            isOn
                              ? "border-amber-400 shadow-md scale-[1.02] bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/40 dark:to-orange-950/40"
                              : "border-border hover:border-amber-200 hover:bg-muted/30",
                          )}
                        >
                          <div className={cn("p-2 rounded-lg w-fit mb-2 bg-gradient-to-br text-white", p.gradient)}>
                            <Icon className="h-4 w-4" />
                          </div>
                          <div className="font-bold text-sm">{p.label}</div>
                          <div className="text-[11px] text-muted-foreground mt-1">
                            {p.maxUsers === 999 ? "∞" : p.maxUsers} مستخدم • {p.maxInvoices === 999999 ? "∞" : p.maxInvoices} فاتورة
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Billing cycle */}
                <div>
                  <Label className="text-sm font-semibold mb-3 block flex items-center gap-2">
                    <CalIcon className="h-4 w-4 text-amber-500" /> دورة الفوترة
                  </Label>
                  <div className="grid grid-cols-2 gap-3">
                    {([
                      { v: "monthly", label: "شهري", sub: "تجديد كل شهر" },
                      { v: "yearly",  label: "سنوي",  sub: "خصم خاص — وفّر 17%" },
                    ] as const).map(opt => {
                      const isOn = form.billingCycle === opt.v;
                      return (
                        <button
                          key={opt.v}
                          onClick={() => setCycle(opt.v)}
                          className={cn(
                            "p-4 rounded-xl border-2 text-right transition-all relative",
                            isOn
                              ? "border-amber-400 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/40 dark:to-orange-950/40 shadow-md"
                              : "border-border hover:border-amber-200 hover:bg-muted/30",
                          )}
                        >
                          <div className="font-bold">{opt.label}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{opt.sub}</div>
                          {isOn && (
                            <CheckCircle2 className="h-5 w-5 text-amber-600 absolute top-3 left-3" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Dates + price */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <Label className="flex items-center gap-1 mb-1.5">
                      <CalIcon className="h-3.5 w-3.5" /> تاريخ البدء
                    </Label>
                    <Input type="date" value={form.startDate} onChange={(e) => setStart(e.target.value)} />
                  </div>
                  <div>
                    <Label className="flex items-center gap-1 mb-1.5">
                      <CalIcon className="h-3.5 w-3.5" /> تاريخ الانتهاء
                    </Label>
                    <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
                    {daysRemaining !== null && (
                      <p className={cn(
                        "text-xs mt-1 flex items-center gap-1",
                        daysRemaining < 0 ? "text-red-600" :
                        daysRemaining <= 7 ? "text-amber-600" : "text-emerald-600",
                      )}>
                        <Clock className="h-3 w-3" />
                        {daysRemaining < 0
                          ? `منتهي منذ ${Math.abs(daysRemaining)} يوم`
                          : `${daysRemaining} يوم متبقي`}
                      </p>
                    )}
                  </div>
                  <div>
                    <Label className="flex items-center gap-1 mb-1.5">
                      <DollarSign className="h-3.5 w-3.5" /> السعر (ر.س) {form.billingCycle === "yearly" ? "/ سنة" : "/ شهر"}
                    </Label>
                    <Input
                      type="number" min={0} step="0.01"
                      value={form.price}
                      onChange={(e) => setForm({ ...form, price: e.target.value })}
                      className="font-mono"
                    />
                  </div>
                </div>

                {/* Quick-extend */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">تمديد سريع:</span>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => extend(1)}>+ شهر</Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => extend(3)}>+ 3 أشهر</Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => extend(6)}>+ 6 أشهر</Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => extend(12)}>+ سنة</Button>
                </div>
              </CardContent>
            </Card>

            {/* ─── Limits card ────────────────────────── */}
            <Card>
              <CardContent className="p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-amber-500" />
                  <h3 className="font-semibold">حدود الاستخدام</h3>
                  <span className="text-xs text-muted-foreground">— استخدم 0 أو 999999 لإزالة الحد</span>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <LimitField
                    icon={UsersIcon} color="blue"
                    label="عدد المستخدمين" value={form.maxUsers}
                    onChange={(v) => setForm({ ...form, maxUsers: v })}
                  />
                  <LimitField
                    icon={GitBranch} color="emerald"
                    label="عدد الفروع" value={form.maxBranches}
                    onChange={(v) => setForm({ ...form, maxBranches: v })}
                  />
                  <LimitField
                    icon={Warehouse} color="amber"
                    label="عدد المخازن" value={form.maxWarehouses}
                    onChange={(v) => setForm({ ...form, maxWarehouses: v })}
                  />
                  <LimitField
                    icon={FileText} color="purple"
                    label="عدد الفواتير / شهر" value={form.maxInvoices}
                    onChange={(v) => setForm({ ...form, maxInvoices: v })}
                  />
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
                  <div className="flex items-center gap-2">
                    {form.isActive ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    ) : (
                      <XCircle className="h-5 w-5 text-red-600" />
                    )}
                    <div>
                      <div className="font-semibold text-sm">
                        {form.isActive ? "الترخيص نشط" : "الترخيص موقوف"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {form.isActive
                          ? "تستطيع الشركة تسجيل الدخول واستخدام النظام"
                          : "تسجيل الدخول معطّل لجميع مستخدمي الشركة"}
                      </div>
                    </div>
                  </div>
                  <Switch checked={form.isActive} onCheckedChange={(v) => setForm({ ...form, isActive: v })} />
                </div>

                {/* Warnings */}
                {existingSub && (form.maxUsers < 999 || form.maxBranches < 999) && (
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 flex items-start gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      تأكد أن عدد الكيانات الحالية لا يتعدى الحدود الجديدة، وإلا سيظهر للمستخدمين تحذير عند تجاوز الحد.
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ─── Save bar ───────────────────────────── */}
            <div className="sticky bottom-0 bg-background/80 backdrop-blur-md border-t -mx-6 px-6 py-3 z-10">
              <div className="flex justify-end gap-2">
                <Button
                  size="lg"
                  onClick={() => saveMut.mutate()}
                  disabled={saveMut.isPending}
                  className="gap-2 bg-gradient-to-l from-amber-600 via-orange-600 to-red-600 hover:from-amber-700 hover:via-orange-700 hover:to-red-700 shadow-md min-w-[200px]"
                >
                  {saveMut.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
                  {existingSub ? "تحديث الترخيص" : "إنشاء الترخيص"}
                </Button>
              </div>
            </div>
          </div>
        )}

      </div>

      {subsLoading && (
        <div className="fixed bottom-4 left-4 bg-card border rounded-lg shadow-lg px-3 py-2 text-xs flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" /> جاري التحميل...
        </div>
      )}
    </div>
  );
}

// ─── Limit field component ───────────────────────────────────────────────
function LimitField({
  icon: Icon, color, label, value, onChange,
}: {
  icon: any; color: "blue" | "emerald" | "amber" | "purple";
  label: string; value: number; onChange: (v: number) => void;
}) {
  const cls = {
    blue:    "from-blue-500 to-cyan-500 text-blue-600 bg-blue-50 dark:bg-blue-950/30 border-blue-200",
    emerald: "from-emerald-500 to-green-500 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200",
    amber:   "from-amber-500 to-orange-500 text-amber-600 bg-amber-50 dark:bg-amber-950/30 border-amber-200",
    purple:  "from-purple-500 to-pink-500 text-purple-600 bg-purple-50 dark:bg-purple-950/30 border-purple-200",
  }[color];
  const isUnlimited = value >= 999;
  return (
    <div className={cn("p-3 rounded-xl border", cls.split(" ").slice(2).join(" "))}>
      <div className="flex items-center gap-2 mb-2">
        <div className={cn("p-1.5 rounded-md bg-gradient-to-br text-white", cls.split(" ").slice(0, 2).join(" "))}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <Label className="text-xs font-semibold">{label}</Label>
      </div>
      <Input
        type="number" min={0}
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="font-mono font-bold text-lg h-9"
      />
      <div className="flex items-center justify-between mt-1.5">
        <button
          onClick={() => onChange(999999)}
          className="text-[10px] text-muted-foreground hover:underline"
        >
          غير محدود
        </button>
        {isUnlimited && (
          <Badge variant="outline" className="text-[10px] h-4 px-1">∞</Badge>
        )}
      </div>
    </div>
  );
}
