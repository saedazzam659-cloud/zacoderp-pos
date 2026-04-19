import { useState } from "react";
import { useLocation } from "wouter";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useFieldArray } from "react-hook-form";
import * as z from "zod";
import { useCreateInvoice, useListCompanies, useListCustomers } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
import {
  ArrowRight, Save, Plus, Trash2, Info, AlertTriangle,
  CreditCard, ClipboardList, Package, ChevronLeft, ChevronRight,
} from "lucide-react";
import { Link } from "wouter";
import { ZATCA_UNIT_CODES } from "@/lib/zatca-units";

const PAYMENT_METHOD_ITEMS: ComboboxItem[] = [
  { value: "10", code: "10", label: "نقدي",             labelEn: "Cash" },
  { value: "30", code: "30", label: "تحويل بنكي",      labelEn: "Credit Transfer" },
  { value: "42", code: "42", label: "حساب بنكي",       labelEn: "Bank Account" },
  { value: "48", code: "48", label: "بطاقة بنكية",     labelEn: "Bank Card" },
  { value: "1",  code: "1",  label: "أخرى / غير محدد", labelEn: "Not Defined" },
];

const INVOICE_TYPE_ITEMS: ComboboxItem[] = [
  { value: "standard",   code: "B2B", label: "ضريبية (B2B)",  description: "شركة لشركة — تُخلَّص فوراً لدى ZATCA" },
  { value: "simplified", code: "B2C", label: "مبسطة (B2C)",  description: "شركة لفرد — QR Code — تُبلَّغ خلال 24 ساعة" },
];

const TAX_CATEGORY_ITEMS: ComboboxItem[] = [
  { value: "S", code: "S", label: "خاضع 15%",  labelEn: "Standard Rate", badge: "15%",  badgeClass: "bg-primary/10 text-primary border-primary/20" },
  { value: "Z", code: "Z", label: "صفري 0%",   labelEn: "Zero Rated",    badge: "0%",   badgeClass: "bg-blue-100 text-blue-700 border-blue-200" },
  { value: "E", code: "E", label: "معفى",       labelEn: "Exempt",         badge: "معفى", badgeClass: "bg-gray-100 text-gray-600 border-gray-200" },
];

const UNIT_ITEMS: ComboboxItem[] = ZATCA_UNIT_CODES.map(u => ({
  value: u.code, code: u.code, label: u.nameAr, labelEn: u.nameEn, group: u.group,
}));

const lineItemSchema = z.object({
  description:    z.string().min(1, "وصف الصنف مطلوب"),
  quantity:       z.coerce.number().min(0.01, "الكمية يجب أن تكون أكبر من 0"),
  unitCode:       z.string().default("PCE"),
  unitPrice:      z.coerce.number().min(0, "السعر يجب أن يكون 0 أو أكبر"),
  discountAmount: z.coerce.number().min(0).default(0),
  taxCategory:    z.string().default("S"),
  vatRate:        z.coerce.number().default(15),
});

const invoiceSchema = z.object({
  companyId:     z.coerce.number().min(1, "الشركة المصدرة مطلوبة"),
  customerId:    z.coerce.number().optional(),
  invoiceType:   z.enum(["standard", "simplified"]),
  paymentMethod: z.string().default("10"),
  issueDate:     z.string().min(1, "تاريخ الإصدار مطلوب"),
  supplyDate:    z.string().optional(),
  notes:         z.string().optional(),
  lineItems:     z.array(lineItemSchema).min(1, "يجب إضافة صنف واحد على الأقل"),
});

type FormValues = z.infer<typeof invoiceSchema>;

export default function InvoiceNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createInvoice = useCreateInvoice();
  const [activeTab, setActiveTab] = useState("basic");

  const { data: companies } = useListCompanies({ query: { queryKey: ["companies"] } });

  const form = useForm<FormValues>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: {
      companyId: undefined,
      customerId: undefined,
      invoiceType: "standard",
      paymentMethod: "10",
      issueDate: new Date().toISOString().split("T")[0],
      lineItems: [{ description: "", quantity: 1, unitCode: "PCE", unitPrice: 0, discountAmount: 0, taxCategory: "S", vatRate: 15 }],
    },
  });

  const selectedCompanyId  = form.watch("companyId");
  const selectedCustomerId = form.watch("customerId");
  const invoiceType        = form.watch("invoiceType");

  const { data: customers } = useListCustomers(
    selectedCompanyId ? { companyId: selectedCompanyId } : undefined,
    { query: { enabled: !!selectedCompanyId, queryKey: ["customers", selectedCompanyId] } }
  );

  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lineItems" });
  const watchLineItems = form.watch("lineItems");

  const totals = watchLineItems.reduce(
    (acc, item) => {
      const sub = (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0) - (Number(item.discountAmount) || 0);
      const vat = sub * ((Number(item.vatRate) || 0) / 100);
      return { subtotal: acc.subtotal + sub, vatTotal: acc.vatTotal + vat, grandTotal: acc.grandTotal + sub + vat };
    },
    { subtotal: 0, vatTotal: 0, grandTotal: 0 }
  );

  const fmt = (n: number) => new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR" }).format(n);

  const companyItems: ComboboxItem[] = (companies ?? []).map(c => ({
    value: c.id.toString(), label: c.nameAr, labelEn: c.nameEn ?? undefined,
    badge: c.isSandbox ? "تجريبي" : undefined,
    badgeClass: "bg-amber-100 text-amber-700 border-amber-200",
  }));

  const customerItems: ComboboxItem[] = (customers ?? []).map(c => ({
    value: c.id.toString(), label: c.nameAr,
    badge: c.vatNumber ? "✓ ضريبي" : undefined,
    badgeClass: "bg-green-100 text-green-700 border-green-200",
  }));

  const isB2B            = invoiceType === "standard";
  const selectedCustomer = customers?.find(c => c.id === selectedCustomerId);
  const b2bMissingCustomer = isB2B && !selectedCustomerId;
  const b2bMissingVat    = isB2B && selectedCustomerId && !selectedCustomer?.vatNumber;

  const onSubmit = (values: FormValues) => {
    createInvoice.mutate(
      { data: values },
      {
        onSuccess: invoice => {
          toast({ title: "تم حفظ الفاتورة مسودة", description: "يمكنك مراجعتها وإصدارها الآن." });
          queryClient.invalidateQueries({ queryKey: ["invoices"] });
          setLocation(`/invoices/${invoice.id}`);
        },
        onError: () => toast({ title: "حدث خطأ", description: "لم نتمكن من إنشاء الفاتورة.", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="max-w-5xl mx-auto space-y-4">

      {/* Header */}
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link href="/invoices"><ArrowRight className="h-5 w-5" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-foreground">إنشاء فاتورة جديدة</h1>
          <p className="text-muted-foreground mt-0.5 text-sm">تعبئة بيانات الفاتورة والأصناف</p>
        </div>
      </div>

      {/* Alerts */}
      {b2bMissingCustomer && (
        <div className="flex gap-3 p-3 rounded-lg border bg-amber-50 border-amber-300 text-amber-800 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
          <span><strong>تنبيه:</strong> الفاتورة الضريبية (B2B) تستلزم اختيار عميل مسجّل.</span>
        </div>
      )}
      {b2bMissingVat && (
        <div className="flex gap-3 p-3 rounded-lg border bg-orange-50 border-orange-300 text-orange-800 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-orange-500 mt-0.5" />
          <span>
            <strong>تنبيه:</strong> العميل المختار ليس لديه رقم ضريبي.{" "}
            <Link href="/customers" className="underline font-semibold">تحديث بيانات العميل</Link>
          </span>
        </div>
      )}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">

          {/* TABS */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">

            {/* Tab bar */}
            <TabsList className="w-full h-auto p-0 bg-transparent border-b rounded-none gap-0 justify-start">
              <TabsTrigger
                value="basic"
                className="relative flex items-center gap-2 px-5 py-3 rounded-none text-sm font-medium border-b-2 border-transparent
                  data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent
                  data-[state=inactive]:text-muted-foreground data-[state=inactive]:bg-transparent
                  shadow-none transition-colors"
              >
                <ClipboardList className="h-4 w-4" />
                البيانات الأساسية
              </TabsTrigger>
              <TabsTrigger
                value="items"
                className="relative flex items-center gap-2 px-5 py-3 rounded-none text-sm font-medium border-b-2 border-transparent
                  data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent
                  data-[state=inactive]:text-muted-foreground data-[state=inactive]:bg-transparent
                  shadow-none transition-colors"
              >
                <Package className="h-4 w-4" />
                الأصناف والخدمات
                {watchLineItems.length > 0 && (
                  <span className="mr-1 rounded-full bg-primary/10 text-primary text-xs px-2 py-0.5 font-bold">
                    {watchLineItems.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            {/* ── TAB 1: البيانات الأساسية ── */}
            <TabsContent value="basic" className="mt-0">
              <Card className="rounded-t-none border-t-0">
                <CardContent className="pt-6">

                  {/* Type guide */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm mb-6">
                    <div className="flex gap-2 p-3 rounded-lg border bg-blue-50 border-blue-200 text-blue-800">
                      <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
                      <div><strong>فاتورة ضريبية (B2B):</strong> للشركات — تُرسل لـ ZATCA للتخليص فوراً.</div>
                    </div>
                    <div className="flex gap-2 p-3 rounded-lg border bg-green-50 border-green-200 text-green-800">
                      <Info className="h-4 w-4 mt-0.5 shrink-0 text-green-500" />
                      <div><strong>فاتورة مبسطة (B2C):</strong> للأفراد — QR Code مدمج، تُبلَّغ خلال 24 ساعة.</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

                    {/* Company */}
                    <FormField control={form.control} name="companyId" render={({ field }) => (
                      <FormItem>
                        <FormLabel>الشركة المصدرة <span className="text-destructive">*</span></FormLabel>
                        <FormControl>
                          <SearchCombobox
                            items={companyItems}
                            value={field.value?.toString()}
                            onValueChange={v => field.onChange(parseInt(v, 10))}
                            placeholder="اختر الشركة..."
                            searchPlaceholder="ابحث باسم الشركة..."
                          />
                        </FormControl>
                        <FormDescription>المنشأة التي ستصدر الفاتورة</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />

                    {/* Invoice type */}
                    <FormField control={form.control} name="invoiceType" render={({ field }) => (
                      <FormItem>
                        <FormLabel>نوع الفاتورة <span className="text-destructive">*</span></FormLabel>
                        <FormControl>
                          <SearchCombobox
                            items={INVOICE_TYPE_ITEMS}
                            value={field.value}
                            onValueChange={field.onChange}
                            placeholder="اختر النوع..."
                            searchPlaceholder="ابحث..."
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                    {/* Customer */}
                    <FormField control={form.control} name="customerId" render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          العميل {isB2B && <span className="text-destructive">*</span>}
                        </FormLabel>
                        <FormControl>
                          <SearchCombobox
                            items={customerItems}
                            value={field.value?.toString()}
                            onValueChange={v => field.onChange(parseInt(v, 10))}
                            placeholder={selectedCompanyId ? "اختر العميل..." : "اختر الشركة أولاً"}
                            searchPlaceholder="ابحث باسم العميل..."
                            disabled={!selectedCompanyId}
                          />
                        </FormControl>
                        <FormDescription>{isB2B ? "مطلوب — يجب أن يمتلك رقماً ضريبياً" : "اختياري للفواتير المبسطة"}</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />

                    {/* Issue date */}
                    <FormField control={form.control} name="issueDate" render={({ field }) => (
                      <FormItem>
                        <FormLabel>تاريخ الإصدار <span className="text-destructive">*</span></FormLabel>
                        <FormControl><Input type="date" {...field} /></FormControl>
                        <FormDescription>يجب ألا يكون في المستقبل</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />

                    {/* Supply date */}
                    <FormField control={form.control} name="supplyDate" render={({ field }) => (
                      <FormItem>
                        <FormLabel>تاريخ التوريد / التسليم</FormLabel>
                        <FormControl><Input type="date" {...field} /></FormControl>
                        <FormDescription>إن اختلف عن تاريخ الإصدار</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />

                    {/* Payment method */}
                    <FormField control={form.control} name="paymentMethod" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-1.5">
                          <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                          طريقة الدفع <span className="text-destructive">*</span>
                        </FormLabel>
                        <FormControl>
                          <SearchCombobox
                            items={PAYMENT_METHOD_ITEMS}
                            value={field.value ?? "10"}
                            onValueChange={field.onChange}
                            placeholder="اختر طريقة الدفع..."
                            searchPlaceholder="ابحث بالكود أو الاسم..."
                          />
                        </FormControl>
                        <FormDescription>UN/ECE 4461 — مطلوب في XML لهيئة الزكاة</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />

                    {/* Notes — full width */}
                    <FormField control={form.control} name="notes" render={({ field }) => (
                      <FormItem className="md:col-span-2 lg:col-span-3">
                        <FormLabel>ملاحظات على الفاتورة</FormLabel>
                        <FormControl>
                          <textarea
                            className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                            placeholder="مثال: شكراً لتعاملكم معنا. الدفع خلال 30 يوماً."
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                  </div>

                  {/* Next button */}
                  <div className="flex justify-start mt-6 pt-4 border-t">
                    <Button type="button" variant="default" className="gap-2" onClick={() => setActiveTab("items")}>
                      التالي — الأصناف والخدمات
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </div>

                </CardContent>
              </Card>
            </TabsContent>

            {/* ── TAB 2: الأصناف والخدمات ── */}
            <TabsContent value="items" className="mt-0">
              <Card className="rounded-t-none border-t-0">
                <CardContent className="p-0">

                  <div className="overflow-x-auto w-full">
                    <table className="w-full min-w-[920px] text-sm">
                      <thead>
                        <tr className="border-b bg-muted/20">
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 190 }}>الوصف</th>
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 70 }}>الكمية</th>
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 160 }}>
                            وحدة القياس
                            <span className="block text-[9px] font-normal opacity-60">UN/CEFACT ZATCA</span>
                          </th>
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 100 }}>سعر الوحدة</th>
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 80 }}>الخصم</th>
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 150 }}>
                            فئة الضريبة
                            <span className="block text-[9px] font-normal opacity-60">ZATCA VAT</span>
                          </th>
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 110 }}>الإجمالي</th>
                          <th className="h-10 px-3" style={{ minWidth: 36 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((field, index) => {
                          const iv  = watchLineItems[index];
                          const sub = ((Number(iv?.quantity) || 0) * (Number(iv?.unitPrice) || 0)) - (Number(iv?.discountAmount) || 0);
                          const tot = sub + sub * ((Number(iv?.vatRate) || 0) / 100);
                          return (
                            <tr key={field.id} className="border-b group">
                              <td className="p-2">
                                <FormField control={form.control} name={`lineItems.${index}.description`} render={({ field }) => (
                                  <FormItem><FormControl>
                                    <Input placeholder="خدمة تصميم / جهاز / استشارة..." {...field} />
                                  </FormControl></FormItem>
                                )} />
                              </td>
                              <td className="p-2">
                                <FormField control={form.control} name={`lineItems.${index}.quantity`} render={({ field }) => (
                                  <FormItem><FormControl>
                                    <Input type="number" min="0" step="0.01" dir="ltr" className="text-left" {...field} />
                                  </FormControl></FormItem>
                                )} />
                              </td>
                              <td className="p-2">
                                <FormField control={form.control} name={`lineItems.${index}.unitCode`} render={({ field }) => (
                                  <FormItem><FormControl>
                                    <SearchCombobox
                                      items={UNIT_ITEMS}
                                      value={field.value ?? "PCE"}
                                      onValueChange={field.onChange}
                                      placeholder="وحدة..."
                                      searchPlaceholder="ابحث بالكود أو الاسم..."
                                      grouped
                                      emptyText="لا توجد وحدة مطابقة"
                                    />
                                  </FormControl></FormItem>
                                )} />
                              </td>
                              <td className="p-2">
                                <FormField control={form.control} name={`lineItems.${index}.unitPrice`} render={({ field }) => (
                                  <FormItem><FormControl>
                                    <Input type="number" min="0" step="0.01" dir="ltr" className="text-left" {...field} />
                                  </FormControl></FormItem>
                                )} />
                              </td>
                              <td className="p-2">
                                <FormField control={form.control} name={`lineItems.${index}.discountAmount`} render={({ field }) => (
                                  <FormItem><FormControl>
                                    <Input type="number" min="0" step="0.01" dir="ltr" className="text-left" {...field} />
                                  </FormControl></FormItem>
                                )} />
                              </td>
                              <td className="p-2">
                                <FormField control={form.control} name={`lineItems.${index}.taxCategory`} render={({ field }) => (
                                  <FormItem><FormControl>
                                    <SearchCombobox
                                      items={TAX_CATEGORY_ITEMS}
                                      value={field.value ?? "S"}
                                      onValueChange={v => {
                                        field.onChange(v);
                                        const rates: Record<string, number> = { S: 15, Z: 0, E: 0 };
                                        form.setValue(`lineItems.${index}.vatRate`, rates[v] ?? 15);
                                      }}
                                      placeholder="فئة..."
                                      searchPlaceholder="ابحث بالكود أو الاسم..."
                                    />
                                  </FormControl></FormItem>
                                )} />
                              </td>
                              <td className="p-2 font-medium tabular-nums whitespace-nowrap" dir="ltr">{fmt(tot)}</td>
                              <td className="p-2 text-center">
                                <Button type="button" variant="ghost" size="icon"
                                  onClick={() => remove(index)} disabled={fields.length === 1}
                                  className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity">
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Add item */}
                  <div className="p-4 border-b border-dashed">
                    <Button type="button" variant="outline" size="sm" className="gap-2"
                      onClick={() => append({ description: "", quantity: 1, unitCode: "PCE", unitPrice: 0, discountAmount: 0, taxCategory: "S", vatRate: 15 })}>
                      <Plus className="h-4 w-4" />إضافة صنف جديد
                    </Button>
                  </div>

                  {/* Totals */}
                  <div className="p-6 bg-muted/10 flex flex-col items-end gap-3">
                    <div className="w-full max-w-xs space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">المجموع قبل الضريبة:</span>
                        <span className="font-medium tabular-nums" dir="ltr">{fmt(totals.subtotal)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">ضريبة القيمة المضافة:</span>
                        <span className="font-medium text-primary tabular-nums" dir="ltr">+{fmt(totals.vatTotal)}</span>
                      </div>
                      <div className="h-px bg-border" />
                      <div className="flex justify-between text-base font-bold">
                        <span>الإجمالي المستحق:</span>
                        <span className="tabular-nums" dir="ltr">{fmt(totals.grandTotal)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="p-4 border-t flex justify-between items-center">
                    <Button type="button" variant="ghost" className="gap-2 text-muted-foreground" onClick={() => setActiveTab("basic")}>
                      <ChevronRight className="h-4 w-4" />
                      رجوع — البيانات الأساسية
                    </Button>
                    <div className="flex gap-3">
                      <Button type="button" variant="outline" asChild>
                        <Link href="/invoices">إلغاء</Link>
                      </Button>
                      <Button type="submit" className="gap-2" disabled={createInvoice.isPending}>
                        <Save className="h-4 w-4" />
                        {createInvoice.isPending ? "جاري الحفظ..." : "حفظ مسودة"}
                      </Button>
                    </div>
                  </div>

                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </form>
      </Form>
    </div>
  );
}
