import React, { useEffect, useMemo, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import { applyNumberSystemToDocument } from "../lib/numberDisplay";
import {
  listJournalEntries, getJournalEntry, getJournalEntryDetail,
  createJournalEntry, updateJournalEntry, postJournalEntry, unpostJournalEntry,
  deleteJournalEntry, peekJournalEntryNumber, listAccounts, confirmUnpostAction,
  type JournalEntry, type ManualJeLine, type ManualJeDetail,
  type JeEntryType, type JeStatus, type Account,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnDanger, btnLink, fmt, todayStr, SearchCombobox,
  useRowSelect, SelectTh, SelectCell, ActionBar, ActionBtn, errText,
  ExportButtons, GridFilterRow, SortableTh, gridToExportCols, useGridFilter,
  type GridColumn,
} from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { getTaxRate } from "../lib/taxSettings";
import { getDefaultTax } from "../lib/taxes";
import {
  formatUiDate, getCompanyProfile, getUiLanguage, safeLogoSrc, uiText, useUiLanguage,
  type CompanyProfile, type UiLanguage,
} from "../lib/appSettings";

const ENTRY_TYPES: { value: JeEntryType; labelAr: string; labelEn: string }[] = [
  { value: "general", labelAr: "قيد عام", labelEn: "General journal entry" },
  { value: "opening", labelAr: "قيد افتتاحي", labelEn: "Opening entry" },
  { value: "closing", labelAr: "قيد إقفال", labelEn: "Closing entry" },
  { value: "adjustment", labelAr: "قيد تسوية", labelEn: "Adjustment entry" },
  { value: "depreciation", labelAr: "قيد إهلاك", labelEn: "Depreciation entry" },
];
const ENTRY_TYPE_LABEL: Record<string, [string, string]> =
  Object.fromEntries(ENTRY_TYPES.map((t) => [t.value, [t.labelAr, t.labelEn]]));

const VAT_IN_CODE = "1400";   // ضريبة القيمة المضافة - مدخلات (أصل)
const VAT_OUT_CODE = "2200";  // ضريبة القيمة المضافة - مخرجات (التزام)
const NET_MARKER = " (صافٍ من الضريبة)";
const VAT_DESC_PREFIX = "ضريبة القيمة المضافة";
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// ── Month grouping (audit-grid visual polish, mirrors the web list) ──────
// Rows are grouped under a month-accent separator derived from `entryDate`.
// Twelve hand-picked accent tones read well against the slate table body.
const MONTH_NAMES_AR: Record<number, string> = {
  1: "يناير", 2: "فبراير", 3: "مارس", 4: "أبريل", 5: "مايو", 6: "يونيو",
  7: "يوليو", 8: "أغسطس", 9: "سبتمبر", 10: "أكتوبر", 11: "نوفمبر", 12: "ديسمبر",
};
const MONTH_ACCENTS: Record<number, string> = {
  1: "#fb7185", 2: "#f472b6", 3: "#e879f9", 4: "#c084fc", 5: "#a78bfa", 6: "#818cf8",
  7: "#60a5fa", 8: "#38bdf8", 9: "#2dd4bf", 10: "#34d399", 11: "#f59e0b", 12: "#f97316",
};
function monthInfo(entryDate: string | null | undefined): { key: string; label: string; accent: string } {
  const m = String(entryDate ?? "").match(/^(\d{4})-(\d{2})/);
  if (!m) return { key: "—", label: "بدون تاريخ", accent: "#cbd5e1" };
  const year = m[1];
  const month = Number(m[2]);
  return {
    key: `${year}-${m[2]}`,
    label: `${MONTH_NAMES_AR[month] ?? m[2]} ${year}`,
    accent: MONTH_ACCENTS[month] ?? "#cbd5e1",
  };
}

type FormState =
  | { kind: "create"; initial: null }
  | { kind: "edit"; id: number; initial: ManualJeDetail }
  | { kind: "duplicate"; initial: ManualJeDetail };

function isManual(e: { sourceType: string | null }): boolean {
  return e.sourceType === null || e.sourceType === "manual";
}

const SOURCE_LABELS: Record<string, [string, string]> = {
  manual: ["يدوي", "Manual"],
  purchase: ["شراء", "Purchase"],
  purchase_return: ["مرتجع شراء", "Purchase return"],
  receipt: ["سند قبض", "Receipt voucher"],
  payment: ["سند صرف", "Payment voucher"],
};
function sourceText(source: string | null, language: UiLanguage): string {
  if (!source || source === "manual") return uiText("يدوي", "Manual", language);
  return SOURCE_LABELS[source] ? uiText(...SOURCE_LABELS[source], language) : source;
}

export default function JournalEntries() {
  const language = useUiLanguage();
  const [rows, setRows] = useState<JournalEntry[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<JournalEntry | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | JeStatus>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [printData, setPrintData] = useState<ManualJeDetail | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  async function refresh() {
    const [list, accs] = await Promise.all([listJournalEntries(5000), listAccounts()]);
    setRows(list); setAccounts(accs);
  }
  useEffect(() => { void refresh(); }, []);
  useDataRefresh(["journal"], refresh);

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
  async function doUnpost(id: number, entryNo: string) {
    if (!(await confirmUnpostAction("القيد", entryNo))) return;
    setBusyId(id);
    try { await unpostJournalEntry(id); await refresh(); }
    catch (e: any) { alert(errText(e, "فشل فك الترحيل")); }
    finally { setBusyId(null); }
  }
  async function doDelete(id: number, entryNo: string) {
    if (!confirm(`حذف القيد ${entryNo}؟ لا يمكن التراجع، وستُلغى آثاره على الأرصدة إن كان مرحَّلاً.`)) return;
    setBusyId(id);
    try { await deleteJournalEntry(id); if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); } await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
    finally { setBusyId(null); }
  }

  const gridColumns = useMemo<GridColumn<JournalEntry>[]>(() => [
    { key: "entryNo", label: uiText("رقم القيد", "Entry number", language), value: (e) => e.entryNo },
    { key: "entryDate", label: uiText("التاريخ", "Date", language), value: (e) => e.entryDate, text: (e) => formatUiDate(e.entryDate, language) },
    { key: "entryType", label: uiText("النوع", "Type", language), value: (e) => ENTRY_TYPE_LABEL[e.entryType] ? uiText(...ENTRY_TYPE_LABEL[e.entryType], language) : e.entryType },
    { key: "description", label: uiText("البيان", "Description", language), value: (e) => e.description ?? "" },
    { key: "sourceType", label: uiText("المصدر", "Source", language), value: (e) => sourceText(e.sourceType, language) },
    { key: "status", label: uiText("الحالة", "Status", language), value: (e) => e.status === "posted" ? uiText("مرحَّل", "Posted", language) : uiText("مسودة", "Draft", language) },
    { key: "totalDebit", label: uiText("المدين", "Debit", language), type: "number", value: (e) => e.totalDebit },
    { key: "totalCredit", label: uiText("الدائن", "Credit", language), type: "number", value: (e) => e.totalCredit },
  ], [language]);

  const dateStatusRows = useMemo(() => rows.filter((e) => {
    if (statusFilter !== "all" && e.status !== statusFilter) return false;
    if (dateFrom && e.entryDate < dateFrom) return false;
    if (dateTo && e.entryDate > dateTo) return false;
    return true;
  }), [rows, statusFilter, dateFrom, dateTo]);
  const grid = useGridFilter(dateStatusRows, gridColumns);
  const filtered = grid.view;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filtered, safePage, pageSize],
  );

  useEffect(() => {
    setPage(1);
  }, [statusFilter, dateFrom, dateTo, grid.search, grid.columnFilters, grid.sort, pageSize]);
  useEffect(() => {
    if (safePage !== page) setPage(safePage);
  }, [safePage, page]);

  function applyDatePreset(preset: "today" | "week" | "month" | "year") {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const format = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today = format(now);
    if (preset === "today") { setDateFrom(today); setDateTo(today); return; }
    const start = new Date(now);
    if (preset === "week") start.setDate(now.getDate() - 6);
    if (preset === "month") start.setDate(1);
    if (preset === "year") { start.setMonth(0); start.setDate(1); }
    setDateFrom(format(start));
    setDateTo(today);
  }

  function clearFilters() {
    setStatusFilter("all");
    setDateFrom("");
    setDateTo("");
    grid.clearAll();
    setPage(1);
  }

  function exportCsv() {
    if (filtered.length === 0) return;
    const csvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const lines = [
      gridColumns.map((col) => csvCell(col.label)).join(","),
      ...filtered.map((entry) => gridColumns.map((col) => {
        const value = col.text ? col.text(entry) : col.value(entry);
        return csvCell(typeof value === "number" ? value.toFixed(2) : value);
      }).join(",")),
    ];
    const blob = new Blob(["\uFEFF", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `journal-entries-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Single-row ActionBar selection binds to the VISIBLE (filtered) set so a
  // hidden row can never be acted on; useRowSelect self-clears when it drops out.
  const sel = useRowSelect(filtered);

  // ── Form prev/next navigation: cycle through the filtered MANUAL entries
  //    by display order (newest-first as returned by the list). ───────────
  const navIds = useMemo(() => filtered.filter(isManual).map((e) => e.id), [filtered]);

  // ── Bulk selection (manual entries only) ─────────────────────────────
  // A row is selectable when it is manual. Bulk-post then operates on the
  // DRAFT subset and bulk-delete on every selected manual row, mirroring the
  // per-row guards.
  const selectableIds = useMemo(() => filtered.filter(isManual).map((e) => e.id), [filtered]);
  // Prune selections that fell out of the current filter so counts stay honest.
  useEffect(() => {
    setSelected((prev) => {
      const allow = new Set(selectableIds);
      let changed = false;
      const next = new Set<number>();
      prev.forEach((id) => { if (allow.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [selectableIds]);

  const selectedIds = useMemo(() => Array.from(selected), [selected]);
  const draftSelectedIds = useMemo(() => {
    const sel = new Set(selected);
    return rows.filter((e) => sel.has(e.id) && isManual(e) && e.status === "draft").map((e) => e.id);
  }, [rows, selected]);
  const postedSelectedIds = useMemo(() => {
    const sel = new Set(selected);
    return rows.filter((e) => sel.has(e.id) && isManual(e) && e.status === "posted").map((e) => e.id);
  }, [rows, selected]);
  const selectedRows = useMemo(
    () => filtered.filter((e) => selected.has(e.id)),
    [filtered, selected],
  );
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  function toggleSel(id: number) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleSelectAll() {
    setSelected((prev) => prev.size >= selectableIds.length && selectableIds.every((id) => prev.has(id))
      ? new Set()
      : new Set(selectableIds));
  }

  // Sequentially run a single-entry op over `ids`, collecting per-row failures.
  async function bulkRun(ids: number[], fn: (id: number) => Promise<void>): Promise<{ ok: number; failures: string[] }> {
    let ok = 0; const failures: string[] = [];
    for (const id of ids) {
      const e = rows.find((r) => r.id === id);
      const label = e ? e.entryNo : String(id);
      try { await fn(id); ok++; } catch (err: any) { failures.push(`${label}: ${err?.message ?? "فشل"}`); }
    }
    return { ok, failures };
  }

  async function handleBulkPost() {
    if (draftSelectedIds.length === 0) return;
    if (!confirm(`سيتم ترحيل ${draftSelectedIds.length} قيد محدد. متابعة؟`)) return;
    setBulkBusy(true);
    try {
      const { ok, failures } = await bulkRun(draftSelectedIds, (id) => postJournalEntry(id));
      await refresh();
      setSelected(new Set());
      if (failures.length > 0) {
        alert(`تم ترحيل ${ok} من ${draftSelectedIds.length} قيد.\n${failures.length} قيد فشل:\n• ${failures.slice(0, 8).join("\n• ")}`);
      } else if (ok > 0) {
        alert(`تم ترحيل ${ok} قيد بنجاح`);
      }
    } finally { setBulkBusy(false); }
  }

  async function handleBulkUnpost() {
    if (postedSelectedIds.length === 0) return;
    if (!confirm(`سيُفك ترحيل ${postedSelectedIds.length} قيد محدد، وسيُلغى أثره من الأرصدة والتقارير. متابعة؟`)) return;
    setBulkBusy(true);
    try {
      const { ok, failures } = await bulkRun(postedSelectedIds, (id) => unpostJournalEntry(id));
      await refresh();
      setSelected(new Set());
      if (failures.length > 0) {
        alert(`تم فك ترحيل ${ok} من ${postedSelectedIds.length} قيد.\n${failures.length} قيد فشل:\n• ${failures.slice(0, 8).join("\n• ")}`);
      } else if (ok > 0) {
        alert(`تم فك ترحيل ${ok} قيد بنجاح`);
      }
    } finally { setBulkBusy(false); }
  }

  async function handleBulkDelete() {
    const ids = rows.filter((e) => selected.has(e.id) && isManual(e)).map((e) => e.id);
    if (ids.length === 0) return;
    if (!confirm(`حذف ${ids.length} قيد محدد؟ لا يمكن التراجع، وستُلغى آثار القيود المرحَّلة على الأرصدة.`)) return;
    setBulkBusy(true);
    try {
      const { ok, failures } = await bulkRun(ids, (id) => deleteJournalEntry(id));
      if (expandedId != null && ids.includes(expandedId)) { setExpandedId(null); setExpandedDetail(null); }
      await refresh();
      setSelected(new Set());
      if (failures.length > 0) {
        alert(`تم حذف ${ok} من ${ids.length} قيد.\n${failures.length} قيد فشل:\n• ${failures.slice(0, 8).join("\n• ")}`);
      } else if (ok > 0) {
        alert(`تم حذف ${ok} قيد بنجاح`);
      }
    } finally { setBulkBusy(false); }
  }

  const draftCount = rows.filter((e) => e.status === "draft").length;
  const filteredDebit = filtered.reduce((sum, e) => sum + Number(e.totalDebit || 0), 0);
  const filteredCredit = filtered.reduce((sum, e) => sum + Number(e.totalCredit || 0), 0);
  const formKey = form ? (form.kind === "edit" ? `edit-${form.id}` : form.kind === "duplicate" ? `dup-${form.initial.id}` : "create") : "none";

  return (
    <Page
      title={uiText("القيود اليومية", "Journal entries", language)}
      subtitle={uiText(
        `${filtered.length} نتيجة من ${rows.length} قيد محمّل — ${draftCount} مسودة`,
        `${filtered.length} results from ${rows.length} loaded entries — ${draftCount} drafts`,
        language,
      )}
      right={
        <button onClick={() => setForm({ kind: "create", initial: null })} disabled={!!form}
          style={{
            ...btnPrimary, minHeight: 40, padding: "9px 18px", borderRadius: 10,
            boxShadow: "0 5px 14px rgba(37,99,235,.18)",
            opacity: form ? 0.5 : 1, cursor: form ? "not-allowed" : "pointer",
          }}>
          {uiText("＋ قيد يدوي", "＋ Manual entry", language)}
        </button>
      }
    >
      {form && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ padding: 16 }}>
            <JeForm
              key={formKey}
              accounts={accounts}
              state={form}
              navIds={navIds}
              onNavigate={(id) => void openEdit(id)}
              onCancel={() => setForm(null)}
              onDone={() => { setForm(null); void refresh(); }}
            />
          </div>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12, marginBottom: 12 }}>
        {[
          { label: uiText("القيود المطابقة", "Matching entries", language), symbol: "#", value: filtered.length.toLocaleString(), accent: "#2563eb", wash: "#eff6ff", note: uiText("حسب الفلاتر الحالية", "With current filters", language) },
          { label: uiText("إجمالي المدين", "Total debit", language), symbol: "مد", value: fmt(filteredDebit), accent: "#059669", wash: "#ecfdf5", note: uiText("للقائمة المطابقة", "For matching entries", language) },
          { label: uiText("إجمالي الدائن", "Total credit", language), symbol: "دا", value: fmt(filteredCredit), accent: "#7c3aed", wash: "#f5f3ff", note: uiText("للقائمة المطابقة", "For matching entries", language) },
        ].map((stat) => (
          <Card key={stat.label} style={{ padding: 14, borderRadius: 14, boxShadow: "0 4px 14px rgba(15,23,42,.04)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 42, height: 42, borderRadius: 12, display: "grid", placeItems: "center", background: stat.wash, color: stat.accent, fontSize: 18, fontWeight: 800 }}>
                {stat.symbol}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "#64748b", fontSize: 12, fontWeight: 600 }}>{stat.label}</div>
                <div style={{ color: "#0f172a", fontSize: 20, fontWeight: 800, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{stat.value}</div>
                <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>{stat.note}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card style={{ marginBottom: 12, borderRadius: 14, boxShadow: "0 4px 16px rgba(15,23,42,.04)" }}>
        <div style={{ padding: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 4 }}>
            {([
              ["all", uiText("الكل", "All", language)],
              ["posted", uiText("مرحَّل", "Posted", language)],
              ["draft", uiText("مسودة", "Draft", language)],
            ] as const).map(([v, l]) => (
              <button key={v} type="button" onClick={() => setStatusFilter(v)}
                style={{
                  ...(statusFilter === v ? btnPrimary : btnSecondary), padding: "7px 13px",
                  borderRadius: 9, minHeight: 34, fontWeight: 700,
                }}>
                {l}
              </button>
            ))}
          </div>
          <input
            value={grid.search}
            onChange={(e) => grid.setSearch(e.target.value)}
            placeholder={uiText("بحث برقم القيد أو البيان…", "Search entry number or description…", language)}
            style={{ ...input, maxWidth: 300, marginBottom: 0, minHeight: 36, borderRadius: 9 }}
          />
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, padding: "4px 8px", border: "1px solid #dbe4ef", borderRadius: 10, background: dateFrom || dateTo ? "#eff6ff" : "#f8fafc" }}>
            <span style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>{uiText("التاريخ", "Date range", language)}</span>
            <input type="date" aria-label={uiText("من تاريخ", "From date", language)} value={dateFrom} max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              style={{ ...input, width: 132, minHeight: 30, padding: "4px 7px", marginBottom: 0, fontSize: 12, borderRadius: 7 }} />
            <span style={{ color: "#94a3b8", fontSize: 12 }}>{uiText("إلى", "to", language)}</span>
            <input type="date" aria-label={uiText("إلى تاريخ", "To date", language)} value={dateTo} min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              style={{ ...input, width: 132, minHeight: 30, padding: "4px 7px", marginBottom: 0, fontSize: 12, borderRadius: 7 }} />
            {([
              ["today", uiText("اليوم", "Today", language)],
              ["week", uiText("٧ أيام", "7 days", language)],
              ["month", uiText("هذا الشهر", "This month", language)],
              ["year", uiText("هذه السنة", "This year", language)],
            ] as const).map(([preset, label]) => (
              <button key={preset} type="button" onClick={() => applyDatePreset(preset)}
                style={{ ...btnSecondary, padding: "5px 8px", minHeight: 28, borderRadius: 7, fontSize: 11 }}>
                {label}
              </button>
            ))}
            {(dateFrom || dateTo) && (
              <button type="button" onClick={() => { setDateFrom(""); setDateTo(""); }}
                style={{ ...btnLink, padding: "3px 5px", color: "#b91c1c" }} title={uiText("مسح فلتر التاريخ", "Clear date filter", language)}>{uiText("مسح", "Clear", language)}</button>
            )}
          </div>
          <span style={{ color: "#64748b", fontSize: 12, fontWeight: 600 }}>{uiText(`${filtered.length} نتيجة`, `${filtered.length} results`, language)}</span>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={() => grid.setShowFilters(!grid.showFilters)}
            style={{ ...btnSecondary, minHeight: 36, borderRadius: 9, background: grid.showFilters ? "#dbeafe" : "#fff", color: grid.showFilters ? "#1d4ed8" : "#334155" }}>
            {uiText("فلاتر الأعمدة", "Column filters", language)}
          </button>
          <ExportButtons columns={gridToExportCols(gridColumns)} rows={filtered} filenameBase="journal-entries" title={uiText("القيود اليومية", "Journal entries", language)} />
          <button type="button" onClick={exportCsv} disabled={filtered.length === 0}
            style={{ ...btnSecondary, minHeight: 36, borderRadius: 9, opacity: filtered.length ? 1 : 0.5 }}>
            CSV
          </button>
          {(grid.hasActive || grid.sort || statusFilter !== "all" || dateFrom || dateTo) && (
            <button type="button" onClick={clearFilters}
              style={{ ...btnSecondary, minHeight: 36, borderRadius: 9, color: "#b91c1c" }}>
              {uiText("مسح الكل", "Clear all", language)}
            </button>
          )}
          {selectedIds.length > 0 && (
            <div style={{ width: "100%", display: "flex", gap: 8, alignItems: "center", marginTop: 4, paddingTop: 10, borderTop: "1px solid #e2e8f0", flexWrap: "wrap" }}>
              <span style={{ color: "#0f172a", fontSize: 13, fontWeight: 700 }}>{uiText(`${selectedIds.length} محدد`, `${selectedIds.length} selected`, language)}</span>
              <ExportButtons columns={gridToExportCols(gridColumns)} rows={selectedRows} filenameBase="journal-entries-selected" title={uiText("القيود المحددة", "Selected journal entries", language)} />
              <button type="button" onClick={() => void handleBulkPost()}
                disabled={bulkBusy || draftSelectedIds.length === 0}
                style={{ ...btnPrimary, background: "#15803d", padding: "7px 14px", borderRadius: 9,
                  opacity: (bulkBusy || draftSelectedIds.length === 0) ? 0.5 : 1,
                  cursor: (bulkBusy || draftSelectedIds.length === 0) ? "not-allowed" : "pointer" }}>
                {bulkBusy ? "..." : uiText(`ترحيل المحدد (${draftSelectedIds.length})`, `Post drafts (${draftSelectedIds.length})`, language)}
              </button>
              <button type="button" onClick={() => void handleBulkUnpost()}
                disabled={bulkBusy || postedSelectedIds.length === 0}
                style={{ ...btnSecondary, padding: "7px 14px", borderRadius: 9, color: "#92400e",
                  opacity: (bulkBusy || postedSelectedIds.length === 0) ? 0.5 : 1,
                  cursor: (bulkBusy || postedSelectedIds.length === 0) ? "not-allowed" : "pointer" }}>
                {bulkBusy ? "..." : uiText(`فك ترحيل (${postedSelectedIds.length})`, `Unpost (${postedSelectedIds.length})`, language)}
              </button>
              <button type="button" onClick={() => void handleBulkDelete()} disabled={bulkBusy}
                style={{ ...btnDanger, padding: "7px 14px", borderRadius: 9, opacity: bulkBusy ? 0.5 : 1 }}>
                {bulkBusy ? "..." : uiText(`حذف المحدد (${selectedIds.length})`, `Delete selected (${selectedIds.length})`, language)}
              </button>
              <button type="button" onClick={() => setSelected(new Set())} disabled={bulkBusy} style={btnLink}>{uiText("إلغاء التحديد", "Clear selection", language)}</button>
            </div>
          )}
        </div>
      </Card>

      {filtered.length > 0 && !form && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.entryNo : null}>
          {(() => {
            const s = sel.selected;
            const rowBusy = !!s && busyId === s.id;
            const manual = !!s && isManual(s);
            return (
              <>
                <ActionBtn label={expandedId === sel.selectedId ? "إخفاء" : "عرض"} icon="▼" disabled={!s || !!form}
                  onClick={() => { if (s) void toggleView(s.id); }} />
                <ActionBtn label="تعديل" icon="✎" disabled={!s || !manual || !!form || rowBusy}
                  onClick={() => { if (s) void openEdit(s.id); }} />
                <ActionBtn label="نسخ" icon="⧉" disabled={!s || !!form || rowBusy}
                  onClick={() => { if (s) void openDuplicate(s.id); }} />
                <ActionBtn label="طباعة" icon="🖨️" tone="primary" disabled={!s || rowBusy}
                  onClick={() => { if (s) void doPrint(s.id); }} />
                <ActionBtn label="ترحيل" icon="✔" tone="success" disabled={!s || !manual || s?.status !== "draft" || rowBusy}
                  onClick={() => { if (s) void doPost(s.id); }} />
                <ActionBtn label="فك ترحيل" icon="↺" tone="warn" disabled={!s || !manual || s?.status !== "posted" || rowBusy}
                  onClick={() => { if (s) void doUnpost(s.id, s.entryNo); }} />
                <ActionBtn label="حذف" icon="🗑" tone="danger" disabled={!s || !manual || rowBusy}
                  onClick={() => { if (s) void doDelete(s.id, s.entryNo); }} />
              </>
            );
          })()}
        </ActionBar>
      )}

      <Card style={{ borderRadius: 14, boxShadow: "0 6px 20px rgba(15,23,42,.05)" }}>
        {filtered.length === 0 ? <Empty text={uiText("لا توجد قيود مطابقة", "No matching entries", language)} /> : (
          <Table>
            <thead><tr>
              <SelectTh />
              <Th style={{ width: 38 }}>
                <input type="checkbox" checked={allSelected} disabled={selectableIds.length === 0}
                  title={uiText("تحديد كل القيود اليدوية", "Select all manual entries", language)} onChange={toggleSelectAll} />
              </Th>
              <SortableTh grid={grid} colKey="entryNo">{uiText("رقم القيد", "Entry no.", language)}</SortableTh>
              <SortableTh grid={grid} colKey="entryDate">{uiText("التاريخ", "Date", language)}</SortableTh>
              <SortableTh grid={grid} colKey="entryType">{uiText("النوع", "Type", language)}</SortableTh>
              <SortableTh grid={grid} colKey="description">{uiText("البيان", "Description", language)}</SortableTh>
              <SortableTh grid={grid} colKey="sourceType">{uiText("المصدر", "Source", language)}</SortableTh>
              <SortableTh grid={grid} colKey="status">{uiText("الحالة", "Status", language)}</SortableTh>
              <SortableTh grid={grid} colKey="totalDebit" style={{ textAlign: "left" }}>{uiText("المدين", "Debit", language)}</SortableTh>
              <SortableTh grid={grid} colKey="totalCredit" style={{ textAlign: "left" }}>{uiText("الدائن", "Credit", language)}</SortableTh>
            </tr>
              <GridFilterRow grid={grid} columns={gridColumns} leading={2} />
            </thead>
            <tbody>
              {(() => {
                let lastMonthKey = "";
                const nodes: React.ReactNode[] = [];
                for (const e of pageRows) {
                  const manual = isManual(e);
                  const rowBusy = busyId === e.id;
                  const mi = monthInfo(e.entryDate);
                  if (mi.key !== lastMonthKey) {
                    lastMonthKey = mi.key;
                    nodes.push(
                      <tr key={`m-${mi.key}`}>
                        <td colSpan={10} style={{
                          borderInlineStart: `4px solid ${mi.accent}`,
                          background: "#f8fafc", padding: "6px 14px",
                          fontSize: 12, fontWeight: 700, color: "#334155",
                          borderTop: "1px solid #e2e8f0",
                        }}>
                          {mi.label}
                        </td>
                      </tr>,
                    );
                  }
                  nodes.push(
                    <React.Fragment key={e.id}>
                      <tr>
                        <SelectCell id={e.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                        <Td style={{ borderInlineStart: `4px solid ${mi.accent}` }}>
                          {manual ? (
                            <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleSel(e.id)} />
                          ) : null}
                        </Td>
                        <Td mono style={{ fontWeight: 600 }}>{e.entryNo}</Td>
                        <Td>{formatUiDate(e.entryDate, language)}</Td>
                        <Td>{ENTRY_TYPE_LABEL[e.entryType]
                          ? uiText(...ENTRY_TYPE_LABEL[e.entryType], language)
                          : e.entryType}</Td>
                        <Td>{e.description ?? "—"}</Td>
                        <Td><SourceTag source={e.sourceType} /></Td>
                        <Td><StatusTag status={e.status} /></Td>
                        <Td num>{fmt(e.totalDebit)}</Td>
                        <Td num>{fmt(e.totalCredit)}</Td>
                      </tr>
                      {expandedId === e.id && (
                        <tr style={{ background: "#f8fafc" }}>
                          <Td colSpan={10 as any}>
                            {!expandedDetail ? <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>... جاري التحميل</div> : (
                              <EntryDetail entry={expandedDetail} />
                            )}
                          </Td>
                        </tr>
                      )}
                    </React.Fragment>,
                  );
                }
                return nodes;
              })()}
            </tbody>
          </Table>
        )}
      </Card>
      {filtered.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
          flexWrap: "wrap", padding: "11px 14px", marginTop: -4, borderRadius: "0 0 12px 12px",
          border: "1px solid #e2e8f0", background: "#f8fafc",
        }}>
            <span style={{ color: "#64748b", fontSize: 12 }}>
              {uiText(
                `عرض ${Math.min((safePage - 1) * pageSize + 1, filtered.length)}–${Math.min(safePage * pageSize, filtered.length)} من ${filtered.length}`,
                `Showing ${Math.min((safePage - 1) * pageSize + 1, filtered.length)}–${Math.min(safePage * pageSize, filtered.length)} of ${filtered.length}`,
                language,
              )}
            </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ color: "#64748b", fontSize: 12 }}>{uiText("صفوف الصفحة", "Rows per page", language)}</label>
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
              style={{ ...input, width: 82, minHeight: 32, padding: "4px 7px", marginBottom: 0, borderRadius: 8 }}>
              {[25, 50, 100, 200].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}
                style={{ ...btnSecondary, minHeight: 32, padding: "5px 11px", borderRadius: 8, opacity: safePage <= 1 ? 0.45 : 1 }}>{uiText("السابق", "Previous", language)}</button>
            <span style={{ minWidth: 82, textAlign: "center", color: "#334155", fontSize: 12, fontWeight: 700 }}>{safePage} / {pageCount}</span>
            <button type="button" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={safePage >= pageCount}
                style={{ ...btnSecondary, minHeight: 32, padding: "5px 11px", borderRadius: 8, opacity: safePage >= pageCount ? 0.45 : 1 }}>{uiText("التالي", "Next", language)}</button>
          </div>
        </div>
      )}
    </Page>
  );
}

function SourceTag({ source }: { source: string | null }) {
  const colors: Record<string, string> = {
    manual: "#475569",
    purchase: "#1e40af",
    purchase_return: "#9a3412",
    receipt: "#15803d",
    payment: "#b91c1c",
  };
  const color = source ? (colors[source] ?? "#64748b") : "#475569";
  return <span style={{ background: color + "20", color, padding: "3px 9px", borderRadius: 999, fontSize: 11, fontWeight: 700 }}>{sourceText(source, getUiLanguage())}</span>;
}

function StatusTag({ status }: { status: JeStatus }) {
  const m = status === "posted" ? { l: "مرحَّل", c: "#15803d" } : { l: "مسودة", c: "#b45309" };
  return <span style={{ background: m.c + "20", color: m.c, padding: "3px 9px", borderRadius: 999, fontSize: 11, fontWeight: 700 }}>{uiText(m.l, status === "posted" ? "Posted" : "Draft", getUiLanguage())}</span>;
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

function JeForm({ accounts, state, navIds, onNavigate, onCancel, onDone }: {
  accounts: Account[]; state: FormState; navIds?: number[];
  onNavigate?: (id: number) => void; onCancel: () => void; onDone: () => void;
}) {
  const language = useUiLanguage();
  const { branches, costCenters } = useDimensions();
  const init = state.initial;
  const isEdit = state.kind === "edit";

  // ── Source-lock: an auto-generated (non-manual) entry must be edited from
  //    its source document. Editing it here would break the link, so we lock
  //    the form read-only and show a banner. (Reachable defensively; the list
  //    only opens manual entries for edit.) Posted manual entries are NOT
  //    locked — offline supports re-posting (reverse + re-apply) — but we show
  //    an informational notice so the user understands the impact on balances.
  const sourceLocked = isEdit && !!init && !isManual(init);
  const postedNotice = isEdit && !!init && init.status === "posted" && !sourceLocked;
  const readOnly = sourceLocked;

  // Prev/next navigation across the current filtered MANUAL entries (edit mode).
  const navList = navIds ?? [];
  const curId = state.kind === "edit" ? state.id : null;
  const curIdx = curId != null ? navList.indexOf(curId) : -1;
  const prevId = curIdx > 0 ? navList[curIdx - 1] : null;
  const nextId = curIdx >= 0 && curIdx < navList.length - 1 ? navList[curIdx + 1] : null;

  const [date, setDate] = useState(isEdit && init ? init.entryDate : todayStr());
  const [desc, setDesc] = useState(init?.description ?? "");
  const [entryType, setEntryType] = useState<JeEntryType>(init?.entryType ?? "general");
  const [docNumber, setDocNumber] = useState(isEdit && init ? init.entryNo : "");
  const [branchId, setBranchId] = useState<number | "">(init?.branchId ?? "");
  const [costCenterId, setCostCenterId] = useState<number | "">(init?.costCenterId ?? "");
  const [autoCopyDesc, setAutoCopyDesc] = useState(true);
  const [vatMode, setVatMode] = useState<"exclusive" | "inclusive">("exclusive");
  const [suggestedNo, setSuggestedNo] = useState("");
  const [activeLine, setActiveLine] = useState<number | null>(null);
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

  // Smart auto-balance: drop the remaining imbalance onto a suitable line so
  // the entry becomes balanced in one click. Prefers an empty-amount line
  // (the active/focused one first, then the first empty), otherwise appends a
  // new line. Idempotent — a no-op when the entry is already balanced.
  function autoBalance() {
    const d = round2(totalDr - totalCr);
    if (Math.abs(d) < 0.001) return; // already balanced → no-op
    const isEmptyAmt = (l: ManualJeLine) => !((Number(l.debit) || 0) > 0) && !((Number(l.credit) || 0) > 0);
    const value = round2(Math.abs(d));
    let targetIdx = (activeLine != null && activeLine >= 0 && activeLine < lines.length && isEmptyAmt(lines[activeLine]))
      ? activeLine
      : lines.findIndex(isEmptyAmt);
    if (targetIdx >= 0) {
      setLine(targetIdx, d < 0 ? { debit: value, credit: 0 } : { credit: value, debit: 0 });
    } else {
      setLines((ls) => [...ls, {
        ...emptyLine(),
        description: desc || null,
        costCenterId: costCenterId === "" ? null : costCenterId,
        ...(d > 0 ? { credit: value } : { debit: value }),
      }]);
    }
  }

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
    if (readOnly) return; // source-locked entries are view-only (defense for keyboard paths)
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
      if (readOnly) return; // source-locked: Esc still closes, all edit shortcuts are inert
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const k = ev.key.toLowerCase();
      if (k === "s" || ev.key === "Enter") { ev.preventDefault(); void save("posted"); }
      else if (k === "d") { ev.preventDefault(); void save("draft"); }
      else if (k === "l") { ev.preventDefault(); addLine(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, readOnly, lines, date, desc, entryType, docNumber, branchId, costCenterId]);

  const title = isEdit ? `تعديل القيد ${init?.entryNo ?? ""}` : state.kind === "duplicate" ? `نسخة من ${init?.entryNo ?? ""}` : "إضافة قيد يومية يدوي";

  const badgeText = isEdit ? (init?.entryNo ?? "") : (docNumber || suggestedNo);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        {badgeText && (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px",
            background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 999,
            color: "#1d4ed8", fontWeight: 700, fontSize: 13, fontFamily: "monospace",
          }} title={isEdit ? "رقم القيد" : "الرقم المقترح"}>
            <span style={{ fontFamily: "inherit" }}>#</span>{badgeText}
            {!isEdit && <span style={{ fontSize: 11, fontWeight: 500, color: "#64748b" }}>مقترح</span>}
          </span>
        )}
        {isEdit && navList.length > 0 && (
          <div style={{ display: "inline-flex", gap: 6, marginInlineStart: "auto", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#64748b" }}>{curIdx >= 0 ? `${curIdx + 1} / ${navList.length}` : ""}</span>
            <button type="button" onClick={() => prevId != null && onNavigate?.(prevId)} disabled={prevId == null}
              style={{ ...btnSecondary, padding: "4px 10px", opacity: prevId == null ? 0.4 : 1, cursor: prevId == null ? "not-allowed" : "pointer" }}>
              ‹ السابق
            </button>
            <button type="button" onClick={() => nextId != null && onNavigate?.(nextId)} disabled={nextId == null}
              style={{ ...btnSecondary, padding: "4px 10px", opacity: nextId == null ? 0.4 : 1, cursor: nextId == null ? "not-allowed" : "pointer" }}>
              التالي ›
            </button>
          </div>
        )}
      </div>

      {sourceLocked && (
        <div style={{
          marginBottom: 12, padding: "10px 14px", borderRadius: 6,
          background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 13,
        }}>
          🔒 هذا القيد تلقائي (مصدره: {init?.sourceType ?? "—"}) ولا يمكن تعديله من هنا. الحقول للعرض فقط — عدّل المستند الأصلي بدلاً من ذلك.
        </div>
      )}
      {postedNotice && (
        <div style={{
          marginBottom: 12, padding: "10px 14px", borderRadius: 6,
          background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 13,
        }}>
          ⚠️ هذا القيد مُرحَّل. أي تعديل ثم حفظ سيُلغي الأثر القديم على الأرصدة ويُعيد تطبيق الأثر الجديد.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "180px 180px 1fr", gap: 10 }}>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="نوع القيد">
          <select value={entryType} onChange={(e) => setEntryType(e.target.value as JeEntryType)} style={input}>
            {ENTRY_TYPES.map((t) => <option key={t.value} value={t.value}>{uiText(t.labelAr, t.labelEn, language)}</option>)}
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
              <Td><input type="number" step="0.01" value={l.debit || ""} disabled={readOnly} onFocus={() => setActiveLine(i)} onChange={(e) => setLine(i, { debit: Number(e.target.value) || 0, credit: 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.credit || ""} disabled={readOnly} onFocus={() => setActiveLine(i)} onChange={(e) => setLine(i, { credit: Number(e.target.value) || 0, debit: 0 })} style={input} /></Td>
              <Td><button onClick={() => removeLine(i)} type="button" disabled={readOnly} style={{ ...btnLink, color: "#dc2626" }}>×</button></Td>
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

      <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={addLine} type="button" disabled={readOnly} style={btnSecondary}>+ سطر</button>
        <button onClick={autoBalance} type="button"
          disabled={readOnly || Math.abs(totalDr - totalCr) < 0.001}
          title="إكمال الموازنة: يضع الفرق في الجانب الفارغ من السطر النشط أو في سطر جديد"
          style={{ ...btnSecondary, opacity: (readOnly || Math.abs(totalDr - totalCr) < 0.001) ? 0.5 : 1 }}>
          ⚖ موازنة تلقائية
        </button>
        {!balanced && totalDr > 0 && Math.abs(totalDr - totalCr) >= 0.001 && (
          <span style={{ marginInlineStart: 12, color: "#dc2626", fontSize: 13 }}>القيد غير متوازن — الفرق {fmt(Math.abs(totalDr - totalCr))}</span>
        )}
      </div>

      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>{readOnly ? "إغلاق (Esc)" : "إلغاء (Esc)"}</button>
        {!readOnly && (
          <>
            <button onClick={() => void save("draft")} disabled={busy} type="button" style={btnDanger}>{busy ? "..." : "حفظ كمسودة (Ctrl+D)"}</button>
            <button onClick={() => void save("posted")} disabled={busy || !balanced} type="button" style={btnPrimary}>{busy ? "..." : "حفظ وترحيل (Ctrl+S)"}</button>
          </>
        )}
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
  const language = getUiLanguage();
  const isEnglish = language === "en";
  const statusLabel = uiText(data.status === "posted" ? "مرحَّل" : "مسودة", data.status === "posted" ? "Posted" : "Draft", language);
  const statusBg = data.status === "posted" ? "#dcfce7" : "#fef9c3";
  const statusColor = data.status === "posted" ? "#166534" : "#854d0e";
  const printedAt = new Date().toLocaleString(isEnglish ? "en-GB" : "ar-SA");
  const typeLabel = ENTRY_TYPE_LABEL[data.entryType]
    ? uiText(...ENTRY_TYPE_LABEL[data.entryType], language)
    : data.entryType;
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
  if (company.cr) metaParts.push(`<span>${uiText("س.ت:", "CR:", language)} ${jeEscapeHtml(company.cr)}</span>`);
  if (company.cr && company.vat) metaParts.push(`<span> • </span>`);
  if (company.vat) metaParts.push(`<span>${uiText("الرقم الضريبي:", "VAT number:", language)} ${jeEscapeHtml(company.vat)}</span>`);
  return `<!DOCTYPE html><html dir="${isEnglish ? "ltr" : "rtl"}" lang="${language}"><head><meta charset="utf-8">
<title>${uiText("قيد يومية", "Journal entry", language)} — ${jeEscapeHtml(data.entryNo)}</title>
<style>
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
body { direction: ${isEnglish ? "ltr" : "rtl"}; font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#0f172a; margin:0; padding:0; }
.je-head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #1e293b; padding-bottom:12px; }
.je-head-r { display:flex; gap:14px; align-items:center; }
.je-logo { max-height:70px; max-width:160px; object-fit:contain; }
.je-co-name { font-size:20px; font-weight:800; margin:0; }
.je-co-meta { font-size:12px; color:#475569; margin-top:4px; }
.je-print-meta { font-size:11px; color:#64748b; text-align:${isEnglish ? "right" : "left"}; }
.je-banner { display:flex; justify-content:space-between; align-items:center; background:#eef2ff; border:1px solid #c7d2fe; border-radius:8px; padding:10px 14px; margin-top:16px; }
.je-docno { font-size:16px; }
.je-docmeta { font-size:12px; color:#475569; margin-top:4px; }
.je-status { font-size:12px; font-weight:700; padding:4px 12px; border-radius:999px; background:${statusBg}; color:${statusColor}; }
.je-desc { font-size:13px; margin-top:12px; }
.je-print-table { width:100%; border-collapse:collapse; margin-top:14px; }
.je-print-table th, .je-print-table td { border:1px solid #94a3b8; padding:7px 10px; font-size:12.5px; }
.je-print-table th { background:#f1f5f9; text-align:${isEnglish ? "left" : "right"}; }
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
        <h1 class="je-co-name">${jeEscapeHtml(company.name || uiText("قيد يومية", "Journal entry", language))}</h1>
        <div class="je-co-meta">${metaParts.join("")}</div>
      </div>
    </div>
    <div class="je-print-meta"><div>${uiText("تاريخ الطباعة", "Printed at", language)}</div><div>${jeEscapeHtml(printedAt)}</div></div>
  </div>

  <div class="je-banner">
    <div>
      <div class="je-docno">${uiText("قيد رقم:", "Entry no.:", language)} <b>${jeEscapeHtml(data.entryNo)}</b></div>
      <div class="je-docmeta">${uiText("التاريخ:", "Date:", language)} ${jeEscapeHtml(formatUiDate(data.entryDate, language))} • ${uiText("النوع:", "Type:", language)} ${jeEscapeHtml(typeLabel)}</div>
    </div>
    <div class="je-status">${statusLabel}</div>
  </div>

  ${data.description ? `<div class="je-desc"><b>${uiText("البيان:", "Description:", language)}</b> ${jeEscapeHtml(data.description)}</div>` : ""}

  <table class="je-print-table">
    <thead>
      <tr>
        <th style="width:38px">${uiText("م", "#", language)}</th>
        <th>${uiText("الحساب", "Account", language)}</th>
        <th>${uiText("الوصف", "Description", language)}</th>
        <th style="width:110px">${uiText("مدين", "Debit", language)}</th>
        <th style="width:110px">${uiText("دائن", "Credit", language)}</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="3">${uiText("الإجمالي", "Total", language)}</td>
        <td class="je-num">${jeEscapeHtml(fmt(data.totalDebit))}</td>
        <td class="je-num">${jeEscapeHtml(fmt(data.totalCredit))}</td>
      </tr>
    </tfoot>
  </table>

  <div class="je-signs">
    <div class="je-sign"><div class="je-sign-line"></div><div class="je-sign-label">${uiText("المحاسب / المُعدّ", "Accountant / Prepared by", language)}</div></div>
    <div class="je-sign"><div class="je-sign-line"></div><div class="je-sign-label">${uiText("المراجع", "Reviewer", language)}</div></div>
    <div class="je-sign"><div class="je-sign-line"></div><div class="je-sign-label">${uiText("المدير المالي / الاعتماد", "Finance manager / Approval", language)}</div></div>
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
  applyNumberSystemToDocument(doc);
  // Wait for the document (incl. the logo image) to finish loading so the
  // letterhead isn't blank, then print. Fall back to a timeout in case the
  // load event never fires inside the embedded webview.
  if (doc.readyState === "complete") setTimeout(run, 200);
  else win.addEventListener("load", () => setTimeout(run, 200), { once: true });
  setTimeout(run, 1200);
}
