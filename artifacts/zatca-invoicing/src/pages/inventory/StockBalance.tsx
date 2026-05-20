import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import ExportButtons from "@/components/ExportButtons";
import { BarChart2, AlertTriangle, Search, Coins, Tag, Receipt } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { useFmt } from "@/hooks/use-fmt";

export default function StockBalance() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`inventoryReports.stockBalance.${k}`, opts) as string;
  const pickName = (ar?: string | null, en?: string | null) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const { fmt, fmtQty, fmtCost, fmtVal } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [warehouseId, setWarehouseId] = useState("");
  const [search, setSearch] = useState("");
  const [showBelowReorder, setShowBelowReorder] = useState(false);

  // ─── أساس الحساب (Calculation Basis) ───────────────────────────────
  // يحدد كيف تُحسب "القيمة" + "إجمالي القيمة" في التقرير:
  //   • cost        → متوسط التكلفة الفعلية من دفتر المخزون (avgCost)
  //   • sale        → سعر البيع للصنف (item.salePrice) — بدون ضريبة
  //   • saleWithVat → سعر البيع × (1 + vatRate/100)
  // يُحفظ الاختيار في localStorage حتى يبقى ثابتاً بين الزيارات.
  type Basis = "cost" | "sale" | "saleWithVat";
  const [basis, setBasis] = useState<Basis>(() => {
    if (typeof window === "undefined") return "cost";
    const v = window.localStorage.getItem("stockBalance.basis");
    return (v === "sale" || v === "saleWithVat") ? v : "cost";
  });
  const updateBasis = (b: Basis) => {
    setBasis(b);
    try { window.localStorage.setItem("stockBalance.basis", b); } catch { /* ignore */ }
  };
  // السعر الوحدوي المستخدم في الحساب حسب الأساس المختار:
  const unitPriceFor = (r: any): number => {
    if (basis === "cost") return Number(r.avgCost ?? 0);
    const sale = Number(r.item?.salePrice ?? 0);
    if (basis === "sale") return sale;
    const vat = Number(r.item?.vatRate ?? 0);
    return sale * (1 + vat / 100);
  };

  // عناوين أعمدة التصدير — تتبع أساس الحساب المختار حتى لا يحدث
  // تضارب دلالي بين عنوان العمود وقيمته في ملف Excel/PDF المُصدَّر.
  // (basisLabel تُحسب لاحقاً بعد filtered، لذا نُكرّر المنطق هنا بشكل
  //  محلّي صغير لتجنّب تبعية ترتيب التصريحات.)
  const basisShort = basis === "cost"
    ? (isRtl ? "بسعر التكلفة" : "At cost")
    : basis === "sale"
      ? (isRtl ? "بسعر البيع (بدون ضريبة)" : "At sale (excl. VAT)")
      : (isRtl ? "بسعر البيع (شامل الضريبة)" : "At sale (incl. VAT)");
  const priceHeader = basis === "cost"
    ? (tr("exportAvgCost"))
    : basis === "sale"
      ? (isRtl ? "سعر البيع (بدون ضريبة)" : "Sale price (excl. VAT)")
      : (isRtl ? "سعر البيع (شامل الضريبة)" : "Sale price (incl. VAT)");
  const valueHeader = `${tr("exportValue")} — ${basisShort}`;
  const EXPORT_COLS = [
    { key: "itemCode",     header: tr("exportItemCode"),  width: 16 },
    { key: "itemName",     header: tr("exportItemName"),  width: 30 },
    { key: "groupName",    header: t("inventoryMaster.itemGroups.colName") as string, width: 20 },
    { key: "unitName",     header: tr("exportUnit"),      width: 14 },
    { key: "warehouseName",header: tr("exportWarehouse"), width: 22 },
    { key: "qty",          header: tr("exportQty"),       width: 14 },
    { key: "avgCost",      header: priceHeader,           width: 22 },
    { key: "totalValue",   header: valueHeader,           width: 26 },
  ];

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["stock-balance", cid, warehouseId],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid)          params.companyId   = String(cid);
      if (warehouseId)  params.warehouseId = warehouseId;
      return inventoryApi.getBalance(params);
    },
  });

  const filtered = rows.filter((r: any) => {
    const matchText = !search || r.item?.nameAr?.includes(search) || r.item?.nameEn?.toLowerCase().includes(search.toLowerCase()) || r.item?.code?.includes(search);
    const matchReorder = !showBelowReorder || Number(r.qty) < Number(r.item?.reorderLevel ?? 0);
    return matchText && matchReorder;
  });

  const totalValue = filtered.reduce((s: number, r: any) => s + Number(r.qty) * unitPriceFor(r), 0);
  const belowReorderCount = rows.filter((r: any) => Number(r.item?.reorderLevel) > 0 && Number(r.qty) < Number(r.item?.reorderLevel)).length;

  // عنوان عمود/كرت "القيمة" يتغيّر حسب أساس الحساب — كي يفهم القارئ
  // ماذا تمثّل الأرقام بدون الحاجة للرجوع للمحدِّد.
  const basisLabel = basis === "cost"
    ? (isRtl ? "بسعر التكلفة" : "At cost")
    : basis === "sale"
      ? (isRtl ? "بسعر البيع (بدون ضريبة)" : "At sale (excl. VAT)")
      : (isRtl ? "بسعر البيع (شامل الضريبة)" : "At sale (incl. VAT)");

  const exportRows = filtered.map((r: any) => ({
    itemCode:      r.item?.code ?? "",
    itemName:      pickName(r.item?.nameAr, r.item?.nameEn),
    groupName:     pickName(r.group?.nameAr, r.group?.nameEn),
    unitName:      pickName(r.unit?.nameAr, r.unit?.nameEn),
    warehouseName: pickName(r.warehouse?.nameAr, r.warehouse?.nameEn),
    qty:           fmtQty(r.qty),
    avgCost:       fmtCost(unitPriceFor(r)),
    totalValue:    fmt(Number(r.qty) * unitPriceFor(r)),
  }));

  // ─── خيارات أساس الحساب — معروضة كـ Segmented Pill Control ───────
  // تصميم مدمج (شريط واحد) مختلف عن البطاقات الكبيرة في لقطة الشاشة
  // المرجعية، مع أيقونة لكل خيار + شرح في tooltip، وانتقال ناعم
  // (animated thumb) عند التبديل بفضل خاصية data-active + Tailwind.
  const BASIS_OPTIONS: Array<{ key: Basis; icon: any; label: string; hint: string; color: string }> = [
    { key: "cost",        icon: Coins,   label: isRtl ? "بسعر التكلفة"            : "At cost",            hint: isRtl ? "متوسط التكلفة الفعلية من دفتر المخزون"     : "Actual avg cost from stock ledger",  color: "emerald" },
    { key: "sale",        icon: Tag,     label: isRtl ? "بسعر البيع (بدون ضريبة)" : "At sale (excl. VAT)", hint: isRtl ? "صافي الإيرادات بعد استبعاد ضريبة القيمة المضافة" : "Net revenue (excluding VAT)",        color: "sky" },
    { key: "saleWithVat", icon: Receipt, label: isRtl ? "بسعر البيع (شامل الضريبة)": "At sale (incl. VAT)", hint: isRtl ? "إجمالي البيع شاملاً ضريبة القيمة المضافة"      : "Gross sale (including VAT)",          color: "violet" },
  ];

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><BarChart2 className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${tr("exportFilename")}-${new Date().toISOString().slice(0,10)}`}
          title={tr("exportTitle")}
          subtitle={warehouseId ? pickName(warehouses.find((w: any) => String(w.id) === warehouseId)?.nameAr, warehouses.find((w: any) => String(w.id) === warehouseId)?.nameEn) : (t("inventoryReports.common.allWarehouses") as string)}
        />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{tr("totalValue")}</p>
            {/* وسم صغير يوضّح أساس الحساب الحالي بجوار الرقم الكبير،
                حتى لا يحتاج المستخدم للنظر للأسفل ليعرف ما يمثّله. */}
            <span className={cn(
              "text-[10px] px-1.5 py-0.5 rounded-full font-medium border",
              basis === "cost"        && "bg-emerald-50 text-emerald-700 border-emerald-200",
              basis === "sale"        && "bg-sky-50 text-sky-700 border-sky-200",
              basis === "saleWithVat" && "bg-violet-50 text-violet-700 border-violet-200",
            )}>{basisLabel}</span>
          </div>
          <p className="text-2xl font-bold tabular-nums mt-1">{fmtVal(totalValue)}</p>
          <p className="text-xs text-muted-foreground">{isRtl ? "ريال سعودي" : "SAR"}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">{tr("totalItems")}</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{filtered.length}</p>
          <p className="text-xs text-muted-foreground">{isRtl ? "صنف × مخزن" : "item × warehouse"}</p>
        </div>
        {belowReorderCount > 0 && (
          <div className="rounded-xl border bg-amber-50 border-amber-200 p-4">
            <p className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle className="h-3 w-3" />{isRtl ? "أصناف تحت حد الطلب" : "Items below reorder level"}</p>
            <p className="text-2xl font-bold text-amber-700 tabular-nums mt-1">{belowReorderCount}</p>
            <button onClick={() => setShowBelowReorder(p => !p)} className="text-xs text-amber-600 underline">
              {showBelowReorder ? (isRtl ? "إظهار الكل" : "Show all") : (isRtl ? "عرض فقط" : "Show only these")}
            </button>
          </div>
        )}
      </div>

      {/* ─── أساس الحساب (Segmented Pill Control) ───────────────────
          شريط مدمج بـ 3 خيارات بدلاً من 3 كروت كبيرة كما في لقطة
          الشاشة المرفقة. كل خيار له:
            • أيقونة + اسم + شرح تحت الاسم
            • حدّ ولون مميز يتفعّل عند الاختيار (emerald/sky/violet)
            • أنميشن ناعم (transition + ring) للتأكيد البصري
          الكلّ في صف واحد على الشاشات الكبيرة وعمودي على الجوال. */}
      <div className="rounded-2xl border bg-gradient-to-bl from-card to-muted/20 p-3 sm:p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
            <span className="inline-block w-1 h-4 rounded-full bg-primary" />
            {isRtl ? "أساس الحساب" : "Calculation basis"}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {isRtl ? "اختر كيف تُحسب القيمة الإجمالية لرصيد المخزون" : "Choose how the total inventory value is calculated"}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {BASIS_OPTIONS.map(opt => {
            const Icon = opt.icon;
            const active = basis === opt.key;
            // ألوان tailwind صريحة لكل خيار حتى لا تُحذَف من الـ JIT
            const colorMap: Record<string, { ring: string; bg: string; border: string; text: string; icon: string; chip: string }> = {
              emerald: { ring: "ring-emerald-400/50", bg: "bg-emerald-50",  border: "border-emerald-400",  text: "text-emerald-900", icon: "text-emerald-600", chip: "bg-emerald-100 text-emerald-700" },
              sky:     { ring: "ring-sky-400/50",     bg: "bg-sky-50",      border: "border-sky-400",      text: "text-sky-900",     icon: "text-sky-600",     chip: "bg-sky-100 text-sky-700" },
              violet:  { ring: "ring-violet-400/50",  bg: "bg-violet-50",   border: "border-violet-400",   text: "text-violet-900",  icon: "text-violet-600",  chip: "bg-violet-100 text-violet-700" },
            };
            const c = colorMap[opt.color];
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => updateBasis(opt.key)}
                aria-pressed={active}
                title={opt.hint}
                className={cn(
                  "group relative text-start rounded-xl border-2 p-3 transition-all duration-200",
                  "hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2",
                  active
                    ? cn(c.bg, c.border, c.text, "shadow-sm ring-2", c.ring)
                    : "bg-card border-border/60 text-muted-foreground hover:border-border",
                )}
              >
                <div className="flex items-start gap-2.5">
                  <div className={cn(
                    "shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-colors",
                    active ? c.chip : "bg-muted text-muted-foreground group-hover:bg-muted/80",
                  )}>
                    <Icon className={cn("h-4.5 w-4.5", active ? c.icon : "")} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm font-bold leading-tight", active ? "" : "text-foreground/80")}>{opt.label}</p>
                    <p className={cn("text-[10.5px] leading-snug mt-0.5", active ? "opacity-80" : "text-muted-foreground")}>{opt.hint}</p>
                  </div>
                  {/* علامة "صح" صغيرة عند التفعيل — تأكيد بصري إضافي */}
                  {active && (
                    <span className={cn("shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold", c.chip)}>✓</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
          <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={tr("searchPh")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="w-full sm:w-72">
          <SearchCombobox
            items={[{ value: "", label: t("inventoryReports.common.allWarehouses") as string }, ...(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: pickName(w.nameAr, w.nameEn) }))]}
            value={warehouseId}
            onValueChange={setWarehouseId}
            placeholder={t("inventoryReports.common.allWarehouses") as string}
          />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colItem")}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden sm:table-cell`}>{t("inventoryMaster.itemGroups.colName") as string}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden md:table-cell`}>{tr("colWarehouse")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("colQty")}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden lg:table-cell`}>{tr("colUnit")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">
                  {basis === "cost" ? tr("colAvgCost") : (isRtl ? "السعر" : "Price")}
                </th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">
                  <div className="flex flex-col items-center leading-tight">
                    <span>{tr("colValue")}</span>
                    {/* وسم صغير يخبر القارئ بأي أساس تُحسب القيمة */}
                    <span className={cn(
                      "text-[9px] font-normal mt-0.5 px-1.5 rounded-full",
                      basis === "cost"        && "bg-emerald-50 text-emerald-700",
                      basis === "sale"        && "bg-sky-50 text-sky-700",
                      basis === "saleWithVat" && "bg-violet-50 text-violet-700",
                    )}>{basisLabel}</span>
                  </div>
                </th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{isRtl ? "الحالة" : "Status"}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(8)].map((_, i) => <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : filtered.length === 0
                ? <tr><td colSpan={8} className="py-12 text-center text-muted-foreground"><BarChart2 className="h-8 w-8 mx-auto mb-2 opacity-30" />{tr("noBalance")}</td></tr>
                : filtered.map((r: any) => {
                    const qty = Number(r.qty);
                    const reorder = Number(r.item?.reorderLevel ?? 0);
                    const isZero  = qty === 0;
                    const isLow   = reorder > 0 && qty < reorder;
                    const unitPrice = unitPriceFor(r);
                    const totalVal = qty * unitPrice;
                    return (
                      <tr key={r.id} className={cn("hover:bg-muted/20", isZero ? "bg-red-50/30" : isLow ? "bg-amber-50/30" : "")}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-sm">{pickName(r.item?.nameAr, r.item?.nameEn) || "—"}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">{r.item?.code}</p>
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">{pickName(r.group?.nameAr, r.group?.nameEn) || "—"}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-xs">{pickName(r.warehouse?.nameAr, r.warehouse?.nameEn) || "—"}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn("font-bold tabular-nums", isZero ? "text-red-600" : isLow ? "text-amber-600" : "")}>
                            {fmtQty(qty)}
                          </span>
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground text-center">{pickName(r.unit?.nameAr, r.unit?.nameEn) || "—"}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-xs tabular-nums text-center">{fmtCost(unitPrice)}</td>
                        <td className={cn(
                          "px-4 py-3 text-center tabular-nums text-sm font-semibold",
                          basis === "sale"        && "text-sky-700",
                          basis === "saleWithVat" && "text-violet-700",
                        )}>{fmt(totalVal)}</td>
                        <td className="px-4 py-3 text-center">
                          {isZero
                            ? <span className="text-[10px] bg-red-50 text-red-600 rounded-full px-2 py-0.5 font-medium">{isRtl ? "نفاد" : "Out"}</span>
                            : isLow
                            ? <span className="text-[10px] bg-amber-50 text-amber-700 rounded-full px-2 py-0.5 font-medium flex items-center gap-1 w-fit mx-auto"><AlertTriangle className="h-2.5 w-2.5" />{isRtl ? "تحت الحد" : "Low"}</span>
                            : <span className="text-[10px] bg-green-50 text-green-700 rounded-full px-2 py-0.5 font-medium">{isRtl ? "عادي" : "OK"}</span>
                          }
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
            {!isLoading && filtered.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={6} className={`px-4 py-3 text-xs font-semibold text-muted-foreground ${isRtl ? "text-right" : "text-left"}`}>{tr("totalValue")}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums">
                    {fmtVal(totalValue)} {isRtl ? "ر.س" : "SAR"}
                  </td>
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
