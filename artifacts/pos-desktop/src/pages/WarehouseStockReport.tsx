// Available quantities per warehouse — a pivot of on-hand stock with items as
// rows and warehouses as columns. Reuses the existing `stock_on_hand_list`
// command (one row per item×warehouse) and pivots it client-side, matching the
// "grouping done in TS, Rust returns raw rows" convention of the other offline
// inventory reports.

import { useEffect, useMemo, useState } from "react";
import { listStockOnHand, type StockOnHand } from "../lib/inventory";
import {
  Page, Card, Table, Th, Td, Empty, input, btnSecondary, fmt,
} from "./_adminUi";

interface WhCol { id: number; name: string }
interface PivotRow {
  itemId: number;
  itemName: string;
  itemCode: string | null;
  qtyByWh: Record<number, number>;
  total: number;
}

export default function WarehouseStockReport() {
  const [raw, setRaw] = useState<StockOnHand[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [hideZero, setHideZero] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      setRaw(await listStockOnHand(null));
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  // Warehouse columns (only those that actually have stock rows), sorted by name.
  const warehouses = useMemo<WhCol[]>(() => {
    const m = new Map<number, string>();
    for (const r of raw) if (!m.has(r.warehouse_id)) m.set(r.warehouse_id, r.warehouse_name);
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }, [raw]);

  const rows = useMemo<PivotRow[]>(() => {
    const m = new Map<number, PivotRow>();
    for (const r of raw) {
      let p = m.get(r.item_id);
      if (!p) {
        p = { itemId: r.item_id, itemName: r.item_name, itemCode: r.item_code, qtyByWh: {}, total: 0 };
        m.set(r.item_id, p);
      }
      p.qtyByWh[r.warehouse_id] = (p.qtyByWh[r.warehouse_id] ?? 0) + r.qty;
      p.total += r.qty;
    }
    let list = [...m.values()];
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) => p.itemName.toLowerCase().includes(q) || (p.itemCode ?? "").toLowerCase().includes(q),
      );
    }
    if (hideZero) list = list.filter((p) => Math.abs(p.total) > 1e-9);
    return list.sort((a, b) => a.itemName.localeCompare(b.itemName, "ar"));
  }, [raw, search, hideZero]);

  // Per-warehouse + grand totals for the footer row.
  const totals = useMemo(() => {
    const byWh: Record<number, number> = {};
    let grand = 0;
    for (const p of rows) {
      for (const w of warehouses) byWh[w.id] = (byWh[w.id] ?? 0) + (p.qtyByWh[w.id] ?? 0);
      grand += p.total;
    }
    return { byWh, grand };
  }, [rows, warehouses]);

  return (
    <Page title="الكميات المتاحة حسب المخزن">
      <Card>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
          <input
            style={{ ...input, maxWidth: 280 }}
            placeholder="بحث بالاسم أو الكود…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
            إخفاء الأصناف ذات الرصيد صفر
          </label>
          <button style={btnSecondary} onClick={() => void refresh()} disabled={loading}>
            {loading ? "جارٍ التحديث…" : "تحديث"}
          </button>
        </div>

        {rows.length === 0 ? (
          <Empty text="لا توجد بيانات مخزون." />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <Table>
              <thead>
                <tr>
                  <Th>الصنف</Th>
                  <Th>الكود</Th>
                  {warehouses.map((w) => (
                    <Th key={w.id} style={{ textAlign: "center" }}>{w.name}</Th>
                  ))}
                  <Th style={{ textAlign: "center" }}>الإجمالي</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.itemId}>
                    <Td>{p.itemName}</Td>
                    <Td>{p.itemCode ?? "—"}</Td>
                    {warehouses.map((w) => {
                      const q = p.qtyByWh[w.id] ?? 0;
                      return (
                        <Td key={w.id} style={{ textAlign: "center", color: q ? undefined : "#94a3b8" }}>
                          {q ? fmt(q) : "—"}
                        </Td>
                      );
                    })}
                    <Td style={{ textAlign: "center", fontWeight: 700 }}>{fmt(p.total)}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td>الإجمالي</Td>
                  <Td>—</Td>
                  {warehouses.map((w) => (
                    <Td key={w.id} style={{ textAlign: "center" }}>{fmt(totals.byWh[w.id] ?? 0)}</Td>
                  ))}
                  <Td style={{ textAlign: "center" }}>{fmt(totals.grand)}</Td>
                </tr>
              </tfoot>
            </Table>
          </div>
        )}
      </Card>
    </Page>
  );
}
