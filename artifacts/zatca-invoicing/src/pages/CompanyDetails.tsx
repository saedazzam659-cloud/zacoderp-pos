import { useState } from "react";
import { useParams, Link, useSearch } from "wouter";
import { useGetCompany, useUpdateCompany } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowRight, Building2, CheckCircle2, XCircle, AlertTriangle,
  Fingerprint, ShieldCheck, Key, FileCode2, Loader2, Copy, RefreshCw,
  Send, Info, ExternalLink, Smartphone
} from "lucide-react";
import ZatcaOtpDialog from "@/components/ZatcaOtpDialog";
import { format } from "date-fns";
import { arSA } from "date-fns/locale";

interface ZatcaResponse {
  success?: boolean;
  error?: string;
  hint?: string;
  csr?: string;
  message?: string;
  binarySecurityToken?: string;
  zatcaResponse?: unknown;
  warningMessages?: Array<{ code: string; message: string }>;
  errorMessages?: Array<{ code: string; message: string }>;
}

function copyToClipboard(text: string, label: string, toast: ReturnType<typeof useToast>["toast"]) {
  navigator.clipboard.writeText(text).then(() => {
    toast({ title: `تم النسخ`, description: `تم نسخ ${label}` });
  });
}

function StepBadge({ n, active, done }: { n: number; active: boolean; done: boolean }) {
  return (
    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold
      ${done ? "bg-green-500 text-white" : active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
      {done ? <CheckCircle2 className="h-4 w-4" /> : n}
    </span>
  );
}

export default function CompanyDetails() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);
  const search = useSearch();
  const defaultTab = new URLSearchParams(search).get("tab") ?? "general";
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: company, isLoading } = useGetCompany(id, {
    query: { enabled: !!id, queryKey: ["company", id] }
  });

  const [otpInput, setOtpInput] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [csrContent, setCsrContent] = useState<string | null>(null);
  const [testInvoiceId, setTestInvoiceId] = useState("");
  const [complianceCheckResult, setComplianceCheckResult] = useState<{ success: boolean; message?: string; error?: string; validationResults?: unknown } | null>(null);
  const [otpDialogOpen, setOtpDialogOpen] = useState(false);

  if (isLoading) {
    return <div className="space-y-6"><Skeleton className="h-12 w-1/3" /><Skeleton className="h-[400px] w-full" /></div>;
  }
  if (!company) return <div className="p-8 text-center">الشركة غير موجودة</div>;

  const hasCsr = !!(company as Record<string, unknown>).zatcaCsr || !!csrContent;
  const hasCsid = !!company.zatcaCsid;
  const hasPcsid = !!company.zatcaPcsid;

  async function apiCall(path: string, body?: unknown): Promise<ZatcaResponse> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  async function handleGenerateCsr() {
    setLoading("csr");
    try {
      const data = await apiCall(`/api/companies/${id}/generate-csr`);
      if (data.success) {
        setCsrContent(data.csr ?? null);
        toast({ title: "تم توليد CSR بنجاح", description: data.message });
        queryClient.invalidateQueries({ queryKey: ["company", id] });
      } else {
        toast({ title: "فشل توليد CSR", description: data.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "خطأ في الاتصال", variant: "destructive" });
    } finally {
      setLoading(null);
    }
  }

  async function handleCompliance(otp?: string) {
    const usedOtp = (otp ?? otpInput).trim();
    if (!usedOtp) {
      toast({ title: "OTP مطلوب", description: "أدخل OTP من بوابة ZATCA", variant: "destructive" });
      return;
    }
    setLoading("compliance");
    try {
      const data = await apiCall(`/api/companies/${id}/compliance`, { otp: usedOtp });
      if (data.success) {
        toast({ title: "تم ربط الجهاز بنجاح ✅", description: "تم الحصول على شهادة CSID من هيئة الزكاة والدخل" });
        queryClient.invalidateQueries({ queryKey: ["company", id] });
        setOtpInput("");
        setOtpDialogOpen(false);
      } else {
        toast({ title: "فشل ربط الجهاز", description: data.error ?? "تحقق من الرمز وحاول مجدداً", variant: "destructive" });
      }
    } catch {
      toast({ title: "خطأ في الاتصال", variant: "destructive" });
    } finally {
      setLoading(null);
    }
  }

  async function handleComplianceCheck() {
    const invId = parseInt(testInvoiceId);
    if (!invId) {
      toast({ title: "أدخل رقم معرّف الفاتورة", variant: "destructive" });
      return;
    }
    setLoading("compliance-check");
    try {
      const data = await apiCall(`/api/companies/${id}/compliance-check`, { invoiceId: invId });
      setComplianceCheckResult({ success: !!data.success, message: data.message, error: data.error });
      if (data.success) {
        toast({ title: "نجح الفحص التجريبي", description: data.message });
      } else {
        toast({ title: "فشل الفحص", description: data.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "خطأ في الاتصال", variant: "destructive" });
    } finally {
      setLoading(null);
    }
  }

  async function handleProductionCsid() {
    setLoading("pcsid");
    try {
      const data = await apiCall(`/api/companies/${id}/production-csid`);
      if (data.success) {
        toast({ title: "تم الحصول على PCSID", description: data.message });
        queryClient.invalidateQueries({ queryKey: ["company", id] });
      } else {
        toast({ title: "فشل الحصول على PCSID", description: data.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "خطأ في الاتصال", variant: "destructive" });
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button asChild variant="ghost" size="icon">
            <Link href="/companies"><ArrowRight className="h-5 w-5" /></Link>
          </Button>
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-foreground">{company.nameAr}</h1>
              <Badge variant={company.isSandbox ? "outline" : "default"}>
                {company.isSandbox ? "Sandbox محاكاة" : "Production إنتاج"}
              </Badge>
              {hasPcsid && (
                <Badge className="bg-green-100 text-green-800">
                  <CheckCircle2 className="h-3 w-3 mr-1" /> مرتبط بالكامل
                </Badge>
              )}
              {hasCsid && !hasPcsid && (
                <Badge className="bg-blue-100 text-blue-800">
                  <ShieldCheck className="h-3 w-3 mr-1" /> CSID فعّال
                </Badge>
              )}
            </div>
            {company.nameEn && <p className="text-muted-foreground mt-1">{company.nameEn}</p>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href={`/invoices?companyId=${company.id}`}>الفواتير</Link>
          </Button>
          <Button asChild>
            <Link href={`/invoices/new?companyId=${company.id}`}>إنشاء فاتورة</Link>
          </Button>
        </div>
      </div>

      <Tabs defaultValue={defaultTab} className="w-full" dir="rtl">
        <TabsList className="w-full justify-start border-b rounded-none h-auto p-0 bg-transparent mb-6 overflow-x-auto">
          {[
            { value: "general", label: "عام" },
            { value: "zatca", label: "ربط ZATCA", badge: hasPcsid ? "✓" : hasCsid ? "CSID" : "" },
            { value: "settings", label: "السيريال" },
            { value: "xml", label: "XML / QR" },
          ].map(tab => (
            <TabsTrigger key={tab.value} value={tab.value}
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2 font-medium gap-2">
              {tab.label}
              {tab.badge && (
                <span className="text-xs bg-green-100 text-green-700 px-1.5 rounded">{tab.badge}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ─── General Tab ───────────────────────────────────────────── */}
        <TabsContent value="general" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-primary" />
                  بيانات الشركة
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {[
                  { label: "الرقم الضريبي", value: company.vatNumber, ltr: true },
                  { label: "رقم السجل التجاري", value: company.crNumber, ltr: true },
                  { label: "مجال الصناعة", value: company.industryName || "-" },
                  { label: "أنواع الفواتير", value: company.invoiceType === "both" ? "ضريبية ومبسطة" : company.invoiceType === "standard" ? "ضريبية فقط" : "مبسطة فقط" },
                  { label: "عداد الفواتير", value: String((company as Record<string, unknown>).invoiceCounter ?? 0), ltr: true },
                  { label: "تاريخ التسجيل", value: company.createdAt ? format(new Date(company.createdAt), "PPP", { locale: arSA }) : "-" },
                ].map(row => (
                  <div key={row.label} className="flex justify-between items-center border-b pb-2 last:border-0">
                    <span className="text-muted-foreground">{row.label}:</span>
                    <span className="font-medium" dir={row.ltr ? "ltr" : undefined}>{row.value}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">العنوان الوطني</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {[
                  { label: "المدينة", value: company.city },
                  { label: "الحي", value: company.district || "-" },
                  { label: "الشارع والمبنى", value: `${company.street} - ${company.buildingNumber}` },
                  { label: "الرمز البريدي", value: company.postalCode, ltr: true },
                  { label: "الرقم الإضافي", value: company.additionalNumber || "-", ltr: true },
                ].map(row => (
                  <div key={row.label} className="flex justify-between items-center border-b pb-2 last:border-0">
                    <span className="text-muted-foreground">{row.label}:</span>
                    <span className="font-medium" dir={row.ltr ? "ltr" : undefined}>{row.value}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ─── ZATCA Integration Tab ────────────────────────────────── */}
        <TabsContent value="zatca" className="space-y-6">
          {/* Steps overview — 4 steps as per ZATCA onboarding */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            {[
              { n: 1, label: "المفتاح والإعدادات", desc: "مفتاح ECDSA + CSR", done: hasCsr, icon: "🔑" },
              { n: 2, label: "الشهادة الأولية", desc: "CSID عبر OTP", done: hasCsid, icon: "📜" },
              { n: 3, label: "الفواتير التجريبية", desc: "التحقق قبل الإنتاج", done: hasCsid, icon: "🧪" },
              { n: 4, label: "الشهادة النهائية", desc: "PCSID للإنتاج", done: hasPcsid, icon: "✅" },
            ].map(step => (
              <div key={step.n} className={`flex flex-col items-start gap-2 p-3 rounded-lg border ${step.done ? "bg-green-50 border-green-200" : "bg-card"}`}>
                <div className="flex items-center gap-2 w-full">
                  <StepBadge n={step.n} active={!step.done} done={step.done} />
                  <span className="text-lg">{step.icon}</span>
                </div>
                <div>
                  <p className="font-medium text-xs">{step.label}</p>
                  <p className="text-muted-foreground text-xs mt-0.5">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
          
          {/* ZATCA Portal Link */}
          <div className="flex items-start gap-3 p-3 rounded-lg bg-primary/5 border border-primary/20 text-sm">
            <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-primary">بوابة هيئة الزكاة والدخل والجمارك (ZATCA)</p>
              <p className="text-muted-foreground text-xs mt-1">
                جميع خطوات الربط تتم عبر بوابة فاتورة الرسمية. للحصول على OTP وإدارة الشهادات:
              </p>
              <div className="flex gap-3 mt-2 flex-wrap">
                <a href="https://fatoora.zatca.gov.sa" target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline font-medium">
                  <ExternalLink className="h-3 w-3" /> fatoora.zatca.gov.sa (الإنتاج)
                </a>
                <a href="https://fatoora.zatca.gov.sa/developer" target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline font-medium">
                  <ExternalLink className="h-3 w-3" /> بوابة المطورين (Sandbox)
                </a>
              </div>
            </div>
          </div>

          {/* Step 1: Generate CSR */}
          <Card className={hasCsr ? "border-green-200" : ""}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StepBadge n={1} active={!hasCsr} done={hasCsr} />
                  <div>
                    <CardTitle className="text-base">الخطوة 1 — توليد CSR</CardTitle>
                    <CardDescription>إنشاء مفتاح ECDSA secp256k1 وطلب الشهادة (Certificate Signing Request)</CardDescription>
                  </div>
                </div>
                <Button
                  variant={hasCsr ? "outline" : "default"}
                  size="sm"
                  className="gap-2"
                  onClick={handleGenerateCsr}
                  disabled={loading === "csr"}
                >
                  {loading === "csr" ? <><Loader2 className="h-4 w-4 animate-spin" />جاري التوليد...</> : <><Key className="h-4 w-4" />{hasCsr ? "إعادة التوليد" : "توليد CSR"}</>}
                </Button>
              </div>
            </CardHeader>
            {hasCsr && (
              <CardContent>
                <div className="flex items-center gap-2 mb-2 text-green-700">
                  <CheckCircle2 className="h-4 w-4" />
                  <span className="text-sm font-medium">تم توليد CSR بنجاح — المفتاح محفوظ بأمان في الخادم</span>
                </div>
                {csrContent && (
                  <div className="relative">
                    <pre className="bg-muted/50 rounded border p-3 text-xs font-mono overflow-auto max-h-32 text-left" dir="ltr">
                      {csrContent.substring(0, 300)}...
                    </pre>
                    <Button size="sm" variant="ghost" className="absolute top-1 left-1"
                      onClick={() => copyToClipboard(csrContent, "CSR", toast)}>
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                )}
              </CardContent>
            )}
          </Card>

          {/* Step 2: CSID */}
          <Card className={hasCsid ? "border-green-200" : ""}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <StepBadge n={2} active={hasCsr && !hasCsid} done={hasCsid} />
                <div>
                  <CardTitle className="text-base">الخطوة 2 — الحصول على CSID</CardTitle>
                  <CardDescription>أرسل CSR مع رمز OTP من بوابة ZATCA للحصول على شهادة التوافق</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {hasCsid ? (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-green-50 border border-green-200">
                  <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-green-800 text-sm">تم الحصول على CSID بنجاح</p>
                    <p className="text-xs text-green-700 mt-1 font-mono break-all">
                      {company.zatcaCsid?.substring(0, 60)}...
                    </p>
                    <Button size="sm" variant="ghost" className="mt-2 h-7 text-xs gap-1 text-green-700"
                      onClick={() => copyToClipboard(company.zatcaCsid ?? "", "CSID Token", toast)}>
                      <Copy className="h-3 w-3" /> نسخ CSID
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Explanation */}
                  <div className="flex gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
                    <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
                    <div className="space-y-1">
                      <p>ستحتاج إلى رمز OTP من البوابة الرسمية لهيئة الزكاة والدخل والجمارك لربط هذا الجهاز.</p>
                      <p className="text-xs text-blue-700">
                        الرمز يُرسَل إلى هاتف المسؤول المسجّل في البوابة ويصلح للاستخدام مرة واحدة فقط.
                      </p>
                    </div>
                  </div>

                  {/* CTA Button — opens dialog */}
                  <Button
                    onClick={() => setOtpDialogOpen(true)}
                    disabled={loading === "compliance"}
                    className="w-full gap-2 h-11 text-base"
                    size="lg"
                  >
                    <Smartphone className="h-5 w-5" />
                    ربط الجهاز عبر رمز التحقق OTP
                  </Button>

                  {!hasCsr && (
                    <p className="text-center text-xs text-amber-600 font-medium">
                      ⚠️ يجب توليد CSR في الخطوة الأولى أولاً قبل الربط
                    </p>
                  )}
                  {company.isSandbox && hasCsr && (
                    <p className="text-center text-xs text-muted-foreground">
                      🧪 بيئة الاختبار — الرمز التجريبي سيظهر داخل نافذة التحقق
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Step 3: الفواتير التجريبية — Compliance Check */}
          <Card className={!hasCsid ? "opacity-60" : complianceCheckResult?.success ? "border-green-200" : ""}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <StepBadge n={3} active={hasCsid && !hasPcsid} done={!!complianceCheckResult?.success} />
                <div>
                  <CardTitle className="text-base">الخطوة 3 — الفواتير التجريبية</CardTitle>
                  <CardDescription>
                    اختبر فاتورة مصدرة مقابل شهادة CSID للتأكد من التوافق قبل الانتقال للإنتاج
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {complianceCheckResult?.success ? (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-green-50 border border-green-200">
                  <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-green-800 text-sm">اجتاز فحص الامتثال بنجاح</p>
                    <p className="text-xs text-green-700 mt-1">{complianceCheckResult.message}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
                    <Info className="h-4 w-4 shrink-0 mt-0.5 text-blue-500" />
                    <div>
                      <p>أنشئ فاتورة وأصدرها أولاً، ثم أدخل معرّفها (ID) هنا لاختبارها.</p>
                      <p className="mt-1">يُتحقق ZATCA من صحة XML وتوقيع الشهادة قبل الإنتاج.</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="معرّف الفاتورة (ID) — مثال: 5"
                      value={testInvoiceId}
                      onChange={e => setTestInvoiceId(e.target.value)}
                      dir="ltr"
                      type="number"
                      min="1"
                      disabled={!hasCsid}
                      className="font-mono"
                    />
                    <Button
                      onClick={handleComplianceCheck}
                      disabled={!hasCsid || loading === "compliance-check" || !testInvoiceId}
                      variant="outline"
                      className="shrink-0 gap-2"
                    >
                      {loading === "compliance-check"
                        ? <><Loader2 className="h-4 w-4 animate-spin" />جاري الفحص...</>
                        : <><RefreshCw className="h-4 w-4" />فحص الفاتورة</>}
                    </Button>
                  </div>
                  {complianceCheckResult && !complianceCheckResult.success && (
                    <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">
                      <p className="font-medium">فشل الفحص: {complianceCheckResult.error}</p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Step 4: PCSID */}
          <Card className={hasPcsid ? "border-green-200" : !hasCsid ? "opacity-60" : ""}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StepBadge n={4} active={hasCsid && !hasPcsid} done={hasPcsid} />
                  <div>
                    <CardTitle className="text-base">الخطوة 4 — الشهادة النهائية PCSID</CardTitle>
                    <CardDescription>الشهادة الإنتاجية — تُفعَّل الفواتير الحقيقية بعد الحصول عليها</CardDescription>
                  </div>
                </div>
                {!hasPcsid && hasCsid && (
                  <Button
                    onClick={handleProductionCsid}
                    disabled={loading === "pcsid"}
                    className="gap-2"
                  >
                    {loading === "pcsid"
                      ? <><Loader2 className="h-4 w-4 animate-spin" />جاري الطلب...</>
                      : <><ShieldCheck className="h-4 w-4" />طلب PCSID</>
                    }
                  </Button>
                )}
              </div>
            </CardHeader>
            {hasPcsid && (
              <CardContent>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-green-50 border border-green-200">
                  <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-green-800 text-sm">الشركة مرتبطة بالكامل ببيئة {company.isSandbox ? "المحاكاة" : "الإنتاج"}</p>
                    <p className="text-xs text-green-700 mt-1 font-mono break-all">
                      {company.zatcaPcsid?.substring(0, 60)}...
                    </p>
                  </div>
                </div>
              </CardContent>
            )}
          </Card>
        </TabsContent>

        {/* ─── Serial Settings Tab ──────────────────────────────────── */}
        <TabsContent value="settings" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Fingerprint className="h-5 w-5 text-primary" />
                أرقام السيريال المميزة للجهاز
              </CardTitle>
              <CardDescription>هذه الأرقام تُستخدم في إنشاء CSR وربط الجهاز مع هيئة الزكاة</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="bg-muted/30 rounded-lg p-4 border font-mono text-sm break-all" dir="ltr">
                {company.serialNumber
                  ?? ((company.deviceSerial1)
                    ? `1-${company.deviceSerial1}|2-${company.deviceSerial2}|3-${company.deviceSerial3}`
                    : "غير محدد")}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4 text-sm">
                {[
                  { label: "الشركة المصنعة", value: (company as Record<string, unknown>).deviceSerial1 as string },
                  { label: "الموديل", value: (company as Record<string, unknown>).deviceSerial2 as string },
                  { label: "الرقم التسلسلي", value: (company as Record<string, unknown>).deviceSerial3 as string },
                ].map(item => item.value && (
                  <div key={item.label} className="p-3 rounded border bg-muted/20">
                    <p className="text-muted-foreground text-xs mb-1">{item.label}</p>
                    <p className="font-mono text-xs break-all" dir="ltr">{item.value}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── XML / QR Tab ────────────────────────────────────────── */}
        <TabsContent value="xml" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileCode2 className="h-5 w-5 text-primary" />
                QR Code (TLV) والـ XML
              </CardTitle>
              <CardDescription>
                QR Code بصيغة TLV (Tag-Length-Value) المطلوبة من ZATCA — يتولّد عند إصدار أي فاتورة
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="p-4 rounded-lg border bg-muted/20 text-sm text-muted-foreground text-center py-10 space-y-2">
                <FileCode2 className="h-8 w-8 mx-auto text-muted-foreground/50" />
                <p>اذهب لأي فاتورة مُصدرة لرؤية QR Code بصيغة TLV وXML UBL 2.1 الكامل.</p>
                <Button variant="outline" asChild className="mt-2">
                  <Link href={`/invoices?companyId=${company.id}`}>
                    عرض الفواتير
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">صيغة QR Code TLV — مثال</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-xs">
                {[
                  { tag: "1", name: "اسم البائع", example: company.nameAr },
                  { tag: "2", name: "الرقم الضريبي", example: company.vatNumber },
                  { tag: "3", name: "وقت الفاتورة", example: "2024-01-15T10:30:00+03:00" },
                  { tag: "4", name: "إجمالي الفاتورة مع ضريبة", example: "1150.00" },
                  { tag: "5", name: "مبلغ ضريبة القيمة المضافة", example: "150.00" },
                ].map(row => (
                  <div key={row.tag} className="flex items-start gap-3 p-2 rounded border bg-muted/20">
                    <span className="shrink-0 rounded bg-primary/10 text-primary px-1.5 py-0.5 font-bold font-mono">
                      Tag {row.tag}
                    </span>
                    <div className="min-w-0">
                      <p className="text-muted-foreground">{row.name}</p>
                      <p className="font-mono break-all" dir="ltr">{row.example}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* OTP Verification Dialog */}
      <ZatcaOtpDialog
        open={otpDialogOpen}
        onOpenChange={setOtpDialogOpen}
        companyName={company.nameAr ?? company.nameEn ?? ""}
        vatNumber={company.vatNumber ?? ""}
        isSandbox={!!company.isSandbox}
        hasCsr={hasCsr}
        loading={loading === "compliance"}
        onSubmit={(otp) => handleCompliance(otp)}
      />
    </div>
  );
}
