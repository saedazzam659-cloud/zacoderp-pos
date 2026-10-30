import React, { useEffect, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listGoodsReceipts, getGoodsReceipt, createGoodsReceipt, postGoodsReceipt,
  deleteGoodsReceipt, convertGoodsReceiptToInvoice,
  listSuppliers, listCashBoxes, listBanks,
  type GoodsReceipt, type GoodsReceiptStatus, type PurchaseLine, type PaymentMethod,
  type Supplier, type CashBox, type Bank,
} from "../lib/accounting";
import { listItems, type LocalItem } from "../lib/items";
import { listUom, type Uom } from "../lib/uom";
import { listWarehouses, type Warehouse } from "../lib/inventory";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty, Pagination, pageSlice, Modal,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
  LineDiscountCell, InvoiceTotals, ValidationPanel, collectDocIssues, EmptyItemsRow,
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
import { uiText, useUiLanguage } from "../lib/appSettings";

type FLine = PurchaseLine & DiscFields;

const STATUS_META: Record<GoodsReceiptStatus, { ar: string; en: string; c: string }> = {
  draft: { ar: "مسودة", en: "Draft", c: "#475569" },
  posted: { ar: "مُرحّل (بالمخزون)", en: "Posted (in stock)", c: "#1e40af" },
  converted: { ar: "محوّل لفاتورة", en: "Converted to invoice", c: "#15803d" },
};

export default function GoodsReceiptsAdmin({ onNavigate }: { onNavigate?: (v: WindowsView) => void }) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<GoodsReceipt[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<GoodsReceipt | null>(null);
  const [creating, setCreating] = useState(false);
  const [convertTarget, setConvertTarget] = useState<GoodsReceipt | null>(null);
  const [deps, setDeps] = useState<{ suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[] } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  async function refresh() { setRows(await listGoodsReceipts(5000)); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [suppliers, cashBoxes, banks, items, warehouses] = await Promise.all([listSuppliers(), listCashBoxes(), listBanks(), listItems(), listWarehouses()]);
      setDeps({ suppliers, cashBoxes, banks, items, warehouses });
    })();
  }, []);

  const { start, end, page: clampedPage } = pageSlice(rows.length, page, pageSize);
  const pageRows = rows.slice(start, end);
  const sel = useRowSelect(rows);
  useDataRefresh(["invoices", "stock"], refresh);
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getGoodsReceipt(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  async function post(id: number) {
    if (!confirm(text("ترحيل سند الاستلام؟ سيتم إدخال البضاعة للمخزون وترحيل قيد وسيط الاستلام.", "Post this goods receipt? Items will be added to stock and the receipt clearing entry will be posted."))) return;
    try { await postGoodsReceipt(id); await refresh(); if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); } }
    catch (e: any) { alert(e?.message ?? text("فشل الترحيل", "Could not post receipt.")); }
  }

  async function remove(id: number) {
    if (!confirm(text("حذف سند الاستلام؟ إن كان مُرحّلاً سيتم عكس حركة المخزون والقيد.", "Delete this goods receipt? If posted, its stock movement and journal entry will be reversed."))) return;
    try {
      await deleteGoodsReceipt(id);
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
    } catch (e: any) { alert(e?.message ?? text("فشل الحذف", "Could not delete receipt.")); }
  }

  async function printDoc(id: number, kind: PrintKind) {
    const o = await getGoodsReceipt(id);
    await printSalesDoc(kind, {
      kind: "invoice",
      docNo: o.receiptNo,
      date: o.receiptDate,
      customerName: o.supplierName,
      paymentMethod: "credit",
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
    <div dir={language === "en" ? "ltr" : "rtl"}>
    <Page
      title={text("سندات استلام البضاعة", "Goods receipts")}
      subtitle={`${rows.length} ${text("سند — الترحيل يُدخِل المخزون عبر حساب وسيط، والتحويل ينشئ فاتورة الشراء", "receipts — posting adds stock through a clearing account; conversion creates a purchase invoice")}`}
      right={
        <button onClick={() => setCreating(true)} disabled={!deps || creating}
          style={{ ...btnPrimary, opacity: (!deps || creating) ? 0.5 : 1, cursor: (!deps || creating) ? "not-allowed" : "pointer" }}>
          + {text("سند استلام", "Goods receipt")}
        </button>
      }
    >
      {creating && deps && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ padding: 16 }}>
            <CreateForm deps={deps} onCancel={() => setCreating(false)} onDone={() => { setCreating(false); void refresh(); }} />
          </div>
        </Card>
      )}
      {convertTarget && deps && (
        <ConvertModal
          gr={convertTarget}
          deps={deps}
          onCancel={() => setConvertTarget(null)}
          onDone={() => { setConvertTarget(null); void refresh(); if (onNavigate) onNavigate("purchases"); }}
        />
      )}
      {rows.length > 0 && !creating && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.receiptNo : null}>
          <ActionBtn label={expandedId === sel.selectedId ? text("إخفاء", "Hide") : text("عرض", "View")} icon="▼" disabled={!sel.selected || creating}
            onClick={() => { if (sel.selectedId != null) void toggleView(sel.selectedId); }} />
          {(() => {
            const s = sel.selected;
            return (
              <>
                <ActionBtn label={text("ترحيل", "Post")} icon="✔" tone="success" disabled={!s || creating || s.status !== "draft"} onClick={() => { if (s) void post(s.id); }} />
                <ActionBtn label={text("تحويل لفاتورة", "Convert to invoice")} icon="➜" tone="purple" disabled={!s || creating || s.status !== "posted"} onClick={() => { if (s) setConvertTarget(s); }} />
                <ActionBtn label={text("طباعة", "Print")} icon="🖶" tone="primary" disabled={!s || creating} onClick={() => { if (s) void printDoc(s.id, "a4"); }} />
                <ActionBtn label={text("حذف", "Delete")} icon="🗑" tone="danger" disabled={!s || creating || s.status === "converted"} onClick={() => { if (s) void remove(s.id); }} />
              </>
            );
          })()}
        </ActionBar>
      )}
      <Card>
        {rows.length === 0 && !creating ? <Empty text={text("لا توجد سندات استلام", "No goods receipts")} /> : (
          <Table>
            <thead><tr>
              <SelectTh />
              <Th>{text("رقم السند", "Receipt number")}</Th><Th>{text("التاريخ", "Date")}</Th><Th>{text("المورد", "Supplier")}</Th><Th>{text("الحالة", "Status")}</Th>
              <Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("المجموع", "Subtotal")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الضريبة", "Tax")}</Th>
              <Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الإجمالي", "Total")}</Th>
            </tr></thead>
            <tbody>
              {pageRows.map((p) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <SelectCell id={p.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                    <Td mono>{p.receiptNo}</Td>
                    <Td>{p.receiptDate}</Td>
                    <Td>{p.supplierName}</Td>
                    <Td><StatusBadge s={p.status} /></Td>
                    <Td num>{fmt(p.subtotal)}</Td>
                    <Td num>{fmt(p.vatTotal)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                  </tr>
                  {expandedId === p.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={8 as any}>
                        {!expandedDetail ? <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>{text("... جاري التحميل", "Loading…")}</div> : (
                          <ReceiptDetail r={expandedDetail} />
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
    </div>
  );
}

function StatusBadge({ s }: { s: GoodsReceiptStatus }) {
  const language = useUiLanguage();
  const x = STATUS_META[s];
  return <span style={{ background: x.c + "20", color: x.c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{language === "en" ? x.en : x.ar}</span>;
}

function ReceiptDetail({ r }: { r: GoodsReceipt }) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 10, fontSize: 13, color: "#475569" }}>
        {r.supplierInvoiceNo && <span>{text("رقم فاتورة المورد:", "Supplier invoice number:")} <b style={{ color: "#0f172a" }}>{r.supplierInvoiceNo}</b></span>}
        {r.convertedInvoiceId && <span>{text("فاتورة الشراء المرتبطة:", "Linked purchase invoice:")} <b style={{ color: "#0f172a" }}>#{r.convertedInvoiceId}</b></span>}
      </div>
      <Table>
        <thead><tr><Th>{text("الصنف", "Item")}</Th><Th>{text("الوحدة", "Unit")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الكمية", "Quantity")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("سعر الوحدة", "Unit price")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الضريبة %", "Tax %")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الإجمالي", "Total")}</Th></tr></thead>
        <tbody>
          {r.lines.map((l, i) => (
            <tr key={l.id ?? i}>
              <Td>{l.itemName}</Td><Td>{l.uomName ?? ""}</Td><Td num>{l.qty}</Td><Td num>{fmt(l.unitCost)}</Td><Td num>{l.vatRate}</Td><Td num>{fmt(l.lineTotal)}</Td>
            </tr>
          ))}
          <tr style={{ background: "#fff", fontWeight: 700 }}><Td colSpan={5 as any}>{text("الإجمالي قبل الضريبة", "Subtotal")}</Td><Td num>{fmt(r.subtotal)}</Td></tr>
          <tr style={{ background: "#fff" }}><Td colSpan={5 as any}>{text("ضريبة القيمة المضافة", "VAT")}</Td><Td num>{fmt(r.vatTotal)}</Td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 800, fontSize: 16 }}><Td colSpan={5 as any}>{text("الإجمالي النهائي", "Grand total")}</Td><Td num>{fmt(r.grandTotal)}</Td></tr>
        </tbody>
      </Table>
    </div>
  );
}

function ConvertModal({ gr, deps, onCancel, onDone }: {
  gr: GoodsReceipt;
  deps: { cashBoxes: CashBox[]; banks: Bank[] };
  onCancel: () => void; onDone: () => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [invoiceDate, setInvoiceDate] = useState(todayStr());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("credit");
  const [cashBoxId, setCashBoxId] = useState<number | null>(deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(deps.banks[0]?.id ?? null);
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState(gr.supplierInvoiceNo ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await convertGoodsReceiptToInvoice(gr.id, {
        invoiceDate,
        paymentMethod,
        cashBoxId: paymentMethod === "cash" ? cashBoxId : null,
        bankId: paymentMethod === "bank" ? bankId : null,
        supplierInvoiceNo: supplierInvoiceNo.trim() || null,
      });
      onDone();
    } catch (e: any) { setErr(e?.message ?? text("فشل التحويل", "Could not convert receipt.")); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`${text("تحويل سند", "Convert receipt")} ${gr.receiptNo} ${text("إلى فاتورة شراء", "to purchase invoice")}`} onCancel={onCancel}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0 10px" }}>
        <Field label={text("تاريخ الفاتورة", "Invoice date")}><input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} style={input} /></Field>
        <Field label={text("رقم فاتورة المورد", "Supplier invoice number")}><input value={supplierInvoiceNo} onChange={(e) => setSupplierInvoiceNo(e.target.value)} style={input} placeholder={text("مرجع المورد", "Supplier reference")} /></Field>
        <Field label={text("طريقة الدفع", "Payment method")}>
          <SearchCombobox
            value={paymentMethod}
            onChange={(v) => setPaymentMethod(v as PaymentMethod)}
            style={input}
            options={[
              { value: "credit", label: text("آجل (على الحساب)", "Credit") },
              { value: "cash", label: text("نقدي", "Cash") },
              { value: "bank", label: text("بنك", "Bank") },
            ]}
          />
        </Field>
        {paymentMethod === "cash" && (
          <Field label={text("الخزينة", "Cash box")}>
            <SearchCombobox value={cashBoxId ?? ""} onChange={(v) => setCashBoxId(Number(v) || null)} style={input}
              options={deps.cashBoxes.map((c) => ({ value: c.id, label: c.name }))} />
          </Field>
        )}
        {paymentMethod === "bank" && (
          <Field label={text("البنك", "Bank")}>
            <SearchCombobox value={bankId ?? ""} onChange={(v) => setBankId(Number(v) || null)} style={input}
              options={deps.banks.map((b) => ({ value: b.id, label: b.name }))} />
          </Field>
        )}
      </div>
      <div style={{ marginTop: 8, fontSize: 13, color: "#475569" }}>
        {text("الإجمالي:", "Total:")} <b style={{ color: "#0f172a" }}>{fmt(gr.grandTotal)}</b>
      </div>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
        <button onClick={submit} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : text("تحويل لفاتورة", "Convert to invoice")}</button>
      </Actions>
    </Modal>
  );
}

function CreateForm({ deps, onCancel, onDone }: {
  deps: { suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[] };
  onCancel: () => void; onDone: () => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [supplierId, setSupplierId] = useState<number>(deps.suppliers[0]?.id ?? 0);
  const [date, setDate] = useState(todayStr());
  const [warehouseId, setWarehouseId] = useState<number>(
    (deps.warehouses.find((w) => w.is_default) ?? deps.warehouses[0])?.id ?? 0,
  );
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState("");
  const { branches, costCenters } = useDimensions();
  const [branchId, setBranchId] = useState<number | "">("");
  useEffect(() => { if (branchId === "" && branches.length === 1) setBranchId(branches[0].id); }, [branches]); // eslint-disable-line react-hooks/exhaustive-deps
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [notes, setNotes] = useState("");
  const [uoms] = useState<Uom[]>(() => listUom());
  const defUom = uoms.find((u) => u.isDefault) ?? uoms[0];
  const blankLine = (): FLine => ({
    itemId: 0, qty: 1, unitCost: 0, vatRate: 0, lineTotal: 0, disc: 0, discType: "percent",
    uomId: defUom?.id ?? null, uomName: defUom?.nameAr ?? null, conversionFactor: defUom?.baseQty ?? 1,
  });
  const [lines, setLines] = useState<FLine[]>([]);
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
        { label: text("المورد", "Supplier"), ok: !!supplierId },
        ...(branches.length ? [{ label: text("الفرع", "Branch"), ok: branchId !== "" }] : []),
        { label: text("المستودع", "Warehouse"), ok: !!warehouseId },
      ], lines.map((l) => ({ itemId: l.itemId, uomId: l.uomId ?? null, price: l.unitCost, qty: l.qty })), text("سعر الشراء", "Purchase price"));
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
      await createGoodsReceipt({
        supplierId, receiptDate: date,
        supplierInvoiceNo: supplierInvoiceNo.trim() || null,
        warehouseId: warehouseId || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
        notes: notes || null, lines: payloadLines,
      });
      onDone();
    } catch (e: any) { setErr(e?.message ?? text("فشل", "Could not save receipt.")); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{text("سند استلام بضاعة جديد", "New goods receipt")}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px", alignItems: "start" }}>
        <Field label={text("المورد *", "Supplier *")}>
          <SearchCombobox
            value={supplierId}
            onChange={(v) => setSupplierId(Number(v))}
            style={input}
            options={[
              { value: 0, label: text("— اختر —", "— Select —") },
              ...deps.suppliers.map((s) => ({ value: s.id, label: s.nameAr })),
            ]}
          />
        </Field>
        <Field label={text("تاريخ الاستلام", "Receipt date")}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label={text("رقم فاتورة المورد", "Supplier invoice number")}>
          <input value={supplierInvoiceNo} onChange={(e) => setSupplierInvoiceNo(e.target.value)} style={input} placeholder={text("مرجع المورد", "Supplier reference")} />
        </Field>
        <Field label={text("المستودع", "Warehouse")}>
          <SearchCombobox
            value={warehouseId}
            onChange={(v) => setWarehouseId(Number(v))}
            style={input}
            options={[
              { value: 0, label: text("— المستودع الافتراضي —", "— Default warehouse —") },
              ...deps.warehouses.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />
        </Field>
        <Field label={text("الضريبة", "Tax")}>
          <SearchCombobox value={taxId} onChange={onSelectTax} options={taxOptions} style={input} />
        </Field>
        <Field label={text("الفرع", "Branch")}>
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label={text("مركز التكلفة", "Cost center")}>
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} options={costCenterPickerOptions(costCenters)} style={input} />
        </Field>
      </div>

      <div style={{ overflowX: "auto", marginTop: 10 }}>
      <Table style={{ minWidth: 1250 }}>
        <thead><tr>
          <Th style={{ minWidth: 240 }}>{text("الصنف", "Item")}</Th>
          <Th style={{ width: 130 }}>{text("الوحدة", "Unit")}</Th>
          <Th style={{ width: 180 }}>{text("الكمية", "Quantity")}</Th>
          <Th style={{ width: 240 }}>{text("سعر الوحدة", "Unit price")}</Th>
          <Th style={{ width: 170 }}>{text("الخصم", "Discount")}</Th>
          <Th style={{ width: 80 }}>{text("ض. %", "Tax %")}</Th>
          <Th style={{ width: 120, textAlign: language === "en" ? "right" : "left" }}>{text("الإجمالي", "Total")}</Th>
          <Th style={{ width: 40 }}></Th>
        </tr></thead>
        <tbody>
          {lines.length === 0 && <EmptyItemsRow colSpan={8} />}
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>
                <SearchCombobox
                  value={l.itemId}
                  onChange={(v) => setLine(i, { itemId: Number(v) })}
                  style={input}
                  options={[
                    { value: 0, label: text("— اختر —", "— Select —") },
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
      <button onClick={addLine} type="button" style={{ ...btnSecondary, marginTop: 8 }}>+ {text("سطر", "Line")}</button>
      <InvoiceTotals result={result} headerDisc={headerDisc} headerType={headerDiscType} onHeaderDisc={setHeaderDisc} onHeaderType={setHeaderDiscType} />

      <Field label={text("ملاحظات", "Notes")} style={{ marginTop: 12 }}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} />
      </Field>
      <ValidationPanel issues={issues} />
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : text("حفظ كمسودة", "Save as draft")}</button>
      </Actions>
    </div>
  );
}
