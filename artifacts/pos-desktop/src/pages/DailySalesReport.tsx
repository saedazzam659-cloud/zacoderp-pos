import { useState } from "react";
import { reportSalesInvoices, type SalesInvoiceReportRow } from "../lib/salesReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";

function payLabel(m: string): string {
  return m === "cash" ? "نقدي" : m === "bank" ? "بنك / شبكة" : "آجل";
}

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
