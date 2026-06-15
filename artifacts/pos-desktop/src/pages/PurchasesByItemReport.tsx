import { useState } from "react";
import { reportPurchaseInvoiceLines } from "../lib/purchaseReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

type Bucket = {
  itemId: number; code: string | null; name: string;
  qty: number; total: number; invoices: Set<number>;
};

export default function PurchasesByItemReport() {
  const { branches } = useDimensions();
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [rows, setRows] = useState<Bucket[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr("تاريخ البداية يجب أن يكون قبل تاريخ النهاية"); return; }
    setErr(null); setLoading(true);
    try {
      const lines = await reportPurchaseInvoiceLines({ fromDate, toDate, branchId: branchId === "" ? null : branchId });
      const map = new Map<number, Bucket>();
      for (const l of lines) {
        const b = map.get(l.itemId) ?? { itemId: l.itemId, code: l.itemCode, name: l.itemName, qty: 0, total: 0, invoices: new Set<number>() };
        b.qty += l.qty; b.total += l.lineTotal; b.invoices.add(l.purchaseId);
        map.set(l.itemId, b);
      }
      setRows([...map.values()].sort((a, b) => b.total - a.total));
    } finally { setLoading(false); }
  }

  const grandTotal = (rows ?? []).reduce((s, r) => s + r.total, 0);
  const totalQty = (rows ?? []).reduce((s, r) => s + r.qty, 0);

  return (
    <Page title="المشتريات حسب الصنف" subtitle="إجمالي مشتريات كل صنف خلال الفترة مرتبة تنازلياً مع نسبة المساهمة.">
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
                <Th style={{ width: 120 }}>كود الصنف</Th>
                <Th>اسم الصنف</Th>
                <Th style={{ textAlign: "left", width: 110 }}>الكمية</Th>
                <Th style={{ textAlign: "center", width: 90 }}>الفواتير</Th>
                <Th style={{ textAlign: "left", width: 150 }}>إجمالي المشتريات</Th>
                <Th style={{ textAlign: "left", width: 100 }}>المساهمة</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><Td colSpan={6}><Empty text="لا توجد مشتريات في الفترة المحددة" /></Td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.itemId}>
                  <Td mono>{r.code || "—"}</Td>
                  <Td>{r.name}</Td>
                  <Td num>{fmt(r.qty)}</Td>
                  <Td style={{ textAlign: "center" }}>{r.invoices.size}</Td>
                  <Td num>{fmt(r.total)}</Td>
                  <Td num>{grandTotal > 0 ? `${((r.total / grandTotal) * 100).toFixed(1)}%` : "—"}</Td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td colSpan={2}>الإجمالي ({rows.length} صنف)</Td>
                  <Td num>{fmt(totalQty)}</Td>
                  <Td />
                  <Td num>{fmt(grandTotal)}</Td>
                  <Td num>100%</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
