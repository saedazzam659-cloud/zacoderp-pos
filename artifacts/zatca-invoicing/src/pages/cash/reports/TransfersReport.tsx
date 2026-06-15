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
import { ArrowLeftRight, Filter } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { DateField } from "@/components/ui/date-field";

export default function TransfersReport() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`cashReports.transfers.${k}`, opts) as string;
  const trc = (k: string, opts?: any) => t(`cashReports.common.${k}`, opts) as string;
  const dash = trc("noneCharDash");
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to,   setTo]   = useState(today);
  const [transferType, setTransferType] = useState<string>("all");
  const [branchId, setBranchId] = useState<number | undefined>(undefined);

  const COLS = [
    { key: "date",              header: trc("date"),     width: 12 },
    { key: "code",              header: tr("voucherNo"), width: 14 },
    { key: "transferTypeLabel", header: isRtl ? "نوع التحويل" : "Transfer Type", width: 18 },
    { key: "fromName",          header: tr("from"),      width: 22 },
    { key: "toName",            header: tr("to"),        width: 22 },
    { key: "description",       header: tr("description"), width: 24 },
    { key: "amount",            header: tr("amount"),    width: 16 },
  ];

  const { data = [], isLoading } = useQuery({
    queryKey: ["transfers-report", cid, from, to, transferType, branchId],
    queryFn: () => cashAnalyticsApi.transfers(cid, from, to, transferType === "all" ? undefined : transferType, branchId),
  });

  const total = data.reduce((s, r) => s + r.amount, 0);

  const exportRows = data.map(r => ({
    date: r.date, code: r.code,
    transferTypeLabel: r.transferTypeLabel,
    fromName: r.fromName, toName: r.toName,
    description: r.description ?? dash,
    amount: fmt(r.amount),
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ArrowLeftRight className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={COLS}
          filename={`${tr("filename")}-${from}-${to}`}
          title={tr("exportTitle")}
          subtitle={`${from} → ${to}`}
        />
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{isRtl ? "الفلاتر" : "Filters"}</h2>
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
            <Label>{isRtl ? "نوع التحويل" : "Transfer Type"}</Label>
            <Select value={transferType} onValueChange={setTransferType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{isRtl ? "الكل" : "All"}</SelectItem>
                <SelectItem value="cash_to_cash">{tr("type.cash_to_cash")}</SelectItem>
                <SelectItem value="cash_to_bank">{tr("type.cash_to_bank")}</SelectItem>
                <SelectItem value="bank_to_cash">{tr("type.bank_to_cash")}</SelectItem>
                <SelectItem value="bank_to_bank">{tr("type.bank_to_bank")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">{tr("count", { count: data.length })}</p>
          <p className="text-xl font-bold tabular-nums mt-1">{data.length}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-4 col-span-2">
          <p className="text-xs text-amber-700">{tr("totalAmount")}</p>
          <p className="text-2xl font-bold text-amber-700 tabular-nums mt-1">{fmt(total)}</p>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[800px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{trc("date")}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("voucherNo")}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{isRtl ? "نوع التحويل" : "Transfer Type"}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("from")}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("to")}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("description")}</th>
                <th className="px-4 py-3 text-center font-semibold text-amber-700">{tr("amount")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={7} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : data.length === 0
                ? <tr><td colSpan={7} className="py-12 text-center text-muted-foreground">{tr("noData")}</td></tr>
                : data.map(r => (
                    <tr key={r.id} className="hover:bg-muted/20">
                      <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{r.date}</td>
                      <td className="px-4 py-3 text-xs font-mono">{r.code}</td>
                      <td className="px-4 py-3 text-xs">{r.transferTypeLabel}</td>
                      <td className="px-4 py-3 text-xs">{r.fromName}</td>
                      <td className="px-4 py-3 text-xs">{r.toName}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{r.description ?? dash}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-amber-700">{fmt(r.amount)}</td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && data.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={6} className="px-4 py-3 text-xs font-semibold text-muted-foreground">{trc("totalRow")}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums text-amber-700">{fmt(total)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
