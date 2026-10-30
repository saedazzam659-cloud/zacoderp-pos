import { useEffect, useMemo, useState } from "react";
import {
  listFinancialTx, createFinancialTx, listSuppliers, listCashBoxes, listBanks, listPurchases,
  type FinancialTx, type Supplier, type CashBox, type Bank, type Purchase,
} from "../lib/accounting";
import { emitData, useDataRefresh } from "../lib/dataBus";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, fmt, todayStr, SearchCombobox,
  useGridFilter, GridToolbar, SortableTh, GridFilterRow, type GridColumn,
  ExportButtons, gridToExportCols,
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
  const [rows, setRows] = useState<FinancialTx[]>([]);
  const [creating, setCreating] = useState(false);
  const [deps, setDeps] = useState<{ suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; purchases: Purchase[] } | null>(null);

  async function refresh() { setRows((await listFinancialTx(1000)).filter((f) => f.txType === "payment" && f.partyType === "supplier")); }
  async function loadDeps() {
    const [suppliers, cashBoxes, banks, purchases] = await Promise.all([
      listSuppliers(), listCashBoxes(), listBanks(), listPurchases(5000),
    ]);
    setDeps({ suppliers, cashBoxes, banks, purchases });
  }
  useEffect(() => { void refresh(); void loadDeps(); }, []);

  const [allTx, setAllTx] = useState<FinancialTx[]>([]);
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
  ], [deps, language]);
  const grid = useGridFilter(rows, columns);
  const sel = useRowSelect(grid.view);

  return (
    <div dir={language === "en" ? "ltr" : "rtl"}>
    <Page
      title={text("سند صرف للموردين", "Supplier payment vouchers")}
      subtitle={text("سند صرف مرتبط بالمورد — يخصم من رصيد المورد ويظهر في كشف حسابه", "Supplier payments reduce the supplier balance and appear on the supplier statement")}
      right={
        <button onClick={() => setCreating(true)}
          style={{ ...btnPrimary, background: "#b91c1c", opacity: (!deps || creating) ? 0.5 : 1, cursor: (!deps || creating) ? "not-allowed" : "pointer" }}
          disabled={!deps || creating}>+ {text("سند صرف", "Payment voucher")}</button>
      }
    >
      {creating && deps && (
        <Card style={{ marginBottom: 12, border: "2px solid #b91c1c" }}>
          <div style={{ padding: 16 }}>
            <PayForm deps={deps} allTx={allTx} onCancel={() => setCreating(false)} onDone={() => { setCreating(false); void refresh(); }} />
          </div>
        </Card>
      )}
      {rows.length > 0 && <GridToolbar grid={grid} placeholder={text("🔍 بحث في سندات الصرف…", "🔍 Search payment vouchers…")} extra={<ExportButtons columns={gridToExportCols(columns)} rows={grid.view} filenameBase="supplier-payments" title={text("سندات الصرف للموردين", "Supplier payment vouchers")} />} />}
      {rows.length > 0 && (
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
        </ActionBar>
      )}
      <Card>
        {rows.length === 0 && !creating ? <Empty text={text("لا توجد سندات صرف للموردين", "No supplier payment vouchers")} /> : grid.view.length === 0 ? <Empty text={text("لا نتائج مطابقة للبحث", "No matching results")} /> : (
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

function PayForm({ deps, allTx, onCancel, onDone }: {
  deps: { suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; purchases: Purchase[] };
  allTx: FinancialTx[];
  onCancel: () => void; onDone: () => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const { branches, costCenters } = useDimensions();
  const [date, setDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [purchaseId, setPurchaseId] = useState<number | null>(null);
  const [walletKind, setWalletKind] = useState<"cash" | "bank">("cash");
  const [cashBoxId, setCashBoxId] = useState<number | null>(deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(deps.banks[0]?.id ?? null);
  const [amount, setAmount] = useState<number>(0);
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Paid-so-far per purchase invoice (across ALL supplier payments).
  const paidByPurchase = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of allTx) {
      if (t.txType === "payment" && t.appliedDocType === "purchase" && t.appliedDocId != null) {
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
      await createFinancialTx({
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
      });
      emitData("vouchers", "journal", "suppliers", "cashboxes", "banks");
      onDone();
    } catch (e: any) { setErr(e?.message ?? text("فشل", "Could not save payment voucher.")); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0, color: "#b91c1c" }}>{text("سند صرف جديد", "New payment voucher")}</h3>
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
            ]}
          />
        </Field>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <Field label={text("التاريخ", "Date")}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label={text("المبلغ", "Amount")}><input type="number" step="0.01" value={amount || ""} onChange={(e) => setAmount(Number(e.target.value) || 0)} style={input} /></Field>
        <Field label={text("المحفظة", "Wallet")}>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setWalletKind("cash")} type="button" style={walletKind === "cash" ? btnPrimary : btnSecondary}>{text("خزينة", "Cashbox")}</button>
            <button onClick={() => setWalletKind("bank")} type="button" style={walletKind === "bank" ? btnPrimary : btnSecondary}>{text("بنك", "Bank")}</button>
          </div>
        </Field>
      </div>

      {walletKind === "cash" ? (
        <Field label={text("الخزينة", "Cashbox")}>
          <SearchCombobox value={cashBoxId ?? ""} onChange={(v) => setCashBoxId(Number(v) || null)} style={input}
            options={deps.cashBoxes.map((c) => ({ value: c.id, label: `${c.name} (${fmt(c.balance)})` }))} />
        </Field>
      ) : (
        <Field label={text("البنك", "Bank")}>
          <SearchCombobox value={bankId ?? ""} onChange={(v) => setBankId(Number(v) || null)} style={input}
            options={deps.banks.map((b) => ({ value: b.id, label: `${b.name} (${fmt(b.balance)})` }))} />
        </Field>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={text("الفرع", "Branch")}>
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label={text("مركز التكلفة", "Cost center")}>
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} options={costCenterPickerOptions(costCenters)} style={input} />
        </Field>
      </div>
      <Field label={text("البيان", "Description")}><textarea value={desc} onChange={(e) => setDesc(e.target.value)} style={{ ...input, minHeight: 50 }} /></Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
        <button onClick={save} disabled={busy} type="button" style={{ ...btnPrimary, background: "#b91c1c" }}>{busy ? "..." : text("حفظ وترحيل", "Save and post")}</button>
      </Actions>
    </div>
  );
}
