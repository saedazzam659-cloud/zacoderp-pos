import { useEffect, useMemo, useState } from "react";
import { listStockMovements, listWarehouses, type StockMovement, type Warehouse } from "../lib/inventory";
import { listItems } from "../lib/items";
import type { LocalItem } from "../lib/items";
import { useCurrencySymbol } from "../lib/currency";
import {
  Page, Card, Table, Th, Td, Empty, input, btnSecondary, fmt, fmtCurrency, todayStr, SearchCombobox,
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

interface KardexRow extends StockMovement {
  running: number;
}

export default function ItemCard() {
  useCurrencySymbol(); // subscribe so currency formatting re-renders on country change
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<LocalItem[]>([]);
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [itemId, setItemId] = useState<number | "">("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>(todayStr());
  const [allRows, setAllRows] = useState<StockMovement[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      setWarehouses(await listWarehouses());
      setItems(await listItems());
    })();
  }, []);

  async function refresh() {
    if (itemId === "") { setAllRows([]); return; }
    setLoading(true);
    try {
      // Fetch the FULL movement history for the item (no date filter) so the
      // opening balance and running balance are computed correctly in TS.
      setAllRows(await listStockMovements({
        warehouseId: warehouseId === "" ? null : warehouseId,
        itemId,
        dateFrom: null,
        dateTo: null,
        limit: 5000,
      }));
    } finally { setLoading(false); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [itemId, warehouseId]);

  // Ascending order + cumulative running balance computed client-side.
  const computed = useMemo<KardexRow[]>(() => {
    const asc = [...allRows].sort((a, b) =>
      a.entry_date === b.entry_date ? a.id - b.id : (a.entry_date < b.entry_date ? -1 : 1));
    let running = 0;
    return asc.map((r) => { running += r.qty_delta; return { ...r, running }; });
  }, [allRows]);

  const view = useMemo(() => {
    const from = dateFrom || null;
    const to = dateTo || null;
    let opening = 0;
    for (const r of computed) {
      if (from && r.entry_date < from) opening = r.running;
      else break;
    }
    const inRange = computed.filter((r) =>
      (!from || r.entry_date >= from) && (!to || r.entry_date <= to));
    let inQ = 0, outQ = 0;
    for (const r of inRange) { if (r.qty_delta > 0) inQ += r.qty_delta; else outQ += -r.qty_delta; }
    const closing = inRange.length ? inRange[inRange.length - 1].running : opening;
    // Cost basis for closing value must be as-of the period end (<= dateTo),
    // never a cost recorded after the selected range.
    const costRows = to ? computed.filter((r) => r.entry_date <= to) : computed;
    const lastCost = [...costRows].reverse().find((r) => r.unit_cost > 0)?.unit_cost ?? 0;
    return { opening, inRange, inQ, outQ, closing, closingValue: closing * lastCost };
  }, [computed, dateFrom, dateTo]);

  // The backend ledger reader caps at 5000 rows; beyond that, opening/running
  // balances would be silently wrong, so surface it explicitly instead.
  const truncated = allRows.length >= 5000;

  const selectedItem = items.find((i) => i.id === itemId);

  return (
    <Page
      title="كارت الصنف"
      subtitle={selectedItem
        ? `${selectedItem.nameAr} · افتتاحي ${fmt(view.opening)} · وارد ${fmt(view.inQ)} · صادر ${fmt(view.outQ)} · ختامي ${fmt(view.closing)}`
        : "اختر صنفًا لعرض حركته"}
    >
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr auto", gap: 10, alignItems: "end" }}>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>الصنف *</div>
            <SearchCombobox
              value={itemId}
              onChange={(v) => setItemId(v === "" ? "" : Number(v))}
              style={input}
              options={[
                { value: "", label: "— اختر الصنف —" },
                ...items.map((i) => ({ value: i.id, label: i.code ? `${i.code} · ${i.nameAr}` : i.nameAr })),
              ]}
            />
          </label>
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
      {truncated && (
        <Card style={{ padding: 12, marginBottom: 12, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 13 }}>
          ⚠️ هذا الصنف لديه أكثر من 5000 حركة — يتم عرض أحدث 5000 فقط، وقد تكون الأرصدة الافتتاحية/الجارية غير دقيقة. ضيّق نطاق المخزن أو التاريخ.
        </Card>
      )}
      <Card>
        {itemId === "" ? <Empty text="اختر صنفًا أولًا" /> : view.inRange.length === 0 && view.opening === 0 ? (
          <Empty text="لا توجد حركات لهذا الصنف" />
        ) : (
          <Table>
            <thead><tr>
              <Th>التاريخ</Th><Th>المرجع</Th><Th>المخزن</Th>
              <Th>وارد</Th><Th>صادر</Th><Th>الرصيد</Th><Th>التكلفة</Th>
            </tr></thead>
            <tbody>
              <tr style={{ background: "#f8fafc" }}>
                <Td mono>—</Td>
                <Td style={{ fontWeight: 600 }}>رصيد افتتاحي</Td>
                <Td>—</Td>
                <Td num></Td>
                <Td num></Td>
                <Td num style={{ fontWeight: 700 }}>{fmt(view.opening)}</Td>
                <Td num></Td>
              </tr>
              {view.inRange.map((r) => (
                <tr key={r.id}>
                  <Td mono>{r.entry_date}</Td>
                  <Td>{REF_LABEL[r.ref_type] ?? r.ref_type}{r.ref_id ? ` #${r.ref_id}` : ""}</Td>
                  <Td>{r.warehouse_name}</Td>
                  <Td num style={{ color: "#16a34a" }}>{r.qty_delta > 0 ? fmt(r.qty_delta) : ""}</Td>
                  <Td num style={{ color: "#dc2626" }}>{r.qty_delta < 0 ? fmt(-r.qty_delta) : ""}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmt(r.running)}</Td>
                  <Td num>{fmt(r.unit_cost)}</Td>
                </tr>
              ))}
              <tr style={{ background: "#f1f5f9" }}>
                <Td mono>—</Td>
                <Td style={{ fontWeight: 700 }}>رصيد ختامي</Td>
                <Td>—</Td>
                <Td num style={{ color: "#16a34a", fontWeight: 600 }}>{fmt(view.inQ)}</Td>
                <Td num style={{ color: "#dc2626", fontWeight: 600 }}>{fmt(view.outQ)}</Td>
                <Td num style={{ fontWeight: 700 }}>{fmt(view.closing)}</Td>
                <Td num style={{ fontWeight: 700 }}>{fmtCurrency(view.closingValue)}</Td>
              </tr>
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
