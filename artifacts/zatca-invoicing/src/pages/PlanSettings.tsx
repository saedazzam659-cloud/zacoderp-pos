import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Package, Star, Crown, RefreshCw, Save, Plus, Trash2,
  CheckCircle2, Settings2, Users, FileText, BadgeCheck,
  Info, Zap, Sparkles, Boxes,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const PLAN_META: Record<string, {
  Icon: any; color: string; bg: string; headerBg: string;
  border: string; ring: string; accent: string; badge?: string;
}> = {
  starter: {
    Icon: Package, color: "text-slate-600", bg: "bg-slate-50",
    headerBg: "bg-gradient-to-br from-slate-50 to-slate-100",
    border: "border-slate-200", ring: "ring-slate-300",
    accent: "bg-slate-600",
  },
  professional: {
    Icon: Zap, color: "text-primary", bg: "bg-primary/5",
    headerBg: "bg-gradient-to-br from-primary/8 to-primary/15",
    border: "border-primary/40", ring: "ring-primary/40",
    accent: "bg-primary", badge: "الأكثر شيوعاً",
  },
  enterprise: {
    Icon: Crown, color: "text-amber-600", bg: "bg-amber-50",
    headerBg: "bg-gradient-to-br from-amber-50 to-amber-100",
    border: "border-amber-300", ring: "ring-amber-300",
    accent: "bg-amber-500",
  },
};

function FeatureList({ features, onChange }: { features: string[]; onChange: (f: string[]) => void }) {
  const [newFeat, setNewFeat] = useState("");

  const add = () => {
    const v = newFeat.trim();
    if (!v) return;
    onChange([...features, v]);
    setNewFeat("");
  };
  const remove = (i: number) => onChange(features.filter((_, idx) => idx !== i));
  const update  = (i: number, val: string) => {
    const copy = [...features];
    copy[i] = val;
    onChange(copy);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5 max-h-44 overflow-y-auto">
        {features.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-3">لا توجد مميزات — أضف أولاً</p>
        )}
        {features.map((f, i) => (
          <div key={i} className="flex items-center gap-2 group">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
            <Input
              value={f} onChange={e => update(i, e.target.value)}
              className="h-7 text-xs flex-1 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 p-0 focus:bg-muted/50 rounded px-2 transition-colors"
              dir="rtl"
            />
            <button type="button" onClick={() => remove(i)}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-muted-foreground hover:text-destructive">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-1 border-t">
        <Input
          value={newFeat} onChange={e => setNewFeat(e.target.value)}
          onKeyDown={e => e.key === "Enter" && (e.preventDefault(), add())}
          placeholder="أضف ميزة جديدة..."
          className="h-8 text-xs flex-1" dir="rtl"
        />
        <Button type="button" variant="outline" size="sm" onClick={add} className="h-8 gap-1 px-3 text-xs shrink-0">
          <Plus className="h-3 w-3" />إضافة
        </Button>
      </div>
    </div>
  );
}

function PlanCard({ plan, onSave, saving }: { plan: any; onSave: (key: string, data: any) => void; saving: boolean }) {
  const [form, setForm]   = useState({ ...plan, features: [...(plan.features ?? [])] });
  const [dirty, setDirty] = useState(false);
  const [tab, setTab]     = useState<"pricing" | "limits" | "features">("pricing");

  const set = (k: string, v: any) => { setForm((f: any) => ({ ...f, [k]: v })); setDirty(true); };

  const meta = PLAN_META[plan.key] ?? PLAN_META.starter;
  const { Icon, color, bg, headerBg, border, ring, accent } = meta;

  const annualMonthly = form.annualPrice ? Math.round(Number(form.annualPrice) / 12) : null;
  const discount = form.monthlyPrice && form.annualPrice
    ? Math.round((1 - Number(form.annualPrice) / (Number(form.monthlyPrice) * 12)) * 100)
    : 0;

  const isProfessional = plan.key === "professional";

  return (
    <div className={cn(
      "rounded-2xl border-2 bg-card flex flex-col overflow-hidden transition-all duration-200",
      dirty
        ? `${border} shadow-lg ring-2 ${ring}/30`
        : isProfessional ? `${border} shadow-md` : "border-border shadow-sm"
    )}>
      {/* ── Plan header ── */}
      <div className={cn("relative px-5 pt-5 pb-4", headerBg)}>
        {/* Active toggle top-right */}
        <div className="absolute top-4 left-4 flex items-center gap-1.5">
          <span className={cn("text-[10px] font-medium", form.isActive ? "text-green-600" : "text-muted-foreground")}>
            {form.isActive ? "نشط" : "موقف"}
          </span>
          <Switch checked={form.isActive} onCheckedChange={v => set("isActive", v)}
            className="h-4 w-7 data-[state=checked]:bg-green-500" />
        </div>

        {/* Icon + name */}
        <div className="flex items-start gap-3 mb-4">
          <div className={cn("h-11 w-11 rounded-xl flex items-center justify-center border shadow-sm", bg, border)}>
            <Icon className={cn("h-5 w-5", color)} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-lg leading-tight">{form.nameAr}</h3>
              {form.isRecommended && (
                <span className="text-[10px] font-bold bg-primary text-primary-foreground rounded-full px-2 py-0.5 shrink-0">
                  ★ الأكثر شيوعاً
                </span>
              )}
              {dirty && (
                <span className="text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-300 rounded-full px-2 py-0.5 shrink-0">
                  تعديلات غير محفوظة
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{form.nameEn}</p>
          </div>
        </div>

        {/* Price display */}
        <div className="flex items-end justify-between">
          <div>
            <div className="flex items-baseline gap-1" dir="ltr">
              <span className="text-3xl font-extrabold tabular-nums">{form.monthlyPrice || "—"}</span>
              <span className="text-sm text-muted-foreground font-medium">ر.س / شهر</span>
            </div>
            {annualMonthly && discount > 0 && (
              <p className="text-xs text-green-600 font-medium mt-0.5">
                أو {annualMonthly} ر.س/شهر باشتراك سنوي
              </p>
            )}
          </div>
          {discount > 0 && (
            <span className="bg-green-100 text-green-700 text-xs font-bold px-2.5 py-1 rounded-full border border-green-200">
              وفّر {discount}%
            </span>
          )}
        </div>

        {/* Limits pills */}
        <div className="flex gap-2 mt-3 flex-wrap">
          <span className="flex items-center gap-1 text-xs bg-white/70 border rounded-full px-2.5 py-1 font-medium">
            <Users className="h-3 w-3 text-muted-foreground" />
            {form.maxUsers >= 999 ? "مستخدمون غير محدودين" : `${form.maxUsers} مستخدم`}
          </span>
          <span className="flex items-center gap-1 text-xs bg-white/70 border rounded-full px-2.5 py-1 font-medium">
            <FileText className="h-3 w-3 text-muted-foreground" />
            {form.maxInvoices >= 999999 ? "فواتير غير محدودة" : `${form.maxInvoices} فاتورة`}
          </span>
        </div>
      </div>

      {/* ── Edit section ── */}
      <div className="flex-1 flex flex-col">
        {/* Inner tabs */}
        <div className="flex border-b bg-muted/20">
          {[
            { key: "pricing",  label: "الأسعار",  icon: BadgeCheck },
            { key: "limits",   label: "الحدود",   icon: Settings2 },
            { key: "features", label: "المميزات", icon: Sparkles },
          ].map(t => {
            const TIcon = t.icon;
            return (
              <button key={t.key} type="button"
                onClick={() => setTab(t.key as any)}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium border-b-2 transition-colors",
                  tab === t.key
                    ? "border-primary text-primary bg-primary/5"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}>
                <TIcon className="h-3 w-3" />{t.label}
              </button>
            );
          })}
        </div>

        <div className="p-5 flex-1 space-y-4">
          {/* Names always visible */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold text-muted-foreground">اسم عربي</Label>
              <Input value={form.nameAr} onChange={e => set("nameAr", e.target.value)}
                className="h-8 text-sm" dir="rtl" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold text-muted-foreground">اسم إنجليزي</Label>
              <Input value={form.nameEn} onChange={e => set("nameEn", e.target.value)}
                className="h-8 text-sm" dir="ltr" />
            </div>
          </div>

          <div className="border-t" />

          {/* TAB: Pricing */}
          {tab === "pricing" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-[11px] font-semibold text-muted-foreground">السعر الشهري</Label>
                  <div className="relative">
                    <Input
                      type="number" min={0} value={form.monthlyPrice}
                      onChange={e => set("monthlyPrice", e.target.value)}
                      className="h-9 text-sm pl-16 font-mono" dir="ltr"
                    />
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground whitespace-nowrap">ر.س/شهر</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] font-semibold text-muted-foreground">السعر السنوي (إجمالي)</Label>
                  <div className="relative">
                    <Input
                      type="number" min={0} value={form.annualPrice}
                      onChange={e => set("annualPrice", e.target.value)}
                      className="h-9 text-sm pl-14 font-mono" dir="ltr"
                    />
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground whitespace-nowrap">ر.س/سنة</span>
                  </div>
                </div>
              </div>

              {discount > 0 && (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-green-50 border border-green-200">
                  <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                  <div className="text-xs text-green-800">
                    <span className="font-semibold">توفير {discount}٪ سنوياً</span>
                    {" — "}{annualMonthly} ر.س/شهر بدلاً من {form.monthlyPrice} ر.س
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between p-3 rounded-xl border bg-muted/20">
                <div>
                  <p className="text-sm font-medium">الباقة الأكثر شيوعاً</p>
                  <p className="text-xs text-muted-foreground">تظهر بشارة مميزة في صفحة التسجيل</p>
                </div>
                <Switch checked={form.isRecommended} onCheckedChange={v => set("isRecommended", v)} />
              </div>
            </div>
          )}

          {/* TAB: Limits */}
          {tab === "limits" && (
            <div className="space-y-4">
              <div className="space-y-3">
                <div className="p-3 rounded-xl border space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center">
                        <Users className="h-4 w-4 text-blue-600" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold">المستخدمون</p>
                        <p className="text-xs text-muted-foreground">الحد الأقصى للمستخدمين في الشركة</p>
                      </div>
                    </div>
                    <div className="w-24">
                      <Input
                        type="number" min={1} value={form.maxUsers}
                        onChange={e => set("maxUsers", parseInt(e.target.value))}
                        className="h-9 text-sm text-center font-mono" dir="ltr"
                      />
                    </div>
                  </div>
                  {form.maxUsers >= 999 && (
                    <p className="text-xs text-primary bg-primary/5 px-2.5 py-1 rounded-lg">
                      ✓ ≥ 999 = غير محدود
                    </p>
                  )}
                </div>

                <div className="p-3 rounded-xl border space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 rounded-lg bg-emerald-50 border border-emerald-100 flex items-center justify-center">
                        <FileText className="h-4 w-4 text-emerald-600" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold">الفواتير</p>
                        <p className="text-xs text-muted-foreground">الحد الأقصى للفواتير شهرياً</p>
                      </div>
                    </div>
                    <div className="w-24">
                      <Input
                        type="number" min={1} value={form.maxInvoices}
                        onChange={e => set("maxInvoices", parseInt(e.target.value))}
                        className="h-9 text-sm text-center font-mono" dir="ltr"
                      />
                    </div>
                  </div>
                  {form.maxInvoices >= 999999 && (
                    <p className="text-xs text-primary bg-primary/5 px-2.5 py-1 rounded-lg">
                      ✓ ≥ 999999 = غير محدود
                    </p>
                  )}
                </div>

                {/* Included free modules — drives the Register page's
                    "X وحدات مشمولة" pill and the cheapest-N-free pricing
                    calc. Set high (e.g. 100) to make a tier "all-inclusive". */}
                <div className="p-3 rounded-xl border space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 rounded-lg bg-purple-50 border border-purple-100 flex items-center justify-center">
                        <Boxes className="h-4 w-4 text-purple-600" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold">الوحدات المشمولة مجاناً</p>
                        <p className="text-xs text-muted-foreground">عدد وحدات النظام التي يحصل عليها العميل ضمن سعر الباقة</p>
                      </div>
                    </div>
                    <div className="w-24">
                      <Input
                        type="number" min={0} value={form.includedModulesCount ?? 0}
                        onChange={e => set("includedModulesCount", parseInt(e.target.value) || 0)}
                        className="h-9 text-sm text-center font-mono" dir="ltr"
                      />
                    </div>
                  </div>
                  {(form.includedModulesCount ?? 0) >= 100 && (
                    <p className="text-xs text-primary bg-primary/5 px-2.5 py-1 rounded-lg">
                      ✓ ≥ 100 = كل الوحدات مجاناً
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB: Features */}
          {tab === "features" && (
            <FeatureList
              features={form.features}
              onChange={v => set("features", v)}
            />
          )}
        </div>

        {/* Save button */}
        <div className="px-5 pb-5">
          <Button
            className={cn("w-full gap-2 transition-all", dirty ? "" : "opacity-60")}
            disabled={!dirty || saving}
            onClick={() => { onSave(plan.key, form); setDirty(false); }}
          >
            {saving
              ? <><RefreshCw className="h-4 w-4 animate-spin" />جاري الحفظ...</>
              : dirty
                ? <><Save className="h-4 w-4" />حفظ التغييرات</>
                : <><CheckCircle2 className="h-4 w-4" />لا توجد تغييرات</>
            }
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function PlanSettings() {
  const { token }  = useAuth();
  const { toast }  = useToast();
  const qc         = useQueryClient();
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data: plans = [], isLoading, refetch } = useQuery({
    queryKey: ["plan-configs"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/plans`, { headers });
      return res.json();
    },
  });

  const saveMutation = useMutation({
    mutationFn: async ({ key, data }: { key: string; data: any }) => {
      setSavingKey(key);
      const res = await fetch(`${API}/api/admin/plans/${key}`, {
        method: "PUT", headers, body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "حدث خطأ");
      return json;
    },
    onSuccess: (_, { key }) => {
      toast({ title: `✓ تم حفظ الباقة بنجاح` });
      qc.invalidateQueries({ queryKey: ["plan-configs"] });
      setSavingKey(null);
    },
    onError: (e: any) => {
      toast({ title: e.message, variant: "destructive" });
      setSavingKey(null);
    },
  });

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Settings2 className="h-6 w-6 text-primary" />
            إعدادات الباقات والأسعار
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تعديل بيانات الباقات التي تظهر في صفحة التسجيل وعند إضافة شركة جديدة
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
          <RefreshCw className="h-3.5 w-3.5" />تحديث
        </Button>
      </div>

      {/* Notice */}
      <div className="rounded-xl border bg-amber-50 border-amber-200 px-4 py-3 flex items-start gap-3">
        <Info className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
        <p className="text-xs text-amber-800">
          تغيير الأسعار والحدود هنا سيؤثر على صفحة التسجيل للشركات الجديدة.
          الاشتراكات الحالية للشركات لن تتغير تلقائياً، يجب تعديلها يدوياً من صفحة "إدارة الاشتراكات".
        </p>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {[1, 2, 3].map(i => (
            <div key={i} className="rounded-2xl border-2 border-border bg-card h-[520px] animate-pulse" />
          ))}
        </div>
      )}

      {/* Plan cards */}
      {!isLoading && plans.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
          {plans.map((plan: any) => (
            <PlanCard
              key={plan.key}
              plan={plan}
              saving={savingKey === plan.key}
              onSave={(key, data) => saveMutation.mutate({ key, data })}
            />
          ))}
        </div>
      )}

      {/* Empty */}
      {!isLoading && plans.length === 0 && (
        <div className="rounded-2xl border-2 border-dashed py-24 text-center">
          <Settings2 className="h-12 w-12 text-muted-foreground/20 mx-auto mb-4" />
          <p className="text-muted-foreground font-medium">لا توجد بيانات باقات</p>
          <p className="text-xs text-muted-foreground mt-1">سيتم إنشاؤها تلقائياً عند إعادة تشغيل الخادم</p>
        </div>
      )}
    </div>
  );
}
