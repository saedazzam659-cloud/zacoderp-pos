import { useEffect, useState } from "react";
import {
  listPurchases, getPurchase, createPurchase, listSuppliers, listCashBoxes, listBanks,
  type Purchase, type PurchaseLine, type PaymentMethod, type Supplier, type CashBox, type Bank,
} from "../lib/accounting";
import { listItems, type LocalItem } from "../lib/items";
import { listUom, type Uom } from "../lib/uom";
import { listWarehouses, type Warehouse } from "../lib/inventory";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty, Pagination, pageSlice,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
} from "./_adminUi";

export default function PurchasesAdmin() {
  const [rows, setRows] = useState<Purchase[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<Purchase | null>(null);
  const [creating, setCreating] = useState(false);
  const [deps, setDeps] = useState<{ suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[] } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  async function refresh() { setRows(await listPurchases(5000)); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [suppliers, cashBoxes, banks, items, warehouses] = await Promise.all([listSuppliers(), listCashBoxes(), listBanks(), listItems(), listWarehouses()]);
      setDeps({ suppliers, cashBoxes, banks, items, warehouses });
    })();
  }, []);

  const { start, end, page: clampedPage } = pageSlice(rows.length, page, pageSize);
  const pageRows = rows.slice(start, end);
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getPurchase(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  return (
    <Page
      title="فواتير الشراء"
      subtitle={`${rows.length} فاتورة — يتم ترحيل قيد المحاسبة تلقائياً عند الحفظ`}
      right={
        <button onClick={() => setCreating(true)} disabled={!deps || creating}
          style={{ ...btnPrimary, opacity: (!deps || creating) ? 0.5 : 1, cursor: (!deps || creating) ? "not-allowed" : "pointer" }}>
          + فاتورة شراء
        </button>
      }
    >
      {creating && deps && (
        <Card style={{ marginBottom: 12, border: "2px solid #2563eb" }}>
          <div style={{ padding: 16 }}>
            <CreateForm deps={deps} onCancel={() => setCreating(false)} onDone={() => { setCreating(false); void refresh(); }} />
          </div>
        </Card>
      )}
      <Card>
        {rows.length === 0 && !creating ? <Empty text="لا توجد فواتير شراء" /> : (
          <Table>
            <thead><tr>
              <Th>رقم الفاتورة</Th><Th>التاريخ</Th><Th>المورد</Th><Th>طريقة الدفع</Th>
              <Th style={{ textAlign: "left" }}>المجموع</Th><Th style={{ textAlign: "left" }}>الضريبة</Th>
              <Th style={{ textAlign: "left" }}>الإجمالي</Th><Th style={{ width: 100 }}></Th>
            </tr></thead>
            <tbody>
              {pageRows.map((p) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <Td mono>{p.invoiceNo}</Td>
                    <Td>{p.invoiceDate}</Td>
                    <Td>{p.supplierName}</Td>
                    <Td><PayBadge m={p.paymentMethod} /></Td>
                    <Td num>{fmt(p.subtotal)}</Td>
                    <Td num>{fmt(p.vatTotal)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                    <Td>
                      <button onClick={() => void toggleView(p.id)} disabled={creating} aria-expanded={expandedId === p.id}
                        style={{ ...btnLink, opacity: creating ? 0.5 : 1, cursor: creating ? "not-allowed" : "pointer" }}>
                        {expandedId === p.id ? "▲ إخفاء" : "▼ عرض"}
                      </button>
                    </Td>
                  </tr>
                  {expandedId === p.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={8 as any}>
                        {!expandedDetail ? <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>... جاري التحميل</div> : (
                          <PurchaseDetail p={expandedDetail} />
                        )}
                      </Td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </Table>
        )}
        {rows.length > 0 && (
          <Pagination total={rows.length} page={page} pageSize={pageSize}
            onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
        )}
      </Card>
    </Page>
  );
}

import React from "react";

function PayBadge({ m }: { m: PaymentMethod }) {
  const map = { credit: { l: "آجل", c: "#9a3412" }, cash: { l: "نقدي", c: "#15803d" }, bank: { l: "بنك", c: "#1e40af" } } as const;
  const x = map[m];
  return <span style={{ background: x.c + "20", color: x.c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{x.l}</span>;
}

function PurchaseDetail({ p }: { p: Purchase }) {
  return (
    <div style={{ padding: 12 }}>
      <Table>
        <thead><tr><Th>الصنف</Th><Th>الوحدة</Th><Th style={{ textAlign: "left" }}>الكمية</Th><Th style={{ textAlign: "left" }}>سعر الوحدة</Th><Th style={{ textAlign: "left" }}>الضريبة %</Th><Th style={{ textAlign: "left" }}>الإجمالي</Th></tr></thead>
        <tbody>
          {p.lines.map((l, i) => (
            <tr key={l.id ?? i}>
              <Td>{l.itemName}</Td><Td>{l.uomName ?? ""}</Td><Td num>{l.qty}</Td><Td num>{fmt(l.unitCost)}</Td><Td num>{l.vatRate}</Td><Td num>{fmt(l.lineTotal)}</Td>
            </tr>
          ))}
          <tr style={{ background: "#fff", fontWeight: 700 }}>
            <Td colSpan={5 as any}>الإجمالي قبل الضريبة</Td><Td num>{fmt(p.subtotal)}</Td>
          </tr>
          <tr style={{ background: "#fff" }}><Td colSpan={5 as any}>ضريبة القيمة المضافة</Td><Td num>{fmt(p.vatTotal)}</Td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 800, fontSize: 16 }}><Td colSpan={5 as any}>الإجمالي النهائي</Td><Td num>{fmt(p.grandTotal)}</Td></tr>
        </tbody>
      </Table>
    </div>
  );
}

function CreateForm({ deps, onCancel, onDone }: {
  deps: { suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[] };
  onCancel: () => void; onDone: () => void;
}) {
  const [supplierId, setSupplierId] = useState<number>(deps.suppliers[0]?.id ?? 0);
  const [date, setDate] = useState(todayStr());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("credit");
  const [cashBoxId, setCashBoxId] = useState<number | null>(deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(deps.banks[0]?.id ?? null);
  const [warehouseId, setWarehouseId] = useState<number>(
    (deps.warehouses.find((w) => w.is_default) ?? deps.warehouses[0])?.id ?? 0,
  );
  const [notes, setNotes] = useState("");
  const [uoms] = useState<Uom[]>(() => listUom());
  const defUom = uoms.find((u) => u.isDefault) ?? uoms[0];
  const blankLine = (): PurchaseLine => ({
    itemId: 0, qty: 1, unitCost: 0, vatRate: 15, lineTotal: 0,
    uomId: defUom?.id ?? null, uomName: defUom?.nameAr ?? null, conversionFactor: defUom?.baseQty ?? 1,
  });
  const [lines, setLines] = useState<PurchaseLine[]>(() => [blankLine()]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function setLine(i: number, patch: Partial<PurchaseLine>) {
    setLines((ls) => ls.map((l, k) => {
      if (k !== i) return l;
      const next = { ...l, ...patch };
      // Default the line's unit from the chosen item.
      if (patch.itemId !== undefined) {
        const it = deps.items.find((x) => x.id === Number(patch.itemId));
        if (it && it.uomId != null) {
          const u = uoms.find((x) => x.id === it.uomId);
          if (u) { next.uomId = u.id; next.uomName = u.nameAr; next.conversionFactor = u.baseQty; }
        }
      }
      // Unit change: cost stays per SELECTED unit; factor only affects stock.
      if (patch.uomId !== undefined) {
        const u = uoms.find((x) => x.id === Number(patch.uomId));
        if (u) { next.uomName = u.nameAr; next.conversionFactor = u.baseQty; }
      }
      const sub = (Number(next.qty) || 0) * (Number(next.unitCost) || 0);
      next.lineTotal = sub + sub * (Number(next.vatRate) || 0) / 100;
      return next;
    }));
  }
  function addLine() { setLines((ls) => [...ls, blankLine()]); }
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
        warehouseId: warehouseId || null,
        notes: notes || null, lines: cleaned,
      });
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>فاتورة شراء جديدة</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 200px 200px", gap: 10 }}>
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
        <Field label="طريقة الدفع">
          <SearchCombobox
            value={paymentMethod}
            onChange={(v) => setPaymentMethod(v as PaymentMethod)}
            style={input}
            options={[
              { value: "credit", label: "آجل (على الحساب)" },
              { value: "cash", label: "نقدي" },
              { value: "bank", label: "بنك" },
            ]}
          />
        </Field>
      </div>
      <Field label="المستودع" style={{ maxWidth: 420 }}>
        <SearchCombobox
          value={warehouseId}
          onChange={(v) => setWarehouseId(Number(v))}
          style={input}
          options={[
            { value: 0, label: "— المستودع الافتراضي —" },
            ...deps.warehouses.map((w) => ({ value: w.id, label: w.name })),
          ]}
        />
      </Field>
      {paymentMethod === "cash" && (
        <Field label="الخزينة">
          <SearchCombobox
            value={cashBoxId ?? ""}
            onChange={(v) => setCashBoxId(Number(v) || null)}
            style={input}
            options={deps.cashBoxes.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
      )}
      {paymentMethod === "bank" && (
        <Field label="البنك">
          <SearchCombobox
            value={bankId ?? ""}
            onChange={(v) => setBankId(Number(v) || null)}
            style={input}
            options={deps.banks.map((b) => ({ value: b.id, label: b.name }))}
          />
        </Field>
      )}

      <Table>
        <thead><tr>
          <Th>الصنف</Th>
          <Th style={{ width: 130 }}>الوحدة</Th>
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
              <Td>
                <SearchCombobox
                  value={l.uomId ?? 0}
                  onChange={(v) => setLine(i, { uomId: Number(v) })}
                  style={input}
                  options={uoms.map((u) => ({ value: u.id, label: u.baseQty !== 1 ? `${u.nameAr} (×${u.baseQty})` : u.nameAr }))}
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
            <Td colSpan={5 as any}>الإجمالي قبل الضريبة</Td><Td num>{fmt(subtotal)}</Td><Td></Td>
          </tr>
          <tr style={{ background: "#f8fafc" }}><Td colSpan={5 as any}>الضريبة</Td><Td num>{fmt(vatTotal)}</Td><Td></Td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 800, fontSize: 15 }}><Td colSpan={5 as any}>الإجمالي</Td><Td num>{fmt(grand)}</Td><Td></Td></tr>
        </tbody>
      </Table>
      <button onClick={addLine} type="button" style={{ ...btnSecondary, marginTop: 8 }}>+ سطر</button>

      <Field label="ملاحظات" style={{ marginTop: 12 }}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} />
      </Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : "حفظ وترحيل"}</button>
      </Actions>
    </div>
  );
}
