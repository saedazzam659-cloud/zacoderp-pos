import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { DateField } from "@/components/ui/date-field";
import { useTranslation } from "react-i18next";
import { Wallet, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { cn } from "@/lib/utils";

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}
function withParams(url: string, params: Record<string, string | number | undefined>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? url + (url.includes("?") ? "&" : "?") + s : url;
}

export default function CustomerBalances() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`salesReports.customerBalances.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "debit" | "credit">("all");
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const EXPORT_COLS = [
    { key: "customerName", header: tr("exportColCustomer"), width: 32 },
    { key: "phone",        header: tr("exportColPhone"),    width: 18 },
    { key: "city",         header: tr("exportColCity"),     width: 18 },
    { key: "balance",      header: tr("exportColBalance"),  width: 16 },
    { key: "status",       header: tr("exportColStatus"),   width: 14 },
  ];

  const { data: customers = [] } = useQuery({
    queryKey: ["customers", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authHeaders() });
      return r.json();
    },
  });
  const { data: balances = [], isLoading } = useQuery({
    queryKey: ["customer-balances", cid, branchId, from, to],
    queryFn: async () => {
      const base = cid ? `${API}/api/customers/balances?companyId=${cid}` : `${API}/api/customers/balances`;
      const r = await fetch(withParams(base, { branchId, from, to }), { headers: authHeaders() });
      return r.json();
    },
  });

  // Sister companies (الشركات الشقيقة): the user treats them as customers, so
  // their AR balances are merged into this report. Both endpoints are gated by
  // the `sister_companies` module — when disabled they 403, so we coerce any
  // non-array response to [] (per the list-query array-guard rule) and no
  // sister rows appear.
  const { data: sisters = [] } = useQuery({
    queryKey: ["sister-companies", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/sister-companies?companyId=${cid}` : `${API}/api/sister-companies`;
      const r = await fetch(url, { headers: authHeaders() });
      if (!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    },
  });
  const { data: sisterBalances = [] } = useQuery({
    queryKey: ["sister-balances", cid, from, to],
    queryFn: async () => {
      const base = cid ? `${API}/api/sister-companies/balances?companyId=${cid}` : `${API}/api/sister-companies/balances`;
      const r = await fetch(withParams(base, { from, to }), { headers: authHeaders() });
      if (!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    },
  });

  const balByCustomer: Record<number, number> = {};
  (balances as any[]).forEach(b => { balByCustomer[b.customerId] = Number(b.balance); });
  const balBySister: Record<number, number> = {};
  (sisterBalances as any[]).forEach(b => { balBySister[b.sisterCompanyId] = Number(b.balance); });

  const matchesFilters = (row: { balance: number; nameAr?: string; nameEn?: string; phone?: string }) =>
    ((branchId === undefined && !from && !to) || row.balance !== 0) &&
    (filter === "all" ? true : filter === "debit" ? row.balance > 0 : row.balance < 0) &&
    (!search || row.nameAr?.includes(search) || row.nameEn?.toLowerCase().includes(search.toLowerCase()) || row.phone?.includes(search));

  const enriched = useMemo(() => {
    const customerRows = (customers as any[])
      .map(c => ({ ...c, rowKey: `c-${c.id}`, isSister: false, balance: balByCustomer[c.id] ?? 0 }));
    const sisterRows = (sisters as any[])
      .map(s => ({ ...s, rowKey: `s-${s.id}`, isSister: true, city: null, balance: balBySister[s.id] ?? 0 }));
    return [...customerRows, ...sisterRows]
      .filter(matchesFilters)
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  },
    [customers, balances, sisters, sisterBalances, search, filter, branchId, from, to]
  );

  const totalDebit  = enriched.filter(c => c.balance > 0).reduce((s, c) => s + c.balance, 0);
  const totalCredit = enriched.filter(c => c.balance < 0).reduce((s, c) => s - c.balance, 0);
  const net = totalDebit - totalCredit;

  const exportRows = enriched.map(c => ({
    customerName: pickName(c.nameAr, c.nameEn) + (c.isSister ? ` (${tr("sisterBadge")})` : ""),
    phone:        c.phone ?? "",
    city:         c.city ?? "",
    balance:      fmt(c.balance),
    status:       c.balance > 0 ? tr("statusDebit") : c.balance < 0 ? tr("statusCredit") : tr("statusZero"),
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${tr("exportFilename")}-${new Date().toISOString().slice(0, 10)}`}
          title={tr("exportTitle")}
          subtitle={tr("exportSubtitle", { value: fmt(net) })}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-blue-50 border-blue-200 p-4">
          <p className="text-xs text-blue-700">{tr("totalDebit")}</p>
          <p className="text-2xl font-bold text-blue-700 tabular-nums mt-1">{fmt(totalDebit)}</p>
        </div>
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
          <p className="text-xs text-emerald-700">{tr("totalCredit")}</p>
          <p className="text-2xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totalCredit)}</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
          <p className="text-xs text-muted-foreground">{tr("net")}</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{fmt(net)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-6 gap-3 items-end">
        <div className="relative sm:col-span-2">
          <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
          <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={tr("searchPh")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">{tr("fromDate")}</label>
          <DateField value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">{tr("toDate")}</label>
          <DateField value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <BranchFilter value={branchId} onChange={setBranchId} />
        <select className="border rounded-md px-3 py-2 text-sm bg-card h-9" value={filter} onChange={e => setFilter(e.target.value as any)}>
          <option value="all">{tr("filterAll")}</option>
          <option value="debit">{tr("filterDebit")}</option>
          <option value="credit">{tr("filterCredit")}</option>
        </select>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colCustomer")}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden sm:table-cell`}>{tr("colPhone")}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden md:table-cell`}>{tr("colCity")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("colBalance")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("colStatus")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={5} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : enriched.length === 0
                ? <tr><td colSpan={5} className="py-12 text-center text-muted-foreground">{tr("noRows")}</td></tr>
                : enriched.map(c => (
                    <tr key={c.rowKey} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <p className="font-medium text-sm flex items-center gap-1.5 flex-wrap">
                          <span>{pickName(c.nameAr, c.nameEn) || "—"}</span>
                          {c.isSister && <span className="text-[9px] bg-purple-50 text-purple-700 rounded-full px-1.5 py-0.5 font-medium">{tr("sisterBadge")}</span>}
                        </p>
                        {(isRtl ? c.nameEn : c.nameAr) && <p className="text-[10px] text-muted-foreground">{isRtl ? c.nameEn : c.nameAr}</p>}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground font-mono">{c.phone ?? "—"}</td>
                      <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">{c.city ?? "—"}</td>
                      <td className={cn("px-4 py-3 text-center tabular-nums font-bold",
                        c.balance > 0 ? "text-blue-600" : c.balance < 0 ? "text-emerald-600" : "text-muted-foreground")}>
                        {fmt(c.balance)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {c.balance > 0
                          ? <span className="text-[10px] bg-blue-50 text-blue-600 rounded-full px-2 py-0.5 font-medium">{tr("statusDebit")}</span>
                          : c.balance < 0
                          ? <span className="text-[10px] bg-emerald-50 text-emerald-700 rounded-full px-2 py-0.5 font-medium">{tr("statusCredit")}</span>
                          : <span className="text-[10px] bg-muted rounded-full px-2 py-0.5 font-medium">{tr("statusZero")}</span>}
                      </td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && enriched.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={3} className="px-4 py-3 text-xs font-bold">{tr("footerLabel", { count: enriched.length })}</td>
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
