import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import ZatcaOtpDialog from "@/components/ZatcaOtpDialog";
import {
  ShieldCheck, Key, CheckCircle2, XCircle, Loader2, AlertTriangle,
  RefreshCw, Globe, Lock, FileText, Cpu, ChevronDown, ChevronUp,
  Copy, ExternalLink, Info, Zap
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Status helpers ─────────────────────────────────────────────────────────

function mask(val: string | null | undefined): string {
  if (!val) return "—";
  if (val.length <= 20) return val;
  return val.slice(0, 10) + "••••••" + val.slice(-6);
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={cn(
      "inline-flex h-2.5 w-2.5 rounded-full shrink-0",
      ok ? "bg-green-500" : "bg-muted-foreground/40"
    )} />
  );
}

// ─── Step wrapper ─────────────────────────────────────────────────────────────

function StepCard({
  num, title, subtitle, status, children, defaultOpen
}: {
  num: number; title: string; subtitle: string;
  status: "done" | "active" | "locked"; children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? status === "active");

  return (
    <div className={cn(
      "rounded-xl border transition-colors",
      status === "done"   ? "border-green-200 bg-green-50/30" :
      status === "active" ? "border-primary/40 bg-primary/5 shadow-sm" :
      "border-border bg-muted/20 opacity-70"
    )}>
      <button
        className="w-full flex items-center gap-4 px-5 py-4 text-right"
        onClick={() => status !== "locked" && setOpen(v => !v)}
        disabled={status === "locked"}
      >
        {/* Step number bubble */}
        <div className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-bold text-sm border-2",
          status === "done"   ? "bg-green-500 text-white border-green-500" :
          status === "active" ? "bg-primary text-primary-foreground border-primary" :
          "bg-muted text-muted-foreground border-muted-foreground/30"
        )}>
          {status === "done" ? <CheckCircle2 className="h-5 w-5" /> : num}
        </div>
        <div className="flex-1 text-right min-w-0">
          <p className="font-semibold text-sm">{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {status === "done" && (
            <Badge className="text-xs bg-green-100 text-green-700 border-green-200 border">مكتمل</Badge>
          )}
          {status !== "locked" && (open
            ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
          {status === "locked" && <Lock className="h-4 w-4 text-muted-foreground/50" />}
        </div>
      </button>
      {open && status !== "locked" && (
        <div className="px-5 pb-5 border-t border-dashed border-border/50 pt-4">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

interface ZatcaIntegrationProps {
  companyId?: number;
}

export default function ZatcaIntegration({ companyId: propCompanyId }: ZatcaIntegrationProps) {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const companyId = propCompanyId ?? user?.companyId;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // ── OTP dialog state
  const [otpOpen, setOtpOpen] = useState(false);
  const [complianceLoading, setComplianceLoading] = useState(false);

  // ── Device form state
  const [deviceForm, setDeviceForm] = useState<{
    serialNumber: string; deviceSerial1: string; deviceSerial2: string; deviceSerial3: string; isSandbox: boolean;
  } | null>(null);
  const [deviceSaved, setDeviceSaved] = useState(false);

  // ── Compliance check state
  const [checkInvoiceId, setCheckInvoiceId] = useState("");
  const [checkResult, setCheckResult] = useState<any | null>(null);

  // ── Load company
  const { data: company, isLoading, refetch } = useQuery({
    queryKey: ["company-zatca", companyId],
    queryFn: async () => {
      const res = await fetch(`${API}/api/companies/${companyId}`, { headers });
      if (!res.ok) throw new Error("فشل تحميل بيانات الشركة");
      return res.json();
    },
    enabled: !!companyId,
  });

  // Seed form from loaded company (once)
  useEffect(() => {
    if (company && !deviceForm) {
      setDeviceForm({
        serialNumber: company.serialNumber ?? "",
        deviceSerial1: company.deviceSerial1 ?? "",
        deviceSerial2: company.deviceSerial2 ?? "",
        deviceSerial3: company.deviceSerial3 ?? "",
        isSandbox: company.isSandbox ?? true,
      });
    }
  }, [company]);

  // ── Save device settings
  const saveDeviceMutation = useMutation({
    mutationFn: async (form: typeof deviceForm) => {
      const res = await fetch(`${API}/api/companies/${companyId}/zatca-settings`, {
        method: "PATCH", headers, body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "خطأ في الحفظ");
      return json;
    },
    onSuccess: () => {
      toast({ title: "✓ تم حفظ إعدادات الجهاز" });
      setDeviceSaved(true);
      qc.invalidateQueries({ queryKey: ["company-zatca", companyId] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // ── Generate CSR (auto-saves device settings first)
  const generateCsrMutation = useMutation({
    mutationFn: async () => {
      // Auto-save device settings before generating
      if (form && !deviceSaved) {
        const saveRes = await fetch(`${API}/api/companies/${companyId}/zatca-settings`, {
          method: "PATCH", headers, body: JSON.stringify(form),
        });
        if (!saveRes.ok) throw new Error("فشل حفظ إعدادات الجهاز");
        setDeviceSaved(true);
      }
      const res = await fetch(`${API}/api/companies/${companyId}/generate-csr`, {
        method: "POST", headers, body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "فشل توليد CSR");
      return json;
    },
    onSuccess: () => {
      toast({ title: "✓ تم توليد CSR بنجاح", description: "الخطوة التالية: احصل على OTP من بوابة ZATCA" });
      qc.invalidateQueries({ queryKey: ["company-zatca", companyId] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // ── Submit compliance OTP
  async function handleOtpSubmit(otp: string) {
    setComplianceLoading(true);
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/compliance`, {
        method: "POST", headers, body: JSON.stringify({ otp }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "فشل الاتصال بـ ZATCA");
      toast({ title: "✓ تم الحصول على CSID بنجاح", description: "الشركة مهيأة لإصدار الفواتير التجريبية" });
      setOtpOpen(false);
      qc.invalidateQueries({ queryKey: ["company-zatca", companyId] });
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    } finally {
      setComplianceLoading(false);
    }
  }

  // ── Compliance check
  const complianceCheckMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/companies/${companyId}/compliance-check`, {
        method: "POST", headers, body: JSON.stringify({ invoiceId: parseInt(checkInvoiceId) }),
      });
      const json = await res.json();
      setCheckResult(json);
      if (!res.ok) throw new Error(json.error ?? "فشل الفحص");
      return json;
    },
    onSuccess: () => toast({ title: "✓ نجح الفحص التجريبي", description: "الفاتورة صحيحة — يمكنك الانتقال للإنتاج" }),
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // ── Get Production CSID
  const productionCsidMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/companies/${companyId}/production-csid`, {
        method: "POST", headers, body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "فشل استخراج PCSID");
      return json;
    },
    onSuccess: () => {
      toast({ title: "✓ تم الحصول على PCSID", description: "الشركة مرتبطة بالإنتاج بالكامل" });
      qc.invalidateQueries({ queryKey: ["company-zatca", companyId] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  if (isLoading || !company) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasCsr    = !!company.zatcaCsr;
  const hasCsid   = !!company.zatcaCsidToken;
  const hasPcsid  = !!company.zatcaPcsidToken;
  const isSandbox = company.isSandbox ?? true;

  // Determine step statuses
  const step1Status = hasCsr ? "done" : "active";
  const step2Status = !hasCsr ? "locked" : hasCsid ? "done" : "active";
  const step3Status = !hasCsid ? "locked" : "active";
  const step4Status = !hasCsid ? "locked" : hasPcsid ? "done" : "active";

  const form = deviceForm ?? {
    serialNumber: company.serialNumber ?? "",
    deviceSerial1: company.deviceSerial1 ?? "",
    deviceSerial2: company.deviceSerial2 ?? "",
    deviceSerial3: company.deviceSerial3 ?? "",
    isSandbox: company.isSandbox ?? true,
  };

  return (
    <div className="space-y-6 pb-10 max-w-3xl mx-auto" dir="rtl">

      {/* ── Page Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-bold">ربط هيئة الزكاة والدخل (ZATCA)</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            ربط منظومة الفاتورة الإلكترونية بخدمات FATOORA وفق متطلبات المرحلة الثانية
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5" />تحديث
        </Button>
      </div>

      {/* ── Status Overview */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-semibold text-sm flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />حالة الربط الحالية
          </h2>
          <Badge className={cn("text-xs border font-medium",
            hasPcsid  ? "bg-green-100 text-green-800 border-green-300" :
            hasCsid   ? "bg-blue-100 text-blue-800 border-blue-300" :
            hasCsr    ? "bg-amber-100 text-amber-800 border-amber-300" :
            "bg-muted text-muted-foreground border-border"
          )}>
            {hasPcsid ? "مرتبط بالإنتاج" : hasCsid ? "مرتبط بالاختبار" : hasCsr ? "CSR جاهز" : "غير مرتبط"}
          </Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "البيئة",    value: isSandbox ? "اختبارية" : "إنتاج",   ok: true,    icon: Globe },
            { label: "CSR",       value: hasCsr ? "مولَّد"  : "لم يولَّد",  ok: hasCsr,  icon: Key },
            { label: "CSID",      value: hasCsid ? "مُستخرَج" : "لم يُستخرَج", ok: hasCsid, icon: ShieldCheck },
            { label: "PCSID",     value: hasPcsid ? "مُستخرَج" : "لم يُستخرَج", ok: hasPcsid, icon: Lock },
          ].map(({ label, value, ok, icon: Icon }) => (
            <div key={label} className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border">
              <StatusDot ok={ok} />
              <div className="min-w-0">
                <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">{label}</p>
                <p className="text-xs font-medium mt-0.5 truncate">{value}</p>
              </div>
            </div>
          ))}
        </div>

        {hasCsid && (
          <div className="space-y-1.5 border-t pt-3">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">CSID (مُشفَّر)</span>
              <span className="font-mono text-muted-foreground" dir="ltr">{mask(company.zatcaCsidToken)}</span>
            </div>
            {hasPcsid && (
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">PCSID (مُشفَّر)</span>
                <span className="font-mono text-muted-foreground" dir="ltr">{mask(company.zatcaPcsidToken)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Steps */}
      <div className="space-y-3">

        {/* Step 1: Device Config + CSR */}
        <StepCard
          num={1}
          title="إعداد الجهاز وتوليد CSR"
          subtitle="حدّد رقم الجهاز والبيئة، ثم ولِّد مفتاح ECDSA وطلب الشهادة"
          status={step1Status}
          defaultOpen={!hasCsr}
        >
          <div className="space-y-4">
            {/* Sandbox toggle */}
            <div className="flex items-center justify-between p-3 rounded-lg border bg-background">
              <div>
                <p className="text-sm font-medium">بيئة الاختبار (Sandbox)</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  فعّل هذا الخيار أثناء الاختبار. أوقفه عند الانتقال للإنتاج.
                </p>
              </div>
              <Switch
                checked={form.isSandbox}
                onCheckedChange={v => {
                  setDeviceForm(f => ({ ...(f!), isSandbox: v }));
                  setDeviceSaved(false);
                }}
              />
            </div>

            {/* Serial numbers */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2 space-y-1.5">
                <Label className="text-xs">الرقم التسلسلي للجهاز (Serial Number)</Label>
                <Input
                  value={form.serialNumber}
                  onChange={e => { setDeviceForm(f => ({ ...(f!), serialNumber: e.target.value })); setDeviceSaved(false); }}
                  placeholder="1-Server|2-Node|3-مثال"
                  dir="ltr"
                  className="h-9 font-mono text-sm"
                />
                <p className="text-[11px] text-muted-foreground">
                  مثال: <span className="font-mono">1-TST|2-TAX|3-EGS</span> — يُستخدم كـ Common Name في شهادة SSL
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Device Serial 1 (اسم الحل)</Label>
                <Input value={form.deviceSerial1} dir="ltr" className="h-9 font-mono text-sm" placeholder="اسم الحل البرمجي"
                  onChange={e => { setDeviceForm(f => ({ ...(f!), deviceSerial1: e.target.value })); setDeviceSaved(false); }} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Device Serial 2 (رقم الترخيص)</Label>
                <Input value={form.deviceSerial2} dir="ltr" className="h-9 font-mono text-sm" placeholder="رقم ترخيص البرنامج"
                  onChange={e => { setDeviceForm(f => ({ ...(f!), deviceSerial2: e.target.value })); setDeviceSaved(false); }} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Device Serial 3 (المعرف الفريد)</Label>
                <Input value={form.deviceSerial3} dir="ltr" className="h-9 font-mono text-sm" placeholder="UUID أو رقم الجهاز"
                  onChange={e => { setDeviceForm(f => ({ ...(f!), deviceSerial3: e.target.value })); setDeviceSaved(false); }} />
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                disabled={saveDeviceMutation.isPending}
                onClick={() => saveDeviceMutation.mutate(form)}
              >
                {saveDeviceMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                حفظ الإعدادات
              </Button>
              <Button
                size="sm"
                className="gap-2"
                disabled={generateCsrMutation.isPending}
                onClick={() => generateCsrMutation.mutate()}
              >
                {generateCsrMutation.isPending
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />جاري التوليد...</>
                  : <><Key className="h-3.5 w-3.5" />{hasCsr ? "إعادة توليد CSR" : "توليد CSR"}</>
                }
              </Button>
            </div>

            {hasCsr && (
              <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                تم توليد CSR بنجاح. يمكنك الآن الانتقال للخطوة الثانية.
              </div>
            )}
          </div>
        </StepCard>

        {/* Step 2: Compliance CSID via OTP */}
        <StepCard
          num={2}
          title="شهادة الامتثال (CSID)"
          subtitle="احصل على OTP من بوابة ZATCA وأدخله للحصول على شهادة الامتثال"
          status={step2Status}
          defaultOpen={hasCsr && !hasCsid}
        >
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-background border space-y-3 text-sm">
              <p className="font-medium flex items-center gap-2">
                <Globe className="h-4 w-4 text-primary shrink-0" />
                خطوات الحصول على OTP من بوابة ZATCA:
              </p>
              <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground text-xs pr-1">
                <li>ادخل بوابة فاتورة ZATCA على <span className="font-mono text-primary">fatoora.zatca.gov.sa</span></li>
                <li>سجّل الدخول بحساب الشركة المعتمد</li>
                <li>انتقل إلى <strong>ربط الأجهزة</strong> ← <strong>إضافة جهاز</strong></li>
                <li>سيُرسَل رمز OTP مكوّن من 6 أرقام على الجوال المسجّل</li>
              </ol>
              <a
                href="https://fatoora.zatca.gov.sa"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                فتح بوابة ZATCA FATOORA
              </a>
            </div>

            {hasCsid ? (
              <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                تم استخراج شهادة الامتثال CSID بنجاح
              </div>
            ) : (
              <Button
                className="gap-2"
                onClick={() => setOtpOpen(true)}
                disabled={!hasCsr}
              >
                <ShieldCheck className="h-4 w-4" />
                إدخال OTP والربط بـ ZATCA
              </Button>
            )}
          </div>
        </StepCard>

        {/* Step 3: Compliance Check */}
        <StepCard
          num={3}
          title="الفحص التجريبي"
          subtitle="اختبر فاتورة تجريبية قبل الانتقال لبيئة الإنتاج (اختياري لكن يُنصح به)"
          status={step3Status}
          defaultOpen={hasCsid && !hasPcsid}
        >
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex gap-2">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>أدخل رقم فاتورة موجودة في النظام لاختبار الامتثال قبل الانتقال للإنتاج</span>
            </div>
            <div className="flex gap-2">
              <Input
                value={checkInvoiceId}
                onChange={e => setCheckInvoiceId(e.target.value)}
                placeholder="رقم معرف الفاتورة (Invoice ID)"
                type="number"
                dir="ltr"
                className="h-9 max-w-xs font-mono"
              />
              <Button
                size="sm"
                variant="outline"
                className="gap-2 whitespace-nowrap"
                disabled={!checkInvoiceId || complianceCheckMutation.isPending}
                onClick={() => complianceCheckMutation.mutate()}
              >
                {complianceCheckMutation.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <FileText className="h-3.5 w-3.5" />
                }
                فحص تجريبي
              </Button>
            </div>

            {checkResult && (
              <div className={cn(
                "rounded-lg border p-3 text-sm space-y-1",
                checkResult.success ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-800"
              )}>
                <p className="font-semibold flex items-center gap-2">
                  {checkResult.success
                    ? <><CheckCircle2 className="h-4 w-4" />نجح الفحص التجريبي</>
                    : <><XCircle className="h-4 w-4" />فشل الفحص — {checkResult.error}</>
                  }
                </p>
                {checkResult.validationResults?.warningMessages?.length > 0 && (
                  <p className="text-xs">تحذيرات: {checkResult.validationResults.warningMessages.length}</p>
                )}
              </div>
            )}
          </div>
        </StepCard>

        {/* Step 4: Production PCSID */}
        <StepCard
          num={4}
          title="شهادة الإنتاج (PCSID)"
          subtitle="احصل على شهادة الإنتاج لإصدار فواتير رسمية معتمدة من ZATCA"
          status={step4Status}
          defaultOpen={hasCsid && !hasPcsid}
        >
          <div className="space-y-4">
            {!isSandbox ? (
              <div className="p-3 rounded-lg bg-muted/50 border text-xs text-muted-foreground flex gap-2">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>
                  للحصول على PCSID يجب أن تكون في بيئة الاختبار (Sandbox). عند الانتقال للإنتاج،
                  تأكد من اجتياز الفحص التجريبي أولاً.
                </span>
              </div>
            ) : (
              <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-800 flex gap-2">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>
                  بعد الحصول على PCSID ستتمكن من إرسال الفواتير الرسمية لـ ZATCA مباشرةً. تأكد من اجتياز الفحص التجريبي أولاً.
                </span>
              </div>
            )}

            {hasPcsid ? (
              <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                تم استخراج PCSID — الشركة مرتبطة بالكامل ببيئة الإنتاج
              </div>
            ) : (
              <Button
                className="gap-2"
                disabled={productionCsidMutation.isPending || !hasCsid}
                onClick={() => productionCsidMutation.mutate()}
              >
                {productionCsidMutation.isPending
                  ? <><Loader2 className="h-4 w-4 animate-spin" />جاري الاستخراج...</>
                  : <><Cpu className="h-4 w-4" />استخراج PCSID</>
                }
              </Button>
            )}
          </div>
        </StepCard>
      </div>

      {/* ── Completion Banner */}
      {hasPcsid && (
        <div className="rounded-xl border-2 border-green-300 bg-green-50 p-5 flex items-start gap-4">
          <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center shrink-0">
            <CheckCircle2 className="h-7 w-7 text-green-600" />
          </div>
          <div>
            <p className="font-bold text-green-800 text-base">اكتمل الربط مع هيئة الزكاة والدخل!</p>
            <p className="text-sm text-green-700 mt-1">
              الشركة مهيأة بالكامل لإصدار الفواتير الإلكترونية المعتمدة وفق متطلبات المرحلة الثانية من FATOORA.
            </p>
          </div>
        </div>
      )}

      {/* OTP Dialog */}
      <ZatcaOtpDialog
        open={otpOpen}
        onOpenChange={setOtpOpen}
        companyName={company.nameAr ?? ""}
        vatNumber={company.vatNumber ?? ""}
        isSandbox={isSandbox}
        hasCsr={hasCsr}
        loading={complianceLoading}
        onSubmit={handleOtpSubmit}
      />
    </div>
  );
}
