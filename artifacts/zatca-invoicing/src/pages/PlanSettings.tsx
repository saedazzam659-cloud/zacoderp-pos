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
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const PLAN_ICONS: Record<string, any> = {
  starter:      { Icon: Package, color: "text-blue-600",  bg: "bg-blue-50",  border: "border-blue-200",  ring: "ring-blue-400" },
  professional: { Icon: Star,    color: "text-primary",   bg: "bg-primary/5",border: "border-primary/30",ring: "ring-primary" },
  enterprise:   { Icon: Crown,   color: "text-amber-600", bg: "bg-amber-50", border: "border-amber-200", ring: "ring-amber-400" },
};

function FeatureEditor({ features, onChange }: { features: string[]; onChange: (f: string[]) => void }) {
  const [newFeat, setNewFeat] = useState("");

  const add = () => {
    const v = newFeat.trim();
    if (!v) return;
    onChange([...features, v]);
    setNewFeat("");
  };

  const remove = (i: number) => onChange(features.filter((_, idx) => idx !== i));

  const update = (i: number, val: string) => {
    const copy = [...features];
    copy[i] = val;
    onChange(copy);
  };

  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold">المميزات</Label>
      <div className="space-y-1.5 max-h-48 overflow-y-auto pl-1">
        {features.map((f, i) => (
          <div key={i} className="flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
            <Input
              value={f}
              onChange={e => update(i, e.target.value)}
              className="h-7 text-sm flex-1"
              dir="rtl"
            />
            <button type="button" onClick={() => remove(i)}
              className="text-destructive hover:text-destructive/80 p-1 rounded shrink-0">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={newFeat}
          onChange={e => setNewFeat(e.target.value)}
          onKeyDown={e => e.key === "Enter" && (e.preventDefault(), add())}
          placeholder="أضف ميزة جديدة..."
          className="h-8 text-sm flex-1"
          dir="rtl"
        />
        <Button type="button" variant="outline" size="sm" onClick={add} className="h-8 gap-1 px-3">
          <Plus className="h-3.5 w-3.5" />إضافة
        </Button>
      </div>
    </div>
  );
}

function PlanCard({ plan, onSave, saving }: {
  plan: any;
  onSave: (key: string, data: any) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState({ ...plan, features: [...(plan.features ?? [])] });
  const [dirty, setDirty] = useState(false);

  const set = (k: string, v: any) => { setForm((f: any) => ({ ...f, [k]: v })); setDirty(true); };

  const { Icon, color, bg, border, ring } = PLAN_ICONS[plan.key] ?? PLAN_ICONS.starter;

  const annualMonthly = form.annualPrice ? (Number(form.annualPrice) / 12).toFixed(0) : "—";
  const discount = form.monthlyPrice && form.annualPrice
    ? Math.round((1 - Number(form.annualPrice) / (Number(form.monthlyPrice) * 12)) * 100)
    : 0;

  return (
    <div className={cn(
      "rounded-2xl border-2 bg-card transition-all shadow-sm",
      dirty ? `${border} ring-2 ${ring}/20` : "border-border"
    )}>
      {/* Card header */}
      <div className={cn("rounded-t-xl px-5 py-4 flex items-center justify-between", bg)}>
        <div className="flex items-center gap-3">
          <div className={cn("h-10 w-10 rounded-xl flex items-center justify-center border", bg, border)}>
            <Icon className={cn("h-5 w-5", color)} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-lg text-foreground">{form.nameAr}</h3>
              {form.isRecommended && (
                <span className="text-[10px] font-bold bg-primary text-primary-foreground rounded-full px-2 py-0.5">
                  الأكثر شيوعاً
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{form.nameEn}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">نشط</span>
          <Switch
            checked={form.isActive}
            onCheckedChange={v => set("isActive", v)}
          />
        </div>
      </div>

      {/* Fields */}
      <div className="p-5 space-y-4">
        {/* Names */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">اسم الباقة (عربي)</Label>
            <Input value={form.nameAr} onChange={e => set("nameAr", e.target.value)} className="h-9 text-sm" dir="rtl" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">اسم الباقة (إنجليزي)</Label>
            <Input value={form.nameEn} onChange={e => set("nameEn", e.target.value)} className="h-9 text-sm" dir="ltr" />
          </div>
        </div>

        {/* Prices */}
        <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
            <BadgeCheck className="h-3.5 w-3.5" />الأسعار (ر.س)
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">السعر الشهري</Label>
              <div className="relative">
                <Input
                  type="number" min={0} value={form.monthlyPrice}
                  onChange={e => set("monthlyPrice", e.target.value)}
                  className="h-9 text-sm pl-14" dir="ltr"
                />
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">ر.س/شهر</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">السعر السنوي (إجمالي)</Label>
              <div className="relative">
                <Input
                  type="number" min={0} value={form.annualPrice}
                  onChange={e => set("annualPrice", e.target.value)}
                  className="h-9 text-sm pl-12" dir="ltr"
                />
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">ر.س/سنة</span>
              </div>
            </div>
          </div>
          {discount > 0 && (
            <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-1.5 flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3" />
              الاشتراك السنوي يوفر {discount}% — {annualMonthly} ر.س/شهر (بدلاً من {form.monthlyPrice})
            </p>
          )}
        </div>

        {/* Limits */}
        <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
            <Settings2 className="h-3.5 w-3.5" />الحدود
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1">
                <Users className="h-3 w-3" />الحد الأقصى للمستخدمين
              </Label>
              <Input
                type="number" min={1} value={form.maxUsers}
                onChange={e => set("maxUsers", parseInt(e.target.value))}
                className="h-9 text-sm" dir="ltr"
              />
              {form.maxUsers >= 999 && (
                <p className="text-[10px] text-primary">≥ 999 = غير محدود</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1">
                <FileText className="h-3 w-3" />الحد الأقصى للفواتير
              </Label>
              <Input
                type="number" min={1} value={form.maxInvoices}
                onChange={e => set("maxInvoices", parseInt(e.target.value))}
                className="h-9 text-sm" dir="ltr"
              />
              {form.maxInvoices >= 999999 && (
                <p className="text-[10px] text-primary">≥ 999999 = غير محدود</p>
              )}
            </div>
          </div>
        </div>

        {/* Recommended toggle */}
        <div className="flex items-center justify-between rounded-xl border px-4 py-3 bg-muted/20">
          <div>
            <p className="text-sm font-medium">الباقة الأكثر شيوعاً</p>
            <p className="text-xs text-muted-foreground">تظهر بشارة "الأكثر شيوعاً" في صفحة التسجيل</p>
          </div>
          <Switch
            checked={form.isRecommended}
            onCheckedChange={v => set("isRecommended", v)}
          />
        </div>

        {/* Features */}
        <FeatureEditor features={form.features} onChange={v => set("features", v)} />

        {/* Save button */}
        <div className="pt-1">
          <Button
            className="w-full gap-2"
            disabled={!dirty || saving}
            onClick={() => {
              onSave(plan.key, form);
              setDirty(false);
            }}
          >
            <Save className="h-4 w-4" />
            {saving ? "جاري الحفظ..." : dirty ? "حفظ التغييرات" : "لا توجد تغييرات"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function PlanSettings() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
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
      toast({ title: `✓ تم حفظ باقة ${key} بنجاح` });
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
            <Settings2 className="h-6 w-6 text-primary" />إعدادات الباقات والأسعار
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تعديل بيانات الباقات التي تظهر في صفحة التسجيل وعند إضافة شركة
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
          <RefreshCw className="h-3.5 w-3.5" />تحديث
        </Button>
      </div>

      {/* Preview notice */}
      <div className="rounded-xl border bg-blue-50 border-blue-200 px-4 py-3 flex items-start gap-3">
        <Package className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
        <div className="text-sm text-blue-800">
          <p className="font-semibold">ملاحظة مهمة</p>
          <p className="text-xs mt-0.5 text-blue-700">
            تغيير الأسعار والحدود هنا سيؤثر على صفحة التسجيل للشركات الجديدة.
            الاشتراكات الحالية للشركات لن تتغير تلقائياً، يجب تعديلها يدوياً من صفحة "إدارة الاشتراكات".
          </p>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {[1, 2, 3].map(i => (
            <div key={i} className="rounded-2xl border-2 border-border bg-card h-96 animate-pulse" />
          ))}
        </div>
      )}

      {/* Plan cards */}
      {!isLoading && plans.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
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

      {/* Empty / not seeded */}
      {!isLoading && plans.length === 0 && (
        <div className="rounded-2xl border-2 border-dashed py-20 text-center">
          <Settings2 className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-muted-foreground font-medium">لا توجد بيانات باقات</p>
          <p className="text-xs text-muted-foreground mt-1">سيتم إنشاؤها تلقائياً عند إعادة تشغيل الخادم</p>
        </div>
      )}
    </div>
  );
}
