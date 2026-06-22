import React, { useEffect, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listGoodsDeliveries, getGoodsDelivery, createGoodsDelivery, postGoodsDelivery,
  deleteGoodsDelivery,
  type GoodsDelivery, type GoodsDeliveryStatus, type DeliveryLine,
} from "../lib/accounting";
import { listCustomers, type LocalCustomer } from "../lib/customers";
import { listItems, type LocalItem } from "../lib/items";
import { listUom, type Uom } from "../lib/uom";
import { listWarehouses, type Warehouse } from "../lib/inventory";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty, Pagination, pageSlice,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
  LineDiscountCell, InvoiceTotals, ValidationPanel, collectDocIssues,
  useRowSelect, SelectTh, SelectCell, ActionBar, ActionBtn,
} from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { useInvoiceTaxes } from "./_invoiceTax";
import {
  computeDiscount, lineNet,
  type DiscType, type DiscFields,
} from "../lib/discount";

type FLine = DeliveryLine & DiscFields;

const STATUS_META: Record<GoodsDeliveryStatus, { l: string; c: string }> = {
  draft: { l: "مسودة", c: "#475569" },
  posted: { l: "مُرحّل (صرف مخزون)", c: "#1e40af" },
};

export default function GoodsDeliveriesAdmin() {
  const [rows, setRows] = useState<GoodsDelivery[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<GoodsDelivery | null>(null);
  const [creating, setCreating] = useState(false);
  const [deps, setDeps] = useState<{ customers: LocalCustomer[]; items: LocalItem[]; warehouses: Warehouse[] } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  async function refresh() { setRows(await listGoodsDeliveries(5000)); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [customers, items, warehouses] = await Promise.all([listCustomers(), listItems(), listWarehouses()]);
      setDeps({ customers, items, warehouses });
    })();
  }, []);

  const { start, end, page: clampedPage } = pageSlice(rows.length, page, pageSize);
  const pageRows = rows.slice(start, end);
  const sel = useRowSelect(rows);
  useDataRefresh(["invoices"], refresh);
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getGoodsDelivery(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  async function post(id: number) {
    if (!confirm("ترحيل إذن الصرف؟ سيتم صرف البضاعة من المخزون وترحيل قيد التكلفة.")) return;
    try { await postGoodsDelivery(id); await refresh(); if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); } }
    catch (e: any) { alert(e?.message ?? "فشل الترحيل"); }
  }

  async function remove(id: number) {
    if (!confirm("حذف إذن الصرف؟ إن كان مُرحّلاً سيتم عكس حركة المخزون والقيد.")) return;
    try {
      await deleteGoodsDelivery(id);
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
    } catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  return (
    <Page
      title="أذونات صرف البضاعة"
      subtitle={`${rows.length} إذن — الترحيل يصرف المخزون عبر حساب وسيط بسعر التكلفة المتحرك`}
      right={
        <button onClick={() => setCreating(true)} disabled={!deps || creating}
          style={{ ...btnPrimary, opacity: (!deps || creating) ? 0.5 : 1, cursor: (!deps || creating) ? "not-allowed" : "pointer" }}>
          + إذن صرف
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
      {rows.length > 0 && !creating && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.deliveryNo : null}>
          <ActionBtn label={expandedId === sel.selectedId ? "إخفاء" : "عرض"} icon="▼" disabled={!sel.selected || creating}
            onClick={() => { if (sel.selectedId != null) void toggleView(sel.selectedId); }} />
          {(() => {
            const s = sel.selected;
            return (
              <>
                <ActionBtn label="ترحيل" icon="✔" tone="success" disabled={!s || creating || s.status !== "draft"} onClick={() => { if (s) void post(s.id); }} />
                <ActionBtn label="حذف" icon="🗑" tone="danger" disabled={!s || creating} onClick={() => { if (s) void remove(s.id); }} />
              </>
            );
          })()}
        </ActionBar>
      )}
      <Card>
        {rows.length === 0 && !creating ? <Empty text="لا توجد أذونات صرف" /> : (
          <Table>
            <thead><tr>
              <SelectTh />
              <Th>رقم الإذن</Th><Th>التاريخ</Th><Th>العميل</Th><Th>الحالة</Th>
              <Th style={{ textAlign: "left" }}>المجموع</Th><Th style={{ textAlign: "left" }}>الضريبة</Th>
              <Th style={{ textAlign: "left" }}>الإجمالي</Th>
            </tr></thead>
            <tbody>
              {pageRows.map((p) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <SelectCell id={p.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                    <Td mono>{p.deliveryNo}</Td>
                    <Td>{p.deliveryDate}</Td>
                    <Td>{p.customerName}</Td>
                    <Td><StatusBadge s={p.status} /></Td>
                    <Td num>{fmt(p.subtotal)}</Td>
                    <Td num>{fmt(p.vatTotal)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                  </tr>
                  {expandedId === p.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={8 as any}>
                        {!expandedDetail ? <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>... جاري التحميل</div> : (
                          <DeliveryDetail r={expandedDetail} />
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

function StatusBadge({ s }: { s: GoodsDeliveryStatus }) {
  const x = STATUS_META[s];
  return <span style={{ background: x.c + "20", color: x.c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{x.l}</span>;
}

function DeliveryDetail({ r }: { r: GoodsDelivery }) {
  return (
    <div style={{ padding: 12 }}>
      {r.notes && <div style={{ marginBottom: 10, fontSize: 13, color: "#475569" }}>ملاحظات: <b style={{ color: "#0f172a" }}>{r.notes}</b></div>}
      <Table>
        <thead><tr><Th>الصنف</Th><Th>الوحدة</Th><Th style={{ textAlign: "left" }}>الكمية</Th><Th style={{ textAlign: "left" }}>سعر الوحدة</Th><Th style={{ textAlign: "left" }}>التكلفة</Th><Th style={{ textAlign: "left" }}>الضريبة %</Th><Th style={{ textAlign: "left" }}>الإجمالي</Th></tr></thead>
        <tbody>
          {r.lines.map((l, i) => (
            <tr key={l.id ?? i}>
              <Td>{l.itemName}</Td><Td>{l.uomName ?? ""}</Td><Td num>{l.qty}</Td><Td num>{fmt(l.unitPrice)}</Td><Td num>{fmt(l.unitCost)}</Td><Td num>{l.vatRate}</Td><Td num>{fmt(l.lineTotal)}</Td>
            </tr>
          ))}
          <tr style={{ background: "#fff", fontWeight: 700 }}><Td colSpan={6 as any}>الإجمالي قبل الضريبة</Td><Td num>{fmt(r.subtotal)}</Td></tr>
          <tr style={{ background: "#fff" }}><Td colSpan={6 as any}>ضريبة القيمة المضافة</Td><Td num>{fmt(r.vatTotal)}</Td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 800, fontSize: 16 }}><Td colSpan={6 as any}>الإجمالي النهائي</Td><Td num>{fmt(r.grandTotal)}</Td></tr>
        </tbody>
      </Table>
    </div>
  );
}

function CreateForm({ deps, onCancel, onDone }: {
  deps: { customers: LocalCustomer[]; items: LocalItem[]; warehouses: Warehouse[] };
  onCancel: () => void; onDone: () => void;
}) {
  const [customerId, setCustomerId] = useState<number>(deps.customers[0]?.id ?? 0);
  const [date, setDate] = useState(todayStr());
  const [warehouseId, setWarehouseId] = useState<number>(
    (deps.warehouses.find((w) => w.is_default) ?? deps.warehouses[0])?.id ?? 0,
  );
  const { branches, costCenters } = useDimensions();
  const [branchId, setBranchId] = useState<number | "">("");
  useEffect(() => { if (branchId === "" && branches.length === 1) setBranchId(branches[0].id); }, [branches]); // eslint-disable-line react-hooks/exhaustive-deps
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [notes, setNotes] = useState("");
  const [uoms] = useState<Uom[]>(() => listUom());
  const defUom = uoms.find((u) => u.isDefault) ?? uoms[0];
  const blankLine = (): FLine => ({
    itemId: 0, qty: 1, unitPrice: 0, unitCost: 0, vatRate: 0, lineTotal: 0, disc: 0, discType: "percent",
    uomId: defUom?.id ?? null, uomName: defUom?.nameAr ?? null, conversionFactor: defUom?.baseQty ?? 1,
  });
  const [lines, setLines] = useState<FLine[]>(() => [blankLine()]);
  const [headerDisc, setHeaderDisc] = useState(0);
  const [headerDiscType, setHeaderDiscType] = useState<DiscType>("percent");
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { taxes, taxId, setTaxId, taxOptions, selectedRate } = useInvoiceTaxes("sales");

  function setLine(i: number, patch: Partial<FLine>) {
    setLines((ls) => ls.map((l, k) => {
      if (k !== i) return l;
      const next = { ...l, ...patch };
      if (patch.itemId !== undefined) {
        const it = deps.items.find((x) => x.id === Number(patch.itemId));
        // VAT comes ONLY from the picked item (0 if it has no registered rate).
        if (it) next.vatRate = it.vatRate ?? 0;
        if (it && it.uomId != null) {
          const u = uoms.find((x) => x.id === it.uomId);
          if (u) { next.uomId = u.id; next.uomName = u.nameAr; next.conversionFactor = u.baseQty; }
        }
      }
      if (patch.uomId !== undefined) {
        const u = uoms.find((x) => x.id === Number(patch.uomId));
        if (u) { next.uomName = u.nameAr; next.conversionFactor = u.baseQty; }
      }
      if (selectedRate != null) next.vatRate = selectedRate;
      const { net } = lineNet(next.qty, next.unitPrice, next.disc, next.discType);
      next.lineTotal = net + net * (Number(next.vatRate) || 0) / 100;
      return next;
    }));
  }
  function addLine() {
    setLines((ls) => {
      const nl = blankLine();
      if (selectedRate != null) nl.vatRate = selectedRate;
      return [...ls, nl];
    });
  }
  function removeLine(i: number) { setLines((ls) => ls.filter((_, k) => k !== i)); }
  function onSelectTax(v: string | number) {
    const id = v === "" ? "" : Number(v);
    setTaxId(id);
    const t = taxes.find((x) => x.id === id);
    if (!t) return;
    const rate = t.rateValue;
    setLines((ls) => ls.map((l) => {
      const { net } = lineNet(l.qty, l.unitPrice, l.disc, l.discType);
      return { ...l, vatRate: rate, lineTotal: net + net * rate / 100 };
    }));
  }

  const result = computeDiscount(
    lines.map((l) => ({ qty: l.qty, unit: l.unitPrice, vatRate: l.vatRate, disc: l.disc, discType: l.discType })),
    headerDisc, headerDiscType,
  );

  async function save() {
    setBusy(true); setErr(null); setIssues([]);
    try {
      const problems = collectDocIssues([
        { label: "العميل", ok: !!customerId },
        ...(branches.length ? [{ label: "الفرع", ok: branchId !== "" }] : []),
        { label: "المستودع", ok: !!warehouseId },
      ], lines.map((l) => ({ itemId: l.itemId, uomId: l.uomId ?? null, price: l.unitPrice, qty: l.qty })), "سعر البيع");
      if (problems.length) { setIssues(problems); setBusy(false); return; }
      const cleaned = lines.filter((l) => l.itemId && (l.qty || 0) > 0);
      const r = computeDiscount(
        cleaned.map((l) => ({ qty: l.qty, unit: l.unitPrice, vatRate: l.vatRate, disc: l.disc, discType: l.discType })),
        headerDisc, headerDiscType,
      );
      const payloadLines: DeliveryLine[] = cleaned.map((l, i) => {
        const net = r.netUnitPrices[i];
        return {
          itemId: l.itemId, itemName: l.itemName, qty: l.qty, unitPrice: net, unitCost: 0, vatRate: l.vatRate,
          lineTotal: l.qty * net * (1 + (Number(l.vatRate) || 0) / 100),
          uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
          warehouseId: warehouseId || null,
        };
      });
      await createGoodsDelivery({
        customerId, deliveryDate: date,
        warehouseId: warehouseId || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
        notes: notes || null, lines: payloadLines,
      });
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>إذن صرف بضاعة جديد</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px", alignItems: "start" }}>
        <Field label="العميل *">
          <SearchCombobox
            value={customerId}
            onChange={(v) => setCustomerId(Number(v))}
            style={input}
            options={[
              { value: 0, label: "— اختر —" },
              ...deps.customers.map((c) => ({ value: c.id, label: c.nameAr })),
            ]}
          />
        </Field>
        <Field label="تاريخ الصرف"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="المستودع">
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
        <Field label="الضريبة">
          <SearchCombobox value={taxId} onChange={onSelectTax} options={taxOptions} style={input} />
        </Field>
        <Field label="الفرع">
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label="مركز التكلفة">
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} options={costCenterPickerOptions(costCenters)} style={input} />
        </Field>
      </div>

      <div style={{ overflowX: "auto", marginTop: 10 }}>
      <Table style={{ minWidth: 1250 }}>
        <thead><tr>
          <Th style={{ minWidth: 240 }}>الصنف</Th>
          <Th style={{ width: 130 }}>الوحدة</Th>
          <Th style={{ width: 180 }}>الكمية</Th>
          <Th style={{ width: 240 }}>سعر الوحدة</Th>
          <Th style={{ width: 170 }}>الخصم</Th>
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
              <Td><input type="number" step="0.01" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><LineDiscountCell amount={l.disc ?? 0} type={l.discType ?? "percent"} gross={(Number(l.qty) || 0) * (Number(l.unitPrice) || 0)} onAmount={(v) => setLine(i, { disc: v })} onType={(t) => setLine(i, { discType: t })} /></Td>
              <Td><input type="number" step="0.01" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td num>{fmt(l.lineTotal)}</Td>
              <Td><button onClick={() => removeLine(i)} type="button" style={{ ...btnLink, color: "#dc2626" }}>×</button></Td>
            </tr>
          ))}
        </tbody>
      </Table>
      </div>
      <button onClick={addLine} type="button" style={{ ...btnSecondary, marginTop: 8 }}>+ سطر</button>
      <InvoiceTotals result={result} headerDisc={headerDisc} headerType={headerDiscType} onHeaderDisc={setHeaderDisc} onHeaderType={setHeaderDiscType} />

      <Field label="ملاحظات" style={{ marginTop: 12 }}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} />
      </Field>
      <ValidationPanel issues={issues} />
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : "حفظ كمسودة"}</button>
      </Actions>
    </div>
  );
}
