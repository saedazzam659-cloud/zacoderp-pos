import { useState } from "react";
import { reportSalesReturns, type SalesReturnReportRow } from "../lib/salesReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

const NO_CUSTOMER = -1;

type Bucket = {
  key: number; name: string;
  count: number; sub: number; vat: number; total: number;
};

export default function SalesReturnsReport() {
  const { branches } = useDimensions();
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [rows, setRows] = useState<Bucket[] | null>(null);
  const [raw, setRaw] = useState<SalesReturnReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr("تاريخ البداية يجب أن يكون قبل تاريخ النهاية"); return; }
    setErr(null); setLoading(true);
    try {
      const rets = await reportSalesReturns({ fromDate, toDate, branchId: branchId === "" ? null : branchId });
      setRaw(rets);
      const map = new Map<number, Bucket>();
      for (const r of rets) {
        const key = r.customerId ?? NO_CUSTOMER;
        let b = map.get(key);
        if (!b) { b = { key, name: r.customerName || "عميل نقدي / غير محدد", count: 0, sub: 0, vat: 0, total: 0 }; map.set(key, b); }
        b.count += 1; b.sub += r.subtotal; b.vat += r.vatTotal; b.total += r.grandTotal;
      }
      setRows([...map.values()].sort((a, b) => b.total - a.total));
    } finally { setLoading(false); }
  }

  const totals = (rows ?? []).reduce(
    (s, r) => { s.count += r.count; s.sub += r.sub; s.vat += r.vat; s.total += r.total; return s; },
    { count: 0, sub: 0, vat: 0, total: 0 },
  );

  return (
    <Page title="تقرير مرتجعات المبيعات" subtitle="إجمالي مرتجعات المبيعات لكل عميل خلال الفترة المحددة.">
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
          <div style={{ marginBottom: 8, fontSize: 13, color: "#64748b" }}>
            عدد مستندات المرتجع: <b>{raw.length}</b>
          </div>
          <Table>
            <thead>
              <tr>
                <Th>العميل</Th>
                <Th style={{ width: 110, textAlign: "center" }}>عدد المرتجعات</Th>
                <Th style={{ textAlign: "left", width: 130 }}>الصافي</Th>
                <Th style={{ textAlign: "left", width: 120 }}>الضريبة</Th>
                <Th style={{ textAlign: "left", width: 140 }}>إجمالي المرتجع</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><Td colSpan={5}><Empty text="لا توجد مرتجعات في الفترة المحددة" /></Td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.key}>
                  <Td>{r.name}</Td>
                  <Td style={{ textAlign: "center" }}>{r.count}</Td>
                  <Td num>{fmt(r.sub)}</Td>
                  <Td num>{fmt(r.vat)}</Td>
                  <Td num>{fmt(r.total)}</Td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td>الإجمالي ({rows.length} عميل)</Td>
                  <Td style={{ textAlign: "center" }}>{totals.count}</Td>
                  <Td num>{fmt(totals.sub)}</Td>
                  <Td num>{fmt(totals.vat)}</Td>
                  <Td num>{fmt(totals.total)}</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
