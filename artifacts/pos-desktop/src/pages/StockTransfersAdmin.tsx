import { useEffect, useState } from "react";
import {
  listStockTransfers, createStockTransfer, listWarehouses,
  type TransferSummary, type TransferLineInput, type Warehouse,
} from "../lib/inventory";
import { listItems } from "../lib/items";
import type { LocalItem } from "../lib/items";
import {
  Page, Card, Table, Th, Td, Modal, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
} from "./_adminUi";

export default function StockTransfersAdmin() {
  const [rows, setRows] = useState<TransferSummary[]>([]);
  const [showForm, setShowForm] = useState(false);

  async function refresh() { setRows(await listStockTransfers()); }
  useEffect(() => { void refresh(); }, []);

  return (
    <Page
      title="التحويل بين المخازن"
      subtitle={`${rows.length} تحويل`}
      right={<button onClick={() => setShowForm(true)} style={btnPrimary}>+ تحويل جديد</button>}
    >
      <Card>
        {rows.length === 0 ? <Empty text="لا توجد تحويلات بعد" /> : (
          <Table>
            <thead><tr>
              <Th>الرقم</Th><Th>التاريخ</Th>
              <Th>من مخزن</Th><Th>إلى مخزن</Th>
              <Th>عدد البنود</Th><Th>إجمالي الكمية</Th>
            </tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <Td mono>{t.transfer_no}</Td>
                  <Td mono>{t.transfer_date}</Td>
                  <Td>{t.from_warehouse_name}</Td>
                  <Td>{t.to_warehouse_name}</Td>
                  <Td num>{t.lines_count}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmt(t.total_qty)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {showForm && <TransferForm onCancel={() => setShowForm(false)} onDone={() => { setShowForm(false); void refresh(); }} />}
    </Page>
  );
}

type LineRow = TransferLineInput & { _key: number };

function TransferForm({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<LocalItem[]>([]);
  const [trDate, setTrDate] = useState<string>(todayStr());
  const [fromId, setFromId] = useState<number | "">("");
  const [toId, setToId] = useState<number | "">("");
  const [notes, setNotes] = useState<string>("");
  const [lines, setLines] = useState<LineRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const ws = await listWarehouses();
      setWarehouses(ws);
      const def = ws.find((w) => w.is_default) ?? ws[0];
      if (def) setFromId(def.id);
      setItems(await listItems());
    })();
  }, []);

  function addLine() { setLines((p) => [...p, { _key: Date.now() + Math.random(), item_id: 0, qty: 0, unit_cost: 0 }]); }
  function updateLine(k: number, patch: Partial<LineRow>) { setLines((p) => p.map((l) => l._key === k ? { ...l, ...patch } : l)); }
  function removeLine(k: number) { setLines((p) => p.filter((l) => l._key !== k)); }

  async function save() {
    if (fromId === "" || toId === "") { setErr("اختر مخزن المصدر والوجهة"); return; }
    if (fromId === toId) { setErr("لا يمكن التحويل لنفس المخزن"); return; }
    const valid = lines.filter((l) => l.item_id > 0 && l.qty > 0);
    if (valid.length === 0) { setErr("أضف بنداً واحداً على الأقل بكمية > 0"); return; }
    setBusy(true); setErr(null);
    try {
      await createStockTransfer({
        transfer_date: trDate,
        from_warehouse_id: fromId,
        to_warehouse_id: toId,
        notes: notes || null,
        lines: valid.map(({ item_id, qty, unit_cost }) => ({ item_id, qty, unit_cost })),
      });
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="تحويل بين المخازن" onCancel={onCancel} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <Field label="التاريخ"><input type="date" value={trDate} onChange={(e) => setTrDate(e.target.value)} style={input} /></Field>
        <Field label="من مخزن">
          <SearchCombobox
            value={fromId}
            onChange={(v) => setFromId(v === "" ? "" : Number(v))}
            style={input}
            options={[
              { value: "", label: "— اختر —" },
              ...warehouses.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />
        </Field>
        <Field label="إلى مخزن">
          <SearchCombobox
            value={toId}
            onChange={(v) => setToId(v === "" ? "" : Number(v))}
            style={input}
            options={[
              { value: "", label: "— اختر —" },
              ...warehouses.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />
        </Field>
      </div>
      <Field label="ملاحظات"><input value={notes} onChange={(e) => setNotes(e.target.value)} style={input} /></Field>

      <div style={{ marginTop: 12, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>البنود</strong>
        <button onClick={addLine} style={btnSecondary} type="button">+ إضافة بند</button>
      </div>

      <Table>
        <thead><tr>
          <Th>الصنف</Th><Th style={{ width: 140 }}>الكمية</Th>
          <Th style={{ width: 140 }}>تكلفة الوحدة</Th><Th style={{ width: 80 }}></Th>
        </tr></thead>
        <tbody>
          {lines.length === 0 ? (
            <tr><Td colSpan={4}><div style={{ padding: 16, textAlign: "center", color: "#94a3b8" }}>لا توجد بنود</div></Td></tr>
          ) : lines.map((l) => (
            <tr key={l._key}>
              <Td>
                <SearchCombobox
                  value={l.item_id}
                  onChange={(v) => updateLine(l._key, { item_id: Number(v) })}
                  style={input}
                  options={[
                    { value: 0, label: "— اختر صنف —" },
                    ...items.map((i) => ({ value: i.id, label: i.nameAr })),
                  ]}
                />
              </Td>
              <Td><input type="number" step="0.001" min={0} value={l.qty} onChange={(e) => updateLine(l._key, { qty: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" min={0} value={l.unit_cost} onChange={(e) => updateLine(l._key, { unit_cost: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><button onClick={() => removeLine(l._key)} style={btnLink} type="button">حذف</button></Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div style={{ marginTop: 8, padding: 8, background: "#f8fafc", borderRadius: 6, fontSize: 12, color: "#64748b" }}>
        ℹ️ التحويل لا يولّد قيداً محاسبياً (نفس الكيان). يسجّل حركتين في دفتر الأستاذ: صادر من المصدر، وارد للوجهة.
      </div>

      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary} type="button">إلغاء</button>
        <button onClick={save} disabled={busy} style={btnPrimary} type="button">{busy ? "..." : "حفظ وترحيل"}</button>
      </Actions>
    </Modal>
  );
}
