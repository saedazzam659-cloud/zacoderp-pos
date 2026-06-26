import { useEffect, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listStocktakes, createStocktake, postStocktake,
  listWarehouses, listStockOnHand,
  type StocktakeSummary, type StocktakeLineInput, type Warehouse,
} from "../lib/inventory";
import { listItems } from "../lib/items";
import type { LocalItem } from "../lib/items";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
  useRowSelect, SelectTh, SelectCell, ActionBar, ActionBtn,
} from "./_adminUi";

export default function StocktakesAdmin() {
  const [rows, setRows] = useState<StocktakeSummary[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [posting, setPosting] = useState<number | null>(null);
  const sel = useRowSelect(rows);

  async function refresh() { setRows(await listStocktakes()); }
  useEffect(() => { void refresh(); }, []);
  useDataRefresh(["stock", "journal"], () => { void refresh(); });

  async function post(s: StocktakeSummary) {
    if (!confirm(`ترحيل الجرد ${s.stocktake_no}؟ سيتم إنشاء تسوية بالفروقات.`)) return;
    setPosting(s.id);
    try { await postStocktake(s.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الترحيل"); }
    finally { setPosting(null); }
  }

  return (
    <Page
      title="جرد المخازن"
      subtitle={`${rows.length} جرد`}
      right={
        <button onClick={() => setShowForm(true)} disabled={showForm}
          style={{ ...btnPrimary, opacity: showForm ? 0.5 : 1, cursor: showForm ? "not-allowed" : "pointer" }}>
          + جرد جديد
        </button>
      }
    >
      {showForm && (
        <Card style={{ marginBottom: 12, border: "2px solid #2563eb" }}>
          <div style={{ padding: 16 }}>
            <StocktakeForm onCancel={() => setShowForm(false)} onDone={() => { setShowForm(false); void refresh(); }} />
          </div>
        </Card>
      )}
      {rows.length > 0 && !showForm && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.stocktake_no : null}>
          <ActionBtn label="ترحيل" icon="✔" tone="success"
            disabled={!sel.selected || posting === sel.selectedId || showForm || sel.selected.status !== "draft"}
            onClick={() => { const s = sel.selected; if (s) void post(s); }} />
        </ActionBar>
      )}
      <Card>
        {rows.length === 0 && !showForm ? <Empty text="لا توجد عمليات جرد بعد" /> : (
          <Table>
            <thead><tr>
              <SelectTh />
              <Th>الرقم</Th><Th>التاريخ</Th><Th>المخزن</Th>
              <Th>عدد الأصناف</Th><Th>الحالة</Th>
              <Th>التسوية</Th>
            </tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <SelectCell id={s.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                  <Td mono>{s.stocktake_no}</Td>
                  <Td mono>{s.stocktake_date}</Td>
                  <Td>{s.warehouse_name}</Td>
                  <Td num>{s.lines_count}</Td>
                  <Td>
                    {s.status === "draft"
                      ? <span style={{ color: "#d97706", fontWeight: 600 }}>مسودة</span>
                      : <span style={{ color: "#16a34a", fontWeight: 600 }}>مرحّل</span>}
                  </Td>
                  <Td mono>{s.adjustment_id ? `ADJ #${s.adjustment_id}` : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

type LineRow = StocktakeLineInput & { _key: number; system_qty: number; nameAr: string };

function StocktakeForm({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<LocalItem[]>([]);
  const [date, setDate] = useState<string>(todayStr());
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [notes, setNotes] = useState<string>("");
  const [lines, setLines] = useState<LineRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const ws = await listWarehouses();
      setWarehouses(ws);
      const def = ws.find((w) => w.is_default) ?? ws[0];
      if (def) setWarehouseId(def.id);
      setItems(await listItems());
    })();
  }, []);

  async function loadAllItemsFromWarehouse() {
    if (warehouseId === "") { setErr("اختر المخزن أولاً"); return; }
    const onHand = await listStockOnHand(warehouseId);
    const byItem = new Map<number, { qty: number; last_cost: number }>();
    for (const r of onHand) byItem.set(r.item_id, { qty: r.qty, last_cost: r.last_cost });
    const rows: LineRow[] = items.map((it, idx) => {
      const oh = byItem.get(it.id);
      return {
        _key: Date.now() + idx,
        item_id: it.id,
        nameAr: it.nameAr,
        system_qty: oh?.qty ?? 0,
        counted_qty: oh?.qty ?? 0,
        unit_cost: oh?.last_cost ?? 0,
      };
    });
    setLines(rows);
  }

  function updateLine(k: number, patch: Partial<LineRow>) {
    setLines((p) => p.map((l) => l._key === k ? { ...l, ...patch } : l));
  }
  function removeLine(k: number) {
    setLines((p) => p.filter((l) => l._key !== k));
  }

  async function save() {
    if (warehouseId === "") { setErr("اختر المخزن"); return; }
    if (lines.length === 0) { setErr("اضغط 'تحميل أصناف المخزن' أو أضف بنوداً"); return; }
    setBusy(true); setErr(null);
    try {
      await createStocktake({
        stocktake_date: date,
        warehouse_id: warehouseId,
        notes: notes || null,
        lines: lines.map(({ item_id, counted_qty, unit_cost }) => ({ item_id, counted_qty, unit_cost })),
      });
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>جرد مخزن جديد</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: 10 }}>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="المخزن">
          <SearchCombobox
            value={warehouseId}
            onChange={(v) => setWarehouseId(v === "" ? "" : Number(v))}
            style={input}
            options={[
              { value: "", label: "— اختر —" },
              ...warehouses.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />
        </Field>
        <Field label="ملاحظات"><input value={notes} onChange={(e) => setNotes(e.target.value)} style={input} /></Field>
      </div>

      <div style={{ marginTop: 12, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>بنود الجرد ({lines.length})</strong>
        <button onClick={() => void loadAllItemsFromWarehouse()} style={btnSecondary} type="button">⬇ تحميل أصناف المخزن</button>
      </div>

      <div style={{ maxHeight: "45vh", overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 6 }}>
        <Table>
          <thead style={{ position: "sticky", top: 0, background: "#f8fafc" }}><tr>
            <Th>الصنف</Th>
            <Th style={{ width: 120 }}>كمية النظام</Th>
            <Th style={{ width: 120 }}>الكمية الفعلية</Th>
            <Th style={{ width: 120 }}>الفرق</Th>
            <Th style={{ width: 120 }}>تكلفة الوحدة</Th>
            <Th style={{ width: 60 }}></Th>
          </tr></thead>
          <tbody>
            {lines.length === 0 ? (
              <tr><Td colSpan={6}><div style={{ padding: 16, textAlign: "center", color: "#94a3b8" }}>اضغط "تحميل أصناف المخزن" لجلب أرصدة النظام</div></Td></tr>
            ) : lines.map((l) => {
              const diff = l.counted_qty - l.system_qty;
              return (
                <tr key={l._key}>
                  <Td>{l.nameAr}</Td>
                  <Td num style={{ color: "#64748b" }}>{fmt(l.system_qty)}</Td>
                  <Td><input type="number" step="0.001" min={0} value={l.counted_qty} onChange={(e) => updateLine(l._key, { counted_qty: Number(e.target.value) || 0 })} style={input} /></Td>
                  <Td num style={{ color: diff > 0 ? "#16a34a" : diff < 0 ? "#dc2626" : "#94a3b8", fontWeight: 600 }}>{diff === 0 ? "—" : (diff > 0 ? "+" : "") + fmt(diff)}</Td>
                  <Td><input type="number" step="0.01" min={0} value={l.unit_cost} onChange={(e) => updateLine(l._key, { unit_cost: Number(e.target.value) || 0 })} style={input} /></Td>
                  <Td><button onClick={() => removeLine(l._key)} style={btnLink} type="button">×</button></Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>

      <div style={{ marginTop: 8, padding: 8, background: "#f8fafc", borderRadius: 6, fontSize: 12, color: "#64748b" }}>
        ℹ️ يُحفظ الجرد كمسودة. اضغط "ترحيل" من القائمة لإنشاء التسوية والقيد المحاسبي.
      </div>

      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary} type="button">إلغاء</button>
        <button onClick={save} disabled={busy} style={btnPrimary} type="button">{busy ? "..." : "حفظ كمسودة"}</button>
      </Actions>
    </div>
  );
}
