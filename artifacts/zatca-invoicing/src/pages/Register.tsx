import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useAuth, type RegisterData } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  Building2, User, Package, Check, ChevronLeft, ChevronRight,
  Eye, EyeOff, Loader2, ShieldCheck, Star, Crown, Globe2, Sparkles
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  COUNTRIES, DEFAULT_COUNTRY_CODE,
  getCountryByCode, getCountryPolicy,
} from "@/lib/countries";
import { INDUSTRIES, unionRecommendedModules } from "@/lib/industries";
import {
  SELECTABLE_MODULES, CATEGORIES, PLAN_INCLUDED, priceFor,
} from "@/lib/systemModules";

const PLANS = [
  {
    id: "starter", icon: <Package className="h-6 w-6" />, name: "مبتدئ",
    nameEn: "Starter", color: "border-blue-200 bg-blue-50",
    activeColor: "border-blue-500 ring-2 ring-blue-200",
    badgeColor: "bg-blue-100 text-blue-700",
    monthly: 99, annual: 990,
    maxUsers: 1, maxInvoices: 50,
    features: ["مستخدم واحد", "50 فاتورة شهرياً", "فواتير ضريبية ومبسطة", "دعم بريد إلكتروني"],
  },
  {
    id: "professional", icon: <Star className="h-6 w-6" />, name: "احترافي",
    nameEn: "Professional", color: "border-primary/30 bg-primary/5",
    activeColor: "border-primary ring-2 ring-primary/20",
    badgeColor: "bg-primary/10 text-primary",
    monthly: 299, annual: 2990,
    maxUsers: 5, maxInvoices: 500,
    features: ["5 مستخدمين", "500 فاتورة شهرياً", "تقارير متقدمة", "API مفتوح", "دعم أولوية"],
    recommended: true,
  },
  {
    id: "enterprise", icon: <Crown className="h-6 w-6" />, name: "مؤسسي",
    nameEn: "Enterprise", color: "border-amber-200 bg-amber-50",
    activeColor: "border-amber-500 ring-2 ring-amber-200",
    badgeColor: "bg-amber-100 text-amber-700",
    monthly: 899, annual: 8990,
    maxUsers: 999, maxInvoices: 999999,
    features: ["مستخدمون غير محدودين", "فواتير غير محدودة", "تقارير مخصصة", "SLA 99.9%", "مدير حساب مخصص"],
  },
];

const STEPS = [
  { id: "company",  label: "بيانات الشركة", icon: <Building2 className="h-4 w-4" /> },
  { id: "plan",     label: "الباقة",         icon: <Package className="h-4 w-4" /> },
  { id: "user",     label: "حساب الإدارة",   icon: <User className="h-4 w-4" /> },
  { id: "confirm",  label: "تأكيد",          icon: <Check className="h-4 w-4" /> },
];

export default function Register() {
  const [, setLocation] = useLocation();
  const { register } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("monthly");
  // Country/policy acceptance gate. Defaults to Saudi Arabia, the default
  // country for the platform. The acceptance flag blocks the final submit
  // in Step 3 — it is reset to false whenever the country changes so users
  // can't accept policy A and silently submit under country B.
  const [acceptedPolicy, setAcceptedPolicy] = useState(false);

  // ── Industry + module selection state (Step 1 rework) ───────────────
  // Multi-select industry chips. Picking one or more pre-selects each
  // industry's recommended modules (UNION); the user can then add/remove
  // individual modules. Empty = no recommendations applied yet.
  const [selectedIndustries, setSelectedIndustries] = useState<string[]>([]);
  // Per-module checkbox state — keys from systemModules.SELECTABLE_MODULES.
  const [selectedModules, setSelectedModules] = useState<string[]>([]);

  const [form, setForm] = useState<Partial<RegisterData>>({
    country: DEFAULT_COUNTRY_CODE,
    currency: getCountryByCode(DEFAULT_COUNTRY_CODE).currency.code,
    invoiceType: "both", plan: "professional", billingCycle: "monthly",
    startDate: new Date().toISOString().split("T")[0],
    endDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
  });

  const set = (k: keyof RegisterData, v: string) => setForm(f => ({ ...f, [k]: v }));

  // Toggle industry chip. Module behaviour is intentionally ADDITIVE so
  // any manual module edits the user has already made are NEVER lost:
  //  - Activating an industry  → ADDS its recommended modules (union)
  //  - Deactivating an industry → leaves modules untouched (user can
  //    deselect manually). Avoids the surprise of recommendations being
  //    silently revoked.
  const toggleIndustry = (code: string) => {
    setSelectedIndustries(prev => {
      const isActivating = !prev.includes(code);
      const next = isActivating ? [...prev, code] : prev.filter(c => c !== code);
      if (isActivating) {
        // Merge in the recommendations for the newly-activated industry
        // (deduped via Set). Existing manual picks are preserved.
        setSelectedModules(curr => Array.from(
          new Set([...curr, ...unionRecommendedModules([code])]),
        ));
      }
      return next;
    });
  };
  // "اختيار الكل" merges every industry's recommendations into the
  // current selection (additive). It never removes user picks.
  const selectAllIndustries = () => {
    const all = INDUSTRIES.map(i => i.code);
    setSelectedIndustries(all);
    setSelectedModules(curr => Array.from(
      new Set([...curr, ...unionRecommendedModules(all)]),
    ));
  };
  // "مسح" clears BOTH industries and modules. Explicit, predictable.
  const clearIndustries = () => {
    setSelectedIndustries([]);
    setSelectedModules([]);
  };
  const toggleModule = (key: string) => {
    setSelectedModules(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key],
    );
  };

  // Country selection: cascades the country code AND the matching default
  // currency, and revokes any prior policy acceptance so the user has to
  // re-confirm the new country's compliance line.
  const selectedCountry = getCountryByCode(form.country);
  const policyText      = getCountryPolicy(form.country, "ar");
  const handleCountryChange = (code: string) => {
    const c = getCountryByCode(code);
    setForm(f => ({ ...f, country: c.code, currency: c.currency.code }));
    setAcceptedPolicy(false);
  };

  const selectedPlan = PLANS.find(p => p.id === form.plan) ?? PLANS[1];

  // Live price breakdown (memoized) — recomputed only when the plan,
  // module selection, or billing cycle change. Annual uses monthly × 10
  // (preserves the ~17% discount baked into the static PLANS.annual values).
  const priceCalc = useMemo(() => priceFor({
    basePlanMonthly: selectedPlan.monthly,
    planKey:         selectedPlan.id,
    selectedKeys:    selectedModules,
  }), [selectedPlan.id, selectedPlan.monthly, selectedModules]);

  const selectPlan = (planId: string) => {
    const plan = PLANS.find(p => p.id === planId)!;
    const price = billingCycle === "annual" ? plan.annual : plan.monthly;
    const endDate = billingCycle === "annual"
      ? new Date(Date.now() + 365 * 86400000).toISOString().split("T")[0]
      : new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
    setForm(f => ({ ...f, plan: planId, billingCycle, price: String(price), endDate }));
  };

  const toggleBilling = (cycle: "monthly" | "annual") => {
    setBillingCycle(cycle);
    const endDate = cycle === "annual"
      ? new Date(Date.now() + 365 * 86400000).toISOString().split("T")[0]
      : new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
    setForm(f => ({ ...f, billingCycle: cycle, endDate }));
  };

  const handleSubmit = async () => {
    setError("");
    setLoading(true);
    try {
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          billingCycle,
          // New: industry classification + per-module selection from Step 1.
          selectedIndustries,
          selectedModules,
          // Send the dynamically-computed price (base + module add-ons) so
          // the subscription record matches what the user actually saw.
          price: String(billingCycle === "annual" ? priceCalc.total * 10 : priceCalc.total),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "حدث خطأ");

      if (data.pending) {
        // Self-registration: redirect to pending approval page
        setLocation("/pending-approval");
      } else if (data.token) {
        // Admin-created: auto-login
        await register(form as RegisterData);
        setLocation("/");
      } else {
        setLocation("/pending-approval");
      }
    } catch (err: any) {
      setError(err.message ?? "حدث خطأ. حاول مرة أخرى.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-muted flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-2xl">

        {/* Logo */}
        <div className="text-center mb-6">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground text-xl font-bold mb-3 shadow-lg">Z</div>
          <h1 className="text-2xl font-bold text-foreground">إنشاء حساب جديد</h1>
          <p className="text-muted-foreground mt-1 text-sm">سجّل شركتك وابدأ إصدار فواتير متوافقة مع ZATCA</p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center mb-6 gap-0">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center">
              <button
                onClick={() => i < step && setStep(i)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all",
                  i === step ? "bg-primary text-primary-foreground shadow" :
                  i < step  ? "bg-primary/20 text-primary cursor-pointer hover:bg-primary/30" :
                              "bg-muted text-muted-foreground"
                )}>
                {i < step ? <Check className="h-3 w-3" /> : s.icon}
                {s.label}
              </button>
              {i < STEPS.length - 1 && <div className={cn("h-px w-6 mx-1", i < step ? "bg-primary" : "bg-border")} />}
            </div>
          ))}
        </div>

        <Card className="shadow-xl">
          <CardContent className="pt-6">

            {/* ─── Step 0: Company ─── */}
            {step === 0 && (
              <div className="space-y-5">
                <h3 className="font-semibold text-foreground flex items-center gap-2"><Building2 className="h-4 w-4" />بيانات الشركة</h3>

                {/* Country + currency. Country drives the displayed
                    compliance policy and seeds the company's default
                    currency on the backend. */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium flex items-center gap-1.5">
                      <Globe2 className="h-4 w-4 text-muted-foreground" />الدولة <span className="text-destructive">*</span>
                    </label>
                    <select
                      value={form.country ?? DEFAULT_COUNTRY_CODE}
                      onChange={e => handleCountryChange(e.target.value)}
                      className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {COUNTRIES.map(c => (
                        <option key={c.code} value={c.code}>{c.nameAr}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">العملة الافتراضية</label>
                    <Input
                      value={`${selectedCountry.currency.nameAr} (${selectedCountry.currency.code}) ${selectedCountry.currency.symbol}`}
                      readOnly
                      className="bg-muted/30 cursor-not-allowed"
                    />
                    <p className="text-xs text-muted-foreground">يتم تعيينها تلقائياً حسب الدولة، يمكنك تعديلها لاحقاً من إعدادات العملات</p>
                  </div>
                </div>

                {/* Country-specific compliance policy preview */}
                <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-sm">
                  <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
                  <div className="space-y-0.5">
                    <div className="font-medium">سياسة التسجيل في {selectedCountry.nameAr}</div>
                    <div className="text-xs opacity-90">{policyText}</div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="sm:col-span-2 space-y-1.5">
                    <label className="text-sm font-medium">اسم الشركة (عربي) <span className="text-destructive">*</span></label>
                    <Input value={form.nameAr ?? ""} onChange={e => set("nameAr", e.target.value)} placeholder="شركة النجاح للتجارة" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">اسم الشركة (إنجليزي)</label>
                    <Input value={form.nameEn ?? ""} onChange={e => set("nameEn", e.target.value)} placeholder="AlNajah Trading Co." dir="ltr" className="text-left" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">الرقم الضريبي (VAT) <span className="text-destructive">*</span></label>
                    <Input value={form.vatNumber ?? ""} onChange={e => set("vatNumber", e.target.value)} placeholder="310000000000003" dir="ltr" className="text-left font-mono" maxLength={15} />
                    <p className="text-xs text-muted-foreground">15 رقماً — يبدأ بـ 3</p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">رقم السجل التجاري <span className="text-destructive">*</span></label>
                    <Input value={form.crNumber ?? ""} onChange={e => set("crNumber", e.target.value)} placeholder="1010000001" dir="ltr" className="text-left font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">المدينة</label>
                    <Input value={form.city ?? ""} onChange={e => set("city", e.target.value)} placeholder="الرياض" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">اسم الشارع</label>
                    <Input value={form.street ?? ""} onChange={e => set("street", e.target.value)} placeholder="شارع الأمير محمد" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">رقم المبنى</label>
                    <Input value={form.buildingNumber ?? ""} onChange={e => set("buildingNumber", e.target.value)} placeholder="1234" dir="ltr" className="text-left" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">الرمز البريدي</label>
                    <Input value={form.postalCode ?? ""} onChange={e => set("postalCode", e.target.value)} placeholder="12345" dir="ltr" className="text-left" maxLength={5} />
                  </div>
                </div>
                <div className="flex justify-end pt-2">
                  <Button onClick={() => {
                    if (!form.nameAr || !form.vatNumber || !form.crNumber) { setError("اسم الشركة والرقم الضريبي والسجل التجاري مطلوبة"); return; }
                    setError(""); setStep(1);
                  }} className="gap-2">
                    التالي <ChevronLeft className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* ─── Step 1: Industry + Plan + Modules ─── */}
            {step === 1 && (
              <div className="space-y-5">
                <h3 className="font-semibold text-foreground flex items-center gap-2">
                  <Package className="h-4 w-4" />اختر نشاطك ووحدات نظامك
                </h3>

                {/* ── 1. Industry multi-select chips ── */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <label className="text-sm font-medium flex items-center gap-1.5">
                      <Sparkles className="h-4 w-4 text-primary" />
                      نوع نشاط الشركة
                      <span className="text-xs font-normal text-muted-foreground">(اختر واحد أو أكثر)</span>
                    </label>
                    <div className="flex gap-3 text-xs">
                      <button type="button" onClick={selectAllIndustries}
                        className="text-primary hover:underline" data-testid="industry-select-all">
                        اختيار الكل
                      </button>
                      {selectedIndustries.length > 0 && (
                        <button type="button" onClick={clearIndustries}
                          className="text-muted-foreground hover:text-destructive" data-testid="industry-clear">
                          مسح
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {INDUSTRIES.map(ind => {
                      const active = selectedIndustries.includes(ind.code);
                      return (
                        <button key={ind.code} type="button"
                          data-testid={`industry-chip-${ind.code}`}
                          onClick={() => toggleIndustry(ind.code)}
                          className={cn(
                            "flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 text-sm transition-all",
                            active
                              ? "border-primary bg-primary/10 text-primary font-medium shadow-sm"
                              : "border-border bg-card text-muted-foreground hover:border-primary/40"
                          )}>
                          <span className="text-base leading-none">{ind.emoji}</span>
                          {ind.nameAr}
                          {active && <Check className="h-3.5 w-3.5" />}
                        </button>
                      );
                    })}
                  </div>
                  {selectedIndustries.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      اختر نشاطاً واحداً أو أكثر لاقتراح الوحدات المناسبة تلقائياً، أو حدّد الوحدات يدوياً أسفله.
                    </p>
                  )}
                </div>

                {/* ── 2. Billing cycle ── */}
                <div className="flex items-center justify-center gap-3 pt-3 border-t">
                  <button onClick={() => toggleBilling("monthly")} type="button"
                    className={cn("px-4 py-1.5 rounded-full text-sm font-medium transition-all",
                      billingCycle === "monthly" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                    شهري
                  </button>
                  <button onClick={() => toggleBilling("annual")} type="button"
                    className={cn("px-4 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1",
                      billingCycle === "annual" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                    سنوي
                    <span className="text-xs bg-green-100 text-green-700 rounded-full px-1.5 py-0.5">وفّر ~17%</span>
                  </button>
                </div>

                {/* ── 3. Plan tier picker (compact, with "X included free" tag) ── */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {PLANS.map(plan => {
                    const price = billingCycle === "annual" ? plan.annual : plan.monthly;
                    const isSelected = form.plan === plan.id;
                    const included = PLAN_INCLUDED[plan.id] ?? 0;
                    const includedLabel = included >= SELECTABLE_MODULES.length
                      ? "كل الوحدات مجاناً"
                      : `${included} وحدات مشمولة`;
                    return (
                      <button key={plan.id} type="button"
                        data-testid={`plan-${plan.id}`}
                        onClick={() => selectPlan(plan.id)}
                        className={cn(
                          "relative rounded-xl border-2 p-3 text-right transition-all hover:shadow-md",
                          isSelected ? plan.activeColor : "border-border bg-card hover:border-primary/40"
                        )}>
                        {plan.recommended && (
                          <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-[10px] bg-primary text-primary-foreground rounded-full px-2 py-0.5 whitespace-nowrap">
                            الأكثر شيوعاً
                          </span>
                        )}
                        <div className="flex items-center gap-2 mb-1">
                          <div className={cn("inline-flex p-1.5 rounded-lg", plan.badgeColor)}>{plan.icon}</div>
                          <span className="font-bold text-foreground text-sm">{plan.name}</span>
                        </div>
                        <div className="text-xl font-bold mt-0.5">
                          {price} <span className="text-[11px] font-normal text-muted-foreground">ر.س/{billingCycle === "annual" ? "سنة" : "شهر"}</span>
                        </div>
                        <div className="text-[11px] text-primary mt-1.5 font-medium">{includedLabel}</div>
                        {isSelected && <div className="absolute top-2 left-2"><Check className="h-3.5 w-3.5 text-primary" /></div>}
                      </button>
                    );
                  })}
                </div>

                {/* ── 4. Module catalog (grouped by category) ── */}
                <div className="space-y-3 pt-3 border-t">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <h4 className="text-sm font-semibold flex items-center gap-2">
                      <Package className="h-4 w-4" />
                      وحدات النظام
                      <span className="text-xs font-normal text-muted-foreground">
                        (محددة {selectedModules.length} من {SELECTABLE_MODULES.length})
                      </span>
                    </h4>
                  </div>

                  {CATEGORIES.map(cat => {
                    const mods = SELECTABLE_MODULES.filter(m => m.category === cat.key);
                    if (mods.length === 0) return null;
                    return (
                      <div key={cat.key} className="space-y-2">
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          {cat.nameAr}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {mods.map(m => {
                            const checked = selectedModules.includes(m.key);
                            return (
                              <label key={m.key}
                                data-testid={`module-${m.key}`}
                                className={cn(
                                  "flex items-start gap-2 p-2.5 rounded-lg border-2 cursor-pointer transition-all hover:shadow-sm",
                                  checked ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/40"
                                )}>
                                <input type="checkbox" checked={checked}
                                  onChange={() => toggleModule(m.key)}
                                  className="mt-0.5 h-4 w-4 accent-primary cursor-pointer" />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium text-sm flex items-center gap-1.5">
                                      <span className="text-base leading-none">{m.emoji}</span>
                                      {m.nameAr}
                                    </span>
                                    <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                                      +{m.monthlyPrice} ر.س
                                    </span>
                                  </div>
                                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{m.descAr}</p>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* ── 5. Live total / breakdown ── */}
                <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-4 space-y-2"
                     data-testid="price-summary">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">الباقة الأساسية ({selectedPlan.name}):</span>
                    <span className="font-medium">{priceCalc.base} ر.س/شهر</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">وحدات مجانية مشمولة بالباقة:</span>
                    <span className="font-medium text-green-700">{priceCalc.includedFree} وحدة</span>
                  </div>
                  {priceCalc.extraCount > 0 && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">
                        وحدات إضافية ({priceCalc.extraCount}):
                      </span>
                      <span className="font-medium">+{priceCalc.extraSubtotal} ر.س/شهر</span>
                    </div>
                  )}
                  <div className="border-t border-primary/20 pt-2 flex items-center justify-between">
                    <span className="font-bold text-foreground">الإجمالي:</span>
                    <span className="text-2xl font-bold text-primary" data-testid="price-total">
                      {billingCycle === "annual" ? priceCalc.total * 10 : priceCalc.total}
                      <span className="text-xs font-normal text-muted-foreground mr-1">
                        {" "}ر.س/{billingCycle === "annual" ? "سنة" : "شهر"}
                      </span>
                    </span>
                  </div>
                </div>

                {/* dates */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">تاريخ بدء الاشتراك</label>
                    <Input type="date" value={form.startDate ?? ""} onChange={e => set("startDate", e.target.value)} dir="ltr" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">تاريخ انتهاء الاشتراك</label>
                    <Input type="date" value={form.endDate ?? ""} onChange={e => set("endDate", e.target.value)} dir="ltr" />
                  </div>
                </div>

                <div className="flex justify-between pt-2">
                  <Button variant="ghost" onClick={() => setStep(0)} className="gap-2"><ChevronRight className="h-4 w-4" />رجوع</Button>
                  <Button onClick={() => { setError(""); setStep(2); }} className="gap-2" data-testid="step1-next">
                    التالي <ChevronLeft className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* ─── Step 2: Admin User ─── */}
            {step === 2 && (
              <div className="space-y-5">
                <h3 className="font-semibold text-foreground flex items-center gap-2"><User className="h-4 w-4" />حساب المدير</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">اسم المستخدم <span className="text-destructive">*</span></label>
                    <Input value={form.username ?? ""} onChange={e => set("username", e.target.value.toLowerCase())}
                      placeholder="admin_company" dir="ltr" className="text-left" autoComplete="off" />
                    <p className="text-xs text-muted-foreground">حروف صغيرة وأرقام فقط، بدون مسافات</p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">البريد الإلكتروني</label>
                    <Input value={form.email ?? ""} onChange={e => set("email", e.target.value)}
                      placeholder="admin@company.com" dir="ltr" className="text-left" type="email" />
                  </div>
                  <div className="sm:col-span-2 space-y-1.5">
                    <label className="text-sm font-medium">كلمة المرور <span className="text-destructive">*</span></label>
                    <div className="relative">
                      <Input
                        type={showPass ? "text" : "password"}
                        value={form.password ?? ""}
                        onChange={e => set("password", e.target.value)}
                        placeholder="8 أحرف على الأقل"
                        dir="ltr" className="text-left pl-10"
                        autoComplete="new-password"
                      />
                      <button type="button" onClick={() => setShowPass(!showPass)}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    {form.password && form.password.length < 8 && (
                      <p className="text-xs text-amber-600">كلمة المرور يجب أن تكون 8 أحرف على الأقل</p>
                    )}
                  </div>
                </div>
                <div className="flex justify-between pt-2">
                  <Button variant="ghost" onClick={() => setStep(1)} className="gap-2"><ChevronRight className="h-4 w-4" />رجوع</Button>
                  <Button onClick={() => {
                    if (!form.username || !form.password) { setError("اسم المستخدم وكلمة المرور مطلوبان"); return; }
                    if (form.password.length < 8) { setError("كلمة المرور يجب أن تكون 8 أحرف على الأقل"); return; }
                    setError(""); setStep(3);
                  }} className="gap-2">التالي <ChevronLeft className="h-4 w-4" /></Button>
                </div>
              </div>
            )}

            {/* ─── Step 3: Confirm ─── */}
            {step === 3 && (
              <div className="space-y-5">
                <h3 className="font-semibold text-foreground flex items-center gap-2"><Check className="h-4 w-4" />مراجعة وتأكيد</h3>
                <div className="rounded-xl border bg-muted/20 p-4 space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-muted-foreground">الشركة:</span><span className="font-medium">{form.nameAr}</span>
                    <span className="text-muted-foreground">الدولة:</span><span className="font-medium">{selectedCountry.nameAr}</span>
                    <span className="text-muted-foreground">العملة:</span><span className="font-medium">{selectedCountry.currency.nameAr} ({selectedCountry.currency.code})</span>
                    <span className="text-muted-foreground">الرقم الضريبي:</span><span className="font-mono text-xs">{form.vatNumber}</span>
                    <span className="text-muted-foreground">الباقة:</span>
                    <span className="font-medium">{selectedPlan.name} — {billingCycle === "annual" ? priceCalc.total * 10 : priceCalc.total} ر.س/{billingCycle === "annual" ? "سنة" : "شهر"}</span>
                    <span className="text-muted-foreground">المستخدمون:</span><span>{selectedPlan.maxUsers === 999 ? "غير محدود" : selectedPlan.maxUsers}</span>
                    <span className="text-muted-foreground">الفواتير الشهرية:</span><span>{selectedPlan.maxInvoices === 999999 ? "غير محدودة" : selectedPlan.maxInvoices}</span>
                    <span className="text-muted-foreground">نشاط الشركة:</span>
                    <span className="font-medium">
                      {selectedIndustries.length === 0
                        ? "—"
                        : selectedIndustries
                            .map(c => INDUSTRIES.find(i => i.code === c)?.nameAr ?? c)
                            .join("، ")}
                    </span>
                    <span className="text-muted-foreground">الوحدات المختارة:</span>
                    <span className="font-medium">
                      {selectedModules.length === 0
                        ? "الأساسيات فقط"
                        : `${selectedModules.length} وحدة (${selectedModules.map(k => SELECTABLE_MODULES.find(m => m.key === k)?.nameAr ?? k).join("، ")})`}
                    </span>
                    <span className="text-muted-foreground">تاريخ البدء:</span><span>{form.startDate}</span>
                    <span className="text-muted-foreground">تاريخ الانتهاء:</span><span>{form.endDate}</span>
                    <span className="text-muted-foreground">اسم المستخدم:</span><span className="font-mono text-xs">{form.username}</span>
                  </div>
                </div>

                {/* Country-policy acceptance gate. Required to submit. */}
                <label className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer hover:bg-amber-100/60 transition-colors">
                  <input
                    type="checkbox"
                    checked={acceptedPolicy}
                    onChange={e => setAcceptedPolicy(e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-amber-400 accent-amber-600 cursor-pointer"
                  />
                  <span className="text-sm text-amber-900">
                    أوافق على <span className="font-semibold">{policyText}</span> وأقرّ بأن البيانات المُدخلة صحيحة.
                  </span>
                </label>

                <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-sm">
                  <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-blue-600" />
                  <span>بالتسجيل، أنت توافق على الشروط والأحكام وسياسة الخصوصية.</span>
                </div>

                {error && <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">{error}</div>}

                <div className="flex justify-between pt-2">
                  <Button variant="ghost" onClick={() => setStep(2)} className="gap-2"><ChevronRight className="h-4 w-4" />رجوع</Button>
                  <Button
                    onClick={() => {
                      if (!acceptedPolicy) {
                        setError("يجب الموافقة على سياسة الدولة لإكمال التسجيل");
                        return;
                      }
                      setError("");
                      handleSubmit();
                    }}
                    className="gap-2"
                    disabled={loading || !acceptedPolicy}
                    title={!acceptedPolicy ? "يجب الموافقة على سياسة الدولة أولاً" : undefined}
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {loading ? "جاري الإنشاء..." : "إنشاء الحساب"}
                  </Button>
                </div>
              </div>
            )}

            {error && step < 3 && (
              <p className="text-sm text-destructive mt-3">{error}</p>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground mt-4">
          لديك حساب بالفعل؟{" "}
          <a href="/login" onClick={e => { e.preventDefault(); setLocation("/login"); }}
            className="text-primary font-medium hover:underline">تسجيل الدخول</a>
        </p>
      </div>
    </div>
  );
}

