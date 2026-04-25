import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
  Download, FileSpreadsheet, ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useFmt } from "@/hooks/use-fmt";
import { exportToExcel, printSectionsAsPDF } from "@/lib/export";

// ─── Constants ───────────────────────────────────────────────────────────────

const API = import.meta.env.VITE_API_URL ?? "";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtNum(n: number) {
  return n.toLocaleString("en-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtSAR(n: number) {
  return `${fmtNum(n)} ر.س`;
}

// ─── Period config ────────────────────────────────────────────────────────────

type PeriodKey = "this_month" | "last_month" | "q1" | "q2" | "q3" | "q4" | "this_year";

const now = new Date();
const Y = now.getFullYear();

function lastDay(y: number, month: number) {
  return new Date(y, month + 1, 0).toISOString().slice(0, 10);
}

const PERIODS: { key: PeriodKey; label: string; from: string; to: string }[] = [
  {
    key: "this_month", label: "الشهر الحالي",
    from: `${Y}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
    to: lastDay(Y, now.getMonth()),
  },
  {
    key: "last_month", label: "الشهر الماضي",
    from: `${Y}-${String(now.getMonth()).padStart(2, "0")}-01`,
    to: lastDay(Y, now.getMonth() - 1),
  },
  { key: "q1", label: `الربع الأول ${Y}`,    from: `${Y}-01-01`, to: `${Y}-03-31` },
  { key: "q2", label: `الربع الثاني ${Y}`,   from: `${Y}-04-01`, to: `${Y}-06-30` },
  { key: "q3", label: `الربع الثالث ${Y}`,   from: `${Y}-07-01`, to: `${Y}-09-30` },
  { key: "q4", label: `الربع الرابع ${Y}`,   from: `${Y}-10-01`, to: `${Y}-12-31` },
  { key: "this_year", label: `السنة الكاملة ${Y}`, from: `${Y}-01-01`, to: `${Y}-12-31` },
];

function arabicDate(iso: string) {
  return new Date(iso).toLocaleDateString("ar-SA-u-nu-latn", {
    year: "numeric", month: "long", day: "numeric",
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

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
  // Per-side returns surfaced as positive deductions; already netted into
  // outputTax / inputTax above. Optional for backwards compatibility with
  // older API responses.
  returns?: {
    sales:     { base: number; vat: number; count: number };
    purchases: { base: number; vat: number; count: number };
  };
  netVat: number;
  discountTotal: number;
  invoiceBreakdown: { standardTypeCount: number; simplifiedTypeCount: number; totalCount: number };
}

async function fetchVAT(from: string, to: string, token: string | null): Promise<VATData> {
  const qs = `from=${from}&to=${to}`;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}/api/reports/vat-declaration?${qs}`, {
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => null);
    throw new Error(msg?.error ?? "فشل في تحميل بيانات الإقرار. يرجى المحاولة مرة أخرى.");
  }
  return res.json();
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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

function TableHeader() {
  return (
    <thead>
      <tr className="text-xs font-semibold text-muted-foreground bg-muted/50 border-b border-border">
        <th className="w-10 px-3 py-2.5 text-center">#</th>
        <th className="px-5 py-2.5 text-right">البيان</th>
        <th className="px-5 py-2.5 text-left w-48 border-r border-border/50">الأساس الخاضع للضريبة</th>
        <th className="px-5 py-2.5 text-left w-44">مبلغ الضريبة (ر.س)</th>
      </tr>
    </thead>
  );
}

function TRow({
  num, label, base, vat, highlight, subtext,
}: {
  num: string;
  label: string;
  base: number | null;
  vat: number | null;
  highlight?: "green" | "blue" | "total";
  subtext?: string;
}) {
  const rowClass = {
    green: "bg-emerald-50/70 dark:bg-emerald-950/20 font-semibold",
    blue:  "bg-blue-50/70 dark:bg-blue-950/20 font-semibold",
    total: "bg-slate-100 dark:bg-slate-800/50 font-bold border-t-2 border-border",
  }[highlight ?? ""] ?? "hover:bg-muted/30";

  return (
    <tr className={cn("border-b border-border/40 text-sm transition-colors", rowClass)}>
      <td className="w-10 px-3 py-3 text-center text-xs text-muted-foreground font-medium">{num}</td>
      <td className="px-5 py-3">
        <span>{label}</span>
        {subtext && <span className="block text-xs text-muted-foreground mt-0.5">{subtext}</span>}
      </td>
      <td className="px-5 py-3 text-left border-r border-border/40 tabular-nums font-mono text-sm">
        {base !== null ? fmtNum(base) : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-5 py-3 text-left tabular-nums font-mono text-sm">
        {vat !== null ? fmtNum(vat) : <span className="text-muted-foreground">—</span>}
      </td>
    </tr>
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VATDeclaration() {
  const { user, token } = useAuth();
  const [selectedKey, setSelectedKey] = useState<PeriodKey>("this_month");
  const period = PERIODS.find(p => p.key === selectedKey) ?? PERIODS[0];

  const { data, isLoading, error } = useQuery<VATData>({
    queryKey: ["vat-declaration", period.from, period.to, token],
    queryFn: () => fetchVAT(period.from, period.to, token),
    enabled: !!token,
  });

  const netVat      = data?.netVat ?? 0;
  const netPositive = netVat >= 0;
  const companyName = data?.company?.nameAr ?? user?.company?.nameAr ?? "—";
  const vatNumber   = data?.company?.vatNumber;
  const crNumber    = data?.company?.crNumber;

  return (
    <div className="space-y-0 max-w-5xl mx-auto">

      {/* ── TOP TOOLBAR ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5 no-print">
        <div>
          <h1 className="text-xl font-bold">الإقرار الضريبي على القيمة المضافة</h1>
          <p className="text-xs text-muted-foreground mt-0.5">هيئة الزكاة والضريبة والجمارك — نموذج الإقرار الدوري</p>
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
            طباعة
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
          فشل في تحميل بيانات الإقرار. يرجى المحاولة مرة أخرى.
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
                  {data.company?.nameEn && (
                    <p className="text-xs text-primary-foreground/70 mt-0.5">{data.company.nameEn}</p>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-primary-foreground/90">
                {vatNumber && (
                  <div>
                    <span className="text-primary-foreground/60 text-xs">الرقم الضريبي</span>
                    <p className="font-mono font-semibold tracking-wide">{vatNumber}</p>
                  </div>
                )}
                {crNumber && (
                  <div>
                    <span className="text-primary-foreground/60 text-xs">السجل التجاري</span>
                    <p className="font-mono">{crNumber}</p>
                  </div>
                )}
                {data.company?.city && (
                  <div>
                    <span className="text-primary-foreground/60 text-xs">المدينة</span>
                    <p>{data.company.city}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── PERIOD STRIP ─────────────────────────────────────────────────── */}
          <div className="bg-muted/40 border-b border-border px-6 py-3 flex flex-wrap items-center gap-x-8 gap-y-2">
            <InfoPill icon={CalendarRange} label="الفترة الضريبية"  value={period.label} />
            <InfoPill label="من"          value={arabicDate(period.from)} />
            <InfoPill label="إلى"         value={arabicDate(period.to)} />
            <div className="mr-auto flex gap-x-5 gap-y-2 flex-wrap">
              <InfoPill icon={Hash}       label="إجمالي الفواتير"       value={`${data.invoiceBreakdown.totalCount} فاتورة`} />
              <InfoPill icon={ReceiptText} label="ضريبية"               value={`${data.invoiceBreakdown.standardTypeCount}`} />
              <InfoPill icon={ReceiptText} label="مبسطة"                value={`${data.invoiceBreakdown.simplifiedTypeCount}`} />
            </div>
          </div>

          {/* ── KPI SUMMARY CARDS ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-3 divide-x divide-x-reverse divide-border border-b border-border">
            {/* Output VAT */}
            <div className="px-6 py-4">
              <div className="flex items-center gap-2 mb-1">
                <ArrowUpFromLine className="h-4 w-4 text-emerald-600" />
                <span className="text-xs text-muted-foreground font-medium">ضريبة المخرجات</span>
              </div>
              <p className="text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                {fmtNum(data.outputTax.total.vat)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                وعاء: {fmtNum(data.outputTax.total.base)} ر.س
              </p>
            </div>

            {/* Input VAT */}
            <div className="px-6 py-4">
              <div className="flex items-center gap-2 mb-1">
                <ArrowDownToLine className="h-4 w-4 text-blue-600" />
                <span className="text-xs text-muted-foreground font-medium">ضريبة المدخلات</span>
              </div>
              <p className="text-2xl font-bold tabular-nums text-blue-700 dark:text-blue-400">
                {fmtNum(data.inputTax.total.vat)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                وعاء: {fmtNum(data.inputTax.total.base)} ر.س
              </p>
            </div>

            {/* Net VAT */}
            <div className={cn("px-6 py-4", netPositive ? "bg-red-50/60 dark:bg-red-950/20" : "bg-green-50/60 dark:bg-green-950/20")}>
              <div className="flex items-center gap-2 mb-1">
                <Scale className={cn("h-4 w-4", netPositive ? "text-red-600" : "text-green-600")} />
                <span className="text-xs text-muted-foreground font-medium">
                  {netPositive ? "صافي مستحق السداد" : "فائض مستحق الاسترداد"}
                </span>
              </div>
              <p className={cn(
                "text-2xl font-bold tabular-nums",
                netPositive ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400",
              )}>
                {fmtNum(Math.abs(netVat))}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                ر.س — صافي الضريبة
              </p>
            </div>
          </div>

          {/* ── SECTION 1: OUTPUT TAX ─────────────────────────────────────────── */}
          <SectionHeader color="green" icon={ArrowUpFromLine} title="الجزء الأول: ضريبة المخرجات — المبيعات" />

          <div className="overflow-x-auto">
            <table className="w-full">
              <TableHeader />
              <tbody>
                <TRow
                  num="1"
                  label="المبيعات الخاضعة للضريبة بالنسبة العامة"
                  subtext="النسبة: 15%"
                  base={data.outputTax.standardRated.base}
                  vat={data.outputTax.standardRated.vat}
                />
                <TRow
                  num="2"
                  label="المبيعات الخاضعة لنسبة الصفر"
                  subtext="النسبة: 0%"
                  base={data.outputTax.zeroRated.base}
                  vat={data.outputTax.zeroRated.vat}
                />
                <TRow
                  num="3"
                  label="المبيعات المعفاة من الضريبة"
                  base={data.outputTax.exempt.base}
                  vat={null}
                />
                {data.discountTotal > 0 && (
                  <TRow
                    num="4"
                    label="إجمالي الخصومات الممنوحة"
                    base={data.discountTotal}
                    vat={null}
                  />
                )}
                <TRow
                  num={data.discountTotal > 0 ? "5" : "4"}
                  label="إجمالي المبيعات"
                  base={data.outputTax.total.base}
                  vat={data.outputTax.total.vat}
                  highlight="green"
                />
              </tbody>
            </table>
          </div>

          {/* ── SECTION 2: INPUT TAX ──────────────────────────────────────────── */}
          <div className="border-t border-border">
            <SectionHeader color="blue" icon={ArrowDownToLine} title="الجزء الثاني: ضريبة المدخلات — المشتريات" />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <TableHeader />
              <tbody>
                <TRow
                  num="5"
                  label="المشتريات الخاضعة للضريبة بالنسبة العامة"
                  subtext="النسبة: 15%"
                  base={data.inputTax.standardRated.base}
                  vat={data.inputTax.standardRated.vat}
                />
                <TRow
                  num="6"
                  label="المشتريات الخاضعة لنسبة الصفر"
                  subtext="النسبة: 0%"
                  base={data.inputTax.zeroRated.base}
                  vat={data.inputTax.zeroRated.vat}
                />
                <TRow
                  num="7"
                  label="المشتريات المعفاة من الضريبة"
                  base={data.inputTax.exempt.base}
                  vat={null}
                />
                <TRow
                  num="8"
                  label="إجمالي المشتريات"
                  base={data.inputTax.total.base}
                  vat={data.inputTax.total.vat}
                  highlight="blue"
                />
              </tbody>
            </table>
          </div>

          {/* ── NOTE ──────────────────────────────────────────────────────────── */}
          <div className="flex items-start gap-2.5 px-5 py-3 bg-blue-50/80 dark:bg-blue-950/20 border-t border-blue-200/60 dark:border-blue-800/40 no-print">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-blue-600" />
            <p className="text-xs text-blue-700 dark:text-blue-400 leading-relaxed">
              <strong>مصادر الإقرار:</strong> يجمع النظام تلقائيًا ضريبة المخرجات من فواتير ومرتجعات المبيعات المُرحَّلة، وضريبة المدخلات من فواتير ومرتجعات المشتريات المُرحَّلة. لا تُحتسب المسودات أو الفواتير الملغاة.
            </p>
          </div>

          {/* ── SECTION 3: NET VAT ────────────────────────────────────────────── */}
          <div className="border-t border-border">
            <SectionHeader color="slate" icon={Scale} title="الجزء الثالث: صافي الضريبة المستحقة" />
          </div>

          <div className="px-6 py-5 border-t border-border/40">
            {/* Calculation rows */}
            <div className="rounded-xl border border-border overflow-hidden max-w-lg">
              <div className="flex items-center justify-between px-5 py-3 border-b border-border/60 bg-emerald-50/60 dark:bg-emerald-950/20">
                <span className="text-sm text-emerald-800 dark:text-emerald-300">ضريبة المخرجات (مجموع البند 1)</span>
                <span className="font-mono font-semibold tabular-nums text-emerald-800 dark:text-emerald-300">
                  {fmtSAR(data.outputTax.total.vat)}
                </span>
              </div>
              <div className="flex items-center justify-between px-5 py-3 border-b border-border/60 bg-blue-50/60 dark:bg-blue-950/20">
                <span className="text-sm text-blue-800 dark:text-blue-300">ضريبة المدخلات (مجموع البند 8)</span>
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
                  {netPositive ? "صافي الضريبة المستحقة للسداد" : "فائض الضريبة المستحق للاسترداد"}
                </span>
                <span className="font-mono font-bold text-lg tabular-nums">
                  {fmtSAR(Math.abs(netVat))}
                </span>
              </div>
            </div>

            {/* Invoice breakdown chips */}
            <div className="flex flex-wrap gap-3 mt-5">
              <Chip icon={BadgePercent} label="إجمالي المبيعات (الوعاء)" value={fmtSAR(data.outputTax.total.base)} />
              <Chip icon={FileText}     label="فواتير ضريبية (B2B)"      value={`${data.invoiceBreakdown.standardTypeCount} فاتورة`} />
              <Chip icon={FileText}     label="فواتير مبسطة (B2C)"       value={`${data.invoiceBreakdown.simplifiedTypeCount} فاتورة`} />
            </div>
          </div>

          {/* ── PRINT FOOTER ─────────────────────────────────────────────────── */}
          <div className="hidden print:block border-t border-border px-6 py-4 text-center text-xs text-muted-foreground">
            <p>هذا الإقرار مُعدّ بواسطة نظام الفاتورة الإلكترونية المتوافق مع متطلبات هيئة الزكاة والضريبة والجمارك</p>
            <p className="mt-1">تاريخ الطباعة: {new Date().toLocaleDateString("ar-SA-u-nu-latn")}</p>
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
            <p className="font-semibold text-muted-foreground">لا توجد فواتير مُصدَرة في هذه الفترة</p>
            <p className="text-sm text-muted-foreground/60 mt-1">جرّب اختيار فترة زمنية مختلفة</p>
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

// ─── VAT Declaration Export Menu ──────────────────────────────────────────────

function VATExportMenu({
  data, period,
}: {
  data: VATData;
  period: { label: string; from: string; to: string };
}) {
  const companyName = data.company?.nameAr ?? "";
  const { dp } = useFmt();

  const VAT_COLS = [
    { key: "section", header: "القسم",                      width: 14 },
    { key: "num",     header: "#",                           width: 6  },
    { key: "label",   header: "البيان",                      width: 50 },
    { key: "base",    header: "الأساس الخاضع للضريبة (ر.س)", width: 28 },
    { key: "vat",     header: "مبلغ الضريبة (ر.س)",          width: 24 },
  ];

  function fmtN(n: number) {
    return n.toFixed(dp);
  }

  function buildRows() {
    const rows: Record<string, unknown>[] = [
      // Meta rows
      { section: "معلومات الإقرار", num: "", label: "الشركة",            base: companyName,                                     vat: "" },
      { section: "معلومات الإقرار", num: "", label: "الرقم الضريبي",     base: data.company?.vatNumber ?? "",                   vat: "" },
      { section: "معلومات الإقرار", num: "", label: "الفترة الضريبية",   base: period.label,                                    vat: "" },
      { section: "معلومات الإقرار", num: "", label: "من تاريخ",          base: period.from,                                     vat: "" },
      { section: "معلومات الإقرار", num: "", label: "إلى تاريخ",         base: period.to,                                       vat: "" },
      { section: "معلومات الإقرار", num: "", label: "عدد الفواتير",      base: data.invoiceBreakdown.totalCount,                vat: "" },
      // Separator
      { section: "", num: "", label: "", base: "", vat: "" },
      // Section 1
      { section: "ضريبة المخرجات", num: "1", label: "المبيعات الخاضعة للضريبة بالنسبة العامة (15%)", base: fmtN(data.outputTax.standardRated.base), vat: fmtN(data.outputTax.standardRated.vat) },
      { section: "ضريبة المخرجات", num: "2", label: "المبيعات الخاضعة لنسبة الصفر %",               base: fmtN(data.outputTax.zeroRated.base),     vat: fmtN(data.outputTax.zeroRated.vat) },
      { section: "ضريبة المخرجات", num: "3", label: "المبيعات المعفاة من الضريبة",                  base: fmtN(data.outputTax.exempt.base),        vat: "—" },
      { section: "ضريبة المخرجات", num: "4", label: "إجمالي المبيعات",                               base: fmtN(data.outputTax.total.base),         vat: fmtN(data.outputTax.total.vat) },
      // Separator
      { section: "", num: "", label: "", base: "", vat: "" },
      // Section 2
      { section: "ضريبة المدخلات", num: "5", label: "المشتريات الخاضعة للضريبة بالنسبة العامة (15%)", base: fmtN(data.inputTax.standardRated.base), vat: fmtN(data.inputTax.standardRated.vat) },
      { section: "ضريبة المدخلات", num: "6", label: "المشتريات الخاضعة لنسبة الصفر %",                base: fmtN(data.inputTax.zeroRated.base),     vat: fmtN(data.inputTax.zeroRated.vat) },
      { section: "ضريبة المدخلات", num: "7", label: "المشتريات المعفاة من الضريبة",                   base: fmtN(data.inputTax.exempt.base),        vat: "—" },
      { section: "ضريبة المدخلات", num: "8", label: "إجمالي المشتريات",                                base: fmtN(data.inputTax.total.base),         vat: fmtN(data.inputTax.total.vat) },
      // Separator
      { section: "", num: "", label: "", base: "", vat: "" },
      // Section 3
      { section: "صافي الضريبة", num: "", label: "ضريبة المخرجات",              base: fmtN(data.outputTax.total.vat), vat: "" },
      { section: "صافي الضريبة", num: "", label: "ضريبة المدخلات (مطروحة)",     base: fmtN(data.inputTax.total.vat),  vat: "" },
      { section: "صافي الضريبة", num: "", label: "صافي الضريبة المستحقة (ر.س)", base: fmtN(data.netVat),              vat: "" },
    ];
    return rows;
  }

  function handleExcel() {
    exportToExcel(buildRows(), VAT_COLS, `اقرار-ضريبي-${period.from}-${period.to}`, "الإقرار الضريبي");
  }

  const INFO_COLS  = [{ key: "label", header: "البيان", width: 40 }, { key: "base", header: "القيمة", width: 40 }];
  const TABLE_COLS = [
    { key: "num",   header: "#",                              width: 6  },
    { key: "label", header: "البيان",                         width: 54 },
    { key: "base",  header: "الأساس الخاضع للضريبة (ر.س)",   width: 28 },
    { key: "vat",   header: "مبلغ الضريبة (ر.س)",            width: 24 },
  ];
  const NET_COLS = [{ key: "label", header: "البيان", width: 54 }, { key: "base", header: "المبلغ (ر.س)", width: 28 }];

  function handlePDF() {
    printSectionsAsPDF(
      [
        {
          title: "معلومات الإقرار",
          color: "#1e40af",
          columns: INFO_COLS,
          rows: [
            { label: "اسم الشركة",        base: companyName },
            { label: "الرقم الضريبي",      base: data.company?.vatNumber ?? "" },
            { label: "الفترة الضريبية",    base: period.label },
            { label: "من تاريخ",          base: period.from },
            { label: "إلى تاريخ",         base: period.to },
            { label: "عدد الفواتير",       base: String(data.invoiceBreakdown.totalCount) },
          ],
        },
        {
          title: "القسم الأول: ضريبة المخرجات (المبيعات)",
          color: "#15803d",
          columns: TABLE_COLS,
          rows: [
            { num: "1", label: "المبيعات الخاضعة للضريبة بالنسبة العامة (15%)", base: fmtN(data.outputTax.standardRated.base), vat: fmtN(data.outputTax.standardRated.vat) },
            { num: "2", label: "المبيعات الخاضعة لنسبة الصفر %",               base: fmtN(data.outputTax.zeroRated.base),     vat: fmtN(data.outputTax.zeroRated.vat) },
            { num: "3", label: "المبيعات المعفاة من الضريبة",                  base: fmtN(data.outputTax.exempt.base),        vat: "—" },
            { num: "4", label: "إجمالي المبيعات",                               base: fmtN(data.outputTax.total.base),         vat: fmtN(data.outputTax.total.vat) },
          ],
        },
        {
          title: "القسم الثاني: ضريبة المدخلات (المشتريات)",
          color: "#1d4ed8",
          columns: TABLE_COLS,
          rows: [
            { num: "5", label: "المشتريات الخاضعة للضريبة بالنسبة العامة (15%)", base: fmtN(data.inputTax.standardRated.base), vat: fmtN(data.inputTax.standardRated.vat) },
            { num: "6", label: "المشتريات الخاضعة لنسبة الصفر %",                base: fmtN(data.inputTax.zeroRated.base),     vat: fmtN(data.inputTax.zeroRated.vat) },
            { num: "7", label: "المشتريات المعفاة من الضريبة",                   base: fmtN(data.inputTax.exempt.base),        vat: "—" },
            { num: "8", label: "إجمالي المشتريات",                                base: fmtN(data.inputTax.total.base),         vat: fmtN(data.inputTax.total.vat) },
          ],
        },
        {
          title: "القسم الثالث: صافي الضريبة المستحقة",
          color: "#7c3aed",
          columns: NET_COLS,
          rows: [
            { label: "ضريبة المخرجات",                base: fmtN(data.outputTax.total.vat) },
            { label: "ضريبة المدخلات (القابلة للخصم)", base: fmtN(data.inputTax.total.vat) },
            { label: "صافي الضريبة المستحقة (ر.س)",    base: fmtN(data.netVat) },
          ],
        },
      ],
      "الإقرار الضريبي على القيمة المضافة",
      `${companyName} — ${period.label} (${period.from} إلى ${period.to})`,
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="gap-2 h-9">
          <Download className="h-3.5 w-3.5" />
          تصدير
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">تصدير الإقرار</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={handleExcel}>
          <FileSpreadsheet className="h-4 w-4 text-green-600" />
          Excel (.xlsx)
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={handlePDF}>
          <FileText className="h-4 w-4 text-red-500" />
          PDF (.pdf)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
