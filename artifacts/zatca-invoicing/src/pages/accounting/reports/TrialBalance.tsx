import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import ExportButtons from "@/components/ExportButtons";
import { Scale, Search, Printer } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const fmt = (n: number) => n === 0 ? "" : n.toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtAbs = (n: number) => Math.abs(n).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TYPE_LABELS: Record<string, string> = {
  asset: "أصول", liability: "التزامات", equity: "حقوق ملكية",
  revenue: "إيرادات", expense: "مصروفات",
};

const EXPORT_COLS = [
  { key: "code",        header: "الكود",         width: 12 },
  { key: "nameAr",      header: "اسم الحساب",    width: 36 },
  { key: "accountType", header: "النوع",          width: 14 },
  { key: "totalDebit",  header: "إجمالي مدين",   width: 16 },
  { key: "totalCredit", header: "إجمالي دائن",   width: 16 },
  { key: "balDebit",    header: "رصيد مدين",     width: 16 },
  { key: "balCredit",   header: "رصيد دائن",     width: 16 },
];

export default function TrialBalance() {
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}` };

  const today = new Date().toISOString().slice(0, 10);
  const firstOfYear = today.slice(0, 4) + "-01-01";

  const [fromDate, setFromDate] = useState(firstOfYear);
  const [toDate, setToDate]     = useState(today);
  const [searched, setSearched] = useState(false);

  const { data: rows = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ["trial-balance", cid, fromDate, toDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid)     params.set("companyId", String(cid));
      if (fromDate) params.set("fromDate", fromDate);
      if (toDate)   params.set("toDate", toDate);
      const res = await fetch(`${API}/api/accounting-reports/trial-balance?${params}`, { headers });
      return res.json();
    },
    enabled: searched,
    select: (data) => data.filter((r: any) => r.totalDebit > 0 || r.totalCredit > 0),
  });

  const totalDr  = rows.reduce((s, r) => s + r.totalDebit,  0);
  const totalCr  = rows.reduce((s, r) => s + r.totalCredit, 0);
  const balDrTot = rows.reduce((s, r) => s + Math.max(0,  r.balance), 0);
  const balCrTot = rows.reduce((s, r) => s + Math.max(0, -r.balance), 0);

  const exportRows = rows.map((r: any) => ({
    code:        r.code,
    nameAr:      r.nameAr,
    accountType: TYPE_LABELS[r.accountType] ?? r.accountType,
    totalDebit:  r.totalDebit  > 0 ? fmtAbs(r.totalDebit)  : "",
    totalCredit: r.totalCredit > 0 ? fmtAbs(r.totalCredit) : "",
    balDebit:    r.balance > 0 ? fmtAbs(r.balance) : "",
    balCredit:   r.balance < 0 ? fmtAbs(r.balance) : "",
  }));

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Scale className="h-6 w-6 text-primary" />
            ميزان المراجعة بالمجاميع
          </h1>
          <p className="text-sm text-muted-foreground mt-1">مجاميع الحركات والأرصدة لكل الحسابات</p>
        </div>
        <div className="flex gap-2">
          {rows.length > 0 && (
            <>
              <ExportButtons rows={exportRows} columns={EXPORT_COLS}
                filename={`ميزان-مراجعة-${fromDate}-${toDate}`}
                title={`ميزان المراجعة بالمجاميع — من ${fromDate} إلى ${toDate}`} />
              <Button variant="outline" size="sm" className="gap-2" onClick={() => window.print()}>
                <Printer className="h-4 w-4" />طباعة
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
          <div className="space-y-1.5">
            <Label>من تاريخ</Label>
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>إلى تاريخ</Label>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
          </div>
          <Button className="gap-2" onClick={() => { setSearched(true); refetch(); }} disabled={isLoading}>
            <Search className="h-4 w-4" />
            {isLoading ? "جاري التحميل..." : "عرض الميزان"}
          </Button>
        </div>
      </div>

      {searched && !isLoading && rows.length === 0 && (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          لا توجد قيود في الفترة المحددة
        </div>
      )}

      {rows.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
          {/* Balance indicator */}
          <div className={cn(
            "flex items-center justify-between px-5 py-2.5 text-sm font-semibold border-b",
            Math.abs(totalDr - totalCr) < 0.01 ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          )}>
            <span>التحقق من التوازن</span>
            <span>
              {Math.abs(totalDr - totalCr) < 0.01
                ? "✓ الميزان متوازن"
                : `⚠ فرق: ${fmtAbs(totalDr - totalCr)}`}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th className="text-right px-4 py-3 font-semibold text-muted-foreground">الكود</th>
                  <th className="text-right px-4 py-3 font-semibold text-muted-foreground">اسم الحساب</th>
                  <th className="text-right px-4 py-3 font-semibold text-muted-foreground">النوع</th>
                  <th className="text-center px-2 py-3 font-semibold text-muted-foreground" colSpan={2}>
                    إجمالي الحركات
                  </th>
                  <th className="text-center px-2 py-3 font-semibold text-muted-foreground" colSpan={2}>
                    الأرصدة
                  </th>
                </tr>
                <tr className="bg-muted/30 border-b text-xs">
                  <th colSpan={3} />
                  <th className="text-left px-4 py-2 font-semibold text-blue-700">مدين</th>
                  <th className="text-left px-4 py-2 font-semibold text-rose-700">دائن</th>
                  <th className="text-left px-4 py-2 font-semibold text-blue-700">مدين</th>
                  <th className="text-left px-4 py-2 font-semibold text-rose-700">دائن</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-2.5 font-mono text-xs text-primary">{r.code}</td>
                    <td className="px-4 py-2.5">{r.nameAr}</td>
                    <td className="px-4 py-2.5 text-muted-foreground text-xs">{TYPE_LABELS[r.accountType] ?? r.accountType}</td>
                    <td className="px-4 py-2.5 text-left font-mono text-blue-700">{fmt(r.totalDebit)}</td>
                    <td className="px-4 py-2.5 text-left font-mono text-rose-700">{fmt(r.totalCredit)}</td>
                    <td className="px-4 py-2.5 text-left font-mono text-blue-700">{r.balance > 0 ? fmt(r.balance) : ""}</td>
                    <td className="px-4 py-2.5 text-left font-mono text-rose-700">{r.balance < 0 ? fmt(-r.balance) : ""}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/60 font-bold border-t-2 text-sm">
                  <td colSpan={3} className="px-4 py-3">الإجمالي</td>
                  <td className="px-4 py-3 text-left font-mono text-blue-700">{fmtAbs(totalDr)}</td>
                  <td className="px-4 py-3 text-left font-mono text-rose-700">{fmtAbs(totalCr)}</td>
                  <td className="px-4 py-3 text-left font-mono text-blue-700">{fmtAbs(balDrTot)}</td>
                  <td className="px-4 py-3 text-left font-mono text-rose-700">{fmtAbs(balCrTot)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
