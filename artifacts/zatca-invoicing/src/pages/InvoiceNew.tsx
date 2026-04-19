import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useFieldArray } from "react-hook-form";
import * as z from "zod";
import { useCreateInvoice, useListCompanies, useListCustomers } from "@workspace/api-client-react";
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
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, Save, Plus, Trash2, Info, AlertTriangle, CreditCard } from "lucide-react";
import { Link } from "wouter";
import { ZATCA_UNIT_CODES, ZATCA_UNIT_GROUPS } from "@/lib/zatca-units";

const PAYMENT_METHODS = [
  { code: "10", labelAr: "نقدي", labelEn: "Cash" },
  { code: "30", labelAr: "تحويل بنكي", labelEn: "Credit Transfer" },
  { code: "42", labelAr: "حساب بنكي", labelEn: "Bank Account" },
  { code: "48", labelAr: "بطاقة بنكية", labelEn: "Bank Card" },
  { code: "1",  labelAr: "أخرى / غير محدد", labelEn: "Not Defined" },
];

const TAX_CATEGORIES = [
  { code: "S",  labelAr: "خاضع 15%",  rate: 15 },
  { code: "Z",  labelAr: "صفري 0%",    rate: 0  },
  { code: "E",  labelAr: "معفى 0%",    rate: 0  },
];

const lineItemSchema = z.object({
  description: z.string().min(1, "وصف الصنف مطلوب"),
  quantity: z.coerce.number().min(0.01, "الكمية يجب أن تكون أكبر من 0"),
  unitCode: z.string().default("PCE"),
  unitPrice: z.coerce.number().min(0, "السعر يجب أن يكون 0 أو أكبر"),
  discountAmount: z.coerce.number().min(0).default(0),
  taxCategory: z.string().default("S"),
  vatRate: z.coerce.number().default(15),
});

const invoiceSchema = z.object({
  companyId: z.coerce.number().min(1, "الشركة المصدرة مطلوبة"),
  customerId: z.coerce.number().optional(),
  invoiceType: z.enum(["standard", "simplified"]),
  paymentMethod: z.string().default("10"),
  issueDate: z.string().min(1, "تاريخ الإصدار مطلوب"),
  supplyDate: z.string().optional(),
  notes: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1, "يجب إضافة صنف واحد على الأقل"),
});

export default function InvoiceNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createInvoice = useCreateInvoice();
  
  const { data: companies } = useListCompanies({ query: { queryKey: ["companies"] } });
  
  const form = useForm<z.infer<typeof invoiceSchema>>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: {
      companyId: undefined,
      customerId: undefined,
      invoiceType: "standard",
      paymentMethod: "10",
      issueDate: new Date().toISOString().split('T')[0],
      lineItems: [{ description: "", quantity: 1, unitCode: "PCE", unitPrice: 0, discountAmount: 0, taxCategory: "S", vatRate: 15 }]
    },
  });

  const selectedCompanyId = form.watch("companyId");
  const selectedCustomerId = form.watch("customerId");
  const invoiceType = form.watch("invoiceType");

  const { data: customers } = useListCustomers(
    selectedCompanyId ? { companyId: selectedCompanyId } : undefined,
    { query: { enabled: !!selectedCompanyId, queryKey: ["customers", selectedCompanyId] } }
  );

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lineItems",
  });

  const watchLineItems = form.watch("lineItems");
  const totals = watchLineItems.reduce((acc, item) => {
    const q = Number(item.quantity) || 0;
    const p = Number(item.unitPrice) || 0;
    const d = Number(item.discountAmount) || 0;
    const r = Number(item.vatRate) || 0;
    const subtotal = (q * p) - d;
    const vat = subtotal * (r / 100);
    return {
      subtotal: acc.subtotal + subtotal,
      vatTotal: acc.vatTotal + vat,
      grandTotal: acc.grandTotal + subtotal + vat
    };
  }, { subtotal: 0, vatTotal: 0, grandTotal: 0 });

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('ar-SA', { style: 'currency', currency: 'SAR' }).format(amount);
  };

  const selectedCustomer = customers?.find(c => c.id === selectedCustomerId);
  const isB2B = invoiceType === "standard";
  const b2bMissingVat = isB2B && selectedCustomerId && !selectedCustomer?.vatNumber;
  const b2bMissingCustomer = isB2B && !selectedCustomerId;

  const onSubmit = (values: z.infer<typeof invoiceSchema>) => {
    createInvoice.mutate({
      data: values
    }, {
      onSuccess: (invoice) => {
        toast({
          title: "تم حفظ الفاتورة مسودة",
          description: "يمكنك مراجعتها وإصدارها الآن.",
        });
        queryClient.invalidateQueries({ queryKey: ["invoices"] });
        setLocation(`/invoices/${invoice.id}`);
      },
      onError: () => {
        toast({
          title: "حدث خطأ",
          description: "لم نتمكن من إنشاء الفاتورة.",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link href="/invoices">
            <ArrowRight className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-foreground">إنشاء فاتورة جديدة</h1>
          <p className="text-muted-foreground mt-1">تعبئة بيانات الفاتورة والأصناف</p>
        </div>
      </div>

      {/* Invoice type guide */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        <div className="flex gap-3 p-3 rounded-lg border bg-blue-50 border-blue-200 text-blue-800">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
          <div>
            <strong>فاتورة ضريبية (B2B):</strong> للشركات والمنشآت — تحتاج بيانات العميل (رقم ضريبي، عنوان) وتُرسل فوراً لهيئة الزكاة للتخليص.
          </div>
        </div>
        <div className="flex gap-3 p-3 rounded-lg border bg-green-50 border-green-200 text-green-800">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-green-500" />
          <div>
            <strong>فاتورة مبسطة (B2C):</strong> للأفراد — لا تحتاج بيانات العميل، يُطبع QR Code عليها، وتُبلَّغ خلال 24 ساعة.
          </div>
        </div>
      </div>

      {/* B2B warning banner */}
      {b2bMissingCustomer && (
        <div className="flex gap-3 p-4 rounded-lg border bg-amber-50 border-amber-300 text-amber-800 text-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500 mt-0.5" />
          <div>
            <strong>تنبيه — فاتورة ضريبية (B2B) بدون عميل:</strong> يُشترط اختيار عميل مسجّل لإصدار الفاتورة الضريبية (B2B). يمكن حفظها مسودة الآن واختيار العميل لاحقاً.
          </div>
        </div>
      )}
      {b2bMissingVat && (
        <div className="flex gap-3 p-4 rounded-lg border bg-orange-50 border-orange-300 text-orange-800 text-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-orange-500 mt-0.5" />
          <div>
            <strong>تنبيه — العميل بدون رقم ضريبي:</strong> الفاتورة الضريبية (B2B) تستلزم الرقم الضريبي للعميل وعنوانه الكامل.{" "}
            <Link href={`/customers`} className="underline font-semibold">تحديث بيانات العميل</Link>
          </div>
        </div>
      )}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {/* Basic Details */}
          <Card>
            <CardHeader className="border-b bg-muted/20 pb-4">
              <CardTitle className="text-lg">البيانات الأساسية</CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <FormField
                  control={form.control}
                  name="companyId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>الشركة المصدرة <span className="text-destructive">*</span></FormLabel>
                      <Select 
                        onValueChange={(val) => field.onChange(parseInt(val, 10))} 
                        value={field.value?.toString() || ""}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="اختر الشركة" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {companies?.map(c => (
                            <SelectItem key={c.id} value={c.id.toString()}>
                              <div className="flex items-center gap-2">
                                <span>{c.nameAr}</span>
                                {c.isSandbox && <span className="text-xs bg-amber-100 text-amber-700 px-1 rounded">تجريبي</span>}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>المنشأة التي ستصدر الفاتورة</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="invoiceType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>نوع الفاتورة <span className="text-destructive">*</span></FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="standard">
                            <div>
                              <p className="font-medium">ضريبية (B2B)</p>
                              <p className="text-xs text-muted-foreground">شركة لشركة — تُخلَّص فوراً</p>
                            </div>
                          </SelectItem>
                          <SelectItem value="simplified">
                            <div>
                              <p className="font-medium">مبسطة (B2C)</p>
                              <p className="text-xs text-muted-foreground">شركة لفرد — QR Code</p>
                            </div>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="customerId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        العميل {isB2B && <span className="text-destructive">*</span>}
                      </FormLabel>
                      <Select 
                        onValueChange={(val) => field.onChange(parseInt(val, 10))} 
                        value={field.value?.toString() || ""}
                        disabled={!selectedCompanyId}
                      >
                        <FormControl>
                          <SelectTrigger className={b2bMissingCustomer ? "border-amber-400" : ""}>
                            <SelectValue placeholder={selectedCompanyId ? "اختر عميلاً" : "اختر الشركة أولاً"} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {customers?.map(c => (
                            <SelectItem key={c.id} value={c.id.toString()}>
                              <div className="flex items-center gap-2">
                                <span>{c.nameAr}</span>
                                {c.vatNumber && <span className="text-xs bg-green-100 text-green-700 px-1 rounded">✓ ضريبي</span>}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        {isB2B ? "مطلوب — يجب أن يمتلك رقماً ضريبياً" : "اختياري للفواتير المبسطة"}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="issueDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>تاريخ الإصدار <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormDescription>يجب ألا يكون في المستقبل</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="supplyDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>تاريخ التوريد / التسليم</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormDescription>إن اختلف عن تاريخ الإصدار</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="paymentMethod"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex items-center gap-1.5">
                        <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                        طريقة الدفع <span className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? "10"}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {PAYMENT_METHODS.map(pm => (
                            <SelectItem key={pm.code} value={pm.code}>
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-xs text-muted-foreground">{pm.code}</span>
                                <span>{pm.labelAr}</span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>UN/ECE 4461 — مطلوب في XML لهيئة الزكاة</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          {/* Line Items */}
          <Card>
            <CardHeader className="border-b bg-muted/20 pb-4">
              <CardTitle className="text-lg">الأصناف والخدمات</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                أضف كل صنف أو خدمة في سطر منفصل. الضريبة تُحسب تلقائياً حسب الفئة الضريبية لكل صنف.
              </p>
            </CardHeader>
            <CardContent className="pt-6 p-0 sm:p-6">
              <div className="overflow-x-auto w-full">
                <table className="w-full min-w-[900px] caption-bottom text-sm">
                  <thead className="[&_tr]:border-b">
                    <tr className="border-b transition-colors hover:bg-muted/50">
                      <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground" style={{minWidth:"200px"}}>الوصف / اسم الخدمة أو المنتج</th>
                      <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground" style={{minWidth:"75px"}}>الكمية</th>
                      <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground" style={{minWidth:"130px"}}>
                        وحدة القياس
                        <span className="block text-[10px] font-normal text-muted-foreground/60">UN/CEFACT</span>
                      </th>
                      <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground" style={{minWidth:"100px"}}>سعر الوحدة</th>
                      <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground" style={{minWidth:"85px"}}>الخصم</th>
                      <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground" style={{minWidth:"110px"}}>
                        فئة الضريبة
                        <span className="block text-[10px] font-normal text-muted-foreground/60">ZATCA VAT</span>
                      </th>
                      <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground" style={{minWidth:"120px"}}>الإجمالي شامل ض.ق.م</th>
                      <th className="h-12 px-4 text-center align-middle font-medium text-muted-foreground"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((field, index) => {
                      const itemValues = watchLineItems[index];
                      const q = Number(itemValues?.quantity) || 0;
                      const p = Number(itemValues?.unitPrice) || 0;
                      const d = Number(itemValues?.discountAmount) || 0;
                      const r = Number(itemValues?.vatRate) || 0;
                      const sub = (q * p) - d;
                      const tot = sub + (sub * r / 100);

                      return (
                        <tr key={field.id} className="border-b transition-colors group">
                          <td className="p-2">
                            <FormField
                              control={form.control}
                              name={`lineItems.${index}.description`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <Input placeholder="مثال: خدمة تصميم / جهاز حاسب" {...field} />
                                  </FormControl>
                                </FormItem>
                              )}
                            />
                          </td>
                          <td className="p-2">
                            <FormField
                              control={form.control}
                              name={`lineItems.${index}.quantity`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <Input type="number" min="0" step="0.01" dir="ltr" className="text-left" {...field} />
                                  </FormControl>
                                </FormItem>
                              )}
                            />
                          </td>
                          <td className="p-2">
                            <FormField
                              control={form.control}
                              name={`lineItems.${index}.unitCode`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <Select onValueChange={field.onChange} value={field.value ?? "PCE"}>
                                      <SelectTrigger className="min-w-[120px]">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {ZATCA_UNIT_GROUPS.map(group => (
                                          <SelectGroup key={group}>
                                            <SelectLabel className="text-xs text-muted-foreground px-2 py-1">{group}</SelectLabel>
                                            {ZATCA_UNIT_CODES.filter(u => u.group === group).map(u => (
                                              <SelectItem key={u.code} value={u.code}>
                                                <span className="font-mono text-primary text-xs ml-1">{u.code}</span>
                                                <span className="text-xs"> — {u.nameAr}</span>
                                              </SelectItem>
                                            ))}
                                          </SelectGroup>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </FormControl>
                                </FormItem>
                              )}
                            />
                          </td>
                          <td className="p-2">
                            <FormField
                              control={form.control}
                              name={`lineItems.${index}.unitPrice`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <Input type="number" min="0" step="0.01" dir="ltr" className="text-left" {...field} />
                                  </FormControl>
                                </FormItem>
                              )}
                            />
                          </td>
                          <td className="p-2">
                            <FormField
                              control={form.control}
                              name={`lineItems.${index}.discountAmount`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <Input type="number" min="0" step="0.01" dir="ltr" className="text-left" {...field} />
                                  </FormControl>
                                </FormItem>
                              )}
                            />
                          </td>
                          <td className="p-2">
                            <FormField
                              control={form.control}
                              name={`lineItems.${index}.taxCategory`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <Select
                                      onValueChange={(val) => {
                                        field.onChange(val);
                                        const cat = TAX_CATEGORIES.find(c => c.code === val);
                                        if (cat) {
                                          form.setValue(`lineItems.${index}.vatRate`, cat.rate);
                                        }
                                      }}
                                      value={field.value ?? "S"}
                                    >
                                      <SelectTrigger>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {TAX_CATEGORIES.map(tc => (
                                          <SelectItem key={tc.code} value={tc.code}>
                                            <div className="flex items-center gap-1.5">
                                              <span className={`font-mono text-xs font-bold px-1 rounded ${
                                                tc.code === "S" ? "bg-primary/10 text-primary" :
                                                tc.code === "Z" ? "bg-blue-100 text-blue-700" :
                                                "bg-gray-100 text-gray-600"
                                              }`}>{tc.code}</span>
                                              <span className="text-xs">{tc.labelAr}</span>
                                            </div>
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </FormControl>
                                </FormItem>
                              )}
                            />
                          </td>
                          <td className="p-2 font-medium" dir="ltr">
                            {formatCurrency(tot)}
                          </td>
                          <td className="p-2 text-center">
                            <Button 
                              type="button" 
                              variant="ghost" 
                              size="icon" 
                              onClick={() => remove(index)}
                              disabled={fields.length === 1}
                              className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="p-4 border-b border-dashed">
                <Button 
                  type="button" 
                  variant="outline" 
                  size="sm" 
                  className="gap-2"
                  onClick={() => append({ description: "", quantity: 1, unitCode: "PCE", unitPrice: 0, discountAmount: 0, taxCategory: "S", vatRate: 15 })}
                >
                  <Plus className="h-4 w-4" />
                  إضافة صنف جديد
                </Button>
              </div>

              {/* Totals Section */}
              <div className="p-6 bg-muted/10 flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
                <div className="w-full md:w-1/2">
                  <FormField
                    control={form.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>ملاحظات على الفاتورة</FormLabel>
                        <FormControl>
                          <textarea 
                            className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                            placeholder="مثال: شكراً لتعاملكم معنا. الدفع خلال 30 يوماً من تاريخ الفاتورة."
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                
                <div className="w-full md:w-1/3 space-y-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-muted-foreground">الإجمالي الخاضع للضريبة:</span>
                    <span className="font-medium" dir="ltr">{formatCurrency(totals.subtotal)}</span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-muted-foreground">مجموع ضريبة القيمة المضافة:</span>
                    <span className="font-medium text-primary" dir="ltr">+{formatCurrency(totals.vatTotal)}</span>
                  </div>
                  <div className="h-px bg-border my-2 border-dashed border-b"></div>
                  <div className="flex justify-between items-center text-lg font-bold">
                    <span>الإجمالي المستحق:</span>
                    <span dir="ltr">{formatCurrency(totals.grandTotal)}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4 pb-12">
            <Button type="button" variant="outline" asChild>
              <Link href="/invoices">إلغاء</Link>
            </Button>
            <Button type="submit" className="gap-2" disabled={createInvoice.isPending}>
              <Save className="h-4 w-4" />
              <span>{createInvoice.isPending ? "جاري الحفظ..." : "حفظ مسودة"}</span>
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
