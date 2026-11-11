import { useEffect, useMemo, useState } from "react";
import {
  listFinancialTx, createFinancialTx, updateFinancialTx, deleteFinancialTx, financialTxPost, financialTxUnpost,
  listCashBoxes, listBanks, listSalesInvoices, type FinancialTxInput,
  type FinancialTx, type CashBox, type Bank, type SalesInvoice,
} from "../lib/accounting";
import { listCustomers, type LocalCustomer } from "../lib/customers";
import { emitData, useDataRefresh } from "../lib/dataBus";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, fmt, todayStr, SearchCombobox,
  useGridFilter, GridToolbar, SortableTh, GridFilterRow, type GridColumn,
  ExportButtons, gridToExportCols, errText,
  useRowSelect, SelectTh, SelectCell, ActionBar, ActionBtn,
} from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { printVoucher } from "../lib/invoicePrint";
import { formatUiDate, uiText, useUiLanguage } from "../lib/appSettings";

// تحصيل من العملاء — a customer-scoped سند قبض. Reuses the shared
// financial_tx pipeline (DR cash/bank, CR AR 1500, decrements customer balance),
// optionally tagging the receipt to a specific outstanding sales invoice so the
// invoice list + statement can surface the collected amount.
function walletName(
  deps: { cashBoxes: CashBox[]; banks: Bank[] } | null,
  f: FinancialTx,
): string | null {
  if (!deps) return null;
  if (f.bankId != null) return deps.banks.find((b) => b.id === f.bankId)?.name ?? null;
  if (f.cashBoxId != null) return deps.cashBoxes.find((c) => c.id === f.cashBoxId)?.name ?? null;
  return null;
}

export default function CustomerCollectionAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const { branches, costCenters } = useDimensions();
  const [rows, setRows] = useState<FinancialTx[]>([]);
  const [creating, setCreating] = useState(false);
  const [editingVoucher, setEditingVoucher] = useState<FinancialTx | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const formOpen = creating || editingVoucher != null;
  const [allTx, setAllTx] = useState<FinancialTx[]>([]);
  const [deps, setDeps] = useState<{ customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; invoices: SalesInvoice[] } | null>(null);

  async function refresh() { setRows((await listFinancialTx(1000)).filter((f) => f.txType === "receipt" && f.partyType === "customer")); }
  function refreshAfterVoucherChange() {
    emitData("vouchers", "journal", "customers", "cashboxes", "banks");
    void refresh();
    void loadDeps();
    void listFinancialTx(5000).then(setAllTx);
  }
  async function loadDeps() {
    const [customers, cashBoxes, banks, invoices] = await Promise.all([
      listCustomers(), listCashBoxes(), listBanks(), listSalesInvoices(5000),
    ]);
    setDeps({ customers, cashBoxes, banks, invoices });
  }
  useEffect(() => { void refresh(); void loadDeps(); }, []);

  // Paid-so-far per sales invoice (across ALL receipts, not just this filtered view).
  useEffect(() => { void (async () => setAllTx(await listFinancialTx(5000)))(); }, [rows.length]);

  // Live-refresh: when a sales invoice or another voucher is created/posted on a
  // different tab, reload the deps (outstanding-invoice picker) + paid totals so
  // the new invoice appears here without a manual page reload.
  useDataRefresh(["invoices", "vouchers", "customers", "cashboxes", "banks"], () => {
    void refresh();
    void loadDeps();
    void (async () => setAllTx(await listFinancialTx(5000)))();
  });

  const invByApplied = (f: FinancialTx) =>
    f.appliedDocType === "sales_invoice" && f.appliedDocId != null
      ? deps?.invoices.find((i) => i.id === f.appliedDocId) ?? null : null;
  const columns = useMemo<GridColumn<FinancialTx>[]>(() => [
    { key: "txNo", label: text("الرقم", "Number"), value: (f) => f.txNo },
    { key: "txDate", label: text("التاريخ", "Date"), value: (f) => f.txDate },
    { key: "party", label: text("العميل", "Customer"), value: (f) => f.partyName ?? "" },
    { key: "invoice", label: text("الفاتورة المرتبطة", "Linked invoice"), value: (f) => invByApplied(f)?.invoiceNo ?? "" },
    { key: "description", label: text("البيان", "Description"), value: (f) => f.description ?? "" },
    { key: "amount", label: text("المبلغ", "Amount"), type: "number", value: (f) => f.amount },
    { key: "currency", label: text("العملة", "Currency"), value: (f) => `${f.currencyCode} · ${f.exchangeRate}` },
    { key: "branch", label: text("الفرع", "Branch"), value: (f) => branches.find((b) => b.id === f.branchId)?.nameAr ?? "" },
    { key: "costCenter", label: text("مركز التكلفة", "Cost center"), value: (f) => costCenters.find((c) => c.id === f.costCenterId)?.nameAr ?? "" },
    { key: "status", label: text("الحالة", "Status"), value: (f) => f.status },
  ], [deps, branches, costCenters, language]);
  const grid = useGridFilter(rows, columns);
  const sel = useRowSelect(grid.view);

  return (
    <div dir={language === "en" ? "ltr" : "rtl"}>
    <Page
      title={text("سند القبض", "Receipt vouchers")}
      subtitle={text("سند قبض مرتبط بالعميل — يخصم من رصيد العميل ويظهر في كشف حسابه", "Customer receipts reduce the customer balance and appear on the customer statement")}
      right={<button onClick={() => { setEditingVoucher(null); setCreating(true); }}
        style={{ ...btnPrimary, background: "#15803d", opacity: (!deps || formOpen) ? 0.5 : 1, cursor: (!deps || formOpen) ? "not-allowed" : "pointer" }}
        disabled={!deps || formOpen}>+ {text("سند قبض", "Receipt voucher")}</button>}
    >
      {formOpen && deps && (
        <Card style={{ marginBottom: 12, border: "2px solid #15803d" }}>
          <div style={{ padding: 16 }}>
            <CollectForm deps={deps} allTx={allTx} initial={editingVoucher}
              onCancel={() => { setCreating(false); setEditingVoucher(null); }}
              onDone={() => { setCreating(false); setEditingVoucher(null); void refresh(); }} />
          </div>
        </Card>
      )}
      {rows.length > 0 && !formOpen && <GridToolbar grid={grid} placeholder={text("🔍 بحث في سندات القبض…", "🔍 Search receipt vouchers…")} extra={<ExportButtons columns={gridToExportCols(columns)} rows={grid.view} filenameBase="customer-receipts" title={text("سندات القبض من العملاء", "Customer receipt vouchers")} />} />}
      {rows.length > 0 && !formOpen && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.txNo : null}>
          <ActionBtn label={text("طباعة", "Print")} icon="🖨️" tone="primary" disabled={!sel.selected}
            onClick={() => {
              const f = sel.selected; if (!f) return;
              const inv = invByApplied(f);
              printVoucher({
                kind: "receipt",
                title: text("سند قبض", "Receipt voucher"),
                docNo: f.txNo,
                date: f.txDate,
                partyName: f.partyName ?? null,
                amount: f.amount,
                description: f.description ?? null,
                walletKind: f.bankId != null ? "bank" : "cash",
                walletName: walletName(deps, f),
                linkedDocNo: inv ? inv.invoiceNo : null,
              });
            }} />
          <VoucherActions
            selected={sel.selected}
            busy={busyId != null}
            text={text}
            onEdit={(f) => setEditingVoucher(f)}
            onDelete={(f) => {
              setBusyId(f.id);
              void deleteFinancialTx(f.id).then(refreshAfterVoucherChange)
                .catch((e) => alert(errText(e, text("تعذر حذف المسودة", "Could not delete draft."))))
                .finally(() => setBusyId(null));
            }}
            onPost={(f) => {
              setBusyId(f.id);
              void financialTxPost(f.id).then(refreshAfterVoucherChange)
                .catch((e) => alert(errText(e, text("تعذر ترحيل السند", "Could not post voucher."))))
                .finally(() => setBusyId(null));
            }}
            onUnpost={(f) => {
              setBusyId(f.id);
              void financialTxUnpost(f.id).then(refreshAfterVoucherChange)
                .catch((e) => alert(errText(e, text("تعذر فك الترحيل", "Could not unpost voucher."))))
                .finally(() => setBusyId(null));
            }}
          />
        </ActionBar>
      )}
      <Card>
        {rows.length === 0 && !formOpen ? <Empty text={text("لا توجد سندات قبض", "No receipt vouchers")} /> : grid.view.length === 0 ? <Empty text={text("لا نتائج مطابقة للبحث", "No matching results")} /> : (
          <Table>
            <thead>
              <tr>
                <SelectTh />
                <SortableTh grid={grid} colKey="txNo">{text("الرقم", "Number")}</SortableTh>
                <SortableTh grid={grid} colKey="txDate">{text("التاريخ", "Date")}</SortableTh>
                <SortableTh grid={grid} colKey="party">{text("العميل", "Customer")}</SortableTh>
                <SortableTh grid={grid} colKey="invoice">{text("الفاتورة المرتبطة", "Linked invoice")}</SortableTh>
                <SortableTh grid={grid} colKey="description">{text("البيان", "Description")}</SortableTh>
                <SortableTh grid={grid} colKey="amount" style={{ textAlign: language === "en" ? "right" : "left" }}>{text("المبلغ", "Amount")}</SortableTh>
                <SortableTh grid={grid} colKey="currency">{text("العملة / السعر", "Currency / Rate")}</SortableTh>
                <SortableTh grid={grid} colKey="branch">{text("الفرع", "Branch")}</SortableTh>
                <SortableTh grid={grid} colKey="costCenter">{text("مركز التكلفة", "Cost center")}</SortableTh>
                <SortableTh grid={grid} colKey="status">{text("الحالة", "Status")}</SortableTh>
              </tr>
              <GridFilterRow grid={grid} columns={columns} leading={1} />
            </thead>
            <tbody>
              {grid.view.map((f) => {
                const inv = invByApplied(f);
                return (
                  <tr key={f.id}>
                    <SelectCell id={f.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                    <Td mono>{f.txNo}</Td><Td>{formatUiDate(f.txDate, language)}</Td>
                    <Td>{f.partyName ?? "—"}</Td>
                    <Td mono>{inv ? inv.invoiceNo : "—"}</Td>
                    <Td>{f.description ?? "—"}</Td>
                    <Td num style={{ fontWeight: 600, color: "#15803d" }}>{fmt(f.amount)}</Td>
                    <Td>{f.currencyCode} · {fmt(f.exchangeRate)}</Td>
                    <Td>{branches.find((b) => b.id === f.branchId)?.nameAr ?? "—"}</Td>
                    <Td>{costCenters.find((c) => c.id === f.costCenterId)?.nameAr ?? "—"}</Td>
                    <Td><VoucherStatus status={f.status} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
    </div>
  );
}

function VoucherActions({ selected, busy, text, onEdit, onDelete, onPost, onUnpost }: {
  selected: FinancialTx | null;
  busy: boolean;
  text: (ar: string, en: string) => string;
  onEdit: (f: FinancialTx) => void;
  onDelete: (f: FinancialTx) => void;
  onPost: (f: FinancialTx) => void;
  onUnpost: (f: FinancialTx) => void;
}) {
  const draft = selected?.status === "draft";
  return <>
    <ActionBtn label={text("تعديل المسودة", "Edit draft")} icon="✎" disabled={!selected || !draft || busy} onClick={() => selected && onEdit(selected)} />
    <ActionBtn label={text("حذف المسودة", "Delete draft")} icon="🗑" tone="danger" disabled={!selected || !draft || busy}
      onClick={() => { if (selected && confirm(text(`حذف مسودة السند ${selected.txNo}؟`, `Delete draft ${selected.txNo}?`))) onDelete(selected); }} />
    <ActionBtn label={text("ترحيل", "Post")} icon="✔" tone="success" disabled={!selected || !draft || busy}
      onClick={() => { if (selected && confirm(text(`ترحيل السند ${selected.txNo}؟`, `Post voucher ${selected.txNo}?`))) onPost(selected); }} />
    <ActionBtn label={text("فك الترحيل", "Unpost")} icon="↺" tone="warn" disabled={!selected || draft || busy}
      onClick={() => { if (selected && confirm(text(`فك ترحيل السند ${selected.txNo}؟`, `Unpost voucher ${selected.txNo}?`))) onUnpost(selected); }} />
  </>;
}

function VoucherStatus({ status }: { status: string }) {
  const language = useUiLanguage();
  const draft = status === "draft";
  return <span style={{ padding: "3px 8px", borderRadius: 999, background: draft ? "#fef3c7" : "#dcfce7", color: draft ? "#92400e" : "#166534", fontSize: 11, fontWeight: 700 }}>
    {draft ? uiText("مسودة", "Draft", language) : uiText("مرحّل", "Posted", language)}
  </span>;
}

function CollectForm({ deps, allTx, initial, onCancel, onDone }: {
  deps: { customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; invoices: SalesInvoice[] };
  allTx: FinancialTx[];
  initial?: FinancialTx | null;
  onCancel: () => void; onDone: () => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const { branches, costCenters } = useDimensions();
  const [date, setDate] = useState(initial?.txDate ?? todayStr());
  const [branchId, setBranchId] = useState<number | "">(initial?.branchId ?? "");
  const [costCenterId, setCostCenterId] = useState<number | "">(initial?.costCenterId ?? "");
  const [customerId, setCustomerId] = useState<number | null>(initial?.partyId ?? null);
  const [invoiceId, setInvoiceId] = useState<number | null>(initial?.appliedDocId ?? null);
  const [walletKind, setWalletKind] = useState<"cash" | "bank">(initial?.bankId != null ? "bank" : "cash");
  const [cashBoxId, setCashBoxId] = useState<number | null>(initial?.cashBoxId ?? deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(initial?.bankId ?? deps.banks[0]?.id ?? null);
  const [amount, setAmount] = useState<number>(initial?.amount ?? 0);
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The selected customer's CREDIT sales invoices that still carry an
  // outstanding balance (grandTotal − Σ posted receipts tagged to that invoice).
  const paidByInvoice = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of allTx) {
      if (t.status === "posted" && t.txType === "receipt" && t.appliedDocType === "sales_invoice" && t.appliedDocId != null) {
        m.set(t.appliedDocId, (m.get(t.appliedDocId) ?? 0) + t.amount);
      }
    }
    return m;
  }, [allTx]);

  const openInvoices = useMemo(() => {
    if (customerId == null) return [] as { inv: SalesInvoice; outstanding: number }[];
    return deps.invoices
      .filter((i) => i.customerId === customerId && i.paymentMethod === "credit" && (i.status ?? "posted") === "posted")
      .map((i) => ({ inv: i, outstanding: i.grandTotal - (paidByInvoice.get(i.id) ?? 0) }))
      .filter((x) => x.outstanding > 0.005);
  }, [customerId, deps.invoices, paidByInvoice]);
  const branchFilter = branchId === "" ? null : Number(branchId);
  const availableCashBoxes = deps.cashBoxes.filter((box) =>
    (box.isActive !== false || box.id === cashBoxId) &&
    (branchFilter == null || !box.branchIds?.length || box.branchIds.includes(branchFilter)),
  );
  const availableBanks = deps.banks.filter((bank) =>
    (bank.isActive !== false || bank.id === bankId) &&
    (branchFilter == null || !bank.branchIds?.length || bank.branchIds.includes(branchFilter)),
  );
  const walletCurrency = walletKind === "bank"
    ? deps.banks.find((bank) => bank.id === bankId)?.currencyCode
    : deps.cashBoxes.find((box) => box.id === cashBoxId)?.currencyCode;

  function pickInvoice(id: number | null) {
    setInvoiceId(id);
    if (id != null) {
      const hit = openInvoices.find((x) => x.inv.id === id);
      if (hit && amount <= 0) setAmount(Number(hit.outstanding.toFixed(2)));
    }
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (customerId == null) throw new Error(text("اختر العميل", "Select a customer."));
      if (amount <= 0) throw new Error(text("أدخل مبلغاً موجباً", "Enter an amount greater than zero."));
      const payload: FinancialTxInput = {
        txDate: date, txType: "receipt",
        partyType: "customer", partyId: customerId,
        cashBoxId: walletKind === "cash" ? cashBoxId : null,
        bankId:    walletKind === "bank" ? bankId : null,
        counterAccountId: null,
        amount, description: desc || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
        appliedDocType: invoiceId != null ? "sales_invoice" : null,
        appliedDocId: invoiceId,
      };
      if (initial) await updateFinancialTx(initial.id, payload); else await createFinancialTx(payload);
      emitData("vouchers", "journal", "customers", "cashboxes", "banks");
      onDone();
      } catch (e: any) { setErr(errText(e, text("تعذر حفظ سند القبض", "Could not save receipt voucher."))); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div style={{ marginBottom: 12, padding: "10px 14px", background: "#ecfdf5", border: "1px solid #a7f3d0", borderRight: "4px solid #16a34a", borderRadius: 8 }}>
        <h3 style={{ margin: 0, color: "#166534", fontSize: 16 }}>{initial ? text(`تعديل مسودة ${initial.txNo}`, `Edit draft ${initial.txNo}`) : text("سند قبض جديد", "New receipt voucher")}</h3>
        <div style={{ marginTop: 3, color: "#4b5563", fontSize: 12 }}>{text("يسجل المبلغ في الخزينة أو البنك ويحدّث رصيد العميل", "Records the receipt in cash or bank and updates the customer balance")}</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, alignItems: "end" }}>
      <Field label={text("العميل", "Customer")}>
        <SearchCombobox
          value={customerId ?? ""}
          onChange={(v) => { setCustomerId(Number(v) || null); setInvoiceId(null); }}
          style={input}
          options={[
            { value: "", label: text("— اختر —", "— Select —") },
            ...deps.customers.map((c) => ({ value: c.id, label: `${c.nameAr} (${text("الرصيد", "Balance")}: ${fmt(c.balance ?? 0)})` })),
          ]}
        />
      </Field>

      {customerId != null && (
        <Field label={text("ربط بفاتورة (اختياري)", "Link to invoice (optional)")}>
          <SearchCombobox
            value={invoiceId ?? ""}
            onChange={(v) => pickInvoice(Number(v) || null)}
            style={input}
            options={[
              { value: "", label: text("— بدون ربط —", "— No link —") },
              ...openInvoices.map((x) => ({ value: x.inv.id, label: `${x.inv.invoiceNo} — ${text("متبقّي", "Outstanding")} ${fmt(x.outstanding)}` })),
              ...(initial?.appliedDocId != null && !openInvoices.some((x) => x.inv.id === initial.appliedDocId)
                ? deps.invoices.filter((inv) => inv.id === initial.appliedDocId).map((inv) => ({
                    value: inv.id, label: `${inv.invoiceNo} — ${text("الفاتورة المرتبطة حالياً", "Currently linked invoice")}`,
                  }))
                : []),
            ]}
          />
        </Field>
      )}
      <Field label={text("التاريخ", "Date")}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
      <Field label={`${text("المبلغ", "Amount")} · ${walletCurrency ?? "SAR"}`}><input type="number" step="0.01" value={amount || ""} onChange={(e) => setAmount(Number(e.target.value) || 0)} style={input} /></Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, alignItems: "end", marginTop: 2 }}>
        <Field label={text("طريقة القبض", "Receipt method")}>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setWalletKind("cash")} type="button" style={walletKind === "cash" ? { ...btnPrimary, background: "#15803d" } : btnSecondary}>{text("نقدي", "Cash")}</button>
            <button onClick={() => setWalletKind("bank")} type="button" style={walletKind === "bank" ? { ...btnPrimary, background: "#15803d" } : btnSecondary}>{text("بنكي", "Bank")}</button>
          </div>
        </Field>
      {walletKind === "cash" ? (
        <Field label={text("الخزينة", "Cashbox")}>
          <SearchCombobox value={cashBoxId ?? ""} onChange={(v) => setCashBoxId(Number(v) || null)} style={input}
            options={availableCashBoxes.map((c) => ({ value: c.id, label: `${c.name} (${fmt(c.balance)} ${c.currencyCode})` }))} />
        </Field>
      ) : (
        <Field label={text("البنك", "Bank")}>
          <SearchCombobox value={bankId ?? ""} onChange={(v) => setBankId(Number(v) || null)} style={input}
            options={availableBanks.map((b) => ({ value: b.id, label: `${b.name} (${fmt(b.balance)} ${b.currencyCode})` }))} />
        </Field>
      )}
        <Field label={text("الفرع", "Branch")}>
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label={text("مركز التكلفة", "Cost center")}>
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} options={costCenterPickerOptions(costCenters)} style={input} />
        </Field>
      </div>
      <Field label={text("البيان", "Description")} style={{ marginTop: 2 }}><textarea value={desc} onChange={(e) => setDesc(e.target.value)} style={{ ...input, minHeight: 44, resize: "vertical" }} /></Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
        <button onClick={save} disabled={busy} type="button" style={{ ...btnPrimary, background: "#15803d" }}>{busy ? "..." : initial ? text("حفظ المسودة", "Save draft") : text("حفظ السند", "Save voucher")}</button>
      </Actions>
    </div>
  );
}
