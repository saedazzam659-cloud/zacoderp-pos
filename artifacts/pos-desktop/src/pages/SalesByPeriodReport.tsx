import { useState } from "react";
import { reportSalesInvoices } from "../lib/salesReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, SearchCombobox, input } from "./_adminUi";
import { useDimensions, DateField, BranchField, FilterField } from "./_reportFilters";
import { uiText, useUiLanguage } from "../lib/appSettings";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

type Bucket = { period: string; count: number; sub: number; vat: number; tot: number };

export default function SalesByPeriodReport() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const { branches } = useDimensions();
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [gran, setGran] = useState<"day" | "month">("month");
  const [rows, setRows] = useState<Bucket[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr(text("تاريخ البداية يجب أن يكون قبل تاريخ النهاية", "Start date must be on or before end date.")); return; }
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
    <Page title={text("المبيعات حسب الفترة", "Sales by period")} subtitle={text("إجمالي المبيعات مجمّعة حسب اليوم أو الشهر.", "Total sales grouped by day or month.")}>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <DateField label={text("من تاريخ", "From date")} value={fromDate} onChange={setFromDate} />
          <DateField label={text("إلى تاريخ", "To date")} value={toDate} onChange={setToDate} />
          <BranchField branches={branches} value={branchId} onChange={setBranchId} />
          <FilterField label={text("التجميع", "Group by")}>
            <SearchCombobox
              value={gran}
              onChange={(v) => setGran((v as "day" | "month") || "month")}
              options={[{ value: "month", label: text("شهري", "Monthly") }, { value: "day", label: text("يومي", "Daily") }]}
              style={{ ...input, padding: "8px 10px" }}
            />
          </FilterField>
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : text("عرض", "Run report")}</button>
        </div>
        {err && <div style={{ marginTop: 8, color: "#991b1b", fontSize: 13 }}>⚠️ {err}</div>}
      </Card>

      {rows && (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 160 }}>{text("الفترة", "Period")}</Th>
                <Th style={{ width: 110, textAlign: "center" }}>{text("عدد الفواتير", "Invoices")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 140 }}>{text("الصافي", "Net")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 130 }}>{text("الضريبة", "Tax")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 150 }}>{text("الإجمالي", "Total")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><Td colSpan={5}><Empty text={text("لا توجد مبيعات في الفترة المحددة", "No sales for this period")} /></Td></tr>
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
                  <Td>{text("الإجمالي", "Total")}</Td>
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
