import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { purchaseAnalyticsApi } from "@/lib/purchaseAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Wallet, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { cn } from "@/lib/utils";

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export default function SupplierBalances() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "credit" | "debit">("all");
  const [branchId, setBranchId] = useState<number | undefined>(undefined);

  const today = new Date().toISOString().slice(0, 10);

  const EXPORT_COLS = [
    { key: "supplierNameAr", header: t("purchasingReports.supplierBalances.supplier"), width: 32 },
    { key: "phone",          header: t("purchasingReports.supplierBalances.phone"),    width: 18 },
    { key: "balance",        header: t("purchasingReports.supplierBalances.balance"),  width: 16 },
    { key: "status",         header: t("purchasingReports.supplierBalances.status"),   width: 14 },
  ];

  const { data: suppliers = [] } = useQuery({
    queryKey: ["suppliers", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`, { headers: authHeaders() });
      return r.json();
    },
  });
  const { data: aging = [], isLoading } = useQuery({
    queryKey: ["supplier-aging-balances", cid, today, branchId],
    queryFn: () => purchaseAnalyticsApi.aging(cid, today, branchId),
  });

  const balBySupplier: Record<number, number> = {};
  (aging as any[]).forEach(a => { balBySupplier[a.supplierId] = a.total; });

  const enriched = useMemo(() =>
    (suppliers as any[])
      .map(s => ({ ...s, balance: balBySupplier[s.id] ?? 0 }))
      .filter(s =>
        (filter === "all" ? true : filter === "credit" ? s.balance > 0 : s.balance < 0) &&
        (!search || s.nameAr?.includes(search) || s.nameEn?.toLowerCase().includes(search.toLowerCase()) || s.phone?.includes(search))
      )
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)),
    [suppliers, aging, search, filter]
  );

  const totalCredit = enriched.filter(s => s.balance > 0).reduce((sum, s) => sum + s.balance, 0);
  const totalDebit  = enriched.filter(s => s.balance < 0).reduce((sum, s) => sum - s.balance, 0);
  const net = totalCredit - totalDebit;

  const exportRows = enriched.map(s => ({
    supplierNameAr: (isRtl ? (s.nameAr ?? s.nameEn) : (s.nameEn ?? s.nameAr)) ?? "",
    phone:          s.phone ?? "",
    balance:        fmt(s.balance),
    status:         s.balance > 0
      ? t("purchasingReports.supplierBalances.creditWithLabel")
      : s.balance < 0
        ? t("purchasingReports.supplierBalances.debitWithLabel")
        : t("purchasingReports.supplierBalances.zeroLabel"),
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="h-6 w-6 text-primary" />{t("purchasingReports.supplierBalances.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("purchasingReports.supplierBalances.subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${t("purchasingReports.supplierBalances.filename")}-${today}`}
          title={t("purchasingReports.supplierBalances.exportTitle")}
          subtitle={t("purchasingReports.supplierBalances.subtitleNet", { net: fmt(net) })}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
          <p className="text-xs text-emerald-700">{t("purchasingReports.supplierBalances.totalCreditDesc")}</p>
          <p className="text-2xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totalCredit)}</p>
        </div>
        <div className="rounded-xl border bg-blue-50 border-blue-200 p-4">
          <p className="text-xs text-blue-700">{t("purchasingReports.supplierBalances.totalDebitDesc")}</p>
          <p className="text-2xl font-bold text-blue-700 tabular-nums mt-1">{fmt(totalDebit)}</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
          <p className="text-xs text-muted-foreground">{t("purchasingReports.supplierBalances.netDesc")}</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{fmt(net)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="relative sm:col-span-2">
          <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
          <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={t("purchasingReports.supplierBalances.searchPh")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("common.branch")}</Label>
          <BranchFilter value={branchId} onChange={setBranchId} />
        </div>
        <select className="border rounded-md px-3 py-2 text-sm bg-card" value={filter} onChange={e => setFilter(e.target.value as any)}>
          <option value="all">{t("purchasingReports.supplierBalances.filterAll")}</option>
          <option value="credit">{t("purchasingReports.supplierBalances.filterCredit")}</option>
          <option value="debit">{t("purchasingReports.supplierBalances.filterDebit")}</option>
        </select>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{t("purchasingReports.supplierBalances.supplier")}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden sm:table-cell`}>{t("purchasingReports.supplierBalances.phone")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{t("purchasingReports.supplierBalances.balance")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{t("purchasingReports.supplierBalances.status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={4} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : enriched.length === 0
                ? <tr><td colSpan={4} className="py-12 text-center text-muted-foreground">{t("purchasingReports.supplierBalances.noData")}</td></tr>
                : enriched.map(s => (
                    <tr key={s.id} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <p className="font-medium text-sm">{(isRtl ? (s.nameAr ?? s.nameEn) : (s.nameEn ?? s.nameAr)) ?? "—"}</p>
                        {(isRtl ? s.nameEn : s.nameAr) && <p className="text-[10px] text-muted-foreground">{isRtl ? s.nameEn : s.nameAr}</p>}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground font-mono">{s.phone ?? "—"}</td>
                      <td className={cn("px-4 py-3 text-center tabular-nums font-bold",
                        s.balance > 0 ? "text-emerald-600" : s.balance < 0 ? "text-blue-600" : "text-muted-foreground")}>
                        {fmt(s.balance)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {s.balance > 0
                          ? <span className="text-[10px] bg-emerald-50 text-emerald-700 rounded-full px-2 py-0.5 font-medium">{t("purchasingReports.supplierBalances.credit")}</span>
                          : s.balance < 0
                          ? <span className="text-[10px] bg-blue-50 text-blue-600 rounded-full px-2 py-0.5 font-medium">{t("purchasingReports.supplierBalances.debit")}</span>
                          : <span className="text-[10px] bg-muted rounded-full px-2 py-0.5 font-medium">{t("purchasingReports.supplierBalances.zero")}</span>}
                      </td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && enriched.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={2} className="px-4 py-3 text-xs font-bold">{t("purchasingReports.supplierBalances.totalRow", { n: enriched.length })}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums">{fmt(net)}</td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
