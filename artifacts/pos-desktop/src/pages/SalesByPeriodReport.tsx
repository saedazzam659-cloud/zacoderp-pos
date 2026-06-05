import { useState } from "react";
import { reportSalesInvoices } from "../lib/salesReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, SearchCombobox, input } from "./_adminUi";
import { useDimensions, DateField, BranchField, FilterField } from "./_reportFilters";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

type Bucket = { period: string; count: number; sub: number; vat: number; tot: number };

export default function SalesByPeriodReport() {
  const { branches } = useDimensions();
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [gran, setGran] = useState<"day" | "month">("month");
  const [rows, setRows] = useState<Bucket[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr("تاريخ البداية يجب أن يكون قبل تاريخ النهاية"); return; }
    setErr(null); setLoading(true);
    try {
      const invs = await reportSalesInvoices({ fromDate, toDate, branchId: branchId === "" ? null : branchId });
      const map = new Map<string, Bucket>();
      for (const r of invs) {
        const period = gran === "day" ? r.invoiceDate : r.invoiceDate.slice(0, 7);
        const b = map.get(period) ?? { period, count: 0, sub: 0, vat: 0, tot: 0 };
        b.count += 1; b.sub += r.subtotal; b.vat += r.vatTotal; b.tot += r.grandTotal;
        map.set(period, b);
      }
      setRows([...map.values()].sort((a, b) => (a.period < b.period ? -1 : 1)));
    } finally { setLoading(false); }
  }

  const totals = (rows ?? []).reduce(
    (s, r) => { s.count += r.count; s.sub += r.sub; s.vat += r.vat; s.tot += r.tot; return s; },
    { count: 0, sub: 0, vat: 0, tot: 0 },
  );

  return (
    <Page title="المبيعات حسب الفترة" subtitle="إجمالي المبيعات مجمّعة حسب اليوم أو الشهر.">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <DateField label="من تاريخ" value={fromDate} onChange={setFromDate} />
          <DateField label="إلى تاريخ" value={toDate} onChange={setToDate} />
          <BranchField branches={branches} value={branchId} onChange={setBranchId} />
          <FilterField label="التجميع">
            <SearchCombobox
              value={gran}
              onChange={(v) => setGran((v as "day" | "month") || "month")}
              options={[{ value: "month", label: "شهري" }, { value: "day", label: "يومي" }]}
              style={{ ...input, padding: "8px 10px" }}
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
                <Th style={{ width: 160 }}>الفترة</Th>
                <Th style={{ width: 110, textAlign: "center" }}>عدد الفواتير</Th>
                <Th style={{ textAlign: "left", width: 140 }}>الصافي</Th>
                <Th style={{ textAlign: "left", width: 130 }}>الضريبة</Th>
                <Th style={{ textAlign: "left", width: 150 }}>الإجمالي</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><Td colSpan={5}><Empty text="لا توجد مبيعات في الفترة المحددة" /></Td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.period}>
                  <Td mono>{r.period}</Td>
                  <Td style={{ textAlign: "center" }}>{r.count}</Td>
                  <Td num>{fmt(r.sub)}</Td>
                  <Td num>{fmt(r.vat)}</Td>
                  <Td num>{fmt(r.tot)}</Td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td>الإجمالي</Td>
                  <Td style={{ textAlign: "center" }}>{totals.count}</Td>
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
