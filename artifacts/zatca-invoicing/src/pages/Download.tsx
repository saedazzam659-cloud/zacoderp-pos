import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Download as DLIcon, Monitor, Shield, Wifi, HardDrive, Sparkles, CheckCircle2, Globe } from "lucide-react";

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
  downloadUrl: string; fileSizeBytes: number | null; checksumSha256: string | null;
  releaseNotes: string | null; isActive: boolean; publishedAt: string;
  fallback?: boolean;
};

export default function Download() {
  const [country, setCountry] = useState<string>(() => localStorage.getItem("download_country") || "SA");

  useEffect(() => { localStorage.setItem("download_country", country); }, [country]);

  const releaseQ = useQuery<Release | null>({
    queryKey: ["public-release", country],
    queryFn: async () => {
      const r = await fetch(`${API}/api/public/download/release?country=${country}&platform=win-x64`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("فشل تحميل بيانات الإصدار");
      return r.json();
    },
  });

  const sizeStr = (b: number | null | undefined) => {
    if (!b) return "—";
    return `${(b / 1024 / 1024).toFixed(1)} ميجابايت`;
  };

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-blue-50">
      <header className="border-b bg-white/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <a href={import.meta.env.BASE_URL} className="text-xl font-bold text-blue-700">زاكود</a>
          <nav className="text-sm flex gap-6 text-muted-foreground">
            <a href={import.meta.env.BASE_URL} className="hover:text-foreground">الرئيسية</a>
            <a href={`${import.meta.env.BASE_URL}login`} className="hover:text-foreground">تسجيل الدخول</a>
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-12 space-y-12">
        {/* Hero */}
        <section className="text-center space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-semibold">
            <Sparkles className="h-3.5 w-3.5" /> جديد — نسخة سطح المكتب لنقاط البيع
          </div>
          <h1 className="text-4xl md:text-5xl font-bold leading-tight">
            نقطة البيع التي <span className="text-blue-700">تعمل بدون إنترنت</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            تطبيق Windows مدمج بقاعدة بيانات محلية + توقيع ZATCA المرحلة الثانية محلياً + مزامنة تلقائية فور عودة الاتصال
          </p>
        </section>

        {/* Country picker + download card */}
        <Card className="border-2 border-blue-200 shadow-xl">
          <CardContent className="p-8 space-y-6">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-3">
                <Globe className="h-5 w-5 text-blue-600" />
                <span className="font-semibold">اختر الدولة لتحميل الإصدار المناسب:</span>
              </div>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COUNTRIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>{c.flag} {c.nameAr}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="border-t pt-6">
              {releaseQ.isLoading && <p className="text-center text-muted-foreground py-8">جاري تحميل بيانات الإصدار...</p>}
              {releaseQ.isError && <p className="text-center text-rose-600 py-8">تعذر تحميل بيانات الإصدار. حاول لاحقاً.</p>}
              {!releaseQ.isLoading && !releaseQ.data && (
                <div className="text-center py-10 space-y-3">
                  <Monitor className="h-12 w-12 text-muted-foreground mx-auto" />
                  <p className="text-muted-foreground">لا يتوفر إصدار للدولة المحددة حالياً.</p>
                  <p className="text-xs text-muted-foreground">جرّب اختيار "أخرى / دولي" أو تواصل مع المبيعات.</p>
                </div>
              )}
              {releaseQ.data && (
                <div className="grid md:grid-cols-3 gap-6 items-center">
                  <div className="md:col-span-2 space-y-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge className="bg-blue-100 text-blue-700">إصدار {releaseQ.data.version}</Badge>
                      <Badge variant="outline">Windows 64-bit</Badge>
                      {releaseQ.data.fallback && <Badge className="bg-amber-100 text-amber-700">إصدار دولي</Badge>}
                      <span className="text-sm text-muted-foreground">نُشر {new Date(releaseQ.data.publishedAt).toLocaleDateString("ar-SA")}</span>
                    </div>
                    {releaseQ.data.releaseNotes && (
                      <div className="text-sm text-muted-foreground bg-slate-50 p-3 rounded-md whitespace-pre-wrap">
                        {releaseQ.data.releaseNotes}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground flex flex-wrap gap-4">
                      <span><HardDrive className="inline h-3 w-3 ml-1" /> الحجم: {sizeStr(releaseQ.data.fileSizeBytes)}</span>
                      {releaseQ.data.checksumSha256 && (
                        <span className="font-mono">SHA-256: {releaseQ.data.checksumSha256.substring(0,16)}...</span>
                      )}
                    </div>
                  </div>
                  <div className="text-center">
                    <a href={releaseQ.data.downloadUrl} className="inline-block">
                      <Button size="lg" className="h-14 px-8 text-lg">
                        <DLIcon className="ml-2 h-5 w-5" /> تنزيل الآن
                      </Button>
                    </a>
                    <p className="text-xs text-muted-foreground mt-2">.msi installer</p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Features grid */}
        <section className="grid md:grid-cols-3 gap-6">
          <FeatureCard icon={<Wifi className="h-6 w-6 text-blue-600" />}
            title="يعمل دون اتصال"
            text="قاعدة بيانات SQLCipher محلية مشفّرة. كل العمليات تتم محلياً، والمزامنة تلقائية فور عودة الإنترنت." />
          <FeatureCard icon={<Shield className="h-6 w-6 text-blue-600" />}
            title="توقيع ZATCA محلي"
            text="توقيع الفاتورة الإلكترونية (المرحلة الثانية) محلياً على الجهاز ثم رفعها للهيئة عند الاتصال." />
          <FeatureCard icon={<HardDrive className="h-6 w-6 text-blue-600" />}
            title="ربط بالأجهزة الطرفية"
            text="طابعة حرارية، درج نقدية، قارئ باركود، شاشة عرض ثانية، وميزان إلكتروني." />
        </section>

        {/* Steps */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold text-center">خطوات الإعداد بعد التحميل</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <Step n={1} title="ثبّت التطبيق" text="افتح ملف .msi واتبع المعالج. يدعم Windows 10/11 (64-bit)." />
            <Step n={2} title="أدخل مفتاح الترخيص" text="ستجده في لوحة التحكم بحساب الشركة أو من تواصلت معه في المبيعات." />
            <Step n={3} title="اربط مع الحساب السحابي" text="يستورد التطبيق المنتجات والعملاء والإعدادات تلقائياً من حسابك." />
          </div>
        </section>

        {/* System requirements */}
        <Card>
          <CardContent className="p-6 space-y-3">
            <h3 className="font-bold text-lg">متطلبات النظام</h3>
            <ul className="text-sm text-muted-foreground space-y-1 mr-4 list-disc">
              <li>Windows 10 أو 11 (64-bit فقط) — لا يدعم 32-bit</li>
              <li>ذاكرة 4 جيجابايت RAM على الأقل (8 جيجا موصى به)</li>
              <li>500 ميجابايت مساحة فارغة + مساحة لقاعدة البيانات المحلية</li>
              <li>اتصال إنترنت للتفعيل الأول والمزامنة (تعمل بدونه بعد التفعيل)</li>
            </ul>
          </CardContent>
        </Card>
      </main>

      <footer className="border-t mt-16 py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} زاكود — جميع الحقوق محفوظة
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <Card><CardContent className="p-6 space-y-2">
      <div className="w-12 h-12 rounded-lg bg-blue-50 flex items-center justify-center">{icon}</div>
      <h3 className="font-bold text-lg">{title}</h3>
      <p className="text-sm text-muted-foreground">{text}</p>
    </CardContent></Card>
  );
}
function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <Card><CardContent className="p-6 space-y-2">
      <div className="w-10 h-10 rounded-full bg-blue-600 text-white font-bold flex items-center justify-center text-lg">{n}</div>
      <h3 className="font-bold">{title}</h3>
      <p className="text-sm text-muted-foreground">{text}</p>
    </CardContent></Card>
  );
}
