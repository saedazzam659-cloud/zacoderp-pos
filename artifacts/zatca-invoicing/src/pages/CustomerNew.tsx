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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, Save, Users } from "lucide-react";
import { Link } from "wouter";

const customerSchema = z.object({
  companyId: z.coerce.number().min(1, { message: "الشركة المسؤولة مطلوبة" }),
  nameAr: z.string().min(2, { message: "اسم العميل مطلوب" }),
  nameEn: z.string().optional(),
  vatNumber: z.string().optional().refine(val => !val || val.length === 15, { message: "يجب أن يكون 15 رقماً إن وجد" }),
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

  const onSubmit = (values: z.infer<typeof customerSchema>) => {
    createCustomer.mutate({
      data: values
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

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
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
                    <FormItem className="col-span-full md:col-span-1">
                      <FormLabel>الشركة المصدرة للفواتير *</FormLabel>
                      <Select 
                        onValueChange={(val) => field.onChange(parseInt(val, 10))} 
                        value={field.value?.toString() || ""}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="اختر شركتك التابع لها العميل" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {companies?.map(c => (
                            <SelectItem key={c.id} value={c.id.toString()}>{c.nameAr}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="hidden md:block"></div>
                
                <FormField
                  control={form.control}
                  name="nameAr"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>اسم العميل أو الجهة (عربي) *</FormLabel>
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
                <FormField
                  control={form.control}
                  name="vatNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>الرقم الضريبي (إن وجد لفواتير B2B)</FormLabel>
                      <FormControl>
                        <Input placeholder="15 رقم" dir="ltr" className="text-left" maxLength={15} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="crNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>رقم السجل التجاري</FormLabel>
                      <FormControl>
                        <Input dir="ltr" className="text-left" {...field} />
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
              <CardTitle className="text-lg">معلومات الاتصال والعنوان</CardTitle>
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
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <FormField
                  control={form.control}
                  name="buildingNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>رقم المبنى</FormLabel>
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
                      <FormLabel>الشارع</FormLabel>
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
                      <FormLabel>المدينة</FormLabel>
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
                      <FormLabel>الرمز البريدي</FormLabel>
                      <FormControl>
                        <Input dir="ltr" className="text-left" maxLength={5} {...field} />
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
