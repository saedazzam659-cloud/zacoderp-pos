import { useEffect, useState } from "react";
import {
  listPurchaseReturns, getPurchaseReturn, createPurchaseReturn, listSuppliers,
  type PurchaseReturn, type PurchaseLine, type Supplier,
} from "../lib/accounting";
import { listItems, type LocalItem } from "../lib/items";
import {
  Page, Card, Table, Th, Td, Modal, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
} from "./_adminUi";

export default function PurchaseReturnsAdmin() {
  const [rows, setRows] = useState<PurchaseReturn[]>([]);
  const [view, setView] = useState<PurchaseReturn | null>(null);
  const [creating, setCreating] = useState(false);
  const [deps, setDeps] = useState<{ suppliers: Supplier[]; items: LocalItem[] } | null>(null);

  async function refresh() { setRows(await listPurchaseReturns()); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [suppliers, items] = await Promise.all([listSuppliers(), listItems()]);
      setDeps({ suppliers, items });
    })();
  }, []);

  async function openView(id: number) { setView(await getPurchaseReturn(id)); }

  return (
    <Page
      title="مرتجع الشراء"
      subtitle={`${rows.length} مرتجع`}
      right={<button onClick={() => setCreating(true)} style={btnPrimary} disabled={!deps}>+ مرتجع شراء</button>}
    >
      <Card>
        {rows.length === 0 ? <Empty text="لا توجد مرتجعات" /> : (
          <Table>
            <thead><tr>
              <Th>رقم المرتجع</Th><Th>التاريخ</Th><Th>المورد</Th>
              <Th style={{ textAlign: "left" }}>المجموع</Th><Th style={{ textAlign: "left" }}>الضريبة</Th>
              <Th style={{ textAlign: "left" }}>الإجمالي</Th><Th style={{ width: 100 }}></Th>
            </tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <Td mono>{p.returnNo}</Td><Td>{p.returnDate}</Td><Td>{p.supplierName}</Td>
                  <Td num>{fmt(p.subtotal)}</Td><Td num>{fmt(p.vatTotal)}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                  <Td><button onClick={() => void openView(p.id)} style={btnLink}>عرض</button></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {view && (
        <Modal title={`مرتجع ${view.returnNo}`} onCancel={() => setView(null)} wide>
          <div style={{ marginBottom: 12, color: "#64748b" }}>{view.returnDate} — {view.supplierName}</div>
          <Table>
            <thead><tr><Th>الصنف</Th><Th style={{ textAlign: "left" }}>الكمية</Th><Th style={{ textAlign: "left" }}>سعر الوحدة</Th><Th style={{ textAlign: "left" }}>الإجمالي</Th></tr></thead>
            <tbody>
              {view.lines.map((l, i) => (
                <tr key={l.id ?? i}><Td>{l.itemName}</Td><Td num>{l.qty}</Td><Td num>{fmt(l.unitCost)}</Td><Td num>{fmt(l.lineTotal)}</Td></tr>
              ))}
              <tr style={{ background: "#f1f5f9", fontWeight: 700 }}><Td colSpan={3 as any}>الإجمالي</Td><Td num>{fmt(view.grandTotal)}</Td></tr>
            </tbody>
          </Table>
          <Actions><button onClick={() => setView(null)} style={btnSecondary}>إغلاق</button></Actions>
        </Modal>
      )}
      {creating && deps && <CreateForm deps={deps} onCancel={() => setCreating(false)} onDone={() => { setCreating(false); void refresh(); }} />}
    </Page>
  );
}

function CreateForm({ deps, onCancel, onDone }: { deps: { suppliers: Supplier[]; items: LocalItem[] }; onCancel: () => void; onDone: () => void }) {
  const [supplierId, setSupplierId] = useState<number>(deps.suppliers[0]?.id ?? 0);
  const [date, setDate] = useState(todayStr());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<PurchaseLine[]>([{ itemId: 0, qty: 1, unitCost: 0, vatRate: 15, lineTotal: 0 }]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function setLine(i: number, patch: Partial<PurchaseLine>) {
    setLines((ls) => ls.map((l, k) => {
      if (k !== i) return l;
      const next = { ...l, ...patch };
      const sub = (Number(next.qty) || 0) * (Number(next.unitCost) || 0);
      next.lineTotal = sub + sub * (Number(next.vatRate) || 0) / 100;
      return next;
    }));
  }
  function addLine() { setLines((ls) => [...ls, { itemId: 0, qty: 1, unitCost: 0, vatRate: 15, lineTotal: 0 }]); }
  function removeLine(i: number) { setLines((ls) => ls.filter((_, k) => k !== i)); }

  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
  const vatTotal = lines.reduce((s, l) => {
    const sub = (Number(l.qty) || 0) * (Number(l.unitCost) || 0);
    return s + sub * (Number(l.vatRate) || 0) / 100;
  }, 0);
  const grand = subtotal + vatTotal;

  async function save() {
    setBusy(true); setErr(null);
    try {
      const cleaned = lines.filter((l) => l.itemId && (l.qty || 0) > 0);
      if (!supplierId) throw new Error("اختر المورد");
      if (cleaned.length === 0) throw new Error("أضف صنفاً واحداً على الأقل");
      await createPurchaseReturn({ supplierId, purchaseId: null, returnDate: date, notes: notes || null, lines: cleaned });
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="مرتجع شراء جديد" onCancel={onCancel} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 200px", gap: 10 }}>
        <Field label="المورد *">
          <SearchCombobox
            value={supplierId}
            onChange={(v) => setSupplierId(Number(v))}
            style={input}
            options={[
              { value: 0, label: "— اختر —" },
              ...deps.suppliers.map((s) => ({ value: s.id, label: s.nameAr })),
            ]}
          />
        </Field>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
      </div>
      <Table>
        <thead><tr>
          <Th>الصنف</Th><Th style={{ width: 90 }}>الكمية</Th><Th style={{ width: 120 }}>سعر الوحدة</Th><Th style={{ width: 80 }}>ض. %</Th>
          <Th style={{ width: 120, textAlign: "left" }}>الإجمالي</Th><Th style={{ width: 40 }}></Th>
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>
                <SearchCombobox
                  value={l.itemId}
                  onChange={(v) => setLine(i, { itemId: Number(v) })}
                  style={input}
                  options={[
                    { value: 0, label: "— اختر —" },
                    ...deps.items.map((it) => ({ value: it.id, label: it.nameAr })),
                  ]}
                />
              </Td>
              <Td><input type="number" step="0.001" value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td num>{fmt(l.lineTotal)}</Td>
              <Td><button onClick={() => removeLine(i)} style={{ ...btnLink, color: "#dc2626" }}>×</button></Td>
            </tr>
          ))}
          <tr style={{ background: "#f8fafc", fontWeight: 700 }}>
            <Td colSpan={4 as any}>قبل الضريبة</Td><Td num>{fmt(subtotal)}</Td><Td></Td>
          </tr>
          <tr style={{ background: "#f8fafc" }}><Td colSpan={4 as any}>الضريبة</Td><Td num>{fmt(vatTotal)}</Td><Td></Td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 800, fontSize: 15 }}><Td colSpan={4 as any}>الإجمالي</Td><Td num>{fmt(grand)}</Td><Td></Td></tr>
        </tbody>
      </Table>
      <button onClick={addLine} style={{ ...btnSecondary, marginTop: 8 }}>+ سطر</button>
      <Field label="ملاحظات" style={{ marginTop: 12 }}><textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} /></Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "..." : "حفظ وترحيل"}</button>
      </Actions>
    </Modal>
  );
}
