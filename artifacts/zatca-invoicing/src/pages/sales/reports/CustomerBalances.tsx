import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { Wallet, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { cn } from "@/lib/utils";

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}
function withBranch(url: string, branchId?: number) {
  if (branchId === undefined) return url;
  return url + (url.includes("?") ? "&" : "?") + "branchId=" + branchId;
}

const EXPORT_COLS = [
  { key: "customerNameAr", header: "العميل", width: 32 },
  { key: "phone",          header: "الهاتف", width: 18 },
  { key: "city",           header: "المدينة", width: 18 },
  { key: "balance",        header: "الرصيد", width: 16 },
  { key: "status",         header: "الحالة", width: 14 },
];

export default function CustomerBalances() {
  const { fmt } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "debit" | "credit">("all");
  const [branchId, setBranchId] = useState<number | undefined>(undefined);

  const { data: customers = [] } = useQuery({
    queryKey: ["customers", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authHeaders() });
      return r.json();
    },
  });
  const { data: balances = [], isLoading } = useQuery({
    queryKey: ["customer-balances", cid, branchId],
    queryFn: async () => {
      const base = cid ? `${API}/api/customers/balances?companyId=${cid}` : `${API}/api/customers/balances`;
      const r = await fetch(withBranch(base, branchId), { headers: authHeaders() });
      return r.json();
    },
  });

  const balByCustomer: Record<number, number> = {};
  (balances as any[]).forEach(b => { balByCustomer[b.customerId] = Number(b.balance); });

  const enriched = useMemo(() =>
    (customers as any[])
      .map(c => ({ ...c, balance: balByCustomer[c.id] ?? 0 }))
      // When a branch is selected, hide customers with no movement in that branch (balance = 0).
      .filter(c => branchId === undefined || c.balance !== 0)
      .filter(c =>
        (filter === "all" ? true : filter === "debit" ? c.balance > 0 : c.balance < 0) &&
        (!search || c.nameAr?.includes(search) || c.phone?.includes(search))
      )
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)),
    [customers, balances, search, filter, branchId]
  );

  const totalDebit  = enriched.filter(c => c.balance > 0).reduce((s, c) => s + c.balance, 0);
  const totalCredit = enriched.filter(c => c.balance < 0).reduce((s, c) => s - c.balance, 0);
  const net = totalDebit - totalCredit;

  const exportRows = enriched.map(c => ({
    customerNameAr: c.nameAr ?? "",
    phone:          c.phone ?? "",
    city:           c.city ?? "",
    balance:        fmt(c.balance),
    status:         c.balance > 0 ? "مدين" : c.balance < 0 ? "دائن" : "صفر",
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="h-6 w-6 text-primary" />أرصدة العملاء</h1>
          <p className="text-muted-foreground text-sm mt-1">ملخص أرصدة جميع العملاء (موجب = مدين، سالب = دائن)</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`أرصدة-العملاء-${new Date().toISOString().slice(0, 10)}`}
          title="تقرير أرصدة العملاء"
          subtitle={`صافي المديونية: ${fmt(net)} ر.س`}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-blue-50 border-blue-200 p-4">
          <p className="text-xs text-blue-700">إجمالي المدين (مستحق علينا منهم)</p>
          <p className="text-2xl font-bold text-blue-700 tabular-nums mt-1">{fmt(totalDebit)}</p>
        </div>
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
          <p className="text-xs text-emerald-700">إجمالي الدائن (مدفوعات زائدة)</p>
          <p className="text-2xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totalCredit)}</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
          <p className="text-xs text-muted-foreground">صافي المديونية</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{fmt(net)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
        <div className="relative sm:col-span-2">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pr-9" placeholder="بحث بالاسم أو الهاتف..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <BranchFilter value={branchId} onChange={setBranchId} />
        <select className="border rounded-md px-3 py-2 text-sm bg-card h-9" value={filter} onChange={e => setFilter(e.target.value as any)}>
          <option value="all">كل العملاء</option>
          <option value="debit">المدينون فقط</option>
          <option value="credit">الدائنون فقط</option>
        </select>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">العميل</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">الهاتف</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">المدينة</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الرصيد</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={5} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : enriched.length === 0
                ? <tr><td colSpan={5} className="py-12 text-center text-muted-foreground">لا توجد بيانات للعرض</td></tr>
                : enriched.map(c => (
                    <tr key={c.id} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <p className="font-medium text-sm">{c.nameAr ?? "—"}</p>
                        {c.nameEn && <p className="text-[10px] text-muted-foreground">{c.nameEn}</p>}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground font-mono">{c.phone ?? "—"}</td>
                      <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">{c.city ?? "—"}</td>
                      <td className={cn("px-4 py-3 text-center tabular-nums font-bold",
                        c.balance > 0 ? "text-blue-600" : c.balance < 0 ? "text-emerald-600" : "text-muted-foreground")}>
                        {fmt(c.balance)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {c.balance > 0
                          ? <span className="text-[10px] bg-blue-50 text-blue-600 rounded-full px-2 py-0.5 font-medium">مدين</span>
                          : c.balance < 0
                          ? <span className="text-[10px] bg-emerald-50 text-emerald-700 rounded-full px-2 py-0.5 font-medium">دائن</span>
                          : <span className="text-[10px] bg-muted rounded-full px-2 py-0.5 font-medium">صفر</span>}
                      </td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && enriched.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={3} className="px-4 py-3 text-xs font-bold">صافي ({enriched.length} عميل)</td>
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
