import { useState, useEffect } from "react";
import { useLocation, useRoute } from "wouter";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { useCreateCustomer, useListCompanies, useGetCustomer, useUpdateCustomer } from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowRight, Save, Users, Info, Building2, MapPin, Phone,
  BadgeCheck, AlertTriangle, ChevronLeft, ChevronRight, CheckCircle2, BookMarked,
} from "lucide-react";
import { AccountCombobox } from "@/components/AccountCombobox";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { LocationCapture, type LocationValue } from "@/components/LocationCapture";
import { useEnterNavigation } from "@/hooks/useEnterNavigation";

const NATIONAL_ADDRESS_RX = /^[A-Z]{4}[0-9]{4}$/;

const customerSchema = z.object({
  companyId:      z.coerce.number().min(1, "الشركة المسؤولة مطلوبة"),
  customerType:   z.enum(["b2b", "b2c"]).default("b2b"),
  nameAr:         z.string().min(2, "اسم العميل مطلوب (حرفان على الأقل)"),
  nameEn:         z.string().optional(),
  vatNumber:      z.string().optional().refine(v => !v || v.length === 15, "يجب أن يكون 15 رقماً"),
  crNumber:       z.string().optional(),
  email:          z.string().email("بريد إلكتروني غير صالح").optional().or(z.literal("")),
  phone:          z.string().optional(),
  city:           z.string().optional(),
  district:       z.string().optional(),
  street:         z.string().optional(),
  buildingNumber: z.string().optional(),
  postalCode:     z.string().optional(),
  country:        z.string().default("SA"),
  nationalAddressShort: z.string().optional()
    .refine(v => !v || NATIONAL_ADDRESS_RX.test(v), "صيغة العنوان الوطني المختصر: 4 حروف إنجليزية + 4 أرقام (مثل RYDH2345)"),
  /**
   * `true`  = العميل يظهر بأرصدته في كشوفات الحسابات وتقارير الأعمار (السلوك الافتراضي).
   * `false` = العميل «للعرض فقط»: بياناته تُطبع على الفواتير والقيود لكن أرصدته
   *            مُستثناة من كشف حساب العملاء وتقارير الأعمار.
   */
  includeInStatements: z.boolean().default(true),
  /**
   * Credit-control pair:
   *   creditLimit         — sets the maximum AR exposure (SAR). 0 / empty means none.
   *   enforceCreditLimit  — when true, the server refuses to CREATE a credit sales
   *                         invoice that would push (currentBalance + invoiceTotal)
   *                         above creditLimit (returns 409 with code "credit_limit_exceeded").
   */
  creditLimit:        z.coerce.number().min(0, "لا يمكن أن يكون سالباً").default(0),
  enforceCreditLimit: z.boolean().default(false),
  /** Optional default branch — sent as null when blank. */
  branchId:           z.union([z.coerce.number().int().positive(), z.literal(""), z.null()]).optional(),
});

type FormValues = z.infer<typeof customerSchema>;

export default function CustomerNew() {
  const [, setLocation] = useLocation();
  const [matchEdit, paramsEdit] = useRoute("/customers/:id");
  const editingId = matchEdit && paramsEdit?.id && paramsEdit.id !== "new" ? Number(paramsEdit.id) : null;
  const isEditMode = !!editingId;
  const { toast }       = useToast();
  const queryClient     = useQueryClient();
  const createCustomer  = useCreateCustomer();
  const updateCustomer  = useUpdateCustomer();
  const [activeTab, setActiveTab] = useState("basic");
  const { user } = useAuth();
  const { data: existingCustomer } = useGetCustomer(editingId as any, {
    query: { enabled: isEditMode } as any,
  });

  const isSuperAdmin   = user?.role === "superadmin";
  const userCompanyId  = user?.companyId;
  const userCompanyName = user?.company?.nameAr ?? user?.company?.nameEn ?? "";

  // Superadmin: company text input state
  const [companyText, setCompanyText] = useState("");
  const [custAccountId, setCustAccountId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [location, setLocation_] = useState<LocationValue>({ lat: null, lng: null, link: null });
  const { token } = useAuth() as any;
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", userCompanyId],
    enabled: !!userCompanyId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/org/branches`, { headers: { Authorization: `Bearer ${token}` } });
      return r.ok ? r.json() : [];
    },
  });
  const { data: companies } = useListCompanies({
    query: { queryKey: ["companies"], enabled: isSuperAdmin }
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      companyId:    userCompanyId ?? undefined,
      customerType: "b2b",
      nameAr: "", nameEn: "",
      vatNumber: "", crNumber: "",
      email: "", phone: "",
      city: "", district: "", street: "",
      buildingNumber: "", postalCode: "",
      country: "SA",
      nationalAddressShort: "",
      includeInStatements: true,
      creditLimit: 0,
      enforceCreditLimit: false,
    },
  });

  // Auto-set companyId for company users
  useEffect(() => {
    if (!isSuperAdmin && userCompanyId) form.setValue("companyId", userCompanyId);
  }, [userCompanyId, isSuperAdmin]);

  // Prefill form when editing
  useEffect(() => {
    if (!isEditMode || !existingCustomer) return;
    const c: any = existingCustomer;
    form.reset({
      companyId:      c.companyId ?? userCompanyId,
      customerType:   (c.customerType as any) ?? "b2b",
      nameAr:         c.nameAr ?? "",
      nameEn:         c.nameEn ?? "",
      vatNumber:      c.vatNumber ?? "",
      crNumber:       c.crNumber ?? "",
      email:          c.email ?? "",
      phone:          c.phone ?? "",
      city:           c.city ?? "",
      district:       c.district ?? "",
      street:         c.street ?? "",
      buildingNumber: c.buildingNumber ?? "",
      postalCode:     c.postalCode ?? "",
      country:        c.country ?? "SA",
      nationalAddressShort: c.nationalAddressShort ?? "",
      includeInStatements: c.includeInStatements ?? true,
      creditLimit: Number(c.creditLimit ?? 0),
      enforceCreditLimit: c.enforceCreditLimit ?? false,
    });
    if (c.accountId) setCustAccountId(String(c.accountId));
    setBranchId(c.branchId ? String(c.branchId) : "");
    setLocation_({
      lat: c.locationLat ?? null,
      lng: c.locationLng ?? null,
      link: c.locationLink ?? null,
    });
  }, [isEditMode, existingCustomer]);

  const customerType = form.watch("customerType");
  const isB2B        = customerType === "b2b";
  const vatValue     = form.watch("vatNumber") ?? "";
  const vatOk        = vatValue.length === 15 && vatValue.startsWith("3");

  // Tab completeness indicators
  const nameAr = form.watch("nameAr");
  const city   = form.watch("city");
  const basicComplete = !!nameAr;
  const taxComplete   = isB2B ? vatOk : true;
  const addressComplete = isB2B ? !!(city) : true;

  const onSubmit = (values: FormValues) => {
    if (!isSuperAdmin && userCompanyId) values.companyId = userCompanyId;
    const { customerType: _ct, ...rest } = values;
    const payload = {
      ...rest,
      accountId: custAccountId ? Number(custAccountId) : null,
      branchId: branchId ? Number(branchId) : null,
      locationLat: location.lat,
      locationLng: location.lng,
      locationLink: location.link,
    } as any;
    if (isEditMode && editingId) {
      updateCustomer.mutate({ id: editingId, data: payload }, {
        onSuccess: () => {
          toast({ title: "✓ تم حفظ التعديلات", description: "تم تحديث بيانات العميل." });
          queryClient.invalidateQueries({ queryKey: ["customers"] });
          queryClient.invalidateQueries({ queryKey: [`/api/customers/${editingId}`] });
          setLocation("/customers");
        },
        onError: (e: any) => toast({
          title: "تعذّر تحديث العميل",
          description: e?.response?.data?.error || e?.message || "لم نتمكن من تحديث العميل.",
          variant: "destructive",
        }),
      });
      return;
    }
    createCustomer.mutate({ data: payload }, {
      onSuccess: () => {
        toast({ title: "✓ تمت الإضافة بنجاح", description: "تمت إضافة العميل إلى النظام." });
        queryClient.invalidateQueries({ queryKey: ["customers"] });
        setLocation("/customers");
      },
      onError: (e: any) => toast({
        title: "تعذّر إضافة العميل",
        description: e?.response?.data?.error || e?.message || "لم نتمكن من إضافة العميل.",
        variant: "destructive",
      }),
    });
  };

  // Enter→Next navigation: pressing Enter in any input advances focus,
  // and on the last field triggers form save.
  const { containerRef, onKeyDown } = useEnterNavigation(() =>
    form.handleSubmit(onSubmit)(),
  );

  // Tab badge helper
  const tabBadge = (ok: boolean, required: boolean) => {
    if (!required) return null;
    return ok
      ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 inline mr-1" />
      : <span className="mr-1 rounded-full bg-amber-100 text-amber-700 text-xs px-1.5 py-0.5 font-bold border border-amber-300">!</span>;
  };

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} className="max-w-4xl mx-auto space-y-4" dir="rtl">

      {/* Header */}
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon" data-enter-skip="true">
          <Link href="/customers"><ArrowRight className="h-5 w-5" /></Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{isEditMode ? "تعديل بيانات العميل" : "إضافة عميل جديد"}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            أدخل بيانات العميل — اضغط Enter للانتقال للحقل التالي.
          </p>
        </div>
        <Button
          type="button"
          className="gap-2 min-w-[140px]"
          data-enter-submit="true"
          disabled={createCustomer.isPending || updateCustomer.isPending}
          onClick={form.handleSubmit(onSubmit, (errors) => {
            const firstTab =
              (errors.nameAr || errors.companyId) ? "basic" :
              (errors.vatNumber || errors.crNumber) ? "tax" : "address";
            setActiveTab(firstTab);
            const firstMsg = Object.values(errors)[0]?.message as string | undefined;
            toast({
              title: "تحقّق من الحقول المطلوبة",
              description: firstMsg ?? "يوجد حقل غير صحيح — راجع التبويبات.",
              variant: "destructive",
            });
          })}
        >
          <Save className="h-4 w-4" />
          {(createCustomer.isPending || updateCustomer.isPending)
            ? "جاري الحفظ..."
            : (isEditMode ? "حفظ التعديلات" : "حفظ العميل")}
        </Button>
      </div>

      {/* Type notices */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        <div className="flex gap-2.5 p-3 rounded-lg border bg-blue-50 border-blue-200 text-blue-800">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
          <div>
            <strong>عميل شركة (B2B):</strong> يجب إدخال الرقم الضريبي (15 رقماً) والعنوان الوطني الكامل لإصدار الفاتورة الضريبية.
          </div>
        </div>
        <div className="flex gap-2.5 p-3 rounded-lg border bg-green-50 border-green-200 text-green-800">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-green-500" />
          <div>
            <strong>عميل فرد (B2C):</strong> الاسم اختياري — يكفي حفظ الفاتورة المبسطة بدون عميل محدد.
          </div>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">

            {/* ── Tab bar ── */}
            <TabsList className="w-full h-auto p-0 bg-transparent border-b rounded-none gap-0 justify-start">
              {[
                {
                  value: "basic",
                  icon:  <Users className="h-4 w-4" />,
                  label: "البيانات الأساسية",
                  badge: tabBadge(basicComplete, true),
                },
                {
                  value: "tax",
                  icon:  <Building2 className="h-4 w-4" />,
                  label: "الضريبية والتجارية",
                  badge: tabBadge(taxComplete, isB2B),
                },
                {
                  value: "address",
                  icon:  <MapPin className="h-4 w-4" />,
                  label: "التواصل والعنوان",
                  badge: tabBadge(addressComplete, isB2B),
                },
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
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                    {/* الشركة المصدرة */}
                    {isSuperAdmin ? (
                      <FormField control={form.control} name="companyId" render={({ field }) => {
                        const matched = (companies ?? []).find(
                          c => c.nameAr === companyText || c.nameEn === companyText
                        );
                        return (
                          <FormItem>
                            <FormLabel>الشركة المصدرة للفواتير <span className="text-destructive">*</span></FormLabel>
                            <datalist id="cust-companies-list">
                              {(companies ?? []).map(c => <option key={c.id} value={c.nameAr} />)}
                            </datalist>
                            <FormControl>
                              <Input
                                list="cust-companies-list"
                                placeholder="اكتب اسم الشركة..."
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
                            </FormControl>
                            {matched
                              ? <p className="text-xs text-green-700 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />تم التعرف على الشركة</p>
                              : companyText
                                ? <p className="text-xs text-amber-600 flex items-center gap-1"><AlertTriangle className="h-3 w-3" />لم يُعثر على الشركة</p>
                                : null
                            }
                            <FormMessage />
                          </FormItem>
                        );
                      }} />
                    ) : (
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">الشركة المصدرة للفواتير</label>
                        <div className="flex items-center gap-2 h-9 rounded-md border border-input bg-muted/30 px-3 text-sm">
                          <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="truncate font-medium">{userCompanyName}</span>
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 mr-auto shrink-0" />
                        </div>
                        <p className="text-xs text-muted-foreground">مرتبط بشركتك تلقائياً</p>
                      </div>
                    )}

                    {/* نوع العميل — segment buttons */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">
                        نوع العميل <span className="text-destructive">*</span>
                      </label>
                      <div className="flex gap-2">
                        {[
                          { val: "b2b", label: "شركة / منشأة", icon: Building2, desc: "B2B" },
                          { val: "b2c", label: "فرد / مستهلك", icon: Users,     desc: "B2C" },
                        ].map(opt => {
                          const Icon = opt.icon;
                          const active = customerType === opt.val;
                          return (
                            <button key={opt.val} type="button"
                              onClick={() => form.setValue("customerType", opt.val as any)}
                              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                                active
                                  ? "bg-primary/10 border-primary text-primary shadow-sm"
                                  : "border-input text-muted-foreground hover:bg-muted/50"
                              }`}>
                              <Icon className="h-4 w-4" />
                              <span>{opt.label}</span>
                              <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${active ? "bg-primary/20" : "bg-muted"}`}>
                                {opt.desc}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {isB2B ? "يتطلب رقم ضريبي وعنوان وطني كامل" : "بيانات اختيارية — للفواتير المبسطة"}
                      </p>
                    </div>

                    {/* اسم عربي */}
                    <FormField control={form.control} name="nameAr" render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          اسم العميل أو الجهة (عربي) <span className="text-destructive">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input placeholder="مثال: شركة الأمانة للتجارة" {...field} />
                        </FormControl>
                        <FormDescription>الاسم الرسمي كما في السجل التجاري</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />

                    {/* اسم إنجليزي */}
                    <FormField control={form.control} name="nameEn" render={({ field }) => (
                      <FormItem>
                        <FormLabel>الاسم (إنجليزي)</FormLabel>
                        <FormControl>
                          <Input placeholder="Al Amanah Trading Co." dir="ltr" className="text-left" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>

                  <div className="flex justify-start mt-6 pt-4 border-t">
                    <Button type="button" variant="default" className="gap-2" onClick={() => setActiveTab("tax")}>
                      التالي — البيانات الضريبية <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ══ TAB 2: البيانات الضريبية والتجارية ══ */}
            <TabsContent value="tax" className="mt-0">
              <Card className="rounded-t-none border-t-0">
                <CardContent className="pt-6 space-y-6">

                  {/* Banner */}
                  <div className={`flex gap-3 p-4 rounded-lg border text-sm ${isB2B ? "bg-blue-50 border-blue-200 text-blue-800" : "bg-gray-50 border-gray-200 text-gray-700"}`}>
                    <Info className={`h-4 w-4 mt-0.5 shrink-0 ${isB2B ? "text-blue-500" : "text-gray-400"}`} />
                    <div>
                      {isB2B
                        ? <><p className="font-semibold mb-0.5">الحقول الإلزامية لفاتورة B2B حسب ZATCA:</p>
                            <p className="text-xs">الرقم الضريبي 15 رقماً يبدأ بـ 3 ✓ — رقم السجل التجاري موصى به</p></>
                        : <span>البيانات الضريبية <strong>اختيارية</strong> للعملاء الأفراد (B2C).</span>
                      }
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* VAT */}
                    <FormField control={form.control} name="vatNumber" render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          الرقم الضريبي (VAT)
                          {isB2B && <span className="text-destructive"> *</span>}
                          {!isB2B && <span className="text-muted-foreground text-xs mr-1">(اختياري)</span>}
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder="310000000000003"
                            dir="ltr" className="text-left font-mono tracking-widest"
                            maxLength={15}
                            {...field}
                            onChange={e => field.onChange(e.target.value.replace(/\D/g, ""))}
                          />
                        </FormControl>
                        <FormDescription>15 رقماً — يبدأ بـ 3 وينتهي بـ 3</FormDescription>
                        <FormMessage />
                        {vatValue.length > 0 && vatValue.length < 15 && (
                          <p className="text-xs text-amber-600 flex items-center gap-1 mt-1">
                            <AlertTriangle className="h-3 w-3" />{15 - vatValue.length} رقم متبقٍ
                          </p>
                        )}
                        {vatOk && (
                          <p className="text-xs text-green-600 flex items-center gap-1 mt-1">
                            <CheckCircle2 className="h-3 w-3" />رقم ضريبي صحيح
                          </p>
                        )}
                        {vatValue.length === 15 && !vatValue.startsWith("3") && (
                          <p className="text-xs text-red-600 flex items-center gap-1 mt-1">
                            <AlertTriangle className="h-3 w-3" />يجب أن يبدأ بـ 3
                          </p>
                        )}
                      </FormItem>
                    )} />

                    {/* CR */}
                    <FormField control={form.control} name="crNumber" render={({ field }) => (
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

                  {/* ── حدود الائتمان ── */}
                  {/* Two fields:
                      • creditLimit        — informational ceiling (numeric).
                      • enforceCreditLimit — when on, server refuses any credit
                        sales invoice that would push the customer's AR above
                        the limit (returns 409 credit_limit_exceeded). */}
                  <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <BadgeCheck className="h-4 w-4 text-amber-600" />
                      <h3 className="text-sm font-semibold text-amber-900">الائتمان والمسموح به</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <FormField control={form.control} name="creditLimit" render={({ field }) => (
                        <FormItem>
                          <FormLabel>الحد الائتماني للسحب (ر.س)</FormLabel>
                          <FormControl>
                            <Input
                              type="number" min={0} step="0.01" inputMode="decimal"
                              placeholder="0.00" dir="ltr" className="text-left font-mono"
                              {...field}
                              value={field.value ?? 0}
                              onChange={e => field.onChange(e.target.value === "" ? 0 : Number(e.target.value))}
                            />
                          </FormControl>
                          <FormDescription>
                            الحد الأقصى للمستحق على العميل. اتركه 0 للسماح بدون حد.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="enforceCreditLimit" render={({ field }) => (
                        <FormItem>
                          <FormLabel>منع التجاوز عند الوصول للحد</FormLabel>
                          <FormControl>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={field.value}
                              onClick={() => field.onChange(!field.value)}
                              className={`flex items-center justify-between gap-3 w-full px-3 py-2.5 rounded-md border text-sm transition-all ${
                                field.value
                                  ? "bg-amber-100 border-amber-400 text-amber-900"
                                  : "bg-white border-input text-muted-foreground hover:bg-muted/40"
                              }`}
                            >
                              <span className="flex items-center gap-2">
                                {field.value
                                  ? <CheckCircle2 className="h-4 w-4 text-amber-600" />
                                  : <Info className="h-4 w-4" />}
                                <span className="font-medium">
                                  {field.value ? "مفعَّل — سيتم رفض الفواتير الزائدة عن الحد" : "غير مفعَّل — الحد للعرض فقط"}
                                </span>
                              </span>
                              <span className={`relative inline-block w-10 h-5 rounded-full transition ${field.value ? "bg-amber-500" : "bg-slate-300"}`}>
                                <span className={`absolute top-0.5 ${field.value ? "right-0.5" : "right-5"} w-4 h-4 bg-white rounded-full shadow transition-all`} />
                              </span>
                            </button>
                          </FormControl>
                          <FormDescription>
                            عند تفعيله، إنشاء فاتورة آجلة تجعل المستحق يتجاوز الحد سيُرفض من الخادم.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  </div>

                  <div className="flex justify-between pt-4 border-t">
                    <Button type="button" variant="ghost" className="gap-2 text-muted-foreground" onClick={() => setActiveTab("basic")}>
                      <ChevronRight className="h-4 w-4" /> رجوع
                    </Button>
                    <Button type="button" variant="default" className="gap-2" onClick={() => setActiveTab("address")}>
                      التالي — التواصل والعنوان <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ══ TAB 3: التواصل والعنوان الوطني ══ */}
            <TabsContent value="address" className="mt-0">
              <Card className="rounded-t-none border-t-0">
                <CardContent className="pt-6 space-y-6">

                  {/* Contact */}
                  <div>
                    <div className="flex items-center gap-2 mb-4">
                      <Phone className="h-4 w-4 text-primary" />
                      <h3 className="font-semibold text-sm">معلومات التواصل</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                      <FormField control={form.control} name="email" render={({ field }) => (
                        <FormItem>
                          <FormLabel>البريد الإلكتروني</FormLabel>
                          <FormControl>
                            <Input type="email" placeholder="info@company.com" dir="ltr" className="text-left" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="phone" render={({ field }) => (
                        <FormItem>
                          <FormLabel>رقم الهاتف</FormLabel>
                          <FormControl>
                            <Input placeholder="0500000000" dir="ltr" className="text-left" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  </div>

                  {/* National Address */}
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
                      <FormField control={form.control} name="street" render={({ field }) => (
                        <FormItem>
                          <FormLabel>اسم الشارع {isB2B && <span className="text-destructive">*</span>}</FormLabel>
                          <FormControl>
                            <Input placeholder="شارع الملك فهد" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="buildingNumber" render={({ field }) => (
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
                          <FormDescription>4 أرقام</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="district" render={({ field }) => (
                        <FormItem>
                          <FormLabel>الحي</FormLabel>
                          <FormControl><Input placeholder="العليا" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="city" render={({ field }) => (
                        <FormItem>
                          <FormLabel>المدينة {isB2B && <span className="text-destructive">*</span>}</FormLabel>
                          <FormControl><Input placeholder="الرياض" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="postalCode" render={({ field }) => (
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
                          <FormDescription>5 أرقام</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  </div>

                  {/* National Address Short + GPS Location */}
                  <div className="pt-2 border-t">
                    <div className="flex items-center gap-2 mb-3">
                      <MapPin className="h-4 w-4 text-primary" />
                      <h3 className="font-semibold text-sm">العنوان الوطني المختصر والموقع</h3>
                      <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5">
                        تسريع التسجيل
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                      <FormField control={form.control} name="nationalAddressShort" render={({ field }) => (
                        <FormItem>
                          <FormLabel>الرمز الوطني المختصر</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="RYDH2345"
                              dir="ltr"
                              className="text-left font-mono tracking-widest uppercase"
                              maxLength={8}
                              value={field.value ?? ""}
                              onChange={(e) => field.onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                            />
                          </FormControl>
                          <FormDescription>
                            صيغة قصيرة: 4 حروف + 4 أرقام (يُستخرج من بطاقة العنوان الوطني السعودي).
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">الموقع الجغرافي (GPS)</label>
                        <LocationCapture value={location} onChange={setLocation_} />
                      </div>
                    </div>
                  </div>

                  {/* Branch + Accounting link */}
                  <div className="pt-4 border-t grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium flex items-center gap-1.5">
                        <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                        الفرع الافتراضي
                      </label>
                      <select
                        value={branchId}
                        onChange={e => setBranchId(e.target.value)}
                        className="w-full h-10 border border-input rounded-md px-3 text-sm bg-background"
                        data-testid="customer-branch"
                      >
                        <option value="">— بدون فرع محدد —</option>
                        {(branches as any[]).map((b: any) => (
                          <option key={b.id} value={b.id}>
                            {b.nameAr ?? b.nameEn ?? `#${b.id}`}{b.isMain ? " (الرئيسي)" : ""}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground">اختياري — الفرع الافتراضي عند إنشاء فاتورة لهذا العميل</p>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium flex items-center gap-1.5">
                        <BookMarked className="h-3.5 w-3.5 text-muted-foreground" />
                        حساب المدينين (العميل)
                      </label>
                      <AccountCombobox
                        value={custAccountId}
                        onValueChange={setCustAccountId}
                        placeholder="— اختر الحساب المحاسبي —"
                        filterTypes={["asset"]}
                        grouped={false}
                      />
                      <p className="text-xs text-muted-foreground">اختياري — الحساب المرتبط بهذا العميل في دفتر الأستاذ</p>
                    </div>
                  </div>

                  <div className="flex justify-between pt-4 border-t">
                    <Button type="button" variant="ghost" className="gap-2 text-muted-foreground" onClick={() => setActiveTab("tax")}>
                      <ChevronRight className="h-4 w-4" /> رجوع
                    </Button>
                    <div className="flex gap-3">
                      <Button type="button" variant="outline" asChild data-enter-skip="true">
                        <Link href="/customers">إلغاء</Link>
                      </Button>
                      <Button type="submit" className="gap-2 min-w-[140px]" data-enter-skip="true" disabled={createCustomer.isPending || updateCustomer.isPending}>
                        <Save className="h-4 w-4" />
                        {(createCustomer.isPending || updateCustomer.isPending)
                          ? "جاري الحفظ..."
                          : (isEditMode ? "حفظ التعديلات" : "حفظ العميل")}
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
