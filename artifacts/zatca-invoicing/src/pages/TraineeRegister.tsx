import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { User, Eye, EyeOff, Loader2, ChevronRight, GraduationCap } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// All 22 Arab-League countries with their dial codes — the spec requires the
// trainee form to be open to every Arab country (not just SA).
export const ARAB_COUNTRIES: { code: string; nameAr: string; dial: string }[] = [
  { code: "SA", nameAr: "المملكة العربية السعودية", dial: "+966" },
  { code: "EG", nameAr: "مصر",                      dial: "+20"  },
  { code: "AE", nameAr: "الإمارات العربية المتحدة", dial: "+971" },
  { code: "KW", nameAr: "الكويت",                   dial: "+965" },
  { code: "QA", nameAr: "قطر",                      dial: "+974" },
  { code: "BH", nameAr: "البحرين",                  dial: "+973" },
  { code: "OM", nameAr: "سلطنة عمان",               dial: "+968" },
  { code: "JO", nameAr: "الأردن",                   dial: "+962" },
  { code: "IQ", nameAr: "العراق",                   dial: "+964" },
  { code: "SY", nameAr: "سوريا",                    dial: "+963" },
  { code: "LB", nameAr: "لبنان",                    dial: "+961" },
  { code: "PS", nameAr: "فلسطين",                   dial: "+970" },
  { code: "YE", nameAr: "اليمن",                    dial: "+967" },
  { code: "LY", nameAr: "ليبيا",                    dial: "+218" },
  { code: "TN", nameAr: "تونس",                     dial: "+216" },
  { code: "DZ", nameAr: "الجزائر",                  dial: "+213" },
  { code: "MA", nameAr: "المغرب",                   dial: "+212" },
  { code: "MR", nameAr: "موريتانيا",                dial: "+222" },
  { code: "SD", nameAr: "السودان",                  dial: "+249" },
  { code: "SO", nameAr: "الصومال",                  dial: "+252" },
  { code: "DJ", nameAr: "جيبوتي",                   dial: "+253" },
  { code: "KM", nameAr: "جزر القمر",                dial: "+269" },
];

export default function TraineeRegister() {
  const [, setLocation] = useLocation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [country, setCountry] = useState("SA");
  const [phoneCountryKey, setPhoneCountryKey] = useState("+966");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [industry, setIndustry] = useState("");
  const [experienceYears, setExperienceYears] = useState("0");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);

  const onCountryChange = (code: string) => {
    setCountry(code);
    const c = ARAB_COUNTRIES.find(x => x.code === code);
    if (c) setPhoneCountryKey(c.dial);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    // فحص فوري لصيغة الإيميل قبل إرسال أي شيء للخادم — يمنع أخطاء مثل gmail.com6
    const emailOk = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/.test(email.trim());
    if (!emailOk) { setError("⚠️ الرجاء إدخال البريد الإلكتروني بشكل صحيح — تأكد من كتابة العنوان مثل: name@gmail.com"); return; }
    if (password !== confirmPassword) { setError("كلمتا المرور غير متطابقتين"); return; }
    if (!termsAccepted) { setError("يجب الموافقة على الشروط والأحكام"); return; }
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/auth/trainee-register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName, email, phone, phoneCountryKey, country,
          city: city || undefined,
          companyName: companyName || undefined,
          jobTitle, industry,
          experienceYears: Number(experienceYears),
          password, confirmPassword, termsAccepted,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j?.error || "تعذّر إرسال الطلب. حاول مرة أخرى."); return; }
      setSuccessMessage(j?.message || "🎉 تم استلام طلبك بنجاح!");
    } catch {
      setError("تعذّر الاتصال بالخادم. حاول مرة أخرى.");
    } finally {
      setLoading(false);
    }
  };

  if (successMessage) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-background to-muted flex items-center justify-center p-4" dir="rtl">
        <div className="w-full max-w-xl">
          <Card className="shadow-xl border-emerald-300">
            <CardContent className="pt-8 pb-6 space-y-5 text-center">
              <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                <GraduationCap className="h-7 w-7" />
              </div>
              <div className="text-sm text-foreground leading-relaxed whitespace-pre-line text-right bg-emerald-50/60 border border-emerald-200 rounded-xl p-4"
                   data-testid="trainee-register-success-message">
                {successMessage}
              </div>
              <Button className="w-full" onClick={() => setLocation("/login")} data-testid="trainee-register-goto-login">
                العودة لتسجيل الدخول
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-background to-muted flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-6">
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt="زاكود Zacode"
            width={48} height={48}
            className="inline-block h-12 w-12 rounded-xl mb-3 shadow-lg"
          />
          <h1 className="text-2xl font-bold text-foreground">طلب حساب متدرب</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            سجّل بياناتك وسيقوم فريقنا بمراجعة الطلب وتفعيل حسابك التدريبي
          </p>
        </div>

        <Card className="shadow-xl">
          <CardContent className="pt-6">
            <form onSubmit={submit} className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">الاسم الكامل <span className="text-destructive">*</span></label>
                  <Input value={fullName} onChange={e => setFullName(e.target.value)} required maxLength={120}
                         data-testid="trainee-full-name" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">البريد الإلكتروني (اسم المستخدم) <span className="text-destructive">*</span></label>
                  <Input type="email" value={email} onChange={e => setEmail(e.target.value)} required dir="ltr"
                         className="text-left" placeholder="you@example.com" data-testid="trainee-email" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">الدولة <span className="text-destructive">*</span></label>
                  <Select value={country} onValueChange={onCountryChange}>
                    <SelectTrigger data-testid="trainee-country"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ARAB_COUNTRIES.map(c => (
                        <SelectItem key={c.code} value={c.code}>{c.nameAr} ({c.dial})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">رقم الجوال <span className="text-destructive">*</span></label>
                  <div className="flex gap-2" dir="ltr">
                    <Input value={phoneCountryKey} onChange={e => setPhoneCountryKey(e.target.value)}
                           className="w-20 text-left font-mono" maxLength={8} data-testid="trainee-phone-key" />
                    <Input value={phone} onChange={e => setPhone(e.target.value.replace(/[^\d]/g, ""))}
                           required className="flex-1 text-left" placeholder="5XXXXXXXX" maxLength={30}
                           inputMode="tel" data-testid="trainee-phone" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">المدينة (اختياري)</label>
                  <Input value={city} onChange={e => setCity(e.target.value)} maxLength={120} data-testid="trainee-city" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">اسم الشركة (اختياري)</label>
                  <Input value={companyName} onChange={e => setCompanyName(e.target.value)} maxLength={160}
                         data-testid="trainee-company-name" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">المسمى الوظيفي <span className="text-destructive">*</span></label>
                  <Input value={jobTitle} onChange={e => setJobTitle(e.target.value)} required maxLength={120}
                         placeholder="محاسب، مدير مبيعات…" data-testid="trainee-job-title" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">مجال النشاط <span className="text-destructive">*</span></label>
                  <Input value={industry} onChange={e => setIndustry(e.target.value)} required maxLength={120}
                         placeholder="تجارة تجزئة، مقاولات…" data-testid="trainee-industry" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">سنوات الخبرة <span className="text-destructive">*</span></label>
                  <Input type="text" inputMode="numeric" dir="ltr" className="text-left"
                         value={experienceYears}
                         onChange={e => setExperienceYears(e.target.value.replace(/[^\d]/g, "").slice(0, 2))}
                         required data-testid="trainee-experience-years" />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">كلمة المرور <span className="text-destructive">*</span></label>
                  <div className="relative">
                    <Input type={showPass ? "text" : "password"} value={password}
                           onChange={e => setPassword(e.target.value)} required minLength={8} dir="ltr"
                           className="text-left pl-10" data-testid="trainee-password" />
                    <button type="button" onClick={() => setShowPass(!showPass)}
                            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">تأكيد كلمة المرور <span className="text-destructive">*</span></label>
                  <Input type={showPass ? "text" : "password"} value={confirmPassword}
                         onChange={e => setConfirmPassword(e.target.value)} required minLength={8} dir="ltr"
                         className="text-left" data-testid="trainee-confirm-password" />
                </div>
              </div>

              <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
                <Checkbox checked={termsAccepted} onCheckedChange={v => setTermsAccepted(v === true)}
                          className="mt-0.5" data-testid="trainee-terms" />
                <span>أوافق على الشروط والأحكام وسياسة الخصوصية الخاصة بمنصة ZacoERP.</span>
              </label>

              {error && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2"
                     data-testid="trainee-register-error">
                  {error}
                </div>
              )}

              <Button type="submit" className="w-full gap-2" disabled={loading} data-testid="trainee-register-submit">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <User className="h-4 w-4" />}
                إرسال طلب التدريب
              </Button>

              <p className="text-center text-sm text-muted-foreground">
                <button type="button" className="text-primary font-medium hover:underline inline-flex items-center gap-1"
                        onClick={() => setLocation("/register")}>
                  <ChevronRight className="h-3.5 w-3.5" />
                  العودة لاختيار نوع الحساب
                </button>
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
