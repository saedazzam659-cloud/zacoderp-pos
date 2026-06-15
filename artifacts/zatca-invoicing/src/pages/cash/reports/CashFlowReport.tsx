import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { cashAnalyticsApi } from "@/lib/cashAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { CalendarRange, Filter } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { DateField } from "@/components/ui/date-field";

export default function CashFlowReport() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`cashReports.dailySummary.${k}`, opts) as string;
  const trc = (k: string, opts?: any) => t(`cashReports.common.${k}`, opts) as string;
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from,  setFrom]  = useState(firstDay);
  const [to,    setTo]    = useState(today);
  const [scope, setScope] = useState<"all" | "cash" | "bank">("all");
  const [branchId, setBranchId] = useState<number | undefined>(undefined);

  const COLS = [
    { key: "date",         header: trc("date"),       width: 14 },
    { key: "receiptCount", header: tr("txCount"),     width: 14 },
    { key: "totalIn",      header: tr("totalReceipts"), width: 18 },
    { key: "paymentCount", header: tr("txCount"),     width: 14 },
    { key: "totalOut",     header: tr("totalPayments"), width: 18 },
    { key: "net",          header: tr("net"),         width: 16 },
  ];

  const { data = [], isLoading } = useQuery({
    queryKey: ["daily-summary", cid, from, to, scope, branchId],
    queryFn: () => cashAnalyticsApi.dailySummary(cid, from, to, scope, branchId),
  });

  const totals = data.reduce((s, r) => ({
    receiptCount: s.receiptCount + r.receiptCount,
    paymentCount: s.paymentCount + r.paymentCount,
    totalIn:  s.totalIn + r.totalIn,
    totalOut: s.totalOut + r.totalOut,
    net:      s.net + r.net,
  }), { receiptCount: 0, paymentCount: 0, totalIn: 0, totalOut: 0, net: 0 });

  const exportRows = data.map(r => ({
    date: r.date,
    receiptCount: r.receiptCount,
    totalIn: fmt(r.totalIn),
    paymentCount: r.paymentCount,
    totalOut: fmt(r.totalOut),
    net: fmt(r.net),
  }));

  const scopeAll = isRtl ? "الكل" : "All";
  const scopeCash = isRtl ? "نقدي" : "Cash";
  const scopeBank = isRtl ? "بنكي" : "Bank";
  const scopeLabel = scope === "all" ? scopeAll : scope === "cash" ? scopeCash : scopeBank;

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><CalendarRange className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={COLS}
          filename={`${tr("filename")}-${from}-${to}`}
          title={tr("exportTitle")}
          subtitle={`${scopeLabel}  |  ${from} → ${to}`}
        />
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{trc("filtersReport")}</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label>{trc("fromDate")}</Label>
            <DateField value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{trc("toDate")}</Label>
            <DateField value={to} onChange={e => setTo(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common.branch")}</Label>
            <BranchFilter value={branchId} onChange={setBranchId} />
          </div>
          <div className="space-y-1.5">
            <Label>{isRtl ? "النطاق" : "Scope"}</Label>
            <Select value={scope} onValueChange={v => setScope(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{isRtl ? "الكل (نقدي + بنكي)" : "All (Cash + Bank)"}</SelectItem>
                <SelectItem value="cash">{isRtl ? "نقدي فقط" : "Cash only"}</SelectItem>
                <SelectItem value="bank">{isRtl ? "بنكي فقط" : "Bank only"}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
          <p className="text-xs text-emerald-700">{tr("totalReceipts")}</p>
          <p className="text-xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.totalIn)}</p>
          <p className="text-xs text-emerald-600/70 mt-1">{totals.receiptCount} {isRtl ? "سند قبض" : "receipt(s)"}</p>
        </div>
        <div className="rounded-xl border bg-rose-50 border-rose-200 p-4">
          <p className="text-xs text-rose-700">{tr("totalPayments")}</p>
          <p className="text-xl font-bold text-rose-700 tabular-nums mt-1">{fmt(totals.totalOut)}</p>
          <p className="text-xs text-rose-600/70 mt-1">{totals.paymentCount} {isRtl ? "سند صرف" : "payment(s)"}</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
          <p className="text-xs text-muted-foreground">{tr("netFlow")}</p>
          <p className={`text-xl font-bold tabular-nums mt-1 ${totals.net < 0 ? "text-rose-700" : ""}`}>{fmt(totals.net)}</p>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{trc("date")}</th>
                <th className="px-4 py-3 text-center font-semibold text-emerald-700">{isRtl ? "عدد المقبوضات" : "Receipt Count"}</th>
                <th className="px-4 py-3 text-center font-semibold text-emerald-700">{tr("totalReceipts")}</th>
                <th className="px-4 py-3 text-center font-semibold text-rose-700">{isRtl ? "عدد المدفوعات" : "Payment Count"}</th>
                <th className="px-4 py-3 text-center font-semibold text-rose-700">{tr("totalPayments")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("net")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : data.length === 0
                ? <tr><td colSpan={6} className="py-12 text-center text-muted-foreground">{tr("noData")}</td></tr>
                : data.map(r => (
                    <tr key={r.date} className="hover:bg-muted/20">
                      <td className="px-4 py-3 tabular-nums text-xs">{r.date}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-xs">{r.receiptCount}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-emerald-600">{fmt(r.totalIn)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-xs">{r.paymentCount}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-rose-600">{fmt(r.totalOut)}</td>
                      <td className={`px-4 py-3 text-center tabular-nums text-sm font-bold ${r.net < 0 ? "text-rose-700" : ""}`}>{fmt(r.net)}</td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && data.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td className="px-4 py-3 text-xs font-semibold text-muted-foreground">{trc("totalRow")}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums">{totals.receiptCount}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(totals.totalIn)}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums">{totals.paymentCount}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums text-rose-700">{fmt(totals.totalOut)}</td>
                  <td className={`px-4 py-3 text-center font-bold tabular-nums ${totals.net < 0 ? "text-rose-700" : ""}`}>{fmt(totals.net)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
