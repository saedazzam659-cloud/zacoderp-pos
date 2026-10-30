import { useState } from "react";
import { reportSalesInvoices, type SalesInvoiceReportRow } from "../lib/salesReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, ExportButtons } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";
import type { ExportColumn } from "../lib/exporters";
import { uiText, useUiLanguage } from "../lib/appSettings";

function payLabel(m: string, language: "ar" | "en"): string {
  return m === "cash" ? uiText("نقدي", "Cash", language) : m === "bank" ? uiText("بنك / شبكة", "Bank / card", language) : uiText("آجل", "Credit", language);
}

// Flat row mirroring the on-screen invoices table (per-invoice rows + totals row).
type SalesExportRow = {
  invoiceNo: string;
  invoiceDate: string;
  customer: string;
  payment: string;
  lineCount: number | "";
  subtotal: number;
  vat: number;
  total: number;
};

export default function DailySalesReport() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const { branches } = useDimensions();
  const [fromDate, setFromDate] = useState(todayStr());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [rows, setRows] = useState<SalesInvoiceReportRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr(text("تاريخ البداية يجب أن يكون قبل تاريخ النهاية", "Start date must be on or before end date.")); return; }
    setErr(null); setLoading(true);
    try {
      setRows(await reportSalesInvoices({ fromDate, toDate, branchId: branchId === "" ? null : branchId }));
    } finally { setLoading(false); }
  }

  const totals = (rows ?? []).reduce(
    (s, r) => { s.sub += r.subtotal; s.vat += r.vatTotal; s.tot += r.grandTotal; return s; },
    { sub: 0, vat: 0, tot: 0 },
  );

  // Export rows mirror the on-screen table: per-invoice rows + totals row.
  const exportRows: SalesExportRow[] = (rows ?? []).map((r) => ({
    invoiceNo: r.invoiceNo,
    invoiceDate: r.invoiceDate,
    customer: r.customerName || text("عميل نقدي", "Cash customer"),
    payment: payLabel(r.paymentMethod, language),
    lineCount: r.lineCount,
    subtotal: r.subtotal,
    vat: r.vatTotal,
    total: r.grandTotal,
  }));
  if (rows && rows.length > 0) {
    exportRows.push({
      invoiceNo: `${text("الإجمالي", "Total")} (${rows.length} ${text("فاتورة", "invoices")})`,
      invoiceDate: "", customer: "", payment: "", lineCount: "",
      subtotal: totals.sub, vat: totals.vat, total: totals.tot,
    });
  }
  const exportCols: ExportColumn<SalesExportRow>[] = [
    { header: text("رقم الفاتورة", "Invoice number"), cell: (r) => r.invoiceNo },
    { header: text("التاريخ", "Date"), cell: (r) => r.invoiceDate },
    { header: text("العميل", "Customer"), cell: (r) => r.customer },
    { header: text("الدفع", "Payment"), cell: (r) => r.payment },
    { header: text("البنود", "Lines"), cell: (r) => r.lineCount },
    { header: text("الصافي", "Net"), cell: (r) => r.subtotal },
    { header: text("الضريبة", "Tax"), cell: (r) => r.vat },
    { header: text("الإجمالي", "Total"), cell: (r) => r.total },
  ];

  return (
    <Page title={text("تقرير المبيعات اليومي", "Daily sales report")} subtitle={text("قائمة فواتير المبيعات (الخلفية) خلال الفترة المحددة مع الإجماليات.", "Sales invoices for the selected period, including totals.")}>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <DateField label={text("من تاريخ", "From date")} value={fromDate} onChange={setFromDate} />
          <DateField label={text("إلى تاريخ", "To date")} value={toDate} onChange={setToDate} />
          <BranchField branches={branches} value={branchId} onChange={setBranchId} />
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : text("عرض", "Run report")}</button>
        </div>
        {err && <div style={{ marginTop: 8, color: "#991b1b", fontSize: 13 }}>⚠️ {err}</div>}
      </Card>

      {rows && (
        <Card>
          {exportRows.length > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 8 }}>
              <ExportButtons
                columns={exportCols}
                rows={exportRows}
                filenameBase={text("تقرير-المبيعات-اليومي", "daily-sales-report")}
                title={`${text("تقرير المبيعات اليومي", "Daily sales report")} — ${fromDate} ← ${toDate}`}
              />
            </div>
          )}
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 120 }}>{text("رقم الفاتورة", "Invoice number")}</Th>
                <Th style={{ width: 110 }}>{text("التاريخ", "Date")}</Th>
                <Th>{text("العميل", "Customer")}</Th>
                <Th style={{ width: 90 }}>{text("الدفع", "Payment")}</Th>
                <Th style={{ width: 70, textAlign: "center" }}>{text("البنود", "Lines")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 120 }}>{text("الصافي", "Net")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 110 }}>{text("الضريبة", "Tax")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 130 }}>{text("الإجمالي", "Total")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><Td colSpan={8}><Empty text={text("لا توجد فواتير في الفترة المحددة", "No invoices for this period")} /></Td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td mono>{r.invoiceNo}</Td>
                  <Td mono>{r.invoiceDate}</Td>
                  <Td>{r.customerName || text("عميل نقدي", "Cash customer")}</Td>
                  <Td>{payLabel(r.paymentMethod, language)}</Td>
                  <Td style={{ textAlign: "center" }}>{r.lineCount}</Td>
                  <Td num>{fmt(r.subtotal)}</Td>
                  <Td num>{fmt(r.vatTotal)}</Td>
                  <Td num>{fmt(r.grandTotal)}</Td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td colSpan={5}>{text("الإجمالي", "Total")} ({rows.length} {text("فاتورة", "invoices")})</Td>
                  <Td num>{fmt(totals.sub)}</Td>
                  <Td num>{fmt(totals.vat)}</Td>
                  <Td num>{fmt(totals.tot)}</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
