import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listSalesReturns, getSalesReturn, createSalesReturn, listCashBoxes, listBanks,
  postSalesReturn, unpostSalesReturn, deleteSalesReturn, confirmUnpostAction,
  salesInvoiceReturnAvailability, getPostingSettings,
  type SalesReturn, type SalesLine, type PaymentMethod, type CashBox, type Bank,
} from "../lib/accounting";
import { listCustomers, type LocalCustomer } from "../lib/customers";
import { listItems, type LocalItem } from "../lib/items";
import { listUom, type Uom } from "../lib/uom";
import { listWarehouses, type Warehouse } from "../lib/inventory";
import { printSalesDoc, type PrintDoc } from "../lib/invoicePrint";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty, Pagination, pageSlice,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
  LineDiscountCell, InvoiceTotals, CurrencyExchangeFields, FormTabs, DocumentFormHeader,
  documentFormStyles, invoiceEditorShell, tabPanel, EmptyItemsRow,
  linesPanel, linesScroll, docFormPinned, contentPanel,
  useRowSelect, SelectTh, SelectCell, ActionBar, ActionBtn,
  errText,
} from "./_adminUi";
import { ValidationPanel, collectDocIssues } from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { useInvoiceTaxes } from "./_invoiceTax";
import { baseCurrencyCode, currencyByCode } from "../lib/currency";
import {
  computeDiscount, lineNet, saveDocDiscount, getDocDiscount,
  clearDocDiscount,
  type DiscType, type DiscFields,
} from "../lib/discount";
import { takeSalesReturnPrefill, type SalesReturnPrefill } from "../lib/returnPrefill";
import { uiText, useUiLanguage } from "../lib/appSettings";

type FLine = SalesLine & DiscFields;

export default function SalesReturnsAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<SalesReturn[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<SalesReturn | null>(null);
  const [creating, setCreating] = useState(false);
  const [depsLoading, setDepsLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Prefill handed over from the sales-invoice list ("إرجاع"). Taken ONCE on
  // mount; when present the create form opens automatically.
  const [prefill, setPrefill] = useState<SalesReturnPrefill | null>(null);
  const [deps, setDeps] = useState<{ customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[] } | null>(null);
  const depsLoadedRef = useRef(false);
  const depsLoadRef = useRef<Promise<void> | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  async function refresh() { setRows(await listSalesReturns(5000)); }
  async function reloadDeps(force = false) {
    if (!force && !depsLoadedRef.current) return;
    if (depsLoadRef.current) return depsLoadRef.current;
    const pending = (async () => {
      const [customers, cashBoxes, banks, items, warehouses] = await Promise.all([
        listCustomers(), listCashBoxes(), listBanks(), listItems(), listWarehouses(),
      ]);
      setDeps({ customers, cashBoxes, banks, items, warehouses });
      depsLoadedRef.current = true;
    })();
    depsLoadRef.current = pending;
    try { await pending; }
    finally { if (depsLoadRef.current === pending) depsLoadRef.current = null; }
  }
  async function openCreate() {
    setErr(null);
    try {
      if (!depsLoadedRef.current) {
        setDepsLoading(true);
        await reloadDeps(true);
      }
      setCreating(true);
    } catch (e: any) {
      setErr(errText(e, text("تعذر تحميل بيانات النموذج", "Could not load form data.")));
    } finally { setDepsLoading(false); }
  }
  useEffect(() => {
    const pf = takeSalesReturnPrefill();
    if (pf) {
      setPrefill(pf);
      setCreating(true);
      setDepsLoading(true);
      void reloadDeps(true).catch((e: any) => setErr(errText(e, text("تعذر تحميل بيانات النموذج", "Could not load form data."))))
        .finally(() => setDepsLoading(false));
    }
    void refresh();
  }, []);

  function closeForm() { setCreating(false); setPrefill(null); setErr(null); }

  const sel = useRowSelect(rows);
  const { start, end, page: clampedPage } = pageSlice(rows.length, page, pageSize);
  const pageRows = rows.slice(start, end);
  useDataRefresh(["invoices"], refresh);
  useDataRefresh(["items", "customers"], () => { void reloadDeps(); });
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getSalesReturn(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  async function post(r: SalesReturn) {
    if (!confirm(text(`ترحيل المرتجع ${r.returnNo}؟`, `Post return ${r.returnNo}?`))) return;
    setBusyId(r.id);
    setErr(null);
    try { await postSalesReturn(r.id); await refresh(); }
    catch (e: any) { setErr(errText(e, text("تعذر ترحيل المرتجع", "Could not post return."))); }
    finally { setBusyId(null); }
  }
  async function unpost(r: SalesReturn) {
    let deleteMode: boolean;
    try { deleteMode = (await getPostingSettings()).unpostBehavior === "delete"; }
    catch (e: any) { setErr(errText(e, text("تعذر قراءة إعداد فك الترحيل", "Could not read the unpost policy."))); return; }
    if (!(await confirmUnpostAction(text("مرتجع المبيعات", "sales return"), r.returnNo, language === "en"))) return;
    setBusyId(r.id);
    setErr(null);
    try {
      await unpostSalesReturn(r.id);
      if (deleteMode) clearDocDiscount("sales_return", r.id);
      await refresh();
    }
    catch (e: any) { setErr(errText(e, text("تعذر فك ترحيل المرتجع", "Could not unpost return."))); }
    finally { setBusyId(null); }
  }
  async function removeDraft(r: SalesReturn) {
    if (!confirm(text(`حذف مسودة المرتجع ${r.returnNo}؟`, `Delete return draft ${r.returnNo}?`))) return;
    setBusyId(r.id);
    setErr(null);
    try { await deleteSalesReturn(r.id); clearDocDiscount("sales_return", r.id); await refresh(); }
    catch (e: any) { setErr(errText(e, text("تعذر حذف المسودة", "Could not delete draft."))); }
    finally { setBusyId(null); }
  }

  return (
    <div dir={language === "en" ? "ltr" : "rtl"}>
    <Page
      title={text("مرتجع المبيعات", "Sales returns")}
      subtitle={text(`${rows.length} مرتجع — يتم عكس قيد المبيعات وإرجاع المخزون تلقائياً`, `${rows.length} returns — the sales entry is reversed and stock is restored automatically`)}
      right={
        <button onClick={() => void openCreate()} disabled={depsLoading || creating}
          style={{ ...btnPrimary, opacity: (depsLoading || creating) ? 0.5 : 1, cursor: (depsLoading || creating) ? "not-allowed" : "pointer" }}>
          {depsLoading ? text("جارٍ تحميل البيانات...", "Loading form data…") : `+ ${text("مرتجع مبيعات", "Sales return")}`}
        </button>
      }
    >
      <ErrorMsg text={err} />
      {creating && deps && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ padding: 16 }}>
            <CreateForm deps={deps} initial={prefill} documentCount={rows.length} onCancel={closeForm} onDone={() => { closeForm(); void refresh(); }} />
          </div>
        </Card>
      )}
      {rows.length > 0 && !creating && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.returnNo : null}>
          <ActionBtn label={expandedId === sel.selectedId ? text("إخفاء", "Hide") : text("عرض", "View")} icon="▼" disabled={!sel.selected}
            onClick={() => { if (sel.selectedId != null) void toggleView(sel.selectedId); }} />
          <ActionBtn label={text("ترحيل", "Post")} icon="✔" tone="success"
            disabled={!sel.selected || sel.selected.status !== "draft" || busyId === sel.selectedId}
            onClick={() => { if (sel.selected) void post(sel.selected); }} />
          <ActionBtn label={text("حذف المسودة", "Delete draft")} icon="🗑" tone="danger"
            disabled={!sel.selected || sel.selected.status !== "draft" || busyId === sel.selectedId}
            onClick={() => { if (sel.selected) void removeDraft(sel.selected); }} />
          <ActionBtn label={text("فك الترحيل", "Unpost")} icon="↺" tone="warn"
            disabled={!sel.selected || sel.selected.status !== "posted" || busyId === sel.selectedId}
            onClick={() => { if (sel.selected) void unpost(sel.selected); }} />
        </ActionBar>
      )}
      {!creating && <Card>
        {rows.length === 0 && !creating ? <Empty text={text("لا توجد مرتجعات", "No sales returns")} /> : (
          <Table>
            <thead><tr>
              <SelectTh />
              <Th>{text("رقم المرتجع", "Return number")}</Th><Th>{text("التاريخ", "Date")}</Th><Th>{text("العميل", "Customer")}</Th><Th>{text("طريقة الدفع", "Payment method")}</Th>
              <Th>{text("الحالة", "Status")}</Th>
              <Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("المجموع", "Subtotal")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الضريبة", "Tax")}</Th>
              <Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الإجمالي", "Total")}</Th>
            </tr></thead>
            <tbody>
              {pageRows.map((p) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <SelectCell id={p.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                    <Td mono>{p.returnNo}</Td><Td>{p.returnDate}</Td><Td>{p.customerName ?? text("نقدي/بدون عميل", "Cash / no customer")}</Td>
                    <Td><PayBadge m={p.paymentMethod} /></Td><Td><ReturnStatus status={p.status} /></Td>
                    <Td num>{fmt(p.subtotal)}</Td><Td num>{fmt(p.vatTotal)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                  </tr>
                  {expandedId === p.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={9 as any}>
                        {!expandedDetail ? <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>{text("... جاري التحميل", "Loading…")}</div> : (
                          <ReturnDetail r={expandedDetail} />
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
      </Card>}
    </Page>
    </div>
  );
}

function ReturnStatus({ status }: { status: SalesReturn["status"] }) {
  const language = useUiLanguage();
  const posted = status === "posted";
  return (
    <span style={{
      background: posted ? "#dcfce7" : "#fef3c7",
      color: posted ? "#15803d" : "#b45309",
      padding: "2px 9px",
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
    }}>
      {posted ? uiText("مرحّل", "Posted", language) : uiText("مسودة", "Draft", language)}
    </span>
  );
}

function PayBadge({ m }: { m: PaymentMethod }) {
  const language = useUiLanguage();
  const map = {
    credit: { ar: "آجل", en: "Credit", c: "#9a3412" },
    cash: { ar: "نقدي", en: "Cash", c: "#15803d" },
    bank: { ar: "بنك", en: "Bank", c: "#1e40af" },
  } as const;
  const x = map[m];
  return <span style={{ background: x.c + "20", color: x.c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{language === "en" ? x.en : x.ar}</span>;
}

function ReturnDetail({ r }: { r: SalesReturn }) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const disc = getDocDiscount("sales_return", r.id);
  const discTotal = disc ? (disc.lineDiscountTotal + disc.headerDiscountValue) : 0;
  return (
    <div style={{ padding: 12 }}>
      <Table>
        <thead><tr><Th>{text("الصنف", "Item")}</Th><Th>{text("الوحدة", "Unit")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الكمية", "Quantity")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("سعر الوحدة", "Unit price")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الإجمالي", "Total")}</Th></tr></thead>
        <tbody>
          {r.lines.map((l, i) => (
            <tr key={l.id ?? i}><Td>{l.itemName}</Td><Td>{l.uomName ?? ""}</Td><Td num>{l.qty}</Td><Td num>{fmt(l.unitPrice)}</Td><Td num>{fmt(l.lineTotal)}</Td></tr>
          ))}
          {disc && discTotal > 0.00001 && (
            <>
              <tr style={{ background: "#fff", color: "#475569" }}><Td colSpan={4 as any}>{text("الإجمالي قبل الخصم", "Gross subtotal")}</Td><Td num>{fmt(disc.grossSubtotal)}</Td></tr>
              <tr style={{ background: "#fff", color: "#b45309" }}><Td colSpan={4 as any}>{text("الخصم", "Discount")}</Td><Td num>− {fmt(discTotal)}</Td></tr>
            </>
          )}
          {disc?.currencyCode && disc.currencyCode !== baseCurrencyCode() && (
            <tr style={{ background: "#fff", color: "#475569" }}><Td colSpan={4 as any}>{text("العملة · سعر الصرف", "Currency · exchange rate")}</Td><Td num>{disc.currencyCode} · {fmt(disc.exchangeRate ?? 1)}</Td></tr>
          )}
          <tr style={{ background: "#f1f5f9", fontWeight: 700 }}><Td colSpan={4 as any}>{text("الإجمالي", "Grand total")}</Td><Td num>{fmt(r.grandTotal)}</Td></tr>
        </tbody>
      </Table>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={() => void printSalesDoc("a4", returnToPrintDoc(r))} style={btnSecondary}>🖨️ {text("طباعة A4", "Print A4")}</button>
        <button onClick={() => void printSalesDoc("thermal", returnToPrintDoc(r))} style={btnSecondary}>🧾 {text("طباعة حرارية", "Thermal print")}</button>
      </div>
    </div>
  );
}

function returnToPrintDoc(r: SalesReturn): PrintDoc {
  return {
    kind: "return",
    docNo: r.returnNo,
    date: r.returnDate,
    customerName: r.customerName,
    customerVat: null,
    paymentMethod: r.paymentMethod,
    subtotal: r.subtotal,
    vatTotal: r.vatTotal,
    grandTotal: r.grandTotal,
    notes: r.notes,
    lines: r.lines,
    qrBase64: null,
  };
}

function CreateForm({ deps, initial, documentCount, onCancel, onDone }: {
  deps: { customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[] };
  initial?: SalesReturnPrefill | null;
  documentCount: number;
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
  const [activeTab, setActiveTab] = useState<"basic" | "lines" | "payments">("basic");
  const [customerId, setCustomerId] = useState<number>(initial?.customerId ?? 0);
  const [date, setDate] = useState(todayStr());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(initial?.paymentMethod ?? "cash");
  const [cashBoxId, setCashBoxId] = useState<number | null>(deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(deps.banks[0]?.id ?? null);
  const [warehouseId, setWarehouseId] = useState<number>(
    initial?.warehouseId ?? (deps.warehouses.find((w) => w.is_default) ?? deps.warehouses[0])?.id ?? 0,
  );
  const { branches, costCenters } = useDimensions();
  const [branchId, setBranchId] = useState<number | "">("");
  useEffect(() => { if (branchId === "" && branches.length === 1) setBranchId(branches[0].id); }, [branches]); // eslint-disable-line react-hooks/exhaustive-deps
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [notes, setNotes] = useState("");
  const [uoms] = useState<Uom[]>(() => listUom());
  const defUom = uoms.find((u) => u.isDefault) ?? uoms[0];
  const blankLine = (): FLine => ({
    itemId: 0, qty: 1, unitPrice: 0, vatRate: 0, lineTotal: 0, disc: 0, discType: "percent",
    uomId: defUom?.id ?? null, uomName: defUom?.nameAr ?? null, conversionFactor: defUom?.baseQty ?? 1,
  });
  const [lines, setLines] = useState<FLine[]>(() =>
    initial?.lines?.length
      ? initial.lines.map((l) => ({ ...l, disc: 0, discType: "percent" as DiscType }))
      : [],
  );
  const [returnAvailability, setReturnAvailability] = useState<Map<number, number> | null>(
    initial?.invoiceId ? null : new Map(),
  );
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [headerDisc, setHeaderDisc] = useState(0);
  const [headerDiscType, setHeaderDiscType] = useState<DiscType>("percent");
  const [currency, setCurrency] = useState<string>(() => baseCurrencyCode());
  const [exchangeRate, setExchangeRate] = useState<number>(1);
  const effRate = currency === baseCurrencyCode() ? 1 : (exchangeRate || 1);
  const docSym = currencyByCode(currency).symbol;
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { taxes, taxId, setTaxId, taxOptions, selectedRate } = useInvoiceTaxes("sales_return");

  useEffect(() => {
    if (!initial?.invoiceId) {
      setReturnAvailability(new Map());
      setAvailabilityError(null);
      return;
    }
    let cancelled = false;
    setReturnAvailability(null);
    setAvailabilityError(null);
    void salesInvoiceReturnAvailability(initial.invoiceId).then((available) => {
      if (cancelled) return;
      const map = new Map(available.map((line) => [line.itemId, line.remainingBaseQty]));
      setReturnAvailability(map);
      setLines((current) => {
        const used = new Map<number, number>();
        return current.map((line) => {
          const rawFactor = line.conversionFactor ?? 1;
          const factor = Number.isFinite(rawFactor) && rawFactor > 0 ? rawFactor : 1;
          const left = Math.max(0, (map.get(line.itemId) ?? 0) - (used.get(line.itemId) ?? 0));
          const qty = Math.min(line.qty, left / factor);
          used.set(line.itemId, (used.get(line.itemId) ?? 0) + qty * factor);
          const { net } = lineNet(qty, line.unitPrice, line.disc, line.discType);
          return { ...line, qty, lineTotal: net + net * (Number(line.vatRate) || 0) / 100 };
        });
      });
    }).catch((e: any) => {
      if (!cancelled) setAvailabilityError(errText(e, text("تعذر تحميل الكميات المتبقية", "Could not load remaining quantities.")));
    });
    return () => { cancelled = true; };
  }, [initial?.invoiceId]);

  function maxQtyForLine(lineIndex: number, itemId: number, factorValue: number | undefined): number | undefined {
    if (!initial?.invoiceId || !returnAvailability || itemId <= 0) return undefined;
    const rawFactor = factorValue ?? 1;
    const factor = Number.isFinite(rawFactor) && rawFactor > 0 ? rawFactor : 1;
    const usedByOtherLines = lines.reduce((total, line, index) => {
      if (index === lineIndex || line.itemId !== itemId) return total;
      const rawLineFactor = line.conversionFactor ?? 1;
      const lineFactor = Number.isFinite(rawLineFactor) && rawLineFactor > 0 ? rawLineFactor : 1;
      return total + line.qty * lineFactor;
    }, 0);
    return Math.max(0, ((returnAvailability.get(itemId) ?? 0) - usedByOtherLines) / factor);
  }

  function setLine(i: number, patch: Partial<FLine>) {
    setLines((ls) => ls.map((l, k) => {
      if (k !== i) return l;
      const next = { ...l, ...patch };
      if (patch.itemId !== undefined) {
        const it = deps.items.find((x) => x.id === Number(patch.itemId));
        if (it) {
          if (!next.unitPrice) next.unitPrice = it.salePrice ?? 0;
          next.vatRate = it.vatRate ?? 0;
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
      if (initial?.invoiceId && returnAvailability && next.itemId > 0) {
        const rawFactor = next.conversionFactor ?? 1;
        const factor = Number.isFinite(rawFactor) && rawFactor > 0 ? rawFactor : 1;
        const usedByOtherLines = ls.reduce((total, line, index) => {
          if (index === i || line.itemId !== next.itemId) return total;
          const rawLineFactor = line.conversionFactor ?? 1;
          const lineFactor = Number.isFinite(rawLineFactor) && rawLineFactor > 0 ? rawLineFactor : 1;
          return total + line.qty * lineFactor;
        }, 0);
        const maxQty = Math.max(0, ((returnAvailability.get(next.itemId) ?? 0) - usedByOtherLines) / factor);
        next.qty = Math.min(Math.max(0, next.qty), maxQty);
      }
      // A selected header tax overrides any per-item/per-line rate so one tax
      // applies to the whole invoice.
      if (selectedRate != null) next.vatRate = selectedRate;
      // Per-line الإجمالي reflects the line discount (header shown in totals panel).
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
  const selectedLineCount = lines.filter((line) => line.itemId > 0).length;

  async function save() {
    if (initial?.invoiceId && returnAvailability === null) {
      setErr(availabilityError ?? text("جارٍ تحميل الكميات المتبقية من الفاتورة", "Loading remaining invoice quantities."));
      return;
    }
    setBusy(true); setErr(null); setIssues([]);
    try {
      const problems = collectDocIssues([
        { label: text("طريقة الدفع", "Payment method"), ok: !!paymentMethod },
        { label: text("العميل", "Customer"), ok: paymentMethod !== "credit" || !!customerId },
        { label: text("العملة", "Currency"), ok: !!currency },
        ...(branches.length ? [{ label: text("الفرع", "Branch"), ok: branchId !== "" }] : []),
        { label: text("المستودع", "Warehouse"), ok: !!warehouseId },
      ], lines.map((l) => ({ itemId: l.itemId, uomId: l.uomId ?? null, price: l.unitPrice, qty: l.qty })), text("سعر البيع", "Sales price"));
      if (problems.length) { setIssues(problems); setBusy(false); return; }
      const cleaned = lines.filter((l) => l.itemId && (l.qty || 0) > 0);
      if (currency !== baseCurrencyCode() && !(exchangeRate > 0)) throw new Error(text("أدخل سعر صرف صحيح للعملة الأجنبية", "Enter a valid exchange rate for the foreign currency."));
      // Fold the discount into each unit price; Rust recomputes totals from
      // qty × unitPrice so VAT lands on the net base (ZATCA-correct).
      const r = computeDiscount(
        cleaned.map((l) => ({ qty: l.qty, unit: l.unitPrice, vatRate: l.vatRate, disc: l.disc, discType: l.discType })),
        headerDisc, headerDiscType,
      );
      const payloadLines: SalesLine[] = cleaned.map((l, i) => {
        // Bake discount AND the FX conversion into the base-currency unit price.
        const net = r.netUnitPrices[i] * effRate;
        return {
          itemId: l.itemId, itemName: l.itemName, qty: l.qty, unitPrice: net, vatRate: l.vatRate,
          lineTotal: l.qty * net * (1 + (Number(l.vatRate) || 0) / 100),
          uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
        };
      });
      const id = await createSalesReturn({
        customerId: customerId || null, invoiceId: initial?.invoiceId ?? null, returnDate: date, paymentMethod,
        cashBoxId: paymentMethod === "cash" ? cashBoxId : null,
        bankId:    paymentMethod === "bank" ? bankId : null,
        warehouseId: warehouseId || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
        notes: notes || null, lines: payloadLines,
      });
      saveDocDiscount("sales_return", id, {
        grossSubtotal: r.grossSubtotal * effRate, lineDiscountTotal: r.lineDiscountTotal * effRate, headerDiscountValue: r.headerDiscountValue * effRate,
        currencyCode: currency, exchangeRate: effRate,
      });
      onDone();
    } catch (e: any) { setErr(errText(e, text("فشل", "Could not save sales return."))); }
    finally { setBusy(false); }
  }

  return (
    <div className="zdoc-form" style={invoiceEditorShell}>
      <style>{documentFormStyles}</style>
      <DocumentFormHeader
        title={text("مرتجع مبيعات جديد", "New sales return")}
        hint={text(`${documentCount} مرتجع — يتم عكس قيد المبيعات وإرجاع المخزون تلقائيًا`, `${documentCount} returns — the sales entry and stock are reversed automatically`)}
        actionLabel={text("مرتجع مبيعات", "Sales return")}
        actionTitle={text("عرض بيانات المرتجع", "Show return details")}
        onAction={() => setActiveTab("basic")}
      />
      <FormTabs active={activeTab} onChange={setActiveTab} accentColor="#079b83" tabs={[
        { key: "basic", label: text("البيانات الأساسية", "Basic information") },
        { key: "lines", label: `${text("بنود الأصناف", "Items")} (${selectedLineCount})` },
        { key: "payments", label: text("المدفوعات", "Payments") },
      ]} />

      <div style={contentPanel(activeTab, "basic")}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px", alignItems: "start" }}>
        <Field label={text("العميل *", "Customer *")}>
          <SearchCombobox
            value={customerId}
            onChange={(v) => setCustomerId(Number(v))}
            style={input}
            options={customerOptions}
          />
        </Field>
        <Field label={text("التاريخ", "Date")}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label={text("المستودع", "Warehouse")}>
          <SearchCombobox
            value={warehouseId}
            onChange={(v) => setWarehouseId(Number(v))}
            style={input}
            options={warehouseOptions}
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
        <CurrencyExchangeFields currency={currency} exchangeRate={exchangeRate} onCurrency={setCurrency} onRate={setExchangeRate} />
      </div>
      </div>

      <div className="zlines-panel" style={linesPanel(activeTab)}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 4, marginBottom: 8, color: "#0f172a" }}>
        <strong style={{ fontSize: 15 }}>{text("بنود الأصناف", "Return items")}</strong>
        <span style={{ padding: "2px 8px", borderRadius: 999, background: "#e8f6f2", color: "#087f69", fontSize: 11, fontWeight: 700 }}>
          {selectedLineCount} {text("صنف", "items")}
        </span>
      </div>
      <div className="zlines-wrap" style={{ ...linesScroll, marginTop: 8 }}>
      <Table style={{ width: "100%", minWidth: 900, tableLayout: "fixed" }}>
        <thead><tr>
          <Th style={{ width: "4%", textAlign: "center" }}>#</Th>
          <Th style={{ width: "24%" }}>{text("الصنف", "Item")}</Th>
          <Th style={{ width: "11%" }}>{text("الوحدة", "Unit")}</Th>
          <Th style={{ width: "8%", textAlign: "center" }}>{text("الكمية", "Quantity")}</Th>
          <Th style={{ width: "14%", textAlign: "center" }}>{text("سعر الوحدة", "Unit price")}</Th>
          <Th style={{ width: "13%", textAlign: "center" }}>{text("الخصم", "Discount")}</Th>
          <Th style={{ width: "7%", textAlign: "center" }}>{text("ض. %", "Tax %")}</Th>
          <Th style={{ width: "12%", textAlign: language === "en" ? "right" : "left" }}>{text("الإجمالي", "Total")}</Th>
          <Th style={{ width: "7%", textAlign: "center" }}>{text("إجراءات", "Actions")}</Th>
        </tr></thead>
        <tbody>
          {lines.length === 0 && <EmptyItemsRow colSpan={9} />}
          {lines.map((l, i) => (
            <tr key={i} className="zrow" style={{ background: i % 2 ? "#fbfdff" : "#fff" }}>
              <Td style={{ textAlign: "center", color: "#94a3b8", fontWeight: 600 }}>{i + 1}</Td>
              <Td>
                <SearchCombobox
                  value={l.itemId}
                  onChange={(v) => setLine(i, { itemId: Number(v) })}
                  style={input}
                  inputClassName="zfield"
                  options={itemOptions}
                />
              </Td>
              <Td>
                <SearchCombobox
                  value={l.uomId ?? 0}
                  onChange={(v) => setLine(i, { uomId: Number(v) })}
                  style={input}
                  inputClassName="zfield"
                  options={uoms.map((u) => ({ value: u.id, label: u.baseQty !== 1 ? `${u.nameAr} (×${u.baseQty})` : u.nameAr }))}
                />
              </Td>
              <Td><input
                type="number"
                step="0.001"
                min={0}
                max={maxQtyForLine(i, l.itemId, l.conversionFactor)}
                value={l.qty}
                onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })}
                style={{ ...input, textAlign: "center", fontWeight: 600 }}
                className="zfield"
              /></Td>
              <Td><input type="number" step="0.01" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) || 0 })} style={{ ...input, textAlign: "center", fontWeight: 600 }} className="zfield" /></Td>
              <Td><LineDiscountCell amount={l.disc ?? 0} type={l.discType ?? "percent"} gross={(Number(l.qty) || 0) * (Number(l.unitPrice) || 0)} sym={docSym} onAmount={(v) => setLine(i, { disc: v })} onType={(t) => setLine(i, { discType: t })} inputClassName="zfield" /></Td>
              <Td><input type="number" step="0.01" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) || 0 })} style={{ ...input, textAlign: "center" }} className="zfield" /></Td>
              <Td num style={{ fontWeight: 700, color: "#0f172a" }}>{docSym} {fmt(l.lineTotal)}</Td>
              <Td><button onClick={() => removeLine(i)} type="button" aria-label={text("حذف السطر", "Remove line")} title={text("حذف السطر", "Remove line")} style={{ ...btnLink, color: "#dc2626", fontSize: 17, padding: "2px 5px" }}>×</button></Td>
            </tr>
          ))}
        </tbody>
      </Table>
      </div>
      {initial?.invoiceId && (
        <div style={{
          marginTop: 8,
          padding: "8px 10px",
          borderRadius: 6,
          background: availabilityError ? "#fef2f2" : "#eff6ff",
          color: availabilityError ? "#b91c1c" : "#1d4ed8",
          fontSize: 12,
        }}>
          {availabilityError
            ? availabilityError
            : returnAvailability === null
              ? text("جارٍ تحميل الكميات المتبقية...", "Loading remaining quantities…")
              : text("تم تقييد الكمية بإجمالي المتبقي من الفاتورة الأصلية، بعد احتساب المرتجعات السابقة.", "Quantities are capped at the original invoice balance after previous returns.")}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-start", gap: 8, marginTop: 8 }}>
        <button onClick={addLine} type="button" style={{ padding: "7px 14px", background: "#fff", color: "#087f69", border: "1px solid #9bd6c9", borderRadius: 7, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700 }}>
          + {text("إضافة صنف", "Add item")}
        </button>
      </div>
      <div style={docFormPinned}>
      <InvoiceTotals layout="compact" result={result} headerDisc={headerDisc} headerType={headerDiscType} sym={docSym} rate={effRate} onHeaderDisc={setHeaderDisc} onHeaderType={setHeaderDiscType} />
      </div>
      </div>

      <div style={contentPanel(activeTab, "payments")}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px", alignItems: "start" }}>
        <Field label={text("طريقة الاسترداد", "Refund method")}>
          <SearchCombobox
            value={paymentMethod}
            onChange={(v) => setPaymentMethod(v as PaymentMethod)}
            style={input}
            options={[
              { value: "cash", label: text("نقدي", "Cash") },
              { value: "bank", label: text("بنك", "Bank") },
              { value: "credit", label: text("آجل (تخفيض الذمة)", "Credit (reduce receivable)") },
            ]}
          />
        </Field>
        {paymentMethod === "cash" && (
          <Field label={text("الخزينة", "Cashbox")}>
            <SearchCombobox
              value={cashBoxId ?? ""}
              onChange={(v) => setCashBoxId(Number(v) || null)}
              style={input}
              options={deps.cashBoxes.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Field>
        )}
        {paymentMethod === "bank" && (
          <Field label={text("البنك", "Bank")}>
            <SearchCombobox
              value={bankId ?? ""}
              onChange={(v) => setBankId(Number(v) || null)}
              style={input}
              options={deps.banks.map((b) => ({ value: b.id, label: b.name }))}
            />
          </Field>
        )}
      </div>
      <Field label={text("ملاحظات", "Notes")} style={{ marginTop: 12 }}><textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} /></Field>
      </div>

      <div style={docFormPinned}>
      <ValidationPanel issues={issues} />
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
        <button onClick={save} disabled={busy || (!!initial?.invoiceId && returnAvailability === null)} type="button" style={btnPrimary}>{busy ? "..." : text("حفظ وترحيل", "Save and post")}</button>
      </Actions>
      </div>
    </div>
  );
}
