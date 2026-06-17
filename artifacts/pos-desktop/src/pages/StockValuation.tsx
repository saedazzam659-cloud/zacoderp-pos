import { useEffect, useMemo, useState } from "react";
import { listStockOnHand, listWarehouses, type StockOnHand, type Warehouse } from "../lib/inventory";
import { useCurrencySymbol } from "../lib/currency";
import {
  Page, Card, Table, Th, Td, Empty, input, btnSecondary, fmt, fmtCurrency, SearchCombobox,
} from "./_adminUi";

interface ValRow extends StockOnHand {
  value: number;
}

export default function StockValuation() {
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

  const valued = useMemo<ValRow[]>(() => {
    return rows
      .filter((r) => !hideZero || Math.abs(r.qty) > 1e-9)
      .map((r) => ({ ...r, value: r.qty * r.last_cost }))
      .sort((a, b) =>
        a.warehouse_name === b.warehouse_name
          ? a.item_name.localeCompare(b.item_name, "ar")
          : a.warehouse_name.localeCompare(b.warehouse_name, "ar"));
  }, [rows, hideZero]);

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

  return (
    <Page
      title="تقييم المخزون"
      subtitle={`${grand.count} صنف · إجمالي الكمية ${fmt(grand.qty)} · إجمالي القيمة ${fmtCurrency(grand.value)}`}
    >
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, alignItems: "end" }}>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>المخزن</div>
            <SearchCombobox
              value={warehouseId}
              onChange={(v) => setWarehouseId(v === "" ? "" : Number(v))}
              style={input}
              options={[
                { value: "", label: "كل المخازن" },
                ...warehouses.map((w) => ({ value: w.id, label: w.name })),
              ]}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 8 }}>
            <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
            <span style={{ fontSize: 13 }}>إخفاء الأرصدة الصفرية</span>
          </label>
          <button onClick={() => void refresh()} disabled={loading} style={btnSecondary}>{loading ? "..." : "تحديث"}</button>
        </div>
      </Card>
      <Card>
        {valued.length === 0 ? <Empty text="لا توجد أرصدة مخزون" /> : (
          <Table>
            <thead><tr>
              <Th>المخزن</Th><Th>الكود</Th><Th>الصنف</Th>
              <Th>الكمية</Th><Th>متوسط التكلفة</Th><Th>القيمة</Th>
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
                  <Td style={{ fontWeight: 600 }}>إجمالي المخزن</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmt(t.qty)}</Td>
                  <Td num>—</Td>
                  <Td num style={{ fontWeight: 700 }}>{fmtCurrency(t.value)}</Td>
                </tr>
              ))}
              <tr style={{ background: "#f1f5f9" }}>
                <Td style={{ fontWeight: 700 }}>الإجمالي العام</Td>
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
