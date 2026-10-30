import { useState } from "react";
import { reportPurchaseInvoiceLines } from "../lib/purchaseReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";
import { uiText, useUiLanguage } from "../lib/appSettings";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

type Bucket = {
  itemId: number; code: string | null; name: string;
  qty: number; total: number; invoices: Set<number>;
};

export default function PurchasesByItemReport() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const { branches } = useDimensions();
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [rows, setRows] = useState<Bucket[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr(text("تاريخ البداية يجب أن يكون قبل تاريخ النهاية", "Start date must be on or before end date.")); return; }
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
    <Page title={text("المشتريات حسب الصنف", "Purchases by item")} subtitle={text("إجمالي مشتريات كل صنف خلال الفترة مرتبة تنازلياً مع نسبة المساهمة.", "Total purchases per item for the period, sorted by contribution.")}>
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
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 120 }}>{text("كود الصنف", "Item code")}</Th>
                <Th>{text("اسم الصنف", "Item name")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 110 }}>{text("الكمية", "Quantity")}</Th>
                <Th style={{ textAlign: "center", width: 90 }}>{text("الفواتير", "Invoices")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 150 }}>{text("إجمالي المشتريات", "Purchases total")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 100 }}>{text("المساهمة", "Share")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><Td colSpan={6}><Empty text={text("لا توجد مشتريات في الفترة المحددة", "No purchases for this period")} /></Td></tr>
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
                  <Td colSpan={2}>{text("الإجمالي", "Total")} ({rows.length} {text("صنف", "items")})</Td>
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
