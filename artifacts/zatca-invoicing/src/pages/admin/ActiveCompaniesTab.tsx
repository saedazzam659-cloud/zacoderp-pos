import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Building2,
  CircleDot,
  Clock3,
  Globe2,
  Laptop2,
  Loader2,
  LogOut,
  MapPin,
  MonitorSmartphone,
  Phone,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Smartphone,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import {
  getGetSecurityActiveCompanySessionsQueryKey,
  getListSecurityActiveCompaniesQueryKey,
  type SecurityActiveCompanySession,
  type SecurityActiveCompanySummary,
  useEndSecurityActiveCompanySessions,
  useGetSecurityActiveCompanySessions,
  useListSecurityActiveCompanies,
} from "@workspace/api-client-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

const numberFormatter = new Intl.NumberFormat("ar-SA-u-ca-gregory-nu-latn");
const dateFormatter = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatNumber(value: number) {
  return numberFormatter.format(value);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "غير متوفر";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "غير متوفر" : dateFormatter.format(date);
}

function errorText(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "تعذّر تحميل البيانات. حاول التحديث مرة أخرى.";
}

function sourceLabel(source: string) {
  if (source === "central") return "المنصة المركزية";
  if (source.startsWith("agent:")) return `سيرفر الوكيل ${source.slice("agent:".length)}`;
  return source;
}

function sourceFilterLabel(source: string, companies: SecurityActiveCompanySummary[]) {
  if (source === "central") return "المنصة المركزية";
  const company = companies.find((item) => String(item.agentInstanceId ?? "") === source);
  if (company?.agentName) {
    return `${company.agentName}${company.agentDomain ? ` — ${company.agentDomain}` : ""}`;
  }
  return `سيرفر الوكيل ${source}`;
}

function zatcaLabel(status: SecurityActiveCompanySummary["zatcaStatus"]) {
  if (status === "production") return "مرتبط بالإنتاج";
  if (status === "sandbox") return "بيئة الاختبار";
  return "غير مرتبط";
}

function zatcaClass(status: SecurityActiveCompanySummary["zatcaStatus"]) {
  if (status === "production") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "sandbox") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function deviceLabel(userAgent: string | null) {
  if (!userAgent) return "جهاز غير معروف";
  if (/mobile|android|iphone|ipad/i.test(userAgent)) return "هاتف أو جهاز لوحي";
  return "حاسوب";
}

function locationLabel(session: SecurityActiveCompanySession) {
  const namedLocation = [session.loginPlace, session.loginZoneName].filter(Boolean).join(" · ");
  const ipLocation = [session.ipCity, session.ipRegion, session.ipCountryName || session.country]
    .filter(Boolean)
    .join(" · ");
  return namedLocation || ipLocation || "الموقع غير متوفر";
}

function SummaryMetric({
  icon: Icon,
  label,
  value,
  detail,
  testId,
  accent,
}: {
  icon: typeof UsersRound;
  label: string;
  value: string;
  detail: string;
  testId: string;
  accent: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200/80 bg-card p-4 shadow-sm">
      <div className={`absolute inset-y-0 start-0 w-1 ${accent}`} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 font-mono text-2xl font-semibold tracking-tight" data-testid={testId}>
            {value}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>
        </div>
        <div className="rounded-lg bg-slate-100 p-2 text-slate-600">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

function CompanyRow({
  company,
  selected,
  onInspect,
  onEnd,
}: {
  company: SecurityActiveCompanySummary;
  selected: boolean;
  onInspect: () => void;
  onEnd: () => void;
}) {
  return (
    <article
      className={`rounded-xl border bg-card p-4 transition-colors ${
        selected ? "border-primary/60 bg-primary/[0.035] shadow-sm" : "border-slate-200/80 hover:border-slate-300"
      }`}
      data-testid={`active-company-card-${company.companyId}-${company.source.replace(/[^a-zA-Z0-9]/g, "-")}`}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-slate-50">
              <Building2 className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-foreground" data-testid={`active-company-name-${company.companyId}`}>
                {company.companyName}
              </h3>
              {company.companyNameEn && <p className="truncate text-xs text-muted-foreground">{company.companyNameEn}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="font-mono">VAT {company.vatNumber || "—"}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">CR {company.crNumber || "—"}</span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700">
            <CircleDot className="h-3 w-3 fill-current" aria-hidden="true" />
            <span className="font-mono text-sm font-semibold" data-testid={`active-company-session-count-${company.companyId}`}>
              {formatNumber(company.activeSessionCount)}
            </span>
            <span className="text-[10px]">جلسة</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-2">
          <div className="flex min-w-0 items-center gap-2">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="truncate">{[company.city, company.district].filter(Boolean).join(" · ") || "العنوان غير متوفر"}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Server className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="truncate" data-testid={`active-company-source-${company.companyId}`}>{sourceLabel(company.source)}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="truncate">{company.phone || "رقم الهاتف غير متوفر"}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Clock3 className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="truncate">آخر دخول: {formatDate(company.latestLoginAt)}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2 sm:col-span-2">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="truncate" title={[company.street, company.buildingNumber, company.postalCode, company.additionalNumber, company.country].filter(Boolean).join(" · ")}>
              {[company.street, company.buildingNumber && `مبنى ${company.buildingNumber}`, company.postalCode && `الرمز ${company.postalCode}`, company.additionalNumber && `الرقم الإضافي ${company.additionalNumber}`, company.country].filter(Boolean).join(" · ") || "تفاصيل العنوان غير متوفرة"}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2 sm:col-span-2">
            <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="truncate">{company.industryName || "النشاط غير محدد"}{company.agentName ? ` · ${company.agentName}${company.agentDomain ? ` (${company.agentDomain})` : ""}` : ""}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="outline" className={zatcaClass(company.zatcaStatus)}>
              <ShieldCheck className="me-1 h-3 w-3" aria-hidden="true" />
              <span data-testid={`active-company-zatca-status-${company.companyId}`}>{zatcaLabel(company.zatcaStatus)}</span>
            </Badge>
            {company.activeUsersPreview.length > 0 && (
              <span className="max-w-[170px] truncate text-[11px] text-muted-foreground" title={company.activeUsersPreview.join("، ")}>
                {company.activeUsersPreview.join("، ")}
              </span>
            )}
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button type="button" variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={onInspect} data-testid={`inspect-active-company-${company.companyId}`}>
              <UsersRound className="me-1 h-3.5 w-3.5" aria-hidden="true" />
              تفاصيل الاتصالات
            </Button>
            <Button type="button" variant="ghost" size="sm" className="text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={onEnd} data-testid={`end-active-company-${company.companyId}`}>
              <LogOut className="me-1 h-3.5 w-3.5" aria-hidden="true" />
              إنهاء الكل
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

function CompanyTableRow({
  company,
  selected,
  onInspect,
  onEnd,
}: {
  company: SecurityActiveCompanySummary;
  selected: boolean;
  onInspect: () => void;
  onEnd: () => void;
}) {
  const address = [
    company.street,
    company.buildingNumber && `مبنى ${company.buildingNumber}`,
    company.postalCode && `الرمز ${company.postalCode}`,
    company.additionalNumber && `الرقم الإضافي ${company.additionalNumber}`,
    company.country,
  ].filter(Boolean).join(" · ");
  const city = [company.city, company.district].filter(Boolean).join(" · ");
  const sourceDetails = [company.agentName, company.agentDomain].filter(Boolean).join(" · ");

  return (
    <tr
      className={`border-b last:border-0 transition-colors hover:bg-muted/30 ${
        selected ? "bg-primary/[0.045]" : ""
      }`}
      data-testid={`active-company-row-${company.companyId}-${company.source.replace(/[^a-zA-Z0-9]/g, "-")}`}
    >
      <td className="px-3 py-3 align-middle">
        <div className="flex min-w-[200px] items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-slate-50">
            <Building2 className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium" data-testid={`active-company-name-table-${company.companyId}`}>
              {company.companyName}
            </p>
            {company.companyNameEn && <p className="truncate text-[11px] text-muted-foreground">{company.companyNameEn}</p>}
            <p className="truncate text-[10px] text-muted-foreground">
              VAT {company.vatNumber || "—"} · CR {company.crNumber || "—"}
            </p>
          </div>
        </div>
      </td>
      <td className="min-w-[160px] px-3 py-3 align-middle">
        <p className="font-medium">{sourceLabel(company.source)}</p>
        {sourceDetails && <p className="mt-0.5 max-w-48 truncate text-[11px] text-muted-foreground" title={sourceDetails}>{sourceDetails}</p>}
      </td>
      <td className="min-w-[220px] px-3 py-3 align-middle">
        <p className="truncate" title={city || undefined}>{city || "العنوان غير متوفر"}</p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={address || undefined}>
          {address || "تفاصيل العنوان غير متوفرة"}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {company.phone || "رقم الهاتف غير متوفر"} · {company.industryName || "النشاط غير محدد"}
        </p>
      </td>
      <td className="min-w-[150px] px-3 py-3 align-middle">
        <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
          <CircleDot className="me-1 h-3 w-3 fill-current" aria-hidden="true" />
          {formatNumber(company.activeSessionCount)} جلسة
        </Badge>
        {company.activeUsersPreview.length > 0 && (
          <p className="mt-1 max-w-40 truncate text-[11px] text-muted-foreground" title={company.activeUsersPreview.join("، ")}>
            {company.activeUsersPreview.join("، ")}
          </p>
        )}
      </td>
      <td className="px-3 py-3 align-middle">
        <Badge variant="outline" className={zatcaClass(company.zatcaStatus)}>
          <ShieldCheck className="me-1 h-3 w-3" aria-hidden="true" />
          {zatcaLabel(company.zatcaStatus)}
        </Badge>
      </td>
      <td className="whitespace-nowrap px-3 py-3 align-middle text-xs text-muted-foreground">
        {formatDate(company.latestLoginAt)}
      </td>
      <td className="px-3 py-3 align-middle">
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onInspect}
            data-testid={`inspect-active-company-table-${company.companyId}`}
          >
            <UsersRound className="me-1 h-3.5 w-3.5" aria-hidden="true" />
            التفاصيل
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
            onClick={onEnd}
            data-testid={`end-active-company-table-${company.companyId}`}
          >
            <LogOut className="me-1 h-3.5 w-3.5" aria-hidden="true" />
            إنهاء الكل
          </Button>
        </div>
      </td>
    </tr>
  );
}

function SessionRow({ session }: { session: SecurityActiveCompanySession }) {
  const isMobile = /mobile|android|iphone|ipad/i.test(session.userAgent || "");
  return (
    <article className="rounded-lg border border-slate-200/80 bg-slate-50/60 p-3" data-testid={`active-session-${session.userId}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-slate-500 shadow-sm ring-1 ring-slate-200">
            <UserRound className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" data-testid={`active-session-user-${session.userId}`}>{session.username}</p>
            <p className="truncate text-xs text-muted-foreground">{session.email || "البريد الإلكتروني غير متوفر"}</p>
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 border-slate-200 bg-white text-[10px] text-slate-600">
          {session.role}
        </Badge>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 text-[11px] text-muted-foreground sm:grid-cols-2">
        <div className="flex items-start gap-2">
          {isMobile ? <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" /> : <Laptop2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />}
          <span className="truncate" title={session.userAgent || undefined}>{deviceLabel(session.userAgent)}{session.userAgent ? ` · ${session.userAgent}` : ""}</span>
        </div>
        <div className="flex items-start gap-2">
          <Globe2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
          <span className="font-mono" data-testid={`active-session-ip-${session.userId}`}>{session.ip || "IP غير متوفر"}{session.ipCountryName || session.country ? ` · ${session.ipCountryName || session.country}` : ""}</span>
        </div>
        <div className="flex items-start gap-2">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
          <span className="truncate">{locationLabel(session)}</span>
        </div>
        <div className="flex items-start gap-2">
          <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
          <span data-testid={`active-session-login-${session.userId}`}>{formatDate(session.lastLoginAt)}</span>
        </div>
      </div>
      {session.loginAddress && <p className="mt-2 truncate border-t border-slate-200/70 pt-2 text-[11px] text-muted-foreground">عنوان الدخول: {session.loginAddress}</p>}
    </article>
  );
}

export default function ActiveCompaniesTab(_props?: { token?: string | null }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [selectedCompany, setSelectedCompany] = useState<SecurityActiveCompanySummary | null>(null);
  const [confirmCompany, setConfirmCompany] = useState<SecurityActiveCompanySummary | null>(null);

  const listParams = useMemo(() => {
    const params: { source?: string; search?: string } = { source: sourceFilter };
    if (search.trim()) params.search = search.trim();
    return params;
  }, [search, sourceFilter]);
  const listQueryKey = useMemo(() => getListSecurityActiveCompaniesQueryKey(listParams), [listParams]);

  const companiesQuery = useListSecurityActiveCompanies(listParams, {
    query: {
      queryKey: listQueryKey,
      refetchInterval: 30_000,
      staleTime: 10_000,
    },
  });
  const companies = companiesQuery.data?.companies ?? [];
  const warnings = companiesQuery.data?.warnings ?? [];
  const sourceOptions = useMemo(() => {
    const values = new Map<string, string>([["central", "المنصة المركزية"]]);
    for (const company of companies) {
      if (company.agentInstanceId != null) {
        const value = String(company.agentInstanceId);
        values.set(value, sourceFilterLabel(value, companies));
      }
    }
    if (sourceFilter !== "all" && !values.has(sourceFilter)) {
      values.set(sourceFilter, sourceFilterLabel(sourceFilter, companies));
    }
    return Array.from(values, ([value, label]) => ({ value, label }));
  }, [companies, sourceFilter]);

  const detailCompanyId = selectedCompany?.companyId ?? 0;
  const detailParams = useMemo(() => ({ source: selectedCompany?.source ?? "central" }), [selectedCompany?.source]);
  const detailQueryKey = useMemo(
    () => getGetSecurityActiveCompanySessionsQueryKey(detailCompanyId, detailParams),
    [detailCompanyId, detailParams],
  );
  const sessionsQuery = useGetSecurityActiveCompanySessions(detailCompanyId, detailParams, {
    query: {
      queryKey: detailQueryKey,
      enabled: Boolean(selectedCompany),
      refetchInterval: 30_000,
      staleTime: 10_000,
    },
  });

  const endSessions = useEndSecurityActiveCompanySessions();

  const refreshAll = () => {
    void companiesQuery.refetch();
    if (selectedCompany) void sessionsQuery.refetch();
  };

  const handleEndCompany = () => {
    if (!confirmCompany) return;
    const target = confirmCompany;
    endSessions.mutate(
      { companyId: target.companyId, data: { source: target.source } },
      {
        onSuccess: (result) => {
          setConfirmCompany(null);
          setSelectedCompany((current) => (
            current && current.companyId === target.companyId && current.source === target.source
              ? { ...current, activeSessionCount: 0, activeUsersPreview: [] }
              : current
          ));
          void queryClient.invalidateQueries({ queryKey: getListSecurityActiveCompaniesQueryKey() });
          void queryClient.invalidateQueries({
            queryKey: getGetSecurityActiveCompanySessionsQueryKey(target.companyId, { source: target.source }),
          });
          toast({
            title: "تم إنهاء جلسات الشركة",
            description: `تم إنهاء ${formatNumber(result.ended)} جلسة عن ${result.companyName || target.companyName}.`,
          });
        },
        onError: (error) => {
          toast({ variant: "destructive", title: "تعذّر إنهاء الجلسات", description: errorText(error) });
        },
      },
    );
  };

  return (
    <section dir="rtl" className="space-y-4" data-testid="active-companies-tab">
      <div className="relative overflow-hidden rounded-2xl border border-slate-200/80 bg-[linear-gradient(135deg,hsl(var(--card))_0%,hsl(var(--muted)/0.62)_100%)] p-5 shadow-sm sm:p-6">
        <div className="absolute -end-12 -top-16 h-40 w-40 rounded-full border-[18px] border-primary/5" aria-hidden="true" />
        <div className="relative flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div className="max-w-2xl">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-emerald-700">
              <span className="flex h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
              مراقبة مباشرة · تحديث تلقائي كل 30 ثانية
            </div>
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">الشركات المتصلة الآن</h2>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
              نظرة تشغيلية على الشركات المتصلة عبر المنصة المركزية وسيرفرات الوكلاء، مع إمكانية فحص كل اتصال وإنهائه بأمان.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={refreshAll} disabled={companiesQuery.isFetching || sessionsQuery.isFetching} data-testid="refresh-active-companies">
            <RefreshCw className={`me-2 h-4 w-4 ${companiesQuery.isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
            تحديث الآن
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryMetric icon={UsersRound} label="الجلسات النشطة" value={formatNumber(companiesQuery.data?.totalActiveSessions ?? 0)} detail="إجمالي الاتصالات المرصودة" testId="active-companies-total-sessions" accent="bg-emerald-500" />
        <SummaryMetric icon={Building2} label="الشركات المتصلة" value={formatNumber(companies.length)} detail="شركات لديها مستخدمون متصلون" testId="active-companies-total-companies" accent="bg-primary" />
        <SummaryMetric icon={AlertTriangle} label="جلسات بلا شركة" value={formatNumber(companiesQuery.data?.unassignedSessionCount ?? 0)} detail="تحتاج إلى مراجعة الهوية" testId="active-companies-unassigned-sessions" accent="bg-amber-500" />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-slate-200/80 bg-card p-3 shadow-sm sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={search} onChange={(event) => { setSearch(event.target.value); setSelectedCompany(null); }} placeholder="ابحث باسم الشركة أو الرقم الضريبي أو المدينة" aria-label="البحث في الشركات المتصلة" className="h-10 pe-9" data-testid="active-companies-search" />
        </div>
        <label className="flex h-10 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground">
          <Server className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="sr-only">مصدر الجلسات</span>
          <select value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value); setSelectedCompany(null); }} className="min-w-36 bg-transparent text-sm text-foreground outline-none" data-testid="active-companies-source-filter" aria-label="مصدر الجلسات">
            <option value="all">كل المصادر</option>
            {sourceOptions.map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}
          </select>
        </label>
        {(search || sourceFilter !== "all") && (
          <Button type="button" variant="ghost" size="sm" onClick={() => { setSearch(""); setSourceFilter("all"); setSelectedCompany(null); }} data-testid="clear-active-companies-filters">
            <X className="me-1 h-3.5 w-3.5" aria-hidden="true" />
            مسح
          </Button>
        )}
      </div>

      {warnings.length > 0 && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-900" data-testid="active-companies-source-warnings">
          <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
          <AlertTitle className="text-sm">النتائج جزئية</AlertTitle>
          <AlertDescription className="mt-1 text-xs text-amber-800">
            تعذّر جلب البيانات من بعض المصادر. ستظل النتائج المتاحة معروضة أدناه.
            <ul className="mt-2 list-inside list-disc space-y-1">
              {warnings.map((warning) => <li key={`${warning.source}-${warning.name}`}>{warning.name || sourceLabel(warning.source)}: {warning.error}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {companiesQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2" data-testid="active-companies-loading">
          {[1, 2, 3, 4].map((item) => <div key={item} className="rounded-xl border border-slate-200/80 bg-card p-4"><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-4 w-1/2" /><Skeleton className="mt-6 h-14 w-full" /><Skeleton className="mt-4 h-8 w-full" /></div>)}
        </div>
      ) : companiesQuery.isError ? (
        <Card className="border-rose-200 bg-rose-50/40" data-testid="active-companies-error">
          <CardContent className="flex flex-col items-center justify-center gap-3 p-10 text-center">
            <AlertTriangle className="h-7 w-7 text-rose-500" aria-hidden="true" />
            <div><p className="font-medium text-rose-800">تعذّر تحميل الشركات المتصلة</p><p className="mt-1 text-sm text-rose-700">{errorText(companiesQuery.error)}</p></div>
            <Button type="button" variant="outline" onClick={() => void companiesQuery.refetch()} data-testid="retry-active-companies">
              <RefreshCw className="me-2 h-4 w-4" aria-hidden="true" /> إعادة المحاولة
            </Button>
          </CardContent>
        </Card>
      ) : companies.length === 0 ? (
        <Card className="border-dashed" data-testid="active-companies-empty">
          <CardContent className="flex flex-col items-center justify-center p-12 text-center">
            <div className="mb-4 rounded-2xl bg-slate-100 p-4 text-slate-500"><MonitorSmartphone className="h-7 w-7" aria-hidden="true" /></div>
            <p className="font-medium">لا توجد شركات مطابقة</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">{search || sourceFilter !== "all" ? "جرّب تغيير البحث أو مصدر الجلسات." : "لا توجد جلسات نشطة في الوقت الحالي."}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3" data-testid="active-companies-list">
          <div className="flex items-center justify-between px-1">
            <p className="text-sm font-medium">الشركات المتصلة</p>
            <p className="text-xs text-muted-foreground">{formatNumber(companies.length)} نتيجة</p>
          </div>

          {/* Use the same responsive pattern as the active-sessions table:
              stacked rows on mobile, a sortable-looking data table on desktop. */}
          <div className="grid grid-cols-1 gap-3 md:hidden">
            {companies.map((company) => (
              <CompanyRow
                key={`mobile:${company.source}:${company.companyId}`}
                company={company}
                selected={selectedCompany?.companyId === company.companyId && selectedCompany.source === company.source}
                onInspect={() => setSelectedCompany(company)}
                onEnd={() => setConfirmCompany(company)}
              />
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-xl border border-slate-200/80 bg-card shadow-sm md:block">
            <table className="w-full min-w-[1180px] text-sm">
              <thead className="border-b bg-muted/40">
                <tr className="text-right text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">الشركة</th>
                  <th className="px-3 py-2 font-medium">مصدر الاتصال</th>
                  <th className="px-3 py-2 font-medium">الموقع والتواصل</th>
                  <th className="px-3 py-2 font-medium">الجلسات النشطة</th>
                  <th className="px-3 py-2 font-medium">حالة الربط</th>
                  <th className="px-3 py-2 font-medium">آخر دخول</th>
                  <th className="px-3 py-2 font-medium">الإجراءات</th>
                </tr>
              </thead>
              <tbody>
                {companies.map((company) => (
                  <CompanyTableRow
                    key={`table:${company.source}:${company.companyId}`}
                    company={company}
                    selected={selectedCompany?.companyId === company.companyId && selectedCompany.source === company.source}
                    onInspect={() => setSelectedCompany(company)}
                    onEnd={() => setConfirmCompany(company)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <Card className="h-fit border-slate-200/80 shadow-sm xl:sticky xl:top-4" data-testid="active-company-session-detail">
            {!selectedCompany ? (
              <CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
                <div className="mb-4 rounded-2xl bg-primary/10 p-4 text-primary"><UsersRound className="h-7 w-7" aria-hidden="true" /></div>
                <p className="font-medium">اختر شركة لفحص الاتصالات</p>
                <p className="mt-1 max-w-xs text-sm leading-6 text-muted-foreground">ستظهر هنا هوية المستخدم ومكان الاتصال والجهاز وآخر وقت دخول.</p>
              </CardContent>
            ) : (
              <>
                <CardHeader className="border-b border-slate-100 pb-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-base" data-testid="selected-active-company-name">{selectedCompany.companyName}</CardTitle>
                      <CardDescription className="mt-1 flex items-center gap-1.5 text-xs"><Server className="h-3 w-3" aria-hidden="true" />{sourceLabel(selectedCompany.source)}</CardDescription>
                    </div>
                    <Badge className="shrink-0 bg-emerald-100 text-emerald-800 hover:bg-emerald-100" data-testid="selected-active-company-session-count">
                      {formatNumber(selectedCompany.activeSessionCount)} جلسة
                    </Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge variant="outline" className={zatcaClass(selectedCompany.zatcaStatus)}>{zatcaLabel(selectedCompany.zatcaStatus)}</Badge>
                    <span className="text-[11px] text-muted-foreground">آخر دخول {formatDate(selectedCompany.latestLoginAt)}</span>
                  </div>
                </CardHeader>
                <CardContent className="p-3">
                  {sessionsQuery.isLoading ? (
                    <div className="space-y-2" data-testid="active-company-sessions-loading"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
                  ) : sessionsQuery.isError ? (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-5 text-center" data-testid="active-company-sessions-error">
                      <p className="text-sm font-medium text-rose-800">تعذّر تحميل تفاصيل الاتصالات</p>
                      <p className="mt-1 text-xs text-rose-700">{errorText(sessionsQuery.error)}</p>
                      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void sessionsQuery.refetch()} data-testid="retry-active-company-sessions">إعادة المحاولة</Button>
                    </div>
                  ) : (sessionsQuery.data?.sessions ?? []).length === 0 ? (
                    <div className="p-7 text-center text-sm text-muted-foreground" data-testid="active-company-sessions-empty">لا توجد اتصالات نشطة لهذه الشركة.</div>
                  ) : (
                    <div className="space-y-2" data-testid="active-company-sessions-list">
                      {(sessionsQuery.data?.sessions ?? []).map((session) => <SessionRow key={`${session.userId}-${session.lastLoginAt ?? "active"}`} session={session} />)}
                    </div>
                  )}
                </CardContent>
              </>
            )}
          </Card>
        </div>
      )}

      <AlertDialog open={Boolean(confirmCompany)} onOpenChange={(open) => { if (!open && !endSessions.isPending) setConfirmCompany(null); }}>
        <AlertDialogContent dir="rtl" data-testid="end-active-company-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-rose-700"><LogOut className="h-5 w-5" aria-hidden="true" />إنهاء كل جلسات الشركة؟</AlertDialogTitle>
            <AlertDialogDescription className="leading-6">
              سيتم تسجيل خروج جميع المستخدمين المتصلين حاليًا من <strong className="text-foreground">{confirmCompany?.companyName}</strong> عبر <strong className="text-foreground">{sourceLabel(confirmCompany?.source ?? "central")}</strong>.
              <span className="mt-2 block rounded-md bg-rose-50 p-2 text-rose-800">
                الإجراء سيُنهي {formatNumber(confirmCompany?.activeSessionCount ?? 0)} جلسة، ولا يمكن التراجع عنه.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={endSessions.isPending} data-testid="cancel-end-active-company">إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => { event.preventDefault(); handleEndCompany(); }} disabled={endSessions.isPending} className="bg-rose-600 hover:bg-rose-700" data-testid="confirm-end-active-company">
              {endSessions.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <LogOut className="me-2 h-4 w-4" aria-hidden="true" />}
              تأكيد إنهاء الجلسات
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {companiesQuery.isFetching && !companiesQuery.isLoading && (
        <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground" data-testid="active-companies-refreshing">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> جارٍ تحديث الحالة
        </div>
      )}
    </section>
  );
}