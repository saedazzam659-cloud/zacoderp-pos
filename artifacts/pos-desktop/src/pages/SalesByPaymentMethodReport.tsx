import { useState } from "react";
import { reportSalesInvoices } from "../lib/salesReports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";
import { uiText, useUiLanguage } from "../lib/appSettings";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

const METHODS = ["cash", "bank", "credit"] as const;
type Method = string;

function payLabel(m: Method, language: "ar" | "en"): string {
  return m === "cash" ? uiText("نقدي", "Cash", language)
    : m === "bank" ? uiText("بنك / شبكة", "Bank / card", language)
    : m === "credit" ? uiText("آجل", "Credit", language) : m;
}

type Bucket = { key: Method; count: number; sub: number; vat: number; total: number };

export default function SalesByPaymentMethodReport() {
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
    <Page title={text("المبيعات حسب طريقة الدفع", "Sales by payment method")} subtitle={text("توزيع المبيعات والتحصيل على طرق الدفع (نقدي / بنك / آجل) خلال الفترة.", "Sales and collections by payment method for the selected period.")}>
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
                <Th>{text("طريقة الدفع", "Payment method")}</Th>
                <Th style={{ width: 90, textAlign: "center" }}>{text("الفواتير", "Invoices")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 130 }}>{text("الصافي", "Net")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 120 }}>{text("الضريبة", "Tax")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 140 }}>{text("الإجمالي", "Total")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 100 }}>{text("النسبة", "Share")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><Td colSpan={6}><Empty text={text("لا توجد فواتير في الفترة المحددة", "No invoices for this period")} /></Td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.key}>
                  <Td>{payLabel(r.key, language)}</Td>
                  <Td style={{ textAlign: "center" }}>{r.count}</Td>
                  <Td num>{fmt(r.sub)}</Td>
                  <Td num>{fmt(r.vat)}</Td>
                  <Td num>{fmt(r.total)}</Td>
                  <Td num>{totals.total > 0 ? `${((r.total / totals.total) * 100).toFixed(1)}%` : "—"}</Td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td>{text("الإجمالي", "Total")}</Td>
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
