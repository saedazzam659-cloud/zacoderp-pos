import { useEffect, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listStockTransfers, createStockTransfer, listWarehouses,
  type TransferSummary, type TransferLineInput, type Warehouse,
} from "../lib/inventory";
import { listItems } from "../lib/items";
import type { LocalItem } from "../lib/items";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
} from "./_adminUi";
import { uiText, useUiLanguage } from "../lib/appSettings";

export default function StockTransfersAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<TransferSummary[]>([]);
  const [showForm, setShowForm] = useState(false);

  async function refresh() { setRows(await listStockTransfers()); }
  useEffect(() => { void refresh(); }, []);
  useDataRefresh(["stock", "journal"], () => { void refresh(); });

  return (
    <Page
      title={text("التحويل بين المخازن", "Warehouse transfers")}
      subtitle={`${rows.length} ${text("تحويل", "transfers")}`}
      right={
        <button onClick={() => setShowForm(true)} disabled={showForm}
          style={{ ...btnPrimary, opacity: showForm ? 0.5 : 1, cursor: showForm ? "not-allowed" : "pointer" }}>
          + {text("تحويل جديد", "New transfer")}
        </button>
      }
    >
      {showForm && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ padding: 16 }}>
            <TransferForm onCancel={() => setShowForm(false)} onDone={() => { setShowForm(false); void refresh(); }} />
          </div>
        </Card>
      )}
      <Card>
        {rows.length === 0 && !showForm ? <Empty text={text("لا توجد تحويلات بعد", "No transfers yet")} /> : (
          <Table>
            <thead><tr>
              <Th>{text("الرقم", "Number")}</Th><Th>{text("التاريخ", "Date")}</Th>
              <Th>{text("من مخزن", "From warehouse")}</Th><Th>{text("إلى مخزن", "To warehouse")}</Th>
              <Th>{text("عدد البنود", "Lines")}</Th><Th>{text("إجمالي الكمية", "Total quantity")}</Th>
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
    </Page>
  );
}

type LineRow = TransferLineInput & { _key: number };

function TransferForm({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
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
    if (fromId === "" || toId === "") { setErr(text("اختر مخزن المصدر والوجهة", "Choose source and destination warehouses.")); return; }
    if (fromId === toId) { setErr(text("لا يمكن التحويل لنفس المخزن", "Source and destination warehouses must differ.")); return; }
    const valid = lines.filter((l) => l.item_id > 0 && l.qty > 0);
    if (valid.length === 0) { setErr(text("أضف بنداً واحداً على الأقل بكمية > 0", "Add at least one line with a quantity greater than zero.")); return; }
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
      } catch (e: any) { setErr(e?.message ?? text("فشل الحفظ", "Could not save transfer.")); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{text("تحويل بين المخازن", "Warehouse transfer")}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <Field label={text("التاريخ", "Date")}><input type="date" value={trDate} onChange={(e) => setTrDate(e.target.value)} style={input} /></Field>
        <Field label={text("من مخزن", "From warehouse")}>
          <SearchCombobox
            value={fromId}
            onChange={(v) => setFromId(v === "" ? "" : Number(v))}
            style={input}
            options={[
              { value: "", label: text("— اختر —", "— Select —") },
              ...warehouses.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />
        </Field>
        <Field label={text("إلى مخزن", "To warehouse")}>
          <SearchCombobox
            value={toId}
            onChange={(v) => setToId(v === "" ? "" : Number(v))}
            style={input}
            options={[
              { value: "", label: text("— اختر —", "— Select —") },
              ...warehouses.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />
        </Field>
      </div>
      <Field label={text("ملاحظات", "Notes")}><input value={notes} onChange={(e) => setNotes(e.target.value)} style={input} /></Field>

      <div style={{ marginTop: 12, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>{text("البنود", "Lines")}</strong>
        <button onClick={addLine} style={btnSecondary} type="button">+ {text("إضافة بند", "Add line")}</button>
      </div>

      <Table>
        <thead><tr>
          <Th>{text("الصنف", "Item")}</Th><Th style={{ width: 140 }}>{text("الكمية", "Quantity")}</Th>
          <Th style={{ width: 140 }}>{text("تكلفة الوحدة", "Unit cost")}</Th><Th style={{ width: 80 }}></Th>
        </tr></thead>
        <tbody>
          {lines.length === 0 ? (
            <tr><Td colSpan={4}><div style={{ padding: 16, textAlign: "center", color: "#94a3b8" }}>{text("لا توجد بنود", "No lines")}</div></Td></tr>
          ) : lines.map((l) => (
            <tr key={l._key}>
              <Td>
                <SearchCombobox
                  value={l.item_id}
                  onChange={(v) => updateLine(l._key, { item_id: Number(v) })}
                  style={input}
                  options={[
                    { value: 0, label: text("— اختر صنف —", "— Select an item —") },
                    ...items.map((i) => ({ value: i.id, label: i.nameAr })),
                  ]}
                />
              </Td>
              <Td><input type="number" step="0.001" min={0} value={l.qty} onChange={(e) => updateLine(l._key, { qty: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" min={0} value={l.unit_cost} onChange={(e) => updateLine(l._key, { unit_cost: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><button onClick={() => removeLine(l._key)} style={btnLink} type="button">{text("حذف", "Remove")}</button></Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div style={{ marginTop: 8, padding: 8, background: "#f8fafc", borderRadius: 6, fontSize: 12, color: "#64748b" }}>
        ℹ️ {text("التحويل لا يولّد قيداً محاسبياً (نفس الكيان). يسجّل حركتين في دفتر الأستاذ: صادر من المصدر، وارد للوجهة.", "A transfer within the same company creates no journal entry. It records an outgoing movement at the source and an incoming movement at the destination.")}
      </div>

      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary} type="button">{text("إلغاء", "Cancel")}</button>
        <button onClick={save} disabled={busy} style={btnPrimary} type="button">{busy ? "..." : text("حفظ وترحيل", "Save and post")}</button>
      </Actions>
    </div>
  );
}
