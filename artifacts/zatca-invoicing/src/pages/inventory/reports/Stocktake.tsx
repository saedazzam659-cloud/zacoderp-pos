import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import ExportButtons from "@/components/ExportButtons";
import {
  ClipboardCheck, Search, Warehouse, Package, Wallet, AlertTriangle,
  CheckCircle2, XCircle, Printer, RotateCcw, ChevronDown, ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { useFmt } from "@/hooks/use-fmt";

type Row = {
  id: string;
  item: { id: number; code: string; nameAr?: string; nameEn?: string; reorderLevel?: number | null };
  group: { nameAr?: string; nameEn?: string } | null;
  unit:  { nameAr?: string; nameEn?: string } | null;
  warehouse: { id: number; nameAr?: string; nameEn?: string };
  qty: number | string;
  avgCost: number | string;
};

export default function Stocktake() {
  const { fmt, fmtQty, fmtCost, fmtVal } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const pickName = (ar?: string | null, en?: string | null) => ar ?? en ?? "";

  const [warehouseId, setWarehouseId] = useState("");
  const [search, setSearch] = useState("");
  const [groupByWh, setGroupByWh] = useState(true);
  const [showOnlyVariance, setShowOnlyVariance] = useState(false);
  // Counted quantities entered by the user — keyed by row.id
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const today = new Date().toISOString().slice(0, 10);

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });
  const { data: rows = [], isLoading } = useQuery<Row[]>({
    queryKey: ["stocktake", cid, warehouseId],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid)         params.companyId   = String(cid);
      if (warehouseId) params.warehouseId = warehouseId;
      return inventoryApi.getBalance(params) as any;
    },
  });

  // Apply text search
  const searched = useMemo(() => rows.filter(r => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (r.item?.nameAr ?? "").includes(search) ||
      (r.item?.nameEn ?? "").toLowerCase().includes(s) ||
      (r.item?.code ?? "").toLowerCase().includes(s);
  }), [rows, search]);

  // Compute variance per row
  const enriched = useMemo(() => searched.map(r => {
    const sysQty = Number(r.qty) || 0;
    const cntStr = counts[r.id];
    const hasCount = cntStr !== undefined && cntStr !== "";
    const cntQty = hasCount ? Number(cntStr) : null;
    const variance = hasCount && cntQty !== null ? cntQty - sysQty : null;
    const variancePct = hasCount && sysQty > 0 ? ((cntQty! - sysQty) / sysQty) * 100 : null;
    const avgCost = Number(r.avgCost) || 0;
    const sysValue = sysQty * avgCost;
    const cntValue = hasCount && cntQty !== null ? cntQty * avgCost : null;
    const varianceValue = hasCount && cntQty !== null ? (cntQty - sysQty) * avgCost : null;
    return { ...r, sysQty, cntQty, hasCount, variance, variancePct, avgCost, sysValue, cntValue, varianceValue };
  }), [searched, counts]);

  const visible = useMemo(() => enriched.filter(r => !showOnlyVariance || (r.variance !== null && r.variance !== 0)), [enriched, showOnlyVariance]);

  // KPI totals
  const totals = useMemo(() => {
    const t = { items: visible.length, sysValue: 0, cntValue: 0, varValue: 0, varCount: 0, countedItems: 0, matched: 0 };
    for (const r of visible) {
      t.sysValue += r.sysValue;
      if (r.hasCount) {
        t.countedItems += 1;
        t.cntValue += r.cntValue ?? 0;
        t.varValue += r.varianceValue ?? 0;
        if (r.variance === 0) t.matched += 1;
        else if (r.variance !== null) t.varCount += 1;
      }
    }
    return t;
  }, [visible]);

  // Group by warehouse
  const grouped = useMemo(() => {
    if (!groupByWh) return [{ wh: { id: 0, name: "" }, rows: visible }];
    const map = new Map<number, { wh: { id: number; name: string }; rows: typeof visible }>();
    for (const r of visible) {
      const key = r.warehouse?.id ?? 0;
      const existing = map.get(key) ?? { wh: { id: key, name: pickName(r.warehouse?.nameAr, r.warehouse?.nameEn) }, rows: [] };
      existing.rows.push(r);
      map.set(key, existing);
    }
    return Array.from(map.values());
  }, [visible, groupByWh]);

  const exportRows = visible.map(r => ({
    itemCode: r.item?.code ?? "",
    itemName: pickName(r.item?.nameAr, r.item?.nameEn),
    groupName: pickName(r.group?.nameAr, r.group?.nameEn),
    unitName: pickName(r.unit?.nameAr, r.unit?.nameEn),
    warehouseName: pickName(r.warehouse?.nameAr, r.warehouse?.nameEn),
    sysQty: fmtQty(r.sysQty),
    cntQty: r.hasCount ? fmtQty(r.cntQty!) : "—",
    variance: r.variance !== null ? fmtQty(r.variance) : "—",
    avgCost: fmtCost(r.avgCost),
    sysValue: fmt(r.sysValue),
    varValue: r.varianceValue !== null ? fmt(r.varianceValue) : "—",
  }));

  const EXPORT_COLS = [
    { key: "itemCode",      header: "كود الصنف",       width: 14 },
    { key: "itemName",      header: "اسم الصنف",       width: 30 },
    { key: "groupName",     header: "المجموعة",        width: 18 },
    { key: "unitName",      header: "الوحدة",          width: 12 },
    { key: "warehouseName", header: "المخزن",          width: 20 },
    { key: "sysQty",        header: "الكمية بالنظام",  width: 14 },
    { key: "cntQty",        header: "الكمية الفعلية",  width: 14 },
    { key: "variance",      header: "الفرق",           width: 12 },
    { key: "avgCost",       header: "متوسط التكلفة",   width: 14 },
    { key: "sysValue",      header: "قيمة النظام",     width: 16 },
    { key: "varValue",      header: "قيمة الفرق",      width: 16 },
  ];

  const resetCounts = () => { if (confirm("هل تريد مسح جميع الكميات المُدخلة؟")) setCounts({}); };

  return (
    <div className="space-y-6" dir="rtl">
      {/* Gradient hero header */}
      <div className="rounded-2xl bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 p-6 text-white shadow-lg print:hidden">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-white/20 backdrop-blur p-3">
              <ClipboardCheck className="h-7 w-7" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">جرد المخازن</h1>
              <p className="text-sm text-white/90 mt-1">
                تقرير جرد فعلي مقابل أرصدة النظام مع حساب الفروقات والقيم. أدخل الكميات الفعلية في العمود المخصص.
              </p>
              <p className="text-xs text-white/70 mt-1">📅 تاريخ الجرد: {today}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => window.print()} className="gap-1.5">
              <Printer className="h-4 w-4" /> طباعة
            </Button>
            <Button variant="secondary" size="sm" onClick={resetCounts} className="gap-1.5">
              <RotateCcw className="h-4 w-4" /> مسح الإدخالات
            </Button>
          </div>
        </div>
      </div>

      {/* Export bar (separate so it can use existing component) */}
      <div className="flex justify-end print:hidden">
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`جرد-المخازن-${today}`}
          title="جرد المخازن"
          subtitle={warehouseId ? pickName((warehouses as any[]).find(w => String(w.id) === warehouseId)?.nameAr, (warehouses as any[]).find(w => String(w.id) === warehouseId)?.nameEn) : "كل المخازن"}
        />
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 print:hidden">
        <KpiCard
          label="إجمالي الأصناف"
          value={String(totals.items)}
          icon={Package}
          color="from-sky-50 to-sky-100/40 border-sky-200 text-sky-700"
        />
        <KpiCard
          label="قيمة المخزون بالنظام"
          value={fmtVal(totals.sysValue)}
          sub="ر.س"
          icon={Wallet}
          color="from-emerald-50 to-emerald-100/40 border-emerald-200 text-emerald-700"
        />
        <KpiCard
          label={`الأصناف المجرودة (${totals.countedItems}/${totals.items})`}
          value={`${totals.matched} مطابق`}
          sub={`${totals.varCount} مختلف`}
          icon={CheckCircle2}
          color="from-violet-50 to-violet-100/40 border-violet-200 text-violet-700"
        />
        <KpiCard
          label="إجمالي قيمة الفروقات"
          value={fmt(totals.varValue)}
          sub={totals.varValue >= 0 ? "زيادة" : "عجز"}
          icon={totals.varValue >= 0 ? CheckCircle2 : AlertTriangle}
          color={totals.varValue >= 0
            ? "from-green-50 to-green-100/40 border-green-200 text-green-700"
            : "from-rose-50 to-rose-100/40 border-rose-200 text-rose-700"}
        />
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 print:hidden">
        <div className="relative sm:col-span-5">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pr-9" placeholder="ابحث باسم أو كود الصنف..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="sm:col-span-4">
          <SearchCombobox
            items={[{ value: "", label: "كل المخازن" }, ...(warehouses as any[]).map(w => ({ value: String(w.id), code: w.code, label: pickName(w.nameAr, w.nameEn) }))]}
            value={warehouseId}
            onValueChange={setWarehouseId}
            placeholder="كل المخازن"
          />
        </div>
        <label className="sm:col-span-2 flex items-center gap-2 text-sm rounded-md border px-3 cursor-pointer hover:bg-muted/30 transition">
          <input type="checkbox" checked={groupByWh} onChange={e => setGroupByWh(e.target.checked)} />
          تجميع بالمخزن
        </label>
        <label className="sm:col-span-1 flex items-center gap-2 text-sm rounded-md border px-3 cursor-pointer hover:bg-muted/30 transition">
          <input type="checkbox" checked={showOnlyVariance} onChange={e => setShowOnlyVariance(e.target.checked)} />
          فروق فقط
        </label>
      </div>

      {/* Print-only header */}
      <div className="hidden print:block">
        <h1 className="text-2xl font-bold text-center">كشف جرد المخازن</h1>
        <p className="text-sm text-center text-muted-foreground mt-1">تاريخ الجرد: {today}</p>
      </div>

      {/* Body */}
      {isLoading ? (
        <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          <ClipboardCheck className="h-12 w-12 mx-auto opacity-30 mb-3" />
          <p>لا توجد بيانات للعرض</p>
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map((g, idx) => {
            const isCollapsed = collapsed[g.wh.id] ?? false;
            const grpSysValue = g.rows.reduce((s, r) => s + r.sysValue, 0);
            const grpVarValue = g.rows.reduce((s, r) => s + (r.varianceValue ?? 0), 0);
            return (
              <div key={idx} className="rounded-xl border bg-card overflow-hidden shadow-sm">
                {groupByWh && g.wh.name && (
                  <button
                    onClick={() => setCollapsed(c => ({ ...c, [g.wh.id]: !isCollapsed }))}
                    className="w-full flex items-center justify-between gap-3 bg-gradient-to-l from-indigo-50 to-transparent px-4 py-3 border-b hover:bg-indigo-100/40 transition print:bg-white"
                  >
                    <div className="flex items-center gap-2">
                      <Warehouse className="h-5 w-5 text-indigo-600" />
                      <h3 className="font-bold text-base">{g.wh.name}</h3>
                      <span className="text-xs bg-indigo-100 text-indigo-700 rounded-full px-2 py-0.5">{g.rows.length} صنف</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-muted-foreground">القيمة: <strong className="tabular-nums text-foreground">{fmtVal(grpSysValue)}</strong></span>
                      {grpVarValue !== 0 && (
                        <span className={cn("tabular-nums font-bold", grpVarValue > 0 ? "text-emerald-600" : "text-rose-600")}>
                          فرق: {fmt(grpVarValue)}
                        </span>
                      )}
                      {isCollapsed ? <ChevronDown className="h-4 w-4 print:hidden" /> : <ChevronUp className="h-4 w-4 print:hidden" />}
                    </div>
                  </button>
                )}
                {!isCollapsed && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[900px]">
                      <thead className="bg-muted/50 border-b">
                        <tr>
                          <th className="px-3 py-2.5 text-right font-semibold text-muted-foreground w-10">#</th>
                          <th className="px-3 py-2.5 text-right font-semibold text-muted-foreground">الصنف</th>
                          <th className="px-3 py-2.5 text-right font-semibold text-muted-foreground hidden md:table-cell">المجموعة</th>
                          <th className="px-3 py-2.5 text-center font-semibold text-muted-foreground">الوحدة</th>
                          <th className="px-3 py-2.5 text-center font-semibold text-muted-foreground">كمية النظام</th>
                          <th className="px-3 py-2.5 text-center font-semibold text-indigo-700 bg-indigo-50/50">الكمية الفعلية</th>
                          <th className="px-3 py-2.5 text-center font-semibold text-muted-foreground">الفرق</th>
                          <th className="px-3 py-2.5 text-center font-semibold text-muted-foreground hidden lg:table-cell">متوسط التكلفة</th>
                          <th className="px-3 py-2.5 text-center font-semibold text-muted-foreground">قيمة الفرق</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {g.rows.map((r, i) => {
                          const hasVar = r.variance !== null && r.variance !== 0;
                          const isMatch = r.hasCount && r.variance === 0;
                          return (
                            <tr key={r.id} className={cn(
                              "hover:bg-muted/20 transition",
                              hasVar && r.variance! > 0 && "bg-emerald-50/30",
                              hasVar && r.variance! < 0 && "bg-rose-50/30",
                              isMatch && "bg-blue-50/20",
                            )}>
                              <td className="px-3 py-2.5 text-muted-foreground tabular-nums text-xs">{i + 1}</td>
                              <td className="px-3 py-2.5">
                                <div className="font-medium">{pickName(r.item?.nameAr, r.item?.nameEn)}</div>
                                <div className="text-[10px] text-muted-foreground font-mono">{r.item?.code}</div>
                              </td>
                              <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell">{pickName(r.group?.nameAr, r.group?.nameEn) || "—"}</td>
                              <td className="px-3 py-2.5 text-center text-xs text-muted-foreground">{pickName(r.unit?.nameAr, r.unit?.nameEn) || "—"}</td>
                              <td className="px-3 py-2.5 text-center tabular-nums font-semibold">{fmtQty(r.sysQty)}</td>
                              <td className="px-2 py-1.5 text-center bg-indigo-50/30">
                                <input
                                  type="number"
                                  step="any"
                                  inputMode="decimal"
                                  value={counts[r.id] ?? ""}
                                  onChange={e => setCounts(c => ({ ...c, [r.id]: e.target.value }))}
                                  placeholder="—"
                                  className="w-24 h-8 text-center tabular-nums rounded-md border border-indigo-200 bg-white px-2 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none print:border-0 print:bg-transparent"
                                />
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                {r.variance === null ? (
                                  <span className="text-muted-foreground text-xs">—</span>
                                ) : r.variance === 0 ? (
                                  <span className="inline-flex items-center gap-1 text-[11px] bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-medium">
                                    <CheckCircle2 className="h-3 w-3" /> مطابق
                                  </span>
                                ) : r.variance > 0 ? (
                                  <span className="inline-flex items-center gap-1 text-[11px] bg-emerald-100 text-emerald-700 rounded-full px-2 py-0.5 font-medium tabular-nums">
                                    +{fmtQty(r.variance)}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-[11px] bg-rose-100 text-rose-700 rounded-full px-2 py-0.5 font-medium tabular-nums">
                                    <XCircle className="h-3 w-3" /> {fmtQty(r.variance)}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-center text-xs tabular-nums text-muted-foreground hidden lg:table-cell">{fmtCost(r.avgCost)}</td>
                              <td className={cn(
                                "px-3 py-2.5 text-center tabular-nums font-semibold",
                                r.varianceValue === null && "text-muted-foreground",
                                r.varianceValue !== null && r.varianceValue > 0 && "text-emerald-700",
                                r.varianceValue !== null && r.varianceValue < 0 && "text-rose-700",
                              )}>
                                {r.varianceValue === null ? "—" : fmt(r.varianceValue)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot className="bg-muted/30 border-t font-semibold">
                        <tr>
                          <td colSpan={4} className="px-3 py-2.5 text-right text-xs text-muted-foreground">الإجمالي</td>
                          <td className="px-3 py-2.5 text-center tabular-nums">{fmtQty(g.rows.reduce((s, r) => s + r.sysQty, 0))}</td>
                          <td className="px-3 py-2.5 text-center tabular-nums">{fmtQty(g.rows.reduce((s, r) => s + (r.cntQty ?? 0), 0))}</td>
                          <td className="px-3 py-2.5"></td>
                          <td className="px-3 py-2.5 text-center text-xs text-muted-foreground hidden lg:table-cell">{fmtVal(grpSysValue)}</td>
                          <td className={cn(
                            "px-3 py-2.5 text-center tabular-nums",
                            grpVarValue > 0 && "text-emerald-700",
                            grpVarValue < 0 && "text-rose-700",
                          )}>
                            {fmt(grpVarValue)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Sign-off footer (print friendly) */}
      <div className="rounded-xl border-2 border-dashed border-muted bg-muted/10 p-6 grid grid-cols-1 sm:grid-cols-3 gap-6 text-sm print:break-inside-avoid">
        {[
          { label: "أمين المخزن", role: "اسم وتوقيع" },
          { label: "لجنة الجرد",  role: "اسم وتوقيع" },
          { label: "المدير المالي", role: "اسم وتوقيع" },
        ].map(s => (
          <div key={s.label} className="text-center">
            <div className="font-semibold mb-8">{s.label}</div>
            <div className="border-t border-muted-foreground/50 pt-2 text-xs text-muted-foreground">{s.role}</div>
          </div>
        ))}
      </div>

      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 10mm; }
          body { background: white !important; }
          input { border: 1px solid #ddd !important; }
        }
      `}</style>
    </div>
  );
}

function KpiCard({ label, value, sub, icon: Icon, color }: { label: string; value: string; sub?: string; icon: any; color: string }) {
  return (
    <div className={cn("rounded-xl border bg-gradient-to-br p-4 transition hover:shadow-md", color)}>
      <div className="flex items-start justify-between mb-2">
        <p className="text-xs font-medium opacity-90">{label}</p>
        <Icon className="h-5 w-5 opacity-70" />
      </div>
      <p className="text-xl font-bold tabular-nums">{value}</p>
      {sub && <p className="text-[11px] opacity-70 mt-0.5">{sub}</p>}
    </div>
  );
}
