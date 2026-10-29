// لوحة المخزون (Inventory Dashboard) — offline TS-only summary.
//
// Reuses existing Rust commands only: stock_on_hand_list, stock_movements_list,
// items_list, warehouses_list. Reorder tracking lives in the LS-backed stock
// overlay (lib/stock.ts) — the same source the low-stock report uses — so the
// "أصناف تحت حد الطلب" tile stays consistent with that screen.

import { useEffect, useMemo, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listStockOnHand, listStockMovements, listWarehouses,
  type StockOnHand, type StockMovement, type Warehouse,
} from "../lib/inventory";
import { listItems, type LocalItem } from "../lib/items";
import { getAllStockShared, countLowStockInMap, type StockMap } from "../lib/stock";
import { useCurrencySymbol } from "../lib/currency";
import {
  Page, Card, Table, Th, Td, Empty, btnSecondary, fmt, fmtCurrency,
} from "./_adminUi";

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: accent ?? "#0f172a" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>{sub}</div>}
    </Card>
  );
}

export default function InventoryDashboardAdmin() {
  useCurrencySymbol();
  const [items, setItems] = useState<LocalItem[]>([]);
  const [onHand, setOnHand] = useState<StockOnHand[]>([]);
  const [moves, setMoves] = useState<StockMovement[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [stockMap, setStockMap] = useState<StockMap>({});
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [it, oh, mv, wh, sm] = await Promise.all([
        listItems(),
        listStockOnHand(null),
        listStockMovements({ limit: 50 }),
        listWarehouses(),
        getAllStockShared(),
      ]);
      setItems(it);
      setOnHand(oh);
      setMoves(mv);
      setWarehouses(wh);
      setStockMap(sm);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);
  useDataRefresh(["stock", "invoices", "items", "warehouses"], () => { void refresh(); });

  const stockValue = useMemo(
    () => onHand.reduce((s, r) => s + r.qty * r.last_cost, 0),
    [onHand],
  );
  const totalQty = useMemo(
    () => onHand.reduce((s, r) => s + r.qty, 0),
    [onHand],
  );
  const belowReorder = useMemo(
    () => countLowStockInMap(stockMap),
    [stockMap],
  );
  const outOfStock = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of onHand) m.set(r.item_id, (m.get(r.item_id) ?? 0) + r.qty);
    let n = 0;
    for (const v of m.values()) if (v <= 1e-9) n++;
    return n;
  }, [onHand]);

  // Top warehouses by stock value.
  const byWarehouse = useMemo(() => {
    const m = new Map<number, { name: string; value: number; qty: number }>();
    for (const r of onHand) {
      const cur = m.get(r.warehouse_id) ?? { name: r.warehouse_name, value: 0, qty: 0 };
      cur.value += r.qty * r.last_cost;
      cur.qty += r.qty;
      m.set(r.warehouse_id, cur);
    }
    return [...m.values()].sort((a, b) => b.value - a.value);
  }, [onHand]);

  return (
    <Page
      title="لوحة المخزون"
      subtitle="نظرة عامة على المخزون والحركة الأخيرة"
      right={<button onClick={() => void refresh()} disabled={loading} style={btnSecondary}>{loading ? "..." : "تحديث"}</button>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
        <Tile label="عدد الأصناف" value={fmt(items.length)} sub={`${fmt(warehouses.length)} مستودع`} />
        <Tile label="قيمة المخزون" value={fmtCurrency(stockValue)} sub={`إجمالي الكمية ${fmt(totalQty)}`} accent="#2563eb" />
        <Tile label="أصناف تحت حد الطلب" value={fmt(belowReorder)} accent={belowReorder > 0 ? "#d97706" : "#0f172a"} />
        <Tile label="أصناف نفدت" value={fmt(outOfStock)} accent={outOfStock > 0 ? "#dc2626" : "#0f172a"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 12, alignItems: "start" }}>
        <Card>
          <div style={{ padding: "12px 16px", fontWeight: 700, borderBottom: "1px solid #e2e8f0" }}>المخزون حسب المستودع</div>
          {byWarehouse.length === 0 ? <Empty text="لا توجد بيانات مخزون" /> : (
            <Table>
              <thead><tr>
                <Th>المستودع</Th><Th style={{ textAlign: "left" }}>الكمية</Th><Th style={{ textAlign: "left" }}>القيمة</Th>
              </tr></thead>
              <tbody>
                {byWarehouse.map((w, i) => (
                  <tr key={i}>
                    <Td>{w.name}</Td>
                    <Td num>{fmt(w.qty)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmtCurrency(w.value)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <div style={{ padding: "12px 16px", fontWeight: 700, borderBottom: "1px solid #e2e8f0" }}>آخر الحركات</div>
          {moves.length === 0 ? <Empty text="لا توجد حركات مخزنية بعد" /> : (
            <Table>
              <thead><tr>
                <Th>التاريخ</Th><Th>الصنف</Th><Th>المستودع</Th>
                <Th style={{ textAlign: "left" }}>الكمية</Th><Th>المرجع</Th>
              </tr></thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id}>
                    <Td>{m.entry_date}</Td>
                    <Td>{m.item_name}</Td>
                    <Td>{m.warehouse_name}</Td>
                    <Td num style={{ color: m.qty_delta < 0 ? "#dc2626" : "#15803d", fontWeight: 600 }}>
                      {m.qty_delta > 0 ? "+" : ""}{fmt(m.qty_delta)}
                    </Td>
                    <Td mono>{m.ref_type}{m.ref_id ? `#${m.ref_id}` : ""}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </Page>
  );
}
