import { useEffect, useMemo, useState } from "react";
import {
  listFinancialTx, createFinancialTx, listCashBoxes, listBanks, listSalesInvoices,
  type FinancialTx, type CashBox, type Bank, type SalesInvoice,
} from "../lib/accounting";
import { listCustomers, type LocalCustomer } from "../lib/customers";
import { emitData } from "../lib/dataBus";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, fmt, todayStr, SearchCombobox,
  useGridFilter, GridToolbar, SortableTh, GridFilterRow, type GridColumn,
  ExportButtons, gridToExportCols,
} from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { printVoucher } from "../lib/invoicePrint";

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
  const [rows, setRows] = useState<FinancialTx[]>([]);
  const [creating, setCreating] = useState(false);
  const [deps, setDeps] = useState<{ customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; invoices: SalesInvoice[] } | null>(null);

  async function refresh() { setRows((await listFinancialTx(1000)).filter((f) => f.txType === "receipt" && f.partyType === "customer")); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [customers, cashBoxes, banks, invoices] = await Promise.all([
        listCustomers(), listCashBoxes(), listBanks(), listSalesInvoices(5000),
      ]);
      setDeps({ customers, cashBoxes, banks, invoices });
    })();
  }, []);

  // Paid-so-far per sales invoice (across ALL receipts, not just this filtered view).
  const [allTx, setAllTx] = useState<FinancialTx[]>([]);
  useEffect(() => { void (async () => setAllTx(await listFinancialTx(5000)))(); }, [rows.length]);

  const invByApplied = (f: FinancialTx) =>
    f.appliedDocType === "sales_invoice" && f.appliedDocId != null
      ? deps?.invoices.find((i) => i.id === f.appliedDocId) ?? null : null;
  const columns = useMemo<GridColumn<FinancialTx>[]>(() => [
    { key: "txNo", label: "الرقم", value: (f) => f.txNo },
    { key: "txDate", label: "التاريخ", value: (f) => f.txDate },
    { key: "party", label: "العميل", value: (f) => f.partyName ?? "" },
    { key: "invoice", label: "الفاتورة المرتبطة", value: (f) => invByApplied(f)?.invoiceNo ?? "" },
    { key: "description", label: "البيان", value: (f) => f.description ?? "" },
    { key: "amount", label: "المبلغ", type: "number", value: (f) => f.amount },
  ], [deps]);
  const grid = useGridFilter(rows, columns);

  return (
    <Page
      title="تحصيل من العملاء"
      subtitle="سند قبض مرتبط بالعميل — يخصم من رصيد العميل ويظهر في كشف حسابه"
      right={
        <button onClick={() => setCreating(true)}
          style={{ ...btnPrimary, background: "#15803d", opacity: (!deps || creating) ? 0.5 : 1, cursor: (!deps || creating) ? "not-allowed" : "pointer" }}
          disabled={!deps || creating}>+ سند تحصيل</button>
      }
    >
      {creating && deps && (
        <Card style={{ marginBottom: 12, border: "2px solid #15803d" }}>
          <div style={{ padding: 16 }}>
            <CollectForm deps={deps} allTx={allTx} onCancel={() => setCreating(false)} onDone={() => { setCreating(false); void refresh(); }} />
          </div>
        </Card>
      )}
      {rows.length > 0 && <GridToolbar grid={grid} placeholder="🔍 بحث في سندات التحصيل…" extra={<ExportButtons columns={gridToExportCols(columns)} rows={grid.view} filenameBase="سندات-التحصيل" title="سندات التحصيل من العملاء" />} />}
      <Card>
        {rows.length === 0 && !creating ? <Empty text="لا توجد سندات تحصيل" /> : grid.view.length === 0 ? <Empty text="لا نتائج مطابقة للبحث" /> : (
          <Table>
            <thead>
              <tr>
                <SortableTh grid={grid} colKey="txNo">الرقم</SortableTh>
                <SortableTh grid={grid} colKey="txDate">التاريخ</SortableTh>
                <SortableTh grid={grid} colKey="party">العميل</SortableTh>
                <SortableTh grid={grid} colKey="invoice">الفاتورة المرتبطة</SortableTh>
                <SortableTh grid={grid} colKey="description">البيان</SortableTh>
                <SortableTh grid={grid} colKey="amount" style={{ textAlign: "left" }}>المبلغ</SortableTh>
                <Th>طباعة</Th>
              </tr>
              <GridFilterRow grid={grid} columns={columns} />
            </thead>
            <tbody>
              {grid.view.map((f) => {
                const inv = invByApplied(f);
                return (
                  <tr key={f.id}>
                    <Td mono>{f.txNo}</Td><Td>{f.txDate}</Td>
                    <Td>{f.partyName ?? "—"}</Td>
                    <Td mono>{inv ? inv.invoiceNo : "—"}</Td>
                    <Td>{f.description ?? "—"}</Td>
                    <Td num style={{ fontWeight: 600, color: "#15803d" }}>{fmt(f.amount)}</Td>
                    <Td>
                      <button
                        type="button"
                        style={btnSecondary}
                        onClick={() => printVoucher({
                          kind: "receipt",
                          title: "سند تحصيل",
                          docNo: f.txNo,
                          date: f.txDate,
                          partyName: f.partyName ?? null,
                          amount: f.amount,
                          description: f.description ?? null,
                          walletKind: f.bankId != null ? "bank" : "cash",
                          walletName: walletName(deps, f),
                          linkedDocNo: inv ? inv.invoiceNo : null,
                        })}
                      >🖨️ طباعة</button>
                    </Td>
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

function CollectForm({ deps, allTx, onCancel, onDone }: {
  deps: { customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; invoices: SalesInvoice[] };
  allTx: FinancialTx[];
  onCancel: () => void; onDone: () => void;
}) {
  const { branches, costCenters } = useDimensions();
  const [date, setDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const [walletKind, setWalletKind] = useState<"cash" | "bank">("cash");
  const [cashBoxId, setCashBoxId] = useState<number | null>(deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(deps.banks[0]?.id ?? null);
  const [amount, setAmount] = useState<number>(0);
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The selected customer's CREDIT sales invoices that still carry an
  // outstanding balance (grandTotal − Σ posted receipts tagged to that invoice).
  const paidByInvoice = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of allTx) {
      if (t.txType === "receipt" && t.appliedDocType === "sales_invoice" && t.appliedDocId != null) {
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
      if (customerId == null) throw new Error("اختر العميل");
      if (amount <= 0) throw new Error("أدخل مبلغاً موجباً");
      await createFinancialTx({
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
      });
      emitData("vouchers", "journal", "customers", "cashboxes", "banks");
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0, color: "#15803d" }}>سند تحصيل جديد</h3>
      <Field label="العميل">
        <SearchCombobox
          value={customerId ?? ""}
          onChange={(v) => { setCustomerId(Number(v) || null); setInvoiceId(null); }}
          style={input}
          options={[
            { value: "", label: "— اختر —" },
            ...deps.customers.map((c) => ({ value: c.id, label: `${c.nameAr} (رصيد: ${fmt(c.balance ?? 0)})` })),
          ]}
        />
      </Field>

      {customerId != null && (
        <Field label="ربط بفاتورة (اختياري)">
          <SearchCombobox
            value={invoiceId ?? ""}
            onChange={(v) => pickInvoice(Number(v) || null)}
            style={input}
            options={[
              { value: "", label: "— بدون ربط —" },
              ...openInvoices.map((x) => ({ value: x.inv.id, label: `${x.inv.invoiceNo} — متبقّي ${fmt(x.outstanding)}` })),
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
        <button onClick={save} disabled={busy} type="button" style={{ ...btnPrimary, background: "#15803d" }}>{busy ? "..." : "حفظ وترحيل"}</button>
      </Actions>
    </div>
  );
}
