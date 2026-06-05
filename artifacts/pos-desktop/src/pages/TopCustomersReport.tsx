import { useState } from "react";
import { reportSalesInvoices, reportSalesReturns } from "../lib/salesReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, input } from "./_adminUi";
import { useDimensions, DateField, BranchField, FilterField } from "./_reportFilters";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

const NO_CUSTOMER = -1;

type Bucket = {
  key: number; name: string;
  count: number; sales: number; returns: number;
};

export default function TopCustomersReport() {
  const { branches } = useDimensions();
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [topN, setTopN] = useState(10);
  const [rows, setRows] = useState<Bucket[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr("تاريخ البداية يجب أن يكون قبل تاريخ النهاية"); return; }
    setErr(null); setLoading(true);
    try {
      const branch = branchId === "" ? null : branchId;
      const [invs, rets] = await Promise.all([
        reportSalesInvoices({ fromDate, toDate, branchId: branch }),
        reportSalesReturns({ fromDate, toDate, branchId: branch }),
      ]);
      const map = new Map<number, Bucket>();
      const get = (id: number | null, name: string | null): Bucket => {
        const key = id ?? NO_CUSTOMER;
        let b = map.get(key);
        if (!b) { b = { key, name: name || "عميل نقدي / غير محدد", count: 0, sales: 0, returns: 0 }; map.set(key, b); }
        return b;
      };
      for (const r of invs) { const b = get(r.customerId, r.customerName); b.count += 1; b.sales += r.grandTotal; }
      for (const r of rets) { const b = get(r.customerId, r.customerName); b.returns += r.grandTotal; }
      setRows([...map.values()].sort((a, b) => (b.sales - b.returns) - (a.sales - a.returns)));
    } finally { setLoading(false); }
  }

  const top = (rows ?? []).slice(0, topN > 0 ? topN : undefined);
  const grandNet = (rows ?? []).reduce((s, r) => s + (r.sales - r.returns), 0);
  const shownNet = top.reduce((s, r) => s + (r.sales - r.returns), 0);

  return (
    <Page title="أفضل العملاء" subtitle="ترتيب العملاء حسب صافي المبيعات (المبيعات − المرتجعات) خلال الفترة.">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <DateField label="من تاريخ" value={fromDate} onChange={setFromDate} />
          <DateField label="إلى تاريخ" value={toDate} onChange={setToDate} />
          <BranchField branches={branches} value={branchId} onChange={setBranchId} />
          <FilterField label="عدد العملاء">
            <input
              type="number" min={1} value={topN}
              onChange={(e) => setTopN(Math.max(1, Number(e.target.value) || 1))}
              style={{ ...input, padding: "8px 10px", width: 110 }}
            />
          </FilterField>
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : "عرض"}</button>
        </div>
        {err && <div style={{ marginTop: 8, color: "#991b1b", fontSize: 13 }}>⚠️ {err}</div>}
      </Card>

      {rows && (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 60, textAlign: "center" }}>#</Th>
                <Th>العميل</Th>
                <Th style={{ width: 90, textAlign: "center" }}>الفواتير</Th>
                <Th style={{ textAlign: "left", width: 130 }}>المبيعات</Th>
                <Th style={{ textAlign: "left", width: 120 }}>المرتجعات</Th>
                <Th style={{ textAlign: "left", width: 140 }}>صافي المبيعات</Th>
                <Th style={{ textAlign: "left", width: 100 }}>المساهمة</Th>
              </tr>
            </thead>
            <tbody>
              {top.length === 0 && (
                <tr><Td colSpan={7}><Empty text="لا توجد مبيعات في الفترة المحددة" /></Td></tr>
              )}
              {top.map((r, i) => {
                const net = r.sales - r.returns;
                return (
                  <tr key={r.key}>
                    <Td style={{ textAlign: "center" }}>{i + 1}</Td>
                    <Td>{r.name}</Td>
                    <Td style={{ textAlign: "center" }}>{r.count}</Td>
                    <Td num>{fmt(r.sales)}</Td>
                    <Td num>{r.returns > 0.001 ? fmt(r.returns) : ""}</Td>
                    <Td num>{fmt(net)}</Td>
                    <Td num>{grandNet > 0 ? `${((net / grandNet) * 100).toFixed(1)}%` : "—"}</Td>
                  </tr>
                );
              })}
              {top.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td />
                  <Td>إجمالي المعروض ({top.length} عميل)</Td>
                  <Td />
                  <Td />
                  <Td />
                  <Td num>{fmt(shownNet)}</Td>
                  <Td num>{grandNet > 0 ? `${((shownNet / grandNet) * 100).toFixed(1)}%` : "—"}</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
