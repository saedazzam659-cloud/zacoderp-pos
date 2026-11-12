import { useEffect, useMemo, useState } from "react";
import {
  listFinancialTx, createFinancialTx, updateFinancialTx, deleteFinancialTx, financialTxPost, financialTxUnpost,
  listSuppliers, listCashBoxes, listBanks, listPurchases, type FinancialTxInput,
  type FinancialTx, type FinancialTxAllocation, type Supplier, type CashBox, type Bank, type Purchase,
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
import { baseCurrencyCode } from "../lib/currency";

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

  const invoiceLabel = (f: FinancialTx) => {
    const links = f.allocations?.length
      ? f.allocations.filter((a) => a.docType === "purchase")
      : f.appliedDocType === "purchase" && f.appliedDocId != null
        ? [{ docId: f.appliedDocId, amount: f.amount }] : [];
    return links.map((a) => deps?.purchases.find((i) => i.id === a.docId)?.invoiceNo ?? "")
      .filter(Boolean).join(", ");
  };
  const columns = useMemo<GridColumn<FinancialTx>[]>(() => [
    { key: "txNo", label: text("الرقم", "Number"), value: (f) => f.txNo },
    { key: "txDate", label: text("التاريخ", "Date"), value: (f) => f.txDate },
    { key: "party", label: text("المورد", "Supplier"), value: (f) => f.partyName ?? "" },
    { key: "invoice", label: text("الفواتير المرتبطة", "Linked invoices"), value: invoiceLabel },
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
                linkedDocNo: invoiceLabel(f) || null,
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
                return (
                  <tr key={f.id}>
                    <SelectCell id={f.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                    <Td mono>{f.txNo}</Td><Td>{formatUiDate(f.txDate, language)}</Td>
                    <Td>{f.partyName ?? "—"}</Td>
                    <Td mono>{invoiceLabel(f) || "—"}</Td>
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
  const [allocations, setAllocations] = useState<Record<number, number>>(() => {
    const links = initial?.allocations?.filter((a) => a.docType === "purchase") ?? [];
    if (links.length) return Object.fromEntries(links.map((a) => [a.docId, a.amount]));
    return initial?.appliedDocType === "purchase" && initial.appliedDocId != null
      ? { [initial.appliedDocId]: initial.amount } : {};
  });
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
      if (t.status !== "posted" || t.txType !== "payment") continue;
      const links = t.allocations?.length
        ? t.allocations.filter((a) => a.docType === "purchase")
        : t.appliedDocType === "purchase" && t.appliedDocId != null
          ? [{ docId: t.appliedDocId, amount: t.amount }] : [];
      for (const link of links) m.set(link.docId, (m.get(link.docId) ?? 0) + link.amount);
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
  const selectedTotal = Object.values(allocations).reduce((sum, value) => sum + value, 0);
  const voucherAmount = Object.keys(allocations).length ? selectedTotal : amount;
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

  function togglePurchase(id: number, selected: boolean) {
    if (!selected) {
      setAllocations((current) => { const next = { ...current }; delete next[id]; return next; });
      return;
    }
    const hit = openPurchases.find((x) => x.inv.id === id);
    if (hit) setAllocations((current) => ({ ...current, [id]: Number(hit.outstanding.toFixed(2)) }));
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (supplierId == null) throw new Error(text("اختر المورد", "Select a supplier."));
      if (voucherAmount <= 0) throw new Error(text("أدخل مبلغاً موجباً", "Enter an amount greater than zero."));
      if (Object.entries(allocations).some(([id, allocated]) => {
        const invoice = openPurchases.find((item) => item.inv.id === Number(id));
        return !invoice || allocated <= 0 || allocated > invoice.outstanding + 0.01;
      })) throw new Error(text("تحقق من أن مبلغ كل فاتورة لا يتجاوز رصيدها المتبقي", "Each allocation must be positive and no greater than its outstanding balance."));
      const invoiceAllocations: FinancialTxAllocation[] = Object.entries(allocations)
        .map(([docId, allocated]) => ({ docType: "purchase", docId: Number(docId), amount: allocated }));
      if (invoiceAllocations.length && walletCurrency !== baseCurrencyCode()) {
        throw new Error(text(`اختر خزينة أو بنكًا بالعملة الأساسية ${baseCurrencyCode()} لربط الفواتير`, `Choose a cashbox or bank in the base currency ${baseCurrencyCode()} to allocate invoices.`));
      }
      const singleLink = invoiceAllocations.length === 1 ? invoiceAllocations[0] : null;
      const payload: FinancialTxInput = {
        txDate: date, txType: "payment",
        partyType: "supplier", partyId: supplierId,
        cashBoxId: walletKind === "cash" ? cashBoxId : null,
        bankId:    walletKind === "bank" ? bankId : null,
        counterAccountId: null,
        amount: voucherAmount, description: desc || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
        appliedDocType: singleLink?.docType ?? null,
        appliedDocId: singleLink?.docId ?? null,
        allocations: invoiceAllocations,
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
          onChange={(v) => { setSupplierId(Number(v) || null); setAllocations({}); }}
          style={input}
          options={[
            { value: "", label: text("— اختر —", "— Select —") },
            ...deps.suppliers.map((s) => ({ value: s.id, label: `${s.nameAr} (${text("الرصيد", "Balance")}: ${fmt(s.balance)})` })),
          ]}
        />
      </Field>
      <Field label={text("التاريخ", "Date")}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
      <Field label={`${text("المبلغ", "Amount")} · ${walletCurrency ?? "SAR"}`}>
        <input type="number" step="0.01" value={voucherAmount || ""} readOnly={Object.keys(allocations).length > 0}
          onChange={(e) => setAmount(Number(e.target.value) || 0)} style={{ ...input, ...(Object.keys(allocations).length ? { background: "#f8fafc" } : {}) }} />
      </Field>
      </div>
      {supplierId != null && (
        <div style={{ marginTop: 8, border: "1px solid #d1d5db", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 10px", background: "#f8fafc", fontWeight: 700, fontSize: 13 }}>
            {text("فواتير الشراء الآجلة المفتوحة — اختر فاتورة أو أكثر", "Open credit purchase invoices — select one or more")}
          </div>
          {openPurchases.length === 0 ? <div style={{ padding: 10, color: "#64748b", fontSize: 12 }}>{text("لا توجد فواتير آجلة متبقية لهذا المورد", "No outstanding credit invoices for this supplier")}</div> : (
            <div style={{ maxHeight: 180, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ background: "#f1f5f9" }}>
                  <th style={{ padding: 7, textAlign: "center" }}></th>
                  <th style={{ padding: 7, textAlign: "right" }}>{text("الفاتورة", "Invoice")}</th>
                  <th style={{ padding: 7, textAlign: "right" }}>{text("الرصيد المطلوب", "Outstanding")}</th>
                  <th style={{ padding: 7, textAlign: "right" }}>{text("المبلغ المخصص", "Amount")}</th>
                </tr></thead>
                <tbody>{openPurchases.map(({ inv, outstanding }) => {
                  const selected = allocations[inv.id] != null;
                  return <tr key={inv.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={{ padding: 6, textAlign: "center" }}><input type="checkbox" checked={selected} onChange={(e) => togglePurchase(inv.id, e.target.checked)} /></td>
                    <td style={{ padding: 6 }}>{inv.invoiceNo} · {inv.invoiceDate}</td>
                    <td style={{ padding: 6, fontVariantNumeric: "tabular-nums" }}>{fmt(outstanding)}</td>
                    <td style={{ padding: 6, width: 160 }}>
                      <input type="number" min="0.01" max={outstanding} step="0.01" disabled={!selected}
                        value={selected ? allocations[inv.id] : ""}
                        onChange={(e) => {
                          const value = Math.min(Math.max(0, Number(e.target.value) || 0), outstanding);
                          setAllocations((current) => ({ ...current, [inv.id]: value }));
                        }} style={{ ...input, padding: "5px 7px" }} />
                    </td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          )}
          {Object.keys(allocations).length > 0 && <div style={{ padding: "7px 10px", borderTop: "1px solid #e5e7eb", textAlign: "left", fontWeight: 700, color: "#9f1239" }}>
            {text("إجمالي السند:", "Voucher total:")} {fmt(selectedTotal)}
          </div>}
        </div>
      )}
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
