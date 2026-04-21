import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { Hourglass, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const EXPORT_COLS = [
  { key: "itemCode",     header: "كود الصنف",       width: 16 },
  { key: "itemNameAr",   header: "اسم الصنف",       width: 30 },
  { key: "groupName",    header: "المجموعة",         width: 20 },
  { key: "qty",          header: "الرصيد الحالي",    width: 16 },
  { key: "value",        header: "القيمة",            width: 16 },
  { key: "lastMoveDate", header: "آخر حركة",         width: 16 },
  { key: "daysIdle",     header: "عدد أيام السكون", width: 16 },
];

export default function SlowMovingItems() {
  const { fmt, fmtQty } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [days, setDays] = useState("90");
  const [search, setSearch] = useState("");

  const { data: items = [] } = useQuery({
    queryKey: ["items", cid],
    queryFn: () => inventoryApi.getItems(cid),
  });
  const { data: balances = [], isLoading: bLoad } = useQuery({
    queryKey: ["stock-balance-all", cid],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid) params.companyId = String(cid);
      return inventoryApi.getBalance(params);
    },
  });
  // Backend-aggregated last movement date per item (handles >500 ledger rows correctly)
  const { data: lastMoves = [], isLoading: lLoad } = useQuery({
    queryKey: ["last-movements", cid],
    queryFn: () => inventoryApi.getLastMovements(cid),
  });

  const isLoading = bLoad || lLoad;

  const lastMoveByItem: Record<number, string> = {};
  (lastMoves as { itemId: number; lastDate: string }[]).forEach(l => {
    if (l.lastDate) lastMoveByItem[Number(l.itemId)] = l.lastDate;
  });

  // Aggregate balance + value per item
  type Agg = { qty: number; value: number };
  const balByItem: Record<number, Agg> = {};
  (balances as any[]).forEach((b: any) => {
    const id = Number(b.itemId);
    if (!balByItem[id]) balByItem[id] = { qty: 0, value: 0 };
    balByItem[id].qty += Number(b.qty);
    balByItem[id].value += Number(b.qty) * Number(b.avgCost);
  });

  const today = new Date();
  const threshold = Number(days) || 90;

  const enriched = (items as any[])
    .filter((it: any) => it.itemType !== "service")
    .map((it: any) => {
      const bal = balByItem[it.id] ?? { qty: 0, value: 0 };
      const lastMove = lastMoveByItem[it.id];
      const daysIdle = lastMove
        ? Math.floor((today.getTime() - new Date(lastMove).getTime()) / 86400000)
        : 9999; // Never moved
      return { ...it, qty: bal.qty, value: bal.value, lastMoveDate: lastMove ?? null, daysIdle };
    })
    .filter((r: any) => r.qty > 0 && r.daysIdle >= threshold)
    .filter((r: any) =>
      !search || r.nameAr?.includes(search) || r.code?.includes(search)
    )
    .sort((a, b) => b.daysIdle - a.daysIdle);

  const totalLockedValue = enriched.reduce((s, r) => s + r.value, 0);

  const exportRows = enriched.map((r: any) => ({
    itemCode:     r.code ?? "",
    itemNameAr:   r.nameAr ?? "",
    groupName:    r.group?.nameAr ?? "",
    qty:          fmtQty(r.qty),
    value:        fmt(r.value),
    lastMoveDate: r.lastMoveDate ?? "لم يتحرك أبداً",
    daysIdle:     r.daysIdle === 9999 ? "—" : `${r.daysIdle} يوم`,
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Hourglass className="h-6 w-6 text-rose-500" />الأصناف الراكدة</h1>
          <p className="text-muted-foreground text-sm mt-1">أصناف لها رصيد ولم تشهد حركة خلال الفترة المحددة</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`أصناف-راكدة-${days}يوم-${new Date().toISOString().slice(0, 10)}`}
          title="تقرير الأصناف الراكدة"
          subtitle={`بدون حركة لمدة ${threshold} يوم أو أكثر`}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-rose-50 border-rose-200 p-4">
          <p className="text-xs text-rose-700">عدد الأصناف الراكدة</p>
          <p className="text-2xl font-bold text-rose-700 tabular-nums mt-1">{enriched.length}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-4">
          <p className="text-xs text-amber-700">القيمة المجمدة</p>
          <p className="text-2xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totalLockedValue)}</p>
          <p className="text-xs text-amber-600">ريال سعودي</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">حد السكون (يوم)</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{threshold}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>عدد أيام السكون كحد أدنى</Label>
          <Input type="number" min={1} value={days} onChange={e => setDays(e.target.value)} placeholder="90" />
        </div>
        <div className="space-y-1.5">
          <Label>بحث</Label>
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pr-9" placeholder="بحث بالكود أو الاسم..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الصنف</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">المجموعة</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الرصيد</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">القيمة</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">آخر حركة</th>
                <th className="px-4 py-3 text-center font-semibold text-rose-700">أيام السكون</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : enriched.length === 0
                ? <tr><td colSpan={6} className="py-12 text-center text-muted-foreground">
                    <Hourglass className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    لا توجد أصناف راكدة بهذا المعيار
                  </td></tr>
                : enriched.map((r: any) => (
                    <tr key={r.id} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <p className="font-medium text-sm">{r.nameAr ?? "—"}</p>
                        <p className="text-[10px] text-muted-foreground font-mono">{r.code}</p>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">{r.group?.nameAr ?? "—"}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm">{fmtQty(r.qty)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm font-semibold">{fmt(r.value)}</td>
                      <td className="px-4 py-3 text-center hidden md:table-cell text-xs text-muted-foreground">{r.lastMoveDate ?? "لم يتحرك"}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`text-xs tabular-nums font-bold rounded-full px-2 py-0.5 ${r.daysIdle >= 365 ? "bg-rose-100 text-rose-700" : r.daysIdle >= 180 ? "bg-amber-100 text-amber-700" : "bg-yellow-50 text-yellow-700"}`}>
                          {r.daysIdle === 9999 ? "لم يتحرك" : `${r.daysIdle} يوم`}
                        </span>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
