import { useState } from "react";
import { reportSalesInvoices } from "../lib/salesReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

const METHODS = ["cash", "bank", "credit"] as const;
type Method = string;

function payLabel(m: Method): string {
  return m === "cash" ? "نقدي" : m === "bank" ? "بنك / شبكة" : m === "credit" ? "آجل" : m;
}

type Bucket = { key: Method; count: number; sub: number; vat: number; total: number };

export default function SalesByPaymentMethodReport() {
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
      const invs = await reportSalesInvoices({ fromDate, toDate, branchId: branchId === "" ? null : branchId });
      const map = new Map<Method, Bucket>();
      for (const r of invs) {
        const key = r.paymentMethod || "credit";
        let b = map.get(key);
        if (!b) { b = { key, count: 0, sub: 0, vat: 0, total: 0 }; map.set(key, b); }
        b.count += 1; b.sub += r.subtotal; b.vat += r.vatTotal; b.total += r.grandTotal;
      }
      const order = (k: Method) => { const i = (METHODS as readonly string[]).indexOf(k); return i < 0 ? 99 : i; };
      setRows([...map.values()].sort((a, b) => order(a.key) - order(b.key)));
    } finally { setLoading(false); }
  }

  const totals = (rows ?? []).reduce(
    (s, r) => { s.count += r.count; s.sub += r.sub; s.vat += r.vat; s.total += r.total; return s; },
    { count: 0, sub: 0, vat: 0, total: 0 },
  );

  return (
    <Page title="المبيعات حسب طريقة الدفع" subtitle="توزيع المبيعات والتحصيل على طرق الدفع (نقدي / بنك / آجل) خلال الفترة.">
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
                <Th>طريقة الدفع</Th>
                <Th style={{ width: 90, textAlign: "center" }}>الفواتير</Th>
                <Th style={{ textAlign: "left", width: 130 }}>الصافي</Th>
                <Th style={{ textAlign: "left", width: 120 }}>الضريبة</Th>
                <Th style={{ textAlign: "left", width: 140 }}>الإجمالي</Th>
                <Th style={{ textAlign: "left", width: 100 }}>النسبة</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><Td colSpan={6}><Empty text="لا توجد فواتير في الفترة المحددة" /></Td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.key}>
                  <Td>{payLabel(r.key)}</Td>
                  <Td style={{ textAlign: "center" }}>{r.count}</Td>
                  <Td num>{fmt(r.sub)}</Td>
                  <Td num>{fmt(r.vat)}</Td>
                  <Td num>{fmt(r.total)}</Td>
                  <Td num>{totals.total > 0 ? `${((r.total / totals.total) * 100).toFixed(1)}%` : "—"}</Td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td>الإجمالي</Td>
                  <Td style={{ textAlign: "center" }}>{totals.count}</Td>
                  <Td num>{fmt(totals.sub)}</Td>
                  <Td num>{fmt(totals.vat)}</Td>
                  <Td num>{fmt(totals.total)}</Td>
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
