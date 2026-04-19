import { useState, useEffect, useRef } from "react";
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
  ShieldCheck, Key, CheckCircle2, Loader2, AlertTriangle,
  RefreshCw, Globe, Lock, FileText, Cpu, ChevronDown, ChevronUp,
  ExternalLink, Info, Zap, AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Types ────────────────────────────────────────────────────────────────────

interface DeviceForm {
  serialNumber: string;
  deviceSerial1: string;
  deviceSerial2: string;
  deviceSerial3: string;
  isSandbox: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Step card ────────────────────────────────────────────────────────────────

function StepCard({
  num, title, subtitle, status, children, defaultOpen,
}: {
  num: number; title: string; subtitle: string;
  status: "done" | "active" | "locked"; children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? status === "active");

  useEffect(() => {
    if (status === "active" && defaultOpen) setOpen(true);
  }, [status]);

  return (
    <div className={cn(
      "rounded-xl border transition-colors",
      status === "done"   ? "border-green-200 bg-green-50/30" :
      status === "active" ? "border-primary/40 bg-primary/5 shadow-sm" :
      "border-border bg-muted/20 opacity-60"
    )}>
      <button
        type="button"
        className="w-full flex items-center gap-4 px-5 py-4 text-right"
        onClick={() => status !== "locked" && setOpen(v => !v)}
        disabled={status === "locked"}
      >
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

// ─── Error alert ─────────────────────────────────────────────────────────────

function ErrorAlert({ message, details }: { message: string; details?: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 space-y-1">
      <p className="font-medium flex items-center gap-1.5">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {message}
      </p>
      {details && (
        <p className="text-xs font-mono text-red-600 break-all pr-5">{details}</p>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface ZatcaIntegrationProps {
  companyId?: number;
}

export default function ZatcaIntegration({ companyId: propCompanyId }: ZatcaIntegrationProps) {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const companyId = propCompanyId ?? user?.companyId;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token ?? ""}`,
    "Content-Type": "application/json",
  };

  // ── State
  const [otpOpen, setOtpOpen] = useState(false);
  const [complianceLoading, setComplianceLoading] = useState(false);
  const [form, setForm] = useState<DeviceForm | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [checkInvoiceId, setCheckInvoiceId] = useState("");
  const [checkResult, setCheckResult] = useState<any | null>(null);
  const [step1Error, setStep1Error] = useState<{ message: string; details?: string } | null>(null);
  const seeded = useRef(false);

  // ── Load company
  const { data: company, isLoading, refetch } = useQuery({
    queryKey: ["company-zatca", companyId],
    queryFn: async () => {
      if (!companyId) throw new Error("companyId غير محدد");
      const res = await fetch(`${API}/api/companies/${companyId}`, { headers });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "فشل تحميل بيانات الشركة");
      }
      return res.json();
    },
    enabled: !!companyId,
    retry: 1,
  });

  // Seed form from loaded company (only once)
  useEffect(() => {
    if (company && !seeded.current) {
      seeded.current = true;
      setForm({
        serialNumber: company.serialNumber ?? "",
        deviceSerial1: company.deviceSerial1 ?? "",
        deviceSerial2: company.deviceSerial2 ?? "",
        deviceSerial3: company.deviceSerial3 ?? "",
        isSandbox: company.isSandbox ?? true,
      });
    }
  }, [company]);

  function updateForm(patch: Partial<DeviceForm>) {
    setForm(prev => prev ? { ...prev, ...patch } : prev);
    setIsDirty(true);
  }

  // ── Validate form
  function validateForm(f: DeviceForm): string | null {
    if (!f.serialNumber.trim()) {
      return "الرقم التسلسلي للجهاز (Serial Number) مطلوب";
    }
    if (f.serialNumber.trim().length < 3) {
      return "الرقم التسلسلي قصير جداً — يجب أن يكون 3 أحرف على الأقل";
    }
    return null;
  }

  // ── Save device settings
  const saveDeviceMutation = useMutation({
    mutationFn: async (f: DeviceForm) => {
      const res = await fetch(`${API}/api/companies/${companyId}/zatca-settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(f),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "خطأ في الحفظ");
      return json;
    },
    onSuccess: () => {
      toast({ title: "✓ تم حفظ إعدادات الجهاز" });
      setIsDirty(false);
      qc.invalidateQueries({ queryKey: ["company-zatca", companyId] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // ── Generate CSR
  const generateCsrMutation = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error("لم يتم تحميل بيانات النموذج بعد");

      const validationError = validateForm(form);
      if (validationError) throw new Error(validationError);

      // Save settings first if dirty
      if (isDirty) {
        const saveRes = await fetch(`${API}/api/companies/${companyId}/zatca-settings`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(form),
        });
        const saveJson = await saveRes.json();
        if (!saveRes.ok) {
          throw new Error(saveJson.error ?? "فشل حفظ إعدادات الجهاز");
        }
      }

      const res = await fetch(`${API}/api/companies/${companyId}/generate-csr`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) {
        const err = new Error(json.error ?? "فشل توليد CSR") as any;
        err.details = json.details;
        throw err;
      }
      return json;
    },
    onSuccess: () => {
      setIsDirty(false);
      setStep1Error(null);
      toast({
        title: "✓ تم توليد CSR بنجاح",
        description: "الخطوة التالية: احصل على OTP من بوابة ZATCA",
      });
      qc.invalidateQueries({ queryKey: ["company-zatca", companyId] });
    },
    onError: (e: any) => {
      setStep1Error({ message: e.message, details: e.details });
      toast({ title: e.message, variant: "destructive" });
    },
  });

  // ── Submit compliance OTP
  async function handleOtpSubmit(otp: string) {
    setComplianceLoading(true);
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/compliance`, {
        method: "POST",
        headers,
        body: JSON.stringify({ otp }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "فشل الاتصال بـ ZATCA");
      toast({
        title: "✓ تم الحصول على CSID بنجاح",
        description: "الشركة مهيأة لإصدار الفواتير التجريبية",
      });
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
        method: "POST",
        headers,
        body: JSON.stringify({ invoiceId: parseInt(checkInvoiceId) }),
      });
      const json = await res.json();
      setCheckResult(json);
      if (!res.ok) throw new Error(json.error ?? "فشل الفحص");
      return json;
    },
    onSuccess: () => toast({
      title: "✓ نجح الفحص التجريبي",
      description: "الفاتورة صحيحة — يمكنك الانتقال للإنتاج",
    }),
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // ── Get Production CSID
  const productionCsidMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/companies/${companyId}/production-csid`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "فشل استخراج PCSID");
      return json;
    },
    onSuccess: () => {
      toast({
        title: "✓ تم الحصول على PCSID",
        description: "الشركة مرتبطة بالإنتاج بالكامل",
      });
      qc.invalidateQueries({ queryKey: ["company-zatca", companyId] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // ── Loading
  if (isLoading || !company) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!form) return null;

  const hasCsr   = !!company.zatcaCsr;
  const hasCsid  = !!company.zatcaCsidToken;
  const hasPcsid = !!company.zatcaPcsidToken;

  // Status uses form.isSandbox (reflects the user's current selection, not just DB state)
  const envLabel = form.isSandbox ? "اختبارية" : "إنتاج";

  const step1Status = hasCsr ? "done" : "active";
  const step2Status = !hasCsr ? "locked" : hasCsid ? "done" : "active";
  const step3Status: "active" | "locked" = !hasCsid ? "locked" : "active";
  const step4Status = !hasCsid ? "locked" : hasPcsid ? "done" : "active";

  return (
    <div className="space-y-6 pb-10 max-w-3xl mx-auto" dir="rtl">

      {/* ── Header */}
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
            { label: "البيئة", value: envLabel,                             ok: true,    icon: Globe },
            { label: "CSR",    value: hasCsr ? "مولَّد" : "لم يولَّد",     ok: hasCsr,  icon: Key },
            { label: "CSID",   value: hasCsid ? "مُستخرَج" : "لم يُستخرَج", ok: hasCsid, icon: ShieldCheck },
            { label: "PCSID",  value: hasPcsid ? "مُستخرَج" : "لم يُستخرَج", ok: hasPcsid, icon: Lock },
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

        {/* Step 1 — Device Config + CSR */}
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
                onCheckedChange={v => updateForm({ isSandbox: v })}
              />
            </div>

            {/* Serial fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2 space-y-1.5">
                <Label className="text-xs">
                  الرقم التسلسلي للجهاز (Serial Number)
                  <span className="text-red-500 mr-1">*</span>
                </Label>
                <Input
                  value={form.serialNumber}
                  onChange={e => updateForm({ serialNumber: e.target.value })}
                  placeholder="مثال: 1-TST|2-TAX|3-EGS"
                  dir="ltr"
                  className="h-9 font-mono text-sm"
                />
                <p className="text-[11px] text-muted-foreground">
                  يُستخدم كـ <span className="font-mono">Common Name</span> في شهادة SSL — مثال:{" "}
                  <span className="font-mono text-primary">1-TST|2-TAX|3-EGS</span>
                </p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Device Serial 1 <span className="font-normal">(اسم الحل البرمجي)</span>
                </Label>
                <Input
                  value={form.deviceSerial1}
                  dir="ltr"
                  className="h-9 font-mono text-sm"
                  placeholder="Solution Name"
                  onChange={e => updateForm({ deviceSerial1: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Device Serial 2 <span className="font-normal">(رقم الترخيص)</span>
                </Label>
                <Input
                  value={form.deviceSerial2}
                  dir="ltr"
                  className="h-9 font-mono text-sm"
                  placeholder="License Number"
                  onChange={e => updateForm({ deviceSerial2: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2 space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Device Serial 3 <span className="font-normal">(المعرف الفريد / UUID)</span>
                </Label>
                <Input
                  value={form.deviceSerial3}
                  dir="ltr"
                  className="h-9 font-mono text-sm"
                  placeholder="UUID or Device ID"
                  onChange={e => updateForm({ deviceSerial3: e.target.value })}
                />
              </div>
            </div>

            {/* Inline validation error */}
            {step1Error && <ErrorAlert message={step1Error.message} details={step1Error.details} />}

            {/* Dirty warning */}
            {isDirty && !step1Error && (
              <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                يوجد تغييرات غير محفوظة — ستُحفظ تلقائياً عند توليد CSR
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-2"
                disabled={saveDeviceMutation.isPending || !isDirty}
                onClick={() => saveDeviceMutation.mutate(form)}
              >
                {saveDeviceMutation.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Cpu className="h-3.5 w-3.5" />
                }
                حفظ الإعدادات
              </Button>
              <Button
                type="button"
                size="sm"
                className="gap-2"
                disabled={generateCsrMutation.isPending}
                onClick={() => {
                  setStep1Error(null);
                  generateCsrMutation.mutate();
                }}
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

        {/* Step 2 — Compliance CSID */}
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
                type="button"
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

        {/* Step 3 — Compliance Check */}
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
                type="button"
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
                checkResult.success
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-red-50 border-red-200 text-red-800"
              )}>
                <p className="font-medium flex items-center gap-1.5">
                  {checkResult.success
                    ? <CheckCircle2 className="h-4 w-4 shrink-0" />
                    : <AlertCircle className="h-4 w-4 shrink-0" />
                  }
                  {checkResult.success ? "نجح الفحص التجريبي" : "فشل الفحص التجريبي"}
                </p>
                {checkResult.validationResults?.errorMessages?.length > 0 && (
                  <ul className="list-disc list-inside text-xs space-y-0.5 pr-1">
                    {checkResult.validationResults.errorMessages.map((m: any, i: number) => (
                      <li key={i}>{m.message} <span className="opacity-60">({m.code})</span></li>
                    ))}
                  </ul>
                )}
                {checkResult.hint && (
                  <p className="text-xs opacity-80">{checkResult.hint}</p>
                )}
              </div>
            )}
          </div>
        </StepCard>

        {/* Step 4 — Production CSID */}
        <StepCard
          num={4}
          title="شهادة الإنتاج (PCSID)"
          subtitle="احصل على شهادة الإنتاج لبدء إرسال الفواتير الرسمية لـ ZATCA"
          status={step4Status}
          defaultOpen={hasCsid && !hasPcsid}
        >
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-800 flex gap-2">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                بعد الحصول على PCSID، ستُرسَل جميع الفواتير الجديدة تلقائياً لـ ZATCA.
                تأكد من اجتياز الفحص التجريبي أولاً.
              </span>
            </div>

            {hasPcsid ? (
              <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                تم استخراج شهادة الإنتاج PCSID بنجاح — الشركة مرتبطة بالكامل
              </div>
            ) : (
              <Button
                type="button"
                className="gap-2"
                disabled={productionCsidMutation.isPending || !hasCsid}
                onClick={() => productionCsidMutation.mutate()}
              >
                {productionCsidMutation.isPending
                  ? <><Loader2 className="h-4 w-4 animate-spin" />جاري الاستخراج...</>
                  : <><Lock className="h-4 w-4" />استخراج شهادة الإنتاج</>
                }
              </Button>
            )}
          </div>
        </StepCard>
      </div>

      {/* OTP Dialog */}
      <ZatcaOtpDialog
        open={otpOpen}
        onOpenChange={v => { if (!v) setOtpOpen(false); }}
        onSubmit={handleOtpSubmit}
        loading={complianceLoading}
        companyName={company.nameAr ?? ""}
        vatNumber={company.vatNumber ?? ""}
        isSandbox={form.isSandbox}
        hasCsr={hasCsr}
      />
    </div>
  );
}
