import { useEffect, useMemo, useState } from "react";
import {
  listFinancialTx, createFinancialTx, updateFinancialTx, deleteFinancialTx, financialTxPost, financialTxUnpost,
  confirmUnpostAction,
  listSuppliers, listCashBoxes, listBanks, listPurchases, type FinancialTxInput,
  type FinancialTx, type Supplier, type CashBox, type Bank, type Purchase,
} from "../lib/accounting";
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

function payWalletName(
  deps: { cashBoxes: CashBox[]; banks: Bank[] } | null,
  f: FinancialTx,
): string | null {
  if (!deps) return null;
  if (f.bankId != null) return deps.banks.find((b) => b.id === f.bankId)?.name ?? null;
  if (f.cashBoxId != null) return deps.cashBoxes.find((c) => c.id === f.cashBoxId)?.name ?? null;
  return null;
}

// سند صرف لمورد — a supplier-scoped payment voucher. Reuses the shared
// financial_tx pipeline (DR AP, CR cash/bank, decrements supplier balance),
// optionally tagging the payment to a specific outstanding purchase invoice so
// the purchase list + supplier statement can surface the paid amount.
export default function SupplierPaymentAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const { branches, costCenters } = useDimensions();
  const [rows, setRows] = useState<FinancialTx[]>([]);
  const [creating, setCreating] = useState(false);
  const [editingVoucher, setEditingVoucher] = useState<FinancialTx | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const formOpen = creating || editingVoucher != null;
  const [allTx, setAllTx] = useState<FinancialTx[]>([]);
  const [deps, setDeps] = useState<{ suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; purchases: Purchase[] } | null>(null);

  async function refresh() { setRows((await listFinancialTx(1000)).filter((f) => f.txType === "payment" && f.partyType === "supplier")); }
  function refreshAfterVoucherChange() {
    emitData("vouchers", "journal", "suppliers", "cashboxes", "banks");
    void refresh();
    void loadDeps();
    void listFinancialTx(5000).then(setAllTx);
  }
  async function loadDeps() {
    const [suppliers, cashBoxes, banks, purchases] = await Promise.all([
      listSuppliers(), listCashBoxes(), listBanks(), listPurchases(5000),
    ]);
    setDeps({ suppliers, cashBoxes, banks, purchases });
  }
  useEffect(() => { void refresh(); void loadDeps(); }, []);

  useEffect(() => { void (async () => setAllTx(await listFinancialTx(5000)))(); }, [rows.length]);

  // Live-refresh: when a purchase invoice or another voucher is created/posted on
  // a different tab, reload the deps (outstanding-purchase picker) + paid totals
  // so the new invoice appears here without a manual page reload.
  useDataRefresh(["invoices", "vouchers", "suppliers", "cashboxes", "banks"], () => {
    void refresh();
    void loadDeps();
    void (async () => setAllTx(await listFinancialTx(5000)))();
  });

  const invByApplied = (f: FinancialTx) =>
    f.appliedDocType === "purchase" && f.appliedDocId != null
      ? deps?.purchases.find((i) => i.id === f.appliedDocId) ?? null : null;
  const columns = useMemo<GridColumn<FinancialTx>[]>(() => [
    { key: "txNo", label: text("الرقم", "Number"), value: (f) => f.txNo },
    { key: "txDate", label: text("التاريخ", "Date"), value: (f) => f.txDate },
    { key: "party", label: text("المورد", "Supplier"), value: (f) => f.partyName ?? "" },
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
      title={text("سند الصرف", "Payment vouchers")}
      subtitle={text("سند صرف للمورد — يُخصم من رصيده ويظهر في كشف حسابه", "Supplier payments reduce the supplier balance and appear on the supplier statement")}
      right={<button onClick={() => { setEditingVoucher(null); setCreating(true); }}
        style={{ ...btnPrimary, background: "#b91c1c", opacity: (!deps || formOpen) ? 0.5 : 1, cursor: (!deps || formOpen) ? "not-allowed" : "pointer" }}
        disabled={!deps || formOpen}>+ {text("سند صرف", "Payment voucher")}</button>}
    >
      {formOpen && deps && (
        <Card style={{ marginBottom: 12, border: "2px solid #b91c1c" }}>
          <div style={{ padding: 16 }}>
            <PayForm deps={deps} allTx={allTx} initial={editingVoucher}
              onCancel={() => { setCreating(false); setEditingVoucher(null); }}
              onDone={() => { setCreating(false); setEditingVoucher(null); void refresh(); }} />
          </div>
        </Card>
      )}
      {rows.length > 0 && !formOpen && <GridToolbar grid={grid} placeholder={text("🔍 بحث في سندات الصرف…", "🔍 Search payment vouchers…")} extra={<ExportButtons columns={gridToExportCols(columns)} rows={grid.view} filenameBase="supplier-payments" title={text("سندات الصرف للموردين", "Supplier payment vouchers")} />} />}
      {rows.length > 0 && !formOpen && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.txNo : null}>
          <ActionBtn label={text("طباعة", "Print")} icon="🖨️" tone="primary" disabled={!sel.selected}
            onClick={() => {
              const f = sel.selected; if (!f) return;
              const inv = invByApplied(f);
              printVoucher({
                kind: "payment",
                title: text("سند صرف", "Payment voucher"),
                docNo: f.txNo,
                date: f.txDate,
                partyName: f.partyName ?? null,
                amount: f.amount,
                description: f.description ?? null,
                walletKind: f.bankId != null ? "bank" : "cash",
                walletName: payWalletName(deps, f),
                linkedDocNo: inv ? inv.invoiceNo : null,
              });
            }} />
          <VoucherActions
            selected={sel.selected}
            busy={busyId != null}
            text={text}
            english={language === "en"}
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
        {rows.length === 0 && !formOpen ? <Empty text={text("لا توجد سندات صرف للموردين", "No supplier payment vouchers")} /> : grid.view.length === 0 ? <Empty text={text("لا نتائج مطابقة للبحث", "No matching results")} /> : (
          <Table>
            <thead>
              <tr>
                <SelectTh />
                <SortableTh grid={grid} colKey="txNo">{text("الرقم", "Number")}</SortableTh>
                <SortableTh grid={grid} colKey="txDate">{text("التاريخ", "Date")}</SortableTh>
                <SortableTh grid={grid} colKey="party">{text("المورد", "Supplier")}</SortableTh>
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
                    <Td num style={{ fontWeight: 600, color: "#b91c1c" }}>{fmt(f.amount)}</Td>
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

function VoucherActions({ selected, busy, text, english, onEdit, onDelete, onPost, onUnpost }: {
  selected: FinancialTx | null;
  busy: boolean;
  text: (ar: string, en: string) => string;
  english: boolean;
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
      onClick={() => {
        if (!selected) return;
        void confirmUnpostAction(text("السند", "voucher"), selected.txNo, english).then((ok) => { if (ok) onUnpost(selected); });
      }} />
  </>;
}

function VoucherStatus({ status }: { status: string }) {
  const language = useUiLanguage();
  const draft = status === "draft";
  return <span style={{ padding: "3px 8px", borderRadius: 999, background: draft ? "#fef3c7" : "#dcfce7", color: draft ? "#92400e" : "#166534", fontSize: 11, fontWeight: 700 }}>
    {draft ? uiText("مسودة", "Draft", language) : uiText("مرحّل", "Posted", language)}
  </span>;
}

function PayForm({ deps, allTx, initial, onCancel, onDone }: {
  deps: { suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; purchases: Purchase[] };
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
  const [supplierId, setSupplierId] = useState<number | null>(initial?.partyId ?? null);
  const [purchaseId, setPurchaseId] = useState<number | null>(initial?.appliedDocId ?? null);
  const [walletKind, setWalletKind] = useState<"cash" | "bank">(initial?.bankId != null ? "bank" : "cash");
  const [cashBoxId, setCashBoxId] = useState<number | null>(initial?.cashBoxId ?? deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(initial?.bankId ?? deps.banks[0]?.id ?? null);
  const [amount, setAmount] = useState<number>(initial?.amount ?? 0);
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Paid-so-far per purchase invoice (across ALL supplier payments).
  const paidByPurchase = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of allTx) {
      if (t.status === "posted" && t.txType === "payment" && t.appliedDocType === "purchase" && t.appliedDocId != null) {
        m.set(t.appliedDocId, (m.get(t.appliedDocId) ?? 0) + t.amount);
      }
    }
    return m;
  }, [allTx]);

  const openPurchases = useMemo(() => {
    if (supplierId == null) return [] as { inv: Purchase; outstanding: number }[];
    return deps.purchases
      .filter((i) => i.supplierId === supplierId && i.paymentMethod === "credit" && (i.status ?? "posted") === "posted")
      .map((i) => ({ inv: i, outstanding: i.grandTotal - (paidByPurchase.get(i.id) ?? 0) }))
      .filter((x) => x.outstanding > 0.005);
  }, [supplierId, deps.purchases, paidByPurchase]);
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

  function pickPurchase(id: number | null) {
    setPurchaseId(id);
    if (id != null) {
      const hit = openPurchases.find((x) => x.inv.id === id);
      if (hit && amount <= 0) setAmount(Number(hit.outstanding.toFixed(2)));
    }
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (supplierId == null) throw new Error(text("اختر المورد", "Select a supplier."));
      if (amount <= 0) throw new Error(text("أدخل مبلغاً موجباً", "Enter an amount greater than zero."));
      const payload: FinancialTxInput = {
        txDate: date, txType: "payment",
        partyType: "supplier", partyId: supplierId,
        cashBoxId: walletKind === "cash" ? cashBoxId : null,
        bankId:    walletKind === "bank" ? bankId : null,
        counterAccountId: null,
        amount, description: desc || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
        appliedDocType: purchaseId != null ? "purchase" : null,
        appliedDocId: purchaseId,
      };
      if (initial) await updateFinancialTx(initial.id, payload); else await createFinancialTx(payload);
      emitData("vouchers", "journal", "suppliers", "cashboxes", "banks");
      onDone();
      } catch (e: any) { setErr(errText(e, text("تعذر حفظ سند الصرف", "Could not save payment voucher."))); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div style={{ marginBottom: 12, padding: "10px 14px", background: "#fff1f2", border: "1px solid #fecdd3", borderRight: "4px solid #e11d48", borderRadius: 8 }}>
        <h3 style={{ margin: 0, color: "#9f1239", fontSize: 16 }}>{initial ? text(`تعديل مسودة ${initial.txNo}`, `Edit draft ${initial.txNo}`) : text("سند صرف جديد", "New payment voucher")}</h3>
        <div style={{ marginTop: 3, color: "#4b5563", fontSize: 12 }}>{text("يسجل المبلغ المصروف ويحدّث رصيد المورد", "Records the payment and updates the supplier balance")}</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, alignItems: "end" }}>
      <Field label={text("المورد", "Supplier")}>
        <SearchCombobox
          value={supplierId ?? ""}
          onChange={(v) => { setSupplierId(Number(v) || null); setPurchaseId(null); }}
          style={input}
          options={[
            { value: "", label: text("— اختر —", "— Select —") },
            ...deps.suppliers.map((s) => ({ value: s.id, label: `${s.nameAr} (${text("الرصيد", "Balance")}: ${fmt(s.balance)})` })),
          ]}
        />
      </Field>
      {supplierId != null && (
        <Field label={text("ربط بفاتورة شراء (اختياري)", "Link to purchase invoice (optional)")}>
          <SearchCombobox
            value={purchaseId ?? ""}
            onChange={(v) => pickPurchase(Number(v) || null)}
            style={input}
            options={[
              { value: "", label: text("— بدون ربط —", "— No link —") },
              ...openPurchases.map((x) => ({ value: x.inv.id, label: `${x.inv.invoiceNo} — ${text("متبقّي", "Outstanding")} ${fmt(x.outstanding)}` })),
              ...(initial?.appliedDocId != null && !openPurchases.some((x) => x.inv.id === initial.appliedDocId)
                ? deps.purchases.filter((purchase) => purchase.id === initial.appliedDocId).map((purchase) => ({
                    value: purchase.id, label: `${purchase.invoiceNo} — ${text("الفاتورة المرتبطة حالياً", "Currently linked invoice")}`,
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
        <Field label={text("طريقة الصرف", "Payment method")}>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setWalletKind("cash")} type="button" style={walletKind === "cash" ? { ...btnPrimary, background: "#b91c1c" } : btnSecondary}>{text("نقدي", "Cash")}</button>
            <button onClick={() => setWalletKind("bank")} type="button" style={walletKind === "bank" ? { ...btnPrimary, background: "#b91c1c" } : btnSecondary}>{text("بنكي", "Bank")}</button>
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
        <button onClick={save} disabled={busy} type="button" style={{ ...btnPrimary, background: "#b91c1c" }}>{busy ? "..." : initial ? text("حفظ المسودة", "Save draft") : text("حفظ السند", "Save voucher")}</button>
      </Actions>
    </div>
  );
}
