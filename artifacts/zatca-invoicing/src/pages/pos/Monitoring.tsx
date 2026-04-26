import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Activity, Banknote, ReceiptText, Users as UsersIcon,
  Building2, Clock, RefreshCw, Search, Lock, AlertCircle, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { posMonitoringApi, type PosSessionRow, type PosSessionDetail } from "@/lib/posMonitoringApi";

const SAR = (n: number | string | null | undefined, locale: string) =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "SAR", maximumFractionDigits: 2 }).format(Number(n ?? 0));

const dt = (s: string | null, locale: string) =>
  s ? new Date(s).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "—";

const durationMin = (a: string, b: string | null, t: (k: string, opts?: any) => string) => {
  const start = new Date(a).getTime();
  const end = b ? new Date(b).getTime() : Date.now();
  const m = Math.max(0, Math.round((end - start) / 60000));
  if (m < 60) return t("posPages.monitoring.durMin", { m });
  const h = Math.floor(m / 60), r = m % 60;
  return t("posPages.monitoring.durHourMin", { h, m: r });
};

function StatusBadge({ status }: { status: PosSessionRow["status"] }) {
  const { t } = useTranslation();
  const tr = (k: string) => t(`posPages.monitoring.${k}`) as string;
  if (status === "open") return (
    <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100">
      <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 me-1.5 animate-pulse" />
      {tr("statusOpen")}
    </Badge>
  );
  if (status === "closed") return <Badge variant="secondary">{tr("statusClosed")}</Badge>;
  return <Badge className="bg-amber-100 text-amber-800 border-amber-200">{tr("statusForceClosed")}</Badge>;
}

function StatCard({ icon: Icon, label, value, accent, sub }: {
  icon: any; label: string; value: string; accent: string; sub?: string;
}) {
  return (
    <Card className="overflow-hidden border-0 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-center gap-4">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${accent}`}>
            <Icon className="w-6 h-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-2xl font-bold leading-tight truncate">{value}</div>
            {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PosMonitoring() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const locale = isRtl ? "ar-SA" : "en-US";
  const tr = (k: string, opts?: any) => t(`posPages.monitoring.${k}`, opts) as string;
  const pickName = (r: { nameAr?: string | null; nameEn?: string | null } | undefined | null) =>
    !r ? "" : (isRtl ? (r.nameAr ?? r.nameEn ?? "") : (r.nameEn ?? r.nameAr ?? ""));
  const qc = useQueryClient();
  const isSuperAdmin = user?.role === "superadmin";
  const [companyId, setCompanyId] = useState<number | null>(user?.companyId ?? null);

  // Companies dropdown for superadmin to filter by tenant.
  const companiesQ = useQuery({
    queryKey: ["companies-for-pos-monitor"],
    enabled: isSuperAdmin,
    queryFn: async () => {
      const API = import.meta.env.VITE_API_URL || "";
      const res = await fetch(`${API}/api/companies`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(tr("loadCompaniesFailed"));
      return (await res.json()) as Array<{ id: number; nameAr: string; nameEn?: string }>;
    },
  });
  const [status, setStatus] = useState<"" | "open" | "closed" | "force_closed">("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => { if (user?.companyId) setCompanyId(user.companyId); }, [user?.companyId]);

  const summary = useQuery({
    queryKey: ["pos-summary-today", companyId],
    queryFn: () => posMonitoringApi.summaryToday(companyId),
    refetchInterval: autoRefresh ? 10_000 : false,
  });

  const list = useQuery({
    queryKey: ["pos-sessions", companyId, status],
    queryFn: () => posMonitoringApi.list({ companyId, status }),
    refetchInterval: autoRefresh ? 10_000 : false,
  });

  const detail = useQuery({
    queryKey: ["pos-session", selectedId],
    queryFn: () => posMonitoringApi.get(selectedId!),
    enabled: selectedId != null,
    refetchInterval: selectedId && autoRefresh ? 10_000 : false,
  });

  const filtered = useMemo(() => {
    const rows = list.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      String(r.id).includes(q) ||
      r.user?.username?.toLowerCase().includes(q) ||
      r.user?.nameAr?.toLowerCase().includes(q) ||
      (r.user as any)?.nameEn?.toLowerCase().includes(q) ||
      r.branch?.nameAr?.toLowerCase().includes(q) ||
      (r.branch as any)?.nameEn?.toLowerCase().includes(q) ||
      r.cashBox?.nameAr?.toLowerCase().includes(q) ||
      (r.cashBox as any)?.nameEn?.toLowerCase().includes(q)
    );
  }, [list.data, search]);

  const openSessions = filtered.filter(r => r.status === "open");
  const byUser = useMemo(() => {
    const map = new Map<string, { name: string; sales: number; invoices: number }>();
    for (const r of filtered) {
      const key = r.user?.username || "—";
      const name = pickName(r.user as any) || r.user?.username || "—";
      const cur = map.get(key) ?? { name, sales: 0, invoices: 0 };
      cur.sales += Number(r.totalSales || 0);
      cur.invoices += Number(r.invoiceCount || 0);
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.sales - a.sales).slice(0, 5);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, isRtl]);

  async function forceClose(id: number) {
    try {
      await posMonitoringApi.forceClose(id, tr("closeReason"));
      toast({ title: tr("toastClosedTitle"), description: tr("toastClosedDesc", { id }) });
      qc.invalidateQueries({ queryKey: ["pos-sessions"] });
      qc.invalidateQueries({ queryKey: ["pos-summary-today"] });
      qc.invalidateQueries({ queryKey: ["pos-session", id] });
    } catch (e: any) {
      toast({ title: tr("toastCloseFailedTitle"), description: e?.message || tr("unknownError"), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6 p-1" dir={isRtl ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="w-6 h-6 text-emerald-600" />
            {tr("title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {tr("subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={autoRefresh ? "default" : "outline"}
            size="sm"
            onClick={() => setAutoRefresh(v => !v)}
            className="gap-1"
          >
            <span className={`inline-block w-2 h-2 rounded-full ${autoRefresh ? "bg-emerald-300 animate-pulse" : "bg-muted-foreground"}`} />
            {tr("autoRefresh")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => { list.refetch(); summary.refetch(); }} className="gap-1">
            <RefreshCw className="w-4 h-4" />
            {tr("refresh")}
          </Button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {summary.isLoading ? (
          <>
            {[0,1,2,3].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </>
        ) : (
          <>
            <StatCard
              icon={Activity}
              label={tr("kpiOpenSessions")}
              value={String(summary.data?.openSessions ?? 0)}
              accent="bg-gradient-to-br from-emerald-500 to-emerald-600"
              sub={tr("kpiOpenSessionsSub")}
            />
            <StatCard
              icon={Banknote}
              label={tr("kpiTodaySales")}
              value={SAR(summary.data?.totalSales ?? 0, locale)}
              accent="bg-gradient-to-br from-blue-500 to-indigo-600"
              sub={tr("kpiTodaySalesSub")}
            />
            <StatCard
              icon={ReceiptText}
              label={tr("kpiTodayInvoices")}
              value={String(summary.data?.invoiceCount ?? 0)}
              accent="bg-gradient-to-br from-purple-500 to-fuchsia-600"
            />
            <StatCard
              icon={Lock}
              label={tr("kpiClosedToday")}
              value={String(summary.data?.closedToday ?? 0)}
              accent="bg-gradient-to-br from-slate-500 to-slate-700"
            />
          </>
        )}
      </div>

      {/* Filters */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground`} />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={tr("searchPh")}
              className={isRtl ? "pe-9" : "ps-9"}
            />
          </div>
          <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v as any)}>
            <SelectTrigger className="w-44"><SelectValue placeholder={tr("allStatuses")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr("allStatuses")}</SelectItem>
              <SelectItem value="open">{tr("statusOpen")}</SelectItem>
              <SelectItem value="closed">{tr("statusClosed")}</SelectItem>
              <SelectItem value="force_closed">{tr("statusForceClosed")}</SelectItem>
            </SelectContent>
          </Select>
          {isSuperAdmin && (
            <Select
              value={companyId ? String(companyId) : "all"}
              onValueChange={(v) => setCompanyId(v === "all" ? null : Number(v))}
            >
              <SelectTrigger className="w-56" data-testid="select-company">
                <SelectValue placeholder={tr("allCompanies")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tr("allCompanies")}</SelectItem>
                {(companiesQ.data ?? []).map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{pickName(c as any)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      {/* Active sessions live strip */}
      {openSessions.length > 0 && (
        <Card className={`border-0 shadow-sm bg-gradient-to-${isRtl ? "l" : "r"} from-emerald-50 to-white`}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <h3 className="font-semibold text-emerald-900">{tr("activeNow", { count: openSessions.length })}</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {openSessions.map(s => {
                const userName = pickName(s.user as any) || s.user?.username || "—";
                const branchName = pickName(s.branch as any) || "—";
                const cashBoxName = pickName(s.cashBox as any) || tr("noCashBox");
                return (
                  <button
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    className={`${isRtl ? "text-right" : "text-left"} rounded-xl border border-emerald-200 bg-white p-3 hover:shadow-md hover:border-emerald-400 transition-all`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-sm font-bold">
                          {userName.charAt(0)}
                        </div>
                        <div>
                          <div className="font-medium text-sm">{userName}</div>
                          <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                            <Building2 className="w-3 h-3" />
                            {branchName} · {cashBoxName}
                          </div>
                        </div>
                      </div>
                      <div className={isRtl ? "text-left" : "text-right"}>
                        <div className="text-base font-bold text-emerald-700">{SAR(s.totalSales, locale)}</div>
                        <div className="text-[11px] text-muted-foreground">{tr("invoiceShort", { count: s.invoiceCount })}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{dt(s.openedAt, locale)}</span>
                      <span className="font-medium text-emerald-700">{durationMin(s.openedAt, null, t)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top performers */}
      {byUser.length > 0 && (
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <UsersIcon className="w-4 h-4 text-blue-600" />
              {tr("topCashiers")}
            </h3>
            <div className="space-y-2">
              {byUser.map((u, idx) => (
                <div key={u.name} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold">{idx + 1}</div>
                  <div className="flex-1 text-sm font-medium">{u.name}</div>
                  <div className="text-xs text-muted-foreground">{tr("invoiceShort", { count: u.invoices })}</div>
                  <div className="font-semibold text-sm">{SAR(u.sales, locale)}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sessions table */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs">
                <tr className={isRtl ? "text-right" : "text-left"}>
                  <th className="p-3">#</th>
                  <th className="p-3">{tr("colCashier")}</th>
                  <th className="p-3">{tr("colBranch")}</th>
                  <th className="p-3">{tr("colCashBox")}</th>
                  <th className="p-3">{tr("colOpened")}</th>
                  <th className="p-3">{tr("colClosed")}</th>
                  <th className="p-3">{tr("colDuration")}</th>
                  <th className={`p-3 ${isRtl ? "text-left" : "text-right"}`}>{tr("colInvoices")}</th>
                  <th className={`p-3 ${isRtl ? "text-left" : "text-right"}`}>{tr("colSales")}</th>
                  <th className={`p-3 ${isRtl ? "text-left" : "text-right"}`}>{tr("colDifference")}</th>
                  <th className="p-3">{tr("colStatus")}</th>
                  <th className={`p-3 ${isRtl ? "text-left" : "text-right"}`}>{tr("colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {list.isLoading && (
                  <tr><td colSpan={12} className="p-6 text-center text-muted-foreground">{tr("loading")}</td></tr>
                )}
                {!list.isLoading && filtered.length === 0 && (
                  <tr><td colSpan={12} className="p-8 text-center text-muted-foreground">
                    {tr("noMatch")}
                  </td></tr>
                )}
                {filtered.map(s => {
                  const userName = pickName(s.user as any) || s.user?.username || "—";
                  return (
                    <tr
                      key={s.id}
                      className="border-t hover:bg-muted/30 cursor-pointer"
                      onClick={() => setSelectedId(s.id)}
                    >
                      <td className="p-3 font-mono text-xs">#{s.id}</td>
                      <td className="p-3">
                        <div className="font-medium">{userName}</div>
                        {(s.user?.nameAr || (s.user as any)?.nameEn) && <div className="text-[11px] text-muted-foreground">{s.user?.username}</div>}
                      </td>
                      <td className="p-3">{pickName(s.branch as any) || "—"}</td>
                      <td className="p-3">{pickName(s.cashBox as any) || "—"}</td>
                      <td className="p-3 text-xs">{dt(s.openedAt, locale)}</td>
                      <td className="p-3 text-xs">{dt(s.closedAt, locale)}</td>
                      <td className="p-3 text-xs">{durationMin(s.openedAt, s.closedAt, t)}</td>
                      <td className={`p-3 ${isRtl ? "text-left" : "text-right"} tabular-nums`}>{s.invoiceCount}</td>
                      <td className={`p-3 ${isRtl ? "text-left" : "text-right"} font-semibold tabular-nums`}>{SAR(s.totalSales, locale)}</td>
                      <td className={`p-3 ${isRtl ? "text-left" : "text-right"} tabular-nums`}>
                        {s.difference != null ? (
                          <span className={Number(s.difference) === 0 ? "text-muted-foreground" :
                            Number(s.difference) > 0 ? "text-emerald-600" : "text-red-600"}>
                            {SAR(s.difference, locale)}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="p-3"><StatusBadge status={s.status} /></td>
                      <td className={`p-3 ${isRtl ? "text-left" : "text-right"}`}>
                        {s.status === "open" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => { e.stopPropagation(); if (confirm(tr("forceCloseConfirm", { id: s.id }))) forceClose(s.id); }}
                            className="gap-1 text-xs"
                          >
                            <Lock className="w-3 h-3" />
                            {tr("close")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Session details dialog */}
      <Dialog open={selectedId != null} onOpenChange={(o) => !o && setSelectedId(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-emerald-600" />
              {tr("sessionTitle", { id: selectedId ? `#${selectedId}` : "" })}
            </DialogTitle>
          </DialogHeader>

          {detail.isLoading && <div className="py-8 text-center text-muted-foreground">{tr("loading")}</div>}
          {detail.data && <SessionDetailBody d={detail.data} onForceClose={() => forceClose(detail.data!.id)} />}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedId(null)}>
              <X className="w-4 h-4 me-1" />
              {tr("close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SessionDetailBody({ d, onForceClose }: { d: PosSessionDetail; onForceClose: () => void }) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const locale = isRtl ? "ar-SA" : "en-US";
  const tr = (k: string, opts?: any) => t(`posPages.monitoring.${k}`, opts) as string;
  const pickName = (r: { nameAr?: string | null; nameEn?: string | null } | undefined | null) =>
    !r ? "" : (isRtl ? (r.nameAr ?? r.nameEn ?? "") : (r.nameEn ?? r.nameAr ?? ""));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Info label={tr("infoCashier")}      value={pickName(d.user as any) || d.user?.username || "—"} />
        <Info label={tr("infoBranch")}       value={pickName(d.branch as any) || "—"} />
        <Info label={tr("infoCashBox")}      value={pickName(d.cashBox as any) || "—"} />
        <Info label={tr("infoStatus")}       value={<StatusBadge status={d.status} />} />
        <Info label={tr("infoOpened")}       value={dt(d.openedAt, locale)} />
        <Info label={tr("infoClosed")}       value={dt(d.closedAt, locale)} />
        <Info label={tr("infoDuration")}     value={durationMin(d.openedAt, d.closedAt, t)} />
        <Info label={tr("infoDevice")}       value={<span className="text-[11px] truncate block">{d.device || "—"}</span>} />
        <Info label={tr("infoOpeningCash")}  value={SAR(d.openingCash, locale)} />
        <Info label={tr("infoExpectedCash")} value={SAR(d.expectedCash, locale)} />
        <Info label={tr("infoClosingCash")}  value={SAR(d.closingCash, locale)} />
        <Info
          label={tr("infoDifference")}
          value={
            <span className={Number(d.difference || 0) === 0 ? "" :
              Number(d.difference || 0) > 0 ? "text-emerald-600 font-semibold" : "text-red-600 font-semibold"}>
              {d.difference != null ? SAR(d.difference, locale) : "—"}
            </span>
          }
        />
      </div>

      <div className="grid grid-cols-3 gap-3 pt-3 border-t">
        <div className="rounded-lg bg-blue-50 p-3 text-center">
          <div className="text-[11px] text-blue-700">{tr("totalSales")}</div>
          <div className="text-lg font-bold text-blue-900">{SAR(d.totalSales, locale)}</div>
        </div>
        <div className="rounded-lg bg-purple-50 p-3 text-center">
          <div className="text-[11px] text-purple-700">{tr("invoiceCount")}</div>
          <div className="text-lg font-bold text-purple-900">{d.invoiceCount}</div>
        </div>
        <div className="rounded-lg bg-emerald-50 p-3 text-center">
          <div className="text-[11px] text-emerald-700">{tr("avgInvoice")}</div>
          <div className="text-lg font-bold text-emerald-900">
            {SAR(d.invoiceCount ? d.totalSales / d.invoiceCount : 0, locale)}
          </div>
        </div>
      </div>

      <div>
        <h4 className="font-semibold mb-2 flex items-center gap-2">
          <ReceiptText className="w-4 h-4" />
          {tr("sessionInvoices", { count: d.invoices.length })}
        </h4>
        <div className="rounded-lg border max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs sticky top-0">
              <tr className={isRtl ? "text-right" : "text-left"}>
                <th className="p-2">{tr("invColNo")}</th>
                <th className="p-2">{tr("invColDate")}</th>
                <th className="p-2">{tr("invColPayment")}</th>
                <th className="p-2">{tr("invColStatus")}</th>
                <th className={`p-2 ${isRtl ? "text-left" : "text-right"}`}>{tr("invColTotal")}</th>
              </tr>
            </thead>
            <tbody>
              {d.invoices.length === 0 && (
                <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">{tr("noInvoicesYet")}</td></tr>
              )}
              {d.invoices.map(i => (
                <tr key={i.id} className="border-t">
                  <td className="p-2 font-mono text-xs">{i.docNumber || `#${i.id}`}</td>
                  <td className="p-2 text-xs">{new Date(i.createdAt).toLocaleTimeString(locale)}</td>
                  <td className="p-2 text-xs">{i.paymentType === "cash" ? tr("paymentCash") : i.paymentType || "—"}</td>
                  <td className="p-2 text-xs">
                    {i.status === "posted"
                      ? <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">{tr("statusPosted")}</Badge>
                      : <Badge variant="secondary">{i.status}</Badge>}
                  </td>
                  <td className={`p-2 ${isRtl ? "text-left" : "text-right"} tabular-nums font-medium`}>{SAR(i.totalAmount, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {d.status === "open" && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200">
          <AlertCircle className="w-4 h-4 text-amber-700 shrink-0" />
          <div className="flex-1 text-xs text-amber-900">
            {tr("stillOpenNotice")}
          </div>
          <Button size="sm" variant="outline" onClick={() => { if (confirm(tr("forceCloseConfirmFinal"))) onForceClose(); }}>
            <Lock className="w-3 h-3 me-1" />
            {tr("forceCloseTitle")}
          </Button>
        </div>
      )}

      {d.closedNotes && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">{tr("closedNotes")}</span> {d.closedNotes}
        </div>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: any }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium mt-0.5">{value}</div>
    </div>
  );
}
