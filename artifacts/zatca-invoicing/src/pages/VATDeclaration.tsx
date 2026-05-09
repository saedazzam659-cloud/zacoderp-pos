import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FileText, Printer, CalendarRange, Building2,
  AlertCircle, Hash, BadgePercent, ReceiptText,
  ArrowDownToLine, ArrowUpFromLine, Scale,
  Download, FileSpreadsheet, ChevronDown, BookOpen,
  ExternalLink, Eye, Loader2, Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { useFmt } from "@/hooks/use-fmt";
import { exportToExcel, printSectionsAsPDF } from "@/lib/export";

const API = import.meta.env.VITE_API_URL ?? "";

function fmtNum(n: number) {
  return n.toLocaleString("en-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type PeriodKey = "this_month" | "last_month" | "q1" | "q2" | "q3" | "q4" | "this_year";

const now = new Date();
const Y = now.getFullYear();

function lastDay(y: number, month: number) {
  return new Date(y, month + 1, 0).toISOString().slice(0, 10);
}

const PERIOD_DEFS: { key: PeriodKey; from: string; to: string }[] = [
  {
    key: "this_month",
    from: `${Y}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
    to: lastDay(Y, now.getMonth()),
  },
  {
    key: "last_month",
    from: `${Y}-${String(now.getMonth()).padStart(2, "0")}-01`,
    to: lastDay(Y, now.getMonth() - 1),
  },
  { key: "q1", from: `${Y}-01-01`, to: `${Y}-03-31` },
  { key: "q2", from: `${Y}-04-01`, to: `${Y}-06-30` },
  { key: "q3", from: `${Y}-07-01`, to: `${Y}-09-30` },
  { key: "q4", from: `${Y}-10-01`, to: `${Y}-12-31` },
  { key: "this_year", from: `${Y}-01-01`, to: `${Y}-12-31` },
];

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
  returns?: {
    sales:     { base: number; vat: number; count: number };
    purchases: { base: number; vat: number; count: number };
  };
  netVat: number;
  discountTotal: number;
  invoiceBreakdown: { standardTypeCount: number; simplifiedTypeCount: number; totalCount: number };
  // Manual VAT corrections recorded directly in the journal (corrections,
  // accruals, write-offs). The backend filters out auto-generated entries
  // from invoices/vouchers to avoid double counting. Sign convention:
  //   outputVat: positive = additional output VAT due, negative = correction
  //   inputVat:  positive = additional recoverable VAT, negative = correction
  journalAdjustments?: {
    outputVat: number;
    inputVat:  number;
    entryCount: number;
    entries: Array<{
      id: number;
      docNumber: string | null;
      entryDate: string;
      description: string | null;
      entryType: string;
      outputVat: number;
      inputVat:  number;
    }>;
  };
}

async function fetchVAT(from: string, to: string, token: string | null, errMsg: string): Promise<VATData> {
  const qs = `from=${from}&to=${to}`;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}/api/reports/vat-declaration?${qs}`, {
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => null);
    throw new Error(msg?.error ?? errMsg);
  }
  return res.json();
}

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

function TableHeader({ t }: { t: (k: string) => string }) {
  return (
    <thead>
      <tr className="text-xs font-semibold text-muted-foreground bg-muted/50 border-b border-border">
        <th className="w-10 px-3 py-2.5 text-center">{t("vatDeclaration.colNum")}</th>
        <th className="px-5 py-2.5 text-right">{t("vatDeclaration.colDescription")}</th>
        <th className="px-5 py-2.5 text-left w-48 border-r border-border/50">{t("vatDeclaration.colTaxableBase")}</th>
        <th className="px-5 py-2.5 text-left w-44">{t("vatDeclaration.colVatAmount")}</th>
      </tr>
    </thead>
  );
}

function TRow({
  num, label, base, vat, highlight, subtext, bucket, onDrillDown,
}: {
  num: string;
  label: string;
  base: number | null;
  vat: number | null;
  highlight?: "green" | "blue" | "total";
  subtext?: string;
  bucket?: string;
  onDrillDown?: (bucket: string, label: string) => void;
}) {
  const clickable = !!bucket && !!onDrillDown;
  const rowClass = highlight
    ? ({
        green: "bg-emerald-50/70 dark:bg-emerald-950/20 font-semibold",
        blue:  "bg-blue-50/70 dark:bg-blue-950/20 font-semibold",
        total: "bg-slate-100 dark:bg-slate-800/50 font-bold border-t-2 border-border",
      } as const)[highlight]
    : "hover:bg-muted/30";

  const handleClick = () => { if (clickable) onDrillDown!(bucket!, label); };
  return (
    <tr
      className={cn(
        "border-b border-border/40 text-sm transition-colors",
        rowClass,
        clickable && "cursor-pointer hover:bg-primary/5 group",
      )}
      onClick={handleClick}
      title={clickable ? "اعرض العمليات الناتج عنها هذه القيمة" : undefined}
    >
      <td className="w-10 px-3 py-3 text-center text-xs text-muted-foreground font-medium">{num}</td>
      <td className="px-5 py-3">
        <span className="inline-flex items-center gap-1.5">
          {label}
          {clickable && (
            <Eye className="h-3.5 w-3.5 text-primary/40 group-hover:text-primary transition-colors no-print" />
          )}
        </span>
        {subtext && <span className="block text-xs text-muted-foreground mt-0.5">{subtext}</span>}
      </td>
      <td
        className={cn(
          "px-5 py-3 text-left border-r border-border/40 tabular-nums font-mono text-sm",
          clickable && "group-hover:text-primary group-hover:underline decoration-dotted underline-offset-4",
        )}
      >
        {base !== null ? fmtNum(base) : <span className="text-muted-foreground">—</span>}
      </td>
      <td
        className={cn(
          "px-5 py-3 text-left tabular-nums font-mono text-sm",
          clickable && "group-hover:text-primary group-hover:underline decoration-dotted underline-offset-4",
        )}
      >
        {vat !== null ? fmtNum(vat) : <span className="text-muted-foreground">—</span>}
      </td>
    </tr>
  );
}

// ── Drill-down modal ──────────────────────────────────────────────────
interface DetailDoc {
  id: number;
  source: string;
  docNumber: string | null;
  date: string;
  partyName: string | null;
  base: number;
  vat: number;
  total: number;
  link: string | null;
}
interface DetailResp {
  bucket: string;
  period: { from: string; to: string };
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
    queryKey: ["vat-declaration-details", from, to, bucket],
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

        {/* KPI strip */}
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

        {/* Search */}
        <div className="relative">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ابحث برقم المستند، الاسم، أو التاريخ..."
            className="pr-10"
          />
        </div>

        {/* List */}
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
                          <Link href={d.link}>
                            <a className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-primary/10 text-primary" title="فتح المستند">
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
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

function InfoPill({ label, value, icon: Icon }: { label: string; value: string; icon?: React.ElementType }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

export default function VATDeclaration() {
  const { user, token } = useAuth();
  const { t, i18n } = useTranslation();
  const [selectedKey, setSelectedKey] = useState<PeriodKey>("this_month");
  const [drill, setDrill] = useState<{ bucket: string; label: string } | null>(null);
  const openDrill = (bucket: string, label: string) => setDrill({ bucket, label });

  const isAr = i18n.language?.startsWith("ar");
  const dateLocale = isAr ? "ar-SA-u-nu-latn" : "en-US";

  const periodLabel = (k: PeriodKey): string => {
    switch (k) {
      case "this_month": return t("vatDeclaration.periodThisMonth");
      case "last_month": return t("vatDeclaration.periodLastMonth");
      case "q1":         return t("vatDeclaration.periodQ1", { year: Y });
      case "q2":         return t("vatDeclaration.periodQ2", { year: Y });
      case "q3":         return t("vatDeclaration.periodQ3", { year: Y });
      case "q4":         return t("vatDeclaration.periodQ4", { year: Y });
      case "this_year":  return t("vatDeclaration.periodFullYear", { year: Y });
    }
  };

  const PERIODS = useMemo(
    () => PERIOD_DEFS.map(p => ({ ...p, label: periodLabel(p.key) })),
    [i18n.language],
  );

  const period = PERIODS.find(p => p.key === selectedKey) ?? PERIODS[0];

  function fmtSAR(n: number) {
    return `${fmtNum(n)} ${t("vatDeclaration.sar")}`;
  }

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString(dateLocale, {
      year: "numeric", month: "long", day: "numeric",
    });
  }

  const errMsg = t("vatDeclaration.loadError");

  const { data, isLoading, error } = useQuery<VATData>({
    queryKey: ["vat-declaration", period.from, period.to, token],
    queryFn: () => fetchVAT(period.from, period.to, token, errMsg),
    enabled: !!token,
  });

  const netVat      = data?.netVat ?? 0;
  const netPositive = netVat >= 0;
  const companyName = (isAr ? data?.company?.nameAr : (data?.company?.nameEn ?? data?.company?.nameAr))
    ?? (isAr ? user?.company?.nameAr : (user?.company?.nameEn ?? user?.company?.nameAr))
    ?? "—";
  const altCompanyName = isAr ? data?.company?.nameEn : data?.company?.nameAr;
  const vatNumber   = data?.company?.vatNumber;
  const crNumber    = data?.company?.crNumber;

  return (
    <div className="space-y-0 max-w-5xl mx-auto">

      {/* ── TOP TOOLBAR ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5 no-print">
        <div>
          <h1 className="text-xl font-bold">{t("vatDeclaration.title")}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{t("vatDeclaration.subtitle")}</p>
        </div>
        <div className="flex items-end gap-2">
          <Select value={selectedKey} onValueChange={v => setSelectedKey(v as PeriodKey)}>
            <SelectTrigger className="w-48 h-9 text-sm gap-2">
              <CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map(p => (
                <SelectItem key={p.key} value={p.key} className="text-sm">{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {data && <VATExportMenu data={data} period={period} />}
          <Button size="sm" variant="outline" className="gap-2 h-9" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" />
            {t("vatDeclaration.print")}
          </Button>
        </div>
      </div>

      {/* ── LOADING ─────────────────────────────────────────────────────────── */}
      {isLoading && (
        <div className="flex items-center justify-center py-32">
          <div className="animate-spin rounded-full h-10 w-10 border-4 border-primary border-t-transparent" />
        </div>
      )}

      {/* ── ERROR ───────────────────────────────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
          <AlertCircle className="h-5 w-5 shrink-0" />
          {t("vatDeclaration.loadError")}
        </div>
      )}

      {data && !isLoading && (
        <div className="rounded-2xl border border-border shadow-sm overflow-hidden bg-card">

          {/* ── DOCUMENT HEADER ──────────────────────────────────────────────── */}
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
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-primary-foreground/90">
                {vatNumber && (
                  <div>
                    <span className="text-primary-foreground/60 text-xs">{t("vatDeclaration.vatNumber")}</span>
                    <p className="font-mono font-semibold tracking-wide">{vatNumber}</p>
                  </div>
                )}
                {crNumber && (
                  <div>
                    <span className="text-primary-foreground/60 text-xs">{t("vatDeclaration.crNumber")}</span>
                    <p className="font-mono">{crNumber}</p>
                  </div>
                )}
                {data.company?.city && (
                  <div>
                    <span className="text-primary-foreground/60 text-xs">{t("vatDeclaration.city")}</span>
                    <p>{data.company.city}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── PERIOD STRIP ─────────────────────────────────────────────────── */}
          <div className="bg-muted/40 border-b border-border px-6 py-3 flex flex-wrap items-center gap-x-8 gap-y-2">
            <InfoPill icon={CalendarRange} label={t("vatDeclaration.taxPeriod")}  value={period.label} />
            <InfoPill label={t("vatDeclaration.fromDate")} value={fmtDate(period.from)} />
            <InfoPill label={t("vatDeclaration.toDate")}   value={fmtDate(period.to)} />
            <div className="mr-auto flex gap-x-5 gap-y-2 flex-wrap">
              <InfoPill icon={Hash}        label={t("vatDeclaration.totalInvoices")}    value={t("vatDeclaration.invoicesUnit", { count: data.invoiceBreakdown.totalCount })} />
              <InfoPill icon={ReceiptText} label={t("vatDeclaration.taxInvoiceShort")}  value={`${data.invoiceBreakdown.standardTypeCount}`} />
              <InfoPill icon={ReceiptText} label={t("vatDeclaration.simplifiedShort")} value={`${data.invoiceBreakdown.simplifiedTypeCount}`} />
            </div>
          </div>

          {/* ── KPI SUMMARY CARDS ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-3 divide-x divide-x-reverse divide-border border-b border-border">
            {/* Output VAT */}
            <div className="px-6 py-4">
              <div className="flex items-center gap-2 mb-1">
                <ArrowUpFromLine className="h-4 w-4 text-emerald-600" />
                <span className="text-xs text-muted-foreground font-medium">{t("vatDeclaration.outputVat")}</span>
              </div>
              <p className="text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                {fmtNum(data.outputTax.total.vat)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("vatDeclaration.baseLabel")}: {fmtNum(data.outputTax.total.base)} {t("vatDeclaration.sar")}
              </p>
            </div>

            {/* Input VAT */}
            <div className="px-6 py-4">
              <div className="flex items-center gap-2 mb-1">
                <ArrowDownToLine className="h-4 w-4 text-blue-600" />
                <span className="text-xs text-muted-foreground font-medium">{t("vatDeclaration.inputVat")}</span>
              </div>
              <p className="text-2xl font-bold tabular-nums text-blue-700 dark:text-blue-400">
                {fmtNum(data.inputTax.total.vat)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("vatDeclaration.baseLabel")}: {fmtNum(data.inputTax.total.base)} {t("vatDeclaration.sar")}
              </p>
            </div>

            {/* Net VAT */}
            <div className={cn("px-6 py-4", netPositive ? "bg-red-50/60 dark:bg-red-950/20" : "bg-green-50/60 dark:bg-green-950/20")}>
              <div className="flex items-center gap-2 mb-1">
                <Scale className={cn("h-4 w-4", netPositive ? "text-red-600" : "text-green-600")} />
                <span className="text-xs text-muted-foreground font-medium">
                  {netPositive ? t("vatDeclaration.netDueLabel") : t("vatDeclaration.refundDueLabel")}
                </span>
              </div>
              <p className={cn(
                "text-2xl font-bold tabular-nums",
                netPositive ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400",
              )}>
                {fmtNum(Math.abs(netVat))}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("vatDeclaration.netVatRow")}
              </p>
            </div>
          </div>

          {/* ── SECTION 1: OUTPUT TAX ─────────────────────────────────────────── */}
          <SectionHeader color="green" icon={ArrowUpFromLine} title={t("vatDeclaration.outputTaxSection")} />

          <div className="overflow-x-auto">
            <table className="w-full">
              <TableHeader t={t} />
              <tbody>
                <TRow
                  num="1"
                  label={t("vatDeclaration.rowSalesStandard")}
                  subtext={`${t("vatDeclaration.ratePrefix")}: ${t("vatDeclaration.rate15")}`}
                  base={data.outputTax.standardRated.base}
                  vat={data.outputTax.standardRated.vat}
                  bucket="sales_standard"
                  onDrillDown={openDrill}
                />
                <TRow
                  num="2"
                  label={t("vatDeclaration.rowSalesZero")}
                  subtext={`${t("vatDeclaration.ratePrefix")}: ${t("vatDeclaration.rate0")}`}
                  base={data.outputTax.zeroRated.base}
                  vat={data.outputTax.zeroRated.vat}
                  bucket="sales_zero"
                  onDrillDown={openDrill}
                />
                <TRow
                  num="3"
                  label={t("vatDeclaration.rowSalesExempt")}
                  base={data.outputTax.exempt.base}
                  vat={null}
                  bucket="sales_exempt"
                  onDrillDown={openDrill}
                />
                {data.discountTotal > 0 && (
                  <TRow
                    num="4"
                    label={t("vatDeclaration.rowTotalDiscounts")}
                    base={data.discountTotal}
                    vat={null}
                  />
                )}
                <TRow
                  num={data.discountTotal > 0 ? "5" : "4"}
                  label={t("vatDeclaration.rowTotalSales")}
                  base={data.outputTax.total.base}
                  vat={data.outputTax.total.vat}
                  highlight="green"
                />
              </tbody>
            </table>
          </div>

          {/* ── SECTION 2: INPUT TAX ──────────────────────────────────────────── */}
          <div className="border-t border-border">
            <SectionHeader color="blue" icon={ArrowDownToLine} title={t("vatDeclaration.inputTaxSection")} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <TableHeader t={t} />
              <tbody>
                <TRow
                  num="5"
                  label={t("vatDeclaration.rowPurchaseStandard")}
                  subtext={`${t("vatDeclaration.ratePrefix")}: ${t("vatDeclaration.rate15")}`}
                  base={data.inputTax.standardRated.base}
                  vat={data.inputTax.standardRated.vat}
                  bucket="purchases_standard"
                  onDrillDown={openDrill}
                />
                <TRow
                  num="6"
                  label={t("vatDeclaration.rowPurchaseZero")}
                  subtext={`${t("vatDeclaration.ratePrefix")}: ${t("vatDeclaration.rate0")}`}
                  base={data.inputTax.zeroRated.base}
                  vat={data.inputTax.zeroRated.vat}
                  bucket="purchases_zero"
                  onDrillDown={openDrill}
                />
                <TRow
                  num="7"
                  label={t("vatDeclaration.rowPurchaseExempt")}
                  base={data.inputTax.exempt.base}
                  vat={null}
                  bucket="purchases_exempt"
                  onDrillDown={openDrill}
                />
                <TRow
                  num="8"
                  label={t("vatDeclaration.rowTotalPurchases")}
                  base={data.inputTax.total.base}
                  vat={data.inputTax.total.vat}
                  highlight="blue"
                />
              </tbody>
            </table>
          </div>

          {/* ── SECTION 2.5: JOURNAL ENTRY ADJUSTMENTS ─────────────────────── */}
          {/* Manual VAT corrections recorded directly in the journal (e.g.    */}
          {/* an external auditor adjustment, period-end accrual, or write-   */}
          {/* off). Auto-generated entries from invoices/vouchers are filtered */}
          {/* out by the backend so figures are not double counted.            */}
          <div className="border-t border-border">
            <SectionHeader color="slate" icon={BookOpen} title={t("vatDeclaration.journalAdjustmentsSection")} />
          </div>

          {data.journalAdjustments && data.journalAdjustments.entryCount > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-xs font-semibold text-muted-foreground bg-muted/50 border-b border-border">
                    <th className="w-10 px-3 py-2.5 text-center">{t("vatDeclaration.colNum")}</th>
                    <th className="px-5 py-2.5 text-right">{t("vatDeclaration.colJEDate")}</th>
                    <th className="px-5 py-2.5 text-right">{t("vatDeclaration.colJEDocNum")}</th>
                    <th className="px-5 py-2.5 text-right">{t("vatDeclaration.colDescription")}</th>
                    <th className="px-5 py-2.5 text-left w-40 border-r border-border/50">{t("vatDeclaration.colJEOutputVat")}</th>
                    <th className="px-5 py-2.5 text-left w-40">{t("vatDeclaration.colJEInputVat")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.journalAdjustments.entries.map((e, idx) => (
                    <tr key={e.id} className="border-b border-border/40 text-sm hover:bg-muted/30">
                      <td className="w-10 px-3 py-3 text-center text-xs text-muted-foreground font-medium">{idx + 1}</td>
                      <td className="px-5 py-3 tabular-nums">{fmtDate(e.entryDate)}</td>
                      <td className="px-5 py-3 font-mono text-xs">{e.docNumber ?? "—"}</td>
                      <td className="px-5 py-3 text-muted-foreground">{e.description ?? "—"}</td>
                      <td className="px-5 py-3 text-left border-r border-border/40 tabular-nums font-mono text-sm">
                        {Math.abs(e.outputVat) > 0.005 ? fmtNum(e.outputVat) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-5 py-3 text-left tabular-nums font-mono text-sm">
                        {Math.abs(e.inputVat) > 0.005 ? fmtNum(e.inputVat) : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-100 dark:bg-slate-800/50 font-bold border-t-2 border-border text-sm">
                    <td className="w-10 px-3 py-3" />
                    <td className="px-5 py-3" colSpan={3}>{t("vatDeclaration.rowJETotalAdjustments")}</td>
                    <td className="px-5 py-3 text-left border-r border-border/40 tabular-nums font-mono">
                      {fmtNum(data.journalAdjustments.outputVat)}
                    </td>
                    <td className="px-5 py-3 text-left tabular-nums font-mono">
                      {fmtNum(data.journalAdjustments.inputVat)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-5 py-6 text-center text-sm text-muted-foreground border-b border-border/40">
              {t("vatDeclaration.journalAdjustmentsEmpty")}
            </div>
          )}

          {/* ── NOTE ──────────────────────────────────────────────────────────── */}
          <div className="flex items-start gap-2.5 px-5 py-3 bg-blue-50/80 dark:bg-blue-950/20 border-t border-blue-200/60 dark:border-blue-800/40 no-print">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-blue-600" />
            <p className="text-xs text-blue-700 dark:text-blue-400 leading-relaxed">
              <strong>{t("vatDeclaration.noteIntro")}</strong> {t("vatDeclaration.noteText")}
            </p>
          </div>

          {/* ── SECTION 3: NET VAT ────────────────────────────────────────────── */}
          <div className="border-t border-border">
            <SectionHeader color="slate" icon={Scale} title={t("vatDeclaration.netVatSection")} />
          </div>

          <div className="px-6 py-5 border-t border-border/40">
            <div className="rounded-xl border border-border overflow-hidden max-w-lg">
              <div className="flex items-center justify-between px-5 py-3 border-b border-border/60 bg-emerald-50/60 dark:bg-emerald-950/20">
                <span className="text-sm text-emerald-800 dark:text-emerald-300">{t("vatDeclaration.outputVatTotalLine")}</span>
                <span className="font-mono font-semibold tabular-nums text-emerald-800 dark:text-emerald-300">
                  {fmtSAR(data.outputTax.total.vat)}
                </span>
              </div>
              <div className="flex items-center justify-between px-5 py-3 border-b border-border/60 bg-blue-50/60 dark:bg-blue-950/20">
                <span className="text-sm text-blue-800 dark:text-blue-300">{t("vatDeclaration.inputVatTotalLine")}</span>
                <span className="font-mono font-semibold tabular-nums text-blue-800 dark:text-blue-300">
                  ({fmtSAR(data.inputTax.total.vat)})
                </span>
              </div>
              <div className={cn(
                "flex items-center justify-between px-5 py-4",
                netPositive
                  ? "bg-red-600 text-white"
                  : "bg-green-600 text-white",
              )}>
                <span className="font-semibold text-sm">
                  {netPositive ? t("vatDeclaration.netDueRow") : t("vatDeclaration.refundDueRow")}
                </span>
                <span className="font-mono font-bold text-lg tabular-nums">
                  {fmtSAR(Math.abs(netVat))}
                </span>
              </div>
            </div>

            {/* Invoice breakdown chips */}
            <div className="flex flex-wrap gap-3 mt-5">
              <Chip icon={BadgePercent} label={t("vatDeclaration.chipTotalSalesBase")} value={fmtSAR(data.outputTax.total.base)} />
              <Chip icon={FileText}     label={t("vatDeclaration.chipTaxInvoiceB2B")}  value={t("vatDeclaration.invoicesUnit", { count: data.invoiceBreakdown.standardTypeCount })} />
              <Chip icon={FileText}     label={t("vatDeclaration.chipSimplifiedB2C")}  value={t("vatDeclaration.invoicesUnit", { count: data.invoiceBreakdown.simplifiedTypeCount })} />
            </div>
          </div>

          {/* ── PRINT FOOTER ─────────────────────────────────────────────────── */}
          <div className="hidden print:block border-t border-border px-6 py-4 text-center text-xs text-muted-foreground">
            <p>{t("vatDeclaration.printFooter1")}</p>
            <p className="mt-1">{t("vatDeclaration.printedOn", { date: new Date().toLocaleDateString(dateLocale) })}</p>
          </div>
        </div>
      )}

      {/* ── EMPTY STATE ──────────────────────────────────────────────────────── */}
      {data && data.invoiceBreakdown.totalCount === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3 mt-4">
          <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center">
            <FileText className="h-8 w-8 text-muted-foreground/50" />
          </div>
          <div>
            <p className="font-semibold text-muted-foreground">{t("vatDeclaration.emptyTitle")}</p>
            <p className="text-sm text-muted-foreground/60 mt-1">{t("vatDeclaration.emptyHint")}</p>
          </div>
        </div>
      )}

      {/* ── PRINT STYLES ─────────────────────────────────────────────────────── */}
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
        from={period.from}
        to={period.to}
        token={token}
      />
    </div>
  );
}

function Chip({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground">{label}:</span>
      <span className="text-xs font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function VATExportMenu({
  data, period,
}: {
  data: VATData;
  period: { label: string; from: string; to: string };
}) {
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith("ar");
  const companyName = (isAr ? data.company?.nameAr : (data.company?.nameEn ?? data.company?.nameAr)) ?? "";
  const { dp } = useFmt();
  // Pull `user` so we can fall back to the auth-context company logo
  // when the report payload omits it — keeps every printed PDF
  // consistently branded regardless of which side carries the value.
  const { user } = useAuth();

  const VAT_COLS = [
    { key: "section", header: t("vatDeclaration.exportColSection"), width: 14 },
    { key: "num",     header: t("vatDeclaration.colNum"),           width: 6  },
    { key: "label",   header: t("vatDeclaration.exportColLabel"),   width: 50 },
    { key: "base",    header: t("vatDeclaration.exportColBase"),    width: 28 },
    { key: "vat",     header: t("vatDeclaration.exportColVat"),     width: 24 },
  ];

  const SEC_INFO   = t("vatDeclaration.exportSectionInfo");
  const SEC_OUTPUT = t("vatDeclaration.exportSectionOutput");
  const SEC_INPUT  = t("vatDeclaration.exportSectionInput");
  const SEC_NET    = t("vatDeclaration.exportSectionNet");

  function fmtN(n: number) {
    return n.toFixed(dp);
  }

  function buildRows() {
    const rows: Record<string, unknown>[] = [
      { section: SEC_INFO, num: "", label: t("vatDeclaration.exportCompany"),       base: companyName,                                     vat: "" },
      { section: SEC_INFO, num: "", label: t("vatDeclaration.exportVatNumber"),     base: data.company?.vatNumber ?? "",                   vat: "" },
      { section: SEC_INFO, num: "", label: t("vatDeclaration.exportTaxPeriod"),     base: period.label,                                    vat: "" },
      { section: SEC_INFO, num: "", label: t("vatDeclaration.exportFromDate"),      base: period.from,                                     vat: "" },
      { section: SEC_INFO, num: "", label: t("vatDeclaration.exportToDate"),        base: period.to,                                       vat: "" },
      { section: SEC_INFO, num: "", label: t("vatDeclaration.exportInvoiceCount"),  base: data.invoiceBreakdown.totalCount,                vat: "" },
      { section: "", num: "", label: "", base: "", vat: "" },
      { section: SEC_OUTPUT, num: "1", label: t("vatDeclaration.exportRowSalesStandard"), base: fmtN(data.outputTax.standardRated.base), vat: fmtN(data.outputTax.standardRated.vat) },
      { section: SEC_OUTPUT, num: "2", label: t("vatDeclaration.exportRowSalesZero"),     base: fmtN(data.outputTax.zeroRated.base),     vat: fmtN(data.outputTax.zeroRated.vat) },
      { section: SEC_OUTPUT, num: "3", label: t("vatDeclaration.exportRowSalesExempt"),   base: fmtN(data.outputTax.exempt.base),        vat: "—" },
      { section: SEC_OUTPUT, num: "4", label: t("vatDeclaration.exportRowTotalSales"),    base: fmtN(data.outputTax.total.base),         vat: fmtN(data.outputTax.total.vat) },
      { section: "", num: "", label: "", base: "", vat: "" },
      { section: SEC_INPUT, num: "5", label: t("vatDeclaration.exportRowPurchaseStandard"), base: fmtN(data.inputTax.standardRated.base), vat: fmtN(data.inputTax.standardRated.vat) },
      { section: SEC_INPUT, num: "6", label: t("vatDeclaration.exportRowPurchaseZero"),     base: fmtN(data.inputTax.zeroRated.base),     vat: fmtN(data.inputTax.zeroRated.vat) },
      { section: SEC_INPUT, num: "7", label: t("vatDeclaration.exportRowPurchaseExempt"),   base: fmtN(data.inputTax.exempt.base),        vat: "—" },
      { section: SEC_INPUT, num: "8", label: t("vatDeclaration.exportRowTotalPurchases"),   base: fmtN(data.inputTax.total.base),         vat: fmtN(data.inputTax.total.vat) },
      { section: "", num: "", label: "", base: "", vat: "" },
      { section: SEC_NET, num: "", label: t("vatDeclaration.outputVat"),                   base: fmtN(data.outputTax.total.vat), vat: "" },
      { section: SEC_NET, num: "", label: t("vatDeclaration.exportInputVatDeducted"),      base: fmtN(data.inputTax.total.vat),  vat: "" },
      { section: SEC_NET, num: "", label: t("vatDeclaration.exportNetVatDue"),             base: fmtN(data.netVat),              vat: "" },
    ];
    return rows;
  }

  function handleExcel() {
    exportToExcel(
      buildRows(),
      VAT_COLS,
      `${t("vatDeclaration.exportFilenamePrefix")}-${period.from}-${period.to}`,
      t("vatDeclaration.exportSheetName"),
    );
  }

  const INFO_COLS  = [
    { key: "label", header: t("vatDeclaration.exportColLabel"),  width: 40 },
    { key: "base",  header: t("vatDeclaration.exportColValue"),  width: 40 },
  ];
  const TABLE_COLS = [
    { key: "num",   header: t("vatDeclaration.colNum"),           width: 6  },
    { key: "label", header: t("vatDeclaration.exportColLabel"),   width: 54 },
    { key: "base",  header: t("vatDeclaration.exportColBase"),    width: 28 },
    { key: "vat",   header: t("vatDeclaration.exportColVat"),     width: 24 },
  ];
  const NET_COLS = [
    { key: "label", header: t("vatDeclaration.exportColLabel"),     width: 54 },
    { key: "base",  header: t("vatDeclaration.exportNetAmount"),    width: 28 },
  ];

  function handlePDF() {
    printSectionsAsPDF(
      [
        {
          title: t("vatDeclaration.exportSectionInfo"),
          color: "#1e40af",
          columns: INFO_COLS,
          rows: [
            { label: t("vatDeclaration.exportCompanyName"), base: companyName },
            { label: t("vatDeclaration.exportVatNumber"),   base: data.company?.vatNumber ?? "" },
            { label: t("vatDeclaration.exportTaxPeriod"),   base: period.label },
            { label: t("vatDeclaration.exportFromDate"),    base: period.from },
            { label: t("vatDeclaration.exportToDate"),      base: period.to },
            { label: t("vatDeclaration.exportInvoiceCount"), base: String(data.invoiceBreakdown.totalCount) },
          ],
        },
        {
          title: t("vatDeclaration.printSection1"),
          color: "#15803d",
          columns: TABLE_COLS,
          rows: [
            { num: "1", label: t("vatDeclaration.exportRowSalesStandard"), base: fmtN(data.outputTax.standardRated.base), vat: fmtN(data.outputTax.standardRated.vat) },
            { num: "2", label: t("vatDeclaration.exportRowSalesZero"),     base: fmtN(data.outputTax.zeroRated.base),     vat: fmtN(data.outputTax.zeroRated.vat) },
            { num: "3", label: t("vatDeclaration.exportRowSalesExempt"),   base: fmtN(data.outputTax.exempt.base),        vat: "—" },
            { num: "4", label: t("vatDeclaration.exportRowTotalSales"),    base: fmtN(data.outputTax.total.base),         vat: fmtN(data.outputTax.total.vat) },
          ],
        },
        {
          title: t("vatDeclaration.printSection2"),
          color: "#1d4ed8",
          columns: TABLE_COLS,
          rows: [
            { num: "5", label: t("vatDeclaration.exportRowPurchaseStandard"), base: fmtN(data.inputTax.standardRated.base), vat: fmtN(data.inputTax.standardRated.vat) },
            { num: "6", label: t("vatDeclaration.exportRowPurchaseZero"),     base: fmtN(data.inputTax.zeroRated.base),     vat: fmtN(data.inputTax.zeroRated.vat) },
            { num: "7", label: t("vatDeclaration.exportRowPurchaseExempt"),   base: fmtN(data.inputTax.exempt.base),        vat: "—" },
            { num: "8", label: t("vatDeclaration.exportRowTotalPurchases"),   base: fmtN(data.inputTax.total.base),         vat: fmtN(data.inputTax.total.vat) },
          ],
        },
        {
          title: t("vatDeclaration.printSection3"),
          color: "#7c3aed",
          columns: NET_COLS,
          rows: [
            { label: t("vatDeclaration.outputVat"),                       base: fmtN(data.outputTax.total.vat) },
            { label: t("vatDeclaration.exportInputVatDeductible"),        base: fmtN(data.inputTax.total.vat) },
            { label: t("vatDeclaration.exportNetVatDue"),                 base: fmtN(data.netVat) },
          ],
        },
      ],
      t("vatDeclaration.printDocTitle"),
      `${companyName} — ${period.label} (${period.from} ${t("vatDeclaration.toDate")} ${period.to})`,
      // The VAT declaration export resolves the company from the loaded
      // declaration data; forward its logo so the printed PDF carries
      // the same branding as every other report.  The narrow type from
      // the OpenAPI codegen doesn't include `logo`, hence the cast.
      // Falls back to the auth context's company logo when the report
      // payload omits it — keeps every PDF consistently branded
      // regardless of which side carries the value.
      (((data.company as any)?.logo as string | null)
        ?? ((user?.company as any)?.logo as string | null)
        ?? null),
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="gap-2 h-9">
          <Download className="h-3.5 w-3.5" />
          {t("vatDeclaration.exportLabel")}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("vatDeclaration.exportMenuLabel")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={handleExcel}>
          <FileSpreadsheet className="h-4 w-4 text-green-600" />
          {t("vatDeclaration.excel")}
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={handlePDF}>
          <FileText className="h-4 w-4 text-red-500" />
          {t("vatDeclaration.pdf")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
