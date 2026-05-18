import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { salesAnalyticsApi } from "@/lib/salesAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import RegionFilter from "@/components/RegionFilter";
import { useTranslation } from "react-i18next";
import { Gift, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

/**
 * تقرير مرتجع الكميات المجانية
 *
 * يجمع بنود مرتجعات المبيعات التي تحوي `free_qty > 0` مجمَّعة بالصنف،
 * مع عرض سعر التكلفة وسعر البيع (شامل وغير شامل ضريبة القيمة المضافة)
 * المأخوذة من بطاقة الصنف الحالية. الستايل مطابق لتقرير «المبيعات حسب الصنف».
 */
export default function FreeReturnsReport() {
  const { fmt, fmtQty } = useFmt();
  const { i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [regionId, setRegionId] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState("");

  const EXPORT_COLS = [
    { key: "itemCode",        header: "كود الصنف",                width: 14 },
    { key: "itemName",        header: "اسم الصنف",                width: 30 },
    { key: "unit",            header: "الوحدة",                   width: 10 },
    { key: "freeQty",         header: "الكمية المجانية",          width: 14 },
    { key: "returnCount",     header: "عدد المرتجعات",            width: 12 },
    { key: "costPrice",       header: "سعر التكلفة",              width: 14 },
    { key: "sellPrice",       header: "سعر البيع (بدون ضريبة)",  width: 16 },
    { key: "sellPriceIncVat", header: "سعر البيع (شامل ضريبة)",  width: 16 },
    { key: "costTotal",       header: "إجمالي التكلفة",           width: 16 },
    { key: "sellTotal",       header: "إجمالي البيع (بدون ضريبة)", width: 18 },
    { key: "sellTotalIncVat", header: "إجمالي البيع (شامل ضريبة)", width: 18 },
  ];

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["free-returns", cid, from, to, branchId, regionId],
    queryFn: () => salesAnalyticsApi.freeReturns(cid, from, to, branchId, regionId),
  });

  const filtered = (rows as any[]).filter(r =>
    !search || r.itemName?.toLowerCase().includes(search.toLowerCase()) || r.itemCode?.includes(search)
  );

  const totals = filtered.reduce((s, r) => ({
    freeQty:         s.freeQty         + r.freeQty,
    returnCount:     s.returnCount     + r.returnCount,
    costTotal:       s.costTotal       + r.costTotal,
    sellTotal:       s.sellTotal       + r.sellTotal,
    sellTotalIncVat: s.sellTotalIncVat + r.sellTotalIncVat,
  }), { freeQty: 0, returnCount: 0, costTotal: 0, sellTotal: 0, sellTotalIncVat: 0 });

  const exportRows = filtered.map(r => ({
    itemCode:        r.itemCode ?? "",
    itemName:        r.itemName,
    unit:            r.unit ?? "",
    freeQty:         fmtQty(r.freeQty),
    returnCount:     r.returnCount,
    costPrice:       fmt(r.costPrice),
    sellPrice:       fmt(r.sellPrice),
    sellPriceIncVat: fmt(r.sellPriceIncVat),
    costTotal:       fmt(r.costTotal),
    sellTotal:       fmt(r.sellTotal),
    sellTotalIncVat: fmt(r.sellTotalIncVat),
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Gift className="h-6 w-6 text-pink-600" />
            مرتجع الكميات المجانية
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            تقرير بالأصناف التي وردت كميات مجانية في مرتجعات المبيعات المرحَّلة، مع تكلفتها وسعر بيعها (شامل/بدون ضريبة).
          </p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`free-returns-${from}-${to}`}
          title="مرتجع الكميات المجانية"
          subtitle={`من ${from} إلى ${to} — إجمالي شامل ضريبة: ${fmt(totals.sellTotalIncVat)}`}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border bg-pink-50 border-pink-200 p-3">
          <p className="text-[11px] text-pink-700">عدد الأصناف</p>
          <p className="text-xl font-bold text-pink-700 tabular-nums mt-1">{filtered.length}</p>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <p className="text-[11px] text-muted-foreground">إجمالي الكمية المجانية</p>
          <p className="text-xl font-bold tabular-nums mt-1">{fmtQty(totals.freeQty)}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-3">
          <p className="text-[11px] text-amber-700">إجمالي التكلفة</p>
          <p className="text-xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totals.costTotal)}</p>
        </div>
        <div className="rounded-xl border bg-rose-50 border-rose-200 p-3">
          <p className="text-[11px] text-rose-700">إجمالي البيع (شامل ضريبة)</p>
          <p className="text-xl font-bold text-rose-700 tabular-nums mt-1">{fmt(totals.sellTotalIncVat)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="space-y-1.5">
          <Label>من تاريخ</Label>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>إلى تاريخ</Label>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <BranchFilter value={branchId} onChange={setBranchId} />
        <RegionFilter value={regionId} onChange={setRegionId} />
        <div className="space-y-1.5">
          <Label>بحث</Label>
          <div className="relative">
            <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
            <Input className={isRtl ? "pr-9" : "pl-9"} placeholder="كود أو اسم صنف..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1100px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>الصنف</th>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden sm:table-cell`}>الوحدة</th>
                <th className="px-3 py-3 text-center font-semibold text-pink-700">الكمية المجانية</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">عدد المرتجعات</th>
                <th className="px-3 py-3 text-center font-semibold text-amber-700">سعر التكلفة</th>
                <th className="px-3 py-3 text-center font-semibold text-blue-700">سعر البيع<br/><span className="text-[10px] opacity-70">بدون ضريبة</span></th>
                <th className="px-3 py-3 text-center font-semibold text-blue-800">سعر البيع<br/><span className="text-[10px] opacity-70">شامل ضريبة</span></th>
                <th className="px-3 py-3 text-center font-semibold text-amber-800">إجمالي التكلفة</th>
                <th className="px-3 py-3 text-center font-semibold text-rose-700">إجمالي البيع<br/><span className="text-[10px] opacity-70">شامل ضريبة</span></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={9} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : filtered.length === 0
                ? <tr><td colSpan={9} className="py-12 text-center text-muted-foreground">لا توجد كميات مجانية في المرتجعات للفترة المحددة</td></tr>
                : filtered.map((r: any, i: number) => (
                    <tr key={`${r.itemId ?? r.itemName}-${i}`} className="hover:bg-muted/20">
                      <td className="px-3 py-3">
                        <p className="font-medium text-sm">{r.itemName}</p>
                        {r.itemCode && <p className="text-[10px] text-muted-foreground font-mono">{r.itemCode}</p>}
                      </td>
                      <td className="px-3 py-3 hidden sm:table-cell text-xs text-muted-foreground">{r.unit ?? "—"}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm font-bold text-pink-700">{fmtQty(r.freeQty)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs hidden md:table-cell">{r.returnCount}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm text-amber-700">{fmt(r.costPrice)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm text-blue-700">{fmt(r.sellPrice)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm font-semibold text-blue-800">{fmt(r.sellPriceIncVat)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm font-semibold text-amber-800">{fmt(r.costTotal)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm font-bold text-rose-700">{fmt(r.sellTotalIncVat)}</td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && filtered.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={2} className="px-3 py-3 text-xs font-bold">الإجمالي</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-pink-700">{fmtQty(totals.freeQty)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums hidden md:table-cell">{totals.returnCount}</td>
                  <td className="px-3 py-3"></td>
                  <td className="px-3 py-3"></td>
                  <td className="px-3 py-3"></td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-amber-800">{fmt(totals.costTotal)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-rose-700">{fmt(totals.sellTotalIncVat)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
