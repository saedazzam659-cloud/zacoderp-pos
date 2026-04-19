import { useLocation } from "wouter";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { useCreateCustomer, useListCompanies } from "@workspace/api-client-react";
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
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, Save, Users, Info, Building2 } from "lucide-react";
import { Link } from "wouter";

const CUSTOMER_TYPE_OPTIONS: ComboboxItem[] = [
  { value: "b2b", code: "B2B", label: "شركة / منشأة",  description: "يحتاج رقم ضريبي وعنوان وطني — للفواتير الضريبية" },
  { value: "b2c", code: "B2C", label: "فرد / مستهلك",  description: "بيانات اختيارية — للفواتير المبسطة" },
];

const customerSchema = z.object({
  companyId: z.coerce.number().min(1, { message: "الشركة المسؤولة مطلوبة" }),
  customerType: z.enum(["b2b", "b2c"]).default("b2b"),
  nameAr: z.string().min(2, { message: "اسم العميل مطلوب" }),
  nameEn: z.string().optional(),
  vatNumber: z.string().optional().refine(val => !val || val.length === 15, { message: "يجب أن يكون 15 رقماً" }),
  crNumber: z.string().optional(),
  email: z.string().email({ message: "بريد إلكتروني غير صالح" }).optional().or(z.literal("")),
  phone: z.string().optional(),
  city: z.string().optional(),
  district: z.string().optional(),
  street: z.string().optional(),
  buildingNumber: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().default("SA"),
});

export default function CustomerNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createCustomer = useCreateCustomer();
  
  const { data: companies } = useListCompanies({
    query: { queryKey: ["companies"] }
  });

  const form = useForm<z.infer<typeof customerSchema>>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      companyId: undefined,
      customerType: "b2b",
      nameAr: "",
      nameEn: "",
      vatNumber: "",
      crNumber: "",
      email: "",
      phone: "",
      city: "",
      district: "",
      street: "",
      buildingNumber: "",
      postalCode: "",
      country: "SA",
    },
  });

  const customerType = form.watch("customerType");
  const isB2B = customerType === "b2b";

  const onSubmit = (values: z.infer<typeof customerSchema>) => {
    const { customerType: _ct, ...rest } = values;
    createCustomer.mutate({
      data: rest
    }, {
      onSuccess: () => {
        toast({
          title: "تمت الإضافة بنجاح",
          description: "تمت إضافة العميل إلى النظام بنجاح.",
        });
        queryClient.invalidateQueries({ queryKey: ["customers"] });
        setLocation("/customers");
      },
      onError: () => {
        toast({
          title: "حدث خطأ",
          description: "لم نتمكن من إضافة العميل. يرجى المحاولة مرة أخرى.",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link href="/customers">
            <ArrowRight className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-foreground">إضافة عميل جديد</h1>
          <p className="text-muted-foreground mt-1">أدخل بيانات العميل الذي ستصدر الفواتير لصالحه</p>
        </div>
      </div>

      {/* B2B requirements notice */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        <div className="flex gap-3 p-3 rounded-lg border bg-blue-50 border-blue-200 text-blue-800">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
          <div>
            <strong>عميل شركة (B2B):</strong> يجب إدخال الرقم الضريبي (15 رقماً) والعنوان الوطني الكامل (الشارع، المبنى، الرمز البريدي، المدينة) — مطلوب لإصدار الفاتورة الضريبية.
          </div>
        </div>
        <div className="flex gap-3 p-3 rounded-lg border bg-green-50 border-green-200 text-green-800">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-green-500" />
          <div>
            <strong>عميل فرد (B2C):</strong> الاسم اختياري — يكفي حفظ الفاتورة المبسطة بدون عميل محدد.
          </div>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {/* Basic Details */}
          <Card>
            <CardHeader className="border-b bg-muted/20 pb-4">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                <CardTitle className="text-lg">البيانات الأساسية</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="companyId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>الشركة المصدرة للفواتير <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <SearchCombobox
                          items={(companies ?? []).map(c => ({
                            value: c.id.toString(),
                            label: c.nameAr,
                            labelEn: c.nameEn ?? undefined,
                          }))}
                          value={field.value?.toString()}
                          onValueChange={v => field.onChange(parseInt(v, 10))}
                          placeholder="اختر شركتك التابع لها العميل..."
                          searchPlaceholder="ابحث باسم الشركة..."
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="customerType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>نوع العميل <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <SearchCombobox
                          items={CUSTOMER_TYPE_OPTIONS}
                          value={field.value}
                          onValueChange={field.onChange}
                          placeholder="اختر نوع العميل..."
                          searchPlaceholder="ابحث بالكود أو الاسم..."
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="nameAr"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        اسم العميل أو الجهة (عربي)
                        <span className="text-destructive"> *</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="أدخل الاسم الرسمي..." {...field} />
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
                      <FormLabel>الاسم (إنجليزي)</FormLabel>
                      <FormControl>
                        <Input placeholder="Customer Name..." dir="ltr" className="text-left" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          {/* Tax & Commercial IDs */}
          <Card className={isB2B ? "border-blue-200" : ""}>
            <CardHeader className={`border-b pb-4 ${isB2B ? "bg-blue-50/50" : "bg-muted/20"}`}>
              <div className="flex items-center gap-2">
                <Building2 className={`h-5 w-5 ${isB2B ? "text-blue-600" : "text-muted-foreground"}`} />
                <CardTitle className="text-lg">
                  البيانات الضريبية والتجارية
                  {isB2B && <span className="mr-2 text-xs font-normal bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">مطلوبة للفواتير الضريبية B2B</span>}
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="vatNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        الرقم الضريبي (VAT)
                        {isB2B && <span className="text-destructive"> *</span>}
                        {!isB2B && <span className="text-muted-foreground text-xs"> (اختياري)</span>}
                      </FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="3xxxxxxxxxxxxxxxxx — 15 رقم يبدأ بـ 3" 
                          dir="ltr" 
                          className={`text-left font-mono ${isB2B && !field.value ? "border-blue-300 focus:border-blue-500" : ""}`}
                          maxLength={15} 
                          {...field} 
                        />
                      </FormControl>
                      <FormDescription>
                        {isB2B 
                          ? "مطلوب لإصدار الفاتورة الضريبية — 15 رقماً يبدأ بـ 3 وينتهي بـ 3"
                          : "اختياري — أدخله إن كان العميل مسجلاً ضريبياً"}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="crNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>رقم السجل التجاري (CR)</FormLabel>
                      <FormControl>
                        <Input placeholder="10xxxxxxxx" dir="ltr" className="text-left font-mono" {...field} />
                      </FormControl>
                      <FormDescription>اختياري — يُضاف في XML للفواتير الضريبية</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          {/* Contact & Address */}
          <Card>
            <CardHeader className="border-b bg-muted/20 pb-4">
              <CardTitle className="text-lg flex items-center gap-2">
                معلومات الاتصال والعنوان الوطني
                {isB2B && <span className="text-xs font-normal bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">مطلوب للفواتير B2B</span>}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>البريد الإلكتروني</FormLabel>
                      <FormControl>
                        <Input type="email" dir="ltr" className="text-left" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>رقم الهاتف</FormLabel>
                      <FormControl>
                        <Input dir="ltr" className="text-left" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* National Address — required for B2B */}
              <div className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-4 rounded-lg ${isB2B ? "bg-blue-50/50 border border-blue-100" : "bg-muted/10 border"}`}>
                <div className="col-span-full mb-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    العنوان الوطني
                    {isB2B && <span className="text-blue-700 mr-1">— مطلوب لفواتير B2B حسب اشتراطات ZATCA</span>}
                  </p>
                </div>
                <FormField
                  control={form.control}
                  name="buildingNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        رقم المبنى
                        {isB2B && <span className="text-destructive"> *</span>}
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="مثال: 1234" dir="ltr" className={`text-left ${isB2B && !field.value ? "border-blue-300" : ""}`} maxLength={4} {...field} />
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
                      <FormLabel>
                        الشارع
                        {isB2B && <span className="text-destructive"> *</span>}
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="مثال: شارع الملك فهد" className={isB2B && !field.value ? "border-blue-300" : ""} {...field} />
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
                        <Input placeholder="مثال: العليا" {...field} />
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
                      <FormLabel>
                        المدينة
                        {isB2B && <span className="text-destructive"> *</span>}
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="مثال: الرياض" className={isB2B && !field.value ? "border-blue-300" : ""} {...field} />
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
                      <FormLabel>
                        الرمز البريدي
                        {isB2B && <span className="text-destructive"> *</span>}
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="مثال: 12345" dir="ltr" className={`text-left ${isB2B && !field.value ? "border-blue-300" : ""}`} maxLength={5} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4 pb-12">
            <Button type="button" variant="outline" asChild>
              <Link href="/customers">إلغاء</Link>
            </Button>
            <Button type="submit" className="gap-2" disabled={createCustomer.isPending}>
              <Save className="h-4 w-4" />
              <span>{createCustomer.isPending ? "جاري الحفظ..." : "حفظ العميل"}</span>
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
