import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useGetDashboardSummary,
  useGetRecentInvoices,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FileText, CheckCircle2, XCircle, FileWarning, TrendingUp, ShieldCheck,
  Plus, Users, Truck, Package, Wallet, BookOpen, ArrowUpRight, Receipt,
  Calendar, Award, Star, BarChart3, PieChart as PieChartIcon,
  Bell, Activity, Clock, AlertTriangle, User as UserIcon,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { arSA, enUS } from "date-fns/locale";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  LineChart, Line, PieChart, Pie, Cell,
} from "recharts";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import SupportMessageCard from "@/components/SupportMessageCard";
import { usePermission } from "@/hooks/usePermission";
import { useFmt } from "@/hooks/use-fmt";
import BranchFilter from "@/components/BranchFilter";
import { dashboardOverviewApi, type DashboardOverview } from "@/lib/dashboardOverviewApi";

// ─── KPI Tile (SAP Fiori-style) ────────────────────────────────────────────────
type Tone = "primary" | "success" | "warning" | "danger" | "info" | "violet" | "amber";
const toneStyles: Record<Tone, { bar: string; iconBg: string; iconFg: string }> = {
  primary: { bar: "bg-primary",       iconBg: "bg-primary/10",       iconFg: "text-primary"       },
  success: { bar: "bg-emerald-500",   iconBg: "bg-emerald-50",       iconFg: "text-emerald-600"   },
  warning: { bar: "bg-amber-500",     iconBg: "bg-amber-50",         iconFg: "text-amber-600"     },
  danger:  { bar: "bg-rose-500",      iconBg: "bg-rose-50",          iconFg: "text-rose-600"      },
  info:    { bar: "bg-sky-500",       iconBg: "bg-sky-50",           iconFg: "text-sky-600"       },
  violet:  { bar: "bg-violet-500",    iconBg: "bg-violet-50",        iconFg: "text-violet-600"    },
  amber:   { bar: "bg-amber-500",     iconBg: "bg-amber-50",         iconFg: "text-amber-700"     },
};

function KpiTile({
  label, value, icon: Icon, tone, hint, href,
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ElementType;
  tone: Tone;
  hint?: string;
  href?: string;
}) {
  const { t } = useTranslation();
  const ts = toneStyles[tone];
  const body = (
    <div className="group relative overflow-hidden rounded-xl border bg-card shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5">
      <div className={cn("absolute inset-y-0 right-0 w-1", ts.bar)} />
      <div className="p-5 pr-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground tracking-wide">{label}</p>
            <p className="mt-2 text-2xl font-bold text-foreground tabular-nums truncate">{value}</p>
            {hint && <p className="text-[11px] text-muted-foreground mt-1.5 truncate">{hint}</p>}
          </div>
          <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", ts.iconBg)}>
            <Icon className={cn("h-5 w-5", ts.iconFg)} />
          </div>
        </div>
        {href && (
          <div className="mt-3 flex items-center text-[11px] font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity">
            {t("pages.dashboard.viewDetails")} <ArrowUpRight className="h-3 w-3 mr-1" />
          </div>
        )}
      </div>
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

// ─── Quick Action Tile ────────────────────────────────────────────────────────
function QuickAction({
  href, icon: Icon, label, color,
}: {
  href: string;
  icon: React.ElementType;
  label: string;
  color: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col items-center justify-center gap-2 p-4 rounded-xl border bg-card hover:border-primary/40 hover:shadow-md transition-all"
    >
      <div className={cn("flex h-11 w-11 items-center justify-center rounded-xl transition-transform group-hover:scale-110", color)}>
        <Icon className="h-5 w-5 text-white" />
      </div>
      <span className="text-xs font-medium text-foreground text-center leading-tight">{label}</span>
    </Link>
  );
}

// ─── Alert Tile ────────────────────────────────────────────────────────────────
function AlertTile({
  icon: Icon, label, count, desc, href, tone,
}: {
  icon: React.ElementType;
  label: string;
  count: number;
  desc: string;
  href: string;
  tone: "danger" | "warning" | "info" | "violet";
}) {
  const styles = {
    danger:  { ring: "border-rose-200 hover:border-rose-300",       iconBg: "bg-rose-50",    iconFg: "text-rose-600",    badge: "bg-rose-100 text-rose-800" },
    warning: { ring: "border-amber-200 hover:border-amber-300",     iconBg: "bg-amber-50",   iconFg: "text-amber-600",   badge: "bg-amber-100 text-amber-800" },
    info:    { ring: "border-sky-200 hover:border-sky-300",         iconBg: "bg-sky-50",     iconFg: "text-sky-600",     badge: "bg-sky-100 text-sky-800" },
    violet:  { ring: "border-violet-200 hover:border-violet-300",   iconBg: "bg-violet-50",  iconFg: "text-violet-600",  badge: "bg-violet-100 text-violet-800" },
  }[tone];
  const dim = count === 0;
  return (
    <Link
      href={href}
      className={cn(
        "block rounded-xl border bg-card p-4 transition-all hover:shadow-md",
        dim ? "opacity-70" : styles.ring,
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", styles.iconBg)}>
          <Icon className={cn("h-5 w-5", styles.iconFg)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground truncate">{label}</p>
            <span className={cn("text-xs font-bold px-2 py-0.5 rounded-full tabular-nums", styles.badge)}>
              {count}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 leading-tight">{desc}</p>
        </div>
      </div>
    </Link>
  );
}

// ─── Section Header ────────────────────────────────────────────────────────────
function SectionHeader({
  icon: Icon, title, desc, color,
}: {
  icon: React.ElementType;
  title: string;
  desc?: string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2.5 mb-3">
      <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg", color)}>
        <Icon className="h-4 w-4 text-white" />
      </div>
      <div>
        <h3 className="text-sm font-bold text-foreground leading-tight">{title}</h3>
        {desc && <p className="text-[11px] text-muted-foreground">{desc}</p>}
      </div>
    </div>
  );
}

// ─── Pie Colors ────────────────────────────────────────────────────────────────
const PAYMENT_COLORS: Record<string, string> = {
  cash:   "hsl(142 71% 45%)",  // emerald
  bank:   "hsl(217 91% 60%)",  // blue
  credit: "hsl(38 92% 50%)",   // amber
};
const PAYMENT_LABELS_AR: Record<string, string> = {
  cash: "نقدي", bank: "شبكة/بنك", credit: "آجل",
};
const PAYMENT_LABELS_EN: Record<string, string> = {
  cash: "Cash", bank: "Bank", credit: "Credit",
};

export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { fmtCurrency } = useFmt();
  const companyId = user?.companyId;
  const isArabic = i18n.language === "ar";
  const dateLocale = isArabic ? arSA : enUS;
  const pickName = (ar: string | null | undefined, en: string | null | undefined) =>
    (isArabic ? ar : (en || ar)) || ar || en || "—";

  const [branchId, setBranchId] = useState<number | undefined>(undefined);

  // Legacy summary still used for the existing 4 status tiles + recent invoices
  // (those endpoints already work and respect tenancy). We additively layer the
  // overview KPIs / charts / alerts / my-day on top.
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary(undefined, {
    query: { queryKey: ["dashboard-summary", companyId] },
  });

  const ownCompany = user?.company;
  const isNotRegistered = ownCompany && !ownCompany.zatcaPcsid;

  const canViewRecentInvoices = usePermission("dashboard_recent_invoices", "view");

  const { data: recentInvoices, isLoading: loadingRecent } = useGetRecentInvoices(undefined, {
    query: { queryKey: ["recent-invoices", companyId], enabled: canViewRecentInvoices },
  });

  // ── New integrated overview payload (KPIs + charts + alerts + myDay) ────────
  const { data: overview, isLoading: loadingOverview } = useQuery<DashboardOverview>({
    queryKey: ["dashboard-overview", companyId, branchId],
    queryFn: () => dashboardOverviewApi.overview({ branchId }),
    refetchInterval: 60_000, // light auto-refresh once per minute
    staleTime: 30_000,
  });

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">{t("pages.dashboard.title")}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t("pages.dashboard.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <BranchFilter value={branchId} onChange={setBranchId} className="min-w-[180px]" />
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link href="/invoices"><FileText className="h-4 w-4" />{t("pages.dashboard.invoices")}</Link>
          </Button>
          <Button asChild size="sm" className="gap-1.5">
            <Link href="/sales/invoices/new"><Plus className="h-4 w-4" />{t("pages.dashboard.newInvoice")}</Link>
          </Button>
        </div>
      </div>

      {/* ZATCA onboarding banner */}
      {isNotRegistered && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 p-4 rounded-xl border border-amber-200 bg-amber-50">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100">
            <ShieldCheck className="h-5 w-5 text-amber-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-amber-800 text-sm">{t("pages.dashboard.zatcaNotConnected")}</p>
            <p className="text-xs text-amber-700 mt-0.5">{t("pages.dashboard.zatcaNotConnectedDesc")}</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button asChild size="sm" className="gap-2 bg-amber-600 hover:bg-amber-700 text-white">
              <Link href="/zatca"><ShieldCheck className="h-4 w-4" />{t("pages.dashboard.connectNow")}</Link>
            </Button>
          </div>
        </div>
      )}

      {/* ─── KEY INDICATORS ──────────────────────────────────────────────── */}
      <div>
        <SectionHeader
          icon={TrendingUp}
          title={t("pages.dashboard.overview.kpiSection")}
          desc={t("pages.dashboard.overview.kpiSectionDesc")}
          color="bg-primary"
        />
        {loadingOverview ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
              <div key={i} className="rounded-xl border bg-card p-5">
                <Skeleton className="h-4 w-24 mb-3" />
                <Skeleton className="h-8 w-20" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              label={t("pages.dashboard.overview.todayNetSales")}
              value={fmtCurrency(overview?.kpis.todayNetSales ?? 0)}
              icon={Calendar}
              tone="primary"
              hint={t("pages.dashboard.overview.postedInvoices", { count: overview?.kpis.todayPostedCount ?? 0 })}
              href="/sales/invoices"
            />
            <KpiTile
              label={t("pages.dashboard.overview.weekNetSales")}
              value={fmtCurrency(overview?.kpis.weekNetSales ?? 0)}
              icon={TrendingUp}
              tone="info"
              hint={t("pages.dashboard.overview.postedInvoices", { count: overview?.kpis.weekInvoiceCount ?? 0 })}
            />
            <KpiTile
              label={t("pages.dashboard.overview.monthNetSales")}
              value={fmtCurrency(overview?.kpis.monthNetSales ?? 0)}
              icon={BarChart3}
              tone="violet"
              hint={t("pages.dashboard.overview.postedInvoices", { count: overview?.kpis.monthInvoiceCount ?? 0 })}
            />
            <KpiTile
              label={t("pages.dashboard.overview.avgInvoice")}
              value={fmtCurrency(overview?.kpis.avgInvoiceMonth ?? 0)}
              icon={Receipt}
              tone="success"
            />
            <KpiTile
              label={t("pages.dashboard.overview.cashCollected")}
              value={fmtCurrency(overview?.kpis.cashCollectedToday ?? 0)}
              icon={Wallet}
              tone="amber"
              hint={t("pages.dashboard.overview.receiptsCount", { count: overview?.kpis.cashReceiptsCount ?? 0 })}
              href="/cash/receipt-vouchers"
            />
            <KpiTile
              label={t("pages.dashboard.overview.todayInvoices")}
              value={overview?.kpis.todayInvoiceCount ?? 0}
              icon={FileText}
              tone="primary"
              hint={t("pages.dashboard.overview.postedInvoices", { count: overview?.kpis.todayPostedCount ?? 0 })}
              href="/sales/invoices"
            />
            <KpiTile
              label={t("pages.dashboard.overview.topCustomerLabel")}
              value={overview?.kpis.topCustomer
                ? pickName(overview.kpis.topCustomer.nameAr, overview.kpis.topCustomer.nameEn)
                : t("pages.dashboard.overview.noData")}
              icon={Award}
              tone="success"
              hint={overview?.kpis.topCustomer ? fmtCurrency(overview.kpis.topCustomer.total) : undefined}
            />
            <KpiTile
              label={t("pages.dashboard.overview.topItemLabel")}
              value={overview?.kpis.topItem?.name || t("pages.dashboard.overview.noData")}
              icon={Star}
              tone="warning"
              hint={overview?.kpis.topItem ? fmtCurrency(overview.kpis.topItem.total) : undefined}
            />
          </div>
        )}
      </div>

      {/* Legacy status tiles (issued / drafts / cancelled) — kept for permission-aware
          status visibility. They use the OLD invoicesTable so they reflect the legacy
          ZATCA-direct invoice flow. */}
      {!loadingSummary && summary && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiTile
            label={t("pages.dashboard.issuedInvoices")}
            value={summary.issuedCount || 0}
            icon={CheckCircle2}
            tone="success"
            hint={t("pages.dashboard.zatcaApproved")}
            href="/invoices"
          />
          <KpiTile
            label={t("pages.dashboard.drafts")}
            value={summary.draftCount || 0}
            icon={FileWarning}
            tone="warning"
            hint={t("pages.dashboard.pendingIssue")}
            href="/invoices"
          />
          <KpiTile
            label={t("pages.dashboard.cancelledInvoices")}
            value={summary.cancelledCount || 0}
            icon={XCircle}
            tone="danger"
            hint={t("pages.dashboard.cancelledOrReturned")}
          />
        </div>
      )}

      {/* Quick actions launchpad */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div>
            <h3 className="text-sm font-bold text-foreground">{t("pages.dashboard.quickActions")}</h3>
            <p className="text-[11px] text-muted-foreground">{t("pages.dashboard.quickActionsDesc")}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 p-4">
          <QuickAction href="/sales/invoices/new"      icon={Receipt}   label={t("pages.dashboard.newInvoice")}     color="bg-primary" />
          <QuickAction href="/customers/new"           icon={Users}     label={t("pages.dashboard.newCustomer")}    color="bg-sky-500" />
          <QuickAction href="/suppliers/new"           icon={Truck}     label={t("pages.dashboard.newSupplier")}    color="bg-indigo-500" />
          <QuickAction href="/inventory/items"         icon={Package}   label={t("pages.dashboard.addItem")}        color="bg-emerald-500" />
          <QuickAction href="/cash/receipt-vouchers"   icon={Wallet}    label={t("pages.dashboard.receiptVoucher")} color="bg-amber-500" />
          <QuickAction href="/accounting/accounts"     icon={BookOpen}  label={t("pages.dashboard.chartOfAccounts")} color="bg-rose-500" />
        </div>
      </div>

      {/* ─── INTERACTIVE CHARTS (2x2 grid) ──────────────────────────────── */}
      <div>
        <SectionHeader
          icon={BarChart3}
          title={t("pages.dashboard.overview.chartsSection")}
          desc={t("pages.dashboard.overview.chartsSectionDesc")}
          color="bg-violet-500"
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Sales 30d line */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t("pages.dashboard.overview.chartSales30d")}</CardTitle>
              <CardDescription className="text-xs">{t("pages.dashboard.overview.chartSales30dDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingOverview ? <Skeleton className="h-[220px] w-full" /> : (
                <div className="h-[220px] w-full" dir="ltr">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={overview?.charts.sales30d ?? []} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false}
                        tickFormatter={(d: string) => d.slice(5)} interval="preserveStartEnd" />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false}
                        tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                        formatter={(v: number) => fmtCurrency(v)}
                      />
                      <Line type="monotone" dataKey="total" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Payment mix pie */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t("pages.dashboard.overview.chartPaymentMix")}</CardTitle>
              <CardDescription className="text-xs">{t("pages.dashboard.overview.chartPaymentMixDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingOverview ? <Skeleton className="h-[220px] w-full" /> : (
                (overview?.charts.paymentMix?.length ?? 0) === 0 ? (
                  <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
                    {t("pages.dashboard.overview.noData")}
                  </div>
                ) : (
                  <div className="h-[220px] w-full" dir="ltr">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={overview?.charts.paymentMix ?? []}
                          dataKey="total"
                          nameKey="paymentType"
                          cx="50%" cy="50%"
                          innerRadius={50}
                          outerRadius={80}
                          paddingAngle={2}
                        >
                          {(overview?.charts.paymentMix ?? []).map((p, idx) => (
                            <Cell key={idx} fill={PAYMENT_COLORS[p.paymentType] ?? "hsl(var(--muted-foreground))"} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                          formatter={(v: number, _n, p: any) => [
                            fmtCurrency(v),
                            (isArabic ? PAYMENT_LABELS_AR : PAYMENT_LABELS_EN)[p?.payload?.paymentType] ?? p?.payload?.paymentType,
                          ]}
                        />
                        <Legend
                          formatter={(value: string) =>
                            (isArabic ? PAYMENT_LABELS_AR : PAYMENT_LABELS_EN)[value] ?? value
                          }
                          wrapperStyle={{ fontSize: 11 }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )
              )}
            </CardContent>
          </Card>

          {/* By branch bar */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t("pages.dashboard.overview.chartByBranch")}</CardTitle>
              <CardDescription className="text-xs">{t("pages.dashboard.overview.chartByBranchDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingOverview ? <Skeleton className="h-[220px] w-full" /> : (
                (overview?.charts.byBranch?.length ?? 0) === 0 ? (
                  <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
                    {t("pages.dashboard.overview.noData")}
                  </div>
                ) : (
                  <div className="h-[220px] w-full" dir="ltr">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={(overview?.charts.byBranch ?? []).map(b => ({
                        name: pickName(b.branchNameAr, b.branchNameEn),
                        total: b.total,
                      }))} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false}
                          tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
                        <Tooltip
                          contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                          formatter={(v: number) => fmtCurrency(v)}
                        />
                        <Bar dataKey="total" fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} maxBarSize={48} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )
              )}
            </CardContent>
          </Card>

          {/* Monthly 12m trend */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t("pages.dashboard.overview.chartMonthly12m")}</CardTitle>
              <CardDescription className="text-xs">{t("pages.dashboard.overview.chartMonthly12mDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingOverview ? <Skeleton className="h-[220px] w-full" /> : (
                <div className="h-[220px] w-full" dir="ltr">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={overview?.charts.monthly12m ?? []} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false}
                        tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                        formatter={(v: number) => fmtCurrency(v)}
                      />
                      <Bar dataKey="total" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={36} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ─── ALERTS & PRIORITIES ─────────────────────────────────────────── */}
      <div>
        <SectionHeader
          icon={AlertTriangle}
          title={t("pages.dashboard.overview.alertsSection")}
          desc={t("pages.dashboard.overview.alertsSectionDesc")}
          color="bg-rose-500"
        />
        {loadingOverview ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <AlertTile
                icon={ShieldCheck}
                label={t("pages.dashboard.overview.alertZatcaPending")}
                desc={t("pages.dashboard.overview.alertZatcaPendingDesc")}
                count={overview?.alerts.zatcaPendingCount ?? 0}
                href="/sales/invoices"
                tone="danger"
              />
              <AlertTile
                icon={Package}
                label={t("pages.dashboard.overview.alertLowStock")}
                desc={t("pages.dashboard.overview.alertLowStockDesc")}
                count={overview?.alerts.lowStockCount ?? 0}
                href="/inventory/items"
                tone="warning"
              />
              <AlertTile
                icon={Activity}
                label={t("pages.dashboard.overview.alertOpenSessions")}
                desc={t("pages.dashboard.overview.alertOpenSessionsDesc")}
                count={overview?.alerts.openPosSessionsCount ?? 0}
                href="/pos"
                tone="info"
              />
              <AlertTile
                icon={Bell}
                label={t("pages.dashboard.overview.alertNotifications")}
                desc={t("pages.dashboard.overview.alertNotificationsDesc")}
                count={overview?.alerts.unreadNotificationsCount ?? 0}
                href="/notifications"
                tone="violet"
              />
            </div>

            {/* Sample lists for the two visual alerts that benefit from previews */}
            {((overview?.alerts.lowStockSample.length ?? 0) > 0 || (overview?.alerts.openSessionsSample.length ?? 0) > 0) && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
                {(overview?.alerts.lowStockSample.length ?? 0) > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{t("pages.dashboard.overview.lowStockHeading")}</CardTitle>
                    </CardHeader>
                    <CardContent className="px-0 pb-2">
                      <div className="divide-y">
                        {overview!.alerts.lowStockSample.map(item => (
                          <Link
                            key={item.itemId}
                            href={`/inventory/items`}
                            className="flex items-center gap-3 px-5 py-2.5 hover:bg-muted/40 transition-colors"
                          >
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                              <Package className="h-4 w-4" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{pickName(item.nameAr, item.nameEn)}</p>
                              <p className="text-[11px] text-muted-foreground tabular-nums">
                                {t("pages.dashboard.overview.currentQty")}: <span className="font-semibold text-rose-600">{item.currentQty}</span>
                                {" · "}
                                {t("pages.dashboard.overview.reorderLevel")}: <span className="font-semibold">{item.reorderLevel}</span>
                              </p>
                            </div>
                          </Link>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}
                {(overview?.alerts.openSessionsSample.length ?? 0) > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{t("pages.dashboard.overview.openSessionsHeading")}</CardTitle>
                    </CardHeader>
                    <CardContent className="px-0 pb-2">
                      <div className="divide-y">
                        {overview!.alerts.openSessionsSample.map(s => (
                          <Link
                            key={s.id}
                            href="/pos"
                            className="flex items-center gap-3 px-5 py-2.5 hover:bg-muted/40 transition-colors"
                          >
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                              <Activity className="h-4 w-4" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">#{s.id} · {fmtCurrency(s.openingCash)}</p>
                              <p className="text-[11px] text-muted-foreground">
                                {t("pages.dashboard.overview.openSession", {
                                  time: format(new Date(s.openedAt), "PPp", { locale: dateLocale }),
                                })}
                              </p>
                            </div>
                          </Link>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ─── MY DAY + RECENT INVOICES (side-panel) ───────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* My Day card */}
        <Card className="xl:col-span-1">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500">
                <UserIcon className="h-4 w-4 text-white" />
              </div>
              <div>
                <CardTitle className="text-sm">{t("pages.dashboard.overview.myDaySection")}</CardTitle>
                <CardDescription className="text-xs">{t("pages.dashboard.overview.myDaySectionDesc")}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {loadingOverview ? (
              <>
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-32 w-full" />
              </>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg border bg-muted/30 p-2.5 text-center">
                    <p className="text-[10px] text-muted-foreground">{t("pages.dashboard.overview.myTodaySales")}</p>
                    <p className="text-sm font-bold tabular-nums truncate mt-0.5">{fmtCurrency(overview?.myDay.myTodayNetSales ?? 0)}</p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-2.5 text-center">
                    <p className="text-[10px] text-muted-foreground">{t("pages.dashboard.overview.myTodayInvoices")}</p>
                    <p className="text-sm font-bold tabular-nums mt-0.5">{overview?.myDay.myTodayInvoiceCount ?? 0}</p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-2.5 text-center">
                    <p className="text-[10px] text-muted-foreground">{t("pages.dashboard.overview.myDrafts")}</p>
                    <p className="text-sm font-bold tabular-nums mt-0.5">{overview?.myDay.myDraftsCount ?? 0}</p>
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-2">{t("pages.dashboard.overview.myRecentActivity")}</p>
                  <div className="divide-y rounded-lg border">
                    {(overview?.myDay.myRecentInvoices.length ?? 0) === 0 ? (
                      <div className="p-4 text-center text-xs text-muted-foreground">
                        {t("pages.dashboard.overview.noMyActivity")}
                      </div>
                    ) : (
                      overview!.myDay.myRecentInvoices.map(inv => {
                        const tone =
                          inv.status === "posted"    ? "bg-emerald-50 text-emerald-700"
                        : inv.status === "draft"     ? "bg-amber-50 text-amber-700"
                        :                              "bg-rose-50 text-rose-700";
                        return (
                          <Link
                            key={inv.id}
                            href={`/sales/invoices/${inv.id}`}
                            className="flex items-center gap-2 px-3 py-2 hover:bg-muted/40 transition-colors"
                          >
                            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium truncate">{inv.docNumber || `#${inv.id}`}</p>
                              <p className="text-[10px] text-muted-foreground tabular-nums">{fmtCurrency(inv.totalAmount)}</p>
                            </div>
                            <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0", tone)}>
                              {inv.status === "posted"    ? t("pages.dashboard.statusIssued")
                              : inv.status === "draft"     ? t("pages.dashboard.statusDraft")
                              :                              t("pages.dashboard.statusCancelled")}
                            </span>
                          </Link>
                        );
                      })
                    )}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Recent invoices side panel — gated by `dashboard_recent_invoices` permission */}
        {canViewRecentInvoices && (
        <Card className="xl:col-span-2">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">{t("pages.dashboard.recentInvoices")}</CardTitle>
              <CardDescription className="text-xs">{t("pages.dashboard.recentInvoicesDesc")}</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm" className="h-7 text-xs gap-1">
              <Link href="/invoices">{t("pages.dashboard.viewAll")} <ArrowUpRight className="h-3 w-3" /></Link>
            </Button>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            <div className="divide-y">
              {loadingRecent ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="px-5 py-3 flex items-center gap-3">
                    <Skeleton className="h-9 w-9 rounded-lg" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-20" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                  </div>
                ))
              ) : !recentInvoices || recentInvoices.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">{t("pages.dashboard.noRecentInvoices")}</div>
              ) : (
                recentInvoices.slice(0, 6).map(invoice => {
                  const statusStyle =
                    invoice.status === "issued"
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : invoice.status === "draft"
                      ? "bg-amber-50 text-amber-700 border-amber-200"
                      : "bg-rose-50 text-rose-700 border-rose-200";
                  const statusText =
                    invoice.status === "issued"
                      ? t("pages.dashboard.statusIssued")
                      : invoice.status === "draft"
                      ? t("pages.dashboard.statusDraft")
                      : t("pages.dashboard.statusCancelled");
                  return (
                    <Link
                      key={invoice.id}
                      href={`/invoices/${invoice.id}`}
                      className="flex items-center gap-3 px-5 py-3 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <FileText className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold truncate">{invoice.invoiceNumber}</p>
                          <span className={cn("text-[10px] font-medium border px-1.5 py-0.5 rounded-full shrink-0", statusStyle)}>
                            {statusText}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-0.5">
                          <p className="text-xs text-muted-foreground truncate">
                            {invoice.customer?.nameAr || t("pages.dashboard.cashCustomer")}
                          </p>
                          <p className="text-xs font-semibold tabular-nums">{fmtCurrency(invoice.grandTotal)}</p>
                        </div>
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                          {format(new Date(invoice.issueDate), "PP", { locale: dateLocale })}
                        </p>
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
        )}
      </div>

      {/* Support message — bottom of dashboard */}
      <SupportMessageCard />
    </div>
  );
}
