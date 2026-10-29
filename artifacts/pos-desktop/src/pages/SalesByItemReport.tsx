import { useState } from "react";
import { reportSalesInvoiceLines } from "../lib/salesReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, ExportButtons } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";
import type { ExportColumn } from "../lib/exporters";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

// Flat row mirroring the on-screen items table (per-item rows + totals row).
type ItemExportRow = {
  code: string;
  name: string;
  qty: number;
  invoices: number | "";
  total: number;
  share: string;
};

type Bucket = {
  itemId: number; code: string | null; name: string;
  qty: number; total: number; invoices: Set<number>;
};

export default function SalesByItemReport() {
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
      const lines = await reportSalesInvoiceLines({ fromDate, toDate, branchId: branchId === "" ? null : branchId });
      const map = new Map<number, Bucket>();
      for (const l of lines) {
        const b = map.get(l.itemId) ?? { itemId: l.itemId, code: l.itemCode, name: l.itemName, qty: 0, total: 0, invoices: new Set<number>() };
        b.qty += l.qty; b.total += l.lineTotal; b.invoices.add(l.invoiceId);
        map.set(l.itemId, b);
      }
      setRows([...map.values()].sort((a, b) => b.total - a.total));
    } finally { setLoading(false); }
  }

  const grandTotal = (rows ?? []).reduce((s, r) => s + r.total, 0);
  const totalQty = (rows ?? []).reduce((s, r) => s + r.qty, 0);

  // Export rows mirror the on-screen table: per-item rows + totals row.
  const exportRows: ItemExportRow[] = (rows ?? []).map((r) => ({
    code: r.code || "—",
    name: r.name,
    qty: r.qty,
    invoices: r.invoices.size,
    total: r.total,
    share: grandTotal > 0 ? `${((r.total / grandTotal) * 100).toFixed(1)}%` : "—",
  }));
  if (rows && rows.length > 0) {
    exportRows.push({
      code: `الإجمالي (${rows.length} صنف)`,
      name: "", qty: totalQty, invoices: "", total: grandTotal, share: "100%",
    });
  }
  const exportCols: ExportColumn<ItemExportRow>[] = [
    { header: "كود الصنف", cell: (r) => r.code },
    { header: "اسم الصنف", cell: (r) => r.name },
    { header: "الكمية", cell: (r) => r.qty },
    { header: "الفواتير", cell: (r) => r.invoices },
    { header: "إجمالي المبيعات", cell: (r) => r.total },
    { header: "المساهمة", cell: (r) => r.share },
  ];

  return (
    <Page title="المبيعات حسب الصنف" subtitle="إجمالي مبيعات كل صنف خلال الفترة مرتبة تنازلياً مع نسبة المساهمة.">
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
                filenameBase="المبيعات-حسب-الصنف"
                title={`المبيعات حسب الصنف — ${fromDate} ← ${toDate}`}
              />
            </div>
          )}
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 120 }}>كود الصنف</Th>
                <Th>اسم الصنف</Th>
                <Th style={{ textAlign: "left", width: 110 }}>الكمية</Th>
                <Th style={{ textAlign: "center", width: 90 }}>الفواتير</Th>
                <Th style={{ textAlign: "left", width: 150 }}>إجمالي المبيعات</Th>
                <Th style={{ textAlign: "left", width: 100 }}>المساهمة</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><Td colSpan={6}><Empty text="لا توجد مبيعات في الفترة المحددة" /></Td></tr>
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
