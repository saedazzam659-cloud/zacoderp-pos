import { useEffect, useState } from "react";
import {
  listFinancialTx, createFinancialTx, listSuppliers, listCashBoxes, listBanks, listAccounts,
  type FinancialTx, type TxType, type PartyType, type Supplier, type CashBox, type Bank, type Account,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Modal, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, fmt, todayStr, SearchCombobox,
} from "./_adminUi";

export default function FinancialTransactionsAdmin() {
  const [rows, setRows] = useState<FinancialTx[]>([]);
  const [creating, setCreating] = useState<null | { type: TxType }>(null);
  const [deps, setDeps] = useState<{ suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; accounts: Account[] } | null>(null);

  async function refresh() { setRows(await listFinancialTx()); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [suppliers, cashBoxes, banks, accounts] = await Promise.all([
        listSuppliers(), listCashBoxes(), listBanks(), listAccounts(),
      ]);
      setDeps({ suppliers, cashBoxes, banks, accounts });
    })();
  }, []);

  return (
    <Page
      title="المعاملات المالية"
      subtitle="سندات القبض والصرف — يتم ترحيل القيد المحاسبي تلقائياً"
      right={<div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setCreating({ type: "receipt" })} style={{ ...btnPrimary, background: "#15803d" }} disabled={!deps}>+ سند قبض</button>
        <button onClick={() => setCreating({ type: "payment" })} style={{ ...btnPrimary, background: "#b91c1c" }} disabled={!deps}>+ سند صرف</button>
      </div>}
    >
      <Card>
        {rows.length === 0 ? <Empty text="لا توجد معاملات" /> : (
          <Table>
            <thead><tr>
              <Th>الرقم</Th><Th>التاريخ</Th><Th>النوع</Th><Th>الطرف</Th><Th>البيان</Th>
              <Th style={{ textAlign: "left" }}>المبلغ</Th>
            </tr></thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
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
      {creating && deps && (
        <CreateForm type={creating.type} deps={deps} onCancel={() => setCreating(null)} onDone={() => { setCreating(null); void refresh(); }} />
      )}
    </Page>
  );
}

function CreateForm({ type, deps, onCancel, onDone }: {
  type: TxType;
  deps: { suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[]; accounts: Account[] };
  onCancel: () => void; onDone: () => void;
}) {
  const [date, setDate] = useState(todayStr());
  // For payment: default party_type=supplier; receipt: customer (or none).
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
      });
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={type === "receipt" ? "سند قبض جديد" : "سند صرف جديد"} onCancel={onCancel}>
      <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>

      <Field label="المحفظة">
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setWalletKind("cash")} style={walletKind === "cash" ? btnPrimary : btnSecondary}>خزينة</button>
          <button onClick={() => setWalletKind("bank")} style={walletKind === "bank" ? btnPrimary : btnSecondary}>بنك</button>
        </div>
      </Field>
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

      <Field label="المبلغ"><input type="number" step="0.01" value={amount || ""} onChange={(e) => setAmount(Number(e.target.value) || 0)} style={input} autoFocus /></Field>
      <Field label="البيان"><textarea value={desc} onChange={(e) => setDesc(e.target.value)} style={{ ...input, minHeight: 50 }} /></Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "..." : "حفظ وترحيل"}</button>
      </Actions>
    </Modal>
  );
}
