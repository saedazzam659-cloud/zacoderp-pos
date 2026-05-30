// Protected install wizard ("معالج التثبيت") at /install.
// Gates the POS Desktop MSI download behind BOTH a user login AND a
// SuperAdmin-issued activation code (double protection). The public
// /download page stays untouched — this is the locked path.
//
// 3 steps: (1) verify (company code + username + password + activation
// code) → (2) choose country / version → (3) download.
// The auth token lives ONLY in component state (never written to the
// app's auth localStorage) so reaching this page does not silently log
// the visitor into the rest of the app.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Download as DLIcon, Monitor, ShieldCheck, KeyRound, Globe, CheckCircle2,
  Loader2, HardDrive, Lock, ArrowLeft, AlertCircle,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const COUNTRIES: { code: string; nameAr: string; flag: string }[] = [
  { code: "SA", nameAr: "السعودية", flag: "🇸🇦" },
  { code: "AE", nameAr: "الإمارات", flag: "🇦🇪" },
  { code: "KW", nameAr: "الكويت", flag: "🇰🇼" },
  { code: "QA", nameAr: "قطر", flag: "🇶🇦" },
  { code: "BH", nameAr: "البحرين", flag: "🇧🇭" },
  { code: "OM", nameAr: "عُمان", flag: "🇴🇲" },
  { code: "JO", nameAr: "الأردن", flag: "🇯🇴" },
  { code: "EG", nameAr: "مصر", flag: "🇪🇬" },
  { code: "ALL", nameAr: "أخرى / دولي", flag: "🌍" },
];

type Release = {
  id: number; countryCode: string; platform: string; version: string;
  fileSizeBytes: number | null; checksumSha256: string | null;
  releaseNotes: string | null; publishedAt: string; fallback?: boolean;
};

const STEPS = ["التحقق", "اختيار الإصدار", "التنزيل"];

export default function InstallWizard() {
  const [step, setStep] = useState(1);
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Step 1 — credentials + activation code
  const [companyCode, setCompanyCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  // Step 2 — release selection
  const [country, setCountry] = useState("SA");
  const [release, setRelease] = useState<Release | null>(null);
  const [loadingRelease, setLoadingRelease] = useState(false);

  // Step 3 — download
  const [downloading, setDownloading] = useState(false);
  const [done, setDone] = useState(false);

  const sizeStr = (b: number | null | undefined) =>
    !b ? "—" : `${(b / 1024 / 1024).toFixed(1)} ميجابايت`;

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!companyCode.trim() || !username.trim() || !password || !code.trim()) {
      setErr("يرجى تعبئة جميع الحقول للمتابعة");
      return;
    }
    setVerifying(true);
    try {
      const lr = await fetch(`${API}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password, companyCode: companyCode.trim() }),
      });
      const lj = await lr.json().catch(() => ({}));
      if (!lr.ok || !lj.token) {
        setErr(lj.error || "فشل تسجيل الدخول. تحقق من كود الشركة واسم المستخدم وكلمة المرور.");
        setVerifying(false); return;
      }
      const tok = lj.token as string;
      const vr = await fetch(`${API}/api/download-wizard/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ code: code.trim() }),
      });
      const vj = await vr.json().catch(() => ({}));
      if (!vr.ok) { setErr(vj.error || "كود التفعيل غير صحيح"); setVerifying(false); return; }
      setToken(tok);
      setStep(2);
      void loadRelease(tok, country);
    } catch {
      setErr("تعذر الاتصال بالخادم. حاول لاحقاً.");
    }
    setVerifying(false);
  }

  async function loadRelease(tok: string, c: string) {
    setLoadingRelease(true); setRelease(null); setErr(null);
    try {
      const r = await fetch(
        `${API}/api/download-wizard/release?code=${encodeURIComponent(code.trim())}&country=${c}&platform=win-x64-exe`,
        { headers: { Authorization: `Bearer ${tok}` } },
      );
      if (r.status === 404) { setRelease(null); setLoadingRelease(false); return; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || "تعذر تحميل بيانات الإصدار"); setLoadingRelease(false); return; }
      setRelease(j);
    } catch {
      setErr("تعذر تحميل بيانات الإصدار");
    }
    setLoadingRelease(false);
  }

  function onCountryChange(c: string) {
    setCountry(c);
    if (token) void loadRelease(token, c);
  }

  async function handleDownload() {
    if (!token) return;
    setDownloading(true); setErr(null);
    try {
      const r = await fetch(`${API}/api/download-wizard/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: code.trim(), country, platform: "win-x64-exe" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || "تعذر بدء التنزيل"); setDownloading(false); return; }
      setDone(true);
      window.location.href = j.downloadUrl;
    } catch {
      setErr("تعذر بدء التنزيل");
    }
    setDownloading(false);
  }

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-blue-50">
      <header className="border-b bg-white/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <a href={import.meta.env.BASE_URL} className="text-xl font-bold text-blue-700">زاكود</a>
          <nav className="text-sm flex gap-6 text-muted-foreground">
            <a href={`${import.meta.env.BASE_URL}download`} className="hover:text-foreground">صفحة التنزيل العامة</a>
            <a href={`${import.meta.env.BASE_URL}login`} className="hover:text-foreground">تسجيل الدخول</a>
          </nav>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-10 space-y-8">
        <section className="text-center space-y-3">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-semibold">
            <Lock className="h-3.5 w-3.5" /> تنزيل محمي
          </div>
          <h1 className="text-3xl md:text-4xl font-bold">معالج تثبيت نقطة البيع</h1>
          <p className="text-muted-foreground max-w-xl mx-auto">
            تنزيل آمن لتطبيق سطح المكتب — يتطلب تسجيل الدخول وكود تفعيل معتمد قبل إظهار رابط التحميل.
          </p>
        </section>

        {/* Stepper */}
        <ol className="flex items-center justify-center gap-2 md:gap-4">
          {STEPS.map((label, i) => {
            const n = i + 1;
            const active = step === n;
            const complete = step > n;
            return (
              <li key={label} className="flex items-center gap-2 md:gap-4">
                <div className="flex items-center gap-2">
                  <span className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold transition
                    ${complete ? "bg-green-600 text-white" : active ? "bg-blue-600 text-white" : "bg-slate-200 text-slate-500"}`}>
                    {complete ? <CheckCircle2 className="h-5 w-5" /> : n}
                  </span>
                  <span className={`text-sm ${active ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{label}</span>
                </div>
                {n < STEPS.length && <span className="w-6 md:w-12 h-px bg-slate-300" />}
              </li>
            );
          })}
        </ol>

        {err && (
          <div className="max-w-2xl mx-auto flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <Card className="border-2 border-blue-100 shadow-xl max-w-2xl mx-auto">
          <CardContent className="p-6 md:p-8">

            {/* STEP 1 */}
            {step === 1 && (
              <form onSubmit={handleVerify} className="space-y-5">
                <div className="flex items-center gap-2 text-blue-700">
                  <ShieldCheck className="h-5 w-5" />
                  <h2 className="font-bold text-lg">الخطوة 1 — التحقق من الهوية</h2>
                </div>
                <p className="text-sm text-muted-foreground">
                  أدخل بيانات حسابك بالإضافة إلى كود التفعيل الذي حصلت عليه من فريق المبيعات.
                </p>
                <div className="space-y-2">
                  <Label>كود الشركة</Label>
                  <Input value={companyCode} onChange={(e) => setCompanyCode(e.target.value)} placeholder="مثال: ZACOD" autoComplete="off" />
                </div>
                <div className="space-y-2">
                  <Label>اسم المستخدم</Label>
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
                </div>
                <div className="space-y-2">
                  <Label>كلمة المرور</Label>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5"><KeyRound className="h-4 w-4 text-amber-600" /> كود التفعيل</Label>
                  <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="أدخل كود التفعيل" className="font-mono tracking-wider" autoComplete="off" />
                </div>
                <Button type="submit" size="lg" className="w-full h-12 text-base" disabled={verifying}>
                  {verifying ? <><Loader2 className="ml-2 h-5 w-5 animate-spin" /> جاري التحقق...</> : <>تحقق ومتابعة</>}
                </Button>
              </form>
            )}

            {/* STEP 2 */}
            {step === 2 && (
              <div className="space-y-5">
                <div className="flex items-center gap-2 text-blue-700">
                  <Globe className="h-5 w-5" />
                  <h2 className="font-bold text-lg">الخطوة 2 — اختر الدولة والإصدار</h2>
                </div>
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <span className="text-sm text-muted-foreground">اختر دولتك لتنزيل الإصدار المناسب:</span>
                  <Select value={country} onValueChange={onCountryChange}>
                    <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {COUNTRIES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>{c.flag} {c.nameAr}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="border-t pt-5 min-h-[120px]">
                  {loadingRelease && <p className="text-center text-muted-foreground py-8"><Loader2 className="inline h-5 w-5 animate-spin ml-2" /> جاري تحميل بيانات الإصدار...</p>}
                  {!loadingRelease && !release && (
                    <div className="text-center py-8 space-y-2">
                      <Monitor className="h-10 w-10 text-muted-foreground mx-auto" />
                      <p className="text-muted-foreground">لا يتوفر إصدار للدولة المحددة. جرّب "أخرى / دولي".</p>
                    </div>
                  )}
                  {!loadingRelease && release && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge className="bg-blue-100 text-blue-700">إصدار {release.version}</Badge>
                        <Badge variant="outline">Windows 64-bit</Badge>
                        {release.fallback && <Badge className="bg-amber-100 text-amber-700">إصدار دولي</Badge>}
                        <span className="text-xs text-muted-foreground">نُشر {new Date(release.publishedAt).toLocaleDateString("ar-SA")}</span>
                      </div>
                      <div className="rounded-lg border border-blue-100 bg-gradient-to-br from-blue-50 to-white p-4 space-y-3">
                        <div className="flex items-center gap-2 text-blue-700 font-bold">
                          <Monitor className="h-5 w-5" /> نظام نقاط بيع متكامل لسطح المكتب
                        </div>
                        <p className="text-sm text-muted-foreground leading-relaxed">
                          حلٌّ احترافي شامل يدير دورة عملك بالكامل — من المبيعات حتى المحاسبة — في منظومة واحدة،
                          يعمل أونلاين وأوفلاين بمزامنة سحابية فورية لتظل بياناتك محدّثة في كل فروعك.
                        </p>
                        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                          {[
                            "إدارة المبيعات والمشتريات والمخزون",
                            "فواتير ضريبية متوافقة مع هيئة الزكاة (ZATCA)",
                            "تقارير محاسبية ومالية لحظية",
                            "دعم الموازين الإلكترونية وقارئ الباركود",
                            "تعدد الفروع والكاشيرات والعملات",
                            "يعمل بدون إنترنت مع مزامنة تلقائية عند الاتصال",
                          ].map((f) => (
                            <li key={f} className="flex items-start gap-2 text-muted-foreground">
                              <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                              <span>{f}</span>
                            </li>
                          ))}
                        </ul>
                        <div className="border-t pt-3 text-xs text-muted-foreground">
                          تطوير وإدارة فريق عمل متكامل — <span className="font-semibold text-foreground">م/ كرم عزام</span>
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground"><HardDrive className="inline h-3 w-3 ml-1" /> الحجم: {sizeStr(release.fileSizeBytes)}</div>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3">
                  <Button variant="ghost" onClick={() => { setStep(1); setErr(null); }}>
                    <ArrowLeft className="ml-1 h-4 w-4" /> رجوع
                  </Button>
                  <Button size="lg" disabled={!release} onClick={() => { setErr(null); setStep(3); }}>
                    متابعة للتنزيل
                  </Button>
                </div>
              </div>
            )}

            {/* STEP 3 */}
            {step === 3 && (
              <div className="space-y-5 text-center">
                <div className="flex items-center justify-center gap-2 text-blue-700">
                  <DLIcon className="h-5 w-5" />
                  <h2 className="font-bold text-lg">الخطوة 3 — تنزيل التطبيق</h2>
                </div>
                {release && (
                  <p className="text-muted-foreground">
                    أنت على وشك تنزيل <span className="font-semibold text-foreground">إصدار {release.version}</span> لنظام Windows (64-bit).
                  </p>
                )}
                <Button size="lg" className="h-14 px-10 text-lg" onClick={handleDownload} disabled={downloading}>
                  {downloading ? <><Loader2 className="ml-2 h-5 w-5 animate-spin" /> جاري التحضير...</> : <><DLIcon className="ml-2 h-5 w-5" /> تنزيل الآن</>}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {release?.platform === "win-x64-exe"
                    ? "مثبّت بنقرة واحدة (.exe) — يبدأ التثبيت فوراً بدون صلاحية مدير — متوافق مع Windows 10 / 11"
                    : ".msi installer — متوافق مع Windows 10 / 11"}
                </p>

                {done && (
                  <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800 space-y-1 text-right">
                    <div className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-4 w-4" /> بدأ التنزيل</div>
                    <p>إذا لم يبدأ التنزيل تلقائياً، اضغط "تنزيل الآن" مرة أخرى.</p>
                  </div>
                )}

                {release?.checksumSha256 && (
                  <p className="text-[11px] text-muted-foreground font-mono break-all">SHA-256: {release.checksumSha256}</p>
                )}

                <div className="border-t pt-4 text-right space-y-2">
                  <h3 className="font-semibold text-sm">بعد التنزيل:</h3>
                  <ol className="text-sm text-muted-foreground space-y-1 mr-5 list-decimal">
                    <li>
                      {release?.platform === "win-x64-exe"
                        ? "شغّل الملف المُنزّل — سيبدأ التثبيت تلقائياً ثم يفتح التطبيق."
                        : "افتح ملف ‎.msi واتبع خطوات المثبّت."}
                    </li>
                    <li>أدخل مفتاح الترخيص عند أول تشغيل.</li>
                    <li>اربط التطبيق بحسابك السحابي لمزامنة البيانات.</li>
                  </ol>
                </div>

                <Button variant="ghost" onClick={() => { setStep(2); setErr(null); setDone(false); }}>
                  <ArrowLeft className="ml-1 h-4 w-4" /> رجوع لاختيار الإصدار
                </Button>
              </div>
            )}

          </CardContent>
        </Card>
      </main>

      <footer className="border-t mt-12 py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} زاكود — جميع الحقوق محفوظة
      </footer>
    </div>
  );
}
