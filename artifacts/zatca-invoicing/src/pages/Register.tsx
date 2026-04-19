import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth, type RegisterData } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  Building2, User, Package, Check, ChevronLeft, ChevronRight,
  Eye, EyeOff, Loader2, ShieldCheck, Star, Zap, Crown
} from "lucide-react";
import { cn } from "@/lib/utils";

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

  const [form, setForm] = useState<Partial<RegisterData>>({
    country: "SA", invoiceType: "both", plan: "professional", billingCycle: "monthly",
    startDate: new Date().toISOString().split("T")[0],
    endDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
  });

  const set = (k: keyof RegisterData, v: string) => setForm(f => ({ ...f, [k]: v }));

  const selectedPlan = PLANS.find(p => p.id === form.plan) ?? PLANS[1];

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
      await register(form as RegisterData);
      toast({ title: "تم إنشاء الحساب بنجاح!", description: "مرحباً بك في نظام الفاتورة الإلكترونية" });
      setLocation("/");
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

            {/* ─── Step 1: Plan ─── */}
            {step === 1 && (
              <div className="space-y-5">
                <h3 className="font-semibold text-foreground flex items-center gap-2"><Package className="h-4 w-4" />اختر الباقة المناسبة</h3>

                {/* Billing toggle */}
                <div className="flex items-center justify-center gap-3">
                  <button onClick={() => toggleBilling("monthly")}
                    className={cn("px-4 py-1.5 rounded-full text-sm font-medium transition-all", billingCycle === "monthly" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                    شهري
                  </button>
                  <button onClick={() => toggleBilling("annual")}
                    className={cn("px-4 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1", billingCycle === "annual" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                    سنوي
                    <span className="text-xs bg-green-100 text-green-700 rounded-full px-1.5 py-0.5">وفّر 15%</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {PLANS.map(plan => {
                    const price = billingCycle === "annual" ? plan.annual : plan.monthly;
                    const isSelected = form.plan === plan.id;
                    return (
                      <button key={plan.id} onClick={() => selectPlan(plan.id)}
                        className={cn("relative rounded-xl border-2 p-4 text-right transition-all hover:shadow-md",
                          isSelected ? plan.activeColor : "border-border bg-card hover:border-primary/40")}>
                        {plan.recommended && (
                          <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-xs bg-primary text-primary-foreground rounded-full px-2 py-0.5 whitespace-nowrap">
                            الأكثر شيوعاً
                          </span>
                        )}
                        <div className={cn("inline-flex p-2 rounded-lg mb-3", plan.badgeColor)}>{plan.icon}</div>
                        <div className="font-bold text-foreground">{plan.name}</div>
                        <div className="text-2xl font-bold mt-1">
                          {price} <span className="text-sm font-normal text-muted-foreground">ر.س/{billingCycle === "annual" ? "سنة" : "شهر"}</span>
                        </div>
                        <ul className="mt-3 space-y-1.5">
                          {plan.features.map(f => (
                            <li key={f} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Check className="h-3 w-3 text-green-600 shrink-0" />{f}
                            </li>
                          ))}
                        </ul>
                        {isSelected && <div className="absolute top-3 left-3"><Check className="h-4 w-4 text-primary" /></div>}
                      </button>
                    );
                  })}
                </div>

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
                  <Button onClick={() => { setError(""); setStep(2); }} className="gap-2">التالي <ChevronLeft className="h-4 w-4" /></Button>
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
                    <span className="text-muted-foreground">الرقم الضريبي:</span><span className="font-mono text-xs">{form.vatNumber}</span>
                    <span className="text-muted-foreground">الباقة:</span>
                    <span className="font-medium">{selectedPlan.name} — {billingCycle === "annual" ? selectedPlan.annual : selectedPlan.monthly} ر.س/{billingCycle === "annual" ? "سنة" : "شهر"}</span>
                    <span className="text-muted-foreground">المستخدمون:</span><span>{selectedPlan.maxUsers === 999 ? "غير محدود" : selectedPlan.maxUsers}</span>
                    <span className="text-muted-foreground">الفواتير الشهرية:</span><span>{selectedPlan.maxInvoices === 999999 ? "غير محدودة" : selectedPlan.maxInvoices}</span>
                    <span className="text-muted-foreground">تاريخ البدء:</span><span>{form.startDate}</span>
                    <span className="text-muted-foreground">تاريخ الانتهاء:</span><span>{form.endDate}</span>
                    <span className="text-muted-foreground">اسم المستخدم:</span><span className="font-mono text-xs">{form.username}</span>
                  </div>
                </div>

                <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-sm">
                  <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-blue-600" />
                  <span>بالتسجيل، أنت توافق على الشروط والأحكام وسياسة الخصوصية.</span>
                </div>

                {error && <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">{error}</div>}

                <div className="flex justify-between pt-2">
                  <Button variant="ghost" onClick={() => setStep(2)} className="gap-2"><ChevronRight className="h-4 w-4" />رجوع</Button>
                  <Button onClick={handleSubmit} className="gap-2" disabled={loading}>
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

