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
import { uiText, useUiLanguage } from "../lib/appSettings";

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
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
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
  const displayDate = (value: string) => {
    const date = new Date(`${value.slice(0, 10)}T00:00:00`);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(language === "en" ? "en-US" : "ar", { dateStyle: "medium" }).format(date);
  };
  const movementLabels: Record<string, [string, string]> = {
    purchase: ["فاتورة شراء", "Purchase invoice"],
    purchase_return: ["مرتجع شراء", "Purchase return"],
    sale: ["فاتورة بيع", "Sales invoice"],
    sale_return: ["مرتجع بيع", "Sales return"],
    adjustment: ["تسوية", "Adjustment"],
    stocktake: ["جرد", "Stocktake"],
    transfer_in: ["تحويل وارد", "Transfer in"],
    transfer_out: ["تحويل صادر", "Transfer out"],
    opening: ["رصيد افتتاحي", "Opening balance"],
  };

  return (
    <Page
      title={text("لوحة المخزون", "Inventory dashboard")}
      subtitle={text("نظرة عامة على المخزون والحركة الأخيرة", "Stock overview and recent movements")}
      right={<button onClick={() => void refresh()} disabled={loading} style={btnSecondary}>{loading ? "..." : text("تحديث", "Refresh")}</button>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
        <Tile label={text("عدد الأصناف", "Items")} value={fmt(items.length)} sub={`${fmt(warehouses.length)} ${text("مستودع", "warehouses")}`} />
        <Tile label={text("قيمة المخزون", "Stock value")} value={fmtCurrency(stockValue)} sub={`${text("إجمالي الكمية", "Total quantity")} ${fmt(totalQty)}`} accent="#2563eb" />
        <Tile label={text("أصناف تحت حد الطلب", "Below reorder point")} value={fmt(belowReorder)} accent={belowReorder > 0 ? "#d97706" : "#0f172a"} />
        <Tile label={text("أصناف نفدت", "Out of stock")} value={fmt(outOfStock)} accent={outOfStock > 0 ? "#dc2626" : "#0f172a"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 12, alignItems: "start" }}>
        <Card>
          <div style={{ padding: "12px 16px", fontWeight: 700, borderBottom: "1px solid #e2e8f0" }}>{text("المخزون حسب المستودع", "Stock by warehouse")}</div>
          {byWarehouse.length === 0 ? <Empty text={text("لا توجد بيانات مخزون", "No stock data")} /> : (
            <Table>
              <thead><tr>
                <Th>{text("المستودع", "Warehouse")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الكمية", "Quantity")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("القيمة", "Value")}</Th>
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
          <div style={{ padding: "12px 16px", fontWeight: 700, borderBottom: "1px solid #e2e8f0" }}>{text("آخر الحركات", "Recent movements")}</div>
          {moves.length === 0 ? <Empty text={text("لا توجد حركات مخزنية بعد", "No stock movements yet")} /> : (
            <Table>
              <thead><tr>
                <Th>{text("التاريخ", "Date")}</Th><Th>{text("الصنف", "Item")}</Th><Th>{text("المستودع", "Warehouse")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الكمية", "Quantity")}</Th><Th>{text("المرجع", "Reference")}</Th>
              </tr></thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id}>
                    <Td>{displayDate(m.entry_date)}</Td>
                    <Td>{m.item_name}</Td>
                    <Td>{m.warehouse_name}</Td>
                    <Td num style={{ color: m.qty_delta < 0 ? "#dc2626" : "#15803d", fontWeight: 600 }}>
                      {m.qty_delta > 0 ? "+" : ""}{fmt(m.qty_delta)}
                    </Td>
                    <Td mono>{movementLabels[m.ref_type] ? uiText(...movementLabels[m.ref_type], language) : m.ref_type}{m.ref_id ? ` #${m.ref_id}` : ""}</Td>
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
