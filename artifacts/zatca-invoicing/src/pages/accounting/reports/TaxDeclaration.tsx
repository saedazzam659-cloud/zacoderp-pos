import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  FileText, Printer, CalendarRange, Building2, AlertCircle,
  Hash, BadgePercent, ReceiptText, ArrowDownToLine, ArrowUpFromLine,
  Scale, BookOpen, Search, Sparkles, History, ExternalLink, Eye, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────
// Number / date helpers — kept local so the page is self-contained and
// the Arabic-Latin numerals stay consistent with the rest of the
// accounting reports (TrialBalance, BalanceSheet, …).
// ─────────────────────────────────────────────────────────────────────
function fmtNum(n: number) {
  return n.toLocaleString("en-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function lastDayOfMonth(y: number, m0: number) {
  // m0 is 0-indexed; Date(y, m0+1, 0) → last day of month m0
  return new Date(y, m0 + 1, 0).getDate();
}
function ymd(y: number, m1: number, d: number) {
  return `${y}-${String(m1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────
// Period presets — designed so the user can jump to any historical
// month / quarter / year with a single click. The "year" selector
// feeds the same preset definitions, so picking 2023 → Q2 gives you
// 2023-04-01 .. 2023-06-30 instantly. "Custom" bypasses the presets
// and uses the from/to inputs directly.
// ─────────────────────────────────────────────────────────────────────
type PresetKey =
  | "this_month" | "last_month"
  | "q1" | "q2" | "q3" | "q4"
  | "h1" | "h2"
  | "this_year" | "last_year"
  | "custom";

function presetRange(key: PresetKey, year: number, today: Date): { from: string; to: string } | null {
  const Y = year;
  const tY = today.getFullYear();
  const tM = today.getMonth(); // 0-11
  switch (key) {
    case "this_month": {
      // "this month" is anchored to today, regardless of the year picker —
      // users expect "هذا الشهر" to mean the literal current month.
      return { from: ymd(tY, tM + 1, 1), to: ymd(tY, tM + 1, lastDayOfMonth(tY, tM)) };
    }
    case "last_month": {
      const lm = new Date(tY, tM - 1, 1);
      return { from: ymd(lm.getFullYear(), lm.getMonth() + 1, 1),
               to:   ymd(lm.getFullYear(), lm.getMonth() + 1, lastDayOfMonth(lm.getFullYear(), lm.getMonth())) };
    }
    case "q1":        return { from: `${Y}-01-01`, to: `${Y}-03-31` };
    case "q2":        return { from: `${Y}-04-01`, to: `${Y}-06-30` };
    case "q3":        return { from: `${Y}-07-01`, to: `${Y}-09-30` };
    case "q4":        return { from: `${Y}-10-01`, to: `${Y}-12-31` };
    case "h1":        return { from: `${Y}-01-01`, to: `${Y}-06-30` };
    case "h2":        return { from: `${Y}-07-01`, to: `${Y}-12-31` };
    case "this_year": return { from: `${Y}-01-01`, to: `${Y}-12-31` };
    case "last_year": return { from: `${Y - 1}-01-01`, to: `${Y - 1}-12-31` };
    case "custom":    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Backend response shape — identical to /api/reports/vat-declaration
// (already used by the legacy `/vat-declaration` page). We reuse the
// same endpoint so historical data comes from the single source of
// truth and there's no risk of the two pages diverging.
// ─────────────────────────────────────────────────────────────────────
interface VATData {
  period: { from: string; to: string };
  company: { nameAr: string; nameEn?: string; vatNumber?: string; crNumber?: string; city?: string } | null;
  outputTax: {
    standardRated: { base: number; vat: number; count: number };
    zeroRated:     { base: number; vat: number; count: number };
    exempt:        { base: number; vat: number; count: number };
    total:         { base: number; vat: number; count: number };
  };
  inputTax: {
    standardRated: { base: number; vat: number };
    zeroRated:     { base: number; vat: number };
    exempt:        { base: number; vat: number };
    total:         { base: number; vat: number };
  };
  netVat: number;
  discountTotal: number;
  invoiceBreakdown: { standardTypeCount: number; simplifiedTypeCount: number; totalCount: number };
  journalAdjustments?: {
    outputVat: number;
    inputVat:  number;
    entryCount: number;
    entries: Array<{
      id: number; docNumber: string | null; entryDate: string;
      description: string | null; entryType: string;
      outputVat: number; inputVat: number;
    }>;
  };
}

// Shared building blocks — kept minimal & self-contained so future
// designers can restyle this page without touching VATDeclaration.tsx.
function SectionHeader({
  color, icon: Icon, title,
}: { color: "green" | "blue" | "slate"; icon: React.ElementType; title: string }) {
  const styles = {
    green: "bg-emerald-600 text-white",
    blue:  "bg-blue-600   text-white",
    slate: "bg-slate-700  text-white",
  }[color];
  return (
    <div className={cn("flex items-center gap-2.5 px-5 py-2.5", styles)}>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="font-semibold text-sm tracking-wide">{title}</span>
    </div>
  );
}

function TRow({
  num, label, base, vat, highlight, subtext, bucket, onDrillDown,
}: {
  num: string;
  label: string;
  base: number | null;
  vat: number | null;
  highlight?: "green" | "blue";
  subtext?: string;
  bucket?: string;
  onDrillDown?: (bucket: string, label: string) => void;
}) {
  const clickable = !!bucket && !!onDrillDown;
  const rowClass = highlight
    ? ({
        green: "bg-emerald-50/70 dark:bg-emerald-950/20 font-semibold",
        blue:  "bg-blue-50/70 dark:bg-blue-950/20 font-semibold",
      } as const)[highlight]
    : "hover:bg-muted/30";

  return (
    <tr
      className={cn(
        "border-b border-border/40 text-sm transition-colors",
        rowClass,
        clickable && "cursor-pointer hover:bg-primary/5 group",
      )}
      onClick={() => clickable && onDrillDown!(bucket!, label)}
      title={clickable ? "اعرض العمليات الناتج عنها هذه القيمة" : undefined}
    >
      <td className="w-10 px-3 py-3 text-center text-xs text-muted-foreground font-medium">{num}</td>
      <td className="px-5 py-3">
        <span className="inline-flex items-center gap-1.5">
          {label}
          {clickable && <Eye className="h-3.5 w-3.5 text-primary/40 group-hover:text-primary transition-colors no-print" />}
        </span>
        {subtext && <span className="block text-xs text-muted-foreground mt-0.5">{subtext}</span>}
      </td>
      <td className={cn(
        "px-5 py-3 text-left border-r border-border/40 tabular-nums font-mono text-sm",
        clickable && "group-hover:text-primary group-hover:underline decoration-dotted underline-offset-4",
      )}>
        {base !== null ? fmtNum(base) : <span className="text-muted-foreground">—</span>}
      </td>
      <td className={cn(
        "px-5 py-3 text-left tabular-nums font-mono text-sm",
        clickable && "group-hover:text-primary group-hover:underline decoration-dotted underline-offset-4",
      )}>
        {vat !== null ? fmtNum(vat) : <span className="text-muted-foreground">—</span>}
      </td>
    </tr>
  );
}

// ── Drill-down modal ──────────────────────────────────────────────────
interface DetailDoc {
  id: number; source: string; docNumber: string | null; date: string;
  partyName: string | null; base: number; vat: number; total: number; link: string | null;
}
interface DetailResp {
  bucket: string; period: { from: string; to: string };
  items: DetailDoc[];
  totals: { base: number; vat: number; total: number; count: number };
}
const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  sales_invoice:    { label: "فاتورة بيع",      color: "bg-emerald-100 text-emerald-700" },
  legacy_invoice:   { label: "فاتورة (قديمة)",  color: "bg-emerald-100 text-emerald-700" },
  sales_return:     { label: "مرتجع بيع",       color: "bg-amber-100 text-amber-700" },
  purchase_invoice: { label: "فاتورة شراء",     color: "bg-blue-100 text-blue-700" },
  purchase_return:  { label: "مرتجع شراء",      color: "bg-amber-100 text-amber-700" },
};

function VatDrilldownDialog({
  open, onOpenChange, bucket, label, from, to, token,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  bucket: string | null;
  label: string;
  from: string;
  to: string;
  token: string | null;
}) {
  const [search, setSearch] = useState("");
  const { data, isLoading, error } = useQuery<DetailResp>({
    queryKey: ["tax-declaration-details", from, to, bucket],
    queryFn: async () => {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const r = await fetch(`${API}/api/reports/vat-declaration/details?from=${from}&to=${to}&bucket=${bucket}`, {
        headers, credentials: "include",
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "تعذر جلب التفاصيل");
      return r.json();
    },
    enabled: !!bucket && open,
  });

  const items = data?.items ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((d) =>
      (d.docNumber ?? "").toLowerCase().includes(q) ||
      (d.partyName ?? "").toLowerCase().includes(q) ||
      d.date.includes(q),
    );
  }, [items, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <FileText className="h-5 w-5 text-primary" />
            العمليات الناتج عنها: <span className="text-primary">{label}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            من {from} إلى {to} · {data ? `${data.totals.count} عملية` : "..."}
          </DialogDescription>
        </DialogHeader>

        {data && (
          <div className="grid grid-cols-3 gap-3 px-1">
            <div className="rounded-lg border bg-emerald-50/60 dark:bg-emerald-950/20 p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">عدد المستندات</p>
              <p className="text-xl font-bold tabular-nums text-emerald-700 dark:text-emerald-400">{data.totals.count}</p>
            </div>
            <div className="rounded-lg border bg-blue-50/60 dark:bg-blue-950/20 p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">إجمالي الوعاء</p>
              <p className="text-xl font-bold tabular-nums text-blue-700 dark:text-blue-400">{fmtNum(data.totals.base)}</p>
            </div>
            <div className="rounded-lg border bg-violet-50/60 dark:bg-violet-950/20 p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">إجمالي الضريبة</p>
              <p className="text-xl font-bold tabular-nums text-violet-700 dark:text-violet-400">{fmtNum(data.totals.vat)}</p>
            </div>
          </div>
        )}

        <div className="relative">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ابحث برقم المستند، الاسم، أو التاريخ..."
            className="pr-10"
          />
        </div>

        <div className="flex-1 overflow-y-auto rounded-lg border">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" /> جارِ التحميل...
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 p-4 text-destructive text-sm">
              <AlertCircle className="h-4 w-4" /> {(error as Error).message}
            </div>
          )}
          {!isLoading && !error && filtered.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-12">
              {items.length === 0 ? "لا توجد عمليات في هذه الفئة." : "لا توجد نتائج مطابقة."}
            </p>
          )}
          {!isLoading && filtered.length > 0 && (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                <tr className="text-xs text-muted-foreground">
                  <th className="px-3 py-2 text-right font-semibold">النوع</th>
                  <th className="px-3 py-2 text-right font-semibold">رقم المستند</th>
                  <th className="px-3 py-2 text-right font-semibold">التاريخ</th>
                  <th className="px-3 py-2 text-right font-semibold">العميل / المورد</th>
                  <th className="px-3 py-2 text-left font-semibold">الوعاء</th>
                  <th className="px-3 py-2 text-left font-semibold">الضريبة</th>
                  <th className="px-3 py-2 text-left font-semibold">الإجمالي</th>
                  <th className="w-12 px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => {
                  const meta = SOURCE_LABELS[d.source] ?? { label: d.source, color: "bg-gray-100 text-gray-700" };
                  return (
                    <tr key={`${d.source}-${d.id}`} className="border-t border-border/40 hover:bg-muted/30">
                      <td className="px-3 py-2.5">
                        <span className={cn("inline-block px-2 py-0.5 rounded text-[11px] font-medium", meta.color)}>{meta.label}</span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs">{d.docNumber ?? `#${d.id}`}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">{d.date}</td>
                      <td className="px-3 py-2.5 truncate max-w-[180px]">{d.partyName ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-3 py-2.5 text-left font-mono tabular-nums text-xs">{fmtNum(d.base)}</td>
                      <td className="px-3 py-2.5 text-left font-mono tabular-nums text-xs">{fmtNum(d.vat)}</td>
                      <td className="px-3 py-2.5 text-left font-mono tabular-nums text-xs font-semibold">{fmtNum(d.total)}</td>
                      <td className="px-2 py-2.5 text-center">
                        {d.link && (
                          <Link
                            href={d.link}
                            className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-primary/10 text-primary cursor-pointer"
                            title="فتح المستند"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function TaxDeclaration() {
  const { user, token } = useAuth() as any;
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith("ar");
  const dateLocale = isAr ? "ar-SA-u-nu-latn" : "en-US";

  const today = useMemo(() => new Date(), []);
  const currentYear = today.getFullYear();

  // Year selector: 10 years back + current + 1 future. Lets the user
  // open any old period that exists in the database without typing
  // dates manually.
  const yearOptions = useMemo(() => {
    const arr: number[] = [];
    for (let y = currentYear + 1; y >= currentYear - 10; y--) arr.push(y);
    return arr;
  }, [currentYear]);

  const [year, setYear] = useState<number>(currentYear);
  const [preset, setPreset] = useState<PresetKey>("this_month");
  const initial = presetRange("this_month", currentYear, today)!;
  const [fromDate, setFromDate] = useState<string>(initial.from);
  const [toDate,   setToDate]   = useState<string>(initial.to);
  const [searched, setSearched] = useState(false);
  const [drill, setDrill] = useState<{ bucket: string; label: string } | null>(null);
  const openDrill = (bucket: string, label: string) => setDrill({ bucket, label });

  // Applying a preset writes into the from/to inputs so the user can
  // see — and further tweak — the resolved date range. Switching to
  // "custom" just leaves whatever values are already in the inputs.
  function applyPreset(key: PresetKey, y: number = year) {
    setPreset(key);
    if (key === "custom") return;
    const r = presetRange(key, y, today);
    if (r) { setFromDate(r.from); setToDate(r.to); }
  }

  function onYearChange(y: number) {
    setYear(y);
    if (preset !== "custom" && preset !== "this_month" && preset !== "last_month") {
      const r = presetRange(preset, y, today);
      if (r) { setFromDate(r.from); setToDate(r.to); }
    }
  }

  const presetChips: { key: PresetKey; labelKey: string }[] = [
    { key: "this_month", labelKey: "taxDeclaration.presetThisMonth" },
    { key: "last_month", labelKey: "taxDeclaration.presetLastMonth" },
    { key: "q1",         labelKey: "taxDeclaration.presetQ1" },
    { key: "q2",         labelKey: "taxDeclaration.presetQ2" },
    { key: "q3",         labelKey: "taxDeclaration.presetQ3" },
    { key: "q4",         labelKey: "taxDeclaration.presetQ4" },
    { key: "h1",         labelKey: "taxDeclaration.presetH1" },
    { key: "h2",         labelKey: "taxDeclaration.presetH2" },
    { key: "this_year",  labelKey: "taxDeclaration.presetThisYear" },
    { key: "last_year",  labelKey: "taxDeclaration.presetLastYear" },
    { key: "custom",     labelKey: "taxDeclaration.presetCustom" },
  ];

  const { data, isLoading, error, refetch } = useQuery<VATData>({
    queryKey: ["tax-declaration", fromDate, toDate, token],
    enabled: !!token && searched,
    queryFn: async () => {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`${API}/api/reports/vat-declaration?from=${fromDate}&to=${toDate}`, {
        headers, credentials: "include",
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => null);
        throw new Error(msg?.error ?? t("taxDeclaration.loadError"));
      }
      return res.json();
    },
  });

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString(dateLocale, {
      year: "numeric", month: "long", day: "numeric",
    });
  }
  function fmtSAR(n: number) { return `${fmtNum(n)} ${t("taxDeclaration.sar")}`; }

  const netVat = data?.netVat ?? 0;
  const netPositive = netVat >= 0;
  const companyName = (isAr ? data?.company?.nameAr : (data?.company?.nameEn ?? data?.company?.nameAr))
    ?? (isAr ? user?.company?.nameAr : (user?.company?.nameEn ?? user?.company?.nameAr))
    ?? "—";
  const altCompanyName = isAr ? data?.company?.nameEn : data?.company?.nameAr;

  return (
    <div className="space-y-5 max-w-6xl mx-auto">
      {/* ─── HEADER ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3 no-print">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BadgePercent className="h-6 w-6 text-primary" />
            {t("taxDeclaration.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("taxDeclaration.subtitle")}</p>
        </div>
        {data && searched && (
          <Button variant="outline" size="sm" className="gap-2" onClick={() => window.print()}>
            <Printer className="h-4 w-4" />
            {t("taxDeclaration.print")}
          </Button>
        )}
      </div>

      {/* ─── FILTER PANEL ─────────────────────────────────────────────
          Eye-catching gradient card containing: year selector → preset
          chips → manual from/to inputs → apply button. Designed to
          make picking an old period feel one-click obvious.          */}
      <div className="rounded-2xl border bg-gradient-to-br from-primary/5 via-card to-emerald-50/40 dark:from-primary/10 dark:via-card dark:to-emerald-950/10 shadow-sm overflow-hidden no-print">
        <div className="px-5 py-3 border-b bg-card/60 backdrop-blur flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">{t("taxDeclaration.choosePeriod")}</span>
          <span className="text-xs text-muted-foreground mr-auto flex items-center gap-1">
            <History className="h-3.5 w-3.5" />
            {t("taxDeclaration.historicalHint")}
          </span>
        </div>

        <div className="p-5 space-y-4">
          {/* Year selector */}
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("taxDeclaration.year")}</Label>
              <Select value={String(year)} onValueChange={v => onYearChange(Number(v))}>
                <SelectTrigger className="w-32 h-10 gap-2 font-semibold">
                  <CalendarRange className="h-4 w-4 text-primary" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {yearOptions.map(y => (
                    <SelectItem key={y} value={String(y)} className="font-mono">{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex-1 min-w-0">
              <Label className="text-xs block mb-1.5">{t("taxDeclaration.quickPresets")}</Label>
              <div className="flex flex-wrap gap-1.5">
                {presetChips.map(p => {
                  const active = preset === p.key;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => applyPreset(p.key)}
                      className={cn(
                        "text-xs font-medium px-3 py-1.5 rounded-full border transition-all",
                        active
                          ? "bg-primary text-primary-foreground border-primary shadow-sm scale-[1.02]"
                          : "bg-background hover:bg-muted border-input hover:border-primary/40"
                      )}
                    >
                      {t(p.labelKey)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Manual date pickers + apply */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end pt-2 border-t border-dashed">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("taxDeclaration.fromDate")}</Label>
              <DateField
                value={fromDate}
                onChange={e => { setFromDate(e.target.value); setPreset("custom"); }}
                className="h-10"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("taxDeclaration.toDate")}</Label>
              <DateField
                value={toDate}
                onChange={e => { setToDate(e.target.value); setPreset("custom"); }}
                className="h-10"
              />
            </div>
            <Button
              className="h-10 gap-2"
              onClick={() => { setSearched(true); refetch(); }}
              disabled={isLoading || !fromDate || !toDate || fromDate > toDate}
            >
              <Search className="h-4 w-4" />
              {isLoading ? t("taxDeclaration.loading") : t("taxDeclaration.show")}
            </Button>
          </div>

          {fromDate && toDate && fromDate > toDate && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" />
              {t("taxDeclaration.invalidRange")}
            </div>
          )}
        </div>
      </div>

      {/* ─── LOADING / ERROR ───────────────────────────────────────── */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-4 border-primary border-t-transparent" />
        </div>
      )}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
          <AlertCircle className="h-5 w-5 shrink-0" />
          {(error as Error).message || t("taxDeclaration.loadError")}
        </div>
      )}

      {/* ─── EMPTY (no search yet) ─────────────────────────────────── */}
      {!searched && !isLoading && (
        <div className="rounded-2xl border bg-card p-12 text-center text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">{t("taxDeclaration.pickAndShow")}</p>
        </div>
      )}

      {/* ─── REPORT BODY ───────────────────────────────────────────── */}
      {data && searched && !isLoading && (
        <div className="rounded-2xl border border-border shadow-sm overflow-hidden bg-card">
          {/* Document header */}
          <div className="bg-primary px-6 py-4 text-primary-foreground print:bg-gray-800">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-white/20 flex items-center justify-center">
                  <Building2 className="h-5 w-5 text-white" />
                </div>
                <div>
                  <p className="font-bold text-base leading-tight">{companyName}</p>
                  {altCompanyName && (
                    <p className="text-xs text-primary-foreground/70 mt-0.5">{altCompanyName}</p>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
                {data.company?.vatNumber && (
                  <div>
                    <span className="text-primary-foreground/60 text-xs">{t("taxDeclaration.vatNumber")}</span>
                    <p className="font-mono font-semibold tracking-wide">{data.company.vatNumber}</p>
                  </div>
                )}
                {data.company?.crNumber && (
                  <div>
                    <span className="text-primary-foreground/60 text-xs">{t("taxDeclaration.crNumber")}</span>
                    <p className="font-mono">{data.company.crNumber}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Period strip */}
          <div className="bg-muted/40 border-b border-border px-6 py-3 flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
            <div className="flex items-center gap-2">
              <CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">{t("taxDeclaration.fromDate")}:</span>
              <span className="font-semibold">{fmtDate(data.period.from)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{t("taxDeclaration.toDate")}:</span>
              <span className="font-semibold">{fmtDate(data.period.to)}</span>
            </div>
            <div className="mr-auto flex items-center gap-2">
              <Hash className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">{t("taxDeclaration.totalInvoices")}:</span>
              <span className="font-semibold tabular-nums">{data.invoiceBreakdown.totalCount}</span>
            </div>
          </div>

          {/* KPI cards */}
          <div className="grid grid-cols-3 divide-x divide-x-reverse divide-border border-b border-border">
            <div className="px-6 py-4">
              <div className="flex items-center gap-2 mb-1">
                <ArrowUpFromLine className="h-4 w-4 text-emerald-600" />
                <span className="text-xs text-muted-foreground font-medium">{t("taxDeclaration.outputVat")}</span>
              </div>
              <p className="text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                {fmtNum(data.outputTax.total.vat)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("taxDeclaration.base")}: {fmtNum(data.outputTax.total.base)}
              </p>
            </div>
            <div className="px-6 py-4">
              <div className="flex items-center gap-2 mb-1">
                <ArrowDownToLine className="h-4 w-4 text-blue-600" />
                <span className="text-xs text-muted-foreground font-medium">{t("taxDeclaration.inputVat")}</span>
              </div>
              <p className="text-2xl font-bold tabular-nums text-blue-700 dark:text-blue-400">
                {fmtNum(data.inputTax.total.vat)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("taxDeclaration.base")}: {fmtNum(data.inputTax.total.base)}
              </p>
            </div>
            <div className={cn("px-6 py-4", netPositive ? "bg-red-50/60 dark:bg-red-950/20" : "bg-green-50/60 dark:bg-green-950/20")}>
              <div className="flex items-center gap-2 mb-1">
                <Scale className={cn("h-4 w-4", netPositive ? "text-red-600" : "text-green-600")} />
                <span className="text-xs text-muted-foreground font-medium">
                  {netPositive ? t("taxDeclaration.netDue") : t("taxDeclaration.refundDue")}
                </span>
              </div>
              <p className={cn(
                "text-2xl font-bold tabular-nums",
                netPositive ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400",
              )}>
                {fmtNum(Math.abs(netVat))}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{t("taxDeclaration.netVatRow")}</p>
            </div>
          </div>

          {/* Output tax */}
          <SectionHeader color="green" icon={ArrowUpFromLine} title={t("taxDeclaration.outputTaxSection")} />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs font-semibold text-muted-foreground bg-muted/50 border-b border-border">
                  <th className="w-10 px-3 py-2.5 text-center">#</th>
                  <th className="px-5 py-2.5 text-right">{t("taxDeclaration.description")}</th>
                  <th className="px-5 py-2.5 text-left w-48 border-r border-border/50">{t("taxDeclaration.taxableBase")}</th>
                  <th className="px-5 py-2.5 text-left w-44">{t("taxDeclaration.vatAmount")}</th>
                </tr>
              </thead>
              <tbody>
                <TRow num="1" label={t("taxDeclaration.salesStandard")} subtext="15%"
                  base={data.outputTax.standardRated.base} vat={data.outputTax.standardRated.vat}
                  bucket="sales_standard" onDrillDown={openDrill} />
                <TRow num="2" label={t("taxDeclaration.salesZero")} subtext="0%"
                  base={data.outputTax.zeroRated.base} vat={data.outputTax.zeroRated.vat}
                  bucket="sales_zero" onDrillDown={openDrill} />
                <TRow num="3" label={t("taxDeclaration.salesExempt")}
                  base={data.outputTax.exempt.base} vat={null}
                  bucket="sales_exempt" onDrillDown={openDrill} />
                <TRow num="4" label={t("taxDeclaration.totalSales")}
                  base={data.outputTax.total.base} vat={data.outputTax.total.vat} highlight="green" />
              </tbody>
            </table>
          </div>

          {/* Input tax */}
          <div className="border-t border-border">
            <SectionHeader color="blue" icon={ArrowDownToLine} title={t("taxDeclaration.inputTaxSection")} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs font-semibold text-muted-foreground bg-muted/50 border-b border-border">
                  <th className="w-10 px-3 py-2.5 text-center">#</th>
                  <th className="px-5 py-2.5 text-right">{t("taxDeclaration.description")}</th>
                  <th className="px-5 py-2.5 text-left w-48 border-r border-border/50">{t("taxDeclaration.taxableBase")}</th>
                  <th className="px-5 py-2.5 text-left w-44">{t("taxDeclaration.vatAmount")}</th>
                </tr>
              </thead>
              <tbody>
                <TRow num="5" label={t("taxDeclaration.purchaseStandard")} subtext="15%"
                  base={data.inputTax.standardRated.base} vat={data.inputTax.standardRated.vat}
                  bucket="purchases_standard" onDrillDown={openDrill} />
                <TRow num="6" label={t("taxDeclaration.purchaseZero")} subtext="0%"
                  base={data.inputTax.zeroRated.base} vat={data.inputTax.zeroRated.vat}
                  bucket="purchases_zero" onDrillDown={openDrill} />
                <TRow num="7" label={t("taxDeclaration.purchaseExempt")}
                  base={data.inputTax.exempt.base} vat={null}
                  bucket="purchases_exempt" onDrillDown={openDrill} />
                <TRow num="8" label={t("taxDeclaration.totalPurchases")}
                  base={data.inputTax.total.base} vat={data.inputTax.total.vat} highlight="blue" />
              </tbody>
            </table>
          </div>

          {/* Journal adjustments */}
          {data.journalAdjustments && data.journalAdjustments.entryCount > 0 && (
            <>
              <div className="border-t border-border">
                <SectionHeader color="slate" icon={BookOpen} title={t("taxDeclaration.journalAdjustments")} />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs font-semibold text-muted-foreground bg-muted/50 border-b">
                      <th className="px-5 py-2.5 text-right">{t("taxDeclaration.jeDate")}</th>
                      <th className="px-5 py-2.5 text-right">{t("taxDeclaration.jeDoc")}</th>
                      <th className="px-5 py-2.5 text-right">{t("taxDeclaration.description")}</th>
                      <th className="px-5 py-2.5 text-left w-40 border-r border-border/50">{t("taxDeclaration.outputVat")}</th>
                      <th className="px-5 py-2.5 text-left w-40">{t("taxDeclaration.inputVat")}</th>
                      <th className="w-12 px-2 py-2.5 no-print"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.journalAdjustments.entries.map(e => (
                      <tr key={e.id} className="border-b border-border/40 hover:bg-muted/30 group">
                        <td className="px-5 py-3 tabular-nums">{fmtDate(e.entryDate)}</td>
                        <td className="px-5 py-3 font-mono text-xs">
                          <Link
                            href={`/accounting/journals/${e.id}`}
                            className="text-primary hover:underline decoration-dotted underline-offset-4 cursor-pointer"
                            title="فتح القيد المحاسبي"
                          >
                            {e.docNumber ?? `#${e.id}`}
                          </Link>
                        </td>
                        <td className="px-5 py-3 text-muted-foreground">{e.description ?? "—"}</td>
                        <td className="px-5 py-3 text-left border-r border-border/40 tabular-nums font-mono">
                          {Math.abs(e.outputVat) > 0.005 ? fmtNum(e.outputVat) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-5 py-3 text-left tabular-nums font-mono">
                          {Math.abs(e.inputVat) > 0.005 ? fmtNum(e.inputVat) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-2 py-3 text-center no-print">
                          <Link
                            href={`/accounting/journals/${e.id}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded text-primary/60 hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer"
                            title="فتح القيد المحاسبي"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-100 dark:bg-slate-800/50 font-bold border-t-2 text-sm">
                      <td className="px-5 py-3" colSpan={3}>{t("taxDeclaration.totalAdjustments")}</td>
                      <td className="px-5 py-3 text-left border-r border-border/40 tabular-nums font-mono">
                        {fmtNum(data.journalAdjustments.outputVat)}
                      </td>
                      <td className="px-5 py-3 text-left tabular-nums font-mono">
                        {fmtNum(data.journalAdjustments.inputVat)}
                      </td>
                      <td className="px-2 py-3 no-print" />
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Net VAT summary */}
          <div className="border-t border-border">
            <SectionHeader color="slate" icon={Scale} title={t("taxDeclaration.netVatSection")} />
          </div>
          <div className="px-6 py-5">
            <div className="rounded-xl border border-border overflow-hidden max-w-lg">
              <div className="flex items-center justify-between px-5 py-3 border-b bg-emerald-50/60 dark:bg-emerald-950/20">
                <span className="text-sm text-emerald-800 dark:text-emerald-300">{t("taxDeclaration.outputVat")}</span>
                <span className="font-mono font-semibold tabular-nums text-emerald-800 dark:text-emerald-300">
                  {fmtSAR(data.outputTax.total.vat)}
                </span>
              </div>
              <div className="flex items-center justify-between px-5 py-3 border-b bg-blue-50/60 dark:bg-blue-950/20">
                <span className="text-sm text-blue-800 dark:text-blue-300">{t("taxDeclaration.inputVat")}</span>
                <span className="font-mono font-semibold tabular-nums text-blue-800 dark:text-blue-300">
                  ({fmtSAR(data.inputTax.total.vat)})
                </span>
              </div>
              <div className={cn(
                "flex items-center justify-between px-5 py-4",
                netPositive ? "bg-red-600 text-white" : "bg-green-600 text-white",
              )}>
                <span className="font-semibold text-sm">
                  {netPositive ? t("taxDeclaration.netDue") : t("taxDeclaration.refundDue")}
                </span>
                <span className="font-mono font-bold text-lg tabular-nums">
                  {fmtSAR(Math.abs(netVat))}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-3 mt-5 text-xs">
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border bg-muted/40">
                <ReceiptText className="h-3.5 w-3.5" />
                {t("taxDeclaration.taxInvoices")}: <strong>{data.invoiceBreakdown.standardTypeCount}</strong>
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border bg-muted/40">
                <ReceiptText className="h-3.5 w-3.5" />
                {t("taxDeclaration.simplifiedInvoices")}: <strong>{data.invoiceBreakdown.simplifiedTypeCount}</strong>
              </span>
            </div>
          </div>

          {/* Print footer */}
          <div className="hidden print:block border-t px-6 py-4 text-center text-xs text-muted-foreground">
            <p>{t("taxDeclaration.printFooter")}</p>
            <p className="mt-1">{t("taxDeclaration.printedOn")}: {new Date().toLocaleDateString(dateLocale)}</p>
          </div>
        </div>
      )}

      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; font-size: 11pt; }
          .shadow-sm { box-shadow: none !important; }
        }
      `}</style>

      {/* ── DRILL-DOWN MODAL ────────────────────────────────────────────── */}
      <VatDrilldownDialog
        open={!!drill}
        onOpenChange={(v) => { if (!v) setDrill(null); }}
        bucket={drill?.bucket ?? null}
        label={drill?.label ?? ""}
        from={fromDate}
        to={toDate}
        token={token}
      />
    </div>
  );
}
