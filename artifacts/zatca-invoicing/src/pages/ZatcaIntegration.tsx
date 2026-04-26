import { useState, useEffect, useRef } from "react";
import { useTranslation, Trans } from "react-i18next";
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
  ExternalLink, Info, Zap, AlertCircle, Wand2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface DeviceForm {
  serialNumber: string;
  deviceSerial1: string;
  deviceSerial2: string;
  deviceSerial3: string;
  isSandbox: boolean;
}

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

function StepCard({
  num, title, subtitle, status, children, defaultOpen, completedLabel,
}: {
  num: number; title: string; subtitle: string;
  status: "done" | "active" | "locked"; children: React.ReactNode;
  defaultOpen?: boolean;
  completedLabel: string;
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
            <Badge className="text-xs bg-green-100 text-green-700 border-green-200 border">{completedLabel}</Badge>
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

interface ZatcaIntegrationProps {
  companyId?: number;
}

export default function ZatcaIntegration({ companyId: propCompanyId }: ZatcaIntegrationProps) {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { t } = useTranslation();

  const companyId = propCompanyId ?? user?.companyId;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token ?? ""}`,
    "Content-Type": "application/json",
  };

  const [otpOpen, setOtpOpen] = useState(false);
  const [complianceLoading, setComplianceLoading] = useState(false);
  const [form, setForm] = useState<DeviceForm | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [checkInvoiceId, setCheckInvoiceId] = useState("");
  const [checkResult, setCheckResult] = useState<any | null>(null);
  const [step1Error, setStep1Error] = useState<{ message: string; details?: string } | null>(null);
  const seeded = useRef(false);

  const { data: company, isLoading, refetch } = useQuery({
    queryKey: ["company-zatca", companyId],
    queryFn: async () => {
      if (!companyId) throw new Error(t("zatcaIntegration.companyIdMissing"));
      const res = await fetch(`${API}/api/companies/${companyId}`, { headers });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? t("zatcaIntegration.loadCompanyError"));
      }
      return res.json();
    },
    enabled: !!companyId,
    retry: 1,
  });

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

  function autoFill() {
    if (!company) return;

    const uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });

    const rawName = (company.nameEn ?? company.nameAr ?? "").replace(/[^a-zA-Z0-9\-]/g, "").slice(0, 20) || "ZATCA-EGS";
    const d1 = rawName;
    const d2 = `LIC-${String(company.id).padStart(6, "0")}`;
    const d3 = uuid.split("-")[0].toUpperCase();
    const serial = `1-${d1}|2-${d2}|3-${d3}`;

    setForm(prev => prev ? {
      ...prev,
      deviceSerial1: d1,
      deviceSerial2: d2,
      deviceSerial3: d3,
      serialNumber: serial,
    } : prev);
    setIsDirty(true);
    setStep1Error(null);
    toast({ title: t("zatcaIntegration.autoFillSuccess") });
  }

  function validateForm(f: DeviceForm): string | null {
    if (!f.serialNumber.trim()) {
      return t("zatcaIntegration.errSerialRequired");
    }
    if (f.serialNumber.trim().length < 3) {
      return t("zatcaIntegration.errSerialTooShort");
    }
    return null;
  }

  const saveDeviceMutation = useMutation({
    mutationFn: async (f: DeviceForm) => {
      const res = await fetch(`${API}/api/companies/${companyId}/zatca-settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(f),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? t("zatcaIntegration.errSaveFailed"));
      return json;
    },
    onSuccess: () => {
      toast({ title: t("zatcaIntegration.settingsSaved") });
      setIsDirty(false);
      qc.invalidateQueries({ queryKey: ["company-zatca", companyId] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const generateCsrMutation = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error(t("zatcaIntegration.formNotLoaded"));

      const validationError = validateForm(form);
      if (validationError) throw new Error(validationError);

      if (isDirty) {
        const saveRes = await fetch(`${API}/api/companies/${companyId}/zatca-settings`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(form),
        });
        const saveJson = await saveRes.json();
        if (!saveRes.ok) {
          throw new Error(saveJson.error ?? t("zatcaIntegration.errSettingsSaveFailed"));
        }
      }

      const res = await fetch(`${API}/api/companies/${companyId}/generate-csr`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) {
        const err = new Error(json.error ?? t("zatcaIntegration.errCsrFailed")) as any;
        err.details = json.details;
        throw err;
      }
      return json;
    },
    onSuccess: () => {
      setIsDirty(false);
      setStep1Error(null);
      toast({
        title: t("zatcaIntegration.csrSuccessTitle"),
        description: t("zatcaIntegration.csrSuccessDesc"),
      });
      qc.invalidateQueries({ queryKey: ["company-zatca", companyId] });
    },
    onError: (e: any) => {
      setStep1Error({ message: e.message, details: e.details });
      toast({ title: e.message, variant: "destructive" });
    },
  });

  async function handleOtpSubmit(otp: string) {
    setComplianceLoading(true);
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/compliance`, {
        method: "POST",
        headers,
        body: JSON.stringify({ otp }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? t("zatcaIntegration.errOtpFailed"));
      toast({
        title: t("zatcaIntegration.csidSuccessTitle"),
        description: t("zatcaIntegration.csidSuccessDesc"),
      });
      setOtpOpen(false);
      qc.invalidateQueries({ queryKey: ["company-zatca", companyId] });
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    } finally {
      setComplianceLoading(false);
    }
  }

  const complianceCheckMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/companies/${companyId}/compliance-check`, {
        method: "POST",
        headers,
        body: JSON.stringify({ invoiceId: parseInt(checkInvoiceId) }),
      });
      const json = await res.json();
      setCheckResult(json);
      if (!res.ok) throw new Error(json.error ?? t("zatcaIntegration.errCheckFailed"));
      return json;
    },
    onSuccess: () => toast({
      title: t("zatcaIntegration.checkSuccessTitle"),
      description: t("zatcaIntegration.checkSuccessDesc"),
    }),
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const productionCsidMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/companies/${companyId}/production-csid`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? t("zatcaIntegration.errPcsidFailed"));
      return json;
    },
    onSuccess: () => {
      toast({
        title: t("zatcaIntegration.pcsidSuccessTitle"),
        description: t("zatcaIntegration.pcsidSuccessDesc"),
      });
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

  if (!form) return null;

  const hasCsr   = !!company.zatcaCsr;
  const hasCsid  = !!company.zatcaCsidToken;
  const hasPcsid = !!company.zatcaPcsidToken;

  const envLabel = form.isSandbox ? t("zatcaIntegration.envSandbox") : t("zatcaIntegration.envProd");

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
            <h1 className="text-xl font-bold">{t("zatcaIntegration.title")}</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("zatcaIntegration.subtitle")}
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5" />{t("zatcaIntegration.refresh")}
        </Button>
      </div>

      {/* ── Status Overview */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-semibold text-sm flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />{t("zatcaIntegration.currentStatus")}
          </h2>
          <Badge className={cn("text-xs border font-medium",
            hasPcsid  ? "bg-green-100 text-green-800 border-green-300" :
            hasCsid   ? "bg-blue-100 text-blue-800 border-blue-300" :
            hasCsr    ? "bg-amber-100 text-amber-800 border-amber-300" :
            "bg-muted text-muted-foreground border-border"
          )}>
            {hasPcsid ? t("zatcaIntegration.statusProdLinked")
              : hasCsid ? t("zatcaIntegration.statusSandboxLinked")
              : hasCsr ? t("zatcaIntegration.statusCsrReady")
              : t("zatcaIntegration.statusNotLinked")}
          </Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: t("zatcaIntegration.envLabel"), value: envLabel,                                                          ok: true,    icon: Globe },
            { label: t("zatcaIntegration.csr"),      value: hasCsr ? t("zatcaIntegration.generated") : t("zatcaIntegration.notGenerated"),  ok: hasCsr,  icon: Key },
            { label: t("zatcaIntegration.csid"),     value: hasCsid ? t("zatcaIntegration.extracted") : t("zatcaIntegration.notExtracted"), ok: hasCsid, icon: ShieldCheck },
            { label: t("zatcaIntegration.pcsid"),    value: hasPcsid ? t("zatcaIntegration.extracted") : t("zatcaIntegration.notExtracted"),ok: hasPcsid,icon: Lock },
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
              <span className="text-muted-foreground">{t("zatcaIntegration.csidEncrypted")}</span>
              <span className="font-mono text-muted-foreground" dir="ltr">{mask(company.zatcaCsidToken)}</span>
            </div>
            {hasPcsid && (
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">{t("zatcaIntegration.pcsidEncrypted")}</span>
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
          title={t("zatcaIntegration.step1Title")}
          subtitle={t("zatcaIntegration.step1Subtitle")}
          status={step1Status}
          defaultOpen={!hasCsr}
          completedLabel={t("zatcaIntegration.completedBadge")}
        >
          <div className="space-y-4">
            {/* Sandbox toggle */}
            <div className="flex items-center justify-between p-3 rounded-lg border bg-background">
              <div>
                <p className="text-sm font-medium">{t("zatcaIntegration.sandboxToggleTitle")}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("zatcaIntegration.sandboxToggleDesc")}
                </p>
              </div>
              <Switch
                checked={form.isSandbox}
                onCheckedChange={v => updateForm({ isSandbox: v })}
              />
            </div>

            {/* Serial fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2 flex items-center justify-between gap-2">
                <Label className="text-xs">
                  {t("zatcaIntegration.serialLabel")}
                  <span className="text-red-500 mr-1">*</span>
                </Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs h-7 px-2.5 border-dashed border-primary/40 text-primary hover:bg-primary/5"
                  onClick={autoFill}
                >
                  <Wand2 className="h-3 w-3" />
                  {t("zatcaIntegration.autoFill")}
                </Button>
              </div>
              <div className="sm:col-span-2 space-y-1.5">
                <Input
                  value={form.serialNumber}
                  onChange={e => updateForm({ serialNumber: e.target.value })}
                  placeholder={t("zatcaIntegration.serialPlaceholder")}
                  dir="ltr"
                  className="h-9 font-mono text-sm"
                />
                <p className="text-[11px] text-muted-foreground">
                  <Trans
                    i18nKey="zatcaIntegration.serialHint"
                    components={[
                      <span key="cn" className="font-mono" />,
                      <span key="ex" className="font-mono text-primary" />,
                    ]}
                  />
                </p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t("zatcaIntegration.ds1Label")} <span className="font-normal">{t("zatcaIntegration.ds1Hint")}</span>
                </Label>
                <Input
                  value={form.deviceSerial1}
                  dir="ltr"
                  className="h-9 font-mono text-sm"
                  placeholder={t("zatcaIntegration.ds1Placeholder")}
                  onChange={e => updateForm({ deviceSerial1: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t("zatcaIntegration.ds2Label")} <span className="font-normal">{t("zatcaIntegration.ds2Hint")}</span>
                </Label>
                <Input
                  value={form.deviceSerial2}
                  dir="ltr"
                  className="h-9 font-mono text-sm"
                  placeholder={t("zatcaIntegration.ds2Placeholder")}
                  onChange={e => updateForm({ deviceSerial2: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2 space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t("zatcaIntegration.ds3Label")} <span className="font-normal">{t("zatcaIntegration.ds3Hint")}</span>
                </Label>
                <Input
                  value={form.deviceSerial3}
                  dir="ltr"
                  className="h-9 font-mono text-sm"
                  placeholder={t("zatcaIntegration.ds3Placeholder")}
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
                {t("zatcaIntegration.dirtyWarning")}
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
                {t("zatcaIntegration.saveSettings")}
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
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("zatcaIntegration.generating")}</>
                  : <><Key className="h-3.5 w-3.5" />{hasCsr ? t("zatcaIntegration.regenerateCsr") : t("zatcaIntegration.generateCsr")}</>
                }
              </Button>
            </div>

            {hasCsr && (
              <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                {t("zatcaIntegration.csrSuccessInline")}
              </div>
            )}
          </div>
        </StepCard>

        {/* Step 2 — Compliance CSID */}
        <StepCard
          num={2}
          title={t("zatcaIntegration.step2Title")}
          subtitle={t("zatcaIntegration.step2Subtitle")}
          status={step2Status}
          defaultOpen={hasCsr && !hasCsid}
          completedLabel={t("zatcaIntegration.completedBadge")}
        >
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-background border space-y-3 text-sm">
              <p className="font-medium flex items-center gap-2">
                <Globe className="h-4 w-4 text-primary shrink-0" />
                {t("zatcaIntegration.otpStepsTitle")}
              </p>
              <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground text-xs pr-1">
                <li>
                  <Trans
                    i18nKey="zatcaIntegration.otpStep1"
                    components={[<span key="url" className="font-mono text-primary" />]}
                  />
                </li>
                <li>{t("zatcaIntegration.otpStep2")}</li>
                <li>
                  <Trans
                    i18nKey="zatcaIntegration.otpStep3"
                    components={{ strong: <strong /> }}
                  />
                </li>
                <li>{t("zatcaIntegration.otpStep4")}</li>
              </ol>
              <a
                href="https://fatoora.zatca.gov.sa"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t("zatcaIntegration.openZatcaPortal")}
              </a>
            </div>

            {hasCsid ? (
              <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                {t("zatcaIntegration.csidExtractedSuccess")}
              </div>
            ) : (
              <Button
                type="button"
                className="gap-2"
                onClick={() => setOtpOpen(true)}
                disabled={!hasCsr}
              >
                <ShieldCheck className="h-4 w-4" />
                {t("zatcaIntegration.enterOtpButton")}
              </Button>
            )}
          </div>
        </StepCard>

        {/* Step 3 — Compliance Check */}
        <StepCard
          num={3}
          title={t("zatcaIntegration.step3Title")}
          subtitle={t("zatcaIntegration.step3Subtitle")}
          status={step3Status}
          defaultOpen={hasCsid && !hasPcsid}
          completedLabel={t("zatcaIntegration.completedBadge")}
        >
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex gap-2">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{t("zatcaIntegration.step3Hint")}</span>
            </div>
            <div className="flex gap-2">
              <Input
                value={checkInvoiceId}
                onChange={e => setCheckInvoiceId(e.target.value)}
                placeholder={t("zatcaIntegration.invoiceIdPlaceholder")}
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
                {t("zatcaIntegration.runCheck")}
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
                  {checkResult.success ? t("zatcaIntegration.checkSuccess") : t("zatcaIntegration.checkFailed")}
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
          title={t("zatcaIntegration.step4Title")}
          subtitle={t("zatcaIntegration.step4Subtitle")}
          status={step4Status}
          defaultOpen={hasCsid && !hasPcsid}
          completedLabel={t("zatcaIntegration.completedBadge")}
        >
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-800 flex gap-2">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{t("zatcaIntegration.step4Hint")}</span>
            </div>

            {hasPcsid ? (
              <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                {t("zatcaIntegration.pcsidExtractedSuccess")}
              </div>
            ) : (
              <Button
                type="button"
                className="gap-2"
                disabled={productionCsidMutation.isPending || !hasCsid}
                onClick={() => productionCsidMutation.mutate()}
              >
                {productionCsidMutation.isPending
                  ? <><Loader2 className="h-4 w-4 animate-spin" />{t("zatcaIntegration.extracting")}</>
                  : <><Lock className="h-4 w-4" />{t("zatcaIntegration.extractPcsid")}</>
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
