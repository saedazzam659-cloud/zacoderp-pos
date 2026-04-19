import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, Save, Truck, MapPin, Phone, AlertTriangle, BookMarked } from "lucide-react";
import { AccountCombobox } from "@/components/AccountCombobox";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";

const supplierSchema = z.object({
  nameAr: z.string().min(2, "اسم المورد مطلوب"),
  nameEn: z.string().optional(),
  vatNumber: z.string().optional(),
  crNumber: z.string().optional(),
  email: z.string().email("بريد إلكتروني غير صحيح").optional().or(z.literal("")),
  phone: z.string().optional(),
  city: z.string().optional(),
  district: z.string().optional(),
  street: z.string().optional(),
  buildingNumber: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().default("SA"),
});

type FormValues = z.infer<typeof supplierSchema>;

export default function SupplierNew() {
  const [, setLocation] = useLocation();
  const { user, token } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<FormValues>({
    resolver: zodResolver(supplierSchema),
    defaultValues: { country: "SA" },
  });

  const createSupplier = useMutation({
    mutationFn: async (values: FormValues) => {
      const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/suppliers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...values, companyId: user?.companyId, accountId: accountId ? Number(accountId) : null }),
      });
      if (!res.ok) throw new Error("فشل الحفظ");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "تم إضافة المورد بنجاح" });
      queryClient.invalidateQueries({ queryKey: ["suppliers"] });
      setLocation("/suppliers");
    },
    onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
  });

  const [accountId, setAccountId] = useState("");
  const vatVal = form.watch("vatNumber");

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link href="/suppliers"><ArrowRight className="h-5 w-5" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Truck className="h-6 w-6 text-primary" />إضافة مورد جديد
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">بيانات المورد / الموزع لاستخدامها في الفواتير</p>
        </div>
      </div>

      <div className="flex gap-3 p-4 rounded-lg border bg-blue-50 border-blue-200 text-blue-800 text-sm">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
        <div>
          <strong>ملاحظة ZATCA:</strong> بيانات المورد مطلوبة في فواتير الشراء والمعاملات B2B.
          الرقم الضريبي ورقم المبنى والرمز البريدي مطلوبة في XML الرسمي.
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(v => createSupplier.mutate(v))} className="space-y-6">

          {/* Identity */}
          <Card>
            <CardHeader className="border-b bg-muted/20 pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Truck className="h-4 w-4" />بيانات الهوية التجارية
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <FormField control={form.control} name="nameAr" render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>اسم المورد (عربي) <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input placeholder="شركة التوريدات الوطنية" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="nameEn" render={({ field }) => (
                  <FormItem>
                    <FormLabel>اسم المورد (إنجليزي)</FormLabel>
                    <FormControl><Input placeholder="National Supply Co." dir="ltr" className="text-left" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="vatNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel>الرقم الضريبي (VAT)</FormLabel>
                    <FormControl><Input placeholder="310000000000003" dir="ltr" className="text-left font-mono" maxLength={15} {...field} /></FormControl>
                    <FormDescription>15 رقماً — يبدأ بـ 3</FormDescription>
                    {vatVal && vatVal.length !== 15 && (
                      <p className="text-xs text-amber-600 flex items-center gap-1 mt-1">
                        <AlertTriangle className="h-3 w-3" /> يجب أن يكون 15 رقماً
                      </p>
                    )}
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="crNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel>رقم السجل التجاري (CR)</FormLabel>
                    <FormControl><Input placeholder="1010000001" dir="ltr" className="text-left font-mono" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="email" render={({ field }) => (
                  <FormItem>
                    <FormLabel>البريد الإلكتروني</FormLabel>
                    <FormControl><Input type="email" placeholder="info@supplier.com" dir="ltr" className="text-left" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="phone" render={({ field }) => (
                  <FormItem>
                    <FormLabel>رقم الهاتف</FormLabel>
                    <FormControl><Input placeholder="0500000000" dir="ltr" className="text-left" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
            </CardContent>
          </Card>

          {/* Address */}
          <Card>
            <CardHeader className="border-b bg-muted/20 pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <MapPin className="h-4 w-4" />العنوان الوطني
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-5">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                <FormField control={form.control} name="street" render={({ field }) => (
                  <FormItem>
                    <FormLabel>اسم الشارع</FormLabel>
                    <FormControl><Input placeholder="شارع الملك فهد" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="buildingNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel>رقم المبنى</FormLabel>
                    <FormControl><Input placeholder="1234" dir="ltr" className="text-left" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="district" render={({ field }) => (
                  <FormItem>
                    <FormLabel>الحي / المنطقة</FormLabel>
                    <FormControl><Input placeholder="حي العليا" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="city" render={({ field }) => (
                  <FormItem>
                    <FormLabel>المدينة</FormLabel>
                    <FormControl><Input placeholder="الرياض" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="postalCode" render={({ field }) => (
                  <FormItem>
                    <FormLabel>الرمز البريدي</FormLabel>
                    <FormControl><Input placeholder="12345" dir="ltr" className="text-left" maxLength={5} {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
            </CardContent>
          </Card>

          {/* Accounting */}
          <Card>
            <CardHeader className="border-b bg-muted/20 pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <BookMarked className="h-4 w-4" />الربط المحاسبي
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-5">
              <div className="max-w-sm space-y-1.5">
                <label className="text-sm font-medium">حساب الدائنين (المورد)</label>
                <AccountCombobox
                  value={accountId}
                  onValueChange={setAccountId}
                  placeholder="— اختر حساب الدائنين —"
                  filterTypes={["liability"]}
                  grouped={false}
                />
                <p className="text-xs text-muted-foreground">الحساب المرتبط بهذا المورد في دفتر الأستاذ</p>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-3 pb-10">
            <Button variant="outline" asChild><Link href="/suppliers">إلغاء</Link></Button>
            <Button type="submit" className="gap-2" disabled={createSupplier.isPending}>
              <Save className="h-4 w-4" />
              {createSupplier.isPending ? "جاري الحفظ..." : "حفظ المورد"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
