import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, Save, Building2, MapPin, Settings, Info, AlertCircle, CheckCircle2, Hash, Cpu, ScanSearch, Loader2, Monitor, HardDrive, Server, User, Package, Eye, EyeOff, Globe2, Briefcase } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { COUNTRIES } from "@/lib/countries";
import { DateField } from "@/components/ui/date-field";
import { deriveModulesFromMenuKeys } from "@/lib/menuItems";
import ModuleScreenPicker, { type ModulePickerValue } from "@/components/ModuleScreenPicker";

const INVOICE_TYPE_OPTIONS: ComboboxItem[] = [
  { value: "standard",   code: "B2B",     label: "فاتورة ضريبية (B2B)",         description: "للشركات والجهات التجارية — تُرسل إلى ZATCA للتخليص" },
  { value: "simplified", code: "B2C",     label: "فاتورة ضريبية مبسطة (B2C)",  description: "للأفراد والمستهلكين — يُطبع QR Code ويُبلَّغ خلال 24 ساعة" },
  { value: "both",       code: "B2B+B2C", label: "كلا النوعين",                  description: "إصدار فواتير B2B و B2C من نفس المنشأة" },
];

// Country picker options. Reuses the same catalog as the public
// registration form so the SuperAdmin sees identical labels & order.
// Each row carries the ISO-3166-α2 code as the value, the Arabic name as
// the display label, and the country's default currency as a description
// hint (so the SuperAdmin can sanity-check the right country at a glance).
const COUNTRY_OPTIONS: ComboboxItem[] = COUNTRIES.map(c => ({
  value:       c.code,
  code:        c.code,
  label:       c.nameAr,
  description: `${c.nameEn} • ${c.currency.code}`,
}));

// Mirrors the row shape returned by GET /api/admin/industries/public
// so the picker below can light up the SuperAdmin-managed catalog
// (configured in /admin/industries) instead of a hard-coded fallback.
type LiveIndustry = {
  code:                  string;
  nameAr:                string;
  nameEn:                string;
  emoji:                 string;
  recommendedModuleKeys: string[];
  sortOrder:             number;
};

interface DeviceInfo {
  manufacturer: string;
  model: string;
  serial: string;
  hostname: string;
  platform: string;
  arch: string;
  osName: string;
  cpuModel: string;
  totalRamGb: number;
  nodeVersion: string;
  stableId: string;
}

const PLAN_OPTIONS: ComboboxItem[] = [
  { value: "starter",      code: "99 ر.س/شهر",  label: "مبتدئ (Starter)",      description: "مستخدم واحد — 50 فاتورة شهرياً" },
  { value: "professional", code: "299 ر.س/شهر", label: "احترافي (Professional)", description: "5 مستخدمين — 500 فاتورة شهرياً" },
  { value: "enterprise",   code: "899 ر.س/شهر", label: "مؤسسي (Enterprise)",    description: "مستخدمون وفواتير غير محدودة" },
];

const BILLING_OPTIONS: ComboboxItem[] = [
  { value: "monthly", code: "شهري",  label: "اشتراك شهري",  description: "سداد شهري بدون التزام" },
  { value: "annual",  code: "سنوي",  label: "اشتراك سنوي",  description: "وفّر ~15% مقارنة بالشهري" },
];

const companySchema = z.object({
  nameAr: z.string().min(2, { message: "اسم الشركة مطلوب" }),
  nameEn: z.string().optional(),
  vatNumber: z.string().length(15, { message: "الرقم الضريبي يجب أن يكون 15 رقماً" }),
  crNumber: z.string().min(5, { message: "رقم السجل التجاري مطلوب" }),
  city: z.string().min(2, { message: "المدينة مطلوبة" }),
  district: z.string().optional(),
  street: z.string().min(2, { message: "الشارع مطلوب" }),
  buildingNumber: z.string().min(1, { message: "رقم المبنى مطلوب" }),
  postalCode: z.string().min(5, { message: "الرمز البريدي مطلوب" }),
  additionalNumber: z.string().optional(),
  phone: z.string().optional(),
  country: z.string().default("SA"),
  industryName: z.string().optional(),
  invoiceType: z.enum(["standard", "simplified", "both"]).default("both"),
  isSandbox: z.boolean().default(true),
  serialNumber: z.string().optional(),
  deviceSerial1: z.string().optional(),
  deviceSerial2: z.string().optional(),
  deviceSerial3: z.string().optional(),
  // Admin user
  username: z.string().min(3, { message: "اسم المستخدم مطلوب (3 أحرف على الأقل)" }),
  email: z.string().email({ message: "بريد إلكتروني غير صحيح" }).optional().or(z.literal("")),
  password: z.string().min(8, { message: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" }),
  // Subscription
  plan: z.enum(["starter", "professional", "enterprise"]).default("starter"),
  billingCycle: z.enum(["monthly", "annual"]).default("monthly"),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
      <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
      <div>{children}</div>
    </div>
  );
}

function ExampleBadge({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded text-xs bg-muted text-muted-foreground border font-mono">
      <span className="text-muted-foreground/60 font-sans">مثال:</span> {text}
    </span>
  );
}

function SectionHeader({ icon: Icon, title, description }: { icon: React.ElementType; title: string; description?: string }) {
  return (
    <CardHeader className="border-b bg-muted/20 pb-4">
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5 text-primary" />
        <div>
          <CardTitle className="text-lg">{title}</CardTitle>
          {description && <CardDescription className="mt-0.5">{description}</CardDescription>}
        </div>
      </div>
    </CardHeader>
  );
}

export default function CompanyNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { token } = useAuth();
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showPass, setShowPass] = useState(false);
  // Industry codes selected by the SuperAdmin. We send these as
  // `selectedIndustries` to /api/auth/register so the backend can
  // merge each industry's `recommendedModuleKeys` into the new
  // company's menuPermissions (otherwise the schema default leaves
  // every other module visible — see issue raised by the user).
  const [selectedIndustries, setSelectedIndustries] = useState<string[]>([]);
  // ── "مخصص" (Custom) mode ── same picker as the public Register page.
  // When ON, we send `selectedMenuKeys` (granular grant, covers null-parent
  // modules) + `selectedNavOff` (per-screen visibility) to /api/auth/register.
  const [customMode, setCustomMode] = useState(false);
  const [customPicker, setCustomPicker] = useState<ModulePickerValue>({ moduleKeys: [], navOff: [] });

  // Live industry catalog from the SuperAdmin-managed table.
  // Falls back to an empty list on error so the rest of the page
  // still renders — the manual `industryName` text field below remains
  // available either way.
  const industriesQ = useQuery<LiveIndustry[]>({
    queryKey: ["industries-public-companynew"],
    queryFn: async () => {
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
      const r = await fetch(`${BASE}/api/admin/industries/public`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
  const INDUSTRIES_LIVE: LiveIndustry[] = industriesQ.data ?? [];

  const today = new Date().toISOString().split("T")[0];
  const in30Days = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];

  const form = useForm<z.infer<typeof companySchema>>({
    resolver: zodResolver(companySchema),
    defaultValues: {
      nameAr: "", nameEn: "", vatNumber: "", crNumber: "",
      city: "", district: "", street: "", buildingNumber: "", postalCode: "",
      additionalNumber: "", phone: "", country: "SA", industryName: "",
      invoiceType: "both", isSandbox: true,
      serialNumber: "", deviceSerial1: "", deviceSerial2: "", deviceSerial3: "",
      username: "", email: "", password: "",
      plan: "starter", billingCycle: "monthly",
      startDate: today, endDate: in30Days,
    },
  });

  const scanDevice = async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/device-info");
      if (!res.ok) throw new Error("فشل الاتصال");
      const info: DeviceInfo = await res.json();
      setDeviceInfo(info);
      form.setValue("deviceSerial1", info.manufacturer);
      form.setValue("deviceSerial2", info.model);
      form.setValue("deviceSerial3", info.serial);
      toast({
        title: "تم المسح بنجاح",
        description: `تم قراءة معلومات الجهاز: ${info.manufacturer} – ${info.model}`,
      });
    } catch {
      toast({
        title: "تعذّر قراءة الجهاز",
        description: "تأكد من تشغيل الخادم وأن الاتصال يعمل.",
        variant: "destructive",
      });
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    scanDevice();
  }, []);

  const onSubmit = async (values: z.infer<typeof companySchema>) => {
    setSubmitting(true);
    try {
      const combinedSerial = (values.deviceSerial1 && values.deviceSerial2 && values.deviceSerial3)
        ? `1-${values.deviceSerial1}|2-${values.deviceSerial2}|3-${values.deviceSerial3}`
        : values.serialNumber;

      const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
      // Derive a human-readable `industryName` from the picked codes
      // when the SuperAdmin hasn't typed one explicitly. This keeps
      // the legacy free-text field useful (it's what gets stored on
      // the company row + appears in printouts) while
      // `selectedIndustries` drives the menuPermissions merge on the
      // server.
      const industryName =
        values.industryName?.trim() ||
        (selectedIndustries.length > 0
          ? selectedIndustries
              .map(c => INDUSTRIES_LIVE.find(i => i.code === c)?.nameAr ?? c)
              .join("، ")
          : undefined);
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          ...values,
          industryName,
          serialNumber: combinedSerial,
          selectedIndustries,
          // مخصص mode only: granular menu grants + per-screen visibility off.
          ...(customMode ? {
            selectedModules: deriveModulesFromMenuKeys(customPicker.moduleKeys),
            selectedMenuKeys: customPicker.moduleKeys,
            selectedNavOff: customPicker.navOff,
          } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "حدث خطأ");
      toast({ title: "تمت الإضافة بنجاح", description: "تمت إضافة الشركة والمستخدم الإداري بنجاح." });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      setLocation(`/companies/${data.user.companyId}`);
    } catch (err: any) {
      toast({ title: "حدث خطأ", description: err.message ?? "يرجى المحاولة مرة أخرى.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link href="/companies">
            <ArrowRight className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-foreground">إضافة شركة جديدة</h1>
          <p className="text-muted-foreground mt-1">سجّل بيانات منشأتك للبدء بإصدار الفواتير الإلكترونية المتوافقة مع هيئة الزكاة والدخل والجمارك</p>
        </div>
      </div>

      {/* Steps overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        {[
          { n: "1", label: "البيانات الأساسية", desc: "اسم الشركة والأرقام الرسمية" },
          { n: "2", label: "العنوان الوطني", desc: "عنوان المنشأة الرسمي" },
          { n: "3", label: "إعدادات ZATCA", desc: "ربط الجهاز وبيئة العمل" },
          { n: "4", label: "المستخدم والاشتراك", desc: "حساب الإدارة وخطة الاشتراك" },
        ].map((s) => (
          <div key={s.n} className="flex items-start gap-3 p-3 rounded-lg border bg-card">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">{s.n}</span>
            <div>
              <p className="font-medium">{s.label}</p>
              <p className="text-muted-foreground text-xs mt-0.5">{s.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

          {/* ─── Section 1: Basic Info ─── */}
          <Card>
            <SectionHeader icon={Building2} title="البيانات الأساسية" description="المعلومات الرسمية للمنشأة كما هي مسجلة في السجل التجاري" />
            <CardContent className="pt-6 space-y-5">
              <InfoBox>
                هذه البيانات ستظهر على رأس كل فاتورة وستُرسل إلى هيئة الزكاة. تأكد من مطابقتها تماماً لما هو مسجل رسمياً.
              </InfoBox>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="nameAr"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>اسم الشركة / المنشأة (عربي) <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input placeholder="شركة النجاح للتجارة" {...field} />
                      </FormControl>
                      <FormDescription>
                        الاسم الرسمي كما يظهر في السجل التجاري
                        <br /><ExampleBadge text="شركة التقنية المتقدمة للتجارة" />
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="nameEn"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>اسم الشركة (إنجليزي) <span className="text-muted-foreground text-xs">(اختياري)</span></FormLabel>
                      <FormControl>
                        <Input placeholder="Advanced Tech Trading Co." dir="ltr" className="text-left" {...field} />
                      </FormControl>
                      <FormDescription>
                        يُستخدم في الفواتير الموجهة للعملاء الأجانب
                        <br /><ExampleBadge text="AlNajah Trading Company" />
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="vatNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>الرقم الضريبي (VAT) <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input
                          placeholder="310000000000003"
                          dir="ltr"
                          className="text-left font-mono tracking-widest text-base"
                          maxLength={15}
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        15 رقماً — يبدأ بـ <strong>3</strong> وينتهي بـ <strong>3</strong>. تجده في شهادة تسجيل ضريبة القيمة المضافة.
                        <br /><ExampleBadge text="310025263300003" />
                      </FormDescription>
                      <FormMessage />
                      {field.value && field.value.length === 15 && (
                        <p className="flex items-center gap-1 text-xs text-green-600 mt-1">
                          <CheckCircle2 className="h-3.5 w-3.5" /> الرقم الضريبي صحيح (15 رقم)
                        </p>
                      )}
                      {field.value && field.value.length > 0 && field.value.length < 15 && (
                        <p className="flex items-center gap-1 text-xs text-amber-600 mt-1">
                          <AlertCircle className="h-3.5 w-3.5" /> {15 - field.value.length} رقم ناقص
                        </p>
                      )}
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="crNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>رقم السجل التجاري (CR) <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input placeholder="1010000001" dir="ltr" className="text-left font-mono" {...field} />
                      </FormControl>
                      <FormDescription>
                        رقم السجل التجاري الصادر من وزارة التجارة — 10 أرقام.
                        <br /><ExampleBadge text="1010000001" />
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="industryName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>مجال الصناعة / النشاط (نص حر) <span className="text-muted-foreground text-xs">(اختياري)</span></FormLabel>
                      <FormControl>
                        <Input placeholder="تقنية المعلومات" {...field} />
                      </FormControl>
                      <FormDescription>
                        يُكتب يدوياً فقط لو ما اخترت من القائمة أدناه. لو تركته فارغاً، يُعبَّأ تلقائياً من الأنشطة المختارة.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* ─── Industry multi-select (drives menu permissions) ───
                  Each chip toggle below adds the industry's
                  recommendedModuleKeys (configured in /admin/industries)
                  into the new company's menuPermissions. Without picking
                  at least one industry here the company falls back to
                  the schema default — that's why the SuperAdmin used to
                  see every module enabled regardless of the industry
                  they meant. */}
              <div className="border-t pt-5 space-y-3">
                <div className="flex items-start gap-2">
                  <Briefcase className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <h4 className="text-sm font-semibold">أنواع النشاط للشركة</h4>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      اختر نشاطاً واحداً أو أكثر — كل نشاط يفعّل الموديولات المرتبطة به (مثل: <span className="font-medium text-foreground">تجاري</span> ⇐ المبيعات + المخزون + المحاسبة).
                      الإعدادات تُدار من <code className="bg-muted px-1 rounded">/admin/industries</code>.
                    </p>
                  </div>
                </div>

                {industriesQ.isLoading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> جارِ تحميل قائمة الأنشطة...
                  </div>
                )}
                {industriesQ.isError && (
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                    تعذّر تحميل قائمة الأنشطة. تابع باستخدام حقل النص الحر أعلاه — يمكنك ضبط الموديولات لاحقاً من صفحة <strong>صلاحيات القوائم</strong>.
                  </div>
                )}

                {INDUSTRIES_LIVE.length > 0 && (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {INDUSTRIES_LIVE.map(ind => {
                        const active = selectedIndustries.includes(ind.code);
                        return (
                          <button
                            key={ind.code}
                            type="button"
                            onClick={() => {
                              setCustomMode(false);
                              setSelectedIndustries(prev =>
                                active ? prev.filter(c => c !== ind.code) : [...prev, ind.code]
                              );
                            }}
                            className={
                              "flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm transition-all " +
                              (active
                                ? "bg-primary text-primary-foreground border-primary shadow-sm"
                                : "bg-background hover:bg-muted border-input")
                            }
                          >
                            <span>{ind.emoji}</span>
                            <span>{ind.nameAr}</span>
                            {active && <CheckCircle2 className="h-3.5 w-3.5" />}
                          </button>
                        );
                      })}
                      {/* "مخصص" — switch to the per-screen custom picker. */}
                      <button
                        type="button"
                        data-testid="industry-chip-custom"
                        onClick={() => { setCustomMode(true); setSelectedIndustries([]); }}
                        className={
                          "flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 text-sm transition-all " +
                          (customMode
                            ? "bg-primary/10 text-primary border-primary font-medium shadow-sm"
                            : "bg-background hover:bg-primary/5 border-dashed border-primary/50 text-primary")
                        }
                      >
                        <span>🎚️</span>
                        <span>مخصص</span>
                        {customMode && <CheckCircle2 className="h-3.5 w-3.5" />}
                      </button>
                    </div>

                    {!customMode && selectedIndustries.length === 0 && (
                      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 flex items-start gap-2">
                        <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <span>
                          لو ما اخترت أي نشاط، الشركة الجديدة ستحصل على القائمة الكاملة من الموديولات افتراضياً.
                          اختر نشاطاً ليتم تفعيل موديولاته فقط.
                        </span>
                      </div>
                    )}

                    {customMode && (
                      <div className="space-y-3">
                        <div className="text-xs text-primary bg-primary/5 border border-primary/20 rounded p-2 flex items-start gap-2">
                          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <span>
                            وضع التخصيص: اختر باقة جاهزة (صغيرة / متوسطة / كبيرة) أو فعّل الوحدات والشاشات يدوياً.
                            الشاشات المُلغاة تُخفى من القائمة الجانبية للشركة الجديدة.
                          </span>
                        </div>
                        <ModuleScreenPicker
                          value={customPicker}
                          onChange={setCustomPicker}
                        />
                      </div>
                    )}

                    {!customMode && selectedIndustries.length > 0 && (
                      <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">
                        <strong>سيتم تفعيل الموديولات التالية:</strong>{" "}
                        {Array.from(new Set(
                          selectedIndustries.flatMap(code =>
                            INDUSTRIES_LIVE.find(i => i.code === code)?.recommendedModuleKeys ?? []
                          )
                        )).join("، ") || "(لا يوجد موديولات مرتبطة بهذه الأنشطة بعد — اضبطها من /admin/industries)"}
                      </div>
                    )}
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ─── Section 2: Address ─── */}
          <Card>
            <SectionHeader icon={MapPin} title="العنوان الوطني" description="عنوان المنشأة وفق نظام العنوان الوطني السعودي (WASL)" />
            <CardContent className="pt-6 space-y-5">
              <InfoBox>
                العنوان الوطني مطلوب قانونياً في الفواتير الإلكترونية. تجد بياناته على خريطة <strong>أبشر</strong> أو موقع <strong>البريد السعودي</strong>.
              </InfoBox>

              {/* Country picker. Lives at the top of the address card so it
                  scopes the rest of the address fields below it. The schema
                  defaults to "SA" but the SuperAdmin can pick any country
                  (matches the public registration form's country list). */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <FormField
                  control={form.control}
                  name="country"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex items-center gap-1.5">
                        <Globe2 className="h-3.5 w-3.5 text-primary" />
                        الدولة <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <SearchCombobox
                          items={COUNTRY_OPTIONS}
                          value={field.value}
                          onValueChange={field.onChange}
                          placeholder="اختر الدولة..."
                          searchPlaceholder="ابحث بالاسم أو الكود..."
                        />
                      </FormControl>
                      <FormDescription>
                        تحدد العملة الافتراضية للشركة بناءً على الدولة المختارة.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                <FormField
                  control={form.control}
                  name="buildingNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>رقم المبنى <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input dir="ltr" className="text-left font-mono" maxLength={4} placeholder="1234" {...field} />
                      </FormControl>
                      <FormDescription>
                        4 أرقام من العنوان الوطني
                        <br /><ExampleBadge text="1234" />
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="street"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>اسم الشارع <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input placeholder="طريق الملك فهد" {...field} />
                      </FormControl>
                      <FormDescription>
                        <ExampleBadge text="طريق الملك فهد" />
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="district"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>الحي <span className="text-muted-foreground text-xs">(اختياري)</span></FormLabel>
                      <FormControl>
                        <Input placeholder="العليا" {...field} />
                      </FormControl>
                      <FormDescription>
                        <ExampleBadge text="العليا / الروضة / السليمانية" />
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="city"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>المدينة <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input placeholder="الرياض" {...field} />
                      </FormControl>
                      <FormDescription>
                        <ExampleBadge text="الرياض / جدة / الدمام" />
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="postalCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>الرمز البريدي <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input dir="ltr" className="text-left font-mono" maxLength={5} placeholder="12211" {...field} />
                      </FormControl>
                      <FormDescription>
                        5 أرقام من العنوان الوطني
                        <br /><ExampleBadge text="12211" />
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="additionalNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>الرقم الإضافي <span className="text-muted-foreground text-xs">(اختياري)</span></FormLabel>
                      <FormControl>
                        <Input dir="ltr" className="text-left font-mono" maxLength={4} placeholder="6789" {...field} />
                      </FormControl>
                      <FormDescription>
                        4 أرقام — تجده بعد الشرطة في العنوان الوطني الكامل
                        <br /><ExampleBadge text="12211-6789 ← الـ 6789 هو الرقم الإضافي" />
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>رقم الهاتف <span className="text-muted-foreground text-xs">(اختياري)</span></FormLabel>
                      <FormControl>
                        <Input dir="ltr" className="text-left font-mono" maxLength={30} placeholder="0501234567" {...field} />
                      </FormControl>
                      <FormDescription>
                        رقم التواصل الرسمي للشركة
                        <br /><ExampleBadge text="0501234567" />
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          {/* ─── Section 3: ZATCA Settings ─── */}
          <Card>
            <SectionHeader icon={Settings} title="إعدادات ZATCA والفواتير" description="إعدادات الربط مع هيئة الزكاة والدخل والجمارك" />
            <CardContent className="pt-6 space-y-6">

              {/* Invoice Type */}
              <div>
                <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Hash className="h-4 w-4 text-primary" />
                  نوع الفواتير المسموح بإصدارها
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <FormField
                    control={form.control}
                    name="invoiceType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>نوع الفواتير <span className="text-destructive">*</span></FormLabel>
                        <FormControl>
                          <SearchCombobox
                            items={INVOICE_TYPE_OPTIONS}
                            value={field.value}
                            onValueChange={field.onChange}
                            placeholder="اختر نوع الفواتير..."
                            searchPlaceholder="ابحث بالكود أو الاسم..."
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2">
                    <p className="font-medium text-foreground">الفرق بين النوعين:</p>
                    <div className="flex gap-2">
                      <span className="shrink-0 rounded bg-blue-100 text-blue-700 px-1.5 py-0.5 text-xs font-bold">B2B</span>
                      <p className="text-muted-foreground">فواتير بين منشآت — مثل: فاتورة من مورد لشركة. تحتاج موافقة (تخليص) من ZATCA فوراً.</p>
                    </div>
                    <div className="flex gap-2">
                      <span className="shrink-0 rounded bg-green-100 text-green-700 px-1.5 py-0.5 text-xs font-bold">B2C</span>
                      <p className="text-muted-foreground">فواتير للأفراد — مثل: فاتورة مطعم أو متجر. يُطبع QR Code ويُبلَّغ لاحقاً.</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Sandbox */}
              <div className="border-t pt-5">
                <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Settings className="h-4 w-4 text-primary" />
                  بيئة العمل
                </h4>
                <FormField
                  control={form.control}
                  name="isSandbox"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-x-reverse space-y-0 rounded-lg border p-4 bg-amber-50 border-amber-200">
                      <FormControl>
                        <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                      <div className="space-y-2 leading-none">
                        <FormLabel className="text-base cursor-pointer">
                          بيئة المحاكاة (Sandbox)
                        </FormLabel>
                        <FormDescription className="text-amber-700">
                          <strong>مُوصى به للبداية.</strong> في هذه البيئة تُصدر فواتير تجريبية بدون أي أثر قانوني — مثالية للتجربة والتأكد من صحة الإعدادات قبل الانتقال للإنتاج الفعلي.
                          <br />
                          <br />
                          بعد التحقق من صحة الإعدادات، انتقل إلى بيئة الإنتاج عبر صفحة <strong>المفتاح والإعدادات</strong>.
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />
              </div>

              {/* Device Serial */}
              <div className="border-t pt-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-start gap-3">
                    <Cpu className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                    <div>
                      <h4 className="text-sm font-semibold">أرقام سيريال الجهاز <span className="text-muted-foreground font-normal">(اختياري)</span></h4>
                      <p className="text-muted-foreground text-sm mt-0.5">
                        معرّف الجهاز (خادم، حاسوب، نقطة بيع) المسجَّل في ZATCA كمصدر للفواتير.
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant={deviceInfo ? "outline" : "default"}
                    size="sm"
                    className="gap-2 shrink-0"
                    onClick={scanDevice}
                    disabled={scanning}
                  >
                    {scanning
                      ? <><Loader2 className="h-4 w-4 animate-spin" />جاري المسح...</>
                      : deviceInfo
                        ? <><ScanSearch className="h-4 w-4" />إعادة المسح</>
                        : <><ScanSearch className="h-4 w-4" />مسح الجهاز تلقائياً</>
                    }
                  </Button>
                </div>

                {/* Auto-detected device info card */}
                {deviceInfo && (
                  <div className="mb-4 rounded-lg border bg-green-50 border-green-200 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                      <span className="text-sm font-semibold text-green-800">تم قراءة معلومات الجهاز تلقائياً</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                      <div className="flex items-start gap-2">
                        <Server className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-green-700 font-medium">نظام التشغيل</p>
                          <p className="text-green-800 font-mono">{deviceInfo.osName || deviceInfo.platform}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <Monitor className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-green-700 font-medium">اسم المضيف</p>
                          <p className="text-green-800 font-mono">{deviceInfo.hostname}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <HardDrive className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-green-700 font-medium">الذاكرة</p>
                          <p className="text-green-800 font-mono">{deviceInfo.totalRamGb} GB RAM</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <Cpu className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-green-700 font-medium">المعالج</p>
                          <p className="text-green-800 font-mono truncate max-w-[120px]">{deviceInfo.arch}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {!deviceInfo && scanning && (
                  <div className="flex items-center gap-3 p-3 rounded-lg border bg-amber-50 border-amber-200 text-sm text-amber-800">
                    <Loader2 className="h-4 w-4 animate-spin text-amber-600 shrink-0" />
                    <span>جاري قراءة معلومات الجهاز تلقائياً...</span>
                  </div>
                )}
                {!deviceInfo && !scanning && (
                  <InfoBox>
                    فشل المسح التلقائي. يمكنك إدخال البيانات يدوياً أو الضغط على <strong>إعادة المسح</strong>.
                    الصيغة المطلوبة في ZATCA:{" "}
                    <code className="bg-blue-100 px-1 rounded font-mono">
                      1-{"{"}الشركة المصنعة{"}"} | 2-{"{"}الموديل{"}"} | 3-{"{"}الرقم الفريد{"}"}
                    </code>
                  </InfoBox>
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                  <FormField
                    control={form.control}
                    name="deviceSerial1"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>1 — الشركة المصنعة</FormLabel>
                        <FormControl>
                          <Input placeholder="Device" dir="ltr" className="text-left font-mono" {...field} />
                        </FormControl>
                        <FormDescription>
                          <ExampleBadge text="Dell / HP / Apple / Server" />
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="deviceSerial2"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>2 — الموديل / الإصدار</FormLabel>
                        <FormControl>
                          <Input placeholder="2354" dir="ltr" className="text-left font-mono" {...field} />
                        </FormControl>
                        <FormDescription>
                          <ExampleBadge text="Latitude7420 / M1 / 2354" />
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="deviceSerial3"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>3 — الرقم التسلسلي الفريد</FormLabel>
                        <FormControl>
                          <Input placeholder="ABCD1234..." dir="ltr" className="text-left font-mono text-xs" {...field} />
                        </FormControl>
                        <FormDescription>
                          <ExampleBadge text="UqazDistserialnumber" />
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Preview combined serial */}
                {(form.watch("deviceSerial1") || form.watch("deviceSerial2") || form.watch("deviceSerial3")) && (
                  <div className="mt-3 p-3 rounded-lg bg-muted border text-sm font-mono" dir="ltr">
                    <span className="text-muted-foreground text-xs block mb-1 font-sans" dir="rtl">الصيغة النهائية التي ستُرسل لـ ZATCA:</span>
                    <span className="text-foreground break-all">
                      1-{form.watch("deviceSerial1") || "..."} | 2-{form.watch("deviceSerial2") || "..."} | 3-{form.watch("deviceSerial3") || "..."}
                    </span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ─── Section 4: Admin User + Subscription ─── */}
          <Card>
            <SectionHeader icon={User} title="حساب المدير والاشتراك" description="أنشئ حساب مدير للشركة وحدد خطة الاشتراك ومدته" />
            <CardContent className="pt-6 space-y-6">

              <div>
                <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <User className="h-4 w-4 text-primary" />حساب المدير
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <FormField control={form.control} name="username" render={({ field }) => (
                    <FormItem>
                      <FormLabel>اسم المستخدم <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input placeholder="admin_company" dir="ltr" className="text-left font-mono" autoComplete="off"
                          {...field} onChange={e => field.onChange(e.target.value.toLowerCase())} />
                      </FormControl>
                      <FormDescription>حروف صغيرة وأرقام فقط، بدون مسافات</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="email" render={({ field }) => (
                    <FormItem>
                      <FormLabel>البريد الإلكتروني <span className="text-muted-foreground text-xs">(اختياري)</span></FormLabel>
                      <FormControl><Input type="email" placeholder="admin@company.sa" dir="ltr" className="text-left" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="password" render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel>كلمة المرور <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input type={showPass ? "text" : "password"} placeholder="8 أحرف على الأقل"
                            dir="ltr" className="text-left pl-10" autoComplete="new-password" {...field} />
                          <button type="button" onClick={() => setShowPass(!showPass)}
                            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                            {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

              <div className="border-t pt-5">
                <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Package className="h-4 w-4 text-primary" />خطة الاشتراك
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <FormField control={form.control} name="plan" render={({ field }) => (
                    <FormItem>
                      <FormLabel>الباقة</FormLabel>
                      <FormControl>
                        <SearchCombobox items={PLAN_OPTIONS} value={field.value} onValueChange={field.onChange}
                          placeholder="اختر الباقة..." searchPlaceholder="ابحث..." />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="billingCycle" render={({ field }) => (
                    <FormItem>
                      <FormLabel>دورة الفوترة</FormLabel>
                      <FormControl>
                        <SearchCombobox items={BILLING_OPTIONS} value={field.value} onValueChange={(v) => {
                          field.onChange(v);
                          const days = v === "annual" ? 365 : 30;
                          form.setValue("endDate", new Date(Date.now() + days * 86400000).toISOString().split("T")[0]);
                        }} placeholder="اختر الدورة..." searchPlaceholder="ابحث..." />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="startDate" render={({ field }) => (
                    <FormItem>
                      <FormLabel>تاريخ بدء الاشتراك</FormLabel>
                      <FormControl><DateField {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="endDate" render={({ field }) => (
                    <FormItem>
                      <FormLabel>تاريخ انتهاء الاشتراك</FormLabel>
                      <FormControl><DateField {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex justify-end gap-4">
            <Button type="button" variant="outline" asChild>
              <Link href="/companies">إلغاء</Link>
            </Button>
            <Button type="submit" className="gap-2 min-w-36" disabled={submitting}>
              <Save className="h-4 w-4" />
              <span>{submitting ? "جاري الحفظ..." : "حفظ بيانات الشركة"}</span>
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
