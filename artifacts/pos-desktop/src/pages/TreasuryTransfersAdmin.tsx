import { useEffect, useMemo, useState } from "react";
import {
  listTreasuryTransfers, createTreasuryTransfer,
  listCashBoxes, listBanks, listCurrencies,
  type TreasuryTransfer, type TreasuryKind, type CashBox, type Bank, type Currency,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Empty, input, btnPrimary, btnSecondary,
  fmtCurrency, fmt, todayStr, SearchCombobox, Field, Row, ErrorMsg,
} from "./_adminUi";
import { useDataRefresh } from "../lib/dataBus";
import { formatUiDate, uiText, useUiLanguage } from "../lib/appSettings";

type Endpoint = { kind: TreasuryKind; id: number };
type Draft = {
  transferDate: string;
  from: Endpoint | null;
  to: Endpoint | null;
  amountFrom: string;
  amountTo: string;
  notes: string;
};

const EMPTY_DRAFT: Draft = { transferDate: todayStr(), from: null, to: null, amountFrom: "", amountTo: "", notes: "" };

function endpointKey(e: Endpoint): string { return `${e.kind}:${e.id}`; }
function parseEndpointKey(k: string): Endpoint | null {
  const [kind, id] = k.split(":");
  if (!kind || !id) return null;
  return { kind: kind as TreasuryKind, id: Number(id) };
}

export default function TreasuryTransfersAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<TreasuryTransfer[]>([]);
  const [cashBoxes, setCashBoxes] = useState<CashBox[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>({ ...EMPTY_DRAFT });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const [tt, cb, bk, cur] = await Promise.all([
      listTreasuryTransfers(200), listCashBoxes(), listBanks(), listCurrencies(false),
    ]);
    setRows(tt); setCashBoxes(cb); setBanks(bk); setCurrencies(cur);
  }
  useEffect(() => { void refresh(); }, []);

  // Refresh the list + balances when a voucher/journal/bank/cashbox is mutated
  // on another tab.
  useDataRefresh(["vouchers", "journal", "banks", "cashboxes"], () => { void refresh(); });

  const endpointOpts = useMemo(() => [
    ...cashBoxes.map(c => ({ value: endpointKey({ kind: "cash", id: c.id }), label: `💰 ${c.name}`, hint: `${c.currencyCode} · ${fmt(c.balance)}` })),
    ...banks.map(b => ({ value: endpointKey({ kind: "bank", id: b.id }), label: `🏦 ${b.name}`, hint: `${b.currencyCode} · ${fmt(b.balance)}` })),
  ], [cashBoxes, banks]);

  function lookupEndpoint(e: Endpoint | null): { name: string; currency: string; balance: number } | null {
    if (!e) return null;
    if (e.kind === "cash") {
      const c = cashBoxes.find(x => x.id === e.id);
      return c ? { name: c.name, currency: c.currencyCode, balance: c.balance } : null;
    }
    const b = banks.find(x => x.id === e.id);
    return b ? { name: b.name, currency: b.currencyCode, balance: b.balance } : null;
  }
  const fromInfo = lookupEndpoint(draft.from);
  const toInfo = lookupEndpoint(draft.to);
  const sameCurrency = !!(fromInfo && toInfo && fromInfo.currency === toInfo.currency);

  // Auto-sync amountTo when same currency or when there's a current rate
  function onFromAmountChange(v: string) {
    setDraft(prev => {
      const next: Draft = { ...prev, amountFrom: v };
      const fInfo = lookupEndpoint(prev.from);
      const tInfo = lookupEndpoint(prev.to);
      if (!fInfo || !tInfo) return next;
      const amt = Number(v);
      if (!isFinite(amt) || amt <= 0) return next;
      if (fInfo.currency === tInfo.currency) {
        next.amountTo = String(amt);
      } else {
        const fRate = currencies.find(c => c.code === fInfo.currency)?.currentRate ?? null;
        const tRate = currencies.find(c => c.code === tInfo.currency)?.currentRate ?? null;
        if (fInfo.currency === "SAR" && tRate && tRate > 0) {
          next.amountTo = (amt / tRate).toFixed(4);
        } else if (tInfo.currency === "SAR" && fRate) {
          next.amountTo = (amt * fRate).toFixed(2);
        } else if (fRate && tRate && tRate > 0) {
          next.amountTo = ((amt * fRate) / tRate).toFixed(4);
        }
      }
      return next;
    });
  }

  function openForm() { setErr(null); setDraft({ ...EMPTY_DRAFT, transferDate: todayStr() }); setShowForm(true); }
  function closeForm() { setShowForm(false); setErr(null); }

  async function submit() {
    if (!draft.from || !draft.to) { setErr(text("اختر الجهة المُحوّل منها وإليها", "Select both the source and destination.")); return; }
    if (draft.from.kind === draft.to.kind && draft.from.id === draft.to.id) { setErr(text("لا يمكن التحويل لنفس الجهة", "Source and destination must be different.")); return; }
    const aF = Number(draft.amountFrom), aT = Number(draft.amountTo);
    if (!isFinite(aF) || aF <= 0 || !isFinite(aT) || aT <= 0) { setErr(text("أدخل المبالغ بشكل صحيح", "Enter valid transfer and received amounts.")); return; }
    setBusy(true); setErr(null);
    try {
      await createTreasuryTransfer({
        transferDate: draft.transferDate,
        fromKind: draft.from.kind, fromId: draft.from.id,
        toKind: draft.to.kind, toId: draft.to.id,
        amountFrom: aF, amountTo: aT,
        notes: draft.notes.trim() || null,
      });
      closeForm(); await refresh();
    } catch (e: any) { setErr(e?.message ?? text("فشل", "Could not save transfer.")); }
    finally { setBusy(false); }
  }

  return (
    <div dir={language === "en" ? "ltr" : "rtl"}>
    <Page
      title={text("تحويل الخزن", "Treasury transfers")}
      subtitle={text("تحويل بين خزينة/بنك (نفس العملة أو عملات مختلفة). فرق الصرف يُسجَّل تلقائيًا في حساب فروقات العملة.", "Transfer between cashboxes and banks in the same or different currencies. Exchange differences are posted automatically to the FX account.")}
      right={!showForm && <button onClick={openForm} style={btnPrimary}>+ {text("تحويل جديد", "New transfer")}</button>}
    >
      {showForm && (
        <Card style={{ padding: 16, marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 12px" }}>{text("تحويل خزينة جديد", "New treasury transfer")}</h4>
          <Row>
            <Field label={text("من (الجهة المُحوَّل منها)", "From (source)")}>
              <SearchCombobox
                value={draft.from ? endpointKey(draft.from) : ""}
                onChange={(v) => setDraft({ ...draft, from: parseEndpointKey(String(v)) })}
                options={endpointOpts}
              />
              {fromInfo && <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{text("الرصيد المتاح:", "Available balance:")} <b>{fmtCurrency(fromInfo.balance, fromInfo.currency)}</b></div>}
            </Field>
            <Field label={text("إلى (الجهة المُحوَّل إليها)", "To (destination)")}>
              <SearchCombobox
                value={draft.to ? endpointKey(draft.to) : ""}
                onChange={(v) => setDraft({ ...draft, to: parseEndpointKey(String(v)) })}
                options={endpointOpts}
              />
              {toInfo && <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{text("الرصيد الحالي:", "Current balance:")} <b>{fmtCurrency(toInfo.balance, toInfo.currency)}</b></div>}
            </Field>
          </Row>
          <Row>
            <Field label={`${text("المبلغ المُحوَّل", "Transfer amount")} ${fromInfo ? `(${fromInfo.currency})` : ""}`}>
              <input type="number" step="0.0001" min="0" value={draft.amountFrom} onChange={(e) => onFromAmountChange(e.target.value)} style={input} placeholder="0.00" />
            </Field>
            <Field label={`${text("المبلغ المُستلَم", "Received amount")} ${toInfo ? `(${toInfo.currency})` : ""}`}>
              <input
                type="number" step="0.0001" min="0"
                value={draft.amountTo}
                onChange={(e) => setDraft({ ...draft, amountTo: e.target.value })}
                disabled={sameCurrency}
                style={{ ...input, background: sameCurrency ? "#f1f5f9" : "#fff" }}
                placeholder="0.00"
              />
              {sameCurrency && <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{text("نفس العملة — يُحسب تلقائيًا", "Same currency — calculated automatically")}</div>}
            </Field>
          </Row>
          <Row>
            <Field label={text("التاريخ", "Date")}>
              <input type="date" value={draft.transferDate} onChange={(e) => setDraft({ ...draft, transferDate: e.target.value })} style={input} />
            </Field>
            <Field label={text("ملاحظات", "Notes")}>
              <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} style={input} placeholder={text("اختياري", "Optional")} />
            </Field>
          </Row>
          <ErrorMsg text={err} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
            <button onClick={submit} disabled={busy} style={btnPrimary}>{busy ? "..." : text("حفظ التحويل", "Save transfer")}</button>
            <button onClick={closeForm} disabled={busy} style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
          </div>
        </Card>
      )}

      <Card>
        {rows.length === 0 ? <Empty text={text("لا توجد تحويلات", "No transfers yet")} /> : (
          <Table>
            <thead><tr>
               <Th style={{ width: 110 }}>{text("رقم", "Number")}</Th>
               <Th style={{ width: 110 }}>{text("التاريخ", "Date")}</Th>
               <Th>{text("من", "From")}</Th>
               <Th>{text("إلى", "To")}</Th>
               <Th style={{ textAlign: language === "en" ? "right" : "left", width: 160 }}>{text("المُحوَّل", "Transferred")}</Th>
               <Th style={{ textAlign: language === "en" ? "right" : "left", width: 160 }}>{text("المُستلَم", "Received")}</Th>
               <Th style={{ textAlign: language === "en" ? "right" : "left", width: 140 }}>{text("فرق الصرف", "FX difference")}</Th>
               <Th>{text("ملاحظات", "Notes")}</Th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td mono>{r.transferNo}</Td>
                  <Td mono>{formatUiDate(r.transferDate, language)}</Td>
                  <Td>{r.fromKind === "cash" ? "💰" : "🏦"} {r.fromName ?? `#${r.fromId}`}</Td>
                  <Td>{r.toKind === "cash" ? "💰" : "🏦"} {r.toName ?? `#${r.toId}`}</Td>
                  <Td num>{fmtCurrency(r.amountFrom, r.fromCurrency)}</Td>
                  <Td num>{fmtCurrency(r.amountTo, r.toCurrency)}</Td>
                  <Td num style={{ color: r.fxDiff > 0 ? "#059669" : r.fxDiff < 0 ? "#dc2626" : "#94a3b8" }}>
                    {Math.abs(r.fxDiff) < 0.005 ? "—" : `${r.fxDiff > 0 ? "+" : ""}${fmt(r.fxDiff)}`}
                  </Td>
                  <Td style={{ color: "#64748b", fontSize: 13 }}>{r.notes ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
    </div>
  );
}
