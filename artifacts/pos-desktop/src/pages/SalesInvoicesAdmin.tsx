import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  listSalesInvoices, getSalesInvoice, createSalesInvoice, updateSalesInvoice, deleteSalesInvoice,
  unpostSalesInvoice, postSalesInvoice, listCashBoxes, listBanks, listFinancialTx,
  type SalesInvoice, type SalesLine, type PaymentMethod, type CashBox, type Bank,
} from "../lib/accounting";
import { listCustomers, type LocalCustomer } from "../lib/customers";
import { emitData } from "../lib/dataBus";
import { listItems, type LocalItem } from "../lib/items";
import { listUom, type Uom } from "../lib/uom";
import { listWarehouses, type Warehouse } from "../lib/inventory";
import { listSalespersons, type Salesperson } from "../lib/salespersons";
import { printSalesDoc, type PrintDoc } from "../lib/invoicePrint";
import { openWhatsApp, buildDocWhatsAppText } from "../lib/whatsapp";
import { getCompanyProfile } from "../lib/appSettings";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty, Pagination, pageSlice,
  input, btnPrimary, btnSecondary, btnLink, actionChip, fmt, todayStr, SearchCombobox,
  LineDiscountCell, InvoiceTotals, CurrencyExchangeFields,
  useGridFilter, GridToolbar, SortableTh, GridFilterRow, type GridColumn,
  ExportButtons, gridToExportCols,
} from "./_adminUi";
import { ValidationPanel, collectDocIssues } from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { useInvoiceTaxes } from "./_invoiceTax";
import { baseCurrencyCode, currencyByCode } from "../lib/currency";
import {
  computeDiscount, lineNet, saveDocDiscount, getDocDiscount,
  type DiscType, type DiscFields,
} from "../lib/discount";
import { isZatcaCountry, bridgeSalesInvoiceToZatca } from "../lib/zatcaBridge";
import { setSalesReturnPrefill } from "../lib/returnPrefill";
import { type WindowsView } from "../lib/moduleRegistry";

type FLine = SalesLine & DiscFields;

export default function SalesInvoicesAdmin({ onNavigate }: { onNavigate?: (v: WindowsView) => void }) {
  const [rows, setRows] = useState<SalesInvoice[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<SalesInvoice | null>(null);
  const [creating, setCreating] = useState(false);
  const [editDoc, setEditDoc] = useState<SalesInvoice | null>(null);
  const formOpen = creating || editDoc != null;
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [deps, setDeps] = useState<{ customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[]; salespersons: Salesperson[] } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // Paid-so-far per invoice: Σ posted receipts tagged appliedDocType=sales_invoice.
  const [paidByInvoice, setPaidByInvoice] = useState<Map<number, number>>(new Map());

  async function refresh() {
    const [invs, tx] = await Promise.all([listSalesInvoices(5000), listFinancialTx(5000)]);
    setRows(invs);
    const m = new Map<number, number>();
    for (const t of tx) {
      if (t.txType === "receipt" && t.appliedDocType === "sales_invoice" && t.appliedDocId != null) {
        m.set(t.appliedDocId, (m.get(t.appliedDocId) ?? 0) + t.amount);
      }
    }
    setPaidByInvoice(m);
  }

  // ZATCA-bridged invoices are legally immutable → block edit/delete and steer
  // the user to a credit-note return instead. `zatcaStatus` is the linked
  // offline_invoices sync state; any non-null value means it reached the bridge.
  function bridgedMsg(): string {
    return "هذه الفاتورة مرتبطة بزاتكا ولا يمكن تعديلها أو حذفها قانونياً. استخدم زر «إرجاع» لإنشاء إشعار دائن.";
  }

  async function startEdit(id: number) {
    setErr(null);
    setBusyId(id);
    try {
      const inv = await getSalesInvoice(id);
      if (inv.zatcaStatus) { setErr(bridgedMsg()); return; }
      setCreating(false);
      setEditDoc(inv);
    } catch (e: any) { setErr(e?.message ?? "تعذّر تحميل الفاتورة"); }
    finally { setBusyId(null); }
  }

  async function remove(id: number, invoiceNo: string, zatcaStatus?: string | null) {
    setErr(null);
    if (zatcaStatus) { setErr(bridgedMsg()); return; }
    if (!confirm(`حذف الفاتورة ${invoiceNo}؟`)) return;
    setBusyId(id);
    try {
      await deleteSalesInvoice(id);
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
    } catch (e: any) { setErr(e?.message ?? "تعذّر حذف الفاتورة"); }
    finally { setBusyId(null); }
  }

  // فك الترحيل: reverse a posted invoice's GL/stock/AR impact, leaving it as an
  // editable draft. ترحيل: re-apply a draft's impact. Both refresh the list.
  async function unpost(id: number, invoiceNo: string) {
    setErr(null);
    if (!confirm(`فك ترحيل الفاتورة ${invoiceNo}؟ سيتم عكس القيد المحاسبي والمخزون وتتحول إلى مسودة قابلة للتعديل.`)) return;
    setBusyId(id);
    try {
      await unpostSalesInvoice(id);
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
    } catch (e: any) { setErr(e?.message ?? "تعذّر فك الترحيل"); }
    finally { setBusyId(null); }
  }
  async function post(id: number, invoiceNo: string) {
    setErr(null);
    if (!confirm(`ترحيل الفاتورة ${invoiceNo}؟ سيتم توليد القيد المحاسبي وخصم المخزون.`)) return;
    setBusyId(id);
    try {
      await postSalesInvoice(id);
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
    } catch (e: any) { setErr(e?.message ?? "تعذّر الترحيل"); }
    finally { setBusyId(null); }
  }
  // Per-row A4 print: list rows don't carry lines, so load the full invoice first.
  async function printRow(id: number) {
    setErr(null);
    setBusyId(id);
    try {
      const inv = await getSalesInvoice(id);
      await printSalesDoc("a4", invoiceToPrintDoc(inv));
    } catch (e: any) { setErr(e?.message ?? "تعذّر طباعة الفاتورة"); }
    finally { setBusyId(null); }
  }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [customers, cashBoxes, banks, items, warehouses, salespersons] = await Promise.all([listCustomers(), listCashBoxes(), listBanks(), listItems(), listWarehouses(), listSalespersons(false)]);
      setDeps({ customers, cashBoxes, banks, items, warehouses, salespersons });
    })();
  }, []);

  const zatca = isZatcaCountry();
  const columns = useMemo<GridColumn<SalesInvoice>[]>(() => {
    const base: GridColumn<SalesInvoice>[] = [
      { key: "invoiceNo", label: "رقم الفاتورة", value: (p) => p.invoiceNo },
      { key: "date", label: "التاريخ", value: (p) => p.invoiceDate },
      { key: "customer", label: "العميل", value: (p) => p.customerName ?? "نقدي/بدون عميل" },
      { key: "payment", label: "طريقة الدفع", value: (p) => p.paymentMethod },
      { key: "status", label: "الحالة", value: (p) => p.status ?? "" },
    ];
    if (zatca) base.push({ key: "zatca", label: "زاتكا", value: (p) => p.zatcaStatus ?? "" });
    base.push(
      { key: "subtotal", label: "المجموع", type: "number", value: (p) => p.subtotal },
      { key: "vat", label: "الضريبة", type: "number", value: (p) => p.vatTotal },
      { key: "grand", label: "الإجمالي", type: "number", value: (p) => p.grandTotal },
      { key: "paid", label: "المسدّد", type: "number", value: (p) => paidByInvoice.get(p.id) ?? 0 },
    );
    return base;
  }, [zatca, paidByInvoice]);
  const grid = useGridFilter(rows, columns);

  const { start, end, page: clampedPage } = pageSlice(grid.view.length, page, pageSize);
  const pageRows = grid.view.slice(start, end);
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);
  useEffect(() => { setPage(1); }, [grid.search, grid.columnFilters, grid.sort]);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getSalesInvoice(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  // إرجاع: hand the sales-return screen a prefill built from the PERSISTED
  // invoice (authoritative qty/price/uom), then navigate there. Works for
  // ZATCA-bridged invoices too — a credit-note return is the compliant reversal.
  async function startReturn(id: number) {
    const inv = await getSalesInvoice(id);
    setSalesReturnPrefill({
      invoiceId: inv.id,
      customerId: inv.customerId,
      paymentMethod: inv.paymentMethod,
      warehouseId: inv.lines.find((l) => l.warehouseId != null)?.warehouseId ?? null,
      lines: inv.lines.map((l) => ({
        itemId: l.itemId, itemName: l.itemName, qty: l.qty, unitPrice: l.unitPrice,
        vatRate: l.vatRate, lineTotal: l.lineTotal,
        uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
      })),
    });
    onNavigate?.("sales_returns");
  }

  return (
    <Page
      title="فواتير المبيعات"
      subtitle={`${rows.length} فاتورة — يتم ترحيل قيد المبيعات وتكلفة البضاعة المباعة تلقائياً عند الحفظ`}
      right={
        <button onClick={() => setCreating(true)} disabled={!deps || formOpen}
          style={{ ...btnPrimary, opacity: (!deps || formOpen) ? 0.5 : 1, cursor: (!deps || formOpen) ? "not-allowed" : "pointer" }}>
          + فاتورة مبيعات
        </button>
      }
    >
      <ErrorMsg text={err} />
      {formOpen && deps && (
        <Card style={{ marginBottom: 12, border: "2px solid #2563eb" }}>
          <div style={{ padding: 16 }}>
            <CreateForm key={editDoc?.id ?? "new"} deps={deps} initial={editDoc}
              onCancel={() => { setCreating(false); setEditDoc(null); }}
              onDone={() => { setCreating(false); setEditDoc(null); void refresh(); }} />
          </div>
        </Card>
      )}
      {rows.length > 0 && !formOpen && <GridToolbar grid={grid} placeholder="🔍 بحث في فواتير المبيعات…" extra={<ExportButtons columns={gridToExportCols(columns)} rows={grid.view} filenameBase="فواتير-المبيعات" title="فواتير المبيعات" />} />}
      <Card>
        {rows.length === 0 && !formOpen ? <Empty text="لا توجد فواتير مبيعات" /> : grid.view.length === 0 ? <Empty text="لا نتائج مطابقة للبحث" /> : (
          <Table>
            <thead>
              <tr>
                <SortableTh grid={grid} colKey="invoiceNo">رقم الفاتورة</SortableTh>
                <SortableTh grid={grid} colKey="date">التاريخ</SortableTh>
                <SortableTh grid={grid} colKey="customer">العميل</SortableTh>
                <SortableTh grid={grid} colKey="payment">طريقة الدفع</SortableTh>
                <SortableTh grid={grid} colKey="status">الحالة</SortableTh>
                {zatca && <SortableTh grid={grid} colKey="zatca">زاتكا</SortableTh>}
                <SortableTh grid={grid} colKey="subtotal" style={{ textAlign: "left" }}>المجموع</SortableTh>
                <SortableTh grid={grid} colKey="vat" style={{ textAlign: "left" }}>الضريبة</SortableTh>
                <SortableTh grid={grid} colKey="grand" style={{ textAlign: "left" }}>الإجمالي</SortableTh>
                <SortableTh grid={grid} colKey="paid" style={{ textAlign: "left" }}>المسدّد / المتبقّي</SortableTh>
                <Th style={{ width: 100 }}></Th>
              </tr>
              <GridFilterRow grid={grid} columns={columns} trailing={1} />
            </thead>
            <tbody>
              {pageRows.map((p) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <Td mono>{p.invoiceNo}</Td>
                    <Td>{p.invoiceDate}</Td>
                    <Td>{p.customerName ?? "نقدي/بدون عميل"}</Td>
                    <Td><PayBadge m={p.paymentMethod} /></Td>
                    <Td><StatusBadge status={p.status} /></Td>
                    {isZatcaCountry() && <Td><ZatcaBadge status={p.zatcaStatus} /></Td>}
                    <Td num>{fmt(p.subtotal)}</Td>
                    <Td num>{fmt(p.vatTotal)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                    <Td num>{paidCell(p, paidByInvoice.get(p.id) ?? 0)}</Td>
                    <Td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                        <button onClick={() => void toggleView(p.id)} disabled={formOpen} aria-expanded={expandedId === p.id}
                          style={actionChip("default", formOpen)}>
                          {expandedId === p.id ? "▲ إخفاء" : "▼ عرض"}
                        </button>
                        <button onClick={() => void printRow(p.id)} disabled={busyId === p.id || formOpen} title="طباعة الفاتورة A4"
                          style={actionChip("primary", busyId === p.id || formOpen)}>
                          🖨️ طباعة
                        </button>
                        {onNavigate && (
                          <button onClick={() => void startReturn(p.id)} disabled={formOpen} title="إنشاء مرتجع من هذه الفاتورة"
                            style={actionChip("warn", formOpen)}>
                            ↩ إرجاع
                          </button>
                        )}
                        {p.zatcaStatus ? (
                          <span title={bridgedMsg()} style={{ fontSize: 12, color: "#94a3b8" }}>🔒 مُرحّلة لزاتكا</span>
                        ) : p.status === "draft" ? (
                          <>
                            <button onClick={() => void post(p.id, p.invoiceNo)} disabled={busyId === p.id || formOpen} title="ترحيل الفاتورة" style={actionChip("success", busyId === p.id || formOpen)}>✔ ترحيل</button>
                            <button onClick={() => void startEdit(p.id)} disabled={busyId === p.id || formOpen} title="تعديل الفاتورة" style={actionChip("default", busyId === p.id || formOpen)}>✎ تعديل</button>
                            <button onClick={() => void remove(p.id, p.invoiceNo, p.zatcaStatus)} disabled={busyId === p.id || formOpen} title="حذف الفاتورة" style={actionChip("danger", busyId === p.id || formOpen)}>حذف</button>
                          </>
                        ) : (
                          <button onClick={() => void unpost(p.id, p.invoiceNo)} disabled={busyId === p.id || formOpen} title="فك الترحيل لتعديل أو حذف الفاتورة" style={actionChip("warn", busyId === p.id || formOpen)}>↺ فك الترحيل</button>
                        )}
                      </div>
                    </Td>
                  </tr>
                  {expandedId === p.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={11 as any}>
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
          <Pagination total={grid.view.length} page={page} pageSize={pageSize}
            onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
        )}
      </Card>
    </Page>
  );
}

// المسدّد / المتبقّي cell: cash/bank invoices are settled at sale → "مدفوعة".
// Credit invoices show Σ collected (تحصيل) and the outstanding remainder.
function paidCell(p: SalesInvoice, paid: number) {
  if (p.paymentMethod !== "credit") return <span style={{ color: "#15803d" }}>مدفوعة</span>;
  const remaining = p.grandTotal - paid;
  if (paid <= 0.005) return <span style={{ color: "#b45309" }}>غير مسدّدة</span>;
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

// Posting state badge: a draft has its impact reversed (no GL/stock effect) and
// is editable; posted is the normal, locked state. Absent status ⇒ posted.
function StatusBadge({ status }: { status?: string }) {
  const draft = status === "draft";
  const c = draft ? "#b45309" : "#15803d";
  return <span style={{ background: c + "20", color: c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{draft ? "مسودة" : "مُرحّلة"}</span>;
}

// ZATCA sync state of the linked offline_invoices row. `null` = not bridged
// (non-Saudi installs, or the bridge hasn't run yet).
function ZatcaBadge({ status }: { status?: string | null }) {
  if (!status) return <span style={{ color: "#94a3b8", fontSize: 12 }}>—</span>;
  const synced = status === "synced" || status === "submitted" || status === "cleared" || status === "reported";
  const c = synced ? "#15803d" : "#b45309";
  const label = synced ? "مُرسلة" : "بانتظار الرفع";
  return <span style={{ background: c + "20", color: c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{label}</span>;
}

function SalesDetail({ p }: { p: SalesInvoice }) {
  const disc = getDocDiscount("sales_invoice", p.id);
  const discTotal = disc ? (disc.lineDiscountTotal + disc.headerDiscountValue) : 0;
  return (
    <div style={{ padding: 12 }}>
      <Table>
        <thead><tr><Th>الصنف</Th><Th>الوحدة</Th><Th style={{ textAlign: "left" }}>الكمية</Th><Th style={{ textAlign: "left" }}>سعر الوحدة</Th><Th style={{ textAlign: "left" }}>الضريبة %</Th><Th style={{ textAlign: "left" }}>الإجمالي</Th></tr></thead>
        <tbody>
          {p.lines.map((l, i) => (
            <tr key={l.id ?? i}>
              <Td>{l.itemName}</Td><Td>{l.uomName ?? ""}</Td><Td num>{l.qty}</Td><Td num>{fmt(l.unitPrice)}</Td><Td num>{l.vatRate}</Td><Td num>{fmt(l.lineTotal)}</Td>
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
          <tr style={{ background: "#fff", color: "#64748b" }}><Td colSpan={5 as any}>تكلفة البضاعة المباعة</Td><Td num>{fmt(p.cogsTotal)}</Td></tr>
          {isZatcaCountry() && p.zatcaQrBase64 && (
            <tr style={{ background: "#fff" }}>
              <Td colSpan={5 as any}>زاتكا</Td>
              <Td>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <ZatcaBadge status={p.zatcaStatus ?? "pending"} />
                  <span style={{ color: "#15803d", fontSize: 12 }}>✓ تم توليد رمز QR وإدراج الفاتورة في طابور الإرسال لزاتكا</span>
                </span>
              </Td>
            </tr>
          )}
        </tbody>
      </Table>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={() => void printSalesDoc("a4", invoiceToPrintDoc(p))} style={btnSecondary}>🖨️ طباعة A4</button>
        <button onClick={() => void printSalesDoc("thermal", invoiceToPrintDoc(p))} style={btnSecondary}>🧾 طباعة حرارية</button>
        <button onClick={() => openWhatsApp(buildDocWhatsAppText({ kind: "invoice", companyName: getCompanyProfile().name, docNo: p.invoiceNo, date: p.invoiceDate, grandTotal: p.grandTotal, customerName: p.buyerName ?? p.customerName }))} style={{ ...btnSecondary, color: "#075e54", borderColor: "#25d366" }}>💬 واتساب</button>
      </div>
    </div>
  );
}

function invoiceToPrintDoc(p: SalesInvoice): PrintDoc {
  return {
    kind: "invoice",
    docNo: p.invoiceNo,
    date: p.invoiceDate,
    customerName: p.buyerName ?? p.customerName,
    customerVat: p.buyerVat ?? null,
    paymentMethod: p.paymentMethod,
    subtotal: p.subtotal,
    vatTotal: p.vatTotal,
    grandTotal: p.grandTotal,
    notes: p.notes,
    lines: p.lines,
    qrBase64: p.zatcaQrBase64 ?? null,
  };
}

function CreateForm({ deps, initial, onCancel, onDone }: {
  deps: { customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[]; salespersons: Salesperson[] };
  initial?: SalesInvoice | null;
  onCancel: () => void; onDone: () => void;
}) {
  const isEdit = !!initial;
  const [customerId, setCustomerId] = useState<number>(initial?.customerId ?? 0);
  const [date, setDate] = useState(initial?.invoiceDate ?? todayStr());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(initial?.paymentMethod ?? "cash");
  const [cashBoxId, setCashBoxId] = useState<number | null>(initial?.cashBoxId ?? deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(initial?.bankId ?? deps.banks[0]?.id ?? null);
  const [warehouseId, setWarehouseId] = useState<number>(
    // SalesInvoice has no header warehouse — derive it from the first line that
    // carries one (all lines share the header warehouse on save).
    initial?.lines.find((l) => l.warehouseId != null)?.warehouseId
      ?? (deps.warehouses.find((w) => w.is_default) ?? deps.warehouses[0])?.id ?? 0,
  );
  const { branches, costCenters } = useDimensions();
  const [branchId, setBranchId] = useState<number | "">(initial?.branchId ?? "");
  // Auto-select the only branch when a single one exists (it acts as the default).
  useEffect(() => { if (!isEdit && branchId === "" && branches.length === 1) setBranchId(branches[0].id); }, [branches]); // eslint-disable-line react-hooks/exhaustive-deps
  const [costCenterId, setCostCenterId] = useState<number | "">(initial?.costCenterId ?? "");
  const [salesRepId, setSalesRepId] = useState<number | "">(initial?.salesRepId ?? "");
  // ZATCA doc type: simplified (B2C) default, standard (B2B) requires buyer VAT.
  const [invoiceType, setInvoiceType] = useState<"simplified" | "standard">(
    (initial?.invoiceType as "simplified" | "standard") ?? "simplified",
  );
  const [buyerName, setBuyerName] = useState(initial?.buyerName ?? "");
  const [buyerVat, setBuyerVat] = useState(initial?.buyerVat ?? "");
  const [buyerAddress, setBuyerAddress] = useState(initial?.buyerAddress ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [uoms] = useState<Uom[]>(() => listUom());
  const defUom = uoms.find((u) => u.isDefault) ?? uoms[0];
  const blankLine = (): FLine => ({
    itemId: 0, qty: 1, unitPrice: 0, vatRate: 15, lineTotal: 0, disc: 0, discType: "percent",
    uomId: defUom?.id ?? null, uomName: defUom?.nameAr ?? null, conversionFactor: defUom?.baseQty ?? 1,
  });
  // Stored line unitPrice is already NET (discount baked in at create) — the
  // pre-discount breakdown isn't round-tripped, so edit re-opens with disc=0.
  const [lines, setLines] = useState<FLine[]>(() =>
    initial && initial.lines.length
      ? initial.lines.map((l) => ({ ...l, disc: 0, discType: "percent" as DiscType }))
      : [blankLine()],
  );
  const [headerDisc, setHeaderDisc] = useState(0);
  const [headerDiscType, setHeaderDiscType] = useState<DiscType>("percent");
  const [currency, setCurrency] = useState<string>(() => baseCurrencyCode());
  const [exchangeRate, setExchangeRate] = useState<number>(1);
  const effRate = currency === baseCurrencyCode() ? 1 : (exchangeRate || 1);
  const docSym = currencyByCode(currency).symbol;
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Once the invoice is persisted we keep its id so a ZATCA-bridge failure can
  // be retried (click حفظ again) WITHOUT creating a duplicate invoice.
  const [savedId, setSavedId] = useState<number | null>(null);
  const { taxes, taxId, setTaxId, taxOptions, selectedRate } = useInvoiceTaxes("sales");

  // ── Enter-to-advance focus navigation ───────────────────────────────
  // Every focusable field carries data-fnav; pressing Enter jumps to the
  // next one in document order (and selects its text for quick overwrite).
  const formRef = useRef<HTMLDivElement | null>(null);
  function advanceFrom(el: HTMLElement | null) {
    const root = formRef.current;
    if (!root || !el) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-fnav]"));
    const i = nodes.indexOf(el);
    if (i === -1) return;
    // Walk forward to the next *focusable* node: skip disabled or hidden
    // controls (e.g. locked fields, collapsed rows) so focus never stalls.
    for (let j = i + 1; j < nodes.length; j++) {
      const nxt = nodes[j];
      const disabled = (nxt as HTMLInputElement).disabled === true || nxt.getAttribute("aria-disabled") === "true";
      const hidden = nxt.offsetParent === null;
      if (disabled || hidden) continue;
      nxt.focus();
      if (document.activeElement === nxt) { (nxt as HTMLInputElement).select?.(); return; }
    }
  }
  const onEnterAdv = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter") { e.preventDefault(); advanceFrom(e.currentTarget); }
  };
  // Spread onto native inputs / comboboxes to enrol them in the Enter chain.
  const navInput = { className: "zfield", "data-fnav": "1", onKeyDown: onEnterAdv } as const;
  const navCombo = { navAttr: "1", inputClassName: "zfield", onEnterNavigate: (el: HTMLElement | null) => advanceFrom(el) } as const;

  const selectedCustomer = deps.customers.find((c) => c.id === customerId) ?? null;

  // In edit mode the first customerId effect would clobber the persisted buyer
  // snapshot / invoiceType with the live customer record — skip exactly once.
  const skipCustomerFill = useRef(isEdit);
  // Freeze a buyer snapshot from the chosen customer (editable afterwards), and
  // auto-pick the ZATCA doc type: a customer with a VAT number ⇒ standard (B2B).
  useEffect(() => {
    if (skipCustomerFill.current) { skipCustomerFill.current = false; return; }
    if (!selectedCustomer) {
      setBuyerName(""); setBuyerVat(""); setBuyerAddress(""); setInvoiceType("simplified");
      return;
    }
    setBuyerName(selectedCustomer.nameAr ?? "");
    setBuyerVat(selectedCustomer.vatNumber ?? "");
    const addr = [selectedCustomer.street, selectedCustomer.district, selectedCustomer.city]
      .filter((x) => x && String(x).trim()).join("، ");
    setBuyerAddress(addr);
    setInvoiceType(selectedCustomer.vatNumber ? "standard" : "simplified");
  }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  function setLine(i: number, patch: Partial<FLine>) {
    setLines((ls) => ls.map((l, k) => {
      if (k !== i) return l;
      const next = { ...l, ...patch };
      // Auto-fill sale price + vat from the chosen item, and default its unit.
      if (patch.itemId !== undefined) {
        const it = deps.items.find((x) => x.id === Number(patch.itemId));
        if (it) {
          if (!next.unitPrice) next.unitPrice = it.salePrice ?? 0;
          next.vatRate = it.vatRate ?? next.vatRate;
          if (it.uomId != null) {
            const u = uoms.find((x) => x.id === it.uomId);
            if (u) { next.uomId = u.id; next.uomName = u.nameAr; next.conversionFactor = u.baseQty; }
          }
        }
      }
      // Unit change: price stays per SELECTED unit; factor only affects stock/COGS.
      if (patch.uomId !== undefined) {
        const u = uoms.find((x) => x.id === Number(patch.uomId));
        if (u) { next.uomName = u.nameAr; next.conversionFactor = u.baseQty; }
      }
      // A selected header tax overrides any per-item/per-line rate so one tax
      // applies to the whole invoice.
      if (selectedRate != null) next.vatRate = selectedRate;
      // Per-line الإجمالي reflects the line discount (header discount is shown
      // separately in the totals panel).
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
        { label: "طريقة الدفع", ok: !!paymentMethod },
        { label: "العميل", ok: paymentMethod !== "credit" || !!customerId },
        { label: "العملة", ok: !!currency },
        ...(branches.length ? [{ label: "الفرع", ok: branchId !== "" }] : []),
        { label: "المستودع", ok: !!warehouseId },
      ], lines.map((l) => ({ itemId: l.itemId, uomId: l.uomId ?? null, price: l.unitPrice, qty: l.qty })), "سعر البيع");
      if (problems.length) { setIssues(problems); setBusy(false); return; }
      const cleaned = lines.filter((l) => l.itemId && (l.qty || 0) > 0);
      if (currency !== baseCurrencyCode() && !(exchangeRate > 0)) throw new Error("أدخل سعر صرف صحيح للعملة الأجنبية");
      // Fold the discount into each unit price; Rust recomputes totals from
      // qty × unitPrice so VAT lands on the net base (ZATCA-correct).
      const r = computeDiscount(
        cleaned.map((l) => ({ qty: l.qty, unit: l.unitPrice, vatRate: l.vatRate, disc: l.disc, discType: l.discType })),
        headerDisc, headerDiscType,
      );
      const payloadLines: SalesLine[] = cleaned.map((l, i) => {
        // Bake discount AND the FX conversion into the base-currency unit
        // price (Rust stores/recomputes in the base currency only).
        const net = r.netUnitPrices[i] * effRate;
        return {
          itemId: l.itemId, itemName: l.itemName, qty: l.qty, unitPrice: net, vatRate: l.vatRate,
          lineTotal: l.qty * net * (1 + (Number(l.vatRate) || 0) / 100),
          uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
          freeQty: l.freeQty || 0, note: l.note?.trim() ? l.note.trim() : null,
        };
      });
      const payload = {
        customerId: customerId || null, invoiceDate: date, paymentMethod,
        cashBoxId: paymentMethod === "cash" ? cashBoxId : null,
        bankId:    paymentMethod === "bank" ? bankId : null,
        warehouseId: warehouseId || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
        salesRepId: salesRepId === "" ? null : salesRepId,
        commissionPct: salesRepId === "" ? null : (deps.salespersons.find((s) => s.id === salesRepId)?.commissionPct ?? 0),
        invoiceType,
        buyerName: invoiceType === "standard" ? (buyerName.trim() || null) : null,
        buyerVat: invoiceType === "standard" ? (buyerVat.trim() || null) : null,
        buyerAddress: invoiceType === "standard" ? (buyerAddress.trim() || null) : null,
        notes: notes || null, lines: payloadLines,
      };
      const discOverlay = {
        grossSubtotal: r.grossSubtotal * effRate, lineDiscountTotal: r.lineDiscountTotal * effRate, headerDiscountValue: r.headerDiscountValue * effRate,
        currencyCode: currency, exchangeRate: effRate,
      };
      // EDIT path: bridged invoices are blocked upstream, so this is always a
      // non-bridged invoice. The Rust update reverses the old GL + stock +
      // shadow-balance impact and re-applies fresh impact, keeping id +
      // invoice_no. ALWAYS re-run the update (no `savedId` short-circuit) so
      // repeated saves persist the latest edits; the ZATCA bridge is skipped on
      // edit (an already-bridged invoice can never reach here).
      if (isEdit && initial) {
        await updateSalesInvoice(initial.id, payload);
        saveDocDiscount("sales_invoice", initial.id, discOverlay);
        onDone();
        return;
      }
      // CREATE path. On a ZATCA-bridge retry `savedId` is already set so we
      // skip the (duplicating) create + discount write and only re-run the
      // bridge.
      let id = savedId;
      if (id == null) {
        id = await createSalesInvoice(payload);
        setSavedId(id);
        saveDocDiscount("sales_invoice", id, discOverlay);
        emitData("invoices", "journal", "stock", "customers", "cashboxes", "banks");
      }
      // ZATCA bridge (Saudi installs only): generate the TLV QR and enqueue the
      // invoice into the existing offline_invoices → cloud-sync submission path.
      // Best-effort: the invoice is already saved, so a bridge failure is shown
      // as a non-fatal warning and can be retried by clicking حفظ again.
      if (isZatcaCountry()) {
        try {
          // Totals + lines are read back from the persisted invoice inside the
          // bridge, so the QR/payload match exactly what was stored (no drift).
          await bridgeSalesInvoiceToZatca({
            invoiceId: id,
            paymentMethod,
            customerName: selectedCustomer?.nameAr ?? null,
            customerVat: selectedCustomer?.vatNumber ?? null,
          });
        } catch (e: any) {
          setErr(`تم حفظ الفاتورة لكن تعذّر ربطها بزاتكا. اضغط «حفظ» مرة أخرى لإعادة المحاولة. (${e?.message ?? "خطأ"})`);
          return;
        }
      }
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }

  return (
    <div ref={formRef}>
      <style>{`
        .zfield{transition:border-color .12s ease, box-shadow .12s ease;}
        .zfield:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.18);}
        .zrow:hover td{background:#eff6ff !important;}
      `}</style>
      <h3 style={{ marginTop: 0 }}>{isEdit ? `تعديل الفاتورة ${initial?.invoiceNo ?? ""}` : "فاتورة مبيعات جديدة"}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px", alignItems: "start" }}>
        <Field label="العميل *">
          <SearchCombobox
            value={customerId}
            onChange={(v) => setCustomerId(Number(v))}
            {...navCombo}
            style={input}
            options={[
              { value: 0, label: "— بدون عميل —" },
              ...deps.customers.map((c) => ({ value: c.id, label: c.nameAr })),
            ]}
          />
        </Field>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} {...navInput} /></Field>
        <Field label="طريقة الدفع">
          <SearchCombobox
            value={paymentMethod}
            onChange={(v) => setPaymentMethod(v as PaymentMethod)}
            {...navCombo}
            style={input}
            options={[
              { value: "cash", label: "نقدي" },
              { value: "bank", label: "بنك" },
              { value: "credit", label: "آجل (على الحساب)" },
            ]}
          />
        </Field>
        <Field label="المستودع">
          <SearchCombobox
            value={warehouseId}
            onChange={(v) => setWarehouseId(Number(v))}
            {...navCombo}
            style={input}
            options={[
              { value: 0, label: "— المستودع الافتراضي —" },
              ...deps.warehouses.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />
        </Field>
        <Field label="الضريبة">
          <SearchCombobox value={taxId} onChange={onSelectTax} {...navCombo} options={taxOptions} style={input} />
        </Field>
        <Field label="الفرع">
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} {...navCombo} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label="مركز التكلفة">
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} {...navCombo} options={costCenterPickerOptions(costCenters)} style={input} />
        </Field>
        <Field label="مندوب المبيعات">
          <SearchCombobox
            value={salesRepId}
            onChange={(v) => setSalesRepId(v === "" ? "" : Number(v))}
            {...navCombo}
            style={input}
            options={[
              { value: "", label: "— بدون —" },
              ...deps.salespersons.map((s) => ({ value: s.id, label: s.nameAr })),
            ]}
          />
        </Field>
        {isZatcaCountry() && (
        <Field label="نوع الفاتورة (زاتكا)">
          <SearchCombobox
            value={invoiceType}
            onChange={(v) => setInvoiceType(v as "simplified" | "standard")}
            {...navCombo}
            style={input}
            options={[
              { value: "simplified", label: "مبسّطة (B2C)" },
              { value: "standard", label: "ضريبية (B2B)" },
            ]}
          />
        </Field>
        )}
        <CurrencyExchangeFields currency={currency} exchangeRate={exchangeRate} onCurrency={setCurrency} onRate={setExchangeRate} />
        {paymentMethod === "cash" && (
          <Field label="الخزينة">
            <SearchCombobox
              value={cashBoxId ?? ""}
              onChange={(v) => setCashBoxId(Number(v) || null)}
              {...navCombo}
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
              {...navCombo}
              style={input}
              options={deps.banks.map((b) => ({ value: b.id, label: b.name }))}
            />
          </Field>
        )}
        {invoiceType === "standard" && (
          <div style={{ gridColumn: "1 / -1", marginBottom: 10, padding: 10, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>بيانات المشتري (للفاتورة الضريبية)</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px" }}>
              <Field label="اسم المشتري">
                <input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} style={input} {...navInput} />
              </Field>
              <Field label="الرقم الضريبي للمشتري">
                <input value={buyerVat} onChange={(e) => setBuyerVat(e.target.value)} style={input} {...navInput} />
              </Field>
              <Field label="عنوان المشتري">
                <input value={buyerAddress} onChange={(e) => setBuyerAddress(e.target.value)} style={input} {...navInput} />
              </Field>
            </div>
          </div>
        )}
        {selectedCustomer && paymentMethod === "credit" && (selectedCustomer.enforceCreditLimit || (selectedCustomer.creditLimit ?? 0) > 0) && (
          <div style={{ gridColumn: "1 / -1", marginBottom: 10, padding: "8px 12px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, fontSize: 13, color: "#92400e" }}>
            الرصيد الحالي: <b>{fmt(selectedCustomer.balance ?? 0)}</b>
            {(selectedCustomer.creditLimit ?? 0) > 0 && <> · حد الائتمان: <b>{fmt(selectedCustomer.creditLimit ?? 0)}</b></>}
            {(selectedCustomer.paymentTermsDays ?? 0) > 0 && <> · مدة الاستحقاق: <b>{selectedCustomer.paymentTermsDays} يوم</b></>}
            {selectedCustomer.enforceCreditLimit && <> · <b>المنع مُفعّل</b></>}
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, fontSize: 15, fontWeight: 700, color: "#0f172a" }}>بنود الفاتورة</div>
      <div style={{ overflowX: "auto", marginTop: 8, border: "1px solid #e2e8f0", borderRadius: 10 }}>
      <Table style={{ minWidth: 1290 }}>
        <thead><tr>
          <Th style={{ width: 44, textAlign: "center" }}>#</Th>
          <Th style={{ minWidth: 240 }}>الصنف</Th>
          <Th style={{ width: 130 }}>الوحدة</Th>
          <Th style={{ width: 180, textAlign: "center" }}>الكمية</Th>
          <Th style={{ width: 80, textAlign: "center" }}>مجاني</Th>
          <Th style={{ width: 240, textAlign: "center" }}>سعر الوحدة</Th>
          <Th style={{ width: 170 }}>الخصم</Th>
          <Th style={{ width: 80, textAlign: "center" }}>ض. %</Th>
          <Th style={{ width: 150 }}>ملاحظة</Th>
          <Th style={{ width: 130, textAlign: "left" }}>الإجمالي</Th>
          <Th style={{ width: 40 }}></Th>
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className="zrow" style={{ background: i % 2 ? "#fbfdff" : "#fff" }}>
              <Td style={{ textAlign: "center", color: "#94a3b8", fontWeight: 600 }}>{i + 1}</Td>
              <Td>
                <SearchCombobox
                  value={l.itemId}
                  onChange={(v) => setLine(i, { itemId: Number(v) })}
                  {...navCombo}
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
                  {...navCombo}
                  style={input}
                  options={uoms.map((u) => ({ value: u.id, label: u.baseQty !== 1 ? `${u.nameAr} (×${u.baseQty})` : u.nameAr }))}
                />
              </Td>
              <Td><input type="number" step="0.001" value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })} style={{ ...input, textAlign: "center", fontWeight: 600 }} {...navInput} /></Td>
              <Td><input type="number" step="0.001" value={l.freeQty ?? 0} onChange={(e) => setLine(i, { freeQty: Number(e.target.value) || 0 })} style={{ ...input, textAlign: "center" }} {...navInput} /></Td>
              <Td><input type="number" step="0.01" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) || 0 })} style={{ ...input, textAlign: "center", fontWeight: 600 }} {...navInput} /></Td>
              <Td><LineDiscountCell amount={l.disc ?? 0} type={l.discType ?? "percent"} gross={(Number(l.qty) || 0) * (Number(l.unitPrice) || 0)} sym={docSym} onAmount={(v) => setLine(i, { disc: v })} onType={(t) => setLine(i, { discType: t })} navAttr="1" inputClassName="zfield" onEnterNavigate={(el) => advanceFrom(el)} /></Td>
              <Td><input type="number" step="0.01" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) || 0 })} style={{ ...input, textAlign: "center" }} {...navInput} /></Td>
              <Td><input value={l.note ?? ""} onChange={(e) => setLine(i, { note: e.target.value })} style={input} {...navInput} /></Td>
              <Td num style={{ fontWeight: 700, color: "#0f172a" }}>{docSym} {fmt(l.lineTotal)}</Td>
              <Td><button onClick={() => removeLine(i)} style={{ ...btnLink, color: "#dc2626", fontSize: 18 }}>×</button></Td>
            </tr>
          ))}
        </tbody>
      </Table>
      </div>
      <button onClick={addLine} type="button" style={{ width: "100%", marginTop: 8, padding: "10px 16px", background: "#f8fafc", color: "#2563eb", border: "1px dashed #93c5fd", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600 }}>+ إضافة سطر</button>
      <InvoiceTotals result={result} headerDisc={headerDisc} headerType={headerDiscType} sym={docSym} rate={effRate} onHeaderDisc={setHeaderDisc} onHeaderType={setHeaderDiscType} />

      <Field label="ملاحظات" style={{ marginTop: 12 }}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} />
      </Field>
      <ValidationPanel issues={issues} />
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} type="button" data-fnav="1" style={btnPrimary}>{busy ? "..." : (isEdit ? "حفظ التعديل" : "حفظ وترحيل")}</button>
      </Actions>
    </div>
  );
}
