import { useEffect, useMemo, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import { listStockMovements, listWarehouses, type StockMovement, type Warehouse } from "../lib/inventory";
import { listItems } from "../lib/items";
import type { LocalItem } from "../lib/items";
import {
  Page, Card, Table, Th, Td, Empty, input, btnSecondary, fmt, todayStr, SearchCombobox,
} from "./_adminUi";
import { uiText, useUiLanguage } from "../lib/appSettings";

const REF_LABEL: Record<string, [string, string]> = {
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

export default function StockMovementsReport() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
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
  useDataRefresh(["stock", "invoices", "journal"], () => { void refresh(); });

  const totals = useMemo(() => {
    let inQ = 0, outQ = 0;
    for (const r of rows) { if (r.qty_delta > 0) inQ += r.qty_delta; else outQ += -r.qty_delta; }
    return { inQ, outQ };
  }, [rows]);

  return (
    <Page
      title={text("حركة المخزون", "Stock movements")}
      subtitle={`${rows.length} ${text("حركة", "movements")} · ${text("داخل", "In")} ${fmt(totals.inQ)} · ${text("خارج", "Out")} ${fmt(totals.outQ)}`}
    >
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: 10, alignItems: "end" }}>
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
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>{text("الصنف", "Item")}</div>
            <SearchCombobox
              value={itemId}
              onChange={(v) => setItemId(v === "" ? "" : Number(v))}
              style={input}
              options={[
                { value: "", label: text("كل الأصناف", "All items") },
                ...items.map((i) => ({ value: i.id, label: i.nameAr })),
              ]}
            />
          </label>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>{text("من تاريخ", "From date")}</div>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={input} />
          </label>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>{text("إلى تاريخ", "To date")}</div>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={input} />
          </label>
          <button onClick={() => void refresh()} disabled={loading} style={btnSecondary}>{loading ? "..." : text("تحديث", "Refresh")}</button>
        </div>
      </Card>
      <Card>
        {rows.length === 0 ? <Empty text={text("لا توجد حركات", "No stock movements")} /> : (
          <Table>
            <thead><tr>
              <Th>{text("التاريخ", "Date")}</Th><Th>{text("المخزن", "Warehouse")}</Th><Th>{text("الصنف", "Item")}</Th>
              <Th>{text("المرجع", "Reference")}</Th><Th>{text("وارد", "In")}</Th><Th>{text("صادر", "Out")}</Th>
              <Th>{text("الرصيد بعد", "Balance after")}</Th><Th>{text("التكلفة", "Cost")}</Th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td mono>{r.entry_date}</Td>
                  <Td>{r.warehouse_name}</Td>
                  <Td>{r.item_name}</Td>
                  <Td>{REF_LABEL[r.ref_type] ? uiText(...REF_LABEL[r.ref_type], language) : r.ref_type}{r.ref_id ? ` #${r.ref_id}` : ""}</Td>
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
