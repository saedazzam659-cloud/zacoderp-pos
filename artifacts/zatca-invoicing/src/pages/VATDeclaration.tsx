import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  FileText, Printer, CalendarRange, Building2,
  TrendingUp, TrendingDown, Minus, AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Helpers ────────────────────────────────────────────────────────────────

const API = import.meta.env.VITE_API_URL ?? "";

function fmt(n: number) {
  return n.toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtSAR(n: number) {
  return `${fmt(n)} ر.س`;
}

// ─── Period helpers ──────────────────────────────────────────────────────────

type PeriodKey =
  | "this_month" | "last_month"
  | "q1" | "q2" | "q3" | "q4"
  | "this_year";

const now = new Date();
const Y   = now.getFullYear();

const PERIODS: { label: string; key: PeriodKey; from: string; to: string }[] = [
  {
    key: "this_month", label: "الشهر الحالي",
    from: `${Y}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
    to:   lastDay(Y, now.getMonth()),
  },
  {
    key: "last_month", label: "الشهر الماضي",
    from: `${Y}-${String(now.getMonth()).padStart(2, "0")}-01`,
    to:   lastDay(Y, now.getMonth() - 1),
  },
  {
    key: "q1", label: `الربع الأول ${Y}`,
    from: `${Y}-01-01`, to: `${Y}-03-31`,
  },
  {
    key: "q2", label: `الربع الثاني ${Y}`,
    from: `${Y}-04-01`, to: `${Y}-06-30`,
  },
  {
    key: "q3", label: `الربع الثالث ${Y}`,
    from: `${Y}-07-01`, to: `${Y}-09-30`,
  },
  {
    key: "q4", label: `الربع الرابع ${Y}`,
    from: `${Y}-10-01`, to: `${Y}-12-31`,
  },
  {
    key: "this_year", label: `السنة الكاملة ${Y}`,
    from: `${Y}-01-01`, to: `${Y}-12-31`,
  },
];

function lastDay(y: number, month: number): string {
  const d = new Date(y, month + 1, 0);
  return d.toISOString().slice(0, 10);
}

function arabicDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("ar-SA-u-nu-latn", {
    year: "numeric", month: "long", day: "numeric",
  });
}

// ─── API call ────────────────────────────────────────────────────────────────

interface VATData {
  period: { from: string; to: string };
  company: {
    nameAr: string; nameEn?: string;
    vatNumber?: string; crNumber?: string; city?: string;
  } | null;
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
  invoiceBreakdown: {
    standardTypeCount: number;
    simplifiedTypeCount: number;
    totalCount: number;
  };
}

async function fetchVATDeclaration(from: string, to: string): Promise<VATData> {
  const res = await fetch(
    `${API}/api/reports/vat-declaration?from=${from}&to=${to}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error("فشل في تحميل البيانات");
  return res.json();
}

// ─── Row component ────────────────────────────────────────────────────────────

function TRow({
  num, label, base, vat, bold, bg,
}: {
  num: string; label: string; base: number | null; vat: number | null;
  bold?: boolean; bg?: string;
}) {
  return (
    <tr className={cn(
      "border-b border-border/60 text-sm",
      bold && "font-semibold",
      bg,
    )}>
      <td className="w-12 text-center text-muted-foreground border-l border-border/40 px-3 py-3">{num}</td>
      <td className="px-4 py-3 flex-1">{label}</td>
      <td className="px-4 py-3 text-center w-44 border-r border-border/40 tabular-nums">
        {base !== null ? fmtSAR(base) : "—"}
      </td>
      <td className="px-4 py-3 text-center w-44 tabular-nums">
        {vat !== null ? fmtSAR(vat) : "—"}
      </td>
    </tr>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VATDeclaration() {
  const { user } = useAuth();
  const printRef  = useRef<HTMLDivElement>(null);

  const defaultPeriod = PERIODS.find(p => p.key === "this_month")!;
  const [selectedKey, setSelectedKey] = useState<PeriodKey>("this_month");
  const period = PERIODS.find(p => p.key === selectedKey) ?? defaultPeriod;

  const { data, isLoading, error } = useQuery<VATData>({
    queryKey: ["vat-declaration", period.from, period.to],
    queryFn:  () => fetchVATDeclaration(period.from, period.to),
  });

  function handlePrint() {
    window.print();
  }

  const netPositive = (data?.netVat ?? 0) >= 0;

  return (
    <div className="space-y-6">
      {/* ── Header ─── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">الإقرار الضريبي</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            إقرار ضريبة القيمة المضافة — هيئة الزكاة والضريبة والجمارك
          </p>
        </div>

        <div className="flex flex-wrap gap-3 no-print">
          {/* Period selector */}
          <Select value={selectedKey} onValueChange={(v) => setSelectedKey(v as PeriodKey)}>
            <SelectTrigger className="w-52 gap-2">
              <CalendarRange className="h-4 w-4 text-muted-foreground" />
              <SelectValue placeholder="اختر الفترة" />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map(p => (
                <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button variant="outline" className="gap-2" onClick={handlePrint}>
            <Printer className="h-4 w-4" />
            طباعة
          </Button>
        </div>
      </div>

      {/* ── Loading / Error states ─── */}
      {isLoading && (
        <div className="flex items-center justify-center py-24">
          <div className="animate-spin rounded-full h-10 w-10 border-4 border-primary border-t-transparent" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
          <AlertCircle className="h-5 w-5 shrink-0" />
          فشل في تحميل بيانات الإقرار. يرجى المحاولة مرة أخرى.
        </div>
      )}

      {/* ── Report body ─── */}
      {data && !isLoading && (
        <div ref={printRef} className="space-y-6">

          {/* ── Company header card ─── */}
          <div className="rounded-xl border bg-card p-5 print:border-2 print:border-gray-800">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <Building2 className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <p className="text-lg font-bold">{data.company?.nameAr ?? user?.company?.nameAr ?? "—"}</p>
                  {data.company?.nameEn && (
                    <p className="text-sm text-muted-foreground">{data.company.nameEn}</p>
                  )}
                </div>
              </div>

              <div className="text-left rtl:text-right space-y-1">
                {data.company?.vatNumber && (
                  <p className="text-sm">
                    <span className="text-muted-foreground">الرقم الضريبي: </span>
                    <span className="font-mono font-semibold">{data.company.vatNumber}</span>
                  </p>
                )}
                {data.company?.crNumber && (
                  <p className="text-sm">
                    <span className="text-muted-foreground">السجل التجاري: </span>
                    <span className="font-mono">{data.company.crNumber}</span>
                  </p>
                )}
                {data.company?.city && (
                  <p className="text-sm text-muted-foreground">{data.company.city}</p>
                )}
              </div>
            </div>

            <Separator className="my-4" />

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">الفترة</p>
                <p className="font-semibold text-sm">{period.label}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">من تاريخ</p>
                <p className="font-semibold text-sm">{arabicDate(period.from)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">إلى تاريخ</p>
                <p className="font-semibold text-sm">{arabicDate(period.to)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">عدد الفواتير</p>
                <p className="font-semibold text-sm">{data.invoiceBreakdown.totalCount} فاتورة</p>
              </div>
            </div>
          </div>

          {/* ── Section 1: Output Tax ─── */}
          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 px-5 py-3 border-b border-emerald-200 dark:border-emerald-800">
              <TrendingUp className="h-4 w-4 text-emerald-600" />
              <h2 className="font-semibold text-emerald-800 dark:text-emerald-300 text-sm">
                الجزء الأول: ضريبة المخرجات (المبيعات)
              </h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted/40 text-xs text-muted-foreground border-b border-border">
                    <th className="w-12 px-3 py-2 text-center border-l border-border/40">#</th>
                    <th className="px-4 py-2 text-right">البيان</th>
                    <th className="px-4 py-2 text-center w-44 border-r border-border/40">الأساس الخاضع للضريبة</th>
                    <th className="px-4 py-2 text-center w-44">مبلغ الضريبة</th>
                  </tr>
                </thead>
                <tbody>
                  <TRow
                    num="1"
                    label="المبيعات المحلية الخاضعة للضريبة بالنسبة العامة (15%)"
                    base={data.outputTax.standardRated.base}
                    vat={data.outputTax.standardRated.vat}
                  />
                  <TRow
                    num="2"
                    label="المبيعات الخاضعة لنسبة الصفر %"
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
                      label="إجمالي الخصومات"
                      base={data.discountTotal}
                      vat={null}
                    />
                  )}
                  <TRow
                    num={data.discountTotal > 0 ? "5" : "4"}
                    label="إجمالي المبيعات"
                    base={data.outputTax.total.base}
                    vat={data.outputTax.total.vat}
                    bold
                    bg="bg-emerald-50/60 dark:bg-emerald-950/20"
                  />
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Section 2: Input Tax ─── */}
          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="flex items-center gap-2 bg-blue-50 dark:bg-blue-950/30 px-5 py-3 border-b border-blue-200 dark:border-blue-800">
              <TrendingDown className="h-4 w-4 text-blue-600" />
              <h2 className="font-semibold text-blue-800 dark:text-blue-300 text-sm">
                الجزء الثاني: ضريبة المدخلات (المشتريات)
              </h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted/40 text-xs text-muted-foreground border-b border-border">
                    <th className="w-12 px-3 py-2 text-center border-l border-border/40">#</th>
                    <th className="px-4 py-2 text-right">البيان</th>
                    <th className="px-4 py-2 text-center w-44 border-r border-border/40">الأساس الخاضع للضريبة</th>
                    <th className="px-4 py-2 text-center w-44">مبلغ الضريبة</th>
                  </tr>
                </thead>
                <tbody>
                  <TRow
                    num="5"
                    label="المشتريات المحلية الخاضعة للضريبة بالنسبة العامة (15%)"
                    base={data.inputTax.standardRated.base}
                    vat={data.inputTax.standardRated.vat}
                  />
                  <TRow
                    num="6"
                    label="المشتريات الخاضعة لنسبة الصفر %"
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
                    bold
                    bg="bg-blue-50/60 dark:bg-blue-950/20"
                  />
                </tbody>
              </table>
            </div>

            {/* Note about purchase tracking */}
            <div className="flex items-start gap-2 px-5 py-3 bg-amber-50/60 dark:bg-amber-950/20 border-t border-amber-200/60 text-xs text-amber-700 dark:text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              ملاحظة: لا يتتبع النظام حاليًا فواتير المشتريات. يرجى إدخال قيم ضريبة المدخلات يدويًا عند تقديم الإقرار الرسمي.
            </div>
          </div>

          {/* ── Section 3: Net VAT Summary ─── */}
          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-3 border-b border-border bg-muted/30">
              <Minus className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-semibold text-sm">الجزء الثالث: صافي الضريبة المستحقة</h2>
            </div>

            <div className="p-5 space-y-4">
              {/* Summary grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* Output VAT */}
                <div className="rounded-lg border bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 p-4">
                  <p className="text-xs text-emerald-700 dark:text-emerald-400 mb-1">ضريبة المخرجات</p>
                  <p className="text-xl font-bold text-emerald-800 dark:text-emerald-200 tabular-nums">
                    {fmtSAR(data.outputTax.total.vat)}
                  </p>
                  <p className="text-xs text-emerald-600 dark:text-emerald-500 mt-1">
                    على {data.outputTax.total.count} فاتورة
                  </p>
                </div>

                {/* Input VAT */}
                <div className="rounded-lg border bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 p-4">
                  <p className="text-xs text-blue-700 dark:text-blue-400 mb-1">ضريبة المدخلات</p>
                  <p className="text-xl font-bold text-blue-800 dark:text-blue-200 tabular-nums">
                    {fmtSAR(data.inputTax.total.vat)}
                  </p>
                  <p className="text-xs text-blue-600 dark:text-blue-500 mt-1">
                    غير متوفرة في النظام
                  </p>
                </div>

                {/* Net VAT */}
                <div className={cn(
                  "rounded-lg border p-4",
                  netPositive
                    ? "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800"
                    : "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800",
                )}>
                  <p className={cn(
                    "text-xs mb-1",
                    netPositive ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400",
                  )}>
                    {netPositive ? "صافي الضريبة المستحقة السداد" : "فائض ضريبة لاسترداد"}
                  </p>
                  <p className={cn(
                    "text-xl font-bold tabular-nums",
                    netPositive ? "text-red-800 dark:text-red-200" : "text-green-800 dark:text-green-200",
                  )}>
                    {fmtSAR(Math.abs(data.netVat))}
                  </p>
                  <Badge
                    variant="outline"
                    className={cn(
                      "mt-2 text-xs",
                      netPositive
                        ? "border-red-300 text-red-700"
                        : "border-green-300 text-green-700",
                    )}
                  >
                    {netPositive ? "مبلغ مستحق على الشركة" : "مبلغ مستحق للشركة"}
                  </Badge>
                </div>
              </div>

              {/* Calculation formula display */}
              <div className="rounded-lg bg-muted/40 p-4 text-sm">
                <p className="text-muted-foreground text-xs mb-2 font-medium">طريقة الحساب:</p>
                <div className="flex flex-wrap items-center gap-2 tabular-nums">
                  <span className="font-mono bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 px-2 py-0.5 rounded">
                    {fmtSAR(data.outputTax.total.vat)}
                  </span>
                  <span className="text-muted-foreground">−</span>
                  <span className="font-mono bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 px-2 py-0.5 rounded">
                    {fmtSAR(data.inputTax.total.vat)}
                  </span>
                  <span className="text-muted-foreground">=</span>
                  <span className={cn(
                    "font-mono font-bold px-2 py-0.5 rounded",
                    netPositive
                      ? "bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300"
                      : "bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300",
                  )}>
                    {fmtSAR(data.netVat)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* ── Invoice type breakdown ─── */}
          <div className="rounded-xl border bg-card p-5">
            <div className="flex items-center gap-2 mb-4">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-semibold text-sm">تفاصيل الفواتير</h2>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <StatBox label="إجمالي الفواتير"    value={data.invoiceBreakdown.totalCount}              unit="فاتورة" />
              <StatBox label="فواتير ضريبية (B2B)" value={data.invoiceBreakdown.standardTypeCount}   unit="فاتورة" />
              <StatBox label="فواتير مبسطة (B2C)"  value={data.invoiceBreakdown.simplifiedTypeCount} unit="فاتورة" />
              <StatBox label="إجمالي المبيعات"     value={data.outputTax.total.base}                 isCurrency />
            </div>
          </div>

          {/* ── Print footer ─── */}
          <div className="hidden print:block text-center text-xs text-muted-foreground pt-4 border-t">
            <p>هذا الإقرار مُعدّ بواسطة نظام الفاتورة الإلكترونية المتوافق مع متطلبات هيئة الزكاة والضريبة والجمارك</p>
            <p className="mt-1">تاريخ الطباعة: {new Date().toLocaleDateString("ar-SA-u-nu-latn")}</p>
          </div>
        </div>
      )}

      {/* ── No data state ─── */}
      {data && data.outputTax.total.count === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <FileText className="h-12 w-12 text-muted-foreground/40" />
          <p className="text-muted-foreground font-medium">لا توجد فواتير مُصدَرة في هذه الفترة</p>
          <p className="text-sm text-muted-foreground/70">يرجى اختيار فترة زمنية أخرى</p>
        </div>
      )}

      {/* ── Print styles ─── */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          .rounded-xl, .rounded-lg { border-radius: 0 !important; }
        }
      `}</style>
    </div>
  );
}

function StatBox({
  label, value, unit, isCurrency,
}: {
  label: string; value: number; unit?: string; isCurrency?: boolean;
}) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-lg font-bold tabular-nums">
        {isCurrency ? fmtSAR(value) : value.toLocaleString("ar-SA")}
      </p>
      {unit && !isCurrency && (
        <p className="text-xs text-muted-foreground">{unit}</p>
      )}
    </div>
  );
}
