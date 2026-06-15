import { useEffect, useState } from "react";
import {
  listSupplierSettlements, createSupplierSettlement, updateSupplierSettlement,
  postSupplierSettlement, unpostSupplierSettlement, deleteSupplierSettlement,
  listSuppliers, listCashBoxes, listBanks,
  type SupplierSettlement, type SupplierSettlementInput,
  type Supplier, type CashBox, type Bank,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
} from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";

type Deps = { suppliers: Supplier[]; cashBoxes: CashBox[]; banks: Bank[] };

type EditState =
  | { mode: "new" }
  | { mode: "edit"; row: SupplierSettlement }
  | null;

export default function SupplierSettlementAdmin() {
  const [rows, setRows] = useState<SupplierSettlement[]>([]);
  const [deps, setDeps] = useState<Deps | null>(null);
  const [edit, setEdit] = useState<EditState>(null);

  async function refresh() { setRows(await listSupplierSettlements()); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [suppliers, cashBoxes, banks] = await Promise.all([listSuppliers(), listCashBoxes(), listBanks()]);
      setDeps({ suppliers, cashBoxes, banks });
    })();
  }, []);

  async function post(r: SupplierSettlement) {
    if (!confirm(`ترحيل سند التسوية ${r.docNo}؟`)) return;
    try { await postSupplierSettlement(r.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الترحيل"); }
  }
  async function unpost(r: SupplierSettlement) {
    if (!confirm(`إلغاء ترحيل السند ${r.docNo}؟`)) return;
    try { await unpostSupplierSettlement(r.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل إلغاء الترحيل"); }
  }
  async function remove(r: SupplierSettlement) {
    if (!confirm(`حذف السند ${r.docNo}؟`)) return;
    try { await deleteSupplierSettlement(r.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  return (
    <Page
      title="تسوية الموردين"
      subtitle="سندات صرف للموردين على ذممهم — يُرحَّل القيد عند الترحيل (مدين الذمم / دائن النقدية)"
      right={
        <button onClick={() => setEdit({ mode: "new" })} disabled={!deps || !!edit}
          style={{ ...btnPrimary, opacity: (!deps || edit) ? 0.5 : 1, cursor: (!deps || edit) ? "not-allowed" : "pointer" }}>
          + سند تسوية
        </button>
      }
    >
      {edit && deps && (
        <Card style={{ marginBottom: 12, border: "2px solid #2563eb" }}>
          <div style={{ padding: 16 }}>
            <SettlementForm
              deps={deps}
              existing={edit.mode === "edit" ? edit.row : null}
              onCancel={() => setEdit(null)}
              onDone={() => { setEdit(null); void refresh(); }}
            />
          </div>
        </Card>
      )}

      <Card>
        {rows.length === 0 ? <Empty text="لا توجد سندات تسوية" /> : (
          <Table>
            <thead><tr>
              <Th>الرقم</Th><Th>التاريخ</Th><Th>المورد</Th><Th>طريقة الدفع</Th>
              <Th style={{ textAlign: "left" }}>المبلغ</Th>
              <Th style={{ width: 90 }}>الحالة</Th>
              <Th style={{ width: 200 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const posted = r.status === "posted";
                return (
                  <tr key={r.id} style={{ opacity: edit ? 0.5 : 1 }}>
                    <Td mono>{r.docNo}</Td>
                    <Td>{r.settlementDate}</Td>
                    <Td>{r.supplierName ?? "—"}</Td>
                    <Td>{r.paymentMethod === "cash" ? "خزينة" : "بنك"}</Td>
                    <Td num style={{ fontWeight: 600 }}>
                      {fmt(r.amount)} {r.currencyCode}
                      {r.currencyCode !== "SAR" && <span style={{ color: "#94a3b8", marginInlineStart: 6, fontSize: 12 }}>({fmt(r.amount * r.exchangeRate)} ر.س)</span>}
                    </Td>
                    <Td>
                      <span style={{ background: posted ? "#dcfce7" : "#fef9c3", color: posted ? "#15803d" : "#854d0e", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                        {posted ? "مرحّل" : "مسودة"}
                      </span>
                    </Td>
                    <Td>
                      {!posted && <>
                        <button onClick={() => setEdit({ mode: "edit", row: r })} disabled={!!edit} style={btnLink}>تعديل</button>
                        {" · "}
                        <button onClick={() => post(r)} disabled={!!edit} style={{ ...btnLink, color: "#15803d" }}>ترحيل</button>
                        {" · "}
                        <button onClick={() => remove(r)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                      </>}
                      {posted && (
                        <button onClick={() => unpost(r)} disabled={!!edit} style={{ ...btnLink, color: "#b45309" }}>إلغاء الترحيل</button>
                      )}
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

function SettlementForm({ deps, existing, onCancel, onDone }: {
  deps: Deps;
  existing: SupplierSettlement | null;
  onCancel: () => void; onDone: () => void;
}) {
  const { branches, costCenters } = useDimensions();
  const [date, setDate] = useState(existing?.settlementDate ?? todayStr());
  const [supplierId, setSupplierId] = useState<number | null>(existing?.supplierId ?? null);
  const [method, setMethod] = useState<"cash" | "bank">(existing?.paymentMethod ?? "cash");
  const [cashBoxId, setCashBoxId] = useState<number | null>(existing?.cashBoxId ?? deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(existing?.bankId ?? deps.banks[0]?.id ?? null);
  const [amount, setAmount] = useState<number>(existing?.amount ?? 0);
  const [branchId, setBranchId] = useState<number | "">(existing?.branchId ?? "");
  const [costCenterId, setCostCenterId] = useState<number | "">(existing?.costCenterId ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (!supplierId) throw new Error("اختر المورد");
      if (amount <= 0) throw new Error("أدخل مبلغاً موجباً");
      const payload: SupplierSettlementInput = {
        settlementDate: date, supplierId, paymentMethod: method,
        cashBoxId: method === "cash" ? cashBoxId : null,
        bankId: method === "bank" ? bankId : null,
        amount, notes: notes || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
      };
      if (existing) await updateSupplierSettlement(existing.id, payload);
      else await createSupplierSettlement(payload);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{existing ? `تعديل سند التسوية ${existing.docNo}` : "سند تسوية مورد جديد"}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="المبلغ"><input type="number" step="0.01" value={amount || ""} onChange={(e) => setAmount(Number(e.target.value) || 0)} style={input} autoFocus /></Field>
        <Field label="طريقة الدفع">
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setMethod("cash")} type="button" style={method === "cash" ? btnPrimary : btnSecondary}>خزينة</button>
            <button onClick={() => setMethod("bank")} type="button" style={method === "bank" ? btnPrimary : btnSecondary}>بنك</button>
          </div>
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="المورد">
          <SearchCombobox
            value={supplierId ?? ""}
            onChange={(v) => setSupplierId(Number(v) || null)}
            style={input}
            options={[
              { value: "", label: "— اختر —" },
              ...deps.suppliers.map((s) => ({ value: s.id, label: `${s.nameAr} (رصيد: ${fmt(s.balance)})` })),
            ]}
          />
        </Field>
        {method === "cash" ? (
          <Field label="الخزينة">
            <SearchCombobox value={cashBoxId ?? ""} onChange={(v) => setCashBoxId(Number(v) || null)} style={input}
              options={deps.cashBoxes.map((c) => ({ value: c.id, label: `${c.name} (${fmt(c.balance)} ${c.currencyCode})` }))} />
          </Field>
        ) : (
          <Field label="البنك">
            <SearchCombobox value={bankId ?? ""} onChange={(v) => setBankId(Number(v) || null)} style={input}
              options={deps.banks.map((b) => ({ value: b.id, label: `${b.name} (${fmt(b.balance)} ${b.currencyCode})` }))} />
          </Field>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="الفرع">
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label="مركز التكلفة">
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} options={costCenterPickerOptions(costCenters)} style={input} />
        </Field>
      </div>
      <Field label="البيان"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} /></Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : "حفظ كمسودة"}</button>
      </Actions>
    </div>
  );
}
