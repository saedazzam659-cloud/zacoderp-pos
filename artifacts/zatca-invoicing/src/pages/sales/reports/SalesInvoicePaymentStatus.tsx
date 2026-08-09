import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { DateField } from "@/components/ui/date-field";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { CircleDollarSign, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { cn } from "@/lib/utils";
import { Link } from "wouter";

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

type Row = {
  id: number; docNumber: string | null; date: string; customerId: number;
  customerNameAr: string | null; customerNameEn: string | null;
  total: number; returns: number; netDue: number; paid: number; remaining: number;
  status: "unpaid" | "partial" | "paid";
};

export default function SalesInvoicePaymentStatus() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`invoicePaymentStatus.${k}`, opts) as string;
  const pickName = (ar?: string | null, en?: string | null) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "—";
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"open" | "all" | "unpaid" | "partial" | "paid">("open");
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const today = new Date().toISOString().slice(0, 10);

  const { data, isLoading } = useQuery({
    queryKey: ["sales-invoice-payment-status", cid, branchId, from, to],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (cid) qs.set("companyId", String(cid));
      if (branchId) qs.set("branchId", String(branchId));
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      const r = await fetch(`${API}/api/sales-analytics/invoice-payment-status?${qs}`, { headers: authHeaders() });
      if (!r.ok) throw new Error("failed");
      const d = await r.json();
      return Array.isArray(d?.rows) ? (d.rows as Row[]) : [];
    },
  });
  const rows = data ?? [];

  const filtered = useMemo(() => rows
    .filter(r =>
      (status === "all" ? true
        : status === "open" ? r.status !== "paid"
        : r.status === status) &&
      (!search ||
        (r.docNumber ?? "").includes(search) ||
        (r.customerNameAr ?? "").includes(search) ||
        (r.customerNameEn ?? "").toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => b.remaining - a.remaining || b.date.localeCompare(a.date)),
    [rows, search, status]);

  const sums = useMemo(() => {
    const by = (st: Row["status"]) => rows.filter(r => r.status === st);
    return {
      unpaidCount: by("unpaid").length,
      unpaidAmt: by("unpaid").reduce((s, r) => s + r.remaining, 0),
      partialCount: by("partial").length,
      partialAmt: by("partial").reduce((s, r) => s + r.remaining, 0),
      paidCount: by("paid").length,
      totalRemaining: rows.reduce((s, r) => s + r.remaining, 0),
    };
  }, [rows]);

  const STATUS_BADGE: Record<Row["status"], { label: string; cls: string }> = {
    unpaid:  { label: tr("statusUnpaid"),  cls: "bg-red-50 text-red-700 border border-red-200" },
    partial: { label: tr("statusPartial"), cls: "bg-amber-50 text-amber-700 border border-amber-200" },
    paid:    { label: tr("statusPaid"),    cls: "bg-emerald-50 text-emerald-700 border border-emerald-200" },
  };

  const EXPORT_COLS = [
    { key: "docNumber", header: tr("colDocNumber"), width: 16 },
    { key: "date",      header: tr("colDate"),      width: 14 },
    { key: "party",     header: tr("colCustomer"),  width: 30 },
    { key: "netDue",    header: tr("colNetDue"),    width: 15 },
    { key: "paid",      header: tr("colPaid"),      width: 15 },
    { key: "remaining", header: tr("colRemaining"), width: 15 },
    { key: "status",    header: tr("colStatus"),    width: 14 },
  ];
  const exportRows = filtered.map(r => ({
    docNumber: r.docNumber ?? "", date: r.date,
    party: pickName(r.customerNameAr, r.customerNameEn),
    netDue: fmt(r.netDue), paid: fmt(r.paid), remaining: fmt(r.remaining),
    status: STATUS_BADGE[r.status].label,
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CircleDollarSign className="h-6 w-6 text-primary" />{tr("salesTitle")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("salesSubtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${tr("salesFilename")}-${today}`}
          title={tr("salesTitle")}
          subtitle={tr("exportSubtitle", { n: filtered.length, amount: fmt(sums.totalRemaining) })}
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <button onClick={() => setStatus("unpaid")} className={cn("text-start rounded-xl border p-4 transition", status === "unpaid" ? "ring-2 ring-red-300" : "", "bg-red-50 border-red-200")}>
          <p className="text-xs text-red-700">{tr("cardUnpaid", { n: sums.unpaidCount })}</p>
          <p className="text-2xl font-bold text-red-700 tabular-nums mt-1">{fmt(sums.unpaidAmt)}</p>
        </button>
        <button onClick={() => setStatus("partial")} className={cn("text-start rounded-xl border p-4 transition", status === "partial" ? "ring-2 ring-amber-300" : "", "bg-amber-50 border-amber-200")}>
          <p className="text-xs text-amber-700">{tr("cardPartial", { n: sums.partialCount })}</p>
          <p className="text-2xl font-bold text-amber-700 tabular-nums mt-1">{fmt(sums.partialAmt)}</p>
        </button>
        <button onClick={() => setStatus("paid")} className={cn("text-start rounded-xl border p-4 transition", status === "paid" ? "ring-2 ring-emerald-300" : "", "bg-emerald-50 border-emerald-200")}>
          <p className="text-xs text-emerald-700">{tr("cardPaid")}</p>
          <p className="text-2xl font-bold text-emerald-700 tabular-nums mt-1">{sums.paidCount}</p>
        </button>
        <button onClick={() => setStatus("open")} className={cn("text-start rounded-xl border p-4 transition", status === "open" ? "ring-2 ring-primary/30" : "", "bg-primary/5 border-primary/10")}>
          <p className="text-xs text-muted-foreground">{tr("cardRemainingTotal")}</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{fmt(sums.totalRemaining)}</p>
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
        <div className="relative sm:col-span-2">
          <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
          <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={tr("searchPhSales")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("common.branch")}</Label>
          <BranchFilter value={branchId} onChange={setBranchId} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{tr("fromDate")}</Label>
          <DateField value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{tr("toDate")}</Label>
          <DateField value={to} onChange={e => setTo(e.target.value)} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {([["open", tr("filterOpen")], ["all", tr("filterAll")], ["unpaid", tr("statusUnpaid")], ["partial", tr("statusPartial")], ["paid", tr("statusPaid")]] as const).map(([v, label]) => (
          <button key={v} onClick={() => setStatus(v)}
            className={cn("text-xs rounded-full px-3 py-1.5 border transition",
              status === v ? "bg-primary text-primary-foreground border-primary" : "bg-card hover:bg-muted/50")}>
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[800px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-start font-semibold text-muted-foreground">{tr("colDocNumber")}</th>
                <th className="px-4 py-3 text-start font-semibold text-muted-foreground">{tr("colDate")}</th>
                <th className="px-4 py-3 text-start font-semibold text-muted-foreground">{tr("colCustomer")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("colNetDue")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("colPaid")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("colRemaining")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground min-w-[140px]">{tr("colProgress")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("colStatus")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : filtered.length === 0
                ? <tr><td colSpan={8} className="py-12 text-center text-muted-foreground">{tr("noData")}</td></tr>
                : filtered.map(r => {
                    const pct = r.netDue > 0 ? Math.min(100, Math.round((r.paid / r.netDue) * 100)) : 0;
                    return (
                      <tr key={r.id} className="hover:bg-muted/20">
                        <td className="px-4 py-3 font-mono text-xs">
                          <Link href={`/sales/invoices/${r.id}`} className="text-primary hover:underline">{r.docNumber ?? "—"}</Link>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{r.date}</td>
                        <td className="px-4 py-3 font-medium">{pickName(r.customerNameAr, r.customerNameEn)}</td>
                        <td className="px-4 py-3 text-center tabular-nums">{fmt(r.netDue)}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-emerald-700">{fmt(r.paid)}</td>
                        <td className={cn("px-4 py-3 text-center tabular-nums font-bold", r.remaining > 0 ? "text-red-600" : "text-muted-foreground")}>{fmt(r.remaining)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                              <div className={cn("h-full rounded-full", pct >= 100 ? "bg-emerald-500" : pct > 0 ? "bg-amber-500" : "bg-red-400")} style={{ width: `${Math.max(pct, 3)}%` }} />
                            </div>
                            <span className="text-[10px] tabular-nums text-muted-foreground w-8">{pct}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn("text-[10px] rounded-full px-2 py-0.5 font-medium", STATUS_BADGE[r.status].cls)}>{STATUS_BADGE[r.status].label}</span>
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
            {!isLoading && filtered.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={3} className="px-4 py-3 text-xs font-bold">{tr("totalRow", { n: filtered.length })}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums">{fmt(filtered.reduce((s, r) => s + r.netDue, 0))}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(filtered.reduce((s, r) => s + r.paid, 0))}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums text-red-600">{fmt(filtered.reduce((s, r) => s + r.remaining, 0))}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
