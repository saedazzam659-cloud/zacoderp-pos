import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { usePermission } from "@/hooks/usePermission";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  Building2,
  Check,
  ChevronDown,
  Clock3,
  FileKey2,
  History,
  KeyRound,
  Loader2,
  LockKeyhole,
  Save,
  ShieldCheck,
} from "lucide-react";
import { companyTaxPermissionForCountry } from "@/lib/companyModuleGate";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Country = "EG" | "JO";
type Environment = "sandbox" | "production";
type SetupStatus = "not_configured" | "configured_unverified";

interface SetupState {
  country: Country;
  provider: "egypt_eta" | "jordan_national";
  environment: Environment | null;
  hasCredentials: boolean;
  setupStatus: SetupStatus;
  updatedAt: string | null;
}

interface AuditLog {
  id?: string | number;
  action?: string;
  event?: string;
  createdAt?: string;
  updatedAt?: string;
  at?: string;
  timestamp?: string;
  actorName?: string | null;
  actor?: string | null;
}

const EGYPT_FIELDS = [
  { key: "taxpayerId", label: "رقم التسجيل الضريبي", hint: "Taxpayer ID", kind: "input" },
  { key: "clientId", label: "معرّف العميل", hint: "Client ID", kind: "input" },
  { key: "clientSecret", label: "سر العميل", hint: "Client secret", kind: "secret" },
  { key: "signingCertificate", label: "شهادة التوقيع", hint: "Signing certificate", kind: "textarea" },
  { key: "signingPrivateKey", label: "المفتاح الخاص للتوقيع", hint: "Signing private key", kind: "textarea" },
] as const;

const JORDAN_FIELDS = [
  { key: "taxNumber", label: "الرقم الضريبي", hint: "Tax number", kind: "input" },
  { key: "userNumber", label: "رقم المستخدم", hint: "User number", kind: "input" },
  { key: "secretKey", label: "المفتاح السري", hint: "Secret key", kind: "secret" },
] as const;

function countryName(country: Country) {
  return country === "EG" ? "مصر" : "الأردن";
}

function providerName(country: Country) {
  return country === "EG" ? "منظومة الضرائب المصرية ETA" : "نظام الفوترة الإلكترونية الوطني الأردني";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "لم يُحفظ بعد";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ar-EG", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function parseError(response: Response, fallback: string) {
  return response.json()
    .then((body) => body?.error || body?.message || fallback)
    .catch(() => fallback);
}

export default function TaxIntegration() {
  const { token, user } = useAuth();
  const companyCountry = String(user?.company?.country ?? "").toUpperCase() as Country;
  const permissionKey = companyTaxPermissionForCountry(companyCountry);
  const hasModuleAccess = usePermission(permissionKey ?? "egypt_tax");
  const countryAllowed = companyCountry === "EG" || companyCountry === "JO";
  const canAccess = countryAllowed && user?.role === "admin" && !!permissionKey && hasModuleAccess;

  const [setup, setSetup] = useState<SetupState | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [environment, setEnvironment] = useState<Environment>("sandbox");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [logsError, setLogsError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [logsOpen, setLogsOpen] = useState(false);

  const fields = useMemo(
    () => companyCountry === "EG" ? EGYPT_FIELDS : JORDAN_FIELDS,
    [companyCountry],
  );

  const headers = useMemo(() => {
    const result: Record<string, string> = { Accept: "application/json" };
    if (token) result.Authorization = `Bearer ${token}`;
    return result;
  }, [token]);

  const load = useCallback(async () => {
    if (!canAccess) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [setupResponse, logsResponse] = await Promise.all([
        fetch(`${API}/api/tax-integrations/setup`, {
          credentials: "include",
          headers,
        }),
        fetch(`${API}/api/tax-integrations/logs`, {
          credentials: "include",
          headers,
        }),
      ]);
      if (!setupResponse.ok) {
        throw new Error(await parseError(setupResponse, "تعذر تحميل إعداد التكامل"));
      }
      const setupBody = await setupResponse.json() as SetupState;
      const expectedProvider = companyCountry === "EG" ? "egypt_eta" : "jordan_national";
      if (setupBody.country !== companyCountry || setupBody.provider !== expectedProvider) {
        throw new Error("لا يتطابق تكامل البلد مع الشركة الحالية.");
      }
      setSetup(setupBody);
      setEnvironment(setupBody.environment ?? "sandbox");
      setForm({});
      if (logsResponse.ok) {
        const logsBody = await logsResponse.json();
        setLogs(Array.isArray(logsBody) ? logsBody : Array.isArray(logsBody?.logs) ? logsBody.logs : []);
        setLogsError("");
      } else {
        setLogs([]);
        setLogsError("تعذر تحميل سجل التغييرات حالياً.");
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذر تحميل إعداد التكامل");
    } finally {
      setLoading(false);
    }
  }, [canAccess, companyCountry, headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateField = (key: string, value: string) => {
    setSaveMessage("");
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!setup || saving) return;
    const missing = fields.filter((field) => !form[field.key]?.trim());
    if (missing.length > 0) {
      setError("أكمل جميع بيانات الاعتماد المطلوبة قبل الحفظ. لا يمكن استكمال الحزمة من البيانات السابقة.");
      return;
    }
    setSaving(true);
    setError("");
    setSaveMessage("");
    try {
      const response = await fetch(`${API}/api/tax-integrations/setup`, {
        method: "PUT",
        credentials: "include",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          environment,
          credentials: Object.fromEntries(fields.map((field) => [field.key, form[field.key].trim()])),
        }),
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "تعذر حفظ بيانات التكامل"));
      }
      setSaveMessage("تم حفظ بيانات التكامل. الحالة الحالية: محفوظة وغير متحقق منها.");
      setForm({});
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "تعذر حفظ بيانات التكامل");
    } finally {
      setSaving(false);
    }
  };

  if (!canAccess) {
    return (
      <div dir="rtl" className="mx-auto flex min-h-[55vh] max-w-xl items-center justify-center px-4">
        <Card className="w-full border-amber-200 bg-amber-50/60">
          <CardContent className="p-8 text-center">
            <AlertCircle className="mx-auto mb-4 h-10 w-10 text-amber-600" />
            <h1 className="text-xl font-bold text-foreground">الوصول غير متاح</h1>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">
              إعدادات التكامل هذه متاحة فقط للشركات المصرية أو الأردنية التي فعّل لها مدير النظام الوحدة المطابقة لبلدها.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div dir="rtl" className="mx-auto max-w-6xl space-y-5">
        <div className="h-28 animate-pulse rounded-2xl bg-muted/60" />
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <div className="h-[520px] animate-pulse rounded-2xl bg-muted/50" />
          <div className="h-64 animate-pulse rounded-2xl bg-muted/50" />
        </div>
      </div>
    );
  }

  if (error && !setup) {
    return (
      <div dir="rtl" className="mx-auto flex min-h-[55vh] max-w-xl items-center justify-center px-4">
        <Card className="w-full border-red-200">
          <CardContent className="p-8 text-center">
            <AlertCircle className="mx-auto mb-4 h-10 w-10 text-red-600" />
            <h1 className="text-xl font-bold">تعذر تحميل الإعداد</h1>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <Button className="mt-5 gap-2" variant="outline" onClick={() => void load()}>
              إعادة المحاولة
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const configured = setup?.setupStatus === "configured_unverified";

  return (
    <div dir="rtl" className="mx-auto max-w-6xl space-y-6 pb-10">
      <section className="relative overflow-hidden rounded-2xl border border-slate-200 bg-[linear-gradient(120deg,#f5f8f6_0%,#eef5f4_55%,#e5efed_100%)] p-6 shadow-sm md:p-8">
        <div className="absolute -left-12 -top-20 h-52 w-52 rounded-full border-[22px] border-teal-100/70" />
        <div className="relative flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <div className="max-w-2xl">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-wide text-teal-800">
              <ShieldCheck className="h-4 w-4" />
              إعدادات الامتثال الضريبي
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 md:text-3xl">
              تكامل {countryName(companyCountry)} داخل زاكود
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-7 text-slate-600">
              مساحة إعداد آمنة لبيانات مزود الفوترة الإلكترونية الخاص ببلد شركتك. لا ترسل هذه الشاشة فواتير ولا تختبر الاتصال.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3 rounded-xl border border-white/80 bg-white/70 px-4 py-3 shadow-sm">
            <Building2 className="h-5 w-5 text-teal-700" />
            <div>
              <p className="text-[11px] text-slate-500">الشركة الحالية</p>
              <p className="max-w-[210px] truncate text-sm font-bold text-slate-800">{user?.company?.nameAr || "الشركة الحالية"}</p>
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {saveMessage && (
        <div className="flex items-start gap-3 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900" role="status">
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{saveMessage}</span>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="overflow-hidden border-slate-200 shadow-sm">
          <CardHeader className="border-b border-slate-100 bg-slate-50/70 px-5 py-5 md:px-7">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <KeyRound className="h-5 w-5 text-teal-700" />
                  بيانات الوصول
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">{providerName(companyCountry)}</p>
              </div>
              <Badge className={cn(
                "w-fit gap-1.5 border px-3 py-1 font-medium",
                configured
                  ? "border-amber-200 bg-amber-50 text-amber-800"
                  : "border-slate-200 bg-white text-slate-600",
              )}>
                {configured ? <Clock3 className="h-3.5 w-3.5" /> : <LockKeyhole className="h-3.5 w-3.5" />}
                {configured ? "محفوظ — غير متحقق منه" : "غير مُعد بعد"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="px-5 py-6 md:px-7">
            <form onSubmit={save} className="space-y-6">
              <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-4">
                <div className="flex gap-3">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                  <div className="text-sm leading-6 text-amber-900">
                    <p className="font-semibold">بيانات حساسة</p>
                    <p className="mt-1 text-amber-800">
                      لا نعيد عرض الأسرار بعد الحفظ. عند تعديل الإعداد، أدخل حزمة بيانات الاعتماد كاملة من جديد؛ لا تترك حقلاً سرياً فارغاً.
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor="tax-environment" className="text-sm font-semibold">بيئة التشغيل</label>
                  <select
                    id="tax-environment"
                    value={environment}
                    onChange={(event) => setEnvironment(event.target.value as Environment)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="sandbox">تجريبية (Sandbox)</option>
                    <option value="production">إنتاجية (Production)</option>
                  </select>
                </div>
                <div className="flex items-end">
                  <div className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-600">
                    اختيار البيئة لا يعني أن المزود تم التحقق منه. حالة التكامل تبقى غير متحقق منها حتى اعتماد مسار الاختبار الرسمي.
                  </div>
                </div>
              </div>

              <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
                {fields.map((field) => (
                  <div key={field.key} className={cn("space-y-2", field.kind === "textarea" && "sm:col-span-2")}>
                    <label htmlFor={`tax-${field.key}`} className="flex items-baseline justify-between gap-3 text-sm font-semibold">
                      <span>{field.label}</span>
                      <span className="font-mono text-[10px] font-normal text-muted-foreground" dir="ltr">{field.hint}</span>
                    </label>
                    {field.kind === "textarea" ? (
                      <Textarea
                        id={`tax-${field.key}`}
                        value={form[field.key] ?? ""}
                        onChange={(event) => updateField(field.key, event.target.value)}
                        required
                        rows={5}
                        dir="ltr"
                        spellCheck={false}
                        autoComplete="off"
                        className="resize-y font-mono text-xs"
                      />
                    ) : (
                      <Input
                        id={`tax-${field.key}`}
                        type={field.kind === "secret" ? "password" : "text"}
                        value={form[field.key] ?? ""}
                        onChange={(event) => updateField(field.key, event.target.value)}
                        required
                        dir="ltr"
                        spellCheck={false}
                        autoComplete="new-password"
                      />
                    )}
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-muted-foreground">
                  آخر تحديث: <span className="font-medium text-foreground">{formatDate(setup?.updatedAt)}</span>
                </p>
                <Button type="submit" disabled={saving} className="gap-2 bg-teal-700 text-white hover:bg-teal-800">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {saving ? "جارٍ الحفظ..." : "حفظ بيانات التكامل"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <aside className="space-y-5">
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-5">
              <div className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-800">
                <FileKey2 className="h-4 w-4 text-teal-700" />
                نطاق هذه الشاشة
              </div>
              <ul className="space-y-3 text-sm leading-6 text-slate-600">
                <li className="flex gap-2"><Check className="mt-1 h-4 w-4 shrink-0 text-teal-700" />حفظ إعدادات الوصول الخاصة ببلد الشركة فقط.</li>
                <li className="flex gap-2"><Check className="mt-1 h-4 w-4 shrink-0 text-teal-700" />عرض سجل تغييرات الإعدادات بعد إخفاء الأسرار.</li>
                <li className="flex gap-2"><Check className="mt-1 h-4 w-4 shrink-0 text-teal-700" />إرسال الفواتير غير متاح حتى اعتماد التحقق الرسمي من البيئة التجريبية.</li>
              </ul>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <button
              type="button"
              onClick={() => setLogsOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-3 px-5 py-4 text-right"
              aria-expanded={logsOpen}
            >
              <span className="flex items-center gap-2 text-sm font-bold text-slate-800">
                <History className="h-4 w-4 text-teal-700" />
                سجل إعدادات التكامل
              </span>
              <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", logsOpen && "rotate-180")} />
            </button>
            {logsOpen && (
              <div className="border-t border-slate-100 px-5 py-3">
                {logsError ? (
                  <p className="py-3 text-center text-xs text-amber-700">{logsError}</p>
                ) : logs.length === 0 ? (
                  <p className="py-3 text-center text-xs text-muted-foreground">لا توجد تغييرات مسجلة.</p>
                ) : (
                  <div className="space-y-3">
                    {logs.map((log, index) => (
                      <div key={String(log.id ?? index)} className="border-b border-dashed border-slate-200 pb-3 last:border-0 last:pb-0">
                        <p className="text-xs font-semibold text-slate-700">{log.action || log.event || "تحديث إعدادات التكامل"}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {formatDate(log.createdAt || log.updatedAt || log.at || log.timestamp)}
                          {log.actorName || log.actor ? ` · ${log.actorName || log.actor}` : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}