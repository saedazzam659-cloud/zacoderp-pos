import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { salesAnalyticsApi, type ProfitabilityLevel, type ProfitabilityReport } from "@/lib/salesAnalyticsApi";
import { inventoryApi } from "@/lib/inventoryApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import { TrendingUp, Filter, X, PackageOpen, Receipt, Users, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFmt } from "@/hooks/use-fmt";

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(): Record<string, string> {
  const t = localStorage.getItem("zatca_token");
  return t ? { Authorization: `Bearer ${t}` } : {};
}

const LEVEL_META: Record<ProfitabilityLevel, { label: string; desc: string; icon: any; chip: string; firstColHeader: string }> = {
  invoice:  { label: "حسب الفاتورة", desc: "هامش ربح كل فاتورة على حدة", icon: Receipt,    chip: "bg-indigo-600 hover:bg-indigo-700", firstColHeader: "الفاتورة" },
  customer: { label: "حسب العميل",   desc: "إجمالي هامش الربح لكل عميل (صافي بعد المرتجعات)", icon: Users,      chip: "bg-sky-600 hover:bg-sky-700",       firstColHeader: "العميل" },
  branch:   { label: "حسب الفرع",    desc: "إجمالي هامش الربح لكل فرع/منطقة (صافي بعد المرتجعات)", icon: Building2,  chip: "bg-emerald-600 hover:bg-emerald-700", firstColHeader: "الفرع" },
};

type Filters = {
  from: string; to: string;
  branchId: string; customerId: string; itemId: string;
};

export default function ProfitabilityReport() {
  const { fmt } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const today    = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const empty: Filters = { from: firstDay, to: today, branchId: "", customerId: "", itemId: "" };
  const [filters, setFilters] = useState<Filters>(empty);
  const [applied, setApplied] = useState<Filters>(empty);
  const [level,   setLevel]   = useState<ProfitabilityLevel>("invoice");

  const { data: items = [] }    = useQuery({ queryKey: ["items", cid],    queryFn: () => inventoryApi.getItems(cid) });
  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`;
      const r = await fetch(url, { headers: authHeaders() });
      return r.ok ? r.json() : [];
    },
  });
  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["org-branches", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/org/branches?companyId=${cid}` : `${API}/api/org/branches`;
      const r = await fetch(url, { headers: authHeaders() });
      return r.ok ? r.json() : [];
    },
  });

  const { data, isLoading, isFetching } = useQuery<ProfitabilityReport>({
    queryKey: ["profitability", cid, applied, level],
    queryFn: () => salesAnalyticsApi.profitability(cid, {
      level,
      from: applied.from || undefined,
      to:   applied.to   || undefined,
      branchId:   applied.branchId   || undefined,
      customerId: applied.customerId || undefined,
      itemId:     applied.itemId     || undefined,
    }),
  });

  const rows   = data?.rows ?? [];
  const totals = data?.totals ?? { revenue: 0, cogs: 0, profit: 0, margin: 0 };

  const apply = () => setApplied(filters);
  const reset = () => { setFilters(empty); setApplied(empty); };
  const hasAnyFilter = !!applied.branchId || !!applied.customerId || !!applied.itemId;

  const itemMap = new Map<number, any>((items as any[]).map(i => [i.id, i]));
  const cusMap  = new Map<number, any>((customers as any[]).map(c => [c.id, c]));
  const brMap   = new Map<number, any>((branches as any[]).map(b => [b.id, b]));
  const appliedItem = applied.itemId     ? itemMap.get(Number(applied.itemId))     : null;
  const appliedCus  = applied.customerId ? cusMap.get(Number(applied.customerId))  : null;
  const appliedBr   = applied.branchId   ? brMap.get(Number(applied.branchId))     : null;

  const subtitle = [
    `المستوى: ${LEVEL_META[level].label}`,
    `الفترة: ${applied.from} → ${applied.to}`,
    appliedBr  && `الفرع: ${appliedBr.nameAr ?? appliedBr.name}`,
    appliedCus && `العميل: ${appliedCus.nameAr ?? appliedCus.name}`,
    appliedItem && `الصنف: ${appliedItem.nameAr ?? appliedItem.code}`,
  ].filter(Boolean).join("  •  ");

  const EXPORT_COLS = level === "invoice"
    ? [
        { key: "label",    header: "رقم الفاتورة", width: 18 },
        { key: "date",     header: "التاريخ",      width: 14 },
        { key: "sublabel", header: "العميل",       width: 26 },
        { key: "revenue",  header: "صافي البيع (بدون ضريبة)", width: 18 },
        { key: "cogs",     header: "تكلفة البضاعة المباعة",   width: 18 },
        { key: "profit",   header: "هامش الربح",   width: 16 },
        { key: "margin",   header: "نسبة الربح %", width: 14 },
      ]
    : [
        { key: "label",    header: LEVEL_META[level].firstColHeader, width: 26 },
        { key: "docCount", header: "عدد الفواتير",  width: 14 },
        { key: "revenue",  header: "صافي البيع (بدون ضريبة)", width: 18 },
        { key: "cogs",     header: "تكلفة البضاعة المباعة",   width: 18 },
        { key: "profit",   header: "هامش الربح",   width: 16 },
        { key: "margin",   header: "نسبة الربح %", width: 14 },
      ];

  const exportRows = rows.map(r => ({
    label:    r.label,
    date:     r.invoiceDate ?? "",
    sublabel: r.sublabel ?? "",
    docCount: r.docCount,
    revenue:  fmt(r.revenue),
    cogs:     fmt(r.cogs),
    profit:   fmt(r.profit),
    margin:   `${r.margin.toFixed(2)}%`,
  }));

  const totalsRow = {
    label: "الإجمالي", date: "", sublabel: "", docCount: rows.reduce((a, r) => a + r.docCount, 0),
    revenue: fmt(totals.revenue),
    cogs:    fmt(totals.cogs),
    profit:  fmt(totals.profit),
    margin:  `${totals.margin.toFixed(2)}%`,
  };

  const LevelIcon = LEVEL_META[level].icon;

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-emerald-600" />
            تقرير الربحية
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            هامش الربح = صافي البيع (بدون ضريبة) − تكلفة البضاعة المباعة من دفتر المخزون (FIFO / متوسط مرجّح)
          </p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`الربحية-${level}-${applied.from}_${applied.to}`}
          title={`تقرير الربحية — ${LEVEL_META[level].label}`}
          subtitle={subtitle}
          totalsRow={totalsRow}
          disabled={rows.length === 0}
        />
      </div>

      {/* Level toggle */}
      <div className="rounded-2xl border bg-gradient-to-br from-slate-50 to-slate-100/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <p className="text-xs text-muted-foreground">مستوى التقرير</p>
            <p className="text-sm font-bold flex items-center gap-2 mt-0.5">
              <LevelIcon className="h-4 w-4 text-primary" /> {LEVEL_META[level].label}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">{LEVEL_META[level].desc}</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(LEVEL_META) as ProfitabilityLevel[]).map(k => {
            const Meta = LEVEL_META[k];
            const Icon = Meta.icon;
            const active = level === k;
            return (
              <button
                key={k}
                onClick={() => setLevel(k)}
                className={cn(
                  "rounded-xl border p-3 text-right transition-all",
                  active
                    ? "ring-2 ring-offset-1 ring-primary bg-white shadow-sm"
                    : "bg-white/60 hover:bg-white hover:shadow-sm border-muted",
                )}
              >
                <Icon className={cn("h-5 w-5 mb-1.5", active ? "text-primary" : "text-muted-foreground")} />
                <p className="text-xs font-bold">{Meta.label}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{Meta.desc}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-2xl border bg-gradient-to-br from-emerald-50/60 to-teal-50/30 p-5 space-y-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold flex items-center gap-2 text-emerald-700">
            <Filter className="h-4 w-4" /> الفلاتر
          </h3>
          {hasAnyFilter && (
            <Button size="sm" variant="ghost" className="text-xs h-7" onClick={reset}>
              <X className="h-3 w-3 ml-1" /> تفريغ الفلاتر
            </Button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">من تاريخ</Label>
            <Input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">إلى تاريخ</Label>
            <Input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">الفرع</Label>
            <SearchCombobox
              items={[{ value: "", label: "جميع الفروع" }, ...(branches as any[]).map(b => ({ value: String(b.id), label: b.nameAr ?? b.name ?? "" }))]}
              value={filters.branchId}
              onValueChange={v => setFilters(f => ({ ...f, branchId: v }))}
              placeholder="جميع الفروع"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">العميل</Label>
            <SearchCombobox
              items={[{ value: "", label: "جميع العملاء" }, ...(customers as any[]).map(c => ({ value: String(c.id), label: `${c.nameAr ?? c.name ?? ""} ${c.code ? `— ${c.code}` : ""}` }))]}
              value={filters.customerId}
              onValueChange={v => setFilters(f => ({ ...f, customerId: v }))}
              placeholder="جميع العملاء"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">الصنف (اختياري)</Label>
            <SearchCombobox
              items={[{ value: "", label: "جميع الأصناف" }, ...(items as any[]).map(i => ({ value: String(i.id), label: `${i.nameAr ?? i.code} ${i.code ? `— ${i.code}` : ""}` }))]}
              value={filters.itemId}
              onValueChange={v => setFilters(f => ({ ...f, itemId: v }))}
              placeholder="جميع الأصناف"
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-3 flex items-end">
            <Button onClick={apply} className={cn("w-full text-white", LEVEL_META[level].chip)}>
              <Filter className="h-4 w-4 ml-2" /> عرض التقرير
            </Button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="rounded-xl border bg-blue-50 border-blue-200 p-4">
          <p className="text-xs text-blue-700">صافي البيع (بدون ضريبة)</p>
          <p className="text-2xl font-bold text-blue-700 tabular-nums mt-1">{fmt(totals.revenue)}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-4">
          <p className="text-xs text-amber-700">تكلفة البضاعة المباعة</p>
          <p className="text-2xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totals.cogs)}</p>
        </div>
        <div className={cn("rounded-xl border p-4", totals.profit >= 0 ? "bg-emerald-50 border-emerald-200" : "bg-rose-50 border-rose-200")}>
          <p className={cn("text-xs", totals.profit >= 0 ? "text-emerald-700" : "text-rose-700")}>هامش الربح</p>
          <p className={cn("text-2xl font-bold tabular-nums mt-1", totals.profit >= 0 ? "text-emerald-700" : "text-rose-700")}>{fmt(totals.profit)}</p>
        </div>
        <div className={cn("rounded-xl border p-4", totals.margin >= 0 ? "bg-emerald-50 border-emerald-200" : "bg-rose-50 border-rose-200")}>
          <p className={cn("text-xs", totals.margin >= 0 ? "text-emerald-700" : "text-rose-700")}>نسبة الربح</p>
          <p className={cn("text-2xl font-bold tabular-nums mt-1", totals.margin >= 0 ? "text-emerald-700" : "text-rose-700")}>{totals.margin.toFixed(2)}%</p>
        </div>
      </div>

      {/* Results table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[980px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{LEVEL_META[level].firstColHeader}</th>
                {level === "invoice"
                  ? <>
                      <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">التاريخ</th>
                      <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">العميل</th>
                    </>
                  : <th className="px-4 py-3 text-center font-semibold text-muted-foreground">عدد الفواتير</th>}
                <th className="px-4 py-3 text-center font-semibold text-blue-700">صافي البيع</th>
                <th className="px-4 py-3 text-center font-semibold text-amber-700">تكلفة البضاعة</th>
                <th className="px-4 py-3 text-center font-semibold text-emerald-700">هامش الربح</th>
                <th className="px-4 py-3 text-center font-semibold text-emerald-700">نسبة الربح %</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(isLoading || isFetching)
                ? [...Array(5)].map((_, i) => (
                    <tr key={i}><td colSpan={7} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>
                  ))
                : rows.length === 0
                ? <tr><td colSpan={7} className="py-12 text-center text-muted-foreground">
                    <PackageOpen className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    لا توجد بيانات للفترة / الفلاتر المحددة
                  </td></tr>
                : rows.map((r) => (
                    <tr key={r.key} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <p className="font-medium text-sm">{r.label}</p>
                        {level === "invoice" && r.sublabel && (
                          <p className="text-[10px] text-muted-foreground md:hidden">{r.sublabel}</p>
                        )}
                      </td>
                      {level === "invoice"
                        ? <>
                            <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground tabular-nums">{r.invoiceDate ?? "—"}</td>
                            <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">{r.sublabel ?? "—"}</td>
                          </>
                        : <td className="px-4 py-3 text-center tabular-nums text-sm">{r.docCount}</td>}
                      <td className="px-4 py-3 text-center tabular-nums text-blue-700 font-medium">{fmt(r.revenue)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-amber-700 font-medium">{fmt(r.cogs)}</td>
                      <td className={cn("px-4 py-3 text-center tabular-nums font-bold", r.profit >= 0 ? "text-emerald-700" : "text-rose-700")}>{fmt(r.profit)}</td>
                      <td className={cn("px-4 py-3 text-center tabular-nums font-bold", r.margin >= 0 ? "text-emerald-700" : "text-rose-700")}>{r.margin.toFixed(2)}%</td>
                    </tr>
                  ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="bg-muted/40 border-t-2">
                <tr>
                  <td className="px-4 py-3 font-bold text-sm" colSpan={level === "invoice" ? 3 : 2}>الإجمالي</td>
                  <td className="px-4 py-3 text-center tabular-nums font-bold text-blue-700">{fmt(totals.revenue)}</td>
                  <td className="px-4 py-3 text-center tabular-nums font-bold text-amber-700">{fmt(totals.cogs)}</td>
                  <td className={cn("px-4 py-3 text-center tabular-nums font-bold", totals.profit >= 0 ? "text-emerald-700" : "text-rose-700")}>{fmt(totals.profit)}</td>
                  <td className={cn("px-4 py-3 text-center tabular-nums font-bold", totals.margin >= 0 ? "text-emerald-700" : "text-rose-700")}>{totals.margin.toFixed(2)}%</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
