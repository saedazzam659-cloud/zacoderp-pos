import { useEffect, useMemo, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import { listStockOnHand, listWarehouses, type StockOnHand, type Warehouse } from "../lib/inventory";
import { useCurrencySymbol } from "../lib/currency";
import { uiText, useUiLanguage } from "../lib/appSettings";
import {
  Page, Card, Table, Th, Td, Empty, input, btnSecondary, fmt, fmtCurrency, SearchCombobox, ExportButtons,
} from "./_adminUi";
import type { ExportColumn } from "../lib/exporters";

interface ValRow extends StockOnHand {
  value: number;
}

// Flat row mirroring the on-screen valuation table (item rows + optional
// per-warehouse subtotal rows + grand total row).
type ValExportRow = {
  warehouse: string;
  code: string;
  name: string;
  qty: number;
  cost: number | "";
  value: number;
};

export default function StockValuation() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  useCurrencySymbol(); // subscribe so currency formatting re-renders on country change
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [hideZero, setHideZero] = useState(true);
  const [rows, setRows] = useState<StockOnHand[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { void (async () => setWarehouses(await listWarehouses()))(); }, []);

  async function refresh() {
    setLoading(true);
    try {
      setRows(await listStockOnHand(warehouseId === "" ? null : warehouseId));
    } finally { setLoading(false); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [warehouseId]);
  useDataRefresh(["stock", "invoices"], () => { void refresh(); });

  const valued = useMemo<ValRow[]>(() => {
    return rows
      .filter((r) => !hideZero || Math.abs(r.qty) > 1e-9)
      .map((r) => ({ ...r, value: r.qty * r.last_cost }))
      .sort((a, b) =>
          a.warehouse_name === b.warehouse_name
          ? a.item_name.localeCompare(b.item_name, language === "en" ? "en" : "ar")
          : a.warehouse_name.localeCompare(b.warehouse_name, language === "en" ? "en" : "ar"));
  }, [rows, hideZero, language]);

  // Per-warehouse subtotals (only meaningful when listing all warehouses).
  const subtotals = useMemo(() => {
    const m = new Map<string, { qty: number; value: number }>();
    for (const r of valued) {
      const cur = m.get(r.warehouse_name) ?? { qty: 0, value: 0 };
      cur.qty += r.qty; cur.value += r.value;
      m.set(r.warehouse_name, cur);
    }
    return m;
  }, [valued]);

  const grand = useMemo(() => {
    let qty = 0, value = 0;
    for (const r of valued) { qty += r.qty; value += r.value; }
    return { qty, value, count: valued.length };
  }, [valued]);

  const showSubtotals = warehouseId === "" && subtotals.size > 1;

  // Export rows mirror the on-screen table: item rows + optional per-warehouse
  // subtotal rows + grand total row. Raw numbers so Excel stays numeric.
  const exportRows = useMemo<ValExportRow[]>(() => {
    if (valued.length === 0) return [];
    const out: ValExportRow[] = valued.map((r) => ({
      warehouse: r.warehouse_name,
      code: r.item_code ?? "",
      name: r.item_name,
      qty: r.qty,
      cost: r.last_cost,
      value: r.value,
    }));
    if (showSubtotals) {
      for (const [name, t] of subtotals.entries()) {
        out.push({ warehouse: name, code: "—", name: text("إجمالي المخزن", "Warehouse total"), qty: t.qty, cost: "", value: t.value });
      }
    }
    out.push({ warehouse: text("الإجمالي العام", "Grand total"), code: "—", name: "—", qty: grand.qty, cost: "", value: grand.value });
    return out;
  }, [valued, showSubtotals, subtotals, grand, language]);

  const exportCols: ExportColumn<ValExportRow>[] = [
    { header: text("المخزن", "Warehouse"), cell: (r) => r.warehouse },
    { header: text("الكود", "Code"), cell: (r) => r.code },
    { header: text("الصنف", "Item"), cell: (r) => r.name },
    { header: text("الكمية", "Quantity"), cell: (r) => r.qty },
    { header: text("متوسط التكلفة", "Average cost"), cell: (r) => r.cost },
    { header: text("القيمة", "Value"), cell: (r) => r.value },
  ];

  return (
    <Page
      title={text("تقييم المخزون", "Stock valuation")}
      subtitle={`${grand.count} ${text("صنف", "items")} · ${text("إجمالي الكمية", "Total quantity")} ${fmt(grand.qty)} · ${text("إجمالي القيمة", "Total value")} ${fmtCurrency(grand.value)}`}
    >
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, alignItems: "end" }}>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>{text("المخزن", "Warehouse")}</div>
            <SearchCombobox
              value={warehouseId}
              onChange={(v) => setWarehouseId(v === "" ? "" : Number(v))}
              style={input}
              options={[
                { value: "", label: text("كل المخازن", "All warehouses") },
                ...warehouses.map((w) => ({ value: w.id, label: w.name })),
              ]}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 8 }}>
            <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
            <span style={{ fontSize: 13 }}>{text("إخفاء الأرصدة الصفرية", "Hide zero balances")}</span>
          </label>
          <button onClick={() => void refresh()} disabled={loading} style={btnSecondary}>{loading ? "..." : text("تحديث", "Refresh")}</button>
        </div>
      </Card>
      <Card>
        {exportRows.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 12px 0" }}>
            <ExportButtons
              columns={exportCols}
              rows={exportRows}
              filenameBase={text("تقييم-المخزون", "stock-valuation")}
              title={text("تقييم المخزون", "Stock valuation")}
            />
          </div>
        )}
        {valued.length === 0 ? <Empty text={text("لا توجد أرصدة مخزون", "No stock balances")} /> : (
          <Table>
            <thead><tr>
              <Th>{text("المخزن", "Warehouse")}</Th><Th>{text("الكود", "Code")}</Th><Th>{text("الصنف", "Item")}</Th>
              <Th>{text("الكمية", "Quantity")}</Th><Th>{text("متوسط التكلفة", "Average cost")}</Th><Th>{text("القيمة", "Value")}</Th>
            </tr></thead>
            <tbody>
              {valued.map((r) => (
                <tr key={`${r.item_id}-${r.warehouse_id}`}>
                  <Td>{r.warehouse_name}</Td>
                  <Td mono>{r.item_code ?? ""}</Td>
                  <Td>{r.item_name}</Td>
                  <Td num>{fmt(r.qty)}</Td>
                  <Td num>{fmt(r.last_cost)}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmtCurrency(r.value)}</Td>
                </tr>
              ))}
              {showSubtotals && [...subtotals.entries()].map(([name, t]) => (
                <tr key={`sub-${name}`} style={{ background: "#f8fafc" }}>
                  <Td style={{ fontWeight: 700 }}>{name}</Td>
                  <Td>—</Td>
                  <Td style={{ fontWeight: 600 }}>{text("إجمالي المخزن", "Warehouse total")}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmt(t.qty)}</Td>
                  <Td num>—</Td>
                  <Td num style={{ fontWeight: 700 }}>{fmtCurrency(t.value)}</Td>
                </tr>
              ))}
              <tr style={{ background: "#f1f5f9" }}>
                <Td style={{ fontWeight: 700 }}>{text("الإجمالي العام", "Grand total")}</Td>
                <Td>—</Td>
                <Td>—</Td>
                <Td num style={{ fontWeight: 700 }}>{fmt(grand.qty)}</Td>
                <Td num>—</Td>
                <Td num style={{ fontWeight: 700 }}>{fmtCurrency(grand.value)}</Td>
              </tr>
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
