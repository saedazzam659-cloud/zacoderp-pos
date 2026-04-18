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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, Save, Building2, MapPin, Settings, Info, AlertCircle, CheckCircle2, Hash, Cpu } from "lucide-react";
import { Link } from "wouter";

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
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="اختر نوع الفواتير" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="standard">
                              <div className="text-right">
                                <p className="font-medium">فاتورة ضريبية (B2B)</p>
                                <p className="text-xs text-muted-foreground">للشركات والجهات التجارية — تُرسل إلى هيئة الزكاة للتخليص</p>
                              </div>
                            </SelectItem>
                            <SelectItem value="simplified">
                              <div className="text-right">
                                <p className="font-medium">فاتورة ضريبية مبسطة (B2C)</p>
                                <p className="text-xs text-muted-foreground">للأفراد والمستهلكين — تُبلَّغ عنها في غضون 24 ساعة</p>
                              </div>
                            </SelectItem>
                            <SelectItem value="both">
                              <div className="text-right">
                                <p className="font-medium">كلا النوعين</p>
                                <p className="text-xs text-muted-foreground">إصدار فواتير B2B و B2C من نفس المنشأة</p>
                              </div>
                            </SelectItem>
                          </SelectContent>
                        </Select>
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
                <div className="flex items-start gap-3 mb-4">
                  <Cpu className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <div>
                    <h4 className="text-sm font-semibold">أرقام سيريال الجهاز (اختياري)</h4>
                    <p className="text-muted-foreground text-sm mt-1">
                      الجهاز الذي يُصدر منه الفواتير (حاسوب، نقطة بيع، خادم). هذه المعلومات تُسجَّل في ZATCA للتحقق من مصدر الفاتورة.
                    </p>
                  </div>
                </div>

                <InfoBox>
                  <strong>كيف تجد رقم السيريال؟</strong> على Windows: اذهب لـ <code className="bg-blue-100 px-1 rounded">CMD</code> واكتب <code className="bg-blue-100 px-1 rounded">wmic bios get serialnumber</code> — على Mac: اذهب لـ <code className="bg-blue-100 px-1 rounded">About This Mac</code>.
                  <br />
                  الصيغة المطلوبة في ZATCA: <code className="bg-blue-100 px-1 rounded font-mono">1-{"{"}اسم الشركة المصنعة{"}"} | 2-{"{"}الموديل{"}"} | 3-{"{"}الرقم الفريد{"}"}</code>
                </InfoBox>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                  <FormField
                    control={form.control}
                    name="deviceSerial1"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>1 — الشركة المصنعة للجهاز</FormLabel>
                        <FormControl>
                          <Input placeholder="Device" dir="ltr" className="text-left font-mono" {...field} />
                        </FormControl>
                        <FormDescription>
                          اسم الشركة المصنعة أو نوع الجهاز
                          <br /><ExampleBadge text="Dell / HP / Apple / Device" />
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
                          رقم الموديل أو إصدار الجهاز
                          <br /><ExampleBadge text="2354 / Latitude7420 / M1" />
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
                        <FormLabel>3 — الرقم التسلسلي الفريد (UUID)</FormLabel>
                        <FormControl>
                          <Input placeholder="UqazDistserial..." dir="ltr" className="text-left font-mono text-xs" {...field} />
                        </FormControl>
                        <FormDescription>
                          الرقم التسلسلي الفريد للجهاز
                          <br /><ExampleBadge text="UqazDistserialnumber" />
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Preview combined serial */}
                {(form.watch("deviceSerial1") || form.watch("deviceSerial2") || form.watch("deviceSerial3")) && (
                  <div className="mt-3 p-3 rounded-lg bg-muted border text-sm font-mono text-right" dir="ltr">
                    <span className="text-muted-foreground text-xs block mb-1 font-sans" dir="rtl">الصيغة النهائية التي ستُرسل لـ ZATCA:</span>
                    <span className="text-foreground">
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
