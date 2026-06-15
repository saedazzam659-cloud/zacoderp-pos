import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { purchaseAnalyticsApi } from "@/lib/purchaseAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { CalendarRange } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { DateField } from "@/components/ui/date-field";

export default function PurchasesByPeriod() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState<"day" | "month">("day");
  const [branchId, setBranchId] = useState<number | undefined>(undefined);

  const EXPORT_COLS = [
    { key: "period",       header: t("purchasingReports.byPeriod.period"),       width: 16 },
    { key: "invoiceCount", header: t("purchasingReports.byPeriod.invoiceCount"), width: 14 },
    { key: "subtotal",     header: t("purchasingReports.byPeriod.subtotal"),     width: 16 },
    { key: "vatAmount",    header: t("purchasingReports.byPeriod.vat"),          width: 14 },
    { key: "totalAmount",  header: t("purchasingReports.byPeriod.totalAmount"),  width: 16 },
  ];

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["purchases-by-period", cid, from, to, groupBy, branchId],
    queryFn: () => purchaseAnalyticsApi.byPeriod(cid, from, to, groupBy, branchId),
  });

  const totals = (rows as any[]).reduce((s, r) => ({
    invoiceCount: s.invoiceCount + r.invoiceCount,
    subtotal: s.subtotal + r.subtotal,
    vatAmount: s.vatAmount + r.vatAmount,
    totalAmount: s.totalAmount + r.totalAmount,
  }), { invoiceCount: 0, subtotal: 0, vatAmount: 0, totalAmount: 0 });

  const maxAmount = Math.max(0, ...(rows as any[]).map(r => r.totalAmount));

  const exportRows = (rows as any[]).map(r => ({
    period:       r.period,
    invoiceCount: r.invoiceCount,
    subtotal:     fmt(r.subtotal),
    vatAmount:    fmt(r.vatAmount),
    totalAmount:  fmt(r.totalAmount),
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><CalendarRange className="h-6 w-6 text-primary" />{t("purchasingReports.byPeriod.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("purchasingReports.byPeriod.subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${groupBy === "day" ? t("purchasingReports.byPeriod.filenameDay") : t("purchasingReports.byPeriod.filenameMonth")}-${from}-${to}`}
          title={groupBy === "day" ? t("purchasingReports.byPeriod.exportTitleDay") : t("purchasingReports.byPeriod.exportTitleMonth")}
          subtitle={t("purchasingReports.byPeriod.subtitleTotal", { from, to, total: fmt(totals.totalAmount) })}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border bg-blue-50 border-blue-200 p-3">
          <p className="text-[11px] text-blue-700">{t("purchasingReports.byPeriod.periodCount")}</p>
          <p className="text-xl font-bold text-blue-700 tabular-nums mt-1">{(rows as any[]).length}</p>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <p className="text-[11px] text-muted-foreground">{t("purchasingReports.byPeriod.invoiceCount")}</p>
          <p className="text-xl font-bold tabular-nums mt-1">{totals.invoiceCount}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-3">
          <p className="text-[11px] text-amber-700">{t("purchasingReports.byPeriod.totalVat")}</p>
          <p className="text-xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totals.vatAmount)}</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-3">
          <p className="text-[11px] text-muted-foreground">{t("purchasingReports.byPeriod.totalAmount")}</p>
          <p className="text-xl font-bold tabular-nums mt-1">{fmt(totals.totalAmount)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="space-y-1.5">
          <Label>{t("purchasingPages.common.fromDate")}</Label>
          <DateField value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("purchasingPages.common.toDate")}</Label>
          <DateField value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("common.branch")}</Label>
          <BranchFilter value={branchId} onChange={setBranchId} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("purchasingReports.byPeriod.groupBy")}</Label>
          <select className="border rounded-md px-3 py-2 text-sm bg-card w-full" value={groupBy} onChange={e => setGroupBy(e.target.value as any)}>
            <option value="day">{t("purchasingReports.byPeriod.daily")}</option>
            <option value="month">{t("purchasingReports.byPeriod.monthly")}</option>
          </select>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{t("purchasingReports.byPeriod.period")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">{t("purchasingReports.byPeriod.invoiceCount")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">{t("purchasingReports.byPeriod.subtotal")}</th>
                <th className="px-3 py-3 text-center font-semibold text-amber-700 hidden md:table-cell">{t("purchasingReports.byPeriod.vat")}</th>
                <th className="px-3 py-3 text-center font-semibold text-blue-700">{t("purchasingReports.byPeriod.totalAmount")}</th>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden lg:table-cell`}>{t("purchasingReports.byPeriod.indicator")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : (rows as any[]).length === 0
                ? <tr><td colSpan={6} className="py-12 text-center text-muted-foreground">{t("purchasingReports.byPeriod.noData")}</td></tr>
                : (rows as any[]).map(r => {
                    const pct = maxAmount > 0 ? (r.totalAmount / maxAmount) * 100 : 0;
                    return (
                      <tr key={r.period} className="hover:bg-muted/20">
                        <td className="px-3 py-3 tabular-nums text-sm font-medium">{r.period}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-sm">{r.invoiceCount}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-xs hidden md:table-cell">{fmt(r.subtotal)}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-xs hidden md:table-cell">{fmt(r.vatAmount)}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-sm font-bold text-blue-600">{fmt(r.totalAmount)}</td>
                        <td className="px-3 py-3 hidden lg:table-cell">
                          <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
            {!isLoading && (rows as any[]).length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td className="px-3 py-3 text-xs font-bold">{t("purchasingReports.byPeriod.total")}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums">{totals.invoiceCount}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums hidden md:table-cell">{fmt(totals.subtotal)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums hidden md:table-cell">{fmt(totals.vatAmount)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-blue-700">{fmt(totals.totalAmount)}</td>
                  <td className="hidden lg:table-cell"></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
