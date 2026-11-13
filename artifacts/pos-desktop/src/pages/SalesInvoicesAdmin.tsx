import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listSalesInvoices, getSalesInvoice, createSalesInvoice, updateSalesInvoice, deleteSalesInvoice,
  unpostSalesInvoice, postSalesInvoice, listCashBoxes, listBanks, listFinancialTx,
  confirmUnpostAction, getPostingSettings,
  listQuotations, getQuotation, listSalesOrders, getSalesOrder,
  type SalesInvoice, type SalesLine, type PaymentMethod, type CashBox, type Bank,
  type Quotation, type SalesOrder,
} from "../lib/accounting";
import { createCustomer, listCustomers, type LocalCustomer } from "../lib/customers";
import { emitData } from "../lib/dataBus";
import { createItem, listItems, type LocalItem } from "../lib/items";
import QuickCreateDialog from "../components/QuickCreateDialog";
import { DocumentItemPicker, ItemCodeHistoryButton, ItemHistoryDialog, NoCustomerHistoryDialog } from "../components/DocumentItemDialogs";
import {
  listItemBrands, itemHasBrands, saveInvoiceLineBrands, getInvoiceLineBrands, dropInvoiceLineBrands, listBrands, setItemBrands,
} from "../lib/brands";
import { getDefaultUom, listUom, type Uom } from "../lib/uom";
import { listWarehouses, type Warehouse } from "../lib/inventory";
import { listSalespersons, type Salesperson } from "../lib/salespersons";
import { printSalesDoc, type PrintDoc } from "../lib/invoicePrint";
import { openWhatsApp, buildDocWhatsAppText } from "../lib/whatsapp";
import {
  getCompanyProfile, useHideZeros, useShowFreeQuantityColumn, blankIfZero, uiText, useUiLanguage,
  setSalesInvoiceLayout, useSalesInvoiceLayout, type SalesInvoiceLayout,
} from "../lib/appSettings";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Empty, Pagination, pageSlice,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
  LineDiscountCell, InvoiceTotals, CurrencyExchangeFields, DocumentFormHeader,
  documentFormStyles, docFormShell, EmptyItemsRow,
  linesScroll, docFormPinned,
  useGridFilter, GridToolbar, SortableTh, GridFilterRow, type GridColumn,
  ExportButtons, gridToExportCols,
  errText,
  useRowSelect, SelectTh, SelectCell, ActionBar, ActionBtn,
} from "./_adminUi";
import { ValidationPanel, collectDocIssues } from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { useInvoiceTaxes } from "./_invoiceTax";
import { baseCurrencyCode, currencyByCode } from "../lib/currency";
import {
  computeDiscount, lineNet, saveDocDiscount, getDocDiscount,
  clearDocDiscount, type DiscType, type DiscFields,
} from "../lib/discount";
import { isZatcaCountry, bridgeSalesInvoiceToZatca } from "../lib/zatcaBridge";
import { setSalesReturnPrefill } from "../lib/returnPrefill";
import { type WindowsView } from "../lib/moduleRegistry";

type FLine = SalesLine & DiscFields & { unitKey?: string; brandId?: number | null; brandName?: string | null };
type SalesPaymentChoice = PaymentMethod | "mixed";

const salesInvoiceTemplateStyles = `
  .zsales-invoice-single-page{height:auto!important;min-height:0!important;overflow:visible!important;display:block!important;--si-accent:#2563eb;--si-panel:#f7faff;--si-border:#cbd8e8;--si-grid:#edf3fb;--si-radius:8px;--si-density:8px;}
  .zsales-invoice-single-page[data-layout="quick"]{--si-accent:#087f69;--si-panel:#f5faf6;--si-border:#d5e4d9;--si-grid:#e9f3ec;--si-radius:5px;--si-density:6px;}
  .zsales-invoice-single-page[data-layout="modern"]{--si-accent:#c2410c;--si-panel:#fff;--si-border:#d8dee8;--si-grid:#f0f1f2;--si-radius:3px;--si-density:9px;}
  .zsales-invoice-single-page[data-layout="erp"]{--si-accent:#294477;--si-panel:#f1f4f8;--si-border:#b9c5d6;--si-grid:#294477;--si-radius:3px;--si-density:4px;}
  .zsales-invoice-single-page>div:first-of-type{border-color:var(--si-border)!important;border-right-color:var(--si-accent)!important;border-radius:var(--si-radius)!important;background:var(--si-panel)!important;}
  .zsales-invoice-single-page>div:first-of-type strong{color:var(--si-accent)!important;}
  .zsales-invoice-single-page .zsales-layout-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0 10px;padding:8px 10px;border:1px solid var(--si-border);border-radius:var(--si-radius);background:var(--si-panel);}
  .zsales-invoice-single-page .zsales-layout-label{display:flex;flex-direction:column;gap:2px;color:#334155;font-size:12px;font-weight:700;}
  .zsales-invoice-single-page .zsales-layout-label small{color:#64748b;font-size:10px;font-weight:500;}
  .zsales-invoice-single-page .zsales-layout-select{min-width:210px;max-width:340px;height:34px;border:1px solid var(--si-border);border-radius:var(--si-radius);background:#fff;color:#0f172a;padding:4px 9px;font:inherit;font-size:12px;}
  .zsales-invoice-single-page .zsales-source-loader{display:grid;grid-template-columns:minmax(180px,.8fr) minmax(220px,1.2fr) auto;align-items:end;gap:10px;margin:8px 0 10px;padding:10px;border:1px solid var(--si-border);border-inline-start:4px solid var(--si-accent);border-radius:var(--si-radius);background:var(--si-panel);}
  .zsales-invoice-single-page .zsales-source-loader-title{grid-column:1/-1;margin:0;color:#334155;font-size:12px;font-weight:800;}
  .zsales-invoice-single-page .zsales-source-loader-status{grid-column:1/-1;margin:0;font-size:12px;line-height:1.5;}
  .zsales-invoice-single-page .zsales-section{margin:10px 0;padding:10px;border:1px solid var(--si-border);border-radius:var(--si-radius);background:var(--si-panel);}
  .zsales-invoice-single-page .zsales-section-heading{display:flex;align-items:center;justify-content:space-between;gap:9px;margin:0 0 8px;color:#0f172a;}
  .zsales-invoice-single-page .zsales-items-heading-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
  .zsales-invoice-single-page .zsales-items-heading-actions button{min-height:32px;white-space:nowrap;}
  .zsales-invoice-single-page .zsales-section-heading>span,.zsales-invoice-single-page .zsales-items-heading-actions>span{padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--si-accent) 12%,white);color:var(--si-accent);font-size:11px;font-weight:700;}
  .zsales-invoice-single-page .zsales-action-bar{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 8px;padding:7px 8px;border:1px solid var(--si-border);border-radius:var(--si-radius);background:rgba(255,255,255,.97);box-shadow:0 5px 16px #0f172a20;backdrop-filter:blur(8px);}
  .zsales-invoice-single-page .zsales-action-buttons{display:flex;align-items:center;gap:6px;flex:1 1 420px;min-width:0;flex-wrap:wrap;}
  .zsales-invoice-single-page .zsales-action-buttons button{min-height:32px;}
  .zsales-invoice-single-page .zsales-quick-payment{display:flex;align-items:center;gap:8px;flex:1 1 390px;min-width:300px;}
  .zsales-invoice-single-page .zsales-quick-payment-label{font-size:11px;font-weight:700;color:#475569;white-space:nowrap;}
  .zsales-invoice-single-page .zsales-payment-methods{display:grid;grid-template-columns:repeat(4,minmax(54px,1fr));gap:4px;flex:1;min-width:0;}
  .zsales-invoice-single-page .zsales-payment-methods button{min-height:32px;padding:5px 7px;border:1px solid var(--si-border);border-radius:var(--si-radius);background:#fff;color:#334155;font:inherit;font-size:11px;font-weight:700;white-space:nowrap;cursor:pointer;}
  .zsales-invoice-single-page .zsales-payment-methods button[aria-pressed="true"]{border-color:var(--si-accent);background:color-mix(in srgb,var(--si-accent) 11%,white);color:var(--si-accent);box-shadow:inset 0 0 0 1px var(--si-accent);}
  .zsales-invoice-single-page .zsales-action-total{display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:var(--si-radius);background:color-mix(in srgb,var(--si-accent) 10%,white);color:#0f172a;font-size:11px;white-space:nowrap;}
  .zsales-invoice-single-page .zsales-action-feedback{flex:1 1 100%;max-height:92px;overflow:auto;}
  .zsales-invoice-single-page .zsales-items-section{background:#fff;}
  .zsales-invoice-single-page .zsales-items-section .zlines-wrap{max-height:min(42vh,320px)!important;overflow-x:auto!important;overflow-y:auto!important;border-color:var(--si-border);overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:auto;}
  .zsales-invoice-single-page .zlines-wrap thead th{position:sticky;top:0;z-index:3;background:var(--si-grid)!important;color:var(--si-grid-text,#1e293b)!important;}
  .zsales-invoice-single-page[data-layout="erp"] .zlines-wrap thead th{--si-grid-text:#fff;}
  .zsales-invoice-single-page .zlines-wrap tbody td{padding:var(--si-density) 5px!important;}
  .zsales-invoice-single-page .zfield:focus{border-color:var(--si-accent)!important;box-shadow:0 0 0 2px color-mix(in srgb,var(--si-accent) 20%,transparent)!important;}
  .zsales-invoice-single-page .zsales-totals-grid{border-color:var(--si-border);}
  .zsales-invoice-single-page .zsales-form-footer{margin-top:12px;padding:10px 0 4px;border-top:2px solid var(--si-border);background:linear-gradient(180deg,var(--si-panel),transparent);}
  .zsales-invoice-single-page[data-layout="quick"] .zsales-section{padding:8px;border-radius:5px;}
  .zsales-invoice-single-page[data-layout="quick"] .zsales-section-heading{font-size:14px;}
  .zsales-invoice-single-page[data-layout="modern"] .zsales-section{box-shadow:0 1px 4px #0f172a0c;}
  .zsales-invoice-single-page[data-layout="modern"] .zlines-wrap tbody tr:nth-child(odd) td{background:#fbfcfd;}
  .zsales-invoice-single-page[data-layout="erp"] .zsales-section{padding:7px;margin:7px 0;}
  .zsales-invoice-single-page[data-layout="erp"] .zlines-wrap thead th{padding:6px 4px!important;font-size:10px!important;}
  .zsales-invoice-single-page[data-layout="erp"] .zlines-wrap .zfield{height:28px!important;padding:3px 4px!important;font-size:11px!important;}
  @media(max-width:1100px){.zsales-invoice-single-page .zsales-header-fields,.zsales-invoice-single-page .zsales-payment-fields{grid-template-columns:repeat(3,minmax(0,1fr))!important}}
  @media(max-width:700px){.zsales-invoice-single-page .zsales-header-fields,.zsales-invoice-single-page .zsales-payment-fields{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
  @media(max-width:900px){.zsales-invoice-single-page .zsales-layout-row{align-items:stretch;flex-direction:column}.zsales-invoice-single-page .zsales-layout-select{max-width:none;width:100%}.zsales-invoice-single-page .zsales-source-loader{grid-template-columns:1fr 1fr}}
  @media(max-width:700px){.zsales-invoice-single-page .zsales-action-buttons{flex-basis:100%}.zsales-invoice-single-page .zsales-quick-payment{flex:1 1 100%;min-width:0;align-items:flex-start;flex-direction:column}.zsales-invoice-single-page .zsales-payment-methods{width:100%;grid-template-columns:repeat(2,minmax(0,1fr))}.zsales-invoice-single-page .zsales-action-total{margin-inline-start:auto}.zsales-invoice-single-page .zsales-source-loader{grid-template-columns:1fr}}
  @media(max-height:680px){.zsales-invoice-single-page .zsales-layout-row{margin:4px 0 6px;padding:4px 8px}.zsales-invoice-single-page .zsales-layout-label small{display:none}.zsales-invoice-single-page .zsales-section{margin:6px 0;padding:7px}.zsales-invoice-single-page .zsales-action-bar{margin:4px 0 6px;padding:5px 7px}.zsales-invoice-single-page .zsales-section-heading{margin-bottom:5px}}
`;

export default function SalesInvoicesAdmin({ onNavigate, onFormOpenChange }: {
  onNavigate?: (v: WindowsView) => void;
  onFormOpenChange?: (open: boolean) => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<SalesInvoice[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<SalesInvoice | null>(null);
  const [creating, setCreating] = useState(false);
  const [editDoc, setEditDoc] = useState<SalesInvoice | null>(null);
  const formOpen = creating || editDoc != null;
  useEffect(() => { onFormOpenChange?.(formOpen); }, [formOpen, onFormOpenChange]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [deps, setDeps] = useState<{ customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[]; salespersons: Salesperson[] } | null>(null);
  const [depsLoading, setDepsLoading] = useState(false);
  const depsLoadedRef = useRef(false);
  const depsLoadRef = useRef<Promise<void> | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // Paid-so-far per invoice: Σ posted receipts tagged appliedDocType=sales_invoice.
  const [paidByInvoice, setPaidByInvoice] = useState<Map<number, number>>(new Map());

  async function refresh() {
    const [invs, tx] = await Promise.all([listSalesInvoices(5000), listFinancialTx(5000)]);
    setRows(invs);
    const m = new Map<number, number>();
    for (const t of tx) {
      if (t.status !== "posted" || t.txType !== "receipt") continue;
      const links = t.allocations?.length
        ? t.allocations.filter((a) => a.docType === "sales_invoice").map((a) => [a.docId, a.amount] as const)
        : t.appliedDocType === "sales_invoice" && t.appliedDocId != null
          ? [[t.appliedDocId, t.amount] as const] : [];
      for (const [invoiceId, amount] of links) {
        m.set(invoiceId, (m.get(invoiceId) ?? 0) + amount);
      }
    }
    setPaidByInvoice(m);
  }

  // ZATCA-bridged invoices are legally immutable → block edit/delete and steer
  // the user to a credit-note return instead. `zatcaStatus` is the linked
  // offline_invoices sync state; any non-null value means it reached the bridge.
  function bridgedMsg(): string {
    return text("هذه الفاتورة مرتبطة بزاتكا ولا يمكن تعديلها أو حذفها قانونياً. استخدم زر «إرجاع» لإنشاء إشعار دائن.", "This invoice is linked to ZATCA and cannot legally be edited or deleted. Use “Return” to create a credit note.");
  }

  async function startEdit(id: number) {
    setErr(null);
    setBusyId(id);
    try {
      if (!depsLoadedRef.current) {
        setDepsLoading(true);
        await reloadDeps(true);
      }
      const inv = await getSalesInvoice(id);
      if (inv.zatcaStatus) { setErr(bridgedMsg()); return; }
      setCreating(false);
      setEditDoc(inv);
    } catch (e: any) { setErr(errText(e, text("تعذّر تحميل الفاتورة", "Could not load invoice."))); }
    finally { setBusyId(null); setDepsLoading(false); }
  }

  async function remove(id: number, invoiceNo: string, zatcaStatus?: string | null) {
    setErr(null);
    if (zatcaStatus) { setErr(bridgedMsg()); return; }
    if (!confirm(`${text("حذف الفاتورة", "Delete invoice")} ${invoiceNo}?`)) return;
    setBusyId(id);
    try {
      await deleteSalesInvoice(id);
      clearDocDiscount("sales_invoice", id);
      dropInvoiceLineBrands(id);
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
    } catch (e: any) { setErr(errText(e, text("تعذّر حذف الفاتورة", "Could not delete invoice."))); }
    finally { setBusyId(null); }
  }

  // فك الترحيل: reverse a posted invoice's GL/stock/AR impact, leaving it as an
  // editable draft. ترحيل: re-apply a draft's impact. Both refresh the list.
  async function unpost(id: number, invoiceNo: string) {
    setErr(null);
    let deleteMode: boolean;
    try { deleteMode = (await getPostingSettings()).unpostBehavior === "delete"; }
    catch (e: any) { setErr(errText(e, text("تعذر قراءة إعداد فك الترحيل", "Could not read the unpost policy."))); return; }
    if (!(await confirmUnpostAction(text("الفاتورة", "invoice"), invoiceNo, language === "en"))) return;
    setBusyId(id);
    try {
      await unpostSalesInvoice(id);
      if (deleteMode) {
        clearDocDiscount("sales_invoice", id);
        dropInvoiceLineBrands(id);
      }
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
      if (!deleteMode) {
        try {
          const draft = await getSalesInvoice(id);
          setCreating(false);
          setEditDoc(draft);
        } catch (e: any) {
          setErr(errText(e, text("تم فك الترحيل لكن تعذر فتح المسودة", "Invoice was unposted, but the draft editor could not be opened.")));
        }
      }
    } catch (e: any) { setErr(errText(e, text("تعذّر فك الترحيل", "Could not unpost invoice."))); }
    finally { setBusyId(null); }
  }
  async function post(id: number, invoiceNo: string) {
    setErr(null);
    if (!confirm(text(`ترحيل الفاتورة ${invoiceNo}؟ سيتم توليد القيد المحاسبي وخصم المخزون.`, `Post invoice ${invoiceNo}? This will create the journal entry and deduct stock.`))) return;
    setBusyId(id);
    try {
      await postSalesInvoice(id);
      if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
    } catch (e: any) { setErr(errText(e, text("تعذّر الترحيل", "Could not post invoice."))); }
    finally { setBusyId(null); }
  }
  // Per-row A4 print: list rows don't carry lines, so load the full invoice first.
  async function printRow(id: number) {
    setErr(null);
    setBusyId(id);
    try {
      const inv = await getSalesInvoice(id);
      await printSalesDoc("a4", invoiceToPrintDoc(inv));
    } catch (e: any) { setErr(errText(e, text("تعذّر طباعة الفاتورة", "Could not print invoice."))); }
    finally { setBusyId(null); }
  }
  async function reloadDeps(force = false) {
    if (!force && !depsLoadedRef.current) return;
    if (depsLoadRef.current) return depsLoadRef.current;
    const pending = (async () => {
      const [customers, cashBoxes, banks, items, warehouses, salespersons] = await Promise.all([
        listCustomers(), listCashBoxes(), listBanks(), listItems(), listWarehouses(), listSalespersons(false),
      ]);
      setDeps({ customers, cashBoxes, banks, items, warehouses, salespersons });
      depsLoadedRef.current = true;
    })();
    depsLoadRef.current = pending;
    try { await pending; }
    finally { if (depsLoadRef.current === pending) depsLoadRef.current = null; }
  }
  async function startCreate() {
    setErr(null);
    try {
      if (!depsLoadedRef.current) {
        setDepsLoading(true);
        await reloadDeps(true);
      }
      setCreating(true);
    } catch (e: any) {
      setErr(errText(e, text("تعذّر تحميل بيانات النموذج", "Could not load form data.")));
    } finally { setDepsLoading(false); }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useDataRefresh(["invoices", "vouchers"], refresh);
  // Keep the item/customer pickers live: another tab adding an item or customer
  // emits on these channels, so reload deps without a manual app refresh.
  useDataRefresh(["items", "customers"], reloadDeps);

  const zatca = isZatcaCountry();
  const columns = useMemo<GridColumn<SalesInvoice>[]>(() => {
    const base: GridColumn<SalesInvoice>[] = [
      { key: "invoiceNo", label: text("رقم الفاتورة", "Invoice number"), value: (p) => p.invoiceNo },
      { key: "date", label: text("التاريخ", "Date"), value: (p) => p.invoiceDate },
      { key: "customer", label: text("العميل", "Customer"), value: (p) => p.customerName ?? text("نقدي/بدون عميل", "Cash / no customer") },
    { key: "payment", label: text("طريقة الدفع", "Payment method"), value: (p) => paymentLabel(p, language) },
      { key: "status", label: text("الحالة", "Status"), value: (p) => p.status ?? "" },
    ];
    if (zatca) base.push({ key: "zatca", label: "ZATCA", value: (p) => p.zatcaStatus ?? "" });
    base.push(
      { key: "subtotal", label: text("المجموع", "Subtotal"), type: "number", value: (p) => p.subtotal },
      { key: "vat", label: text("الضريبة", "Tax"), type: "number", value: (p) => p.vatTotal },
      { key: "grand", label: text("الإجمالي", "Total"), type: "number", value: (p) => p.grandTotal },
      { key: "paid", label: text("المسدّد", "Paid"), type: "number", value: (p) =>
        (p.cashAmount ?? (p.paymentMethod === "cash" ? p.grandTotal : 0))
        + (p.bankAmount ?? (p.paymentMethod === "bank" ? p.grandTotal : 0))
        + (paidByInvoice.get(p.id) ?? 0) },
    );
    return base;
  }, [zatca, paidByInvoice, language]);
  const grid = useGridFilter(rows, columns);
  const sel = useRowSelect(grid.view);

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
    <div
      dir={language === "en" ? "ltr" : "rtl"}
      style={formOpen ? { height: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" } : undefined}
    >
    <Page
      title={text("فواتير المبيعات", "Sales invoices")}
      subtitle={text(`${rows.length} فاتورة — يتم ترحيل قيد المبيعات وتكلفة البضاعة المباعة تلقائياً عند الحفظ`, `${rows.length} invoices — sales and cost-of-goods-sold entries post automatically when saved`)}
      hideHeader={formOpen}
      fillHeight={formOpen}
      right={
        <button onClick={() => void startCreate()} disabled={depsLoading || formOpen}
          style={{ ...btnPrimary, opacity: (depsLoading || formOpen) ? 0.5 : 1, cursor: (depsLoading || formOpen) ? "not-allowed" : "pointer" }}>
          {depsLoading ? text("جارٍ تحميل البيانات...", "Loading form data…") : `+ ${text("فاتورة مبيعات", "Sales invoice")}`}
        </button>
      }
    >
      <ErrorMsg text={err} />
      {formOpen && deps && (
        <Card style={{ marginBottom: 0, flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: 0, flex: 1, minHeight: 0, overflow: "hidden" }}>
            <CreateForm key={editDoc?.id ?? "new"} deps={deps} initial={editDoc} invoiceCount={rows.length}
              onRefreshDeps={reloadDeps}
              onCancel={() => { setCreating(false); setEditDoc(null); }}
              onDone={() => { setCreating(false); setEditDoc(null); void refresh(); }} />
          </div>
        </Card>
      )}
      {!formOpen && rows.length > 0 && <GridToolbar grid={grid} placeholder={text("🔍 بحث في فواتير المبيعات…", "🔍 Search sales invoices…")} extra={<ExportButtons columns={gridToExportCols(columns)} rows={grid.view} filenameBase="sales-invoices" title={text("فواتير المبيعات", "Sales invoices")} />} />}
      {rows.length > 0 && !formOpen && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.invoiceNo : null}>
          <ActionBtn label={expandedId === sel.selectedId ? text("إخفاء", "Hide") : text("عرض", "View")} icon="▼" disabled={!sel.selected}
            onClick={() => { if (sel.selectedId != null) void toggleView(sel.selectedId); }} />
          <ActionBtn label={text("طباعة الفاتورة", "Print invoice")} icon="🖨️" tone="primary" disabled={!sel.selected || busyId === sel.selectedId}
            onClick={() => { if (sel.selectedId != null) void printRow(sel.selectedId); }} />
          {onNavigate && (
            <ActionBtn label={text("إرجاع", "Return")} icon="↩" tone="warn" disabled={!sel.selected || sel.selected.status !== "posted"}
              onClick={() => { if (sel.selectedId != null) void startReturn(sel.selectedId); }} />
          )}
          {sel.selected?.zatcaStatus ? (
            <span style={{ fontSize: 12, color: "#94a3b8" }}>🔒 {text("مُرحّلة لزاتكا", "ZATCA-linked")}</span>
          ) : (() => {
            const s = sel.selected;
            const busy = !s || busyId === s.id;
            const isDraft = s?.status === "draft";
            return (
              <>
                <ActionBtn label={text("ترحيل", "Post")} icon="✔" tone="success" disabled={busy || !isDraft} onClick={() => { if (s) void post(s.id, s.invoiceNo); }} />
                <ActionBtn label={text("تعديل", "Edit")} icon="✎" disabled={busy || !isDraft} onClick={() => { if (s) void startEdit(s.id); }} />
                <ActionBtn label={text("حذف", "Delete")} icon="🗑" tone="danger" disabled={busy || !isDraft} onClick={() => { if (s) void remove(s.id, s.invoiceNo, s.zatcaStatus); }} />
                <ActionBtn label={text("فك الترحيل", "Unpost")} icon="↺" tone="warn" disabled={busy || isDraft} onClick={() => { if (s) void unpost(s.id, s.invoiceNo); }} />
              </>
            );
          })()}
        </ActionBar>
      )}
      {!formOpen && <Card>
        {rows.length === 0 && !formOpen ? <Empty text={text("لا توجد فواتير مبيعات", "No sales invoices")} /> : grid.view.length === 0 ? <Empty text={text("لا نتائج مطابقة للبحث", "No matching results")} /> : (
          <Table>
            <thead>
              <tr>
                <SelectTh />
                <SortableTh grid={grid} colKey="invoiceNo">{text("رقم الفاتورة", "Invoice number")}</SortableTh>
                <SortableTh grid={grid} colKey="date">{text("التاريخ", "Date")}</SortableTh>
                <SortableTh grid={grid} colKey="customer">{text("العميل", "Customer")}</SortableTh>
                <SortableTh grid={grid} colKey="payment">{text("طريقة الدفع", "Payment method")}</SortableTh>
                <SortableTh grid={grid} colKey="status">{text("الحالة", "Status")}</SortableTh>
                {zatca && <SortableTh grid={grid} colKey="zatca">ZATCA</SortableTh>}
                <SortableTh grid={grid} colKey="subtotal" style={{ textAlign: language === "en" ? "right" : "left" }}>{text("المجموع", "Subtotal")}</SortableTh>
                <SortableTh grid={grid} colKey="vat" style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الضريبة", "Tax")}</SortableTh>
                <SortableTh grid={grid} colKey="grand" style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الإجمالي", "Total")}</SortableTh>
                <SortableTh grid={grid} colKey="paid" style={{ textAlign: language === "en" ? "right" : "left" }}>{text("المسدّد / المتبقّي", "Paid / remaining")}</SortableTh>
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
                    <Td>{p.customerName ?? text("نقدي/بدون عميل", "Cash / no customer")}</Td>
                    <Td><PayBadge invoice={p} /></Td>
                    <Td><StatusBadge status={p.status} /></Td>
                    {isZatcaCountry() && <Td><ZatcaBadge status={p.zatcaStatus} /></Td>}
                    <Td num>{fmt(p.subtotal)}</Td>
                    <Td num>{fmt(p.vatTotal)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                    <Td num><PaidCell invoice={p} paid={paidByInvoice.get(p.id) ?? 0} /></Td>
                  </tr>
                  {expandedId === p.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={11 as any}>
                        {!expandedDetail ? <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>{text("... جاري التحميل", "Loading…")}</div> : (
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
      </Card>}
    </Page>
    </div>
  );
}

// المسدّد / المتبقّي cell: cash/bank invoices are settled at sale → "مدفوعة".
// Credit invoices show Σ collected (تحصيل) and the outstanding remainder.
function PaidCell({ invoice: p, paid }: { invoice: SalesInvoice; paid: number }) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const initialPaid = (p.cashAmount ?? (p.paymentMethod === "cash" ? p.grandTotal : 0))
    + (p.bankAmount ?? (p.paymentMethod === "bank" ? p.grandTotal : 0));
  const totalPaid = initialPaid + paid;
  const remaining = p.grandTotal - totalPaid;
  if (remaining <= 0.005) return <span style={{ color: "#15803d" }}>{text("مدفوعة", "Paid")}</span>;
  if (totalPaid <= 0.005) return <span style={{ color: "#b45309" }}>{text("غير مسدّدة", "Unpaid")}</span>;
  return (
    <span>
      <span style={{ color: "#15803d", fontWeight: 600 }}>{fmt(totalPaid)}</span>
      {remaining > 0.005 && <span style={{ color: "#b45309" }}> / {fmt(remaining)}</span>}
    </span>
  );
}

function paymentLabel(p: SalesInvoice, language: "ar" | "en"): string {
  const cash = p.cashAmount ?? (p.paymentMethod === "cash" ? p.grandTotal : 0);
  const bank = p.bankAmount ?? (p.paymentMethod === "bank" ? p.grandTotal : 0);
  const credit = p.creditAmount ?? (p.paymentMethod === "credit" ? p.grandTotal : 0);
  const parts = [
    cash > 0.005 ? (language === "en" ? "Cash" : "نقدي") : "",
    bank > 0.005 ? (language === "en" ? "Bank" : "بنكي") : "",
    credit > 0.005 ? (language === "en" ? "Credit" : "آجل") : "",
  ].filter(Boolean);
  return parts.length > 1
    ? (language === "en" ? "Mixed" : "متعدد")
    : parts[0] || (language === "en" ? "Paid" : "مدفوع");
}

function PayBadge({ invoice }: { invoice: SalesInvoice }) {
  const language = useUiLanguage();
  const label = paymentLabel(invoice, language);
  const c = (invoice.creditAmount ?? (invoice.paymentMethod === "credit" ? invoice.grandTotal : 0)) > 0.005
    ? "#9a3412" : (invoice.cashAmount ?? 0) > 0.005 ? "#15803d" : "#1e40af";
  return <span style={{ background: c + "20", color: c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{label}</span>;
}

// Posting state badge: a draft has its impact reversed (no GL/stock effect) and
// is editable; posted is the normal, locked state. Absent status ⇒ posted.
function StatusBadge({ status }: { status?: string }) {
  const language = useUiLanguage();
  const draft = status === "draft";
  const c = draft ? "#b45309" : "#15803d";
  return <span style={{ background: c + "20", color: c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{draft ? uiText("مسودة", "Draft", language) : uiText("مُرحّلة", "Posted", language)}</span>;
}

// ZATCA sync state of the linked offline_invoices row. `null` = not bridged
// (non-Saudi installs, or the bridge hasn't run yet).
function ZatcaBadge({ status }: { status?: string | null }) {
  const language = useUiLanguage();
  if (!status) return <span style={{ color: "#94a3b8", fontSize: 12 }}>—</span>;
  const synced = status === "synced" || status === "submitted" || status === "cleared" || status === "reported";
  const c = synced ? "#15803d" : "#b45309";
  const label = synced ? uiText("مُرسلة", "Submitted", language) : uiText("بانتظار الرفع", "Awaiting upload", language);
  return <span style={{ background: c + "20", color: c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{label}</span>;
}

function SalesDetail({ p }: { p: SalesInvoice }) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const disc = getDocDiscount("sales_invoice", p.id);
  const discTotal = disc ? (disc.lineDiscountTotal + disc.headerDiscountValue) : 0;
  return (
    <div style={{ padding: 12 }}>
      <Table>
        <thead><tr><Th>{text("الصنف", "Item")}</Th><Th>{text("الوحدة", "Unit")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الكمية", "Quantity")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("سعر الوحدة", "Unit price")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الضريبة %", "Tax %")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الإجمالي", "Total")}</Th></tr></thead>
        <tbody>
          {p.lines.map((l, i) => (
            <tr key={l.id ?? i}>
              <Td>{l.itemName}</Td><Td>{l.uomName ?? ""}</Td><Td num>{l.qty}</Td><Td num>{fmt(l.unitPrice)}</Td><Td num>{l.vatRate}</Td><Td num>{fmt(l.lineTotal)}</Td>
            </tr>
          ))}
          {disc && discTotal > 0.00001 && (
            <>
              <tr style={{ background: "#fff", color: "#475569" }}><Td colSpan={5 as any}>{text("الإجمالي قبل الخصم", "Gross subtotal")}</Td><Td num>{fmt(disc.grossSubtotal)}</Td></tr>
              <tr style={{ background: "#fff", color: "#b45309" }}><Td colSpan={5 as any}>{text("الخصم", "Discount")}</Td><Td num>− {fmt(discTotal)}</Td></tr>
            </>
          )}
          {disc?.currencyCode && disc.currencyCode !== baseCurrencyCode() && (
            <tr style={{ background: "#fff", color: "#475569" }}><Td colSpan={5 as any}>{text("العملة · سعر الصرف", "Currency · exchange rate")}</Td><Td num>{disc.currencyCode} · {fmt(disc.exchangeRate ?? 1)}</Td></tr>
          )}
          <tr style={{ background: "#fff", fontWeight: 700 }}>
            <Td colSpan={5 as any}>{text("الإجمالي قبل الضريبة", "Subtotal")}</Td><Td num>{fmt(p.subtotal)}</Td>
          </tr>
          <tr style={{ background: "#fff" }}><Td colSpan={5 as any}>{text("ضريبة القيمة المضافة", "VAT")}</Td><Td num>{fmt(p.vatTotal)}</Td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 800, fontSize: 16 }}><Td colSpan={5 as any}>{text("الإجمالي النهائي", "Grand total")}</Td><Td num>{fmt(p.grandTotal)}</Td></tr>
          <tr style={{ background: "#fff", color: "#64748b" }}><Td colSpan={5 as any}>{text("تكلفة البضاعة المباعة", "Cost of goods sold")}</Td><Td num>{fmt(p.cogsTotal)}</Td></tr>
          {isZatcaCountry() && p.zatcaQrBase64 && (
            <tr style={{ background: "#fff" }}>
              <Td colSpan={5 as any}>ZATCA</Td>
              <Td>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <ZatcaBadge status={p.zatcaStatus ?? "pending"} />
                  <span style={{ color: "#15803d", fontSize: 12 }}>✓ {text("تم توليد رمز QR وإدراج الفاتورة في طابور الإرسال لزاتكا", "QR code generated and invoice added to the ZATCA submission queue")}</span>
                </span>
              </Td>
            </tr>
          )}
        </tbody>
      </Table>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={() => void printSalesDoc("a4", invoiceToPrintDoc(p))} style={btnSecondary}>🖨️ {text("طباعة A4", "Print A4")}</button>
        <button onClick={() => void printSalesDoc("thermal", invoiceToPrintDoc(p))} style={btnSecondary}>🧾 {text("طباعة حرارية", "Thermal print")}</button>
        <button onClick={() => openWhatsApp(buildDocWhatsAppText({ kind: "invoice", companyName: getCompanyProfile().name, docNo: p.invoiceNo, date: p.invoiceDate, grandTotal: p.grandTotal, customerName: p.buyerName ?? p.customerName }))} style={{ ...btnSecondary, color: "#075e54", borderColor: "#25d366" }}>💬 WhatsApp</button>
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
    // Merge the print-only brand snapshot by index (persisted-line order).
    lines: (() => {
      const bl = getInvoiceLineBrands(p.id);
      return p.lines.map((l, i) => ({ ...l, brandName: bl[i]?.brandName ?? null }));
    })(),
    qrBase64: p.zatcaQrBase64 ?? null,
  };
}

function CreateForm({ deps, initial, invoiceCount, onRefreshDeps, onCancel, onDone }: {
  deps: { customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[]; salespersons: Salesperson[] };
  initial?: SalesInvoice | null;
  invoiceCount: number;
  onRefreshDeps: () => Promise<void>;
  onCancel: () => void; onDone: () => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const customerOptions = useMemo(() => [
    { value: 0, label: text("— بدون عميل —", "— No customer —") },
    ...deps.customers.map((customer) => ({ value: customer.id, label: customer.nameAr })),
  ], [deps.customers, language]);
  const warehouseOptions = useMemo(() => [
    { value: 0, label: text("— المستودع الافتراضي —", "— Default warehouse —") },
    ...deps.warehouses.map((warehouse) => ({ value: warehouse.id, label: warehouse.name })),
  ], [deps.warehouses, language]);
  const itemOptions = useMemo(() => [
    { value: 0, label: text("— اختر —", "— Select —") },
    ...deps.items.map((item) => ({ value: item.id, label: item.nameAr })),
  ], [deps.items, language]);
  const isEdit = !!initial;
  const hideZeros = useHideZeros();
  const showFreeQuantityColumn = useShowFreeQuantityColumn();
  const salesInvoiceLayout = useSalesInvoiceLayout();
  const headerColumns = salesInvoiceLayout === "erp" ? 7 : salesInvoiceLayout === "quick" ? 4 : 5;
  const paymentColumns = salesInvoiceLayout === "erp" ? 6 : salesInvoiceLayout === "quick" ? 4 : 5;
  const [customerId, setCustomerId] = useState<number>(initial?.customerId ?? 0);
  const [date, setDate] = useState(initial?.invoiceDate ?? todayStr());
  const [paymentChoice, setPaymentChoice] = useState<SalesPaymentChoice>(() => {
    if (!initial) return "cash";
    const parts = [initial.cashAmount ?? 0, initial.bankAmount ?? 0, initial.creditAmount ?? 0]
      .filter((amount) => amount > 0.005).length;
    return parts > 1 ? "mixed" : initial.paymentMethod;
  });
  const [cashAmount, setCashAmount] = useState(
    initial?.cashAmount ?? (initial?.paymentMethod === "cash" ? initial.grandTotal : 0),
  );
  const [bankAmount, setBankAmount] = useState(
    initial?.bankAmount ?? (initial?.paymentMethod === "bank" ? initial.grandTotal : 0),
  );
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
    itemId: 0, qty: 1, unitPrice: 0, vatRate: 0, lineTotal: 0, disc: 0, discType: "percent",
    uomId: defUom?.id ?? null, uomName: defUom?.nameAr ?? null, conversionFactor: defUom?.baseQty ?? 1,
    unitKey: "base",
  });
  // Stored line unitPrice is already NET (discount baked in at create) — the
  // pre-discount breakdown isn't round-tripped, so edit re-opens with disc=0.
  const [lines, setLines] = useState<FLine[]>(() => {
    if (initial && initial.lines.length) {
      // Re-hydrate the print-only brand snapshot (indexed in persisted-line order).
      const bl = getInvoiceLineBrands(initial.id);
      return initial.lines.map((l, i) => ({
        ...l, disc: 0, discType: "percent" as DiscType,
        brandId: bl[i]?.brandId ?? null, brandName: bl[i]?.brandName ?? null,
      }));
    }
    return [];
  });
  const [expandedLineIndices, setExpandedLineIndices] = useState<Set<number>>(() => {
    const savedBrands = initial ? getInvoiceLineBrands(initial.id) : [];
    return new Set(initial?.lines.flatMap((line, index) =>
      line.note?.trim() || savedBrands[index]?.brandId ? [index] : [],
    ) ?? []);
  });
  const [headerDisc, setHeaderDisc] = useState(0);
  const [headerDiscType, setHeaderDiscType] = useState<DiscType>("percent");
  const [currency, setCurrency] = useState<string>(() => baseCurrencyCode());
  const [exchangeRate, setExchangeRate] = useState<number>(1);
  const effRate = currency === baseCurrencyCode() ? 1 : (exchangeRate || 1);
  const docSym = currencyByCode(currency).symbol;
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [quickCreate, setQuickCreate] = useState<"customer" | "item" | null>(null);
  const [quickCreateBusy, setQuickCreateBusy] = useState(false);
  const [quickCreateError, setQuickCreateError] = useState<string | null>(null);
  const [sourceKind, setSourceKind] = useState<"quotation" | "sales_order">("quotation");
  const [sourceDocNo, setSourceDocNo] = useState("");
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceFeedback, setSourceFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [itemPickerOpen, setItemPickerOpen] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<{ item: LocalItem; customer: LocalCustomer } | null>(null);
  const [historyNeedsCustomer, setHistoryNeedsCustomer] = useState(false);
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
    // Keep the submit action last in the keyboard sequence even though its
    // visual shortcut now stays at the top of the invoice.
    const orderedNodes = [
      ...nodes.filter((node) => node.dataset.fnavLast !== "1"),
      ...nodes.filter((node) => node.dataset.fnavLast === "1"),
    ];
    const i = orderedNodes.indexOf(el);
    if (i === -1) return;
    // Walk forward to the next *focusable* node: skip disabled or hidden
    // controls (e.g. locked fields, collapsed rows) so focus never stalls.
    for (let j = i + 1; j < orderedNodes.length; j++) {
      const nxt = orderedNodes[j];
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
  const selectedLineCount = lines.filter((line) => Number(line.itemId) > 0).length;
  const selectedBranch = branchId === "" ? null : Number(branchId);
  const invoiceCashBoxes = deps.cashBoxes.filter((box) =>
    (box.isActive !== false || box.id === cashBoxId) &&
    (selectedBranch == null || !box.branchIds?.length || box.branchIds.includes(selectedBranch)),
  );
  const invoiceBanks = deps.banks.filter((bank) =>
    (bank.isActive !== false || bank.id === bankId) &&
    (selectedBranch == null || !bank.branchIds?.length || bank.branchIds.includes(selectedBranch)),
  );

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
    if (patch.itemId && itemHasBrands(patch.itemId)) {
      setExpandedLineIndices((current) => new Set(current).add(i));
    }
    setLines((ls) => ls.map((l, k) => {
      if (k !== i) return l;
      const next = { ...l, ...patch };
      // Auto-fill sale price + vat from the chosen item, and reset to its BASE
      // unit (the item's own additional units appear in the unit picker below).
      if (patch.itemId !== undefined) {
        const it = deps.items.find((x) => x.id === Number(patch.itemId));
        if (it) {
          next.unitKey = "base";
          next.unitPrice = it.salePrice ?? 0;
          next.vatRate = it.vatRate ?? 0;
          const bu = it.uomId != null ? uoms.find((x) => x.id === it.uomId) : defUom;
          next.uomId = bu?.id ?? null; next.uomName = bu?.nameAr ?? null; next.conversionFactor = bu?.baseQty ?? 1;
        }
        // A different item carries different brands — clear any prior pick.
        next.brandId = null; next.brandName = null;
      }
      // Brand pick (PRINT-ONLY, back-office only). Loads the brand's own sale
      // price into unitPrice and snapshots the brand name for the printed
      // invoice. NEVER enters the ZATCA UBL/hash/signature/QR/ICV-PIH.
      if (patch.brandId !== undefined) {
        const bid = patch.brandId;
        if (bid) {
          const link = listItemBrands(Number(next.itemId)).find((b) => b.brandId === bid);
          if (link) {
            next.brandName = link.brandNameAr;
            if ((link.salePrice1 ?? 0) > 0) next.unitPrice = link.salePrice1 as number;
          }
        } else {
          next.brandName = null;
        }
      }
      // Unit change via the per-item picker. Picking an ADDITIONAL unit auto-fills
      // its own price + conversion factor; the BASE unit restores the base price.
      if (patch.unitKey !== undefined) {
        const it = deps.items.find((x) => x.id === Number(next.itemId));
        if (patch.unitKey.startsWith("add:") && it) {
          const u = it.units?.find((x) => x.id === patch.unitKey!.slice(4));
          if (u) { next.uomId = null; next.uomName = u.name; next.conversionFactor = u.factor; next.unitPrice = u.price; }
        } else if (patch.unitKey === "source") {
          // Keep the source document's unit, conversion factor, and price as-is.
        } else {
          const bu = it?.uomId != null ? uoms.find((x) => x.id === it.uomId) : defUom;
          next.uomId = bu?.id ?? null; next.uomName = bu?.nameAr ?? null; next.conversionFactor = bu?.baseQty ?? 1;
          if (it) next.unitPrice = it.salePrice ?? 0;
        }
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

  function appendCatalogItems(items: LocalItem[]) {
    setLines((current) => [...current, ...items.map((item) => {
      const uom = item.uomId != null ? uoms.find((unit) => unit.id === item.uomId) : defUom;
      const line: FLine = {
        ...blankLine(), itemId: item.id, itemName: item.nameAr, unitPrice: item.salePrice ?? 0,
        vatRate: selectedRate ?? item.vatRate ?? 0,
        uomId: uom?.id ?? null, uomName: uom?.nameAr ?? null, conversionFactor: uom?.baseQty ?? 1,
      };
      const { net } = lineNet(line.qty, line.unitPrice, line.disc, line.discType);
      line.lineTotal = net + net * (Number(line.vatRate) || 0) / 100;
      return line;
    })]);
  }

  function openItemHistory(itemId: number) {
    if (!customerId) { setHistoryNeedsCustomer(true); return; }
    const item = deps.items.find((entry) => entry.id === itemId);
    const customer = deps.customers.find((entry) => entry.id === customerId);
    if (item && customer) setHistoryTarget({ item, customer });
  }

  async function createQuickCustomer(input: { nameAr: string; phone: string; vatNumber: string }) {
    if (!input.nameAr.trim()) { setQuickCreateError(text("اكتب اسم العميل بالعربية", "Enter the customer's Arabic name.")); return false; }
    if (input.vatNumber && !/^3\d{13}3$/.test(input.vatNumber.trim())) {
      setQuickCreateError(text("الرقم الضريبي يجب أن يكون 15 رقمًا ويبدأ وينتهي بـ3", "The tax number must be 15 digits and start and end with 3."));
      return false;
    }
    setQuickCreateBusy(true); setQuickCreateError(null);
    try {
      const customer = await createCustomer({
        nameAr: input.nameAr.trim(),
        phone: input.phone.trim() || null,
        vatNumber: input.vatNumber.trim() || null,
        currencyCode: baseCurrencyCode(),
        openingBalance: 0,
        createLedgerAccount: true,
      });
      await onRefreshDeps();
      setCustomerId(customer.id);
      setBuyerName(customer.nameAr);
      setBuyerVat(customer.vatNumber ?? "");
      setBuyerAddress([customer.street, customer.district, customer.city].filter(Boolean).join("، "));
      if (customer.vatNumber) setInvoiceType("standard");
      setQuickCreate(null);
      emitData("customers");
      return true;
    } catch (e: any) {
      setQuickCreateError(e?.message ?? text("تعذر إضافة العميل", "Could not add customer."));
      return false;
    } finally { setQuickCreateBusy(false); }
  }

  async function createQuickItem(input: { nameAr: string; code: string; barcode: string; salePrice: number; vatRate: number; nature: "stock" | "service"; uomId: number; brandId: number | null; quantity?: number }, action: "close" | "add-another" = "close") {
    if (!input.nameAr.trim()) { setQuickCreateError(text("اكتب اسم الصنف بالعربية", "Enter the item's Arabic name.")); return false; }
    if (!Number.isFinite(input.salePrice) || input.salePrice < 0) { setQuickCreateError(text("أدخل سعرًا صحيحًا", "Enter a valid price.")); return false; }
    if (!Number.isFinite(input.quantity ?? 1) || (input.quantity ?? 1) <= 0) { setQuickCreateError(text("أدخل كمية أكبر من صفر", "Enter a quantity greater than zero.")); return false; }
    if (!Number.isFinite(input.vatRate) || input.vatRate < 0 || input.vatRate > 100) { setQuickCreateError(text("نسبة الضريبة يجب أن تكون بين 0 و100", "Tax must be between 0 and 100.")); return false; }
    const uom = uoms.find((unit) => unit.id === input.uomId);
    if (!uom) { setQuickCreateError(text("اختر وحدة قياس للصنف", "Choose a unit of measure.")); return false; }
    setQuickCreateBusy(true); setQuickCreateError(null);
    try {
      const item = await createItem({
        nameAr: input.nameAr.trim(),
        code: input.code.trim() || null,
        barcode: input.barcode.trim() || null,
        salePrice: input.salePrice,
        vatRate: selectedRate ?? input.vatRate,
        costPrice: 0,
        uomId: uom.id,
        nature: input.nature,
      });
      const chosenBrand = input.brandId == null ? null : listBrands().find((brand) => brand.id === input.brandId) ?? null;
      if (chosenBrand) setItemBrands(item.id, [{ brandId: chosenBrand.id, salePrice1: item.salePrice, status: "active" }]);
      if (chosenBrand) setExpandedLineIndices((current) => new Set(current).add(lines.length));
      try { await onRefreshDeps(); } catch { /* the new local item still gets its document line */ }
      setLines((current) => {
        const next: FLine = { ...blankLine(), itemId: item.id, itemName: item.nameAr, qty: input.quantity ?? 1, unitPrice: item.salePrice, vatRate: selectedRate ?? item.vatRate, uomId: item.uomId ?? uom.id, uomName: uom.nameAr, conversionFactor: uom.baseQty, brandId: chosenBrand?.id ?? null, brandName: chosenBrand?.nameAr ?? null };
        const { net } = lineNet(next.qty, next.unitPrice, next.disc, next.discType);
        next.lineTotal = net + net * next.vatRate / 100;
        return [...current, next];
      });
      if (action === "close") setQuickCreate(null);
      return true;
    } catch (e: any) {
      setQuickCreateError(e?.message ?? text("تعذر إضافة الصنف", "Could not add item."));
      return false;
    } finally { setQuickCreateBusy(false); }
  }
  function removeLine(i: number) {
    setLines((ls) => ls.filter((_, k) => k !== i));
    setExpandedLineIndices((current) => new Set(
      [...current].flatMap((index) => index === i ? [] : [index > i ? index - 1 : index]),
    ));
  }
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
  const paymentOptions = [
    { value: "cash", label: text("نقدي", "Cash") },
    { value: "bank", label: text("بنك", "Bank") },
    { value: "credit", label: text("آجل", "Credit") },
    { value: "mixed", label: text("مختلط", "Mixed") },
  ] as const;
  function changePaymentChoice(value: string | number) {
    const next = value as SalesPaymentChoice;
    if (next === "mixed") {
      if (paymentChoice === "cash") { setCashAmount(result.grandTotal); setBankAmount(0); }
      else if (paymentChoice === "bank") { setCashAmount(0); setBankAmount(result.grandTotal); }
      else if (paymentChoice === "credit") { setCashAmount(0); setBankAmount(0); }
    }
    setPaymentChoice(next);
  }

  async function loadSourceDocument() {
    const requestedNo = sourceDocNo.trim().replace(/\s+/g, "").toLocaleUpperCase();
    if (!requestedNo) {
      setSourceFeedback({ kind: "error", text: text("أدخل رقم عرض السعر أو أمر البيع.", "Enter a quotation or sales-order number.") });
      return;
    }
    if (lines.some((line) => line.itemId > 0) && !window.confirm(text(
      "سيتم استبدال بنود الفاتورة الحالية ببيانات المستند المحمّل. هل تريد المتابعة؟",
      "The current invoice lines will be replaced by the loaded document. Continue?",
    ))) return;

    setSourceBusy(true);
    setSourceFeedback(null);
    try {
      let source: Quotation | SalesOrder;
      if (sourceKind === "quotation") {
        const match = (await listQuotations(5000)).find(
          (row) => row.docNo.trim().replace(/\s+/g, "").toLocaleUpperCase() === requestedNo,
        );
        if (!match) throw new Error(text("لم يتم العثور على عرض السعر بهذا الرقم.", "No quotation was found with that number."));
        source = await getQuotation(match.id);
        if (source.status === "converted" || source.status === "rejected") {
          throw new Error(text("لا يمكن تحميل عرض سعر محوّل أو مرفوض.", "Converted or rejected quotations cannot be loaded."));
        }
      } else {
        const match = (await listSalesOrders(5000)).find(
          (row) => row.docNo.trim().replace(/\s+/g, "").toLocaleUpperCase() === requestedNo,
        );
        if (!match) throw new Error(text("لم يتم العثور على أمر البيع بهذا الرقم.", "No sales order was found with that number."));
        source = await getSalesOrder(match.id);
        if (source.status === "converted" || source.status === "cancelled") {
          throw new Error(text("لا يمكن تحميل أمر بيع محوّل أو ملغى.", "Converted or cancelled sales orders cannot be loaded."));
        }
      }

      if (!source.lines.length) {
        throw new Error(text("المستند لا يحتوي على بنود أصناف لتحميلها.", "The source document has no item lines to load."));
      }
      const missingLine = source.lines.find((line) => !deps.items.some((item) => item.id === line.itemId));
      if (missingLine) {
        throw new Error(text(
          `الصنف رقم ${missingLine.itemId} في المستند غير موجود في دليل الأصناف الحالي.`,
          `Item ${missingLine.itemId} from the source document is missing from the current catalog.`,
        ));
      }
      const loadedLines: FLine[] = source.lines.map((line) => {
        const item = deps.items.find((entry) => entry.id === line.itemId)!;
        const matchingUnit = item.units?.find((unit) => unit.name === line.uomName
          && (line.conversionFactor == null || Math.abs(unit.factor - line.conversionFactor) < 0.000001));
        const baseUom = item.uomId != null ? uoms.find((unit) => unit.id === item.uomId) : defUom;
        const isBaseUnit = (!line.uomName || line.uomName === baseUom?.nameAr)
          && (line.conversionFactor == null || Math.abs((baseUom?.baseQty ?? 1) - line.conversionFactor) < 0.000001);
        const unitKey = matchingUnit
          ? `add:${matchingUnit.id}`
          : isBaseUnit ? "base" : "source";
        return {
          ...line,
          itemName: line.itemName ?? item.nameAr,
          uomId: line.uomId ?? baseUom?.id ?? null,
          uomName: line.uomName ?? matchingUnit?.name ?? baseUom?.nameAr ?? null,
          conversionFactor: line.conversionFactor ?? matchingUnit?.factor ?? baseUom?.baseQty ?? 1,
          unitKey,
          disc: 0,
          discType: "percent",
          brandId: null,
          brandName: null,
        };
      });

      setLines(loadedLines);
      setExpandedLineIndices(new Set(loadedLines.flatMap((line, index) => line.note?.trim() ? [index] : [])));
      setHeaderDisc(0);
      setHeaderDiscType("percent");
      setCustomerId(source.customerId ?? 0);
      setWarehouseId(source.warehouseId ?? warehouseId);
      setBranchId(source.branchId ?? "");
      setCostCenterId(source.costCenterId ?? "");
      setSalesRepId(source.salesRepId ?? "");
      setInvoiceType(source.invoiceType === "standard" ? "standard" : "simplified");
      setBuyerName(source.buyerName ?? "");
      setBuyerVat(source.buyerVat ?? "");
      setBuyerAddress(source.buyerAddress ?? "");
      setNotes(source.notes ?? "");
      if ("paymentMethod" in source) {
        setPaymentChoice(source.paymentMethod);
        setCashAmount(source.paymentMethod === "cash" ? source.grandTotal : 0);
        setBankAmount(source.paymentMethod === "bank" ? source.grandTotal : 0);
        setCashBoxId(source.cashBoxId ?? cashBoxId);
        setBankId(source.bankId ?? bankId);
      }
      setSourceFeedback({
        kind: "success",
        text: text(
          `تم تحميل ${sourceKind === "quotation" ? "عرض السعر" : "أمر البيع"} ${source.docNo}. تم نسخ البيانات إلى الفاتورة، والمستند الأصلي لم يتغير.`,
          `Loaded ${sourceKind === "quotation" ? "quotation" : "sales order"} ${source.docNo}. Its data was copied into this invoice; the source document was not changed.`,
        ),
      });
    } catch (error: unknown) {
      setSourceFeedback({
        kind: "error",
        text: error instanceof Error ? error.message : text("تعذر تحميل المستند.", "Could not load the document."),
      });
    } finally {
      setSourceBusy(false);
    }
  }

  async function save() {
    setBusy(true); setErr(null); setIssues([]);
    try {
      const problems = collectDocIssues([
        { label: text("طريقة الدفع", "Payment method"), ok: !!paymentChoice },
        { label: text("العميل", "Customer"), ok: paymentChoice !== "credit" || !!customerId },
        { label: text("العملة", "Currency"), ok: !!currency },
        ...(branches.length ? [{ label: text("الفرع", "Branch"), ok: branchId !== "" }] : []),
        { label: text("المستودع", "Warehouse"), ok: !!warehouseId },
      ], lines.map((l) => ({ itemId: l.itemId, uomId: l.uomId ?? null, price: l.unitPrice, qty: l.qty })), text("سعر البيع", "Sales price"));
      if (problems.length) { setIssues(problems); setBusy(false); return; }
      const cleaned = lines.filter((l) => l.itemId && (l.qty || 0) > 0);
      // Print-only per-line brand snapshot, aligned to the persisted (cleaned) order.
      const brandSnapshot = cleaned.map((l) => ({ brandId: l.brandId ?? null, brandName: l.brandName ?? null }));
      if (currency !== baseCurrencyCode() && !(exchangeRate > 0)) throw new Error(text("أدخل سعر صرف صحيح للعملة الأجنبية", "Enter a valid exchange rate for the foreign currency."));
      // Fold the discount into each unit price; Rust recomputes totals from
      // qty × unitPrice so VAT lands on the net base (ZATCA-correct).
      const r = computeDiscount(
        cleaned.map((l) => ({ qty: l.qty, unit: l.unitPrice, vatRate: l.vatRate, disc: l.disc, discType: l.discType })),
        headerDisc, headerDiscType,
      );
      const paymentTotal = r.grandTotal;
      const paidCash = paymentChoice === "cash" ? paymentTotal : paymentChoice === "mixed" ? cashAmount : 0;
      const paidBank = paymentChoice === "bank" ? paymentTotal : paymentChoice === "mixed" ? bankAmount : 0;
      const dueCredit = paymentChoice === "credit" ? paymentTotal : paymentChoice === "mixed" ? paymentTotal - paidCash - paidBank : 0;
      if (paymentChoice === "mixed" && (paidCash < 0 || paidBank < 0 || paidCash + paidBank > paymentTotal + 0.01)) {
        throw new Error(text("مجموع النقدي والبنكي لا يمكن أن يتجاوز إجمالي الفاتورة", "Cash and bank amounts cannot exceed the invoice total."));
      }
      if (paidCash > 0.005 && !cashBoxId) throw new Error(text("اختر الخزينة للمبلغ النقدي", "Choose a cashbox for the cash amount."));
      if (paidBank > 0.005 && !bankId) throw new Error(text("اختر البنك للمبلغ البنكي", "Choose a bank for the bank amount."));
      if (dueCredit > 0.005 && !customerId) throw new Error(text("اختر العميل للمبلغ الآجل", "Choose a customer for the credit amount."));
      const savedMethod: PaymentMethod = dueCredit > 0.005 ? "credit" : paidCash > 0.005 ? "cash" : "bank";
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
        customerId: customerId || null, invoiceDate: date, paymentMethod: savedMethod,
        cashAmount: paidCash * effRate, bankAmount: paidBank * effRate, creditAmount: dueCredit * effRate,
        cashBoxId: paidCash > 0.005 ? cashBoxId : null,
        bankId:    paidBank > 0.005 ? bankId : null,
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
        saveInvoiceLineBrands(initial.id, brandSnapshot);
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
        saveInvoiceLineBrands(id, brandSnapshot);
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
            paymentMethod: savedMethod,
            customerName: selectedCustomer?.nameAr ?? null,
            customerVat: selectedCustomer?.vatNumber ?? null,
          });
        } catch (e: any) {
          const detail = errText(e, text("خطأ غير معروف", "Unknown error"));
          setErr(text(`تم حفظ الفاتورة لكن تعذّر ربطها بزاتكا. اضغط «حفظ» مرة أخرى لإعادة المحاولة. (${detail})`, `Invoice saved, but the ZATCA link failed. Select “Save” again to retry. (${detail})`));
          return;
        }
      }
      onDone();
    } catch (e: any) { setErr(errText(e, text("فشل", "Could not save invoice."))); }
    finally { setBusy(false); }
  }

  return (
    <div
      ref={formRef}
      className={`zdoc-form zsales-invoice-single-page zsales-layout-${salesInvoiceLayout}`}
      data-layout={salesInvoiceLayout}
      style={docFormShell}
    >
      <style>{documentFormStyles + salesInvoiceTemplateStyles}</style>
      <DocumentFormHeader
        title={isEdit ? `${text("تعديل الفاتورة", "Edit invoice")} ${initial?.invoiceNo ?? ""}` : text("فاتورة مبيعات جديدة", "New sales invoice")}
        hint={text(`${invoiceCount} فاتورة — يتم ترحيل القيد تلقائيًا عند الحفظ`, `${invoiceCount} invoices — entries post automatically when saved`)}
      />
      <div className="zsales-layout-row">
        <label className="zsales-layout-label" htmlFor="sales-invoice-layout">
          {text("نموذج شاشة الفاتورة", "Invoice screen template")}
          <small>{text("يُحفظ اختيارك كافتراضي على هذا الجهاز", "Your choice is saved as the default on this device")}</small>
        </label>
        <select
          id="sales-invoice-layout"
          data-testid="input-sales-invoice-layout"
          className="zsales-layout-select"
          value={salesInvoiceLayout}
          onChange={(event) => setSalesInvoiceLayout(event.target.value as SalesInvoiceLayout)}
          aria-label={text("اختيار نموذج شاشة فاتورة المبيعات", "Choose sales invoice screen template")}
        >
          <option value="classic">{text("تقليدي", "Classic")}</option>
          <option value="quick">{text("إدخال سريع", "Quick entry")}</option>
          <option value="modern">{text("شبكة حديثة", "Modern grid")}</option>
          <option value="erp">{text("ERP مكثف", "Dense ERP")}</option>
        </select>
      </div>

      {!isEdit && (
        <div className="zsales-source-loader" role="group" aria-label={text("تحميل عرض سعر أو أمر بيع", "Load a quotation or sales order")}>
          <p className="zsales-source-loader-title">{text("تحميل مستند سابق إلى الفاتورة", "Load a source document into this invoice")}</p>
          <Field label={text("نوع المستند", "Document type")}>
            <select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as "quotation" | "sales_order")} disabled={sourceBusy} style={input}>
              <option value="quotation">{text("عرض سعر", "Quotation")}</option>
              <option value="sales_order">{text("أمر بيع", "Sales order")}</option>
            </select>
          </Field>
          <Field label={text("رقم المستند", "Document number")}>
            <input value={sourceDocNo} onChange={(event) => setSourceDocNo(event.target.value)} disabled={sourceBusy}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void loadSourceDocument(); } }}
              dir="ltr" placeholder={text("أدخل رقم المستند", "Enter document number")} style={input} />
          </Field>
          <button type="button" onClick={() => void loadSourceDocument()} disabled={sourceBusy || !sourceDocNo.trim()}
            style={{ ...btnSecondary, minHeight: 36, padding: "7px 15px", color: "#fff", background: "var(--si-accent)", borderColor: "var(--si-accent)", fontWeight: 800, whiteSpace: "nowrap", opacity: sourceBusy || !sourceDocNo.trim() ? 0.6 : 1 }}>
            {sourceBusy ? text("جارٍ التحميل…", "Loading…") : text("تحميل إلى الفاتورة", "Load into invoice")}
          </button>
          {sourceFeedback && (
            <div className="zsales-source-loader-status" role={sourceFeedback.kind === "error" ? "alert" : "status"}
              style={{ color: sourceFeedback.kind === "error" ? "#991b1b" : "#166534", background: sourceFeedback.kind === "error" ? "#fef2f2" : "#f0fdf4", border: `1px solid ${sourceFeedback.kind === "error" ? "#fecaca" : "#bbf7d0"}`, borderRadius: 7, padding: "7px 9px" }}>
              {sourceFeedback.text}
            </div>
          )}
        </div>
      )}

      <div className="zsales-action-bar" role="group" aria-label={text("إجراءات الفاتورة السريعة", "Quick invoice actions")}>
        <div className="zsales-action-buttons">
          <button
            onClick={addLine}
            type="button"
            data-testid="button-add-sales-invoice-line"
            title={text("إضافة صنف إلى الفاتورة", "Add an item line")}
            aria-label={text("إضافة صنف إلى الفاتورة", "Add an item line")}
            style={{ ...btnSecondary, padding: "6px 8px", color: "#087f69", borderColor: "#9bd6c9", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}
          >+ {text("إضافة صنف", "Add item")}</button>
          <button
            onClick={() => setItemPickerOpen(true)}
            type="button"
            data-testid="button-select-sales-invoice-items"
            title={text("اختيار عدة أصناف موجودة", "Select multiple existing items")}
            aria-label={text("اختيار أصناف", "Select items")}
            style={{ ...btnSecondary, padding: "6px 8px", color: "#315e56", borderColor: "#b8d4cb", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}
          >{text("اختيار أصناف", "Select items")}</button>
          <button
            onClick={() => { setQuickCreateError(null); setQuickCreate("item"); }}
            type="button"
            data-testid="button-create-sales-invoice-item"
            title={text("إنشاء صنف جديد وإضافته للفاتورة", "Create a new item for this invoice")}
            aria-label={text("إنشاء صنف جديد", "Create a new item")}
            style={{ ...btnSecondary, padding: "6px 8px", color: "#4338ca", borderColor: "#c7d2fe", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}
          >✨ {text("صنف جديد", "New item")}</button>
          <button
            onClick={onCancel}
            type="button"
            data-testid="button-cancel-sales-invoice"
            style={{ ...btnSecondary, padding: "6px 9px", whiteSpace: "nowrap" }}
          >{text("إلغاء", "Cancel")}</button>
          <button
            onClick={save}
            disabled={busy || sourceBusy}
            type="button"
            data-fnav="1"
            data-fnav-last="1"
            data-testid="button-save-sales-invoice"
            style={{ ...btnPrimary, padding: "6px 12px", whiteSpace: "nowrap" }}
          >{busy ? "..." : (isEdit ? text("حفظ التعديل", "Save changes") : text("حفظ وترحيل", "Save and post"))}</button>
        </div>
        <div className="zsales-quick-payment" data-testid="sales-invoice-quick-payment">
          <span className="zsales-quick-payment-label">{text("طريقة الدفع", "Payment method")}</span>
          <div className="zsales-payment-methods" role="group" aria-label={text("اختيار طريقة الدفع", "Choose payment method")}>
            {paymentOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                data-testid={`button-sales-invoice-payment-${option.value}`}
                aria-label={text(`طريقة الدفع: ${option.label}`, `Payment method: ${option.label}`)}
                aria-pressed={paymentChoice === option.value}
                onClick={() => changePaymentChoice(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="zsales-action-total" data-testid="sales-invoice-total" aria-live="polite">
          <span>{text("الإجمالي", "Total")}</span>
          <strong>{docSym} {fmt(result.grandTotal)}</strong>
        </div>
        {(issues.length > 0 || err) && (
          <div className="zsales-action-feedback" aria-live="polite">
            <ValidationPanel issues={issues} />
            <ErrorMsg text={err} />
          </div>
        )}
      </div>

      <section className="zsales-section zsales-header-section">
      <div className="zsales-header-fields" style={{ display: "grid", gridTemplateColumns: `repeat(${headerColumns}, minmax(0, 1fr))`, gap: "0 var(--si-density)", alignItems: "start" }}>
        <Field label={text("التاريخ", "Date")}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} {...navInput} /></Field>
        <Field label={text("العميل *", "Customer *")}>
          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <SearchCombobox
                value={customerId}
                onChange={(v) => setCustomerId(Number(v))}
                {...navCombo}
                style={input}
                  options={customerOptions}
              />
            </div>
            <button type="button" onClick={() => { setQuickCreateError(null); setQuickCreate("customer"); }}
              title={text("إضافة عميل سريعًا", "Quick-add customer")}
              aria-label={text("إضافة عميل جديد", "Add a new customer")}
              style={quickAddButton("#2563eb")}>＋</button>
          </div>
        </Field>
        <Field label={text("مندوب المبيعات", "Sales representative")}>
          <SearchCombobox
            value={salesRepId}
            onChange={(v) => setSalesRepId(v === "" ? "" : Number(v))}
            {...navCombo}
            style={input}
            options={[
              { value: "", label: text("— بدون —", "— None —") },
              ...deps.salespersons.map((s) => ({ value: s.id, label: s.nameAr })),
            ]}
          />
        </Field>
        <Field label={text("المستودع", "Warehouse")}>
          <SearchCombobox
            value={warehouseId}
            onChange={(v) => setWarehouseId(Number(v))}
            {...navCombo}
            style={input}
              options={warehouseOptions}
          />
        </Field>
        <Field label={text("الضريبة", "Tax")}>
          <SearchCombobox value={taxId} onChange={onSelectTax} {...navCombo} options={taxOptions} style={input} />
        </Field>
        <Field label={text("الفرع", "Branch")}>
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} {...navCombo} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label={text("مركز التكلفة", "Cost center")}>
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} {...navCombo} options={costCenterPickerOptions(costCenters)} style={input} />
        </Field>
        {isZatcaCountry() && (
        <Field label={text("نوع الفاتورة (زاتكا)", "Invoice type (ZATCA)")}>
          <SearchCombobox
            value={invoiceType}
            onChange={(v) => setInvoiceType(v as "simplified" | "standard")}
            {...navCombo}
            style={input}
            options={[
              { value: "simplified", label: text("مبسّطة (B2C)", "Simplified (B2C)") },
              { value: "standard", label: text("ضريبية (B2B)", "Standard tax (B2B)") },
            ]}
          />
        </Field>
        )}
        <CurrencyExchangeFields currency={currency} exchangeRate={exchangeRate} onCurrency={setCurrency} onRate={setExchangeRate} />
        {invoiceType === "standard" && (
          <div style={{ gridColumn: "1 / -1", marginBottom: 10, padding: 10, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{text("بيانات المشتري (للفاتورة الضريبية)", "Buyer details (for tax invoices)")}</div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(headerColumns, 3)}, minmax(0, 1fr))`, gap: "0 10px" }}>
              <Field label={text("اسم المشتري", "Buyer name")}>
                <input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} style={input} {...navInput} />
              </Field>
              <Field label={text("الرقم الضريبي للمشتري", "Buyer tax number")}>
                <input value={buyerVat} onChange={(e) => setBuyerVat(e.target.value)} style={input} {...navInput} />
              </Field>
              <Field label={text("عنوان المشتري", "Buyer address")}>
                <input value={buyerAddress} onChange={(e) => setBuyerAddress(e.target.value)} style={input} {...navInput} />
              </Field>
            </div>
          </div>
        )}
      </div>
      </section>

      <section className="zsales-section zsales-items-section zsales-invoice-lines">
      <div className="zsales-section-heading">
        <strong style={{ fontSize: 15 }}>{text("بنود الأصناف", "Invoice items")}</strong>
        <div className="zsales-items-heading-actions">
          <span>{selectedLineCount} {text("صنف", "items")}</span>
          <button
            onClick={addLine}
            type="button"
            data-testid="button-add-sales-invoice-line-inline"
            style={{ ...btnSecondary, padding: "5px 9px", color: "#087f69", borderColor: "#9bd6c9", fontSize: 12, fontWeight: 700 }}
          >+ {text("إضافة صنف", "Add item")}</button>
          <button
            onClick={() => setItemPickerOpen(true)}
            type="button"
            data-testid="button-select-sales-invoice-items-inline"
            style={{ ...btnSecondary, padding: "5px 9px", color: "#315e56", borderColor: "#b8d4cb", fontSize: 12, fontWeight: 700 }}
          >{text("اختيار أصناف", "Select items")}</button>
        </div>
      </div>
      <div className="zlines-wrap" style={{ ...linesScroll, marginTop: 8 }}>
      <Table style={{ width: "100%", minWidth: 900, tableLayout: "fixed" }}>
        <thead><tr>
          <Th style={{ width: "3%", textAlign: "center" }}>#</Th>
          <Th style={{ width: showFreeQuantityColumn ? "23%" : "29%" }}>{text("الصنف", "Item")}</Th>
          <Th style={{ width: "10%" }}>{text("الوحدة", "Unit")}</Th>
          <Th style={{ width: "8%", textAlign: "center" }}>{text("الكمية", "Quantity")}</Th>
          {showFreeQuantityColumn && <Th style={{ width: "6%", textAlign: "center" }}>{text("مجاني", "Free")}</Th>}
          <Th style={{ width: "13%", textAlign: "center" }}>{text("سعر الوحدة", "Unit price")}</Th>
          <Th style={{ width: "12%" }}>{text("الخصم", "Discount")}</Th>
          <Th style={{ width: "6%", textAlign: "center" }}>{text("ض. %", "Tax %")}</Th>
          <Th style={{ width: "12%", textAlign: language === "en" ? "right" : "left" }}>{text("الإجمالي", "Total")}</Th>
          <Th style={{ width: "7%", textAlign: "center" }}>{text("إجراءات", "Actions")}</Th>
        </tr></thead>
        <tbody>
          {lines.length === 0 && <EmptyItemsRow colSpan={showFreeQuantityColumn ? 10 : 9} />}
          {lines.map((l, i) => {
            const expanded = expandedLineIndices.has(i);
            const selectedItem = deps.items.find((item) => item.id === l.itemId);
            return (
              <React.Fragment key={`line-${i}`}>
                <tr className="zrow" style={{ background: i % 2 ? "#fbfdff" : "#fff" }}>
                  <Td style={{ textAlign: "center", color: "#94a3b8", fontWeight: 600 }}>{i + 1}</Td>
                  <Td>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, direction: "rtl" }}>
                      <ItemCodeHistoryButton
                        code={selectedItem?.code}
                        itemName={l.itemName ?? text("الصنف", "item")}
                        disabled={!selectedItem}
                        onClick={() => openItemHistory(l.itemId)}
                      />
                      <div style={{ flex: "1 1 0%", minWidth: 0 }}>
                        <SearchCombobox
                          value={l.itemId}
                          onChange={(v) => setLine(i, { itemId: Number(v) })}
                          {...navCombo}
                          style={{ ...input, minWidth: 0 }}
                          options={itemOptions}
                        />
                      </div>
                    </div>
                  </Td>
                  <Td>
                    {(() => {
                      const selItem = deps.items.find((x) => x.id === l.itemId);
                      const baseName = selItem?.uomId != null
                        ? (uoms.find((u) => u.id === selItem.uomId)?.nameAr ?? "")
                        : (defUom?.nameAr ?? "");
                      const unitOpts = selItem
                        ? [
                            { value: "base", label: baseName || text("أساسي", "Base") },
                            ...((selItem.units ?? []).map((u) => ({ value: `add:${u.id}`, label: `${u.name} (×${u.factor})` }))),
                              ...(l.unitKey === "source" && l.uomName
                                ? [{ value: "source", label: `${l.uomName} (${text("من المستند", "from source")})` }]
                                : []),
                          ]
                        : [{ value: "base", label: defUom?.nameAr ?? "" }];
                      return (
                        <SearchCombobox
                          value={l.unitKey ?? "base"}
                          onChange={(v) => setLine(i, { unitKey: String(v) })}
                          {...navCombo}
                          style={input}
                          options={unitOpts}
                        />
                      );
                    })()}
                  </Td>
                  <Td><input type="number" step="0.001" value={blankIfZero(l.qty, hideZeros)} onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })} style={{ ...input, textAlign: "center", fontWeight: 600 }} {...navInput} /></Td>
                  {showFreeQuantityColumn && <Td><input type="number" step="0.001" value={blankIfZero(l.freeQty ?? 0, hideZeros)} onChange={(e) => setLine(i, { freeQty: Number(e.target.value) || 0 })} style={{ ...input, textAlign: "center" }} {...navInput} /></Td>}
                  <Td><input type="number" step="0.01" value={blankIfZero(l.unitPrice, hideZeros)} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) || 0 })} style={{ ...input, textAlign: "center", fontWeight: 600 }} {...navInput} /></Td>
                  <Td><LineDiscountCell amount={l.disc ?? 0} type={l.discType ?? "percent"} gross={(Number(l.qty) || 0) * (Number(l.unitPrice) || 0)} sym={docSym} onAmount={(v) => setLine(i, { disc: v })} onType={(t) => setLine(i, { discType: t })} navAttr="1" inputClassName="zfield" onEnterNavigate={(el) => advanceFrom(el)} /></Td>
                  <Td><input type="number" step="0.01" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) || 0 })} style={{ ...input, textAlign: "center" }} {...navInput} /></Td>
                  <Td num style={{ fontWeight: 700, color: "#0f172a" }}>{docSym} {fmt(l.lineTotal)}</Td>
                  <Td>
                    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 3 }}>
                      <button
                        type="button"
                        onClick={() => openItemHistory(l.itemId)}
                        disabled={!l.itemId}
                        aria-label={text(`عرض سجل مبيعات ${l.itemName ?? "الصنف"}`, `View sales history for ${l.itemName ?? "item"}`)}
                        title={text("سجل مبيعات هذا الصنف للعميل", "Sales history for this item and customer")}
                        style={{ ...btnLink, color: "#315e56", fontSize: 12, padding: "4px 6px", whiteSpace: "nowrap" }}
                      >
                        {text("السجل", "History")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setExpandedLineIndices((current) => {
                          const next = new Set(current);
                          if (next.has(i)) next.delete(i); else next.add(i);
                          return next;
                        })}
                        aria-label={expanded ? text("إخفاء تفاصيل السطر", "Hide line details") : text("فتح تفاصيل السطر", "Open line details")}
                        title={expanded ? text("إخفاء التفاصيل", "Hide details") : text("ملاحظة وبيانات إضافية", "Note and additional information")}
                        style={{ ...btnLink, color: expanded ? "#087f69" : "#64748b", fontSize: 16, padding: "2px 5px" }}
                      >
                        {expanded ? "⌄" : "⋯"}
                      </button>
                      <button type="button" onClick={() => removeLine(i)} aria-label={text("حذف السطر", "Remove line")} title={text("حذف السطر", "Remove line")} style={{ ...btnLink, color: "#dc2626", fontSize: 17, padding: "2px 5px" }}>×</button>
                    </div>
                  </Td>
                </tr>
                {expanded && (
                  <tr className="zline-details">
                    <Td colSpan={showFreeQuantityColumn ? 10 : 9}>
                      <div className="zline-details-panel">
                        {itemHasBrands(l.itemId) && (
                          <div>
                            <label className="zline-detail-label">{text("العلامة التجارية", "Brand")}</label>
                            <SearchCombobox
                              value={l.brandId ?? ""}
                              onChange={(v) => setLine(i, { brandId: v === "" ? null : Number(v) })}
                              style={input}
                              options={[
                                { value: "", label: text("بدون علامة تجارية", "No brand") },
                                ...listItemBrands(l.itemId).map((b) => ({ value: b.brandId, label: b.brandNameAr })),
                              ]}
                            />
                          </div>
                        )}
                        <div style={{ gridColumn: itemHasBrands(l.itemId) ? undefined : "1 / -1" }}>
                          <label className="zline-detail-label">{text("ملاحظة السطر", "Line note")}</label>
                          <input value={l.note ?? ""} onChange={(e) => setLine(i, { note: e.target.value })} style={input} {...navInput} />
                        </div>
                      </div>
                    </Td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </Table>
      </div>
      <div style={docFormPinned}>
      <InvoiceTotals layout="compact" result={result} headerDisc={headerDisc} headerType={headerDiscType} sym={docSym} rate={effRate} onHeaderDisc={setHeaderDisc} onHeaderType={setHeaderDiscType} />
      </div>
      </section>

      <section className="zsales-section zsales-payment-section">
      <div className="zsales-payment-fields" style={{ display: "grid", gridTemplateColumns: `repeat(${paymentColumns}, minmax(0, 1fr))`, gap: "0 var(--si-density)", alignItems: "start" }}>
        {paymentChoice === "mixed" && (
          <Field label={`${text("المبلغ النقدي", "Cash amount")} · ${docSym}`}>
            <input type="number" min="0" max={Math.max(0, result.grandTotal - bankAmount)} step="0.01"
              value={cashAmount || ""} onChange={(e) => setCashAmount(Math.min(Math.max(0, Number(e.target.value) || 0), Math.max(0, result.grandTotal - bankAmount)))}
              style={input} {...navInput} />
          </Field>
        )}
        {(paymentChoice === "cash" || paymentChoice === "mixed") && (
          <Field label={text("الخزينة", "Cashbox")}>
            <SearchCombobox
              value={cashBoxId ?? ""}
              onChange={(v) => setCashBoxId(Number(v) || null)}
              {...navCombo}
              style={input}
              options={invoiceCashBoxes.map((c) => ({ value: c.id, label: `${language === "en" ? c.nameEn || c.name : c.name} · ${c.currencyCode}` }))}
            />
          </Field>
        )}
        {paymentChoice === "mixed" && (
          <Field label={`${text("المبلغ البنكي", "Bank amount")} · ${docSym}`}>
            <input type="number" min="0" max={Math.max(0, result.grandTotal - cashAmount)} step="0.01"
              value={bankAmount || ""} onChange={(e) => setBankAmount(Math.min(Math.max(0, Number(e.target.value) || 0), Math.max(0, result.grandTotal - cashAmount)))}
              style={input} {...navInput} />
          </Field>
        )}
        {(paymentChoice === "bank" || paymentChoice === "mixed") && (
          <Field label={text("البنك", "Bank")}>
            <SearchCombobox
              value={bankId ?? ""}
              onChange={(v) => setBankId(Number(v) || null)}
              {...navCombo}
              style={input}
              options={invoiceBanks.map((b) => ({ value: b.id, label: `${language === "en" ? b.nameEn || b.name : b.name} · ${b.currencyCode}` }))}
            />
          </Field>
        )}
        {paymentChoice === "mixed" && (
          <Field label={`${text("المتبقي آجل", "Remaining on account")} · ${docSym}`}>
            <input readOnly value={fmt(Math.max(0, result.grandTotal - cashAmount - bankAmount))}
              style={{ ...input, background: "#f8fafc", color: "#9a3412", fontWeight: 700 }} />
          </Field>
        )}
      </div>
      {selectedCustomer && (paymentChoice === "credit" || (paymentChoice === "mixed" && result.grandTotal - cashAmount - bankAmount > 0.005)) && (selectedCustomer.enforceCreditLimit || (selectedCustomer.creditLimit ?? 0) > 0) && (
        <div style={{ marginBottom: 10, padding: "8px 12px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, fontSize: 13, color: "#92400e" }}>
          {text("الرصيد الحالي:", "Current balance:")} <b>{fmt(selectedCustomer.balance ?? 0)}</b>
          {(selectedCustomer.creditLimit ?? 0) > 0 && <> · {text("حد الائتمان:", "Credit limit:")} <b>{fmt(selectedCustomer.creditLimit ?? 0)}</b></>}
          {(selectedCustomer.paymentTermsDays ?? 0) > 0 && <> · {text("مدة الاستحقاق:", "Payment terms:")} <b>{selectedCustomer.paymentTermsDays} {text("يوم", "days")}</b></>}
          {selectedCustomer.enforceCreditLimit && <> · <b>{text("المنع مُفعّل", "Credit limit enforced")}</b></>}
        </div>
      )}
      <Field label={text("ملاحظات", "Notes")} style={{ marginTop: 12 }}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} />
      </Field>
      </section>

      {itemPickerOpen && (
        <DocumentItemPicker items={deps.items} onCancel={() => setItemPickerOpen(false)} onAdd={appendCatalogItems} />
      )}
      {historyTarget && (
        <ItemHistoryDialog itemId={historyTarget.item.id} itemName={historyTarget.item.nameAr}
          customerId={historyTarget.customer.id} customerName={historyTarget.customer.nameAr}
          onClose={() => setHistoryTarget(null)} />
      )}
      {historyNeedsCustomer && <NoCustomerHistoryDialog onClose={() => setHistoryNeedsCustomer(false)} />}
      {quickCreate && (
        <QuickCreateDialog
          key={quickCreate}
          kind={quickCreate}
          documentLabel={{ ar: "الفاتورة", en: "invoice" }}
          initialVatRate={selectedRate ?? 0}
          includeQuantity={quickCreate === "item"}
          busy={quickCreateBusy}
          error={quickCreateError}
          onCancel={() => { if (!quickCreateBusy) setQuickCreate(null); }}
          onSubmit={(payload, action) => {
            if (payload.kind === "customer") return createQuickCustomer(payload);
            return createQuickItem(payload, action);
          }}
          uoms={uoms}
        />
      )}
    </div>
  );
}

function quickAddButton(color: string): React.CSSProperties {
  return {
    width: 35, height: 35, flex: "0 0 35px", borderRadius: 9, border: `1px solid ${color}35`,
    background: `${color}12`, color, fontSize: 23, lineHeight: 1, fontWeight: 700,
    cursor: "pointer", boxShadow: "0 1px 2px #0f172a12",
  };
}
