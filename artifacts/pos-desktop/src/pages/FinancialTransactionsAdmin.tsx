import { useEffect, useState } from "react";
import {
  listFinancialTx, createFinancialTx, listSuppliers, listCashBoxes, listBanks, listAccounts,
  type FinancialTx, type TxType, type PartyType, type Supplier, type CashBox, type Bank, type Account,
} from "../lib/accounting";
import { listCustomers, type LocalCustomer } from "../lib/customers";
import { emitData, useDataRefresh } from "../lib/dataBus";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, fmt, todayStr, SearchCombobox,
  useRowSelect, SelectTh, SelectCell, ActionBar, ActionBtn,
} from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { printVoucher } from "../lib/invoicePrint";

function txWalletName(
  deps: { cashBoxes: CashBox[]; banks: Bank[] } | null,
  f: FinancialTx,
): string | null {
  if (!deps) return null;
  if (f.bankId != null) return deps.banks.find((b) => b.id === f.bankId)?.name ?? null;
  if (f.cashBoxId != null) return deps.cashBoxes.find((c) => c.id === f.cashBoxId)?.name ?? null;
  return null;
}

export default function FinancialTransactionsAdmin() {
  const [rows, setRows] = useState<FinancialTx[]>([]);
  const [creating, setCreating] = useState<null | { type: TxType }>(null);
  const [deps, setDeps] = useState<{ suppliers: Supplier[]; customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; accounts: Account[] } | null>(null);

  const sel = useRowSelect(rows);

  async function refresh() { setRows(await listFinancialTx()); }
  async function loadDeps() {
    const [suppliers, customers, cashBoxes, banks, accounts] = await Promise.all([
      listSuppliers(), listCustomers(), listCashBoxes(), listBanks(), listAccounts(),
    ]);
    setDeps({ suppliers, customers, cashBoxes, banks, accounts });
  }
  useEffect(() => { void refresh(); void loadDeps(); }, []);

  // Live-refresh: vouchers/JEs posted on another tab (and the party/wallet
  // balances they move) stay current here without a manual reload.
  useDataRefresh(["vouchers", "journal", "customers", "suppliers", "cashboxes", "banks", "accounts"], () => {
    void refresh();
    void loadDeps();
  });

  return (
    <Page
      title="المعاملات المالية"
      subtitle="سندات القبض والصرف — يتم ترحيل القيد المحاسبي تلقائياً"
      right={<div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setCreating({ type: "receipt" })}
          style={{ ...btnPrimary, background: "#15803d", opacity: creating ? 0.5 : 1, cursor: creating ? "not-allowed" : "pointer" }}
          disabled={!deps || !!creating}>+ سند قبض</button>
        <button onClick={() => setCreating({ type: "payment" })}
          style={{ ...btnPrimary, background: "#b91c1c", opacity: creating ? 0.5 : 1, cursor: creating ? "not-allowed" : "pointer" }}
          disabled={!deps || !!creating}>+ سند صرف</button>
      </div>}
    >
      {creating && deps && (
        <Card style={{ marginBottom: 12, border: `2px solid ${creating.type === "receipt" ? "#15803d" : "#b91c1c"}` }}>
          <div style={{ padding: 16 }}>
            <CreateForm
              type={creating.type}
              deps={deps}
              onCancel={() => setCreating(null)}
              onDone={() => { setCreating(null); void refresh(); }}
            />
          </div>
        </Card>
      )}
      {rows.length > 0 && !creating && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.txNo : null}>
          <ActionBtn label="طباعة" icon="🖨️" tone="primary" disabled={!sel.selected}
            onClick={() => {
              const f = sel.selected; if (!f) return;
              printVoucher({
                kind: f.txType === "receipt" ? "receipt" : "payment",
                title: f.txType === "receipt" ? "سند قبض" : "سند صرف",
                docNo: f.txNo,
                date: f.txDate,
                partyName: f.partyName ?? null,
                amount: f.amount,
                description: f.description ?? null,
                walletKind: f.bankId != null ? "bank" : "cash",
                walletName: txWalletName(deps, f),
              });
            }} />
        </ActionBar>
      )}
      <Card>
        {rows.length === 0 ? <Empty text="لا توجد معاملات" /> : (
          <Table>
            <thead><tr>
              <SelectTh />
              <Th>الرقم</Th><Th>التاريخ</Th><Th>النوع</Th><Th>الطرف</Th><Th>البيان</Th>
              <Th style={{ textAlign: "left" }}>المبلغ</Th>
            </tr></thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <SelectCell id={f.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                  <Td mono>{f.txNo}</Td><Td>{f.txDate}</Td>
                  <Td>
                    <span style={{ background: f.txType === "receipt" ? "#dcfce7" : "#fee2e2", color: f.txType === "receipt" ? "#15803d" : "#b91c1c", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                      {f.txType === "receipt" ? "قبض" : "صرف"}
                    </span>
                  </Td>
                  <Td>{f.partyName ?? "—"}</Td>
                  <Td>{f.description ?? "—"}</Td>
                  <Td num style={{ fontWeight: 600, color: f.txType === "receipt" ? "#15803d" : "#b91c1c" }}>{fmt(f.amount)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

function CreateForm({ type, deps, onCancel, onDone }: {
  type: TxType;
  deps: { suppliers: Supplier[]; customers: LocalCustomer[]; cashBoxes: CashBox[]; banks: Bank[]; accounts: Account[] };
  onCancel: () => void; onDone: () => void;
}) {
  const { branches, costCenters } = useDimensions();
  const [date, setDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [partyType, setPartyType] = useState<PartyType>(type === "payment" ? "supplier" : "none");
  const [partyId, setPartyId] = useState<number | null>(null);
  const [walletKind, setWalletKind] = useState<"cash" | "bank">("cash");
  const [cashBoxId, setCashBoxId] = useState<number | null>(deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(deps.banks[0]?.id ?? null);
  const [counterAccountId, setCounterAccountId] = useState<number | null>(null);
  const [amount, setAmount] = useState<number>(0);
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const leafAccounts = deps.accounts.filter((a) => a.isLeaf);

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (amount <= 0) throw new Error("أدخل مبلغاً موجباً");
      await createFinancialTx({
        txDate: date, txType: type,
        partyType: partyType === "none" ? null : partyType,
        partyId: partyType === "none" ? null : partyId,
        cashBoxId: walletKind === "cash" ? cashBoxId : null,
        bankId:    walletKind === "bank" ? bankId : null,
        counterAccountId: partyType === "none" ? counterAccountId : null,
        amount, description: desc || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
      });
      emitData("vouchers", "journal", "cashboxes", "banks", "customers", "suppliers");
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0, color: type === "receipt" ? "#15803d" : "#b91c1c" }}>
        {type === "receipt" ? "سند قبض جديد" : "سند صرف جديد"}
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="المبلغ"><input type="number" step="0.01" value={amount || ""} onChange={(e) => setAmount(Number(e.target.value) || 0)} style={input} autoFocus /></Field>
        <Field label="المحفظة">
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setWalletKind("cash")} type="button" style={walletKind === "cash" ? btnPrimary : btnSecondary}>خزينة</button>
            <button onClick={() => setWalletKind("bank")} type="button" style={walletKind === "bank" ? btnPrimary : btnSecondary}>بنك</button>
          </div>
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {walletKind === "cash" ? (
          <Field label="الخزينة">
            <SearchCombobox
              value={cashBoxId ?? ""}
              onChange={(v) => setCashBoxId(Number(v) || null)}
              style={input}
              options={deps.cashBoxes.map((c) => ({ value: c.id, label: `${c.name} (${fmt(c.balance)})` }))}
            />
          </Field>
        ) : (
          <Field label="البنك">
            <SearchCombobox
              value={bankId ?? ""}
              onChange={(v) => setBankId(Number(v) || null)}
              style={input}
              options={deps.banks.map((b) => ({ value: b.id, label: `${b.name} (${fmt(b.balance)})` }))}
            />
          </Field>
        )}

        <Field label="الطرف الآخر">
          <SearchCombobox
            value={partyType}
            onChange={(v) => { setPartyType(v as PartyType); setPartyId(null); }}
            style={input}
            options={[
              { value: "none", label: "حساب من شجرة الحسابات (إيراد / مصروف / ...)" },
              { value: "supplier", label: "مورد" },
              ...(type === "receipt" ? [{ value: "customer", label: "عميل" }] : []),
            ]}
          />
        </Field>
      </div>

      {partyType === "supplier" && (
        <Field label="المورد">
          <SearchCombobox
            value={partyId ?? ""}
            onChange={(v) => setPartyId(Number(v) || null)}
            style={input}
            options={[
              { value: "", label: "— اختر —" },
              ...deps.suppliers.map((s) => ({ value: s.id, label: `${s.nameAr} (رصيد: ${fmt(s.balance)})` })),
            ]}
          />
        </Field>
      )}
      {partyType === "customer" && (
        <Field label="العميل">
          <SearchCombobox
            value={partyId ?? ""}
            onChange={(v) => setPartyId(Number(v) || null)}
            style={input}
            options={[
              { value: "", label: "— اختر —" },
              ...deps.customers.map((c) => ({ value: c.id, label: `${c.nameAr} (رصيد: ${fmt(c.balance ?? 0)})` })),
            ]}
          />
        </Field>
      )}
      {partyType === "none" && (
        <Field label={type === "receipt" ? "حساب الإيراد / الدائن" : "حساب المصروف / المدين"}>
          <SearchCombobox
            value={counterAccountId ?? ""}
            onChange={(v) => setCounterAccountId(Number(v) || null)}
            style={input}
            options={[
              { value: "", label: "— اختر —" },
              ...leafAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` })),
            ]}
          />
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
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : "حفظ وترحيل"}</button>
      </Actions>
    </div>
  );
}
