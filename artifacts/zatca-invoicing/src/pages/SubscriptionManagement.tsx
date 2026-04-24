import { useState, useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Package, Search, RefreshCw, CheckCircle2, XCircle,
  Calendar, Users, FileText, ChevronDown, ChevronUp, BadgeCheck,
  CalendarPlus, Repeat, AlertTriangle, Zap, ShieldAlert, PlayCircle, PauseCircle
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const PLANS = [
  { key: "starter",      label: "مبتدئ",     color: "bg-blue-50 text-blue-700 border-blue-200",    maxUsers: 1,   maxInvoices: 50,     price: "99" },
  { key: "professional", label: "احترافي",   color: "bg-primary/10 text-primary border-primary/20", maxUsers: 5,   maxInvoices: 500,    price: "299" },
  { key: "enterprise",   label: "مؤسسي",     color: "bg-amber-50 text-amber-700 border-amber-200",  maxUsers: 999, maxInvoices: 999999, price: "899" },
];

const PLAN_MAP = Object.fromEntries(PLANS.map(p => [p.key, p]));

const EXTEND_OPTIONS = [
  { months: 1,  label: "+ شهر" },
  { months: 3,  label: "+ 3 أشهر" },
  { months: 6,  label: "+ 6 أشهر" },
  { months: 12, label: "+ سنة" },
];

const TABS = [
  { key: "all",       label: "الكل" },
  { key: "active",    label: "نشطة" },
  { key: "expiring",  label: "تنتهي قريباً (≤30 يوم)" },
  { key: "expired",   label: "منتهية" },
] as const;

type TabKey = typeof TABS[number]["key"];

function daysUntil(iso?: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso + "T00:00:00").getTime();
  if (isNaN(t)) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((t - today.getTime()) / 86_400_000);
}

function StatCard({ label, value, sub, icon: Icon, iconBg, iconColor, border }: any) {
  return (
    <div className={cn("rounded-xl border bg-card p-4 flex items-center gap-3", border)}>
      <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center shrink-0", iconBg)}>
        <Icon className={cn("h-5 w-5", iconColor)} />
      </div>
      <div>
        <p className="text-2xl font-bold tabular-nums">{value ?? "—"}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
        {sub && <p className="text-[11px] text-muted-foreground/70 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function StatusBadge({ sub, companyStatus }: { sub: any; companyStatus?: string | null }) {
  if (companyStatus === "suspended") {
    return (
      <span className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit bg-red-50 text-red-700 border-red-300">
        <ShieldAlert className="h-3 w-3" />الشركة موقوفة
      </span>
    );
  }
  if (!sub?.isActive) {
    return (
      <span className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit bg-zinc-100 text-zinc-700 border-zinc-300">
        <PauseCircle className="h-3 w-3" />مجمّد
      </span>
    );
  }
  const d = daysUntil(sub?.endDate);
  if (d == null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit bg-green-50 text-green-700 border-green-200">
        <CheckCircle2 className="h-3 w-3" />نشط
      </span>
    );
  }
  if (d < 0)  return (
    <span className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit bg-red-50 text-red-700 border-red-200">
      <XCircle className="h-3 w-3" />منتهي منذ {Math.abs(d)} يوم
    </span>
  );
  if (d <= 7) return (
    <span className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit bg-red-50 text-red-700 border-red-200">
      <AlertTriangle className="h-3 w-3" />ينتهي خلال {d} يوم
    </span>
  );
  if (d <= 30) return (
    <span className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit bg-amber-50 text-amber-800 border-amber-200">
      <AlertTriangle className="h-3 w-3" />ينتهي خلال {d} يوم
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit bg-green-50 text-green-700 border-green-200">
      <CheckCircle2 className="h-3 w-3" />نشط · {d} يوم
    </span>
  );
}

export default function SubscriptionManagement() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [search, setSearch]             = useState("");
  const [planFilter, setPlanFilter]     = useState("all");
  const [tab, setTab]                   = useState<TabKey>("all");
  const [expandedRow, setExpandedRow]   = useState<number | null>(null);
  const [selected, setSelected]         = useState<Set<number>>(new Set());
  const [bulkMonths, setBulkMonths]     = useState<number>(1);
  const [extendForms, setExtendForms]   = useState<Record<number, number>>({});
  const [planForms, setPlanForms]       = useState<Record<number, { plan: string; cycle: "monthly" | "yearly" }>>({});
  const [overLimitOpen, setOverLimitOpen] = useState(false);
  const [upgradeForId, setUpgradeForId] = useState<number | null>(null);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ["admin-subscriptions"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/subscriptions`, { headers });
      return res.json();
    },
  });

  const { data: usage = [] } = useQuery({
    queryKey: ["admin-subscriptions-usage"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/subscriptions/usage`, { headers });
      return res.json();
    },
  });

  const { data: autoSuspend, refetch: refetchAutoSuspend } = useQuery({
    queryKey: ["admin-auto-suspend"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/system-settings/auto-suspend`, { headers });
      return res.json();
    },
  });

  // Map: companyId → usage row
  const usageByCompany = useMemo(() => {
    const m = new Map<number, any>();
    for (const u of usage as any[]) m.set(u.companyId, u);
    return m;
  }, [usage]);

  // Mutations
  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      const res = await fetch(`${API}/api/admin/subscriptions/${id}`, {
        method: "PUT", headers, body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "حدث خطأ");
      return json;
    },
    onSuccess: () => {
      toast({ title: "✓ تم تحديث الاشتراك بنجاح" });
      qc.invalidateQueries({ queryKey: ["admin-subscriptions"] });
      qc.invalidateQueries({ queryKey: ["admin-subscriptions-usage"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const extendMutation = useMutation({
    mutationFn: async ({ id, months }: { id: number; months: number }) => {
      const res = await fetch(`${API}/api/admin/subscriptions/${id}/extend`, {
        method: "POST", headers, body: JSON.stringify({ months }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "حدث خطأ");
      return json;
    },
    onSuccess: (_, vars) => {
      toast({ title: `✓ تم تمديد الاشتراك ${vars.months} شهر` });
      qc.invalidateQueries({ queryKey: ["admin-subscriptions"] });
      qc.invalidateQueries({ queryKey: ["admin-subscriptions-usage"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const changePlanMutation = useMutation({
    mutationFn: async ({ id, planKey, billingCycle }: { id: number; planKey: string; billingCycle: string }) => {
      const res = await fetch(`${API}/api/admin/subscriptions/${id}/change-plan`, {
        method: "POST", headers, body: JSON.stringify({ planKey, billingCycle }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "حدث خطأ");
      return json;
    },
    onSuccess: () => {
      toast({ title: "✓ تم تبديل الباقة" });
      qc.invalidateQueries({ queryKey: ["admin-subscriptions"] });
      qc.invalidateQueries({ queryKey: ["admin-subscriptions-usage"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const bulkExtendMutation = useMutation({
    mutationFn: async ({ ids, months }: { ids: number[]; months: number }) => {
      const res = await fetch(`${API}/api/admin/subscriptions/bulk-extend`, {
        method: "POST", headers, body: JSON.stringify({ ids, months }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "حدث خطأ");
      return json;
    },
    onSuccess: (data: any) => {
      toast({ title: `✓ تم تمديد ${data.processed} اشتراك` });
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["admin-subscriptions"] });
      qc.invalidateQueries({ queryKey: ["admin-subscriptions-usage"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const bulkFreezeMutation = useMutation({
    mutationFn: async ({ ids, isActive }: { ids: number[]; isActive: boolean }) => {
      const res = await fetch(`${API}/api/admin/subscriptions/bulk-freeze`, {
        method: "POST", headers, body: JSON.stringify({ ids, isActive }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "حدث خطأ");
      return json;
    },
    onSuccess: (data: any) => {
      toast({ title: `✓ تم ${data.isActive ? "تفعيل" : "تجميد"} ${data.processed} اشتراك` });
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["admin-subscriptions"] });
      qc.invalidateQueries({ queryKey: ["admin-subscriptions-usage"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const autoSuspendMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch(`${API}/api/admin/system-settings/auto-suspend`, {
        method: "PUT", headers, body: JSON.stringify({ enabled }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "حدث خطأ");
      return json;
    },
    onSuccess: (data: any) => {
      toast({ title: data.enabled ? "✓ تم تفعيل الإيقاف التلقائي" : "✓ تم إيقاف الإيقاف التلقائي" });
      refetchAutoSuspend();
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Filtering
  const filtered = useMemo(() => (rows as any[]).filter((r: any) => {
    const sub = r.subscription;
    const matchSearch =
      r.company?.nameAr?.includes(search) ||
      r.company?.vatNumber?.includes(search);
    const matchPlan =
      planFilter === "all" || sub?.plan === planFilter;
    if (!matchSearch || !matchPlan) return false;

    const d = daysUntil(sub?.endDate);
    if (tab === "active")    return sub?.isActive && (d == null || d >= 0);
    if (tab === "expiring")  return sub?.isActive && d != null && d >= 0 && d <= 30;
    if (tab === "expired")   return d != null && d < 0;
    return true;
  }), [rows, search, planFilter, tab]);

  // Stats
  const total   = (rows as any[]).length;
  const active  = (rows as any[]).filter((r: any) => r.subscription?.isActive).length;
  const expiringSoon = (rows as any[]).filter((r: any) => {
    const d = daysUntil(r.subscription?.endDate);
    return r.subscription?.isActive && d != null && d >= 0 && d <= 30;
  }).length;
  const expired = (rows as any[]).filter((r: any) => {
    const d = daysUntil(r.subscription?.endDate);
    return d != null && d < 0;
  }).length;
  const overLimitCount = (usage as any[]).filter(u => u.overLimit).length;

  const allFilteredIds = filtered.map((r: any) => r.subscription?.id).filter(Boolean) as number[];
  const allSelectedOnPage = allFilteredIds.length > 0 && allFilteredIds.every(id => selected.has(id));
  const toggleAll = () => {
    if (allSelectedOnPage) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allFilteredIds));
    }
  };
  const toggleOne = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const overLimitRows = (usage as any[]).filter(u => u.overLimit);

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package className="h-6 w-6 text-primary" />إدارة الاشتراكات والباقات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">دورة حياة الاشتراك، التمديد، تبديل الباقة، والاستهلاك مقابل الحدود</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs bg-card border rounded-lg px-3 py-1.5 cursor-pointer">
            <Checkbox
              checked={!!autoSuspend?.enabled}
              onCheckedChange={(v) => autoSuspendMutation.mutate(!!v)}
            />
            <span className="font-medium">إيقاف تلقائي للشركات منتهية الاشتراك</span>
          </label>
          <Button variant="outline" size="sm" onClick={() => { refetch(); qc.invalidateQueries({ queryKey: ["admin-subscriptions-usage"] }); }} className="gap-2">
            <RefreshCw className="h-3.5 w-3.5" />تحديث
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="إجمالي الاشتراكات" value={total}         icon={Package}        iconBg="bg-primary/10"  iconColor="text-primary" />
        <StatCard label="نشطة"               value={active}        icon={CheckCircle2}   iconBg="bg-green-100"   iconColor="text-green-600" />
        <StatCard label="تنتهي خلال 30 يوم" value={expiringSoon}  icon={AlertTriangle}  iconBg="bg-amber-100"   iconColor="text-amber-600" />
        <StatCard label="منتهية"             value={expired}       icon={XCircle}        iconBg="bg-red-100"     iconColor="text-red-600" />
      </div>

      {/* Over-limit collapsible panel */}
      {overLimitCount > 0 && (
        <div className="rounded-xl border-2 border-amber-300 bg-amber-50">
          <button
            type="button"
            onClick={() => setOverLimitOpen(o => !o)}
            className="w-full flex items-center justify-between gap-2 px-4 py-3 font-semibold text-amber-900 hover:bg-amber-100/60 transition-colors rounded-xl"
            aria-expanded={overLimitOpen}
          >
            <span className="flex items-center gap-2">
              <Zap className="h-4 w-4" />
              <span>{overLimitCount} شركة تجاوزت حدود باقتها</span>
            </span>
            <span className="text-xs font-normal text-amber-700">
              {overLimitOpen ? "إخفاء" : "عرض التفاصيل"}
            </span>
          </button>
          {overLimitOpen && (
            <div className="grid gap-2 md:grid-cols-2 px-4 pb-4">
              {overLimitRows.map(u => (
                <div key={u.subscriptionId} className="rounded-lg bg-white border border-amber-200 px-3 py-2 text-xs space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-foreground">{u.companyName ?? `شركة #${u.companyId}`}</div>
                    <span className="text-[10px] text-muted-foreground bg-muted/50 rounded px-1.5 py-0.5">
                      {u.plan}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 text-amber-800">
                    {u.overFields.map((f: string) => (
                      <span key={f} className="bg-amber-100 border border-amber-300 rounded px-1.5 py-0.5 font-mono">
                        {f}: {u.actual[f]} / {u.allowed[f]}
                      </span>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setExpandedRow(u.subscriptionId);
                      setUpgradeForId(u.subscriptionId);
                      setOverLimitOpen(false);
                      setTimeout(() => {
                        const el = document.getElementById(`sub-row-${u.subscriptionId}`);
                        el?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }, 50);
                    }}
                    className="w-full mt-1 text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white rounded px-2 py-1.5 transition-colors"
                  >
                    ترقية الباقة الآن ←
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 flex-col sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="ابحث باسم الشركة أو الرقم الضريبي..."
            className="pr-10 h-9 text-sm" />
        </div>
        <div className="flex rounded-lg border overflow-hidden bg-background text-sm">
          {TABS.map((t, i) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={cn("px-3 py-1.5 font-medium transition-colors", i > 0 && "border-r",
                tab === t.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/60")}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border overflow-hidden bg-background text-sm">
          {[{ key: "all", label: "كل الباقات" }, ...PLANS.map(p => ({ key: p.key, label: p.label }))].map((tabp, i) => (
            <button key={tabp.key} onClick={() => setPlanFilter(tabp.key)}
              className={cn("px-3 py-1.5 font-medium transition-colors", i > 0 && "border-r",
                planFilter === tabp.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/60")}>
              {tabp.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="rounded-xl border bg-primary/5 border-primary/30 px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-semibold text-primary">{selected.size} اشتراك محدد</span>
          <div className="flex items-center gap-2">
            <Label className="text-xs">تمديد جماعي:</Label>
            <select className="h-8 rounded-md border bg-background px-2 text-xs"
              value={bulkMonths} onChange={e => setBulkMonths(parseInt(e.target.value))}>
              {EXTEND_OPTIONS.map(o => <option key={o.months} value={o.months}>{o.label}</option>)}
            </select>
            <Button size="sm" className="h-8 gap-1.5"
              disabled={bulkExtendMutation.isPending}
              onClick={() => bulkExtendMutation.mutate({ ids: Array.from(selected), months: bulkMonths })}>
              <CalendarPlus className="h-3.5 w-3.5" />تطبيق التمديد
            </Button>
          </div>
          <div className="flex items-center gap-2 ms-auto">
            <Button size="sm" variant="outline" className="h-8 gap-1.5 border-red-300 text-red-700 hover:bg-red-50"
              disabled={bulkFreezeMutation.isPending}
              onClick={() => bulkFreezeMutation.mutate({ ids: Array.from(selected), isActive: false })}>
              <PauseCircle className="h-3.5 w-3.5" />تجميد المحدد
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 border-green-300 text-green-700 hover:bg-green-50"
              disabled={bulkFreezeMutation.isPending}
              onClick={() => bulkFreezeMutation.mutate({ ids: Array.from(selected), isActive: true })}>
              <PlayCircle className="h-3.5 w-3.5" />تفعيل المحدد
            </Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setSelected(new Set())}>
              إلغاء التحديد
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {/* Column headers */}
        <div className="grid items-center gap-4 border-b bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide select-none"
          style={{ gridTemplateColumns: "auto 2fr 1fr 1fr 1fr 1fr 1.4fr auto" }}>
          <Checkbox checked={allSelectedOnPage} onCheckedChange={toggleAll} aria-label="تحديد الكل" />
          <span>الشركة</span>
          <span>الباقة</span>
          <span>المستخدمون</span>
          <span>الفواتير</span>
          <span>انتهاء الاشتراك</span>
          <span>الحالة</span>
          <span className="text-center w-8">—</span>
        </div>

        {isLoading && (
          <div className="divide-y">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="flex items-center gap-4 px-4 py-4 animate-pulse">
                <Skeleton className="h-4 w-4 rounded shrink-0" />
                <Skeleton className="h-4 w-40 flex-1" />
                <Skeleton className="h-6 w-20 rounded-full" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-6 w-28 rounded-full" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && filtered.length === 0 && (
          <div className="py-20 text-center">
            <Package className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">لا توجد اشتراكات{search ? " مطابقة" : ""}</p>
          </div>
        )}

        <div className="divide-y">
          {filtered.map((row: any) => {
            const sub     = row.subscription;
            const company = row.company;
            const plan    = PLAN_MAP[sub?.plan] ?? PLAN_MAP.starter;
            const isExp   = expandedRow === sub?.id;
            const isSelected = selected.has(sub?.id);
            const u       = usageByCompany.get(sub?.companyId);
            const extM    = extendForms[sub?.id] ?? 1;
            const planForm = planForms[sub?.id] ?? { plan: sub?.plan, cycle: (sub?.billingCycle === "annual" ? "yearly" : sub?.billingCycle) ?? "monthly" };

            const isUpgradeTarget = upgradeForId === sub?.id;
            return (
              <div
                key={sub?.id}
                id={`sub-row-${sub?.id}`}
                className={cn(
                  "transition-colors",
                  !sub?.isActive && "bg-muted/20",
                  isSelected && "bg-primary/5",
                  isUpgradeTarget && "ring-2 ring-amber-400 ring-inset bg-amber-50/40",
                )}
              >
                <div
                  className="grid items-center gap-4 px-4 py-3.5 cursor-pointer hover:bg-muted/20 transition-colors"
                  style={{ gridTemplateColumns: "auto 2fr 1fr 1fr 1fr 1fr 1.4fr auto" }}
                  onClick={() => { setExpandedRow(isExp ? null : sub?.id); if (isUpgradeTarget) setUpgradeForId(null); }}
                >
                  <div onClick={e => e.stopPropagation()}>
                    <Checkbox checked={isSelected} onCheckedChange={() => toggleOne(sub?.id)} aria-label="تحديد" />
                  </div>

                  {/* Company */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0">
                      {company?.nameAr?.[0] ?? "ش"}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-foreground truncate flex items-center gap-1.5">
                        {company?.nameAr}
                        {company?.status === "suspended" && (
                          <span className="text-[10px] bg-red-100 text-red-700 border border-red-200 rounded px-1">شركة موقوفة</span>
                        )}
                      </p>
                      <p className="text-[11px] font-mono text-muted-foreground truncate">{company?.vatNumber}</p>
                    </div>
                  </div>

                  <span className={cn("inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-semibold w-fit", plan.color)}>
                    <Package className="h-3 w-3 shrink-0" />{plan.label}
                  </span>

                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Users className="h-3.5 w-3.5 shrink-0" />
                    <span className={cn("text-xs", u?.overFields?.includes("users") && "text-amber-700 font-semibold")}>
                      {u ? `${u.actual.users}/` : ""}{sub?.maxUsers === 999 ? "∞" : sub?.maxUsers}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className={cn("text-xs", u?.overFields?.includes("invoices") && "text-amber-700 font-semibold")}>
                      {u ? `${u.actual.invoices}/` : ""}{sub?.maxInvoices === 999999 ? "∞" : sub?.maxInvoices?.toLocaleString()}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Calendar className="h-3.5 w-3.5 shrink-0" />
                    {sub?.endDate ?? "—"}
                  </div>

                  <StatusBadge sub={sub} companyStatus={company?.status} />

                  <button className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted transition-colors text-muted-foreground"
                    onClick={e => { e.stopPropagation(); setExpandedRow(isExp ? null : sub?.id); }}>
                    {isExp ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                </div>

                {isExp && (
                  <div className="border-t bg-muted/20 px-4 pb-4 pt-3 space-y-4">
                    {/* Usage panel */}
                    {u && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                        {(["users", "branches", "warehouses", "invoices"] as const).map(k => {
                          const over = u.overFields?.includes(k);
                          const labels: Record<string, string> = { users: "المستخدمون", branches: "الفروع", warehouses: "المستودعات", invoices: "الفواتير" };
                          return (
                            <div key={k} className={cn("rounded-lg border p-2.5 bg-background/60", over && "border-amber-300 bg-amber-50")}>
                              <p className="text-[10px] text-muted-foreground/70 uppercase tracking-wide font-semibold">{labels[k]}</p>
                              <p className={cn("text-sm font-semibold mt-0.5 tabular-nums", over && "text-amber-800")}>
                                {u.actual[k]?.toLocaleString()} / {u.allowed[k] >= 999 ? "∞" : u.allowed[k]?.toLocaleString()}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Inline actions: Extend + Change Plan + Freeze */}
                    <div className="grid md:grid-cols-2 gap-3">
                      {/* Extend */}
                      <div className="rounded-lg border bg-background p-3 space-y-2">
                        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                          <CalendarPlus className="h-3.5 w-3.5 text-primary" />تمديد الاشتراك
                        </div>
                        <div className="flex gap-2">
                          <select className="flex-1 h-8 rounded-md border bg-background px-2 text-xs"
                            value={extM}
                            onChange={e => setExtendForms(f => ({ ...f, [sub.id]: parseInt(e.target.value) }))}>
                            {EXTEND_OPTIONS.map(o => <option key={o.months} value={o.months}>{o.label}</option>)}
                          </select>
                          <Button size="sm" className="h-8 gap-1.5" disabled={extendMutation.isPending}
                            onClick={() => extendMutation.mutate({ id: sub.id, months: extM })}>
                            تطبيق
                          </Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          ينتهي حالياً في {sub.endDate} — سيمتد بمقدار الأشهر المختارة من تاريخ الانتهاء الحالي.
                        </p>
                      </div>

                      {/* Change plan */}
                      <div className="rounded-lg border bg-background p-3 space-y-2">
                        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                          <Repeat className="h-3.5 w-3.5 text-primary" />تبديل الباقة
                        </div>
                        <div className="flex gap-2">
                          <select className="flex-1 h-8 rounded-md border bg-background px-2 text-xs"
                            value={planForm.plan}
                            onChange={e => setPlanForms(f => ({ ...f, [sub.id]: { ...planForm, plan: e.target.value } }))}>
                            {PLANS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                          </select>
                          <select className="h-8 rounded-md border bg-background px-2 text-xs"
                            value={planForm.cycle}
                            onChange={e => setPlanForms(f => ({ ...f, [sub.id]: { ...planForm, cycle: e.target.value as "monthly" | "yearly" } }))}>
                            <option value="monthly">شهرية</option>
                            <option value="yearly">سنوية</option>
                          </select>
                          <Button size="sm" className="h-8 gap-1.5" disabled={changePlanMutation.isPending}
                            onClick={() => changePlanMutation.mutate({ id: sub.id, planKey: planForm.plan, billingCycle: planForm.cycle })}>
                            تبديل
                          </Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          يضبط حدود وسعر الباقة الجديدة، ويبدأ دورة جديدة من اليوم.
                        </p>
                      </div>
                    </div>

                    <div className="flex gap-2 pt-1 flex-wrap">
                      <Button size="sm" variant="outline" className={cn("gap-1.5 h-8",
                        sub?.isActive ? "border-red-300 text-red-700 hover:bg-red-50" : "border-green-300 text-green-700 hover:bg-green-50")}
                        onClick={() => updateMutation.mutate({ id: sub.id, data: { isActive: !sub.isActive } })}>
                        {sub?.isActive ? <><PauseCircle className="h-3.5 w-3.5" />تجميد</> : <><PlayCircle className="h-3.5 w-3.5" />تفعيل</>}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground flex items-center justify-between">
            <span>عدد الاشتراكات: <strong>{filtered.length}</strong></span>
            <span className="text-muted-foreground/60">انقر على أي صف لعرض الإجراءات</span>
          </div>
        )}
      </div>

    </div>
  );
}
