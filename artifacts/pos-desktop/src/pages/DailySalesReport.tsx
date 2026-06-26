import { useState } from "react";
import { reportSalesInvoices, type SalesInvoiceReportRow } from "../lib/salesReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, ExportButtons } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";
import type { ExportColumn } from "../lib/exporters";

function payLabel(m: string): string {
  return m === "cash" ? "نقدي" : m === "bank" ? "بنك / شبكة" : "آجل";
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
  const { branches } = useDimensions();
  const [fromDate, setFromDate] = useState(todayStr());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [rows, setRows] = useState<SalesInvoiceReportRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr("تاريخ البداية يجب أن يكون قبل تاريخ النهاية"); return; }
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
    customer: r.customerName || "عميل نقدي",
    payment: payLabel(r.paymentMethod),
    lineCount: r.lineCount,
    subtotal: r.subtotal,
    vat: r.vatTotal,
    total: r.grandTotal,
  }));
  if (rows && rows.length > 0) {
    exportRows.push({
      invoiceNo: `الإجمالي (${rows.length} فاتورة)`,
      invoiceDate: "", customer: "", payment: "", lineCount: "",
      subtotal: totals.sub, vat: totals.vat, total: totals.tot,
    });
  }
  const exportCols: ExportColumn<SalesExportRow>[] = [
    { header: "رقم الفاتورة", cell: (r) => r.invoiceNo },
    { header: "التاريخ", cell: (r) => r.invoiceDate },
    { header: "العميل", cell: (r) => r.customer },
    { header: "الدفع", cell: (r) => r.payment },
    { header: "البنود", cell: (r) => r.lineCount },
    { header: "الصافي", cell: (r) => r.subtotal },
    { header: "الضريبة", cell: (r) => r.vat },
    { header: "الإجمالي", cell: (r) => r.total },
  ];

  return (
    <Page title="تقرير المبيعات اليومي" subtitle="قائمة فواتير المبيعات (الخلفية) خلال الفترة المحددة مع الإجماليات.">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <DateField label="من تاريخ" value={fromDate} onChange={setFromDate} />
          <DateField label="إلى تاريخ" value={toDate} onChange={setToDate} />
          <BranchField branches={branches} value={branchId} onChange={setBranchId} />
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : "عرض"}</button>
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
                filenameBase="تقرير-المبيعات-اليومي"
                title={`تقرير المبيعات اليومي — ${fromDate} ← ${toDate}`}
              />
            </div>
          )}
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 120 }}>رقم الفاتورة</Th>
                <Th style={{ width: 110 }}>التاريخ</Th>
                <Th>العميل</Th>
                <Th style={{ width: 90 }}>الدفع</Th>
                <Th style={{ width: 70, textAlign: "center" }}>البنود</Th>
                <Th style={{ textAlign: "left", width: 120 }}>الصافي</Th>
                <Th style={{ textAlign: "left", width: 110 }}>الضريبة</Th>
                <Th style={{ textAlign: "left", width: 130 }}>الإجمالي</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><Td colSpan={8}><Empty text="لا توجد فواتير في الفترة المحددة" /></Td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td mono>{r.invoiceNo}</Td>
                  <Td mono>{r.invoiceDate}</Td>
                  <Td>{r.customerName || "عميل نقدي"}</Td>
                  <Td>{payLabel(r.paymentMethod)}</Td>
                  <Td style={{ textAlign: "center" }}>{r.lineCount}</Td>
                  <Td num>{fmt(r.subtotal)}</Td>
                  <Td num>{fmt(r.vatTotal)}</Td>
                  <Td num>{fmt(r.grandTotal)}</Td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td colSpan={5}>الإجمالي ({rows.length} فاتورة)</Td>
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
