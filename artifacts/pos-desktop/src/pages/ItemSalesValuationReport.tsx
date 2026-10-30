// تقييم مبيعات الأصناف (Item Sales Valuation) — offline report.
//
// Per-item SOLD vs RETURNED vs NET, valued on one of three bases:
//   • cost      → qty × unit_cost
//   • excl_vat  → line_total (net, VAT-exclusive)
//   • incl_vat  → line_total × (1 + vat_rate/100)
// Reuses report_sales_invoice_lines + report_sales_return_lines (Rust returns
// filtered raw lines; the valuation + aggregation happen here per the
// offline-reports convention).

import { useMemo, useState } from "react";
import { reportSalesInvoiceLines, reportSalesReturnLines } from "../lib/salesReports";
import { useCurrencySymbol } from "../lib/currency";
import { Page, Card, Table, Th, Td, Empty, input, btnPrimary, fmt, fmtCurrency, todayStr } from "./_adminUi";
import { useDimensions, DateField, BranchField } from "./_reportFilters";
import { uiText, useUiLanguage } from "../lib/appSettings";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

type Basis = "cost" | "excl_vat" | "incl_vat";
const BASIS_LABELS: Record<Basis, string> = {
  cost: "التكلفة",
  excl_vat: "قبل الضريبة",
  incl_vat: "شامل الضريبة",
};
const BASIS_LABELS_EN: Record<Basis, string> = {
  cost: "Cost",
  excl_vat: "Excluding tax",
  incl_vat: "Including tax",
};

type RawLine = { itemId: number; itemCode: string | null; itemName: string; qty: number; unitCost: number; lineTotal: number; vatRate: number };

function lineValue(l: RawLine, basis: Basis): number {
  switch (basis) {
    case "cost": return l.qty * l.unitCost;
    case "incl_vat": return l.lineTotal * (1 + (l.vatRate || 0) / 100);
    case "excl_vat":
    default: return l.lineTotal;
  }
}

type Bucket = {
  itemId: number; code: string | null; name: string;
  soldQty: number; soldValue: number;
  returnedQty: number; returnedValue: number;
};

export default function ItemSalesValuationReport() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  useCurrencySymbol(); // subscribe so currency formatting re-renders on country change
  const { branches } = useDimensions();
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [basis, setBasis] = useState<Basis>("excl_vat");
  const [search, setSearch] = useState("");
  const [sold, setSold] = useState<RawLine[] | null>(null);
  const [returned, setReturned] = useState<RawLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr(text("تاريخ البداية يجب أن يكون قبل تاريخ النهاية", "Start date must be on or before end date.")); return; }
    setErr(null); setLoading(true);
    try {
      const branch = branchId === "" ? null : branchId;
      const [soldLines, returnLines] = await Promise.all([
        reportSalesInvoiceLines({ fromDate, toDate, branchId: branch }),
        reportSalesReturnLines({ fromDate, toDate, branchId: branch }),
      ]);
      setSold(soldLines);
      setReturned(returnLines);
    } finally { setLoading(false); }
  }

  const rows = useMemo(() => {
    if (!sold) return null;
    const map = new Map<number, Bucket>();
    const get = (l: RawLine) =>
      map.get(l.itemId) ?? { itemId: l.itemId, code: l.itemCode, name: l.itemName, soldQty: 0, soldValue: 0, returnedQty: 0, returnedValue: 0 };
    for (const l of sold) {
      const b = get(l);
      b.soldQty += l.qty;
      b.soldValue += lineValue(l, basis);
      map.set(l.itemId, b);
    }
    for (const l of returned) {
      const b = get(l);
      b.returnedQty += l.qty;
      b.returnedValue += lineValue(l, basis);
      map.set(l.itemId, b);
    }
    return [...map.values()].sort((a, b) => (b.soldValue - b.returnedValue) - (a.soldValue - a.returnedValue));
  }, [sold, returned, basis]);

  const filtered = (rows ?? []).filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.name.toLowerCase().includes(q) || (r.code ?? "").toLowerCase().includes(q);
  });

  const tot = filtered.reduce(
    (s, r) => ({
      soldQty: s.soldQty + r.soldQty,
      soldValue: s.soldValue + r.soldValue,
      returnedQty: s.returnedQty + r.returnedQty,
      returnedValue: s.returnedValue + r.returnedValue,
    }),
    { soldQty: 0, soldValue: 0, returnedQty: 0, returnedValue: 0 },
  );

  return (
    <Page title={text("تقييم مبيعات الأصناف", "Item sales valuation")} subtitle={`${text("صافي مبيعات كل صنف (المباع − المرتجع) مقيّمًا على أساس", "Net sales per item (sold minus returned), valued by")} ${language === "en" ? BASIS_LABELS_EN[basis] : BASIS_LABELS[basis]}.`}>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <DateField label={text("من تاريخ", "From date")} value={fromDate} onChange={setFromDate} />
          <DateField label={text("إلى تاريخ", "To date")} value={toDate} onChange={setToDate} />
          <BranchField branches={branches} value={branchId} onChange={setBranchId} />
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
            <label style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>{text("أساس التقييم", "Valuation basis")}</label>
            <select value={basis} onChange={(e) => setBasis(e.target.value as Basis)} style={{ ...input, padding: "8px 10px" }}>
              <option value="cost">{text("التكلفة", "Cost")}</option>
              <option value="excl_vat">{text("قبل الضريبة", "Excluding tax")}</option>
              <option value="incl_vat">{text("شامل الضريبة", "Including tax")}</option>
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 180 }}>
            <label style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>{text("بحث (اسم / كود)", "Search (name / code)")}</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...input, padding: "8px 10px" }} placeholder={text("ابحث باسم الصنف أو الكود", "Search by item name or code")} />
          </div>
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : text("عرض", "Run report")}</button>
        </div>
        {err && <div style={{ marginTop: 8, color: "#991b1b", fontSize: 13 }}>⚠️ {err}</div>}
      </Card>

      {rows && (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 110 }}>{text("كود الصنف", "Item code")}</Th>
                <Th>{text("اسم الصنف", "Item name")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 90 }}>{text("كمية مباعة", "Qty sold")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 130 }}>{text("قيمة مباعة", "Sales value")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 90 }}>{text("كمية مرتجعة", "Qty returned")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 130 }}>{text("قيمة مرتجعة", "Return value")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 90 }}>{text("صافي الكمية", "Net quantity")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 140 }}>{text("صافي القيمة", "Net value")}</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><Td colSpan={8}><Empty text={text("لا توجد مبيعات في الفترة المحددة", "No sales for this period")} /></Td></tr>
              )}
              {filtered.map((r) => (
                <tr key={r.itemId}>
                  <Td mono>{r.code || "—"}</Td>
                  <Td>{r.name}</Td>
                  <Td num>{fmt(r.soldQty)}</Td>
                  <Td num>{fmtCurrency(r.soldValue)}</Td>
                  <Td num>{fmt(r.returnedQty)}</Td>
                  <Td num>{fmtCurrency(r.returnedValue)}</Td>
                  <Td num>{fmt(r.soldQty - r.returnedQty)}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmtCurrency(r.soldValue - r.returnedValue)}</Td>
                </tr>
              ))}
              {filtered.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td colSpan={2}>{text("الإجمالي", "Total")} ({filtered.length} {text("صنف", "items")})</Td>
                  <Td num>{fmt(tot.soldQty)}</Td>
                  <Td num>{fmtCurrency(tot.soldValue)}</Td>
                  <Td num>{fmt(tot.returnedQty)}</Td>
                  <Td num>{fmtCurrency(tot.returnedValue)}</Td>
                  <Td num>{fmt(tot.soldQty - tot.returnedQty)}</Td>
                  <Td num>{fmtCurrency(tot.soldValue - tot.returnedValue)}</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
