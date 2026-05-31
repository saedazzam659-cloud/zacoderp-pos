import React, { useEffect, useMemo, useState } from "react";
import {
  listJournalEntries, getJournalEntry, getJournalEntryDetail,
  createJournalEntry, updateJournalEntry, postJournalEntry, unpostJournalEntry,
  deleteJournalEntry, peekJournalEntryNumber, listAccounts,
  type JournalEntry, type ManualJeLine, type ManualJeDetail,
  type JeEntryType, type JeStatus, type Account,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnDanger, btnLink, fmt, todayStr, SearchCombobox,
} from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { getTaxRate } from "../lib/taxSettings";
import { getDefaultTax } from "../lib/taxes";
import { getCompanyProfile, safeLogoSrc, type CompanyProfile } from "../lib/appSettings";

const ENTRY_TYPES: { value: JeEntryType; label: string }[] = [
  { value: "general", label: "قيد عام" },
  { value: "opening", label: "قيد افتتاحي" },
  { value: "closing", label: "قيد إقفال" },
  { value: "adjustment", label: "قيد تسوية" },
  { value: "depreciation", label: "قيد إهلاك" },
];
const ENTRY_TYPE_LABEL: Record<string, string> =
  Object.fromEntries(ENTRY_TYPES.map((t) => [t.value, t.label]));

const VAT_IN_CODE = "1400";   // ضريبة القيمة المضافة - مدخلات (أصل)
const VAT_OUT_CODE = "2200";  // ضريبة القيمة المضافة - مخرجات (التزام)
const NET_MARKER = " (صافٍ من الضريبة)";
const VAT_DESC_PREFIX = "ضريبة القيمة المضافة";
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

type FormState =
  | { kind: "create"; initial: null }
  | { kind: "edit"; id: number; initial: ManualJeDetail }
  | { kind: "duplicate"; initial: ManualJeDetail };

function isManual(e: { sourceType: string | null }): boolean {
  return e.sourceType === null || e.sourceType === "manual";
}

export default function JournalEntries() {
  const [rows, setRows] = useState<JournalEntry[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<JournalEntry | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | JeStatus>("all");
  const [search, setSearch] = useState("");
  const [printData, setPrintData] = useState<ManualJeDetail | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function refresh() {
    const [list, accs] = await Promise.all([listJournalEntries(500), listAccounts()]);
    setRows(list); setAccounts(accs);
  }
  useEffect(() => { void refresh(); }, []);

  // Print: build a standalone HTML document and print it inside an isolated
  // hidden iframe. The previous in-DOM overlay (#je-print-area, position:absolute)
  // was clipped by PosShell's flex/overflow containers, so the printout came out
  // cropped/blank. An iframe is its own document — no clipping ancestors — and
  // prints reliably inside the Tauri WebView2.
  useEffect(() => {
    if (!printData) return;
    printJournalEntry(printData, getCompanyProfile());
    setPrintData(null);
  }, [printData]);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getJournalEntry(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  async function openEdit(id: number) {
    setBusyId(id);
    try { const d = await getJournalEntryDetail(id); setForm({ kind: "edit", id, initial: d }); }
    finally { setBusyId(null); }
  }
  async function openDuplicate(id: number) {
    setBusyId(id);
    try { const d = await getJournalEntryDetail(id); setForm({ kind: "duplicate", initial: d }); }
    finally { setBusyId(null); }
  }
  async function doPrint(id: number) {
    setBusyId(id);
    try { setPrintData(await getJournalEntryDetail(id)); }
    finally { setBusyId(null); }
  }
  async function doPost(id: number) {
    if (!confirm("ترحيل هذا القيد؟ سيؤثر على أرصدة الحسابات.")) return;
    setBusyId(id);
    try { await postJournalEntry(id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الترحيل"); }
    finally { setBusyId(null); }
  }
  async function doUnpost(id: number) {
    if (!confirm("فك ترحيل هذا القيد؟ سيُعاد لحالة مسودة وتُلغى آثاره على الأرصدة.")) return;
    setBusyId(id);
    try { await unpostJournalEntry(id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل فك الترحيل"); }
    finally { setBusyId(null); }
  }
  async function doDelete(id: number, entryNo: string) {
    if (!confirm(`حذف القيد ${entryNo}؟ لا يمكن التراجع، وستُلغى آثاره على الأرصدة إن كان مرحَّلاً.`)) return;
    setBusyId(id);
    try { await deleteJournalEntry(id); if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); } await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
    finally { setBusyId(null); }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((e) => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (!q) return true;
      return e.entryNo.toLowerCase().includes(q) || (e.description ?? "").toLowerCase().includes(q);
    });
  }, [rows, statusFilter, search]);

  const draftCount = rows.filter((e) => e.status === "draft").length;
  const formKey = form ? (form.kind === "edit" ? `edit-${form.id}` : form.kind === "duplicate" ? `dup-${form.initial.id}` : "create") : "none";

  return (
    <Page
      title="القيود اليومية"
      subtitle={`${rows.length} قيد — ${draftCount} مسودة — تشمل القيود التلقائية (مشتريات/مرتجع/سندات) والقيود اليدوية`}
      right={
        <button onClick={() => setForm({ kind: "create", initial: null })} disabled={!!form}
          style={{ ...btnPrimary, opacity: form ? 0.5 : 1, cursor: form ? "not-allowed" : "pointer" }}>
          + قيد يدوي
        </button>
      }
    >
      {form && (
        <Card style={{ marginBottom: 12, border: "2px solid #2563eb" }}>
          <div style={{ padding: 16 }}>
            <JeForm
              key={formKey}
              accounts={accounts}
              state={form}
              onCancel={() => setForm(null)}
              onDone={() => { setForm(null); void refresh(); }}
            />
          </div>
        </Card>
      )}

      <Card style={{ marginBottom: 12 }}>
        <div style={{ padding: 12, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 4 }}>
            {([["all", "الكل"], ["posted", "مرحَّل"], ["draft", "مسودة"]] as const).map(([v, l]) => (
              <button key={v} type="button" onClick={() => setStatusFilter(v)}
                style={{ ...(statusFilter === v ? btnPrimary : btnSecondary), padding: "6px 14px" }}>
                {l}
              </button>
            ))}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث برقم القيد أو البيان…"
            style={{ ...input, maxWidth: 300 }}
          />
          <span style={{ color: "#64748b", fontSize: 13 }}>{filtered.length} نتيجة</span>
        </div>
      </Card>

      <Card>
        {filtered.length === 0 ? <Empty text="لا توجد قيود مطابقة" /> : (
          <Table>
            <thead><tr>
              <Th>رقم القيد</Th><Th>التاريخ</Th><Th>النوع</Th><Th>البيان</Th><Th>المصدر</Th><Th>الحالة</Th>
              <Th style={{ textAlign: "left" }}>المدين</Th><Th style={{ textAlign: "left" }}>الدائن</Th>
              <Th style={{ width: 260 }}></Th>
            </tr></thead>
            <tbody>
              {filtered.map((e) => {
                const manual = isManual(e);
                const rowBusy = busyId === e.id;
                return (
                  <React.Fragment key={e.id}>
                    <tr>
                      <Td mono style={{ fontWeight: 600 }}>{e.entryNo}</Td>
                      <Td>{e.entryDate}</Td>
                      <Td>{ENTRY_TYPE_LABEL[e.entryType] ?? e.entryType}</Td>
                      <Td>{e.description ?? "—"}</Td>
                      <Td><SourceTag source={e.sourceType} /></Td>
                      <Td><StatusTag status={e.status} /></Td>
                      <Td num>{fmt(e.totalDebit)}</Td>
                      <Td num>{fmt(e.totalCredit)}</Td>
                      <Td>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          <button onClick={() => void toggleView(e.id)} disabled={!!form} aria-expanded={expandedId === e.id}
                            style={{ ...btnLink, opacity: form ? 0.5 : 1 }}>
                            {expandedId === e.id ? "▲ إخفاء" : "▼ عرض"}
                          </button>
                          {manual && (
                            <button onClick={() => void openEdit(e.id)} disabled={!!form || rowBusy} style={btnLink}>تعديل</button>
                          )}
                          <button onClick={() => void openDuplicate(e.id)} disabled={!!form || rowBusy} style={btnLink}>نسخ</button>
                          <button onClick={() => void doPrint(e.id)} disabled={rowBusy} style={btnLink}>طباعة</button>
                          {manual && e.status === "draft" && (
                            <button onClick={() => void doPost(e.id)} disabled={rowBusy} style={{ ...btnLink, color: "#15803d", fontWeight: 600 }}>ترحيل</button>
                          )}
                          {manual && e.status === "posted" && (
                            <button onClick={() => void doUnpost(e.id)} disabled={rowBusy} style={{ ...btnLink, color: "#b45309" }}>فك ترحيل</button>
                          )}
                          {manual && (
                            <button onClick={() => void doDelete(e.id, e.entryNo)} disabled={rowBusy} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                          )}
                        </div>
                      </Td>
                    </tr>
                    {expandedId === e.id && (
                      <tr style={{ background: "#f8fafc" }}>
                        <Td colSpan={9 as any}>
                          {!expandedDetail ? <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>... جاري التحميل</div> : (
                            <EntryDetail entry={expandedDetail} />
                          )}
                        </Td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
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
  const m = source ? (map[source] ?? { l: source, c: "#64748b" }) : { l: "يدوي", c: "#475569" };
  return <span style={{ background: m.c + "20", color: m.c, padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600 }}>{m.l}</span>;
}

function StatusTag({ status }: { status: JeStatus }) {
  const m = status === "posted" ? { l: "مرحَّل", c: "#15803d" } : { l: "مسودة", c: "#b45309" };
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

// ── Manual JE create / edit / duplicate form ──────────────────────────
function emptyLine(): ManualJeLine {
  return { accountId: 0, debit: 0, credit: 0, description: null, costCenterId: null };
}

function JeForm({ accounts, state, onCancel, onDone }: {
  accounts: Account[]; state: FormState; onCancel: () => void; onDone: () => void;
}) {
  const { branches, costCenters } = useDimensions();
  const init = state.initial;
  const isEdit = state.kind === "edit";

  const [date, setDate] = useState(isEdit && init ? init.entryDate : todayStr());
  const [desc, setDesc] = useState(init?.description ?? "");
  const [entryType, setEntryType] = useState<JeEntryType>(init?.entryType ?? "general");
  const [docNumber, setDocNumber] = useState(isEdit && init ? init.entryNo : "");
  const [branchId, setBranchId] = useState<number | "">(init?.branchId ?? "");
  const [costCenterId, setCostCenterId] = useState<number | "">(init?.costCenterId ?? "");
  const [autoCopyDesc, setAutoCopyDesc] = useState(true);
  const [vatMode, setVatMode] = useState<"exclusive" | "inclusive">("exclusive");
  const [suggestedNo, setSuggestedNo] = useState("");
  const [lines, setLines] = useState<ManualJeLine[]>(
    init && init.lines.length
      ? init.lines.map((l) => ({ ...l, id: isEdit ? l.id : undefined }))
      : [emptyLine(), emptyLine()]
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // VAT driving applyVat: the system default tax's percent rate + its own GL
  // account if one is configured; otherwise the country/localStorage rate and
  // the hardcoded VAT account codes (1400/2200). Loaded once.
  const [vatRate, setVatRate] = useState<number>(() => getTaxRate());
  const [vatTaxAccountId, setVatTaxAccountId] = useState<number | null>(null);

  useEffect(() => {
    void getDefaultTax()
      .then((t) => {
        if (t && t.rateType === "percent") {
          const n = Number(t.rateValue);
          if (Number.isFinite(n) && n >= 0) setVatRate(n);
        }
        setVatTaxAccountId(t?.accountId ?? null);
      })
      .catch(() => { /* keep the getTaxRate() fallback */ });
  }, []);

  // Peek the next sequence number for the "الرقم المقترح" hint (create/duplicate only).
  useEffect(() => {
    if (isEdit) return;
    void peekJournalEntryNumber().then(setSuggestedNo).catch(() => setSuggestedNo(""));
  }, [isEdit]);

  const leafAccounts = useMemo(() => accounts.filter((a) => a.isLeaf), [accounts]);
  const accountOptions = useMemo(() => [
    { value: 0, label: "— اختر —" },
    ...leafAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` })),
  ], [leafAccounts]);
  const ccOptions = useMemo(() => costCenterPickerOptions(costCenters), [costCenters]);

  const totalDr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const validCount = lines.filter((l) => l.accountId && ((Number(l.debit) || 0) > 0 || (Number(l.credit) || 0) > 0)).length;
  const balanced = Math.abs(totalDr - totalCr) < 0.001 && totalDr > 0 && validCount >= 2;

  function setLine(i: number, patch: Partial<ManualJeLine>) {
    setLines((ls) => ls.map((l, k) => k === i ? { ...l, ...patch } : l));
  }
  function addLine() { setLines((ls) => [...ls, { ...emptyLine(), costCenterId: costCenterId === "" ? null : costCenterId }]); }
  function removeLine(i: number) { setLines((ls) => ls.length > 1 ? ls.filter((_, k) => k !== i) : ls); }

  function onHeaderDescChange(v: string) {
    setDesc(v);
    if (autoCopyDesc) setLines((ls) => ls.map((l) => ({ ...l, description: v || null })));
  }
  function copyDescToLines() {
    setLines((ls) => ls.map((l) => ({ ...l, description: desc || null })));
  }

  function applyVat() {
    // Account resolution: the default tax (شاشة الضرائب) owns ONE GL account
    // used on either side. If a default tax is configured WITH an account, that
    // account MUST exist — we never silently fall back, so a bad configuration
    // surfaces instead of posting to the wrong account. Only when there is no
    // default-tax account at all do we fall back to the legacy codes 1400/2200.
    let vatInId: number | undefined;
    let vatOutId: number | undefined;
    if (vatTaxAccountId != null) {
      if (!accounts.some((a) => a.id === vatTaxAccountId)) {
        setErr("حساب الضريبة المرتبط بالضريبة الافتراضية غير موجود في شجرة الحسابات — افتح شاشة الضرائب واختر حسابًا صحيحًا");
        return;
      }
      vatInId = vatTaxAccountId;
      vatOutId = vatTaxAccountId;
    } else {
      vatInId = accounts.find((a) => a.code === VAT_IN_CODE)?.id;
      vatOutId = accounts.find((a) => a.code === VAT_OUT_CODE)?.id;
      if (!vatInId || !vatOutId) {
        setErr(`لا يوجد حساب ضريبة افتراضي — افتح شاشة الضرائب وحدّد ضريبة افتراضية بحساب، أو أضف الحسابين (${VAT_IN_CODE} مدخلات / ${VAT_OUT_CODE} مخرجات) في شجرة الحسابات`);
        return;
      }
    }
    setErr(null);
    const defCc = costCenterId === "" ? null : costCenterId;
    const rate = vatRate;
    const vatDesc = `${VAT_DESC_PREFIX} ${fmt(rate)}%`;
    const isVatAccount = (accId: number | null | undefined) => {
      const code = accounts.find((a) => a.id === accId)?.code;
      return code === VAT_IN_CODE || code === VAT_OUT_CODE ||
        (vatTaxAccountId != null && accId === vatTaxAccountId);
    };
    setLines((prev) => {
      // Idempotent: drop the VAT lines a previous click already generated so
      // re-running the tool rebuilds ONE correct set instead of stacking a new
      // tax line for every base line on every press (the reported duplication).
      const base = prev.filter(
        (l) => !(isVatAccount(l.accountId) && (l.description ?? "").startsWith(VAT_DESC_PREFIX)),
      );
      const out: ManualJeLine[] = [];
      const vatLines: ManualJeLine[] = [];
      for (const l of base) {
        const dr = Number(l.debit) || 0, cr = Number(l.credit) || 0;
        if (!l.accountId || isVatAccount(l.accountId) || (dr <= 0 && cr <= 0)) { out.push(l); continue; }
        const onDebit = dr > 0;
        const amount = onDebit ? dr : cr;
        const alreadyNet = (l.description ?? "").includes(NET_MARKER);
        let vat: number;
        if (alreadyNet) {
          // Line is already the net base from a prior inclusive run — tax the net
          // and keep it as-is; never re-net (that compounded on each click).
          vat = round2(amount * rate / 100);
          out.push(l);
        } else if (vatMode === "exclusive") {
          vat = round2(amount * rate / 100);
          out.push(l);
        } else {
          vat = round2(amount * rate / (100 + rate));
          const net = round2(amount - vat);
          out.push({ ...l, debit: onDebit ? net : 0, credit: onDebit ? 0 : net, description: `${l.description ?? ""}${NET_MARKER}` });
        }
        vatLines.push({
          accountId: onDebit ? vatInId : vatOutId,
          debit: onDebit ? vat : 0, credit: onDebit ? 0 : vat,
          description: vatDesc, costCenterId: l.costCenterId ?? defCc,
        });
      }
      return [...out, ...vatLines];
    });
  }

  function buildPayload(status: JeStatus) {
    const cleaned = lines
      .filter((l) => l.accountId && ((Number(l.debit) || 0) > 0 || (Number(l.credit) || 0) > 0))
      .map((l) => ({
        id: isEdit ? l.id ?? null : undefined,
        accountId: l.accountId,
        debit: Number(l.debit) || 0,
        credit: Number(l.credit) || 0,
        description: l.description ?? (desc || null),
        costCenterId: l.costCenterId ?? (costCenterId === "" ? null : costCenterId),
      }));
    return {
      entryDate: date,
      description: desc || null,
      entryType,
      docNumber: isEdit ? undefined : (docNumber.trim() || null),
      status,
      branchId: branchId === "" ? null : branchId,
      costCenterId: costCenterId === "" ? null : costCenterId,
      lines: cleaned,
    };
  }

  async function save(status: JeStatus) {
    if (status === "draft" && validCount < 1) { setErr("أضف سطراً واحداً صالحاً على الأقل"); return; }
    if (status === "posted" && !balanced) { setErr("القيد غير متوازن أو يحتوي أقل من سطرين"); return; }
    setBusy(true); setErr(null);
    try {
      const payload = buildPayload(status);
      if (isEdit) await updateJournalEntry((state as Extract<FormState, { kind: "edit" }>).id, payload);
      else await createJournalEntry(payload);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  // Keyboard shortcuts: Ctrl+S / Ctrl+Enter = post, Ctrl+D = draft,
  // Ctrl+L = add line, Esc = cancel.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (busy) return;
      if (ev.key === "Escape") { ev.preventDefault(); onCancel(); return; }
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const k = ev.key.toLowerCase();
      if (k === "s" || ev.key === "Enter") { ev.preventDefault(); void save("posted"); }
      else if (k === "d") { ev.preventDefault(); void save("draft"); }
      else if (k === "l") { ev.preventDefault(); addLine(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, lines, date, desc, entryType, docNumber, branchId, costCenterId]);

  const title = isEdit ? `تعديل القيد ${init?.entryNo ?? ""}` : state.kind === "duplicate" ? `نسخة من ${init?.entryNo ?? ""}` : "إضافة قيد يومية يدوي";

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{title}</h3>

      <div style={{ display: "grid", gridTemplateColumns: "180px 180px 1fr", gap: 10 }}>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="نوع القيد">
          <select value={entryType} onChange={(e) => setEntryType(e.target.value as JeEntryType)} style={input}>
            {ENTRY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        <Field label={isEdit ? "رقم القيد" : `رقم القيد (اتركه فارغاً للترقيم التلقائي${suggestedNo ? ` — المقترح: ${suggestedNo}` : ""})`}>
          <input value={docNumber} disabled={isEdit}
            onChange={(e) => setDocNumber(e.target.value)}
            placeholder={isEdit ? "" : suggestedNo}
            style={{ ...input, ...(isEdit ? { background: "#f1f5f9", color: "#64748b" } : {}) }} />
        </Field>
      </div>

      <div style={{ marginTop: 10 }}>
        <Field label="البيان العام"><input value={desc} onChange={(e) => onHeaderDescChange(e.target.value)} style={input} /></Field>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 13, color: "#475569" }}>
          <input type="checkbox" checked={autoCopyDesc} onChange={(e) => setAutoCopyDesc(e.target.checked)} />
          نسخ البيان العام تلقائياً لكل سطر
          <button type="button" onClick={copyDescToLines} style={{ ...btnLink, marginInlineStart: 8 }}>نسخ الآن</button>
        </label>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
        <Field label="الفرع">
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label="مركز التكلفة (افتراضي للسطور)">
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} options={ccOptions} style={input} />
        </Field>
      </div>

      <div style={{ marginTop: 12, padding: 10, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>{`أداة الضريبة ${fmt(vatRate)}%:`}</strong>
        <select value={vatMode} onChange={(e) => setVatMode(e.target.value as any)} style={{ ...input, width: 220 }}>
          <option value="exclusive">غير شامل — تُضاف الضريبة فوق المبلغ</option>
          <option value="inclusive">شامل — المبلغ يتضمن الضريبة</option>
        </select>
        <button type="button" onClick={applyVat} style={btnSecondary}>أضف سطور الضريبة</button>
      </div>

      <Table>
        <thead><tr>
          <Th style={{ minWidth: 200 }}>الحساب</Th><Th>البيان</Th><Th style={{ width: 180 }}>مركز التكلفة</Th>
          <Th style={{ width: 120 }}>مدين</Th><Th style={{ width: 120 }}>دائن</Th><Th style={{ width: 50 }}></Th>
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>
                <SearchCombobox value={l.accountId} onChange={(v) => setLine(i, { accountId: Number(v) })} style={input} options={accountOptions} />
              </Td>
              <Td><input value={l.description ?? ""} onChange={(e) => setLine(i, { description: e.target.value || null })} style={input} /></Td>
              <Td>
                <SearchCombobox value={l.costCenterId ?? ""} onChange={(v) => setLine(i, { costCenterId: v === "" ? null : Number(v) })} style={input} options={ccOptions} />
              </Td>
              <Td><input type="number" step="0.01" value={l.debit || ""} onChange={(e) => setLine(i, { debit: Number(e.target.value) || 0, credit: 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.credit || ""} onChange={(e) => setLine(i, { credit: Number(e.target.value) || 0, debit: 0 })} style={input} /></Td>
              <Td><button onClick={() => removeLine(i)} type="button" style={{ ...btnLink, color: "#dc2626" }}>×</button></Td>
            </tr>
          ))}
          <tr style={{ background: "#f8fafc", fontWeight: 700 }}>
            <Td colSpan={3 as any}>الإجمالي</Td>
            <Td num>{fmt(totalDr)}</Td>
            <Td num>{fmt(totalCr)}</Td>
            <Td></Td>
          </tr>
        </tbody>
      </Table>

      <div style={{ marginTop: 8 }}>
        <button onClick={addLine} type="button" style={btnSecondary}>+ سطر</button>
        {!balanced && totalDr > 0 && Math.abs(totalDr - totalCr) >= 0.001 && (
          <span style={{ marginInlineStart: 12, color: "#dc2626", fontSize: 13 }}>القيد غير متوازن — الفرق {fmt(Math.abs(totalDr - totalCr))}</span>
        )}
      </div>

      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء (Esc)</button>
        <button onClick={() => void save("draft")} disabled={busy} type="button" style={btnDanger}>{busy ? "..." : "حفظ كمسودة (Ctrl+D)"}</button>
        <button onClick={() => void save("posted")} disabled={busy || !balanced} type="button" style={btnPrimary}>{busy ? "..." : "حفظ وترحيل (Ctrl+S)"}</button>
      </Actions>
    </div>
  );
}

// ── Print (professional letterhead, standalone HTML document) ──────────
// We build a complete, self-contained HTML document and print it inside a
// hidden iframe rather than overlaying a hidden node in the live DOM. The
// old overlay approach (#je-print-area, position:absolute + visibility tricks)
// was silently CLIPPED by PosShell's flex/overflow ancestor containers, so the
// printout came out cropped/short. An iframe is its own document with no
// clipping ancestors and prints reliably inside the Tauri WebView2.
const jeEscapeHtml = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function buildJePrintHtml(data: ManualJeDetail, company: CompanyProfile): string {
  const statusLabel = data.status === "posted" ? "مرحَّل" : "مسودة";
  const statusBg = data.status === "posted" ? "#dcfce7" : "#fef9c3";
  const statusColor = data.status === "posted" ? "#166534" : "#854d0e";
  const printedAt = new Date().toLocaleString("ar-SA");
  const typeLabel = ENTRY_TYPE_LABEL[data.entryType] ?? data.entryType;
  const logo = safeLogoSrc(company.logo);
  const rows = data.lines.map((l, i) => `
        <tr>
          <td class="je-num">${i + 1}</td>
          <td>${jeEscapeHtml(l.accountCode)} — ${jeEscapeHtml(l.accountName)}</td>
          <td>${jeEscapeHtml(l.description ?? "")}</td>
          <td class="je-num">${l.debit ? jeEscapeHtml(fmt(l.debit)) : ""}</td>
          <td class="je-num">${l.credit ? jeEscapeHtml(fmt(l.credit)) : ""}</td>
        </tr>`).join("");
  const metaParts: string[] = [];
  if (company.cr) metaParts.push(`<span>س.ت: ${jeEscapeHtml(company.cr)}</span>`);
  if (company.cr && company.vat) metaParts.push(`<span> • </span>`);
  if (company.vat) metaParts.push(`<span>الرقم الضريبي: ${jeEscapeHtml(company.vat)}</span>`);
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<title>قيد يومية — ${jeEscapeHtml(data.entryNo)}</title>
<style>
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
body { direction: rtl; font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#0f172a; margin:0; padding:0; }
.je-head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #1e293b; padding-bottom:12px; }
.je-head-r { display:flex; gap:14px; align-items:center; }
.je-logo { max-height:70px; max-width:160px; object-fit:contain; }
.je-co-name { font-size:20px; font-weight:800; margin:0; }
.je-co-meta { font-size:12px; color:#475569; margin-top:4px; }
.je-print-meta { font-size:11px; color:#64748b; text-align:left; }
.je-banner { display:flex; justify-content:space-between; align-items:center; background:#eef2ff; border:1px solid #c7d2fe; border-radius:8px; padding:10px 14px; margin-top:16px; }
.je-docno { font-size:16px; }
.je-docmeta { font-size:12px; color:#475569; margin-top:4px; }
.je-status { font-size:12px; font-weight:700; padding:4px 12px; border-radius:999px; background:${statusBg}; color:${statusColor}; }
.je-desc { font-size:13px; margin-top:12px; }
.je-print-table { width:100%; border-collapse:collapse; margin-top:14px; }
.je-print-table th, .je-print-table td { border:1px solid #94a3b8; padding:7px 10px; font-size:12.5px; }
.je-print-table th { background:#f1f5f9; text-align:right; }
.je-print-table tfoot td { background:#f8fafc; font-weight:800; }
.je-num { text-align:left; font-variant-numeric:tabular-nums; }
.je-signs { display:flex; justify-content:space-between; gap:24px; margin-top:56px; }
.je-sign { flex:1; text-align:center; }
.je-sign-line { border-top:1px solid #475569; margin-bottom:6px; }
.je-sign-label { font-size:12px; color:#475569; }
</style></head><body>
  <div class="je-head">
    <div class="je-head-r">
      ${logo ? `<img class="je-logo" src="${jeEscapeHtml(logo)}" alt="" />` : ""}
      <div>
        <h1 class="je-co-name">${jeEscapeHtml(company.name || "قيد يومية")}</h1>
        <div class="je-co-meta">${metaParts.join("")}</div>
      </div>
    </div>
    <div class="je-print-meta"><div>تاريخ الطباعة</div><div>${jeEscapeHtml(printedAt)}</div></div>
  </div>

  <div class="je-banner">
    <div>
      <div class="je-docno">قيد رقم: <b>${jeEscapeHtml(data.entryNo)}</b></div>
      <div class="je-docmeta">التاريخ: ${jeEscapeHtml(data.entryDate)} • النوع: ${jeEscapeHtml(typeLabel)}</div>
    </div>
    <div class="je-status">${statusLabel}</div>
  </div>

  ${data.description ? `<div class="je-desc"><b>البيان:</b> ${jeEscapeHtml(data.description)}</div>` : ""}

  <table class="je-print-table">
    <thead>
      <tr>
        <th style="width:38px">م</th>
        <th>الحساب</th>
        <th>الوصف</th>
        <th style="width:110px">مدين</th>
        <th style="width:110px">دائن</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="3">الإجمالي</td>
        <td class="je-num">${jeEscapeHtml(fmt(data.totalDebit))}</td>
        <td class="je-num">${jeEscapeHtml(fmt(data.totalCredit))}</td>
      </tr>
    </tfoot>
  </table>

  <div class="je-signs">
    <div class="je-sign"><div class="je-sign-line"></div><div class="je-sign-label">المحاسب / المُعدّ</div></div>
    <div class="je-sign"><div class="je-sign-line"></div><div class="je-sign-label">المراجع</div></div>
    <div class="je-sign"><div class="je-sign-line"></div><div class="je-sign-label">المدير المالي / الاعتماد</div></div>
  </div>
</body></html>`;
}

function printJournalEntry(data: ManualJeDetail, company: CompanyProfile): void {
  const html = buildJePrintHtml(data, company);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  const doc = win?.document;
  if (!win || !doc) { iframe.remove(); return; }
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    try { win.focus(); win.print(); } catch { /* user cancelled / unsupported */ }
    setTimeout(() => iframe.remove(), 1500);
  };
  doc.open();
  doc.write(html);
  doc.close();
  // Wait for the document (incl. the logo image) to finish loading so the
  // letterhead isn't blank, then print. Fall back to a timeout in case the
  // load event never fires inside the embedded webview.
  if (doc.readyState === "complete") setTimeout(run, 200);
  else win.addEventListener("load", () => setTimeout(run, 200), { once: true });
  setTimeout(run, 1200);
}
