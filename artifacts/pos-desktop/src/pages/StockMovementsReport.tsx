import { useEffect, useMemo, useState } from "react";
import { listStockMovements, listWarehouses, type StockMovement, type Warehouse } from "../lib/inventory";
import { listItems } from "../lib/items";
import type { LocalItem } from "../lib/items";
import {
  Page, Card, Table, Th, Td, Empty, input, btnSecondary, fmt, todayStr,
} from "./_adminUi";

const REF_LABEL: Record<string, string> = {
  purchase: "فاتورة شراء",
  purchase_return: "مرتجع شراء",
  sale: "فاتورة بيع",
  sale_return: "مرتجع بيع",
  adjustment: "تسوية",
  stocktake: "جرد",
  transfer_in: "تحويل وارد",
  transfer_out: "تحويل صادر",
  opening: "رصيد افتتاحي",
};

export default function StockMovementsReport() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<LocalItem[]>([]);
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [itemId, setItemId] = useState<number | "">("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>(todayStr());
  const [rows, setRows] = useState<StockMovement[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      setWarehouses(await listWarehouses());
      setItems(await listItems());
    })();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      setRows(await listStockMovements({
        warehouseId: warehouseId === "" ? null : warehouseId,
        itemId: itemId === "" ? null : itemId,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        limit: 1000,
      }));
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const totals = useMemo(() => {
    let inQ = 0, outQ = 0;
    for (const r of rows) { if (r.qty_delta > 0) inQ += r.qty_delta; else outQ += -r.qty_delta; }
    return { inQ, outQ };
  }, [rows]);

  return (
    <Page
      title="حركة المخزون"
      subtitle={`${rows.length} حركة · داخل ${fmt(totals.inQ)} · خارج ${fmt(totals.outQ)}`}
    >
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: 10, alignItems: "end" }}>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>المخزن</div>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value === "" ? "" : Number(e.target.value))} style={input}>
              <option value="">كل المخازن</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>الصنف</div>
            <select value={itemId} onChange={(e) => setItemId(e.target.value === "" ? "" : Number(e.target.value))} style={input}>
              <option value="">كل الأصناف</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.nameAr}</option>)}
            </select>
          </label>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>من تاريخ</div>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={input} />
          </label>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>إلى تاريخ</div>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={input} />
          </label>
          <button onClick={() => void refresh()} disabled={loading} style={btnSecondary}>{loading ? "..." : "تحديث"}</button>
        </div>
      </Card>
      <Card>
        {rows.length === 0 ? <Empty text="لا توجد حركات" /> : (
          <Table>
            <thead><tr>
              <Th>التاريخ</Th><Th>المخزن</Th><Th>الصنف</Th>
              <Th>المرجع</Th><Th>وارد</Th><Th>صادر</Th>
              <Th>الرصيد بعد</Th><Th>التكلفة</Th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td mono>{r.entry_date}</Td>
                  <Td>{r.warehouse_name}</Td>
                  <Td>{r.item_name}</Td>
                  <Td>{REF_LABEL[r.ref_type] ?? r.ref_type}{r.ref_id ? ` #${r.ref_id}` : ""}</Td>
                  <Td num style={{ color: "#16a34a" }}>{r.qty_delta > 0 ? fmt(r.qty_delta) : ""}</Td>
                  <Td num style={{ color: "#dc2626" }}>{r.qty_delta < 0 ? fmt(-r.qty_delta) : ""}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmt(r.balance_after)}</Td>
                  <Td num>{fmt(r.unit_cost)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
