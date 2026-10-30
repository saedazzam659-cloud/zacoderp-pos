import React, { useEffect, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listSalesReturns, getSalesReturn, createSalesReturn, listCashBoxes, listBanks,
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
  LineDiscountCell, InvoiceTotals, CurrencyExchangeFields, FormTabs, tabPanel, EmptyItemsRow,
  docFormShell, linesPanel, linesScroll, docFormPinned, contentPanel,
  useRowSelect, SelectTh, SelectCell, ActionBar, ActionBtn,
} from "./_adminUi";
import { ValidationPanel, collectDocIssues } from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { useInvoiceTaxes } from "./_invoiceTax";
import { baseCurrencyCode, currencyByCode } from "../lib/currency";
import {
  computeDiscount, lineNet, saveDocDiscount, getDocDiscount,
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
  // Prefill handed over from the sales-invoice list ("إرجاع"). Taken ONCE on
  // mount; when present the create form opens automatically.
  const [prefill, setPrefill] = useState<SalesReturnPrefill | null>(null);
  const [deps, setDeps] = useState<{ customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[] } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  async function refresh() { setRows(await listSalesReturns(5000)); }
  useEffect(() => {
    const pf = takeSalesReturnPrefill();
    if (pf) { setPrefill(pf); setCreating(true); }
    void refresh();
    void (async () => {
      const [customers, cashBoxes, banks, items, warehouses] = await Promise.all([listCustomers(), listCashBoxes(), listBanks(), listItems(), listWarehouses()]);
      setDeps({ customers, cashBoxes, banks, items, warehouses });
    })();
  }, []);

  function closeForm() { setCreating(false); setPrefill(null); }

  const sel = useRowSelect(rows);
  const { start, end, page: clampedPage } = pageSlice(rows.length, page, pageSize);
  const pageRows = rows.slice(start, end);
  useDataRefresh(["invoices"], refresh);
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getSalesReturn(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  return (
    <div dir={language === "en" ? "ltr" : "rtl"}>
    <Page
      title={text("مرتجع المبيعات", "Sales returns")}
      subtitle={text(`${rows.length} مرتجع — يتم عكس قيد المبيعات وإرجاع المخزون تلقائياً`, `${rows.length} returns — the sales entry is reversed and stock is restored automatically`)}
      right={
        <button onClick={() => setCreating(true)} disabled={!deps || creating}
          style={{ ...btnPrimary, opacity: (!deps || creating) ? 0.5 : 1, cursor: (!deps || creating) ? "not-allowed" : "pointer" }}>
          + {text("مرتجع مبيعات", "Sales return")}
        </button>
      }
    >
      {creating && deps && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ padding: 16 }}>
            <CreateForm deps={deps} initial={prefill} onCancel={closeForm} onDone={() => { closeForm(); void refresh(); }} />
          </div>
        </Card>
      )}
      {rows.length > 0 && !creating && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.returnNo : null}>
          <ActionBtn label={expandedId === sel.selectedId ? text("إخفاء", "Hide") : text("عرض", "View")} icon="▼" disabled={!sel.selected}
            onClick={() => { if (sel.selectedId != null) void toggleView(sel.selectedId); }} />
        </ActionBar>
      )}
      {!creating && <Card>
        {rows.length === 0 && !creating ? <Empty text={text("لا توجد مرتجعات", "No sales returns")} /> : (
          <Table>
            <thead><tr>
              <SelectTh />
              <Th>{text("رقم المرتجع", "Return number")}</Th><Th>{text("التاريخ", "Date")}</Th><Th>{text("العميل", "Customer")}</Th><Th>{text("طريقة الدفع", "Payment method")}</Th>
              <Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("المجموع", "Subtotal")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الضريبة", "Tax")}</Th>
              <Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الإجمالي", "Total")}</Th>
            </tr></thead>
            <tbody>
              {pageRows.map((p) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <SelectCell id={p.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                    <Td mono>{p.returnNo}</Td><Td>{p.returnDate}</Td><Td>{p.customerName ?? text("نقدي/بدون عميل", "Cash / no customer")}</Td>
                    <Td><PayBadge m={p.paymentMethod} /></Td>
                    <Td num>{fmt(p.subtotal)}</Td><Td num>{fmt(p.vatTotal)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                  </tr>
                  {expandedId === p.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={8 as any}>
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

function CreateForm({ deps, initial, onCancel, onDone }: {
  deps: { customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; items: LocalItem[]; warehouses: Warehouse[] };
  initial?: SalesReturnPrefill | null;
  onCancel: () => void; onDone: () => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
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

  async function save() {
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
    } catch (e: any) { setErr(e?.message ?? text("فشل", "Could not save sales return.")); }
    finally { setBusy(false); }
  }

  return (
    <div style={docFormShell}>
      <h3 style={{ marginTop: 0, flexShrink: 0 }}>{text("مرتجع مبيعات جديد", "New sales return")}</h3>
      <style>{`.zlines-wrap thead th{position:sticky;top:0;z-index:2;}`}</style>
      <FormTabs active={activeTab} onChange={setActiveTab} tabs={[
        { key: "basic", label: text("البيانات الأساسية", "Basic information") },
        { key: "lines", label: `${text("بنود الأصناف", "Items")}${lines.length ? ` (${lines.length})` : ""}` },
        { key: "payments", label: text("المدفوعات", "Payments") },
      ]} />

      <div style={contentPanel(activeTab, "basic")}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px", alignItems: "start" }}>
        <Field label={text("العميل *", "Customer *")}>
          <SearchCombobox
            value={customerId}
            onChange={(v) => setCustomerId(Number(v))}
            style={input}
            options={[
              { value: 0, label: text("— بدون عميل —", "— No customer —") },
              ...deps.customers.map((c) => ({ value: c.id, label: c.nameAr })),
            ]}
          />
        </Field>
        <Field label={text("التاريخ", "Date")}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
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
        <CurrencyExchangeFields currency={currency} exchangeRate={exchangeRate} onCurrency={setCurrency} onRate={setExchangeRate} />
      </div>
      </div>

      <div style={linesPanel(activeTab)}>
      <div className="zlines-wrap" style={linesScroll}>
      <Table style={{ minWidth: 1250 }}>
        <thead><tr>
          <Th style={{ minWidth: 240 }}>{text("الصنف", "Item")}</Th><Th style={{ width: 130 }}>{text("الوحدة", "Unit")}</Th><Th style={{ width: 180 }}>{text("الكمية", "Quantity")}</Th><Th style={{ width: 240 }}>{text("سعر الوحدة", "Unit price")}</Th><Th style={{ width: 170 }}>{text("الخصم", "Discount")}</Th><Th style={{ width: 80 }}>{text("ض. %", "Tax %")}</Th>
          <Th style={{ width: 120, textAlign: language === "en" ? "right" : "left" }}>{text("الإجمالي", "Total")}</Th><Th style={{ width: 40 }}></Th>
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
              <Td><input type="number" step="0.01" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><LineDiscountCell amount={l.disc ?? 0} type={l.discType ?? "percent"} gross={(Number(l.qty) || 0) * (Number(l.unitPrice) || 0)} sym={docSym} onAmount={(v) => setLine(i, { disc: v })} onType={(t) => setLine(i, { discType: t })} /></Td>
              <Td><input type="number" step="0.01" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td num>{fmt(l.lineTotal)}</Td>
              <Td><button onClick={() => removeLine(i)} type="button" style={{ ...btnLink, color: "#dc2626" }}>×</button></Td>
            </tr>
          ))}
        </tbody>
      </Table>
      </div>
      <button onClick={addLine} type="button" style={{ ...btnSecondary, marginTop: 8, flexShrink: 0 }}>+ {text("سطر", "Line")}</button>
      <div style={docFormPinned}>
      <InvoiceTotals result={result} headerDisc={headerDisc} headerType={headerDiscType} sym={docSym} rate={effRate} onHeaderDisc={setHeaderDisc} onHeaderType={setHeaderDiscType} />
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
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : text("حفظ وترحيل", "Save and post")}</button>
      </Actions>
      </div>
    </div>
  );
}
