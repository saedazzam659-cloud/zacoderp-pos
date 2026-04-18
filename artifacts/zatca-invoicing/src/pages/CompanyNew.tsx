import { useLocation } from "wouter";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { useCreateCompany } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ArrowRight, Save, Building2 } from "lucide-react";
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
    // Combine serial numbers into the required ZATCA format if provided
    const combinedSerial = (values.deviceSerial1 && values.deviceSerial2 && values.deviceSerial3) 
      ? `${values.deviceSerial1}|${values.deviceSerial2}|${values.deviceSerial3}`
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
      onError: (error) => {
        toast({
          title: "حدث خطأ",
          description: "لم نتمكن من إضافة الشركة. يرجى المحاولة مرة أخرى.",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link href="/companies">
            <ArrowRight className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-foreground">إضافة شركة جديدة</h1>
          <p className="text-muted-foreground mt-1">أدخل بيانات الشركة للتسجيل في نظام الفوترة الإلكترونية</p>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Card>
            <CardHeader className="border-b bg-muted/20 pb-4">
              <div className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-primary" />
                <CardTitle className="text-lg">البيانات الأساسية</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="nameAr"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>اسم الشركة (عربي) *</FormLabel>
                      <FormControl>
                        <Input placeholder="أدخل اسم الشركة الرسمي..." {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="nameEn"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>اسم الشركة (إنجليزي)</FormLabel>
                      <FormControl>
                        <Input placeholder="Company Name in English..." dir="ltr" className="text-left" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="vatNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>الرقم الضريبي *</FormLabel>
                      <FormControl>
                        <Input placeholder="15 رقم" dir="ltr" className="text-left" maxLength={15} {...field} />
                      </FormControl>
                      <FormDescription>يبدأ بـ 3 وينتهي بـ 3</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="crNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>رقم السجل التجاري *</FormLabel>
                      <FormControl>
                        <Input dir="ltr" className="text-left" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="industryName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>مجال الصناعة (اختياري)</FormLabel>
                      <FormControl>
                        <Input placeholder="مثال: تقنية المعلومات" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b bg-muted/20 pb-4">
              <CardTitle className="text-lg">العنوان الوطني</CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <FormField
                  control={form.control}
                  name="buildingNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>رقم المبنى *</FormLabel>
                      <FormControl>
                        <Input dir="ltr" className="text-left" maxLength={4} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="street"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>اسم الشارع *</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="district"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>الحي</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="city"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>المدينة *</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="postalCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>الرمز البريدي *</FormLabel>
                      <FormControl>
                        <Input dir="ltr" className="text-left" maxLength={5} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="additionalNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>الرقم الإضافي</FormLabel>
                      <FormControl>
                        <Input dir="ltr" className="text-left" maxLength={4} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b bg-muted/20 pb-4">
              <CardTitle className="text-lg">إعدادات ZATCA والفواتير</CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="invoiceType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>نوع الفواتير *</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="اختر نوع الفواتير المسموحة" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="standard">فواتير ضريبية (B2B)</SelectItem>
                          <SelectItem value="simplified">فواتير ضريبية مبسطة (B2C)</SelectItem>
                          <SelectItem value="both">كلاهما</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <div className="pt-8">
                  <FormField
                    control={form.control}
                    name="isSandbox"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-start space-x-3 space-x-reverse space-y-0 rounded-md border p-4">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                        <div className="space-y-1 leading-none">
                          <FormLabel>بيئة المحاكاة (Sandbox)</FormLabel>
                          <FormDescription>
                            تفعيل وضع المحاكاة للتجارب والربط قبل الإنتاج الفعلي.
                          </FormDescription>
                        </div>
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <div className="border-t pt-6">
                <h4 className="text-sm font-medium mb-4">أرقام السيريال للأجهزة</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="deviceSerial1"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>الشركة المصنعة</FormLabel>
                        <FormControl>
                          <Input placeholder="1- Device" dir="ltr" className="text-left" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="deviceSerial2"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>الموديل / الإصدار</FormLabel>
                        <FormControl>
                          <Input placeholder="2- 2354" dir="ltr" className="text-left" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="deviceSerial3"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>السيريال الفريد</FormLabel>
                        <FormControl>
                          <Input placeholder="3- UqazDistserial" dir="ltr" className="text-left" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4 pb-12">
            <Button type="button" variant="outline" asChild>
              <Link href="/companies">إلغاء</Link>
            </Button>
            <Button type="submit" className="gap-2" disabled={createCompany.isPending}>
              <Save className="h-4 w-4" />
              <span>{createCompany.isPending ? "جاري الحفظ..." : "حفظ بيانات الشركة"}</span>
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
