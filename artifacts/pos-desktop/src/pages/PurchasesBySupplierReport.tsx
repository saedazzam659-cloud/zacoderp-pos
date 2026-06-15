import { useState } from "react";
import { reportPurchaseInvoices, reportPurchaseReturns } from "../lib/purchaseReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

const NO_SUPPLIER = -1;

type Bucket = {
  key: number; name: string;
  count: number; sub: number; vat: number; purchases: number; returns: number;
};

export default function PurchasesBySupplierReport() {
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
      const branch = branchId === "" ? null : branchId;
      const [invs, rets] = await Promise.all([
        reportPurchaseInvoices({ fromDate, toDate, branchId: branch }),
        reportPurchaseReturns({ fromDate, toDate, branchId: branch }),
      ]);
      const map = new Map<number, Bucket>();
      const get = (id: number | null, name: string | null): Bucket => {
        const key = id ?? NO_SUPPLIER;
        let b = map.get(key);
        if (!b) { b = { key, name: name || "مورد غير محدد", count: 0, sub: 0, vat: 0, purchases: 0, returns: 0 }; map.set(key, b); }
        return b;
      };
      for (const r of invs) {
        const b = get(r.supplierId, r.supplierName);
        b.count += 1; b.sub += r.subtotal; b.vat += r.vatTotal; b.purchases += r.grandTotal;
      }
      for (const r of rets) {
        const b = get(r.supplierId, r.supplierName);
        b.returns += r.grandTotal;
      }
      setRows([...map.values()].sort((a, b) => (b.purchases - b.returns) - (a.purchases - a.returns)));
    } finally { setLoading(false); }
  }

  const totals = (rows ?? []).reduce(
    (s, r) => { s.count += r.count; s.sub += r.sub; s.vat += r.vat; s.purchases += r.purchases; s.returns += r.returns; return s; },
    { count: 0, sub: 0, vat: 0, purchases: 0, returns: 0 },
  );

  return (
    <Page title="المشتريات حسب المورد" subtitle="إجمالي المشتريات والمرتجعات والصافي لكل مورد خلال الفترة.">
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
                <Th>المورد</Th>
                <Th style={{ width: 90, textAlign: "center" }}>الفواتير</Th>
                <Th style={{ textAlign: "left", width: 120 }}>الصافي</Th>
                <Th style={{ textAlign: "left", width: 110 }}>الضريبة</Th>
                <Th style={{ textAlign: "left", width: 130 }}>إجمالي المشتريات</Th>
                <Th style={{ textAlign: "left", width: 120 }}>المرتجعات</Th>
                <Th style={{ textAlign: "left", width: 140 }}>صافي المشتريات</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><Td colSpan={7}><Empty text="لا توجد مشتريات في الفترة المحددة" /></Td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.key}>
                  <Td>{r.name}</Td>
                  <Td style={{ textAlign: "center" }}>{r.count}</Td>
                  <Td num>{fmt(r.sub)}</Td>
                  <Td num>{fmt(r.vat)}</Td>
                  <Td num>{fmt(r.purchases)}</Td>
                  <Td num>{r.returns > 0.001 ? fmt(r.returns) : ""}</Td>
                  <Td num>{fmt(r.purchases - r.returns)}</Td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td>الإجمالي ({rows.length} مورد)</Td>
                  <Td style={{ textAlign: "center" }}>{totals.count}</Td>
                  <Td num>{fmt(totals.sub)}</Td>
                  <Td num>{fmt(totals.vat)}</Td>
                  <Td num>{fmt(totals.purchases)}</Td>
                  <Td num>{fmt(totals.returns)}</Td>
                  <Td num>{fmt(totals.purchases - totals.returns)}</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
