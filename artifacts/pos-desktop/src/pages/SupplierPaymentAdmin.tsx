import { useEffect, useMemo, useState } from "react";
import {
  listFinancialTx, createFinancialTx, listSuppliers, listCashBoxes, listBanks, listPurchases,
  type FinancialTx, type Supplier, type CashBox, type Bank, type Purchase,
} from "../lib/accounting";
import { emitData } from "../lib/dataBus";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, fmt, todayStr, SearchCombobox,
  useGridFilter, GridToolbar, SortableTh, GridFilterRow, type GridColumn,
  ExportButtons, gridToExportCols,
  useRowSelect, SelectTh, SelectCell, ActionBar, ActionBtn,
} from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { printVoucher } from "../lib/invoicePrint";

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
  const [rows, setRows] = useState<FinancialTx[]>([]);
  const [creating, setCreating] = useState(false);
  const [deps, setDeps] = useState<{ suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; purchases: Purchase[] } | null>(null);

  async function refresh() { setRows((await listFinancialTx(1000)).filter((f) => f.txType === "payment" && f.partyType === "supplier")); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [suppliers, cashBoxes, banks, purchases] = await Promise.all([
        listSuppliers(), listCashBoxes(), listBanks(), listPurchases(5000),
      ]);
      setDeps({ suppliers, cashBoxes, banks, purchases });
    })();
  }, []);

  const [allTx, setAllTx] = useState<FinancialTx[]>([]);
  useEffect(() => { void (async () => setAllTx(await listFinancialTx(5000)))(); }, [rows.length]);

  const invByApplied = (f: FinancialTx) =>
    f.appliedDocType === "purchase" && f.appliedDocId != null
      ? deps?.purchases.find((i) => i.id === f.appliedDocId) ?? null : null;
  const columns = useMemo<GridColumn<FinancialTx>[]>(() => [
    { key: "txNo", label: "الرقم", value: (f) => f.txNo },
    { key: "txDate", label: "التاريخ", value: (f) => f.txDate },
    { key: "party", label: "المورد", value: (f) => f.partyName ?? "" },
    { key: "invoice", label: "الفاتورة المرتبطة", value: (f) => invByApplied(f)?.invoiceNo ?? "" },
    { key: "description", label: "البيان", value: (f) => f.description ?? "" },
    { key: "amount", label: "المبلغ", type: "number", value: (f) => f.amount },
  ], [deps]);
  const grid = useGridFilter(rows, columns);
  const sel = useRowSelect(grid.view);

  return (
    <Page
      title="سند صرف للموردين"
      subtitle="سند صرف مرتبط بالمورد — يخصم من رصيد المورد ويظهر في كشف حسابه"
      right={
        <button onClick={() => setCreating(true)}
          style={{ ...btnPrimary, background: "#b91c1c", opacity: (!deps || creating) ? 0.5 : 1, cursor: (!deps || creating) ? "not-allowed" : "pointer" }}
          disabled={!deps || creating}>+ سند صرف</button>
      }
    >
      {creating && deps && (
        <Card style={{ marginBottom: 12, border: "2px solid #b91c1c" }}>
          <div style={{ padding: 16 }}>
            <PayForm deps={deps} allTx={allTx} onCancel={() => setCreating(false)} onDone={() => { setCreating(false); void refresh(); }} />
          </div>
        </Card>
      )}
      {rows.length > 0 && <GridToolbar grid={grid} placeholder="🔍 بحث في سندات الصرف…" extra={<ExportButtons columns={gridToExportCols(columns)} rows={grid.view} filenameBase="سندات-الصرف" title="سندات الصرف للموردين" />} />}
      {rows.length > 0 && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.txNo : null}>
          <ActionBtn label="طباعة" icon="🖨️" tone="primary" disabled={!sel.selected}
            onClick={() => {
              const f = sel.selected; if (!f) return;
              const inv = invByApplied(f);
              printVoucher({
                kind: "payment",
                title: "سند صرف",
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
        {rows.length === 0 && !creating ? <Empty text="لا توجد سندات صرف للموردين" /> : grid.view.length === 0 ? <Empty text="لا نتائج مطابقة للبحث" /> : (
          <Table>
            <thead>
              <tr>
                <SelectTh />
                <SortableTh grid={grid} colKey="txNo">الرقم</SortableTh>
                <SortableTh grid={grid} colKey="txDate">التاريخ</SortableTh>
                <SortableTh grid={grid} colKey="party">المورد</SortableTh>
                <SortableTh grid={grid} colKey="invoice">الفاتورة المرتبطة</SortableTh>
                <SortableTh grid={grid} colKey="description">البيان</SortableTh>
                <SortableTh grid={grid} colKey="amount" style={{ textAlign: "left" }}>المبلغ</SortableTh>
              </tr>
              <GridFilterRow grid={grid} columns={columns} leading={1} />
            </thead>
            <tbody>
              {grid.view.map((f) => {
                const inv = invByApplied(f);
                return (
                  <tr key={f.id}>
                    <SelectCell id={f.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                    <Td mono>{f.txNo}</Td><Td>{f.txDate}</Td>
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
  );
}

function PayForm({ deps, allTx, onCancel, onDone }: {
  deps: { suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; purchases: Purchase[] };
  allTx: FinancialTx[];
  onCancel: () => void; onDone: () => void;
}) {
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
      if (supplierId == null) throw new Error("اختر المورد");
      if (amount <= 0) throw new Error("أدخل مبلغاً موجباً");
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
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0, color: "#b91c1c" }}>سند صرف جديد</h3>
      <Field label="المورد">
        <SearchCombobox
          value={supplierId ?? ""}
          onChange={(v) => { setSupplierId(Number(v) || null); setPurchaseId(null); }}
          style={input}
          options={[
            { value: "", label: "— اختر —" },
            ...deps.suppliers.map((s) => ({ value: s.id, label: `${s.nameAr} (رصيد: ${fmt(s.balance)})` })),
          ]}
        />
      </Field>

      {supplierId != null && (
        <Field label="ربط بفاتورة شراء (اختياري)">
          <SearchCombobox
            value={purchaseId ?? ""}
            onChange={(v) => pickPurchase(Number(v) || null)}
            style={input}
            options={[
              { value: "", label: "— بدون ربط —" },
              ...openPurchases.map((x) => ({ value: x.inv.id, label: `${x.inv.invoiceNo} — متبقّي ${fmt(x.outstanding)}` })),
            ]}
          />
        </Field>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="المبلغ"><input type="number" step="0.01" value={amount || ""} onChange={(e) => setAmount(Number(e.target.value) || 0)} style={input} /></Field>
        <Field label="المحفظة">
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setWalletKind("cash")} type="button" style={walletKind === "cash" ? btnPrimary : btnSecondary}>خزينة</button>
            <button onClick={() => setWalletKind("bank")} type="button" style={walletKind === "bank" ? btnPrimary : btnSecondary}>بنك</button>
          </div>
        </Field>
      </div>

      {walletKind === "cash" ? (
        <Field label="الخزينة">
          <SearchCombobox value={cashBoxId ?? ""} onChange={(v) => setCashBoxId(Number(v) || null)} style={input}
            options={deps.cashBoxes.map((c) => ({ value: c.id, label: `${c.name} (${fmt(c.balance)})` }))} />
        </Field>
      ) : (
        <Field label="البنك">
          <SearchCombobox value={bankId ?? ""} onChange={(v) => setBankId(Number(v) || null)} style={input}
            options={deps.banks.map((b) => ({ value: b.id, label: `${b.name} (${fmt(b.balance)})` }))} />
        </Field>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="الفرع">
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label="مركز التكلفة">
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} options={costCenterPickerOptions(costCenters)} style={input} />
        </Field>
      </div>
      <Field label="البيان"><textarea value={desc} onChange={(e) => setDesc(e.target.value)} style={{ ...input, minHeight: 50 }} /></Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} type="button" style={{ ...btnPrimary, background: "#b91c1c" }}>{busy ? "..." : "حفظ وترحيل"}</button>
      </Actions>
    </div>
  );
}
