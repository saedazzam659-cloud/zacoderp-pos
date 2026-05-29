import React, { useEffect, useState } from "react";
import {
  listSalesInvoices, getSalesInvoice, createSalesInvoice, listCashBoxes, listBanks,
  type SalesInvoice, type SalesLine, type PaymentMethod, type CashBox, type Bank,
} from "../lib/accounting";
import { listCustomers, type LocalCustomer } from "../lib/customers";
import { listItems, type LocalItem } from "../lib/items";
import { listWarehouses, type Warehouse } from "../lib/inventory";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty, Pagination, pageSlice,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
} from "./_adminUi";

export default function SalesInvoicesAdmin() {
  const [rows, setRows] = useState<SalesInvoice[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<SalesInvoice | null>(null);
  const [creating, setCreating] = useState(false);
  const [deps, setDeps] = useState<{ customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[] } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  async function refresh() { setRows(await listSalesInvoices(5000)); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [customers, cashBoxes, banks, items, warehouses] = await Promise.all([listCustomers(), listCashBoxes(), listBanks(), listItems(), listWarehouses()]);
      setDeps({ customers, cashBoxes, banks, items, warehouses });
    })();
  }, []);

  const { start, end, page: clampedPage } = pageSlice(rows.length, page, pageSize);
  const pageRows = rows.slice(start, end);
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getSalesInvoice(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  return (
    <Page
      title="فواتير المبيعات"
      subtitle={`${rows.length} فاتورة — يتم ترحيل قيد المبيعات وتكلفة البضاعة المباعة تلقائياً عند الحفظ`}
      right={
        <button onClick={() => setCreating(true)} disabled={!deps || creating}
          style={{ ...btnPrimary, opacity: (!deps || creating) ? 0.5 : 1, cursor: (!deps || creating) ? "not-allowed" : "pointer" }}>
          + فاتورة مبيعات
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
        {rows.length === 0 && !creating ? <Empty text="لا توجد فواتير مبيعات" /> : (
          <Table>
            <thead><tr>
              <Th>رقم الفاتورة</Th><Th>التاريخ</Th><Th>العميل</Th><Th>طريقة الدفع</Th>
              <Th style={{ textAlign: "left" }}>المجموع</Th><Th style={{ textAlign: "left" }}>الضريبة</Th>
              <Th style={{ textAlign: "left" }}>الإجمالي</Th><Th style={{ width: 100 }}></Th>
            </tr></thead>
            <tbody>
              {pageRows.map((p) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <Td mono>{p.invoiceNo}</Td>
                    <Td>{p.invoiceDate}</Td>
                    <Td>{p.customerName ?? "نقدي/بدون عميل"}</Td>
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
                          <SalesDetail p={expandedDetail} />
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

function PayBadge({ m }: { m: PaymentMethod }) {
  const map = { credit: { l: "آجل", c: "#9a3412" }, cash: { l: "نقدي", c: "#15803d" }, bank: { l: "بنك", c: "#1e40af" } } as const;
  const x = map[m];
  return <span style={{ background: x.c + "20", color: x.c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{x.l}</span>;
}

function SalesDetail({ p }: { p: SalesInvoice }) {
  return (
    <div style={{ padding: 12 }}>
      <Table>
        <thead><tr><Th>الصنف</Th><Th style={{ textAlign: "left" }}>الكمية</Th><Th style={{ textAlign: "left" }}>سعر الوحدة</Th><Th style={{ textAlign: "left" }}>الضريبة %</Th><Th style={{ textAlign: "left" }}>الإجمالي</Th></tr></thead>
        <tbody>
          {p.lines.map((l, i) => (
            <tr key={l.id ?? i}>
              <Td>{l.itemName}</Td><Td num>{l.qty}</Td><Td num>{fmt(l.unitPrice)}</Td><Td num>{l.vatRate}</Td><Td num>{fmt(l.lineTotal)}</Td>
            </tr>
          ))}
          <tr style={{ background: "#fff", fontWeight: 700 }}>
            <Td colSpan={4 as any}>الإجمالي قبل الضريبة</Td><Td num>{fmt(p.subtotal)}</Td>
          </tr>
          <tr style={{ background: "#fff" }}><Td colSpan={4 as any}>ضريبة القيمة المضافة</Td><Td num>{fmt(p.vatTotal)}</Td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 800, fontSize: 16 }}><Td colSpan={4 as any}>الإجمالي النهائي</Td><Td num>{fmt(p.grandTotal)}</Td></tr>
          <tr style={{ background: "#fff", color: "#64748b" }}><Td colSpan={4 as any}>تكلفة البضاعة المباعة</Td><Td num>{fmt(p.cogsTotal)}</Td></tr>
        </tbody>
      </Table>
    </div>
  );
}

function CreateForm({ deps, onCancel, onDone }: {
  deps: { customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[] };
  onCancel: () => void; onDone: () => void;
}) {
  const [customerId, setCustomerId] = useState<number>(0);
  const [date, setDate] = useState(todayStr());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [cashBoxId, setCashBoxId] = useState<number | null>(deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(deps.banks[0]?.id ?? null);
  const [warehouseId, setWarehouseId] = useState<number>(
    (deps.warehouses.find((w) => w.is_default) ?? deps.warehouses[0])?.id ?? 0,
  );
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<SalesLine[]>([{ itemId: 0, qty: 1, unitPrice: 0, vatRate: 15, lineTotal: 0 }]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedCustomer = deps.customers.find((c) => c.id === customerId) ?? null;

  function setLine(i: number, patch: Partial<SalesLine>) {
    setLines((ls) => ls.map((l, k) => {
      if (k !== i) return l;
      const next = { ...l, ...patch };
      // Auto-fill sale price + vat from the chosen item.
      if (patch.itemId !== undefined) {
        const it = deps.items.find((x) => x.id === Number(patch.itemId));
        if (it) {
          if (!next.unitPrice) next.unitPrice = it.salePrice ?? 0;
          next.vatRate = it.vatRate ?? next.vatRate;
        }
      }
      const sub = (Number(next.qty) || 0) * (Number(next.unitPrice) || 0);
      next.lineTotal = sub + sub * (Number(next.vatRate) || 0) / 100;
      return next;
    }));
  }
  function addLine() { setLines((ls) => [...ls, { itemId: 0, qty: 1, unitPrice: 0, vatRate: 15, lineTotal: 0 }]); }
  function removeLine(i: number) { setLines((ls) => ls.filter((_, k) => k !== i)); }

  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const vatTotal = lines.reduce((s, l) => {
    const sub = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
    return s + sub * (Number(l.vatRate) || 0) / 100;
  }, 0);
  const grand = subtotal + vatTotal;

  async function save() {
    setBusy(true); setErr(null);
    try {
      const cleaned = lines.filter((l) => l.itemId && (l.qty || 0) > 0);
      if (cleaned.length === 0) throw new Error("أضف صنفاً واحداً على الأقل");
      if (paymentMethod === "credit" && !customerId) throw new Error("اختر العميل للبيع الآجل");
      await createSalesInvoice({
        customerId: customerId || null, invoiceDate: date, paymentMethod,
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
      <h3 style={{ marginTop: 0 }}>فاتورة مبيعات جديدة</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 200px 200px", gap: 10 }}>
        <Field label={paymentMethod === "credit" ? "العميل *" : "العميل (اختياري)"}>
          <SearchCombobox
            value={customerId}
            onChange={(v) => setCustomerId(Number(v))}
            style={input}
            options={[
              { value: 0, label: "— بدون عميل —" },
              ...deps.customers.map((c) => ({ value: c.id, label: c.nameAr })),
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
              { value: "cash", label: "نقدي" },
              { value: "bank", label: "بنك" },
              { value: "credit", label: "آجل (على الحساب)" },
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

      {selectedCustomer && paymentMethod === "credit" && (selectedCustomer.enforceCreditLimit || (selectedCustomer.creditLimit ?? 0) > 0) && (
        <div style={{ marginTop: 8, padding: "8px 12px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, fontSize: 13, color: "#92400e" }}>
          الرصيد الحالي: <b>{fmt(selectedCustomer.balance ?? 0)}</b>
          {(selectedCustomer.creditLimit ?? 0) > 0 && <> · حد الائتمان: <b>{fmt(selectedCustomer.creditLimit ?? 0)}</b></>}
          {(selectedCustomer.paymentTermsDays ?? 0) > 0 && <> · مدة الاستحقاق: <b>{selectedCustomer.paymentTermsDays} يوم</b></>}
          {selectedCustomer.enforceCreditLimit && <> · <b>المنع مُفعّل</b></>}
        </div>
      )}

      {paymentMethod === "cash" && (
        <Field label="الخزينة" style={{ marginTop: 10 }}>
          <SearchCombobox
            value={cashBoxId ?? ""}
            onChange={(v) => setCashBoxId(Number(v) || null)}
            style={input}
            options={deps.cashBoxes.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
      )}
      {paymentMethod === "bank" && (
        <Field label="البنك" style={{ marginTop: 10 }}>
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
              <Td><input type="number" step="0.001" value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) || 0 })} style={input} /></Td>
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
