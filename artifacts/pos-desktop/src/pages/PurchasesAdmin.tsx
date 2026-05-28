import { useEffect, useState } from "react";
import {
  listPurchases, getPurchase, createPurchase, listSuppliers, listCashBoxes, listBanks,
  type Purchase, type PurchaseLine, type PaymentMethod, type Supplier, type CashBox, type Bank,
} from "../lib/accounting";
import { listItems, type LocalItem } from "../lib/items";
import {
  Page, Card, Table, Th, Td, Modal, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr,
} from "./_adminUi";

export default function PurchasesAdmin() {
  const [rows, setRows] = useState<Purchase[]>([]);
  const [view, setView] = useState<Purchase | null>(null);
  const [creating, setCreating] = useState(false);
  // Pre-load form deps once.
  const [deps, setDeps] = useState<{ suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[] } | null>(null);

  async function refresh() { setRows(await listPurchases()); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [suppliers, cashBoxes, banks, items] = await Promise.all([listSuppliers(), listCashBoxes(), listBanks(), listItems()]);
      setDeps({ suppliers, cashBoxes, banks, items });
    })();
  }, []);

  async function openView(id: number) { setView(await getPurchase(id)); }

  return (
    <Page
      title="فواتير الشراء"
      subtitle={`${rows.length} فاتورة — يتم ترحيل قيد المحاسبة تلقائياً عند الحفظ`}
      right={<button onClick={() => setCreating(true)} style={btnPrimary} disabled={!deps}>+ فاتورة شراء</button>}
    >
      <Card>
        {rows.length === 0 ? <Empty text="لا توجد فواتير شراء" /> : (
          <Table>
            <thead><tr>
              <Th>رقم الفاتورة</Th><Th>التاريخ</Th><Th>المورد</Th><Th>طريقة الدفع</Th>
              <Th style={{ textAlign: "left" }}>المجموع</Th><Th style={{ textAlign: "left" }}>الضريبة</Th>
              <Th style={{ textAlign: "left" }}>الإجمالي</Th><Th style={{ width: 100 }}></Th>
            </tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <Td mono>{p.invoiceNo}</Td>
                  <Td>{p.invoiceDate}</Td>
                  <Td>{p.supplierName}</Td>
                  <Td><PayBadge m={p.paymentMethod} /></Td>
                  <Td num>{fmt(p.subtotal)}</Td>
                  <Td num>{fmt(p.vatTotal)}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                  <Td><button onClick={() => void openView(p.id)} style={btnLink}>عرض</button></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {view && <ViewModal p={view} onClose={() => setView(null)} />}
      {creating && deps && <CreateForm deps={deps} onCancel={() => setCreating(false)} onDone={() => { setCreating(false); void refresh(); }} />}
    </Page>
  );
}

function PayBadge({ m }: { m: PaymentMethod }) {
  const map = { credit: { l: "آجل", c: "#9a3412" }, cash: { l: "نقدي", c: "#15803d" }, bank: { l: "بنك", c: "#1e40af" } } as const;
  const x = map[m];
  return <span style={{ background: x.c + "20", color: x.c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{x.l}</span>;
}

function ViewModal({ p, onClose }: { p: Purchase; onClose: () => void }) {
  return (
    <Modal title={`فاتورة شراء ${p.invoiceNo}`} onCancel={onClose} wide>
      <div style={{ marginBottom: 12, color: "#64748b" }}>{p.invoiceDate} — {p.supplierName}</div>
      <Table>
        <thead><tr><Th>الصنف</Th><Th style={{ textAlign: "left" }}>الكمية</Th><Th style={{ textAlign: "left" }}>سعر الوحدة</Th><Th style={{ textAlign: "left" }}>الضريبة %</Th><Th style={{ textAlign: "left" }}>الإجمالي</Th></tr></thead>
        <tbody>
          {p.lines.map((l, i) => (
            <tr key={l.id ?? i}>
              <Td>{l.itemName}</Td><Td num>{l.qty}</Td><Td num>{fmt(l.unitCost)}</Td><Td num>{l.vatRate}</Td><Td num>{fmt(l.lineTotal)}</Td>
            </tr>
          ))}
          <tr style={{ background: "#f8fafc", fontWeight: 700 }}>
            <Td colSpan={4 as any}>الإجمالي قبل الضريبة</Td><Td num>{fmt(p.subtotal)}</Td>
          </tr>
          <tr style={{ background: "#f8fafc" }}><Td colSpan={4 as any}>ضريبة القيمة المضافة</Td><Td num>{fmt(p.vatTotal)}</Td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 800, fontSize: 16 }}><Td colSpan={4 as any}>الإجمالي النهائي</Td><Td num>{fmt(p.grandTotal)}</Td></tr>
        </tbody>
      </Table>
      <Actions><button onClick={onClose} style={btnSecondary}>إغلاق</button></Actions>
    </Modal>
  );
}

function CreateForm({ deps, onCancel, onDone }: {
  deps: { suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[] };
  onCancel: () => void; onDone: () => void;
}) {
  const [supplierId, setSupplierId] = useState<number>(deps.suppliers[0]?.id ?? 0);
  const [date, setDate] = useState(todayStr());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("credit");
  const [cashBoxId, setCashBoxId] = useState<number | null>(deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(deps.banks[0]?.id ?? null);
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
      await createPurchase({
        supplierId, invoiceDate: date, paymentMethod,
        cashBoxId: paymentMethod === "cash" ? cashBoxId : null,
        bankId:    paymentMethod === "bank" ? bankId : null,
        notes: notes || null, lines: cleaned,
      });
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="فاتورة شراء جديدة" onCancel={onCancel} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 200px 200px", gap: 10 }}>
        <Field label="المورد *">
          <select value={supplierId} onChange={(e) => setSupplierId(Number(e.target.value))} style={input}>
            <option value={0}>— اختر —</option>
            {deps.suppliers.map((s) => <option key={s.id} value={s.id}>{s.nameAr}</option>)}
          </select>
        </Field>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="طريقة الدفع">
          <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)} style={input}>
            <option value="credit">آجل (على الحساب)</option>
            <option value="cash">نقدي</option>
            <option value="bank">بنك</option>
          </select>
        </Field>
      </div>
      {paymentMethod === "cash" && (
        <Field label="الخزينة">
          <select value={cashBoxId ?? ""} onChange={(e) => setCashBoxId(Number(e.target.value) || null)} style={input}>
            {deps.cashBoxes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      )}
      {paymentMethod === "bank" && (
        <Field label="البنك">
          <select value={bankId ?? ""} onChange={(e) => setBankId(Number(e.target.value) || null)} style={input}>
            {deps.banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
      )}

      <Table>
        <thead><tr>
          <Th>الصنف</Th>
          <Th style={{ width: 90 }}>الكمية</Th>
          <Th style={{ width: 120 }}>سعر الوحدة</Th>
          <Th style={{ width: 80 }}>ض. %</Th>
          <Th style={{ width: 120, textAlign: "left" }}>الإجمالي</Th>
          <Th style={{ width: 40 }}></Th>
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>
                <select value={l.itemId} onChange={(e) => setLine(i, { itemId: Number(e.target.value) })} style={input}>
                  <option value={0}>— اختر —</option>
                  {deps.items.map((it) => <option key={it.id} value={it.id}>{it.nameAr}</option>)}
                </select>
              </Td>
              <Td><input type="number" step="0.001" value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td num>{fmt(l.lineTotal)}</Td>
              <Td><button onClick={() => removeLine(i)} style={{ ...btnLink, color: "#dc2626" }}>×</button></Td>
            </tr>
          ))}
          <tr style={{ background: "#f8fafc", fontWeight: 700 }}>
            <Td colSpan={4 as any}>الإجمالي قبل الضريبة</Td><Td num>{fmt(subtotal)}</Td><Td></Td>
          </tr>
          <tr style={{ background: "#f8fafc" }}><Td colSpan={4 as any}>الضريبة</Td><Td num>{fmt(vatTotal)}</Td><Td></Td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 800, fontSize: 15 }}><Td colSpan={4 as any}>الإجمالي</Td><Td num>{fmt(grand)}</Td><Td></Td></tr>
        </tbody>
      </Table>
      <button onClick={addLine} style={{ ...btnSecondary, marginTop: 8 }}>+ سطر</button>

      <Field label="ملاحظات" style={{ marginTop: 12 }}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} />
      </Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "..." : "حفظ وترحيل"}</button>
      </Actions>
    </Modal>
  );
}
