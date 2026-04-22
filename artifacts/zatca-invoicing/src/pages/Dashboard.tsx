import React from "react";
import {
  useGetDashboardSummary,
  useGetRecentInvoices,
  useGetMonthlyStats,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FileText, CheckCircle2, XCircle, FileWarning, TrendingUp, ShieldCheck,
  Plus, Users, Truck, Package, Wallet, BookOpen, ArrowUpRight, Receipt,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { arSA } from "date-fns/locale";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

// ─── KPI Tile (SAP Fiori-style) ────────────────────────────────────────────────
type Tone = "primary" | "success" | "warning" | "danger" | "info";
const toneStyles: Record<Tone, { bar: string; iconBg: string; iconFg: string }> = {
  primary: { bar: "bg-primary",       iconBg: "bg-primary/10",       iconFg: "text-primary"       },
  success: { bar: "bg-emerald-500",   iconBg: "bg-emerald-50",       iconFg: "text-emerald-600"   },
  warning: { bar: "bg-amber-500",     iconBg: "bg-amber-50",         iconFg: "text-amber-600"     },
  danger:  { bar: "bg-rose-500",      iconBg: "bg-rose-50",          iconFg: "text-rose-600"      },
  info:    { bar: "bg-sky-500",       iconBg: "bg-sky-50",           iconFg: "text-sky-600"       },
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
            {hint && <p className="text-[11px] text-muted-foreground mt-1.5">{hint}</p>}
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

export default function Dashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const companyId = user?.companyId;

  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary(undefined, {
    query: { queryKey: ["dashboard-summary", companyId] },
  });

  const ownCompany = user?.company;
  const isNotRegistered = ownCompany && !ownCompany.zatcaPcsid;

  const { data: recentInvoices, isLoading: loadingRecent } = useGetRecentInvoices(undefined, {
    query: { queryKey: ["recent-invoices", companyId] },
  });

  const { data: monthlyStats, isLoading: loadingStats } = useGetMonthlyStats(undefined, {
    query: { queryKey: ["monthly-stats", companyId] },
  });

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR" }).format(amount);

  const chartData =
    monthlyStats?.map(stat => ({
      name: stat.month,
      [t("pages.dashboard.revenue")]: stat.revenue,
      [t("pages.dashboard.vat")]: stat.vatAmount,
      [t("pages.dashboard.invoices")]: stat.invoiceCount,
    })) || [];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">{t("pages.dashboard.title")}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t("pages.dashboard.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link href="/invoices"><FileText className="h-4 w-4" />{t("pages.dashboard.invoices")}</Link>
          </Button>
          <Button asChild size="sm" className="gap-1.5">
            <Link href="/invoices/new"><Plus className="h-4 w-4" />{t("pages.dashboard.newInvoice")}</Link>
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

      {/* KPI tiles */}
      {loadingSummary ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="rounded-xl border bg-card p-5">
              <Skeleton className="h-4 w-24 mb-3" />
              <Skeleton className="h-8 w-20" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label={t("pages.dashboard.totalRevenue")}
            value={formatCurrency(summary?.totalRevenue || 0)}
            icon={TrendingUp}
            tone="primary"
            hint={t("pages.dashboard.totalVatHint", { amount: formatCurrency(summary?.totalVat || 0) })}
          />
          <KpiTile
            label={t("pages.dashboard.issuedInvoices")}
            value={summary?.issuedCount || 0}
            icon={CheckCircle2}
            tone="success"
            hint={t("pages.dashboard.zatcaApproved")}
            href="/invoices"
          />
          <KpiTile
            label={t("pages.dashboard.drafts")}
            value={summary?.draftCount || 0}
            icon={FileWarning}
            tone="warning"
            hint={t("pages.dashboard.pendingIssue")}
            href="/invoices"
          />
          <KpiTile
            label={t("pages.dashboard.cancelledInvoices")}
            value={summary?.cancelledCount || 0}
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
          <QuickAction href="/invoices/new"     icon={Receipt}   label={t("pages.dashboard.newInvoice")}     color="bg-primary" />
          <QuickAction href="/customers/new"    icon={Users}     label={t("pages.dashboard.newCustomer")}        color="bg-sky-500" />
          <QuickAction href="/suppliers/new"    icon={Truck}     label={t("pages.dashboard.newSupplier")}        color="bg-indigo-500" />
          <QuickAction href="/inventory/items"  icon={Package}   label={t("pages.dashboard.addItem")}        color="bg-emerald-500" />
          <QuickAction href="/cash/receipt-vouchers" icon={Wallet}    label={t("pages.dashboard.receiptVoucher")}     color="bg-amber-500" />
          <QuickAction href="/accounting/accounts"   icon={BookOpen}  label={t("pages.dashboard.chartOfAccounts")} color="bg-rose-500" />
        </div>
      </div>

      {/* Two-column: Chart + Recent invoices */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Monthly Stats Chart */}
        <Card className="xl:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-base">{t("pages.dashboard.monthlyRevenueStats")}</CardTitle>
                <CardDescription className="text-xs">{t("pages.dashboard.monthlyStatsDesc")}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loadingStats ? (
              <Skeleton className="h-[280px] w-full" />
            ) : (
              <div className="h-[280px] w-full" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={value => `${value / 1000}k`}
                    />
                    <Tooltip
                      cursor={{ fill: "hsl(var(--muted)/0.5)" }}
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        borderRadius: "8px",
                        border: "1px solid hsl(var(--border))",
                        fontSize: "12px",
                      }}
                    />
                    <Legend wrapperStyle={{ paddingTop: "16px", fontSize: "12px" }} />
                    <Bar dataKey={t("pages.dashboard.revenue")} fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={36} />
                    <Bar dataKey={t("pages.dashboard.vat")} fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} maxBarSize={36} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent invoices side panel */}
        <Card className="xl:col-span-1">
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
                recentInvoices.slice(0, 5).map(invoice => {
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
                          <p className="text-xs font-semibold tabular-nums">{formatCurrency(invoice.grandTotal)}</p>
                        </div>
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                          {format(new Date(invoice.issueDate), "PP", { locale: arSA })}
                        </p>
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
