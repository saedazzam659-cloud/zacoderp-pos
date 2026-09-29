import { useMemo, type ReactNode } from "react";
import { Table2 } from "lucide-react";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";
import ExportButtons from "@/components/ExportButtons";
import { cn } from "@/lib/utils";
import { useFormatters } from "@/lib/format";
import { useFmt } from "@/hooks/use-fmt";
import type { ExportColumn } from "@/lib/export";

type ReportRow = Record<string, unknown>;

type Props = {
  domain: "sales" | "purchases";
  reportId: string;
  reportTitle: string;
  companyId?: number;
  fromDate?: string;
  toDate?: string;
  rows: ReportRow[];
  labels: Record<string, string>;
};

const moneyFields = new Set([
  "value", "total", "totalAmount", "totalValue", "invoiceValue", "invoiceTotal",
  "net", "gross", "sales", "returns", "discounts", "headerDiscount",
  "lineDiscount", "lineDiscountAmount", "vat", "headerVat", "lineGross", "lineNet",
  "netInvoiceTotal", "postedReturnTotal", "postedReturnLineValue",
  "lastInvoiceValue", "lastValue", "historicalValue", "unitPrice", "finalCost",
  "averagePrice", "minPrice", "maxPrice", "lastPrice", "lineValue", "lineTotal",
  "grossValue", "netValue", "headerTotal", "discountAmount",
]);

const additiveMoneyFields = new Set([
  "value", "total", "totalAmount", "totalValue", "invoiceValue", "invoiceTotal",
  "net", "gross", "sales", "returns", "discounts", "headerDiscount",
  "lineDiscount", "lineDiscountAmount", "vat", "headerVat", "lineGross", "lineNet",
  "netInvoiceTotal", "postedReturnTotal", "postedReturnLineValue", "grossValue",
  "netValue", "headerTotal", "discountAmount",
]);

const countFields = new Set(["invoiceCount", "operations", "recordCount"]);
const quantityFields = new Set([
  "quantity", "qty", "freeQty", "grossQuantity", "netQuantity",
  "openingStock", "closingStock", "movement",
]);
const percentageFields = new Set(["discount", "lineDiscountPercent", "vatRate"]);
const idFields = new Set([
  "id", "invoiceId", "returnId", "customerId", "supplierId", "itemId",
  "itemGroupId", "branchId", "warehouseId", "salesRepId",
  "originalInvoiceId", "createdById",
]);
const dateFields = new Set([
  "date", "invoiceDate", "returnDate", "lastDate", "lastInvoiceDate",
]);
const translatedValues: Record<string, string> = {
  draft: "مسودة",
  posted: "مرحّل",
  cancelled: "ملغي",
  canceled: "ملغي",
  voided: "ملغي",
  paid: "مدفوع",
  unpaid: "غير مدفوع",
  partially_paid: "مدفوع جزئياً",
  cash: "نقدي",
  credit: "آجل",
  bank: "بنكي",
  bank_transfer: "تحويل بنكي",
  card: "بطاقة",
};

function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNumericField(key: string, rows: ReportRow[]): boolean {
  return moneyFields.has(key)
    || countFields.has(key)
    || quantityFields.has(key)
    || percentageFields.has(key)
    || idFields.has(key)
    || rows.some(row => typeof row[key] === "number");
}

function labelFor(key: string, labels: Record<string, string>): string {
  return labels[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, value => value.toUpperCase());
}

function printableValue(value: unknown): string {
  if (value == null || value === "") return "";
  const text = String(value);
  return translatedValues[text] ?? text;
}

export default function AdditionalOperationalReportGrid({
  domain, reportId, reportTitle, companyId, fromDate, toDate, rows, labels,
}: Props) {
  const { fmt, fmtDate, fmtInt } = useFormatters();
  const { dp } = useFmt();
  const columns = useMemo(
    () => [...new Set(rows.flatMap(row => Object.keys(row).filter(key => !key.startsWith("_"))))]
      .filter(key => rows.some(row => row[key] !== undefined)),
    [rows],
  );
  const numericKeys = useMemo(
    () => new Set(columns.filter(key => isNumericField(key, rows))),
    [columns, rows],
  );
  const currencyCode = rows[0]?.currencyCode;
  const oneKnownCurrency = typeof currencyCode === "string"
    && currencyCode.trim() !== ""
    && currencyCode !== "غير محددة"
    && rows.every(row => row.currencyCode === currencyCode);
  const moneyFormat = dp > 0 ? `#,##0.${"0".repeat(dp)}` : "#,##0";

  const totals = useMemo(() => {
    const keys = columns.filter(key =>
      countFields.has(key)
      || (oneKnownCurrency && moneyFields.has(key) && additiveMoneyFields.has(key)),
    );
    const values = Object.fromEntries(keys.map(key => [
      key,
      rows.reduce((sum, row) => sum + (numericValue(row[key]) ?? 0), 0),
    ]));
    return { keys, values };
  }, [columns, oneKnownCurrency, rows]);

  const gridColumns = useMemo<GridColumn<ReportRow>[]>(() => columns.map(key => {
    const numeric = numericKeys.has(key);
    const isMoney = moneyFields.has(key);
    const isCount = countFields.has(key);
    const canTotal = countFields.has(key)
      || (oneKnownCurrency && moneyFields.has(key) && additiveMoneyFields.has(key));
    return {
      key,
      label: labelFor(key, labels),
      type: numeric ? "num" : "text",
      align: numeric ? "end" : "start",
      width: isMoney ? 150 : dateFields.has(key) ? 130 : 160,
      totalable: canTotal,
      value: row => numeric ? numericValue(row[key]) : (row[key] == null ? "" : String(row[key])),
      render: row => {
        const value = row[key];
        if (value == null || value === "") return <span className="text-slate-400">—</span>;
        if (dateFields.has(key)) {
          return <span className="whitespace-nowrap font-mono tabular-nums" dir="ltr">{fmtDate(value)}</span>;
        }
        if (numeric) {
          const parsed = numericValue(value);
          if (parsed == null) return <span>{String(value)}</span>;
          const rendered = isCount
            ? fmtInt(parsed)
            : fmt(parsed, {
                minimumFractionDigits: isMoney ? dp : 0,
                maximumFractionDigits: isMoney ? dp : quantityFields.has(key) || percentageFields.has(key) ? 3 : 0,
              });
          return (
            <span className={cn("whitespace-nowrap font-mono tabular-nums", isMoney && parsed < 0 && "text-rose-700")} dir="ltr">
              {rendered}
            </span>
          );
        }
        const text = printableValue(value);
        return <span className="block max-w-[22rem] truncate" title={text}>{text}</span>;
      },
    };
  }), [columns, dp, fmt, fmtDate, fmtInt, labels, numericKeys, oneKnownCurrency]);

  const exportColumns: ExportColumn[] = columns.map(key => ({
    key,
    header: labelFor(key, labels),
    width: moneyFields.has(key) ? 18 : dateFields.has(key) ? 14 : key.toLowerCase().includes("note") ? 32 : 22,
    ...(moneyFields.has(key) ? { numFmt: moneyFormat } : {}),
    ...(countFields.has(key) ? { numFmt: "#,##0" } : {}),
    ...(quantityFields.has(key) ? { numFmt: "#,##0.###" } : {}),
  }));
  const exportRows = rows.map(row => Object.fromEntries(columns.map(key => {
    const value = row[key];
    if (numericKeys.has(key)) return [key, value == null || value === "" ? "" : numericValue(value) ?? printableValue(value)];
    return [key, dateFields.has(key) && value ? fmtDate(value) : printableValue(value)];
  })));
  const gridTotalsRow: (Partial<Record<string, ReactNode>> & { __label?: ReactNode }) | null = totals.keys.length
    ? {
        __label: <span>الإجمالي</span>,
        ...Object.fromEntries(totals.keys.map(key => {
          const value = totals.values[key] ?? 0;
          const rendered = countFields.has(key)
            ? fmtInt(value)
            : fmt(value, { minimumFractionDigits: dp, maximumFractionDigits: dp });
          return [key, <span className="font-mono font-bold tabular-nums" dir="ltr">{rendered}</span>];
        })),
      }
    : null;
  const exportTotalsRow: Record<string, unknown> | null = totals.keys.length && columns.length
    ? { [columns[0]]: "الإجمالي", ...totals.values }
    : null;
  const subtitle = `الفترة: ${fromDate ? fmtDate(fromDate) : "—"} إلى ${toDate ? fmtDate(toDate) : "—"}`;
  const filename = `${domain}-${reportId}-${fromDate || "all"}-${toDate || "all"}`;

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_14px_35px_-28px_rgba(15,23,42,0.65)]" data-testid="additional-operational-report-results">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <Table2 className="h-4 w-4 text-teal-700" />
          <span className="text-sm font-bold text-slate-800">نتائج التقرير</span>
        </div>
        <span className="font-mono text-xs text-slate-500">{fmtInt(rows.length)} سجل</span>
      </div>
      <AdvancedReportGrid
        slug={`additionalOperationalReports-${domain}-${reportId}`}
        cid={companyId}
        columns={gridColumns}
        rowKey={(_row, index) => `${domain}-${reportId}-${index}`}
        rows={rows}
        totalsRow={gridTotalsRow}
        unitLabel="سجل"
        emptyMessage="لا توجد بيانات ضمن النطاق المحدد"
        toolbarExtras={
          <ExportButtons
            rows={exportRows}
            columns={exportColumns}
            filename={filename}
            title={reportTitle}
            subtitle={subtitle}
            totalsRow={exportTotalsRow}
            pdfFitOneLine={columns.length >= 9}
            showPrintButton
            disabled={rows.length === 0}
          />
        }
      />
    </div>
  );
}