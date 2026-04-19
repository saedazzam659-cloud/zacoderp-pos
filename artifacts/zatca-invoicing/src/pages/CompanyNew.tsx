import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { useCreateCompany } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
import { ArrowRight, Save, Building2, MapPin, Settings, Info, AlertCircle, CheckCircle2, Hash, Cpu, ScanSearch, Loader2, Monitor, HardDrive, Server } from "lucide-react";
import { Link } from "wouter";

const INVOICE_TYPE_OPTIONS: ComboboxItem[] = [
  { value: "standard",   code: "B2B",     label: "فاتورة ضريبية (B2B)",         description: "للشركات والجهات التجارية — تُرسل إلى ZATCA للتخليص" },
  { value: "simplified", code: "B2C",     label: "فاتورة ضريبية مبسطة (B2C)",  description: "للأفراد والمستهلكين — يُطبع QR Code ويُبلَّغ خلال 24 ساعة" },
  { value: "both",       code: "B2B+B2C", label: "كلا النوعين",                  description: "إصدار فواتير B2B و B2C من نفس المنشأة" },
];

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
  country: z.string().default("SA"),
  industryName: z.string().optional(),
  invoiceType: z.enum(["standard", "simplified", "both"]).default("both"),
  isSandbox: z.boolean().default(true),
  serialNumber: z.string().optional(),
  deviceSerial1: z.string().optional(),
  deviceSerial2: z.string().optional(),
  deviceSerial3: z.string().optional(),
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
  const createCompany = useCreateCompany();
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [scanning, setScanning] = useState(false);

  const form = useForm<z.infer<typeof companySchema>>({
    resolver: zodResolver(companySchema),
    defaultValues: {
      nameAr: "",
      nameEn: "",
      vatNumber: "",
      crNumber: "",
      city: "",
      district: "",
      street: "",
      buildingNumber: "",
      postalCode: "",
      additionalNumber: "",
      country: "SA",
      industryName: "",
      invoiceType: "both",
      isSandbox: true,
      serialNumber: "",
      deviceSerial1: "",
      deviceSerial2: "",
      deviceSerial3: "",
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

  const onSubmit = (values: z.infer<typeof companySchema>) => {
    const combinedSerial = (values.deviceSerial1 && values.deviceSerial2 && values.deviceSerial3)
      ? `1-${values.deviceSerial1}|2-${values.deviceSerial2}|3-${values.deviceSerial3}`
      : values.serialNumber;

    createCompany.mutate({
      data: {
        ...values,
        serialNumber: combinedSerial,
      }
    }, {
      onSuccess: (company) => {
        toast({
          title: "تمت الإضافة بنجاح",
          description: "تمت إضافة الشركة إلى النظام بنجاح.",
        });
        queryClient.invalidateQueries({ queryKey: ["companies"] });
        setLocation(`/companies/${company.id}`);
      },
      onError: () => {
        toast({
          title: "حدث خطأ",
          description: "لم نتمكن من إضافة الشركة. يرجى المحاولة مرة أخرى.",
          variant: "destructive",
        });
      }
    });
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
      <div className="grid grid-cols-3 gap-3 text-sm">
        {[
          { n: "1", label: "البيانات الأساسية", desc: "اسم الشركة والأرقام الرسمية" },
          { n: "2", label: "العنوان الوطني", desc: "عنوان المنشأة الرسمي" },
          { n: "3", label: "إعدادات ZATCA", desc: "ربط الجهاز وبيئة العمل" },
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
                      <FormLabel>مجال الصناعة / النشاط <span className="text-muted-foreground text-xs">(اختياري)</span></FormLabel>
                      <FormControl>
                        <Input placeholder="تقنية المعلومات" {...field} />
                      </FormControl>
                      <FormDescription>
                        النشاط التجاري الرئيسي للمنشأة
                        <br /><ExampleBadge text="التجزئة / الخدمات المهنية / المقاولات" />
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
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

          {/* Actions */}
          <div className="flex justify-end gap-4">
            <Button type="button" variant="outline" asChild>
              <Link href="/companies">إلغاء</Link>
            </Button>
            <Button type="submit" className="gap-2 min-w-36" disabled={createCompany.isPending}>
              <Save className="h-4 w-4" />
              <span>{createCompany.isPending ? "جاري الحفظ..." : "حفظ بيانات الشركة"}</span>
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
