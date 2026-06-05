import { Fragment, useState } from "react";
import { reportSalesInvoices, reportSalesInvoiceLines, type SalesInvoiceReportRow, type SalesLineReportRow } from "../lib/salesReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";

function payLabel(m: string): string {
  return m === "cash" ? "نقدي" : m === "bank" ? "بنك / شبكة" : "آجل";
}

type ItemBucket = { itemId: number; code: string | null; name: string; qty: number; total: number };

export default function DailyDetailedSalesReport() {
  const { branches } = useDimensions();
  const [fromDate, setFromDate] = useState(todayStr());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [invoices, setInvoices] = useState<SalesInvoiceReportRow[] | null>(null);
  const [linesByInvoice, setLinesByInvoice] = useState<Map<number, SalesLineReportRow[]>>(new Map());
  const [items, setItems] = useState<ItemBucket[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr("تاريخ البداية يجب أن يكون قبل تاريخ النهاية"); return; }
    setErr(null); setLoading(true);
    try {
      const branch = branchId === "" ? null : branchId;
      const [invs, lines] = await Promise.all([
        reportSalesInvoices({ fromDate, toDate, branchId: branch }),
        reportSalesInvoiceLines({ fromDate, toDate, branchId: branch }),
      ]);
      const byInv = new Map<number, SalesLineReportRow[]>();
      const itemMap = new Map<number, ItemBucket>();
      for (const l of lines) {
        const arr = byInv.get(l.invoiceId) ?? [];
        arr.push(l); byInv.set(l.invoiceId, arr);
        const b = itemMap.get(l.itemId) ?? { itemId: l.itemId, code: l.itemCode, name: l.itemName, qty: 0, total: 0 };
        b.qty += l.qty; b.total += l.lineTotal; itemMap.set(l.itemId, b);
      }
      setLinesByInvoice(byInv);
      setItems([...itemMap.values()].sort((a, b) => b.total - a.total));
      setInvoices(invs);
    } finally { setLoading(false); }
  }

  const totals = (invoices ?? []).reduce(
    (s, r) => { s.sub += r.subtotal; s.vat += r.vatTotal; s.tot += r.grandTotal; return s; },
    { sub: 0, vat: 0, tot: 0 },
  );

  return (
    <Page title="تقرير المبيعات اليومي التفصيلي" subtitle="قائمة الفواتير مع بنودها، وملخّص إجمالي لكل صنف خلال الفترة.">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <DateField label="من تاريخ" value={fromDate} onChange={setFromDate} />
          <DateField label="إلى تاريخ" value={toDate} onChange={setToDate} />
          <BranchField branches={branches} value={branchId} onChange={setBranchId} />
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : "عرض"}</button>
        </div>
        {err && <div style={{ marginTop: 8, color: "#991b1b", fontSize: 13 }}>⚠️ {err}</div>}
      </Card>

      {invoices && (
        <>
          <Card style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8, fontWeight: 700 }}>الفواتير وبنودها ({invoices.length} فاتورة)</div>
            <Table>
              <thead>
                <tr>
                  <Th style={{ width: 120 }}>رقم الفاتورة</Th>
                  <Th style={{ width: 110 }}>التاريخ</Th>
                  <Th>العميل</Th>
                  <Th style={{ width: 90 }}>الدفع</Th>
                  <Th style={{ textAlign: "left", width: 110 }}>الصافي</Th>
                  <Th style={{ textAlign: "left", width: 100 }}>الضريبة</Th>
                  <Th style={{ textAlign: "left", width: 120 }}>الإجمالي</Th>
                </tr>
              </thead>
              <tbody>
                {invoices.length === 0 && (
                  <tr><Td colSpan={7}><Empty text="لا توجد فواتير في الفترة المحددة" /></Td></tr>
                )}
                {invoices.map((inv) => {
                  const lines = linesByInvoice.get(inv.id) ?? [];
                  return (
                    <Fragment key={`inv-${inv.id}`}>
                      <tr style={{ background: "#f8fafc", fontWeight: 600 }}>
                        <Td mono>{inv.invoiceNo}</Td>
                        <Td mono>{inv.invoiceDate}</Td>
                        <Td>{inv.customerName || "عميل نقدي"}</Td>
                        <Td>{payLabel(inv.paymentMethod)}</Td>
                        <Td num>{fmt(inv.subtotal)}</Td>
                        <Td num>{fmt(inv.vatTotal)}</Td>
                        <Td num>{fmt(inv.grandTotal)}</Td>
                      </tr>
                      {lines.map((l, i) => (
                        <tr key={`inv-${inv.id}-line-${i}`}>
                          <Td />
                          <Td colSpan={2} style={{ color: "#475569" }}>
                            {l.itemCode ? `[${l.itemCode}] ` : ""}{l.itemName}
                          </Td>
                          <Td style={{ color: "#475569" }}>{fmt(l.qty)} × {fmt(l.unitPrice)}</Td>
                          <Td num style={{ color: "#475569" }}>{fmt(l.lineTotal)}</Td>
                          <Td style={{ color: "#94a3b8", textAlign: "left" }}>{l.vatRate}%</Td>
                          <Td />
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
                {invoices.length > 0 && (
                  <tr style={{ fontWeight: 700, background: "#eef2ff" }}>
                    <Td colSpan={4}>الإجمالي العام</Td>
                    <Td num>{fmt(totals.sub)}</Td>
                    <Td num>{fmt(totals.vat)}</Td>
                    <Td num>{fmt(totals.tot)}</Td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Card>

          <Card>
            <div style={{ marginBottom: 8, fontWeight: 700 }}>ملخّص الأصناف ({items.length} صنف)</div>
            <Table>
              <thead>
                <tr>
                  <Th style={{ width: 120 }}>كود الصنف</Th>
                  <Th>اسم الصنف</Th>
                  <Th style={{ textAlign: "left", width: 120 }}>الكمية</Th>
                  <Th style={{ textAlign: "left", width: 150 }}>إجمالي المبيعات</Th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr><Td colSpan={4}><Empty text="لا توجد بنود في الفترة المحددة" /></Td></tr>
                )}
                {items.map((r) => (
                  <tr key={r.itemId}>
                    <Td mono>{r.code || "—"}</Td>
                    <Td>{r.name}</Td>
                    <Td num>{fmt(r.qty)}</Td>
                    <Td num>{fmt(r.total)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </Page>
  );
}
