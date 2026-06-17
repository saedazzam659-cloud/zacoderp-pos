// التنبيهات الذكية (Smart Alerts) — offline TS-only report.
//
// Two alert classes, reusing existing Rust commands only:
//   • نقص المخزون: on-hand ≤ reorderPoint (reorder tracked in LS overlay,
//     lib/stock.ts — same source as the low-stock report).
//   • أصناف راكدة: on-hand > 0 but no movement in the last N days
//     (idleDays param), derived from the stock-movement ledger (cf.
//     SlowMovingItems coverage-window reasoning).

import { useEffect, useMemo, useState } from "react";
import {
  listStockOnHand, listStockMovements,
  type StockOnHand, type StockMovement,
} from "../lib/inventory";
import { listItems, type LocalItem } from "../lib/items";
import { getAllStockShared, type StockMap } from "../lib/stock";
import { useCurrencySymbol } from "../lib/currency";
import {
  Page, Card, Table, Th, Td, Empty, input, btnSecondary, fmt, fmtCurrency,
} from "./_adminUi";

interface LowRow { id: number; code: string | null; name: string; qty: number; reorderPoint: number; shortfall: number; }
interface IdleRow { id: number; code: string | null; name: string; qty: number; value: number; daysIdle: number; }

const NEVER = 9999;

export default function SmartAlertsAdmin() {
  useCurrencySymbol();
  const [items, setItems] = useState<LocalItem[]>([]);
  const [onHand, setOnHand] = useState<StockOnHand[]>([]);
  const [moves, setMoves] = useState<StockMovement[]>([]);
  const [stockMap, setStockMap] = useState<StockMap>({});
  const [idleDays, setIdleDays] = useState("60");
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [it, oh, mv, sm] = await Promise.all([
        listItems(),
        listStockOnHand(null),
        listStockMovements({ limit: 5000 }),
        getAllStockShared(),
      ]);
      setItems(it);
      setOnHand(oh);
      setMoves(mv);
      setStockMap(sm);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  const itemById = useMemo(() => {
    const m = new Map<number, LocalItem>();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);

  // Aggregate on-hand qty + value per item across warehouses.
  const balByItem = useMemo(() => {
    const m = new Map<number, { qty: number; value: number }>();
    for (const r of onHand) {
      const cur = m.get(r.item_id) ?? { qty: 0, value: 0 };
      cur.qty += r.qty;
      cur.value += r.qty * r.last_cost;
      m.set(r.item_id, cur);
    }
    return m;
  }, [onHand]);

  // Low-stock alerts from the reorder overlay (qty + reorderPoint both LS).
  const lowRows = useMemo<LowRow[]>(() => {
    const out: LowRow[] = [];
    for (const it of items) {
      const s = stockMap[it.id];
      if (!s || s.reorderPoint <= 0) continue;
      if (s.qty > s.reorderPoint) continue;
      out.push({
        id: it.id, code: it.code ?? null, name: it.nameAr,
        qty: s.qty, reorderPoint: s.reorderPoint,
        shortfall: Math.max(0, s.reorderPoint - s.qty),
      });
    }
    out.sort((a, b) => b.shortfall - a.shortfall);
    return out;
  }, [items, stockMap]);

  const lastMoveByItem = useMemo(() => {
    const m = new Map<number, string>();
    for (const mv of moves) {
      const prev = m.get(mv.item_id);
      if (!prev || mv.entry_date > prev) m.set(mv.item_id, mv.entry_date);
    }
    return m;
  }, [moves]);

  const threshold = Number(idleDays) || 60;
  const truncated = moves.length >= 5000;
  const coverageDays = useMemo(() => {
    if (!truncated || moves.length === 0) return Infinity;
    let oldest = moves[0].entry_date;
    for (const mv of moves) if (mv.entry_date < oldest) oldest = mv.entry_date;
    return Math.max(0, Math.floor((Date.now() - new Date(oldest).getTime()) / 86_400_000));
  }, [moves, truncated]);

  const idleRows = useMemo<IdleRow[]>(() => {
    const todayMs = Date.now();
    const out: IdleRow[] = [];
    for (const [itemId, bal] of balByItem.entries()) {
      if (bal.qty <= 1e-9) continue;
      const it = itemById.get(itemId);
      if (!it || it.nature === "service") continue;
      const lastMove = lastMoveByItem.get(itemId) ?? null;
      let daysIdle: number;
      if (lastMove) {
        daysIdle = Math.max(0, Math.floor((todayMs - new Date(lastMove).getTime()) / 86_400_000));
      } else if (coverageDays === Infinity || coverageDays >= threshold) {
        daysIdle = NEVER;
      } else {
        continue; // undetermined under truncated coverage
      }
      if (daysIdle < threshold) continue;
      out.push({
        id: itemId, code: it.code ?? null, name: it.nameAr,
        qty: bal.qty, value: bal.value, daysIdle,
      });
    }
    out.sort((a, b) => b.daysIdle - a.daysIdle);
    return out;
  }, [balByItem, itemById, lastMoveByItem, threshold, coverageDays]);

  return (
    <Page
      title="التنبيهات الذكية"
      subtitle={`${lowRows.length} تنبيه نقص · ${idleRows.length} صنف راكد`}
      right={<button onClick={() => void refresh()} disabled={loading} style={btnSecondary}>{loading ? "..." : "تحديث"}</button>}
    >
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <label>
          <div style={{ fontSize: 12, marginBottom: 4 }}>حد الركود (أيام بدون حركة)</div>
          <input type="number" min={1} value={idleDays} onChange={(e) => setIdleDays(e.target.value)} style={{ ...input, width: 160 }} placeholder="60" />
        </label>
      </Card>

      <Card style={{ marginBottom: 12 }}>
        <div style={{ padding: "12px 16px", fontWeight: 700, borderBottom: "1px solid #e2e8f0", color: "#d97706" }}>
          ⚠️ نقص المخزون ({fmt(lowRows.length)})
        </div>
        {lowRows.length === 0 ? <Empty text="لا توجد أصناف تحت حد الطلب" /> : (
          <Table>
            <thead><tr>
              <Th>الكود</Th><Th>الصنف</Th>
              <Th style={{ textAlign: "left" }}>الرصيد</Th>
              <Th style={{ textAlign: "left" }}>حد الطلب</Th>
              <Th style={{ textAlign: "left" }}>العجز</Th>
            </tr></thead>
            <tbody>
              {lowRows.map((r) => (
                <tr key={r.id}>
                  <Td mono>{r.code ?? ""}</Td>
                  <Td>{r.name}</Td>
                  <Td num style={{ color: r.qty <= 0 ? "#dc2626" : "#0f172a", fontWeight: 600 }}>{fmt(r.qty)}</Td>
                  <Td num>{fmt(r.reorderPoint)}</Td>
                  <Td num style={{ fontWeight: 600, color: "#d97706" }}>{fmt(r.shortfall)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <div style={{ padding: "12px 16px", fontWeight: 700, borderBottom: "1px solid #e2e8f0", color: "#7c3aed" }}>
          🐌 أصناف راكدة ({fmt(idleRows.length)})
        </div>
        {truncated && (
          <div style={{ padding: 12, background: "#fffbeb", borderBottom: "1px solid #fde68a", color: "#92400e", fontSize: 13 }}>
            ⚠️ سجل الحركات كبير (أكثر من 5000 حركة) — الأصناف التي لا يمكن الجزم بركودها ضمن التغطية غير مدرجة.
          </div>
        )}
        {idleRows.length === 0 ? <Empty text="لا توجد أصناف راكدة ضمن هذا الحد" /> : (
          <Table>
            <thead><tr>
              <Th>الكود</Th><Th>الصنف</Th>
              <Th style={{ textAlign: "left" }}>الرصيد</Th>
              <Th style={{ textAlign: "left" }}>القيمة</Th>
              <Th style={{ textAlign: "left" }}>أيام الركود</Th>
            </tr></thead>
            <tbody>
              {idleRows.map((r) => (
                <tr key={r.id}>
                  <Td mono>{r.code ?? ""}</Td>
                  <Td>{r.name}</Td>
                  <Td num>{fmt(r.qty)}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmtCurrency(r.value)}</Td>
                  <Td num>{r.daysIdle === NEVER ? "لم يتحرك" : `${fmt(r.daysIdle)} يوم`}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
