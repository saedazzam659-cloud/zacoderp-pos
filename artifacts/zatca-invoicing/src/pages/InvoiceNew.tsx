import { useState, useEffect } from "react";
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
  Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowRight, Save, Plus, Trash2, Info, AlertTriangle,
  CreditCard, ClipboardList, Package, ChevronLeft, ChevronRight, User,
  BadgeCheck, Building2, MapPin, CheckCircle2, Tag,
} from "lucide-react";
import { Link } from "wouter";
import { ZATCA_UNIT_CODES } from "@/lib/zatca-units";
import { useAuth } from "@/contexts/AuthContext";

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

const COUNTRY_ITEMS: ComboboxItem[] = [
  { value: "SA", code: "SA", label: "المملكة العربية السعودية", labelEn: "Saudi Arabia" },
  { value: "AE", code: "AE", label: "الإمارات العربية المتحدة", labelEn: "UAE" },
  { value: "KW", code: "KW", label: "الكويت",                  labelEn: "Kuwait" },
  { value: "BH", code: "BH", label: "البحرين",                 labelEn: "Bahrain" },
  { value: "QA", code: "QA", label: "قطر",                     labelEn: "Qatar" },
  { value: "OM", code: "OM", label: "عُمان",                   labelEn: "Oman" },
  { value: "EG", code: "EG", label: "مصر",                     labelEn: "Egypt" },
  { value: "JO", code: "JO", label: "الأردن",                  labelEn: "Jordan" },
  { value: "US", code: "US", label: "الولايات المتحدة",        labelEn: "United States" },
  { value: "GB", code: "GB", label: "المملكة المتحدة",         labelEn: "United Kingdom" },
  { value: "DE", code: "DE", label: "ألمانيا",                  labelEn: "Germany" },
  { value: "FR", code: "FR", label: "فرنسا",                    labelEn: "France" },
  { value: "CN", code: "CN", label: "الصين",                   labelEn: "China" },
  { value: "IN", code: "IN", label: "الهند",                    labelEn: "India" },
];

const lineItemSchema = z.object({
  description:    z.string().min(1, "وصف الصنف مطلوب"),
  quantity:       z.coerce.number().min(0.001, "الكمية يجب أن تكون أكبر من صفر"),
  unitCode:       z.string().default("PCE"),
  unitPrice:      z.coerce.number().min(0, "السعر يجب أن يكون صفراً أو أكثر"),
  discountAmount: z.coerce.number().min(0).default(0),
  taxCategory:    z.string().default("S"),
  vatRate:        z.coerce.number().default(15),
});

const invoiceSchema = z.object({
  companyId:          z.coerce.number().min(1, "الشركة المصدرة مطلوبة"),
  customerId:         z.coerce.number().optional(),
  invoiceType:        z.enum(["standard", "simplified"]),
  paymentMethod:      z.string().default("10"),
  issueDate:          z.string().min(1, "تاريخ الإصدار مطلوب"),
  supplyDate:         z.string().optional(),
  notes:              z.string().optional(),
  // Buyer — ZATCA mandatory for B2B
  buyerName:          z.string().optional(),
  buyerVatNumber:     z.string().optional(),
  buyerCrNumber:      z.string().optional(),
  buyerStreet:        z.string().optional(),
  buyerBuildingNumber: z.string().optional(),
  buyerDistrict:      z.string().optional(),
  buyerCity:          z.string().optional(),
  buyerPostalCode:    z.string().optional(),
  buyerCountry:       z.string().default("SA"),
  lineItems:          z.array(lineItemSchema).min(1, "يجب إضافة صنف واحد على الأقل"),
});

type FormValues = z.infer<typeof invoiceSchema>;

// Readonly field — styled like input but non-editable
function ReadonlyField({ value, label, description, icon: Icon }: {
  value: string; label: string; description?: string; icon?: any;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
        {label}
      </label>
      <div className="flex items-center gap-2 h-9 rounded-md border border-input bg-muted/30 px-3 text-sm text-foreground select-text">
        {Icon && <Icon className="h-4 w-4 text-muted-foreground shrink-0" />}
        <span className="truncate">{value}</span>
        <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0 mr-auto" />
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

export default function InvoiceNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createInvoice = useCreateInvoice();
  const [activeTab, setActiveTab] = useState("basic");
  const { user } = useAuth();

  const isSuperAdmin = user?.role === "superadmin";
  const userCompanyId = user?.companyId;
  const userCompanyName = user?.company?.nameAr ?? user?.company?.nameEn ?? "";
  const userCompanyVat = user?.company?.vatNumber ?? "";

  // Superadmin: text search for company (no dropdown)
  const [companyText, setCompanyText] = useState("");

  // Companies list — only used by superadmin
  const { data: companies } = useListCompanies({
    query: { queryKey: ["companies"], enabled: isSuperAdmin }
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: {
      companyId: userCompanyId ?? undefined,
      customerId: undefined,
      invoiceType: "standard",
      paymentMethod: "10",
      issueDate: new Date().toISOString().split("T")[0],
      buyerCountry: "SA",
      lineItems: [{ description: "", quantity: 1, unitCode: "PCE", unitPrice: 0, discountAmount: 0, taxCategory: "S", vatRate: 15 }],
    },
  });

  // Auto-set companyId for company users (non-superadmin)
  useEffect(() => {
    if (!isSuperAdmin && userCompanyId) {
      form.setValue("companyId", userCompanyId);
    }
  }, [userCompanyId, isSuperAdmin]);

  const selectedCompanyId  = form.watch("companyId");
  const selectedCustomerId = form.watch("customerId");
  const invoiceType        = form.watch("invoiceType");
  const isB2B              = invoiceType === "standard";

  const effectiveCompanyId = isSuperAdmin ? selectedCompanyId : (userCompanyId ?? 0);

  const { data: customers } = useListCustomers(
    effectiveCompanyId ? { companyId: effectiveCompanyId } : undefined,
    { query: { enabled: !!effectiveCompanyId, queryKey: ["customers", effectiveCompanyId] } }
  );

  // Auto-populate buyer fields when customer is selected
  useEffect(() => {
    if (!selectedCustomerId || !customers) return;
    const c = customers.find(x => x.id === selectedCustomerId);
    if (!c) return;
    form.setValue("buyerName",           c.nameAr ?? "");
    form.setValue("buyerVatNumber",      c.vatNumber ?? "");
    form.setValue("buyerCrNumber",       c.crNumber ?? "");
    form.setValue("buyerStreet",         c.street ?? "");
    form.setValue("buyerBuildingNumber", c.buildingNumber ?? "");
    form.setValue("buyerDistrict",       c.district ?? "");
    form.setValue("buyerCity",           c.city ?? "");
    form.setValue("buyerPostalCode",     c.postalCode ?? "");
    form.setValue("buyerCountry",        c.country ?? "SA");
  }, [selectedCustomerId, customers]);

  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lineItems" });
  const watchLineItems = form.watch("lineItems");

  const totals = watchLineItems.reduce(
    (acc, item) => {
      const qty      = Number(item.quantity) || 0;
      const price    = Number(item.unitPrice) || 0;
      const discount = Number(item.discountAmount) || 0;
      const gross    = qty * price;
      const sub      = gross - discount;
      const vat      = sub * ((Number(item.vatRate) || 0) / 100);
      return {
        gross:         acc.gross + gross,
        discountTotal: acc.discountTotal + discount,
        subtotal:      acc.subtotal + sub,
        vatTotal:      acc.vatTotal + vat,
        grandTotal:    acc.grandTotal + sub + vat,
      };
    },
    { gross: 0, discountTotal: 0, subtotal: 0, vatTotal: 0, grandTotal: 0 }
  );

  const fmt = (n: number) => new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR" }).format(n);

  const companyItems: ComboboxItem[] = (companies ?? []).map(c => ({
    value: c.id.toString(), label: c.nameAr, labelEn: c.nameEn ?? undefined,
    badge: c.isSandbox ? "تجريبي" : undefined,
    badgeClass: "bg-amber-100 text-amber-700 border-amber-200",
  }));

  const customerItems: ComboboxItem[] = (customers ?? []).map(c => ({
    value: c.id.toString(), label: c.nameAr,
    badge: c.vatNumber ? "✓ ضريبي" : "بدون رقم",
    badgeClass: c.vatNumber
      ? "bg-green-100 text-green-700 border-green-200"
      : "bg-amber-100 text-amber-700 border-amber-200",
  }));

  const selectedCustomer   = customers?.find(c => c.id === selectedCustomerId);
  const b2bMissingCustomer = isB2B && !selectedCustomerId;
  const b2bMissingVat      = isB2B && selectedCustomerId && !selectedCustomer?.vatNumber;

  // Buyer tab completeness
  const buyerName    = form.watch("buyerName");
  const buyerVat     = form.watch("buyerVatNumber");
  const buyerCity    = form.watch("buyerCity");
  const buyerStreet  = form.watch("buyerStreet");
  const buyerPostal  = form.watch("buyerPostalCode");
  const buyerComplete = isB2B
    ? !!(buyerName && buyerVat?.length === 15 && buyerCity && buyerStreet)
    : !!buyerName;

  const vatValid = !buyerVat || (buyerVat.length === 15 && /^3\d{14}$/.test(buyerVat));

  const onSubmit = (values: FormValues) => {
    if (!isSuperAdmin && userCompanyId) values.companyId = userCompanyId;
    createInvoice.mutate(
      { data: values as any },
      {
        onSuccess: invoice => {
          toast({ title: "✓ تم حفظ الفاتورة مسودة", description: "يمكنك مراجعتها وإصدارها." });
          queryClient.invalidateQueries({ queryKey: ["invoices"] });
          setLocation(`/invoices/${invoice.id}`);
        },
        onError: (e: any) => toast({
          title: "حدث خطأ",
          description: e?.data?.error ?? "لم نتمكن من إنشاء الفاتورة.",
          variant: "destructive"
        }),
      }
    );
  };

  return (
    <div className="max-w-5xl mx-auto space-y-4" dir="rtl">

      {/* Header */}
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link href="/invoices"><ArrowRight className="h-5 w-5" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold">إنشاء فاتورة جديدة</h1>
          <p className="text-muted-foreground mt-0.5 text-sm">تعبئة بيانات الفاتورة والأصناف</p>
        </div>
      </div>

      {/* Global alerts */}
      {b2bMissingCustomer && (
        <div className="flex gap-3 p-3 rounded-lg border bg-amber-50 border-amber-300 text-amber-800 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
          <span><strong>تنبيه:</strong> الفاتورة الضريبية (B2B) تستلزم اختيار عميل مسجّل يمتلك رقماً ضريبياً.</span>
        </div>
      )}
      {b2bMissingVat && (
        <div className="flex gap-3 p-3 rounded-lg border bg-orange-50 border-orange-300 text-orange-800 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-orange-500 mt-0.5" />
          <span>
            <strong>تنبيه:</strong> العميل ليس لديه رقم ضريبي — مطلوب للفاتورة B2B.{" "}
            <Link href="/customers" className="underline font-semibold">تحديث بيانات العميل</Link>
          </span>
        </div>
      )}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">

            {/* ── Tab bar ── */}
            <TabsList className="w-full h-auto p-0 bg-transparent border-b rounded-none gap-0 justify-start">
              {[
                { value: "basic", icon: <ClipboardList className="h-4 w-4" />, label: "البيانات الأساسية" },
                { value: "buyer", icon: <User className="h-4 w-4" />, label: "بيانات المشتري",
                  badge: isB2B && !buyerComplete
                    ? <span className="mr-1 rounded-full bg-amber-100 text-amber-700 text-xs px-1.5 py-0.5 font-bold border border-amber-300">!</span>
                    : buyerComplete
                      ? <span className="mr-1 text-green-600"><BadgeCheck className="h-3.5 w-3.5 inline" /></span>
                      : null },
                { value: "items", icon: <Package className="h-4 w-4" />, label: "الأصناف والخدمات",
                  badge: watchLineItems.length > 0
                    ? <span className="mr-1 rounded-full bg-primary/10 text-primary text-xs px-2 py-0.5 font-bold">{watchLineItems.length}</span>
                    : null },
              ].map(tab => (
                <TabsTrigger key={tab.value} value={tab.value}
                  className="relative flex items-center gap-2 px-5 py-3 rounded-none text-sm font-medium border-b-2 border-transparent
                    data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent
                    data-[state=inactive]:text-muted-foreground shadow-none transition-colors">
                  {tab.icon}{tab.label}{tab.badge}
                </TabsTrigger>
              ))}
            </TabsList>

            {/* ══ TAB 1: البيانات الأساسية ══ */}
            <TabsContent value="basic" className="mt-0">
              <Card className="rounded-t-none border-t-0">
                <CardContent className="pt-6">
                  {/* Type explanation */}
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

                    {/* ─── الشركة المصدرة ─── */}
                    {isSuperAdmin ? (
                      <FormField control={form.control} name="companyId" render={({ field }) => {
                        const matched = (companies ?? []).find(
                          c => c.nameAr === companyText || c.nameEn === companyText || c.id.toString() === companyText
                        );
                        return (
                          <FormItem>
                            <FormLabel>الشركة المصدرة <span className="text-destructive">*</span></FormLabel>
                            {/* Native datalist — no custom dropdown, just browser suggestions */}
                            <datalist id="companies-list">
                              {(companies ?? []).map(c => (
                                <option key={c.id} value={c.nameAr} />
                              ))}
                            </datalist>
                            <FormControl>
                              <div className="relative">
                                <Building2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none z-10" />
                                <Input
                                  list="companies-list"
                                  placeholder="اكتب اسم الشركة..."
                                  className="pr-9 pl-9"
                                  value={companyText}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setCompanyText(val);
                                    const found = (companies ?? []).find(
                                      c => c.nameAr === val || c.nameEn === val
                                    );
                                    field.onChange(found ? found.id : undefined);
                                  }}
                                />
                                {matched && (
                                  <CheckCircle2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-green-500 pointer-events-none" />
                                )}
                              </div>
                            </FormControl>
                            {matched && (
                              <p className="text-xs text-green-700 font-mono">
                                الرقم الضريبي: {matched.vatNumber ?? "—"}
                              </p>
                            )}
                            {companyText && !matched && (
                              <p className="text-xs text-amber-600 flex items-center gap-1">
                                <AlertTriangle className="h-3 w-3" />
                                لم يُعثر على الشركة — تأكد من الاسم
                              </p>
                            )}
                            <FormMessage />
                          </FormItem>
                        );
                      }} />
                    ) : (
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">الشركة المصدرة</label>
                        <div className="flex items-center gap-2 h-9 rounded-md border border-input bg-muted/30 px-3 text-sm">
                          <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="truncate font-medium">{userCompanyName}</span>
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0 mr-auto" />
                        </div>
                        {userCompanyVat && (
                          <p className="text-xs text-muted-foreground font-mono">
                            الرقم الضريبي: {userCompanyVat}
                          </p>
                        )}
                      </div>
                    )}

                    <FormField control={form.control} name="invoiceType" render={({ field }) => (
                      <FormItem>
                        <FormLabel>نوع الفاتورة <span className="text-destructive">*</span></FormLabel>
                        <FormControl>
                          <SearchCombobox items={INVOICE_TYPE_ITEMS} value={field.value}
                            onValueChange={field.onChange}
                            placeholder="اختر النوع..." searchPlaceholder="ابحث..." />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="customerId" render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          العميل {isB2B && <span className="text-destructive">*</span>}
                          {!isB2B && <span className="text-xs text-muted-foreground mr-1">(اختياري)</span>}
                        </FormLabel>
                        <FormControl>
                          <SearchCombobox items={customerItems} value={field.value?.toString()}
                            onValueChange={v => field.onChange(parseInt(v, 10))}
                            placeholder={effectiveCompanyId ? "اختر العميل..." : "حدد الشركة أولاً"}
                            searchPlaceholder="ابحث باسم العميل أو الرقم الضريبي..."
                            disabled={!effectiveCompanyId} />
                        </FormControl>
                        <FormDescription>
                          {isB2B ? "مطلوب — يجب أن يمتلك رقماً ضريبياً (15 رقماً)" : "اختياري للفواتير المبسطة B2C"}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="issueDate" render={({ field }) => (
                      <FormItem>
                        <FormLabel>تاريخ الإصدار <span className="text-destructive">*</span></FormLabel>
                        <FormControl><Input type="date" {...field} /></FormControl>
                        <FormDescription>يجب ألا يكون في المستقبل</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="supplyDate" render={({ field }) => (
                      <FormItem>
                        <FormLabel>تاريخ التوريد / التسليم</FormLabel>
                        <FormControl><Input type="date" {...field} /></FormControl>
                        <FormDescription>إن اختلف عن تاريخ الإصدار — اختياري</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="paymentMethod" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-1.5">
                          <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                          طريقة الدفع <span className="text-destructive">*</span>
                        </FormLabel>
                        <FormControl>
                          <SearchCombobox items={PAYMENT_METHOD_ITEMS} value={field.value ?? "10"}
                            onValueChange={field.onChange}
                            placeholder="اختر طريقة الدفع..." searchPlaceholder="ابحث..." />
                        </FormControl>
                        <FormDescription>UN/ECE 4461 — مطلوب في XML لهيئة الزكاة</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="notes" render={({ field }) => (
                      <FormItem className="md:col-span-2 lg:col-span-3">
                        <FormLabel>ملاحظات على الفاتورة</FormLabel>
                        <FormControl>
                          <textarea
                            className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                            placeholder="مثال: شكراً لتعاملكم معنا. الدفع خلال 30 يوماً من تاريخ الفاتورة."
                            {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>

                  <div className="flex justify-start mt-6 pt-4 border-t">
                    <Button type="button" variant="default" className="gap-2" onClick={() => setActiveTab("buyer")}>
                      التالي — بيانات المشتري <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ══ TAB 2: بيانات المشتري ══ */}
            <TabsContent value="buyer" className="mt-0">
              <Card className="rounded-t-none border-t-0">
                <CardContent className="pt-6 space-y-6">

                  {/* ZATCA requirements banner */}
                  <div className={`flex gap-3 p-4 rounded-lg border text-sm ${isB2B ? "bg-blue-50 border-blue-200 text-blue-800" : "bg-gray-50 border-gray-200 text-gray-700"}`}>
                    <Info className={`h-4 w-4 mt-0.5 shrink-0 ${isB2B ? "text-blue-500" : "text-gray-500"}`} />
                    <div>
                      {isB2B ? (
                        <>
                          <p className="font-semibold mb-1">متطلبات زكاة — فاتورة ضريبية B2B (إلزامية):</p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5 text-xs">
                            <span>✓ اسم المشتري (الاسم التجاري الرسمي)</span>
                            <span>✓ الرقم الضريبي 15 رقماً يبدأ بـ 3</span>
                            <span>✓ اسم الشارع + رقم المبنى</span>
                            <span>✓ المدينة + الرمز البريدي (5 أرقام)</span>
                          </div>
                        </>
                      ) : (
                        <span><strong>فاتورة مبسطة B2C:</strong> بيانات المشتري اختيارية — يمكن إصدار الفاتورة بدونها.</span>
                      )}
                    </div>
                  </div>

                  {/* Auto-populate hint */}
                  {selectedCustomerId && (
                    <div className="flex gap-2 p-3 rounded-lg bg-green-50 border border-green-200 text-green-800 text-sm">
                      <BadgeCheck className="h-4 w-4 mt-0.5 shrink-0 text-green-600" />
                      <span>تم تعبئة البيانات تلقائياً من سجل العميل — يمكنك التعديل إن احتجت.</span>
                    </div>
                  )}

                  {/* Section: Identity */}
                  <div>
                    <div className="flex items-center gap-2 mb-4">
                      <Building2 className="h-4 w-4 text-primary" />
                      <h3 className="font-semibold text-sm">بيانات الهوية التجارية</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">

                      <FormField control={form.control} name="buyerName" render={({ field }) => (
                        <FormItem className="lg:col-span-1">
                          <FormLabel>اسم المشتري {isB2B && <span className="text-destructive">*</span>}</FormLabel>
                          <FormControl>
                            <Input placeholder="شركة الأمانة للتجارة" {...field} />
                          </FormControl>
                          <FormDescription>الاسم الرسمي كما في السجل التجاري</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="buyerVatNumber" render={({ field }) => (
                        <FormItem>
                          <FormLabel>الرقم الضريبي (VAT) {isB2B && <span className="text-destructive">*</span>}</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="310000000000003"
                              dir="ltr" className="text-left font-mono tracking-widest"
                              maxLength={15}
                              {...field}
                              onChange={e => {
                                const v = e.target.value.replace(/\D/g, "");
                                field.onChange(v);
                              }}
                            />
                          </FormControl>
                          <FormDescription>15 رقماً — يبدأ بـ 3</FormDescription>
                          <FormMessage />
                          {field.value && field.value.length > 0 && field.value.length !== 15 && (
                            <p className="text-xs text-amber-600 flex items-center gap-1 mt-1">
                              <AlertTriangle className="h-3 w-3" />
                              {15 - field.value.length} رقم متبقٍ
                            </p>
                          )}
                          {field.value?.length === 15 && !field.value.startsWith("3") && (
                            <p className="text-xs text-red-600 flex items-center gap-1 mt-1">
                              <AlertTriangle className="h-3 w-3" />
                              الرقم الضريبي يجب أن يبدأ بـ 3
                            </p>
                          )}
                          {field.value?.length === 15 && field.value.startsWith("3") && (
                            <p className="text-xs text-green-600 flex items-center gap-1 mt-1">
                              <CheckCircle2 className="h-3 w-3" />
                              رقم ضريبي صحيح
                            </p>
                          )}
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="buyerCrNumber" render={({ field }) => (
                        <FormItem>
                          <FormLabel>رقم السجل التجاري (CR)</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="1010000001"
                              dir="ltr" className="text-left font-mono"
                              {...field}
                              onChange={e => field.onChange(e.target.value.replace(/\D/g, ""))}
                            />
                          </FormControl>
                          <FormDescription>موصى به للفواتير B2B — 10 أرقام</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  </div>

                  {/* Section: National Address */}
                  <div>
                    <div className="flex items-center gap-2 mb-4">
                      <MapPin className="h-4 w-4 text-primary" />
                      <h3 className="font-semibold text-sm">العنوان الوطني</h3>
                      {isB2B && (
                        <span className="text-xs bg-red-50 text-red-700 border border-red-200 rounded-full px-2 py-0.5">
                          مطلوب للفواتير B2B
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">

                      <FormField control={form.control} name="buyerStreet" render={({ field }) => (
                        <FormItem>
                          <FormLabel>اسم الشارع {isB2B && <span className="text-destructive">*</span>}</FormLabel>
                          <FormControl><Input placeholder="شارع الأمير محمد بن عبدالعزيز" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="buyerBuildingNumber" render={({ field }) => (
                        <FormItem>
                          <FormLabel>رقم المبنى {isB2B && <span className="text-destructive">*</span>}</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="1234"
                              dir="ltr" className="text-left"
                              maxLength={4}
                              {...field}
                              onChange={e => field.onChange(e.target.value.replace(/\D/g, ""))}
                            />
                          </FormControl>
                          <FormDescription>4 أرقام بالضبط</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="buyerDistrict" render={({ field }) => (
                        <FormItem>
                          <FormLabel>الحي / المنطقة</FormLabel>
                          <FormControl><Input placeholder="حي العليا" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="buyerCity" render={({ field }) => (
                        <FormItem>
                          <FormLabel>المدينة {isB2B && <span className="text-destructive">*</span>}</FormLabel>
                          <FormControl><Input placeholder="الرياض" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="buyerPostalCode" render={({ field }) => (
                        <FormItem>
                          <FormLabel>الرمز البريدي {isB2B && <span className="text-destructive">*</span>}</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="12345"
                              dir="ltr" className="text-left font-mono"
                              maxLength={5}
                              {...field}
                              onChange={e => field.onChange(e.target.value.replace(/\D/g, ""))}
                            />
                          </FormControl>
                          <FormDescription>5 أرقام بالضبط</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="buyerCountry" render={({ field }) => (
                        <FormItem>
                          <FormLabel>الدولة {isB2B && <span className="text-destructive">*</span>}</FormLabel>
                          <FormControl>
                            <SearchCombobox items={COUNTRY_ITEMS} value={field.value ?? "SA"}
                              onValueChange={field.onChange}
                              placeholder="اختر الدولة..." searchPlaceholder="ابحث..." />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  </div>

                  <div className="flex justify-between pt-4 border-t">
                    <Button type="button" variant="ghost" className="gap-2 text-muted-foreground" onClick={() => setActiveTab("basic")}>
                      <ChevronRight className="h-4 w-4" /> رجوع
                    </Button>
                    <Button type="button" variant="default" className="gap-2" onClick={() => setActiveTab("items")}>
                      التالي — الأصناف <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ══ TAB 3: الأصناف والخدمات ══ */}
            <TabsContent value="items" className="mt-0">
              <Card className="rounded-t-none border-t-0">
                <CardContent className="p-0">
                  <div className="overflow-x-auto w-full">
                    <table className="w-full min-w-[900px] text-sm">
                      <thead>
                        <tr className="border-b bg-muted/20">
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 200 }}>وصف الصنف / الخدمة</th>
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 75 }}>الكمية</th>
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 155 }}>
                            وحدة القياس
                            <span className="block text-[9px] font-normal opacity-60">UN/CEFACT</span>
                          </th>
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 110 }}>سعر الوحدة (ر.س)</th>
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 90 }}>خصم (ر.س)</th>
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 145 }}>
                            فئة الضريبة
                            <span className="block text-[9px] font-normal opacity-60">ZATCA VAT</span>
                          </th>
                          <th className="h-10 px-3 text-right font-medium text-muted-foreground text-xs" style={{ minWidth: 110 }}>الإجمالي (ر.س)</th>
                          <th className="h-10 px-3" style={{ width: 40 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((field, index) => {
                          const iv  = watchLineItems[index];
                          const sub = ((Number(iv?.quantity) || 0) * (Number(iv?.unitPrice) || 0)) - (Number(iv?.discountAmount) || 0);
                          const tot = sub + sub * ((Number(iv?.vatRate) || 0) / 100);
                          return (
                            <tr key={field.id} className="border-b group hover:bg-muted/10">
                              <td className="p-2">
                                <FormField control={form.control} name={`lineItems.${index}.description`} render={({ field }) => (
                                  <FormItem><FormControl>
                                    <Input placeholder="مثال: خدمة استشارية / جهاز..." {...field} />
                                  </FormControl></FormItem>
                                )} />
                              </td>
                              <td className="p-2">
                                <FormField control={form.control} name={`lineItems.${index}.quantity`} render={({ field }) => (
                                  <FormItem><FormControl>
                                    <Input type="number" min="0.001" step="0.001" dir="ltr" className="text-left" {...field} />
                                  </FormControl></FormItem>
                                )} />
                              </td>
                              <td className="p-2">
                                <FormField control={form.control} name={`lineItems.${index}.unitCode`} render={({ field }) => (
                                  <FormItem><FormControl>
                                    <SearchCombobox items={UNIT_ITEMS} value={field.value ?? "PCE"} onValueChange={field.onChange}
                                      placeholder="وحدة..." searchPlaceholder="ابحث..." grouped emptyText="لا توجد وحدة مطابقة" />
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
                                    <SearchCombobox items={TAX_CATEGORY_ITEMS} value={field.value ?? "S"}
                                      onValueChange={v => {
                                        field.onChange(v);
                                        form.setValue(`lineItems.${index}.vatRate`, { S: 15, Z: 0, E: 0 }[v] ?? 15);
                                      }}
                                      placeholder="فئة..." searchPlaceholder="ابحث..." />
                                  </FormControl></FormItem>
                                )} />
                              </td>
                              <td className="p-2 font-semibold tabular-nums whitespace-nowrap text-left" dir="ltr">
                                {fmt(tot)}
                              </td>
                              <td className="p-2 text-center">
                                <Button type="button" variant="ghost" size="icon"
                                  onClick={() => remove(index)} disabled={fields.length === 1}
                                  className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity h-8 w-8">
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
                    <Button type="button" variant="outline" size="sm" className="gap-2"
                      onClick={() => append({ description: "", quantity: 1, unitCode: "PCE", unitPrice: 0, discountAmount: 0, taxCategory: "S", vatRate: 15 })}>
                      <Plus className="h-4 w-4" />إضافة صنف
                    </Button>
                  </div>

                  {/* Totals */}
                  <div className="p-6 bg-muted/10 border-t">
                    <div className="flex justify-end">
                      <div className="w-full max-w-sm">
                        {/* Rows */}
                        <div className="space-y-0 divide-y divide-border/50 rounded-xl border bg-background shadow-sm overflow-hidden">

                          {/* Gross (only show if there are discounts) */}
                          {totals.discountTotal > 0 && (
                            <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                              <span className="text-muted-foreground">إجمالي الأسعار:</span>
                              <span className="tabular-nums font-medium" dir="ltr">{fmt(totals.gross)}</span>
                            </div>
                          )}

                          {/* Discounts — highlighted */}
                          {totals.discountTotal > 0 && (
                            <div className="flex items-center justify-between px-4 py-2.5 text-sm bg-red-50/60">
                              <span className="flex items-center gap-1.5 text-red-700 font-medium">
                                <Tag className="h-3.5 w-3.5" />
                                إجمالي الخصومات:
                              </span>
                              <span className="tabular-nums font-semibold text-red-700" dir="ltr">
                                − {fmt(totals.discountTotal)}
                              </span>
                            </div>
                          )}

                          {/* Subtotal before VAT */}
                          <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                            <span className="text-muted-foreground">
                              {totals.discountTotal > 0 ? "الصافي قبل الضريبة:" : "المجموع قبل الضريبة:"}
                            </span>
                            <span className="tabular-nums font-medium" dir="ltr">{fmt(totals.subtotal)}</span>
                          </div>

                          {/* VAT */}
                          <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                            <span className="text-primary/80">ضريبة القيمة المضافة (VAT 15%):</span>
                            <span className="tabular-nums font-medium text-primary" dir="ltr">+ {fmt(totals.vatTotal)}</span>
                          </div>

                          {/* Grand total */}
                          <div className="flex items-center justify-between px-4 py-3.5 bg-primary/5 text-base font-bold">
                            <span>الإجمالي المستحق:</span>
                            <span className="tabular-nums text-primary text-lg" dir="ltr">{fmt(totals.grandTotal)}</span>
                          </div>
                        </div>

                        {/* Discount savings badge */}
                        {totals.discountTotal > 0 && (
                          <div className="mt-3 flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                            <BadgeCheck className="h-3.5 w-3.5 shrink-0" />
                            <span>
                              تم توفير <strong>{fmt(totals.discountTotal)}</strong> كخصم على هذه الفاتورة
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="p-4 border-t flex justify-between items-center">
                    <Button type="button" variant="ghost" className="gap-2 text-muted-foreground" onClick={() => setActiveTab("buyer")}>
                      <ChevronRight className="h-4 w-4" /> رجوع
                    </Button>
                    <div className="flex gap-3">
                      <Button type="button" variant="outline" asChild>
                        <Link href="/invoices">إلغاء</Link>
                      </Button>
                      <Button type="submit" className="gap-2 min-w-[140px]" disabled={createInvoice.isPending}>
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
