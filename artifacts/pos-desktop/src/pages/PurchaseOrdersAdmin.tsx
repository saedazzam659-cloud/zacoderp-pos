import React, { useEffect, useState } from "react";
import { getTaxRate } from "../lib/taxSettings";
import { useDataRefresh } from "../lib/dataBus";
import {
  listPurchaseOrders, getPurchaseOrder, createPurchaseOrder, updatePurchaseOrder,
  deletePurchaseOrder, setPurchaseOrderStatus, convertPurchaseOrder,
  listSuppliers, listCashBoxes, listBanks,
  type PurchaseOrder, type PurchaseOrderStatus, type PurchaseLine, type PaymentMethod,
  type Supplier, type CashBox, type Bank,
} from "../lib/accounting";
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
import { printSalesDoc, type PrintKind } from "../lib/invoicePrint";
import { type WindowsView } from "../lib/moduleRegistry";

type FLine = PurchaseLine & DiscFields;

type FormSeed = {
  editId?: number;
  supplierId: number; orderDate: string; expectedDate: string; paymentMethod: PaymentMethod;
  cashBoxId: number | null; bankId: number | null; warehouseId: number;
  branchId: number | null; costCenterId: number | null;
  supplierInvoiceNo: string; notes: string;
  lines: FLine[];
};

const STATUS_META: Record<PurchaseOrderStatus, { l: string; c: string }> = {
  draft: { l: "مسودة", c: "#475569" },
  confirmed: { l: "مؤكد", c: "#1e40af" },
  converted: { l: "محوّل لفاتورة", c: "#15803d" },
  cancelled: { l: "ملغي", c: "#b91c1c" },
};

export default function PurchaseOrdersAdmin({ onNavigate }: { onNavigate?: (v: WindowsView) => void }) {
  const [rows, setRows] = useState<PurchaseOrder[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<PurchaseOrder | null>(null);
  const [form, setForm] = useState<FormSeed | null>(null);
  const [deps, setDeps] = useState<{ suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[] } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const creating = form !== null;

  async function refresh() { setRows(await listPurchaseOrders(5000)); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [suppliers, cashBoxes, banks, items, warehouses] = await Promise.all([listSuppliers(), listCashBoxes(), listBanks(), listItems(), listWarehouses()]);
      setDeps({ suppliers, cashBoxes, banks, items, warehouses });
    })();
  }, []);

  const sel = useRowSelect(rows);
  const { start, end, page: clampedPage } = pageSlice(rows.length, page, pageSize);
  const pageRows = rows.slice(start, end);
  useDataRefresh(["invoices"], refresh);
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getPurchaseOrder(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  function blankSeed(): FormSeed {
    return {
      supplierId: deps?.suppliers[0]?.id ?? 0,
      orderDate: todayStr(),
      expectedDate: "",
      paymentMethod: "credit",
      cashBoxId: deps?.cashBoxes[0]?.id ?? null,
      bankId: deps?.banks[0]?.id ?? null,
      warehouseId: (deps?.warehouses.find((w) => w.is_default) ?? deps?.warehouses[0])?.id ?? 0,
      branchId: null,
      costCenterId: null,
      supplierInvoiceNo: "",
      notes: "",
      lines: [],
    };
  }

  function seedLines(o: PurchaseOrder): FLine[] {
    return o.lines.map((l) => ({
      id: l.id, itemId: l.itemId, itemName: l.itemName,
      qty: l.qty, unitCost: l.unitCost, vatRate: l.vatRate, lineTotal: l.lineTotal,
      uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
      disc: 0, discType: "percent",
    }));
  }

  async function startEdit(id: number) {
    const o = await getPurchaseOrder(id);
    if (o.status !== "draft") { alert("لا يمكن تعديل أمر شراء غير المسودة"); return; }
    setExpandedId(null); setExpandedDetail(null);
    setForm({
      editId: o.id, supplierId: o.supplierId, orderDate: o.orderDate,
      expectedDate: o.expectedDate ?? "", paymentMethod: o.paymentMethod,
      cashBoxId: o.cashBoxId, bankId: o.bankId,
      warehouseId: o.warehouseId ?? (deps?.warehouses.find((w) => w.is_default) ?? deps?.warehouses[0])?.id ?? 0,
      branchId: o.branchId, costCenterId: o.costCenterId,
      supplierInvoiceNo: o.supplierInvoiceNo ?? "", notes: o.notes ?? "",
      lines: seedLines(o),
    });
  }

  async function duplicate(id: number) {
    const o = await getPurchaseOrder(id);
    setExpandedId(null); setExpandedDetail(null);
    setForm({
      supplierId: o.supplierId, orderDate: todayStr(), expectedDate: "",
      paymentMethod: o.paymentMethod, cashBoxId: o.cashBoxId, bankId: o.bankId,
      warehouseId: o.warehouseId ?? (deps?.warehouses.find((w) => w.is_default) ?? deps?.warehouses[0])?.id ?? 0,
      branchId: o.branchId, costCenterId: o.costCenterId,
      supplierInvoiceNo: "", notes: o.notes ?? "",
      lines: seedLines(o),
    });
  }

  async function changeStatus(id: number, status: PurchaseOrderStatus) {
    try { await setPurchaseOrderStatus(id, status); await refresh(); if (expandedId === id) await toggleView(id), await toggleView(id); }
    catch (e: any) { alert(e?.message ?? "فشل تغيير الحالة"); }
  }

  async function convert(id: number) {
    if (!confirm("تحويل أمر الشراء إلى فاتورة شراء؟ سيتم ترحيل القيد المحاسبي وحركة المخزون.")) return;
    try {
      await convertPurchaseOrder(id);
      await refresh();
      if (onNavigate) onNavigate("purchases");
    } catch (e: any) { alert(e?.message ?? "فشل التحويل"); }
  }

  async function remove(id: number) {
    if (!confirm("حذف أمر الشراء؟")) return;
    try {
      await deletePurchaseOrder(id);
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
    } catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  async function printDoc(id: number, kind: PrintKind) {
    const o = await getPurchaseOrder(id);
    await printSalesDoc(kind, {
      kind: "invoice",
      docNo: o.orderNo,
      date: o.orderDate,
      customerName: o.supplierName,
      paymentMethod: o.paymentMethod,
      subtotal: o.subtotal,
      vatTotal: o.vatTotal,
      grandTotal: o.grandTotal,
      notes: o.notes,
      qrBase64: null,
      lines: o.lines.map((l) => ({
        itemId: l.itemId, itemName: l.itemName, qty: l.qty,
        unitPrice: l.unitCost, vatRate: l.vatRate, lineTotal: l.lineTotal,
        uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
      })),
    });
  }

  return (
    <Page
      title="أوامر الشراء"
      subtitle={`${rows.length} أمر — لا يُرحَّل قيد محاسبي إلا عند التحويل إلى فاتورة`}
      right={
        <button onClick={() => setForm(blankSeed())} disabled={!deps || creating}
          style={{ ...btnPrimary, opacity: (!deps || creating) ? 0.5 : 1, cursor: (!deps || creating) ? "not-allowed" : "pointer" }}>
          + أمر شراء
        </button>
      }
    >
      {creating && deps && form && (
        <Card style={{ marginBottom: 12, border: "2px solid #2563eb" }}>
          <div style={{ padding: 16 }}>
            <CreateForm deps={deps} seed={form} onCancel={() => setForm(null)} onDone={() => { setForm(null); void refresh(); }} />
          </div>
        </Card>
      )}
      {rows.length > 0 && !creating && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.orderNo : null}>
          <ActionBtn label={expandedId === sel.selectedId ? "إخفاء" : "عرض"} icon="▼" disabled={!sel.selected}
            onClick={() => { if (sel.selectedId != null) void toggleView(sel.selectedId); }} />
          {(() => {
            const s = sel.selected;
            if (!s) return null;
            return (
              <>
                {s.status === "draft" && (
                  <ActionBtn label="تأكيد" icon="✓" tone="primary" onClick={() => void changeStatus(s.id, "confirmed")} />
                )}
                {s.status === "confirmed" && (
                  <ActionBtn label="مسودة" icon="↺" tone="warn" onClick={() => void changeStatus(s.id, "draft")} />
                )}
                {(s.status === "draft" || s.status === "confirmed") && (
                  <ActionBtn label="تحويل لفاتورة" icon="➜" tone="success" onClick={() => void convert(s.id)} />
                )}
                {s.status === "draft" && (
                  <ActionBtn label="تعديل" icon="✎" onClick={() => void startEdit(s.id)} />
                )}
                <ActionBtn label="نسخ" icon="⧉" onClick={() => void duplicate(s.id)} />
                <ActionBtn label="طباعة" icon="🖶" tone="primary" onClick={() => void printDoc(s.id, "a4")} />
                {s.status !== "converted" && (
                  <ActionBtn label="حذف" icon="🗑" tone="danger" onClick={() => void remove(s.id)} />
                )}
              </>
            );
          })()}
        </ActionBar>
      )}
      <Card>
        {rows.length === 0 && !creating ? <Empty text="لا توجد أوامر شراء" /> : (
          <Table>
            <thead><tr>
              <SelectTh />
              <Th>رقم الأمر</Th><Th>التاريخ</Th><Th>التسليم المتوقع</Th><Th>المورد</Th><Th>الحالة</Th>
              <Th style={{ textAlign: "left" }}>المجموع</Th><Th style={{ textAlign: "left" }}>الضريبة</Th>
              <Th style={{ textAlign: "left" }}>الإجمالي</Th>
            </tr></thead>
            <tbody>
              {pageRows.map((p) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <SelectCell id={p.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                    <Td mono>{p.orderNo}</Td>
                    <Td>{p.orderDate}</Td>
                    <Td>{p.expectedDate ?? "—"}</Td>
                    <Td>{p.supplierName}</Td>
                    <Td><StatusBadge s={p.status} /></Td>
                    <Td num>{fmt(p.subtotal)}</Td>
                    <Td num>{fmt(p.vatTotal)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                  </tr>
                  {expandedId === p.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={9 as any}>
                        {!expandedDetail ? <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>... جاري التحميل</div> : (
                          <OrderDetail o={expandedDetail} />
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

function StatusBadge({ s }: { s: PurchaseOrderStatus }) {
  const x = STATUS_META[s];
  return <span style={{ background: x.c + "20", color: x.c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{x.l}</span>;
}

function OrderDetail({ o }: { o: PurchaseOrder }) {
  return (
    <div style={{ padding: 12 }}>
      {o.convertedInvoiceId && (
        <div style={{ marginBottom: 10, fontSize: 13, color: "#475569" }}>
          فاتورة الشراء المرتبطة: <b style={{ color: "#0f172a" }}>#{o.convertedInvoiceId}</b>
        </div>
      )}
      <Table>
        <thead><tr><Th>الصنف</Th><Th>الوحدة</Th><Th style={{ textAlign: "left" }}>الكمية</Th><Th style={{ textAlign: "left" }}>سعر الوحدة</Th><Th style={{ textAlign: "left" }}>الضريبة %</Th><Th style={{ textAlign: "left" }}>الإجمالي</Th></tr></thead>
        <tbody>
          {o.lines.map((l, i) => (
            <tr key={l.id ?? i}>
              <Td>{l.itemName}</Td><Td>{l.uomName ?? ""}</Td><Td num>{l.qty}</Td><Td num>{fmt(l.unitCost)}</Td><Td num>{l.vatRate}</Td><Td num>{fmt(l.lineTotal)}</Td>
            </tr>
          ))}
          <tr style={{ background: "#fff", fontWeight: 700 }}><Td colSpan={5 as any}>الإجمالي قبل الضريبة</Td><Td num>{fmt(o.subtotal)}</Td></tr>
          <tr style={{ background: "#fff" }}><Td colSpan={5 as any}>ضريبة القيمة المضافة</Td><Td num>{fmt(o.vatTotal)}</Td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 800, fontSize: 16 }}><Td colSpan={5 as any}>الإجمالي النهائي</Td><Td num>{fmt(o.grandTotal)}</Td></tr>
        </tbody>
      </Table>
    </div>
  );
}

function CreateForm({ deps, seed, onCancel, onDone }: {
  deps: { suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[] };
  seed: FormSeed;
  onCancel: () => void; onDone: () => void;
}) {
  const isEdit = seed.editId != null;
  const [supplierId, setSupplierId] = useState<number>(seed.supplierId || deps.suppliers[0]?.id || 0);
  const [date, setDate] = useState(seed.orderDate || todayStr());
  const [expectedDate, setExpectedDate] = useState(seed.expectedDate);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(seed.paymentMethod);
  const [cashBoxId, setCashBoxId] = useState<number | null>(seed.cashBoxId ?? deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(seed.bankId ?? deps.banks[0]?.id ?? null);
  const [warehouseId, setWarehouseId] = useState<number>(
    seed.warehouseId || (deps.warehouses.find((w) => w.is_default) ?? deps.warehouses[0])?.id || 0,
  );
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState(seed.supplierInvoiceNo);
  const { branches, costCenters } = useDimensions();
  const [branchId, setBranchId] = useState<number | "">(seed.branchId ?? "");
  useEffect(() => { if (branchId === "" && !isEdit && branches.length === 1) setBranchId(branches[0].id); }, [branches]); // eslint-disable-line react-hooks/exhaustive-deps
  const [costCenterId, setCostCenterId] = useState<number | "">(seed.costCenterId ?? "");
  const [notes, setNotes] = useState(seed.notes);
  const [uoms] = useState<Uom[]>(() => listUom());
  const defUom = uoms.find((u) => u.isDefault) ?? uoms[0];
  const blankLine = (): FLine => ({
    itemId: 0, qty: 1, unitCost: 0, vatRate: getTaxRate(), lineTotal: 0, disc: 0, discType: "percent",
    uomId: defUom?.id ?? null, uomName: defUom?.nameAr ?? null, conversionFactor: defUom?.baseQty ?? 1,
  });
  const [lines, setLines] = useState<FLine[]>(() => seed.lines.length ? seed.lines : [blankLine()]);
  const [headerDisc, setHeaderDisc] = useState(0);
  const [headerDiscType, setHeaderDiscType] = useState<DiscType>("percent");
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { taxes, taxId, setTaxId, taxOptions, selectedRate } = useInvoiceTaxes("purchase");

  function setLine(i: number, patch: Partial<FLine>) {
    setLines((ls) => ls.map((l, k) => {
      if (k !== i) return l;
      const next = { ...l, ...patch };
      if (patch.itemId !== undefined) {
        const it = deps.items.find((x) => x.id === Number(patch.itemId));
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
      const { net } = lineNet(next.qty, next.unitCost, next.disc, next.discType);
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
      const { net } = lineNet(l.qty, l.unitCost, l.disc, l.discType);
      return { ...l, vatRate: rate, lineTotal: net + net * rate / 100 };
    }));
  }

  const result = computeDiscount(
    lines.map((l) => ({ qty: l.qty, unit: l.unitCost, vatRate: l.vatRate, disc: l.disc, discType: l.discType })),
    headerDisc, headerDiscType,
  );

  async function save() {
    setBusy(true); setErr(null); setIssues([]);
    try {
      const problems = collectDocIssues([
        { label: "طريقة الدفع", ok: !!paymentMethod },
        { label: "المورد", ok: !!supplierId },
        ...(branches.length ? [{ label: "الفرع", ok: branchId !== "" }] : []),
      ], lines.map((l) => ({ itemId: l.itemId, uomId: l.uomId ?? null, price: l.unitCost, qty: l.qty })), "سعر الشراء");
      if (problems.length) { setIssues(problems); setBusy(false); return; }
      const cleaned = lines.filter((l) => l.itemId && (l.qty || 0) > 0);
      const r = computeDiscount(
        cleaned.map((l) => ({ qty: l.qty, unit: l.unitCost, vatRate: l.vatRate, disc: l.disc, discType: l.discType })),
        headerDisc, headerDiscType,
      );
      const payloadLines: PurchaseLine[] = cleaned.map((l, i) => {
        const net = r.netUnitPrices[i];
        return {
          itemId: l.itemId, itemName: l.itemName, qty: l.qty, unitCost: net, vatRate: l.vatRate,
          lineTotal: l.qty * net * (1 + (Number(l.vatRate) || 0) / 100),
          uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
        };
      });
      const payload = {
        supplierId, orderDate: date, expectedDate: expectedDate || null, paymentMethod,
        cashBoxId: paymentMethod === "cash" ? cashBoxId : null,
        bankId: paymentMethod === "bank" ? bankId : null,
        warehouseId: warehouseId || null,
        supplierInvoiceNo: supplierInvoiceNo.trim() || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
        notes: notes || null, lines: payloadLines,
      };
      if (isEdit) await updatePurchaseOrder(seed.editId!, payload);
      else await createPurchaseOrder(payload);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{isEdit ? "تعديل أمر الشراء" : "أمر شراء جديد"}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px", alignItems: "start" }}>
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
        <Field label="تاريخ الأمر"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="التسليم المتوقع"><input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} style={input} /></Field>
        <Field label="رقم مرجع المورد">
          <input value={supplierInvoiceNo} onChange={(e) => setSupplierInvoiceNo(e.target.value)} style={input} placeholder="مرجع المورد" />
        </Field>
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
              <Td><input type="number" step="0.01" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><LineDiscountCell amount={l.disc ?? 0} type={l.discType ?? "percent"} gross={(Number(l.qty) || 0) * (Number(l.unitCost) || 0)} onAmount={(v) => setLine(i, { disc: v })} onType={(t) => setLine(i, { discType: t })} /></Td>
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
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : (isEdit ? "حفظ التعديلات" : "حفظ")}</button>
      </Actions>
    </div>
  );
}
