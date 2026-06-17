// الأصناف بطيئة الحركة (Slow-Moving Items) — offline report.
//
// Reuses existing Rust commands only (stock_on_hand_list, stock_movements_list,
// list_items) — no new Rust. Balance + value come from on-hand; the last
// movement date per item is derived in TS from the movement ledger.
//
// NOTE on the 5000-row cap: stock_movements_list caps at the most-recent 5000
// rows. When the cap is hit we only KNOW the ledger back to the oldest sampled
// movement (the "coverage window"). For an item with no movement inside that
// window we can only conclude idle >= coverageDays:
//   • coverageDays >= threshold  → definitely slow (shown as "لم يتحرك")
//   • coverageDays <  threshold  → UNDETERMINED — we cannot prove it's slow, so
//     it is NOT listed as slow-moving; it is counted in a separate note instead.
// When the cap is NOT hit the whole ledger was sampled, so a missing item truly
// never moved and is genuinely slow.

import { useEffect, useMemo, useState } from "react";
import { listStockOnHand, listStockMovements, type StockOnHand, type StockMovement } from "../lib/inventory";
import { listItems, type LocalItem } from "../lib/items";
import { itemGroupName } from "../lib/itemGroups";
import { useCurrencySymbol } from "../lib/currency";
import {
  Page, Card, Table, Th, Td, Empty, input, btnSecondary, fmt, fmtCurrency,
} from "./_adminUi";

interface Row {
  id: number;
  code: string | null;
  name: string;
  groupName: string | null;
  qty: number;
  value: number;
  lastMove: string | null;
  daysIdle: number;
}

const NEVER = 9999;

export default function SlowMovingItems() {
  useCurrencySymbol(); // subscribe so currency formatting re-renders on country change
  const [items, setItems] = useState<LocalItem[]>([]);
  const [onHand, setOnHand] = useState<StockOnHand[]>([]);
  const [moves, setMoves] = useState<StockMovement[]>([]);
  const [days, setDays] = useState("90");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [it, oh, mv] = await Promise.all([
        listItems(),
        listStockOnHand(null),
        listStockMovements({ limit: 5000 }),
      ]);
      setItems(it);
      setOnHand(oh);
      setMoves(mv);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  // Aggregate on-hand qty + value per item (across all warehouses).
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

  // Latest movement date per item from the ledger window.
  const lastMoveByItem = useMemo(() => {
    const m = new Map<number, string>();
    for (const mv of moves) {
      const prev = m.get(mv.item_id);
      if (!prev || mv.entry_date > prev) m.set(mv.item_id, mv.entry_date);
    }
    return m;
  }, [moves]);

  const threshold = Number(days) || 90;
  const truncated = moves.length >= 5000;

  // Coverage lower-bound: when the ledger was truncated we only know history back
  // to the oldest sampled movement. Infinity = full ledger sampled (no cap hit).
  const coverageDays = useMemo(() => {
    if (!truncated || moves.length === 0) return Infinity;
    let oldest = moves[0].entry_date;
    for (const mv of moves) if (mv.entry_date < oldest) oldest = mv.entry_date;
    return Math.max(0, Math.floor((Date.now() - new Date(oldest).getTime()) / 86_400_000));
  }, [moves, truncated]);

  const { rows, undetermined } = useMemo(() => {
    const todayMs = Date.now();
    const q = search.trim().toLowerCase();
    const out: Row[] = [];
    let undet = 0;
    for (const it of items) {
      if (it.nature === "service") continue;
      const bal = balByItem.get(it.id) ?? { qty: 0, value: 0 };
      if (bal.qty <= 1e-9) continue;
      const lastMove = lastMoveByItem.get(it.id) ?? null;

      let daysIdle: number;
      if (lastMove) {
        daysIdle = Math.max(0, Math.floor((todayMs - new Date(lastMove).getTime()) / 86_400_000));
      } else if (coverageDays === Infinity) {
        // Full ledger sampled → item genuinely never moved.
        daysIdle = NEVER;
      } else if (coverageDays >= threshold) {
        // Truncated but coverage proves idle >= threshold → definitely slow.
        daysIdle = NEVER;
      } else {
        // Truncated and coverage too short to prove slowness → undetermined.
        undet += 1;
        continue;
      }

      if (daysIdle < threshold) continue;
      if (q && !it.nameAr.toLowerCase().includes(q) && !(it.code ?? "").toLowerCase().includes(q)) continue;
      out.push({
        id: it.id,
        code: it.code ?? null,
        name: it.nameAr,
        groupName: itemGroupName(it.groupId),
        qty: bal.qty,
        value: bal.value,
        lastMove,
        daysIdle,
      });
    }
    out.sort((a, b) => b.daysIdle - a.daysIdle);
    return { rows: out, undetermined: undet };
  }, [items, balByItem, lastMoveByItem, threshold, coverageDays, search]);

  const totalLocked = useMemo(() => rows.reduce((s, r) => s + r.value, 0), [rows]);

  function idleBadge(daysIdle: number) {
    const bg = daysIdle >= 365 ? "#fee2e2" : daysIdle >= 180 ? "#fef3c7" : "#fefce8";
    const fg = daysIdle >= 365 ? "#991b1b" : daysIdle >= 180 ? "#92400e" : "#854d0e";
    return (
      <span style={{ background: bg, color: fg, borderRadius: 999, padding: "2px 8px", fontWeight: 700, fontSize: 12 }}>
        {daysIdle === NEVER ? "لم يتحرك" : `${fmt(daysIdle)} يوم`}
      </span>
    );
  }

  return (
    <Page
      title="الأصناف بطيئة الحركة"
      subtitle={`${rows.length} صنف · القيمة المجمّدة ${fmtCurrency(totalLocked)} · حد الركود ${threshold} يوم`}
    >
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 10, alignItems: "end" }}>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>أقل عدد أيام ركود</div>
            <input
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              style={{ ...input, width: 140 }}
              placeholder="90"
            />
          </label>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>بحث (اسم / كود)</div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={input}
              placeholder="ابحث باسم الصنف أو الكود"
            />
          </label>
          <button onClick={() => void refresh()} disabled={loading} style={btnSecondary}>{loading ? "..." : "تحديث"}</button>
        </div>
      </Card>

      {truncated && (
        <Card style={{ padding: 12, marginBottom: 12, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 13 }}>
          ⚠️ سجل الحركات كبير (أكثر من 5000 حركة) — التغطية المؤكدة تعود لآخر {Number.isFinite(coverageDays) ? `${fmt(coverageDays as number)} يوم` : "—"} فقط.
          الأصناف بلا حركة داخل هذه النافذة تُعرض كـ «لم يتحرك» (بطيئة الحركة مؤكدة) فقط عندما تتجاوز التغطية حدّ الركود.
          {undetermined > 0 && ` يوجد ${fmt(undetermined)} صنف لا يمكن الجزم ببطء حركته لأن التغطية أقصر من الحدّ المحدد — لم يُدرَج في القائمة.`}
        </Card>
      )}

      <Card>
        {rows.length === 0 ? <Empty text="لا توجد أصناف بطيئة الحركة ضمن هذا الحد" /> : (
          <Table>
            <thead><tr>
              <Th>الكود</Th><Th>الصنف</Th><Th>المجموعة</Th>
              <Th>الرصيد</Th><Th>القيمة</Th><Th>آخر حركة</Th><Th>أيام الركود</Th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td mono>{r.code ?? ""}</Td>
                  <Td>{r.name}</Td>
                  <Td>{r.groupName ?? "—"}</Td>
                  <Td num>{fmt(r.qty)}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmtCurrency(r.value)}</Td>
                  <Td>{r.lastMove ?? "—"}</Td>
                  <Td>{idleBadge(r.daysIdle)}</Td>
                </tr>
              ))}
              <tr style={{ background: "#f1f5f9" }}>
                <Td style={{ fontWeight: 700 }}>الإجمالي</Td>
                <Td>—</Td>
                <Td>—</Td>
                <Td>—</Td>
                <Td num style={{ fontWeight: 700 }}>{fmtCurrency(totalLocked)}</Td>
                <Td>—</Td>
                <Td>—</Td>
              </tr>
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
