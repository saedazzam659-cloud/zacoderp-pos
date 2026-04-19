import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import ExportButtons from "@/components/ExportButtons";
import { Building2, Search, Printer } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const fmt = (n: number) => n.toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function SectionCard({ title, rows, total, colorClass }: {
  title: string; rows: any[]; total: number; colorClass: string;
}) {
  return (
    <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
      <div className={cn("px-5 py-3 font-bold text-base border-b", colorClass)}>{title}</div>
      <div>
        {rows.filter(r => r.balance !== 0).map(r => (
          <div key={r.id} className="flex items-center justify-between px-5 py-2.5 border-b hover:bg-muted/30 transition-colors">
            <div>
              <span className="text-xs text-muted-foreground font-mono ml-2">{r.code}</span>
              <span className="text-sm">{r.nameAr}</span>
            </div>
            <span className="font-mono text-sm font-semibold">{fmt(Math.abs(r.balance))}</span>
          </div>
        ))}
        {rows.filter(r => r.balance !== 0).length === 0 && (
          <div className="px-5 py-4 text-center text-muted-foreground text-sm">لا توجد بيانات</div>
        )}
      </div>
      <div className={cn("flex items-center justify-between px-5 py-3 font-bold", colorClass)}>
        <span>الإجمالي</span>
        <span className="font-mono">{fmt(Math.abs(total))}</span>
      </div>
    </div>
  );
}

export default function BalanceSheet() {
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}` };

  const today = new Date().toISOString().slice(0, 10);
  const [asOfDate, setAsOfDate] = useState(today);
  const [searched, setSearched] = useState(false);

  const { data, isLoading, refetch } = useQuery<any>({
    queryKey: ["balance-sheet", cid, asOfDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid) params.set("companyId", String(cid));
      params.set("asOfDate", asOfDate);
      const res = await fetch(`${API}/api/accounting-reports/balance-sheet?${params}`, { headers });
      return res.json();
    },
    enabled: searched,
  });

  const isBalanced = data ? Math.abs(data.totalAssets - data.totalLiabilitiesAndEquity) < 0.01 : true;

  const exportRows = data ? [
    ...( data.assets ?? []).filter((r: any) => r.balance !== 0).map((r: any) =>
      ({ section: "أصول", code: r.code, name: r.nameAr, amount: fmt(Math.abs(r.balance)) })),
    { section: "", code: "", name: "إجمالي الأصول", amount: fmt(Math.abs(data.totalAssets)) },
    ...(data.liabilities ?? []).filter((r: any) => r.balance !== 0).map((r: any) =>
      ({ section: "التزامات", code: r.code, name: r.nameAr, amount: fmt(Math.abs(r.balance)) })),
    ...(data.equity ?? []).filter((r: any) => r.balance !== 0).map((r: any) =>
      ({ section: "حقوق ملكية", code: r.code, name: r.nameAr, amount: fmt(Math.abs(r.balance)) })),
    { section: "", code: "", name: "إجمالي الالتزامات وحقوق الملكية", amount: fmt(Math.abs(data.totalLiabilitiesAndEquity)) },
  ] : [];

  const exportCols = [
    { key: "section", header: "القسم",       width: 18 },
    { key: "code",    header: "الكود",       width: 12 },
    { key: "name",    header: "البند",        width: 38 },
    { key: "amount",  header: "المبلغ",       width: 18 },
  ];

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="h-6 w-6 text-primary" />
            المركز المالي (الميزانية العمومية)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">الأصول والالتزامات وحقوق الملكية في تاريخ محدد</p>
        </div>
        <div className="flex gap-2">
          {data && (
            <>
              <ExportButtons rows={exportRows} columns={exportCols}
                filename={`مركز-مالي-${asOfDate}`}
                title={`المركز المالي — بتاريخ ${asOfDate}`} />
              <Button variant="outline" size="sm" className="gap-2" onClick={() => window.print()}>
                <Printer className="h-4 w-4" />طباعة
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Filter */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="space-y-1.5">
            <Label>بتاريخ</Label>
            <Input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="w-44" />
          </div>
          <Button className="gap-2" onClick={() => { setSearched(true); refetch(); }} disabled={isLoading}>
            <Search className="h-4 w-4" />
            {isLoading ? "جاري التحميل..." : "عرض المركز المالي"}
          </Button>
        </div>
      </div>

      {searched && data && (
        <>
          {/* Balance check */}
          <div className={cn(
            "rounded-xl px-5 py-3 flex items-center justify-between font-semibold text-sm",
            isBalanced ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"
          )}>
            <span>التحقق من توازن الميزانية</span>
            <span>
              {isBalanced
                ? `✓ الميزانية متوازنة — الأصول = الالتزامات + حقوق الملكية = ${fmt(Math.abs(data.totalAssets))}`
                : `⚠ فرق: ${fmt(Math.abs(data.totalAssets - data.totalLiabilitiesAndEquity))}`}
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Assets side */}
            <div className="space-y-4">
              <SectionCard
                title="الأصول"
                rows={data.assets ?? []}
                total={data.totalAssets}
                colorClass="bg-blue-50 text-blue-800"
              />
            </div>

            {/* Liabilities + Equity side */}
            <div className="space-y-4">
              <SectionCard
                title="الالتزامات"
                rows={data.liabilities ?? []}
                total={data.totalLiabilities}
                colorClass="bg-rose-50 text-rose-800"
              />
              <SectionCard
                title="حقوق الملكية"
                rows={data.equity ?? []}
                total={data.totalEquity}
                colorClass="bg-purple-50 text-purple-800"
              />
              {/* Total */}
              <div className="rounded-xl border bg-muted/50 px-5 py-4 flex items-center justify-between font-bold">
                <span>إجمالي الالتزامات وحقوق الملكية</span>
                <span className="font-mono text-primary text-lg">{fmt(Math.abs(data.totalLiabilitiesAndEquity))}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
