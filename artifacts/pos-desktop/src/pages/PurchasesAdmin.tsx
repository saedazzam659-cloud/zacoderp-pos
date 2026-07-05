import { useEffect, useMemo, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listPurchases, getPurchase, createPurchase, updatePurchase, deletePurchase,
  unpostPurchase, postPurchase, listFinancialTx,
  listSuppliers, listCashBoxes, listBanks, listLettersOfCredit,
  type Purchase, type PurchaseLine, type PaymentMethod, type Supplier, type CashBox, type Bank,
  type LetterOfCredit,
} from "../lib/accounting";
import { listItems, type LocalItem } from "../lib/items";
import { listUom, type Uom } from "../lib/uom";
import { emitData } from "../lib/dataBus";
import { listWarehouses, type Warehouse } from "../lib/inventory";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty, Pagination, pageSlice,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
  LineDiscountCell, InvoiceTotals, CurrencyExchangeFields, FormTabs, tabPanel,
  docFormShell, linesPanel, linesScroll, docFormPinned, contentPanel,
  useGridFilter, GridToolbar, SortableTh, GridFilterRow, type GridColumn,
  ExportButtons, gridToExportCols,
  useRowSelect, SelectTh, SelectCell, ActionBar, ActionBtn,
} from "./_adminUi";
import { ValidationPanel, collectDocIssues } from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { useInvoiceTaxes } from "./_invoiceTax";
import { baseCurrencyCode, currencyByCode } from "../lib/currency";
import {
  computeDiscount, lineNet, saveDocDiscount, getDocDiscount, clearDocDiscount,
  type DiscType, type DiscFields,
} from "../lib/discount";
import { setPurchaseReturnPrefill } from "../lib/returnPrefill";
import { printSalesDoc, type PrintKind } from "../lib/invoicePrint";
import { type WindowsView } from "../lib/moduleRegistry";

type FLine = PurchaseLine & DiscFields;

// Edit/duplicate seed for the create form. `editId` set → update mode;
// otherwise the seeded lines/header are used to mint a brand-new invoice.
type FormSeed = {
  editId?: number;
  supplierId: number; invoiceDate: string; paymentMethod: PaymentMethod;
  cashBoxId: number | null; bankId: number | null; warehouseId: number;
  supplierInvoiceNo: string; notes: string;
  lcId: number | null;
  lines: FLine[];
};

export default function PurchasesAdmin({ onNavigate }: { onNavigate?: (v: WindowsView) => void }) {
  const [rows, setRows] = useState<Purchase[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<Purchase | null>(null);
  const [form, setForm] = useState<FormSeed | null>(null);
  const [deps, setDeps] = useState<{ suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[]; lcs: LetterOfCredit[] } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const creating = form !== null;
  // Paid-so-far per purchase: Σ posted payments tagged appliedDocType=purchase.
  const [paidByPurchase, setPaidByPurchase] = useState<Map<number, number>>(new Map());

  async function refresh() {
    const [invs, tx] = await Promise.all([listPurchases(5000), listFinancialTx(5000)]);
    setRows(invs);
    const m = new Map<number, number>();
    for (const t of tx) {
      if (t.txType === "payment" && t.appliedDocType === "purchase" && t.appliedDocId != null) {
        m.set(t.appliedDocId, (m.get(t.appliedDocId) ?? 0) + t.amount);
      }
    }
    setPaidByPurchase(m);
  }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [suppliers, cashBoxes, banks, items, warehouses, lcs] = await Promise.all([listSuppliers(), listCashBoxes(), listBanks(), listItems(), listWarehouses(), listLettersOfCredit()]);
      setDeps({ suppliers, cashBoxes, banks, items, warehouses, lcs });
    })();
  }, []);

  const columns = useMemo<GridColumn<Purchase>[]>(() => [
    { key: "invoiceNo", label: "رقم الفاتورة", value: (p) => p.invoiceNo },
    { key: "date", label: "التاريخ", value: (p) => p.invoiceDate },
    { key: "supplier", label: "المورد", value: (p) => p.supplierName ?? "" },
    { key: "payment", label: "طريقة الدفع", value: (p) => p.paymentMethod },
    { key: "status", label: "الحالة", value: (p) => p.status ?? "" },
    { key: "subtotal", label: "المجموع", type: "number", value: (p) => p.subtotal },
    { key: "vat", label: "الضريبة", type: "number", value: (p) => p.vatTotal },
    { key: "grand", label: "الإجمالي", type: "number", value: (p) => p.grandTotal },
    { key: "paid", label: "المدفوع", type: "number", value: (p) => paidByPurchase.get(p.id) ?? 0 },
  ], [paidByPurchase]);
  const grid = useGridFilter(rows, columns);
  const sel = useRowSelect(grid.view);

  const { start, end, page: clampedPage } = pageSlice(grid.view.length, page, pageSize);
  const pageRows = grid.view.slice(start, end);
  useDataRefresh(["invoices", "vouchers"], refresh);
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);
  useEffect(() => { setPage(1); }, [grid.search, grid.columnFilters, grid.sort]);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getPurchase(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  function blankSeed(): FormSeed {
    return {
      supplierId: deps?.suppliers[0]?.id ?? 0,
      invoiceDate: todayStr(),
      paymentMethod: "credit",
      cashBoxId: deps?.cashBoxes[0]?.id ?? null,
      bankId: deps?.banks[0]?.id ?? null,
      warehouseId: (deps?.warehouses.find((w) => w.is_default) ?? deps?.warehouses[0])?.id ?? 0,
      supplierInvoiceNo: "",
      notes: "",
      lcId: null,
      lines: [],
    };
  }

  // Rebuild editable FLine[] from a persisted invoice. The stored lines are
  // already in BASE currency with any original discount baked into unitCost, so
  // edit/duplicate work in base currency (no FX/discount reconstruction). Net
  // amounts are preserved exactly; re-saving keeps the same totals.
  function seedFromPurchase(inv: Purchase): FLine[] {
    return inv.lines.map((l) => ({
      id: l.id, itemId: l.itemId, itemName: l.itemName,
      qty: l.qty, unitCost: l.unitCost,
      vatRate: l.vatRate, lineTotal: l.lineTotal,
      uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
      disc: 0, discType: "percent",
    }));
  }

  async function startEdit(id: number) {
    const inv = await getPurchase(id);
    setExpandedId(null); setExpandedDetail(null);
    setForm({
      editId: inv.id,
      supplierId: inv.supplierId,
      invoiceDate: inv.invoiceDate,
      paymentMethod: inv.paymentMethod,
      cashBoxId: inv.cashBoxId,
      bankId: inv.bankId,
      warehouseId: inv.warehouseId ?? (deps?.warehouses.find((w) => w.is_default) ?? deps?.warehouses[0])?.id ?? 0,
      supplierInvoiceNo: inv.supplierInvoiceNo ?? "",
      notes: inv.notes ?? "",
      lcId: inv.lcId ?? null,
      lines: seedFromPurchase(inv),
    });
  }

  async function duplicate(id: number) {
    const inv = await getPurchase(id);
    setExpandedId(null); setExpandedDetail(null);
    setForm({
      supplierId: inv.supplierId,
      invoiceDate: todayStr(),
      paymentMethod: inv.paymentMethod,
      cashBoxId: inv.cashBoxId,
      bankId: inv.bankId,
      warehouseId: inv.warehouseId ?? (deps?.warehouses.find((w) => w.is_default) ?? deps?.warehouses[0])?.id ?? 0,
      supplierInvoiceNo: "",
      notes: inv.notes ?? "",
      lcId: inv.lcId ?? null,
      lines: seedFromPurchase(inv),
    });
  }

  async function remove(id: number) {
    if (!confirm("حذف فاتورة الشراء؟")) return;
    try {
      await deletePurchase(id);
      clearDocDiscount("purchase", id);
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
    } catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  // فك الترحيل / ترحيل: reverse or re-apply a non-GR purchase's GL/stock/AP
  // impact. GR-sourced invoices are rejected at the Rust layer (no draft cycle).
  async function unpost(id: number) {
    if (!confirm("فك ترحيل فاتورة الشراء؟ سيتم عكس القيد والمخزون وتتحول إلى مسودة قابلة للتعديل.")) return;
    try {
      await unpostPurchase(id);
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
    } catch (e: any) { alert(e?.message ?? "تعذّر فك الترحيل"); }
  }
  async function post(id: number) {
    if (!confirm("ترحيل فاتورة الشراء؟ سيتم توليد القيد المحاسبي وإضافة المخزون.")) return;
    try {
      await postPurchase(id);
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
    } catch (e: any) { alert(e?.message ?? "تعذّر الترحيل"); }
  }

  async function printDoc(id: number, kind: PrintKind) {
    const inv = await getPurchase(id);
    await printSalesDoc(kind, {
      kind: "invoice",
      docNo: inv.invoiceNo,
      date: inv.invoiceDate,
      customerName: inv.supplierName,
      paymentMethod: inv.paymentMethod,
      subtotal: inv.subtotal,
      vatTotal: inv.vatTotal,
      grandTotal: inv.grandTotal,
      notes: inv.notes,
      qrBase64: null,
      lines: inv.lines.map((l) => ({
        itemId: l.itemId, itemName: l.itemName, qty: l.qty,
        unitPrice: l.unitCost, vatRate: l.vatRate, lineTotal: l.lineTotal,
        uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
      })),
    });
  }

  // إرجاع: build a purchase-return prefill from the PERSISTED purchase invoice
  // (authoritative qty/cost/uom) then navigate to the purchase-returns screen.
  async function startReturn(id: number) {
    const inv = await getPurchase(id);
    setPurchaseReturnPrefill({
      purchaseId: inv.id,
      supplierId: inv.supplierId,
      // Default the return to the SOURCE purchase warehouse so stock-out unwinds
      // from the same warehouse the goods were received into (falls back to the
      // company default only when the source purchase has no warehouse).
      warehouseId: inv.warehouseId ?? null,
      lines: inv.lines.map((l) => ({
        itemId: l.itemId, itemName: l.itemName, qty: l.qty, unitCost: l.unitCost,
        vatRate: l.vatRate, lineTotal: l.lineTotal,
        uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
      })),
    });
    onNavigate?.("purchase_returns");
  }

  return (
    <Page
      title="فواتير الشراء"
      subtitle={`${rows.length} فاتورة — يتم ترحيل قيد المحاسبة تلقائياً عند الحفظ`}
      right={
        <button onClick={() => setForm(blankSeed())} disabled={!deps || creating}
          style={{ ...btnPrimary, opacity: (!deps || creating) ? 0.5 : 1, cursor: (!deps || creating) ? "not-allowed" : "pointer" }}>
          + فاتورة شراء
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
      {rows.length > 0 && !creating && <GridToolbar grid={grid} placeholder="🔍 بحث في فواتير الشراء…" extra={<ExportButtons columns={gridToExportCols(columns)} rows={grid.view} filenameBase="فواتير-الشراء" title="فواتير الشراء" />} />}
      {rows.length > 0 && !creating && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.invoiceNo : null}>
          <ActionBtn label={expandedId === sel.selectedId ? "إخفاء" : "عرض"} icon="▼" disabled={!sel.selected}
            onClick={() => { if (sel.selectedId != null) void toggleView(sel.selectedId); }} />
          <ActionBtn label="نسخ" icon="⧉" disabled={!sel.selected}
            onClick={() => { if (sel.selectedId != null) void duplicate(sel.selectedId); }} />
          <ActionBtn label="طباعة" icon="🖶" tone="primary" disabled={!sel.selected}
            onClick={() => { if (sel.selectedId != null) void printDoc(sel.selectedId, "a4"); }} />
          {onNavigate && (
            <ActionBtn label="إرجاع" icon="↩" tone="warn" disabled={!sel.selected}
              onClick={() => { if (sel.selectedId != null) void startReturn(sel.selectedId); }} />
          )}
          {(() => {
            const s = sel.selected;
            if (!s) return null;
            if (s.sourceGoodsReceiptId != null) {
              return (
                <>
                  <span title="ناتجة عن سند استلام — تُدار من شاشة سندات الاستلام" style={{ fontSize: 12, color: "#94a3b8" }}>🔒 من سند استلام</span>
                  <ActionBtn label="حذف" icon="🗑" tone="danger" onClick={() => void remove(s.id)} />
                </>
              );
            }
            if (s.status === "draft") {
              return (
                <>
                  <ActionBtn label="ترحيل" icon="✔" tone="success" onClick={() => void post(s.id)} />
                  <ActionBtn label="تعديل" icon="✎" onClick={() => void startEdit(s.id)} />
                  <ActionBtn label="حذف" icon="🗑" tone="danger" onClick={() => void remove(s.id)} />
                </>
              );
            }
            return <ActionBtn label="فك الترحيل" icon="↺" tone="warn" onClick={() => void unpost(s.id)} />;
          })()}
        </ActionBar>
      )}
      {!creating && <Card>
        {rows.length === 0 && !creating ? <Empty text="لا توجد فواتير شراء" /> : grid.view.length === 0 ? <Empty text="لا نتائج مطابقة للبحث" /> : (
          <Table>
            <thead>
              <tr>
                <SelectTh />
                <SortableTh grid={grid} colKey="invoiceNo">رقم الفاتورة</SortableTh>
                <SortableTh grid={grid} colKey="date">التاريخ</SortableTh>
                <SortableTh grid={grid} colKey="supplier">المورد</SortableTh>
                <SortableTh grid={grid} colKey="payment">طريقة الدفع</SortableTh>
                <SortableTh grid={grid} colKey="status">الحالة</SortableTh>
                <SortableTh grid={grid} colKey="subtotal" style={{ textAlign: "left" }}>المجموع</SortableTh>
                <SortableTh grid={grid} colKey="vat" style={{ textAlign: "left" }}>الضريبة</SortableTh>
                <SortableTh grid={grid} colKey="grand" style={{ textAlign: "left" }}>الإجمالي</SortableTh>
                <SortableTh grid={grid} colKey="paid" style={{ textAlign: "left" }}>المدفوع / المتبقّي</SortableTh>
              </tr>
              <GridFilterRow grid={grid} columns={columns} leading={1} />
            </thead>
            <tbody>
              {pageRows.map((p) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <SelectCell id={p.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                    <Td mono>{p.invoiceNo}</Td>
                    <Td>{p.invoiceDate}</Td>
                    <Td>{p.supplierName}</Td>
                    <Td><PayBadge m={p.paymentMethod} /></Td>
                    <Td><StatusBadge status={p.status} gr={p.sourceGoodsReceiptId != null} /></Td>
                    <Td num>{fmt(p.subtotal)}</Td>
                    <Td num>{fmt(p.vatTotal)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                    <Td num>{paidCell(p, paidByPurchase.get(p.id) ?? 0)}</Td>
                  </tr>
                  {expandedId === p.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={10 as any}>
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
          <Pagination total={grid.view.length} page={page} pageSize={pageSize}
            onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
        )}
      </Card>}
    </Page>
  );
}

import React from "react";

// المدفوع / المتبقّي cell: cash/bank purchases are settled at purchase → "مدفوعة".
// Credit purchases show Σ paid (سند صرف) and the outstanding remainder.
function paidCell(p: Purchase, paid: number) {
  if (p.paymentMethod !== "credit") return <span style={{ color: "#15803d" }}>مدفوعة</span>;
  const remaining = p.grandTotal - paid;
  if (paid <= 0.005) return <span style={{ color: "#b45309" }}>غير مدفوعة</span>;
  return (
    <span>
      <span style={{ color: "#15803d", fontWeight: 600 }}>{fmt(paid)}</span>
      {remaining > 0.005 && <span style={{ color: "#b45309" }}> / {fmt(remaining)}</span>}
      {remaining <= 0.005 && <span style={{ color: "#15803d" }}> ✓</span>}
    </span>
  );
}

function PayBadge({ m }: { m: PaymentMethod }) {
  const map = { credit: { l: "آجل", c: "#9a3412" }, cash: { l: "نقدي", c: "#15803d" }, bank: { l: "بنك", c: "#1e40af" } } as const;
  const x = map[m];
  return <span style={{ background: x.c + "20", color: x.c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{x.l}</span>;
}

function StatusBadge({ status, gr }: { status?: string; gr?: boolean }) {
  const draft = status === "draft";
  const c = draft ? "#b45309" : "#15803d";
  const label = draft ? "مسودة" : gr ? "مُرحّلة (استلام)" : "مُرحّلة";
  return <span style={{ background: c + "20", color: c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{label}</span>;
}

function PurchaseDetail({ p }: { p: Purchase }) {
  const disc = getDocDiscount("purchase", p.id);
  const discTotal = disc ? (disc.lineDiscountTotal + disc.headerDiscountValue) : 0;
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
          {disc && discTotal > 0.00001 && (
            <>
              <tr style={{ background: "#fff", color: "#475569" }}><Td colSpan={5 as any}>الإجمالي قبل الخصم</Td><Td num>{fmt(disc.grossSubtotal)}</Td></tr>
              <tr style={{ background: "#fff", color: "#b45309" }}><Td colSpan={5 as any}>الخصم</Td><Td num>− {fmt(discTotal)}</Td></tr>
            </>
          )}
          {disc?.currencyCode && disc.currencyCode !== baseCurrencyCode() && (
            <tr style={{ background: "#fff", color: "#475569" }}><Td colSpan={5 as any}>العملة · سعر الصرف</Td><Td num>{disc.currencyCode} · {fmt(disc.exchangeRate ?? 1)}</Td></tr>
          )}
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

function CreateForm({ deps, seed, onCancel, onDone }: {
  deps: { suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[]; lcs: LetterOfCredit[] };
  seed: FormSeed;
  onCancel: () => void; onDone: () => void;
}) {
  const isEdit = seed.editId != null;
  const [activeTab, setActiveTab] = useState<"basic" | "lines" | "payments">("basic");
  const [supplierId, setSupplierId] = useState<number>(seed.supplierId || deps.suppliers[0]?.id || 0);
  const [date, setDate] = useState(seed.invoiceDate || todayStr());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(seed.paymentMethod);
  const [cashBoxId, setCashBoxId] = useState<number | null>(seed.cashBoxId ?? deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(seed.bankId ?? deps.banks[0]?.id ?? null);
  const [warehouseId, setWarehouseId] = useState<number>(
    seed.warehouseId || (deps.warehouses.find((w) => w.is_default) ?? deps.warehouses[0])?.id || 0,
  );
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState(seed.supplierInvoiceNo);
  const [lcId, setLcId] = useState<number | "">(seed.lcId ?? "");
  // Clear the LC link if the chosen supplier no longer matches the LC's supplier.
  useEffect(() => {
    if (lcId === "") return;
    const lc = deps.lcs.find((x) => x.id === lcId);
    if (lc && lc.supplierId !== supplierId) setLcId("");
  }, [supplierId]); // eslint-disable-line react-hooks/exhaustive-deps
  const { branches, costCenters } = useDimensions();
  const [branchId, setBranchId] = useState<number | "">("");
  useEffect(() => { if (branchId === "" && branches.length === 1) setBranchId(branches[0].id); }, [branches]); // eslint-disable-line react-hooks/exhaustive-deps
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [notes, setNotes] = useState(seed.notes);
  const [uoms] = useState<Uom[]>(() => listUom());
  const defUom = uoms.find((u) => u.isDefault) ?? uoms[0];
  const blankLine = (): FLine => ({
    itemId: 0, qty: 1, unitCost: 0, vatRate: 0, lineTotal: 0, disc: 0, discType: "percent",
    uomId: defUom?.id ?? null, uomName: defUom?.nameAr ?? null, conversionFactor: defUom?.baseQty ?? 1,
  });
  const [lines, setLines] = useState<FLine[]>(() => seed.lines.length ? seed.lines : [blankLine()]);
  const [headerDisc, setHeaderDisc] = useState(0);
  const [headerDiscType, setHeaderDiscType] = useState<DiscType>("percent");
  const [currency, setCurrency] = useState<string>(() => baseCurrencyCode());
  const [exchangeRate, setExchangeRate] = useState<number>(1);
  const effRate = currency === baseCurrencyCode() ? 1 : (exchangeRate || 1);
  const docSym = currencyByCode(currency).symbol;
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { taxes, taxId, setTaxId, taxOptions, selectedRate } = useInvoiceTaxes("purchase");

  function setLine(i: number, patch: Partial<FLine>) {
    setLines((ls) => ls.map((l, k) => {
      if (k !== i) return l;
      const next = { ...l, ...patch };
      // Default the line's unit from the chosen item.
      if (patch.itemId !== undefined) {
        const it = deps.items.find((x) => x.id === Number(patch.itemId));
        // VAT comes ONLY from the picked item (0 if it has no registered rate).
        if (it) next.vatRate = it.vatRate ?? 0;
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
      // A selected header tax overrides any per-line rate so one tax applies to
      // the whole invoice.
      if (selectedRate != null) next.vatRate = selectedRate;
      // Per-line الإجمالي reflects the line discount (header shown in totals panel).
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
        { label: "العملة", ok: !!currency },
        ...(branches.length ? [{ label: "الفرع", ok: branchId !== "" }] : []),
        { label: "المستودع", ok: !!warehouseId },
      ], lines.map((l) => ({ itemId: l.itemId, uomId: l.uomId ?? null, price: l.unitCost, qty: l.qty })), "سعر الشراء");
      if (problems.length) { setIssues(problems); setBusy(false); return; }
      const cleaned = lines.filter((l) => l.itemId && (l.qty || 0) > 0);
      if (currency !== baseCurrencyCode() && !(exchangeRate > 0)) throw new Error("أدخل سعر صرف صحيح للعملة الأجنبية");
      // Fold the discount into each unit cost; Rust recomputes totals from
      // qty × unitCost so VAT lands on the net base (ZATCA-correct).
      const r = computeDiscount(
        cleaned.map((l) => ({ qty: l.qty, unit: l.unitCost, vatRate: l.vatRate, disc: l.disc, discType: l.discType })),
        headerDisc, headerDiscType,
      );
      const payloadLines: PurchaseLine[] = cleaned.map((l, i) => {
        // Bake discount AND the FX conversion into the base-currency unit cost.
        const net = r.netUnitPrices[i] * effRate;
        return {
          itemId: l.itemId, itemName: l.itemName, qty: l.qty, unitCost: net, vatRate: l.vatRate,
          lineTotal: l.qty * net * (1 + (Number(l.vatRate) || 0) / 100),
          uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
        };
      });
      const payload = {
        supplierId, invoiceDate: date, paymentMethod,
        cashBoxId: paymentMethod === "cash" ? cashBoxId : null,
        bankId:    paymentMethod === "bank" ? bankId : null,
        warehouseId: warehouseId || null,
        supplierInvoiceNo: supplierInvoiceNo.trim() || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
        lcId: lcId === "" ? null : lcId,
        notes: notes || null, lines: payloadLines,
      };
      const id = isEdit ? (await updatePurchase(seed.editId!, payload), seed.editId!) : await createPurchase(payload);
      emitData("invoices", "journal", "stock", "suppliers", "cashboxes", "banks");
      // Refresh the discount overlay for this invoice (clear stale, then save).
      clearDocDiscount("purchase", id);
      saveDocDiscount("purchase", id, {
        grossSubtotal: r.grossSubtotal * effRate, lineDiscountTotal: r.lineDiscountTotal * effRate, headerDiscountValue: r.headerDiscountValue * effRate,
        currencyCode: currency, exchangeRate: effRate,
      });
      onDone();
    } catch (e: any) { setErr(typeof e === "string" ? e : (e?.message ?? "فشل")); }
    finally { setBusy(false); }
  }

  return (
    <div style={docFormShell}>
      <h3 style={{ marginTop: 0, flexShrink: 0 }}>{isEdit ? `تعديل فاتورة الشراء` : "فاتورة شراء جديدة"}</h3>
      <style>{`.zlines-wrap thead th{position:sticky;top:0;z-index:2;}`}</style>
      <FormTabs active={activeTab} onChange={setActiveTab} tabs={[
        { key: "basic", label: "البيانات الأساسية" },
        { key: "lines", label: `بنود الأصناف${lines.length ? ` (${lines.length})` : ""}` },
        { key: "payments", label: "المدفوعات" },
      ]} />

      <div style={contentPanel(activeTab, "basic")}>
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
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="رقم فاتورة المورد">
          <input value={supplierInvoiceNo} onChange={(e) => setSupplierInvoiceNo(e.target.value)} style={input} placeholder="مرجع المورد" />
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
        <Field label="الاعتماد المستندي">
          <SearchCombobox
            value={lcId}
            onChange={(v) => setLcId(v === "" ? "" : Number(v))}
            style={input}
            options={[
              { value: "", label: "— بدون —" },
              ...deps.lcs
                .filter((lc) => (lc.supplierId === supplierId) && (lc.status !== "closed" || lc.id === seed.lcId))
                .map((lc) => ({ value: lc.id, label: `${lc.lcNumber} — ${lc.supplierName ?? ""}`, hint: lc.status })),
            ]}
          />
        </Field>
        <CurrencyExchangeFields currency={currency} exchangeRate={exchangeRate} onCurrency={setCurrency} onRate={setExchangeRate} />
      </div>
      </div>

      <div style={linesPanel(activeTab)}>
      <div className="zlines-wrap" style={{ ...linesScroll, marginTop: 10 }}>
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
              <Td><LineDiscountCell amount={l.disc ?? 0} type={l.discType ?? "percent"} gross={(Number(l.qty) || 0) * (Number(l.unitCost) || 0)} sym={docSym} onAmount={(v) => setLine(i, { disc: v })} onType={(t) => setLine(i, { discType: t })} /></Td>
              <Td><input type="number" step="0.01" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td num>{fmt(l.lineTotal)}</Td>
              <Td><button onClick={() => removeLine(i)} style={{ ...btnLink, color: "#dc2626" }}>×</button></Td>
            </tr>
          ))}
        </tbody>
      </Table>
      </div>
      <button onClick={addLine} type="button" style={{ ...btnSecondary, marginTop: 8, flexShrink: 0 }}>+ سطر</button>
      <div style={docFormPinned}>
      <InvoiceTotals result={result} headerDisc={headerDisc} headerType={headerDiscType} sym={docSym} rate={effRate} onHeaderDisc={setHeaderDisc} onHeaderType={setHeaderDiscType} />
      </div>
      </div>

      <div style={contentPanel(activeTab, "payments")}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px", alignItems: "start" }}>
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
      <Field label="ملاحظات" style={{ marginTop: 12 }}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} />
      </Field>
      </div>

      <div style={docFormPinned}>
      <ValidationPanel issues={issues} />
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : (isEdit ? "حفظ التعديلات" : "حفظ وترحيل")}</button>
      </Actions>
      </div>
    </div>
  );
}
