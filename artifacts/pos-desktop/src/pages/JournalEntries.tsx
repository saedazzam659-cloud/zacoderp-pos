import React, { useEffect, useState } from "react";
import {
  listJournalEntries, getJournalEntry, createJournalEntry, listAccounts,
  type JournalEntry, type JournalEntryLine, type Account,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
} from "./_adminUi";

export default function JournalEntries() {
  const [rows, setRows] = useState<JournalEntry[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<JournalEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);

  async function refresh() {
    const [list, accs] = await Promise.all([listJournalEntries(500), listAccounts()]);
    setRows(list); setAccounts(accs);
  }
  useEffect(() => { void refresh(); }, []);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getJournalEntry(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  return (
    <Page
      title="القيود اليومية"
      subtitle={`${rows.length} قيد — تشمل القيود التلقائية (مشتريات/مرتجع/سندات) والقيود اليدوية`}
      right={
        <button onClick={() => setCreating(true)} disabled={creating}
          style={{ ...btnPrimary, opacity: creating ? 0.5 : 1, cursor: creating ? "not-allowed" : "pointer" }}>
          + قيد يدوي
        </button>
      }
    >
      {creating && (
        <Card style={{ marginBottom: 12, border: "2px solid #2563eb" }}>
          <div style={{ padding: 16 }}>
            <CreateForm accounts={accounts} onCancel={() => setCreating(false)} onDone={() => { setCreating(false); void refresh(); }} />
          </div>
        </Card>
      )}
      <Card>
        {rows.length === 0 && !creating ? <Empty text="لا توجد قيود بعد" /> : (
          <Table>
            <thead><tr>
              <Th>رقم القيد</Th><Th>التاريخ</Th><Th>البيان</Th><Th>المصدر</Th>
              <Th style={{ textAlign: "left" }}>المدين</Th><Th style={{ textAlign: "left" }}>الدائن</Th>
              <Th style={{ width: 100 }}></Th>
            </tr></thead>
            <tbody>
              {rows.map((e) => (
                <React.Fragment key={e.id}>
                  <tr>
                    <Td mono style={{ fontWeight: 600 }}>{e.entryNo}</Td>
                    <Td>{e.entryDate}</Td>
                    <Td>{e.description ?? "—"}</Td>
                    <Td><SourceTag source={e.sourceType} /></Td>
                    <Td num>{fmt(e.totalDebit)}</Td>
                    <Td num>{fmt(e.totalCredit)}</Td>
                    <Td>
                      <button onClick={() => void toggleView(e.id)} disabled={creating} aria-expanded={expandedId === e.id}
                        style={{ ...btnLink, opacity: creating ? 0.5 : 1, cursor: creating ? "not-allowed" : "pointer" }}>
                        {expandedId === e.id ? "▲ إخفاء" : "▼ عرض"}
                      </button>
                    </Td>
                  </tr>
                  {expandedId === e.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={7 as any}>
                        {!expandedDetail ? <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>... جاري التحميل</div> : (
                          <EntryDetail entry={expandedDetail} />
                        )}
                      </Td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

function SourceTag({ source }: { source: string | null }) {
  const map: Record<string, { l: string; c: string }> = {
    manual:           { l: "يدوي",       c: "#475569" },
    purchase:         { l: "شراء",       c: "#1e40af" },
    purchase_return:  { l: "مرتجع شراء", c: "#9a3412" },
    receipt:          { l: "سند قبض",    c: "#15803d" },
    payment:          { l: "سند صرف",    c: "#b91c1c" },
  };
  const m = source ? (map[source] ?? { l: source, c: "#64748b" }) : { l: "—", c: "#94a3b8" };
  return <span style={{ background: m.c + "20", color: m.c, padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600 }}>{m.l}</span>;
}

function EntryDetail({ entry }: { entry: JournalEntry }) {
  return (
    <div style={{ padding: 12 }}>
      <Table>
        <thead><tr><Th>الحساب</Th><Th>البيان</Th><Th style={{ textAlign: "left" }}>مدين</Th><Th style={{ textAlign: "left" }}>دائن</Th></tr></thead>
        <tbody>
          {entry.lines.map((l, i) => (
            <tr key={l.id ?? i}>
              <Td mono>{l.accountCode} — {l.accountName}</Td>
              <Td>{l.description ?? ""}</Td>
              <Td num>{l.debit ? fmt(l.debit) : ""}</Td>
              <Td num>{l.credit ? fmt(l.credit) : ""}</Td>
            </tr>
          ))}
          <tr style={{ background: "#fff", fontWeight: 700 }}>
            <Td colSpan={2 as any}>الإجمالي</Td>
            <Td num>{fmt(entry.totalDebit)}</Td>
            <Td num>{fmt(entry.totalCredit)}</Td>
          </tr>
        </tbody>
      </Table>
    </div>
  );
}

function CreateForm({ accounts, onCancel, onDone }: { accounts: Account[]; onCancel: () => void; onDone: () => void }) {
  const [date, setDate] = useState(todayStr());
  const [desc, setDesc] = useState("");
  const [lines, setLines] = useState<JournalEntryLine[]>([
    { accountId: 0, debit: 0, credit: 0, description: null },
    { accountId: 0, debit: 0, credit: 0, description: null },
  ]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const leafAccounts = accounts.filter((a) => a.isLeaf);
  const totalDr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(totalDr - totalCr) < 0.001 && totalDr > 0;

  function setLine(i: number, patch: Partial<JournalEntryLine>) {
    setLines((ls) => ls.map((l, k) => k === i ? { ...l, ...patch } : l));
  }
  function addLine() { setLines((ls) => [...ls, { accountId: 0, debit: 0, credit: 0, description: null }]); }
  function removeLine(i: number) { setLines((ls) => ls.filter((_, k) => k !== i)); }

  async function save() {
    setBusy(true); setErr(null);
    try {
      const cleaned = lines.filter((l) => l.accountId && ((l.debit || 0) > 0 || (l.credit || 0) > 0));
      await createJournalEntry({ entryDate: date, description: desc || null, lines: cleaned });
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>إضافة قيد يومية يدوي</h3>
      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 10 }}>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="البيان"><input value={desc} onChange={(e) => setDesc(e.target.value)} style={input} /></Field>
      </div>
      <Table>
        <thead><tr>
          <Th>الحساب</Th><Th>البيان</Th>
          <Th style={{ width: 120 }}>مدين</Th><Th style={{ width: 120 }}>دائن</Th><Th style={{ width: 50 }}></Th>
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>
                <SearchCombobox
                  value={l.accountId}
                  onChange={(v) => setLine(i, { accountId: Number(v) })}
                  style={input}
                  options={[
                    { value: 0, label: "— اختر —" },
                    ...leafAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` })),
                  ]}
                />
              </Td>
              <Td><input value={l.description ?? ""} onChange={(e) => setLine(i, { description: e.target.value || null })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.debit || ""} onChange={(e) => setLine(i, { debit: Number(e.target.value) || 0, credit: 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.credit || ""} onChange={(e) => setLine(i, { credit: Number(e.target.value) || 0, debit: 0 })} style={input} /></Td>
              <Td><button onClick={() => removeLine(i)} type="button" style={{ ...btnLink, color: "#dc2626" }}>×</button></Td>
            </tr>
          ))}
          <tr style={{ background: "#f8fafc", fontWeight: 700 }}>
            <Td colSpan={2 as any}>الإجمالي</Td>
            <Td num>{fmt(totalDr)}</Td>
            <Td num>{fmt(totalCr)}</Td>
            <Td></Td>
          </tr>
        </tbody>
      </Table>
      <div style={{ marginTop: 8 }}>
        <button onClick={addLine} type="button" style={btnSecondary}>+ سطر</button>
        {!balanced && totalDr > 0 && <span style={{ marginInlineStart: 12, color: "#dc2626", fontSize: 13 }}>القيد غير متوازن — الفرق {fmt(Math.abs(totalDr - totalCr))}</span>}
      </div>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy || !balanced} type="button" style={btnPrimary}>{busy ? "..." : "حفظ القيد"}</button>
      </Actions>
    </div>
  );
}
