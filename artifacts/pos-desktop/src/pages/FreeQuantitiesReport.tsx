// تقرير الكميات الحرة (Free Quantities) — offline report.
//
// Per-item bonus/free quantities: free qty SOLD (sales-invoice lines free_qty)
// minus free qty RETURNED (sales-return lines free_qty) = net free qty given
// away. Reuses report_sales_invoice_lines + report_sales_return_lines (Rust
// returns filtered raw lines; aggregation is done here per the offline-reports
// convention). NOTE: there is no return-form free-qty UI yet, so returnedFreeQty
// is 0 until that data exists — the column/netting is wired for when it does.

import { useState } from "react";
import { reportSalesInvoiceLines, reportSalesReturnLines } from "../lib/salesReports";
import { useCurrencySymbol } from "../lib/currency";
import { Page, Card, Table, Th, Td, Empty, input, btnPrimary, fmt, todayStr } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

type Bucket = {
  itemId: number; code: string | null; name: string;
  soldFree: number; returnedFree: number;
};

export default function FreeQuantitiesReport() {
  useCurrencySymbol(); // subscribe so formatting re-renders on country change
  const { branches } = useDimensions();
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Bucket[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr("تاريخ البداية يجب أن يكون قبل تاريخ النهاية"); return; }
    setErr(null); setLoading(true);
    try {
      const branch = branchId === "" ? null : branchId;
      const [soldLines, returnLines] = await Promise.all([
        reportSalesInvoiceLines({ fromDate, toDate, branchId: branch }),
        reportSalesReturnLines({ fromDate, toDate, branchId: branch }),
      ]);
      const map = new Map<number, Bucket>();
      const get = (itemId: number, code: string | null, name: string) =>
        map.get(itemId) ?? { itemId, code, name, soldFree: 0, returnedFree: 0 };
      for (const l of soldLines) {
        if ((l.freeQty ?? 0) === 0) continue;
        const b = get(l.itemId, l.itemCode, l.itemName);
        b.soldFree += l.freeQty;
        map.set(l.itemId, b);
      }
      for (const l of returnLines) {
        if ((l.freeQty ?? 0) === 0) continue;
        const b = get(l.itemId, l.itemCode, l.itemName);
        b.returnedFree += l.freeQty;
        map.set(l.itemId, b);
      }
      const out = [...map.values()]
        .filter((b) => b.soldFree !== 0 || b.returnedFree !== 0)
        .sort((a, b) => (b.soldFree - b.returnedFree) - (a.soldFree - a.returnedFree));
      setRows(out);
    } finally { setLoading(false); }
  }

  const filtered = (rows ?? []).filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.name.toLowerCase().includes(q) || (r.code ?? "").toLowerCase().includes(q);
  });
  const totalSold = filtered.reduce((s, r) => s + r.soldFree, 0);
  const totalReturned = filtered.reduce((s, r) => s + r.returnedFree, 0);
  const totalNet = totalSold - totalReturned;

  return (
    <Page title="تقرير الكميات الحرة" subtitle="الكميات المجانية (البونص) المصروفة لكل صنف خلال الفترة: المباع الحر مطروحًا منه المرتجع الحر.">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <DateField label="من تاريخ" value={fromDate} onChange={setFromDate} />
          <DateField label="إلى تاريخ" value={toDate} onChange={setToDate} />
          <BranchField branches={branches} value={branchId} onChange={setBranchId} />
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200 }}>
            <label style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>بحث (اسم / كود)</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...input, padding: "8px 10px" }} placeholder="ابحث باسم الصنف أو الكود" />
          </div>
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
                <Th style={{ textAlign: "left", width: 150 }}>الكمية الحرة المباعة</Th>
                <Th style={{ textAlign: "left", width: 150 }}>الكمية الحرة المرتجعة</Th>
                <Th style={{ textAlign: "left", width: 150 }}>صافي الكمية الحرة</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><Td colSpan={5}><Empty text="لا توجد كميات حرة في الفترة المحددة" /></Td></tr>
              )}
              {filtered.map((r) => (
                <tr key={r.itemId}>
                  <Td mono>{r.code || "—"}</Td>
                  <Td>{r.name}</Td>
                  <Td num>{fmt(r.soldFree)}</Td>
                  <Td num>{fmt(r.returnedFree)}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmt(r.soldFree - r.returnedFree)}</Td>
                </tr>
              ))}
              {filtered.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td colSpan={2}>الإجمالي ({filtered.length} صنف)</Td>
                  <Td num>{fmt(totalSold)}</Td>
                  <Td num>{fmt(totalReturned)}</Td>
                  <Td num>{fmt(totalNet)}</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
