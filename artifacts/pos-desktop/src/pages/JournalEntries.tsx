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
import { isTaxEnabledFor, listTaxes, type Tax, type TaxDirection } from "../lib/taxes";
import {
  formatUiDate, getCompanyProfile, getUiLanguage, safeLogoSrc, uiText, useUiLanguage,
  setJournalEntryLayout, useJournalEntryLayout,
  type CompanyProfile, type DocumentEditorLayout, type UiLanguage,
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
const GENERATED_TAX_PREFIXES = ["ضريبة المدخلات", "ضريبة المخرجات", "ضريبة صفرية", VAT_DESC_PREFIX];
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const journalEntryTemplateStyles = `
  .zje-form{height:auto!important;min-height:0!important;overflow:visible!important;display:block!important;--je-accent:#2563eb;--je-panel:#f7faff;--je-border:#cbd8e8;--je-grid:#edf3fb;--je-radius:9px;--je-density:10px;}
  .zje-form .zje-layout-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:8px 0 10px;padding:9px 11px;border:1px solid var(--je-border);border-radius:var(--je-radius);background:var(--je-panel);}
  .zje-form .zje-layout-label{display:flex;flex-direction:column;gap:2px;color:#334155;font-size:12px;font-weight:700;}
  .zje-form .zje-layout-label small{color:#64748b;font-size:10px;font-weight:500;}
  .zje-form .zje-layout-select{min-width:210px;max-width:340px;height:34px;border:1px solid var(--je-border);border-radius:var(--je-radius);background:#fff;color:#0f172a;padding:4px 9px;font:inherit;font-size:12px;}
  .zje-form .zje-section{margin:9px 0;padding:var(--je-density);border:1px solid var(--je-border);border-radius:var(--je-radius);background:var(--je-panel);}
  .zje-form .zje-header-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0 10px;align-items:start;}
  .zje-form .zje-dimension-grid{grid-template-columns:repeat(2,minmax(0,1fr));}
  .zje-form .zje-tax-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:9px 0;padding:8px 10px;border:1px solid var(--je-border);border-radius:var(--je-radius);background:var(--je-panel);}
  .zje-form .zje-lines-wrap{overflow-x:auto;border:1px solid var(--je-border);border-radius:var(--je-radius);background:#fff;}
  .zje-form .zje-lines-wrap table{min-width:850px;}
  .zje-form table.z-admin-table thead th{background:var(--je-grid)!important;color:#334155!important;}
  .zje-form .zje-action-cell{position:relative;overflow:visible!important;text-align:center;white-space:nowrap;}
  .zje-form .zje-tax-popover{position:fixed;z-index:1000;width:278px;max-width:min(278px,80vw);max-height:320px;overflow:auto;padding:10px;border:1px solid var(--je-border);border-radius:10px;background:#fff;color:#1e293b;box-shadow:0 12px 32px #0f172a30;text-align:start;white-space:normal;}
  .zje-form .zje-tax-popover button{width:100%;margin-top:5px;text-align:start;white-space:normal;}
  .zje-form .zje-total-summary{display:flex;align-items:center;justify-content:flex-end;gap:18px;flex-wrap:wrap;margin-top:8px;padding:8px 10px;border-radius:var(--je-radius);background:color-mix(in srgb,var(--je-accent) 8%,white);font-size:13px;font-weight:700;}
  .zje-form[data-layout="classic"]{--je-accent:#2563eb;--je-panel:#fff;--je-border:#d8dee8;--je-grid:#f1f5f9;--je-radius:4px;--je-density:8px;}
  .zje-form[data-layout="quick"]{--je-accent:#087f69;--je-panel:#f5faf6;--je-border:#d2e4d9;--je-grid:#e8f3eb;--je-radius:6px;--je-density:7px;}
  .zje-form[data-layout="modern"]{--je-accent:#c2410c;--je-panel:#fffaf7;--je-border:#f0d5c5;--je-grid:#fff0e7;--je-radius:12px;--je-density:12px;}
  .zje-form[data-layout="modern"] .zje-section{box-shadow:0 2px 8px #7c2d120d;}
  .zje-form[data-layout="erp"]{--je-accent:#294477;--je-panel:#f1f4f8;--je-border:#b9c5d6;--je-grid:#294477;--je-radius:3px;--je-density:6px;}
  .zje-form[data-layout="erp"] table.z-admin-table thead th{color:#fff!important;}
  @media(max-width:1000px){.zje-form .zje-header-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}
  @media(max-width:620px){.zje-form .zje-header-grid,.zje-form .zje-dimension-grid{grid-template-columns:1fr}.zje-form .zje-layout-select{width:100%;max-width:none}}
  @media(max-height:680px){.zje-form .zje-layout-row,.zje-form .zje-section{margin-block:5px;padding:7px;}.zje-form .zje-tax-toolbar{margin-block:5px;padding:6px;}}
`;

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
  const [reference, setReference] = useState(init?.reference ?? "");
  const [entryType, setEntryType] = useState<JeEntryType>(init?.entryType ?? "general");
  const [docNumber, setDocNumber] = useState(isEdit && init ? init.entryNo : "");
  const [branchId, setBranchId] = useState<number | "">(init?.branchId ?? "");
  const [costCenterId, setCostCenterId] = useState<number | "">(init?.costCenterId ?? "");
  const [autoCopyDesc, setAutoCopyDesc] = useState(true);
  const [vatMode, setVatMode] = useState<"exclusive" | "inclusive">("exclusive");
  const [taxPopoverLine, setTaxPopoverLine] = useState<number | null>(null);
  const [taxPopoverPosition, setTaxPopoverPosition] = useState<{ top: number; left: number } | null>(null);
  const [suggestedNo, setSuggestedNo] = useState("");
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const journalLayout = useJournalEntryLayout();
  const [lines, setLines] = useState<ManualJeLine[]>(
    init && init.lines.length
      ? init.lines.map((l) => ({ ...l, id: isEdit ? l.id : undefined }))
      : [emptyLine(), emptyLine()]
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [taxes, setTaxes] = useState<Tax[]>([]);
  const [selectedTaxId, setSelectedTaxId] = useState<number | "">("");
  const [taxesLoading, setTaxesLoading] = useState(true);
  const selectedTax = selectedTaxId === "" ? null : taxes.find((t) => t.id === selectedTaxId) ?? null;
  const vatRate = selectedTax?.rateValue ?? getTaxRate();
  const ratePctLabel = `${fmt(vatRate)}%`;

  function toggleTaxPopover(lineIndex: number, button: HTMLButtonElement) {
    if (taxPopoverLine === lineIndex) {
      setTaxPopoverLine(null);
      return;
    }
    const rect = button.getBoundingClientRect();
    const popoverWidth = Math.min(278, window.innerWidth - 16);
    const popoverHeight = 320;
    setTaxPopoverPosition({
      top: rect.bottom + popoverHeight + 8 <= window.innerHeight
        ? rect.bottom + 4
        : Math.max(8, rect.top - popoverHeight - 4),
      left: Math.min(Math.max(8, rect.right - popoverWidth), window.innerWidth - popoverWidth - 8),
    });
    setTaxPopoverLine(lineIndex);
  }

  useEffect(() => {
    void listTaxes()
      .then((all) => {
        const usable = all.filter(
          (tax) => tax.isActive && tax.rateType === "percent" && (tax.salesEnabled || tax.purchaseEnabled),
        );
        setTaxes(usable);
        const defaultTax = usable.find((tax) => tax.isDefault);
        if (defaultTax) setSelectedTaxId(defaultTax.id);
      })
      .catch((e: unknown) => {
        setErr(errText(e, "تعذر تحميل قائمة الضرائب / Could not load the tax list"));
      })
      .finally(() => setTaxesLoading(false));
  }, []);

  useEffect(() => {
    if (taxPopoverLine == null) return;
    const closeOnViewportChange = () => setTaxPopoverLine(null);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [taxPopoverLine]);

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

  function isVatAccount(accountId: number | null | undefined): boolean {
    if (accountId == null || accountId <= 0) return false;
    const account = accounts.find((a) => a.id === accountId);
    return account?.code === VAT_IN_CODE || account?.code === VAT_OUT_CODE
      || taxes.some((tax) => tax.accountId === accountId);
  }
  function isGeneratedTaxLine(line: ManualJeLine | undefined): boolean {
    const description = (line?.description ?? "").trim();
    return !!line && GENERATED_TAX_PREFIXES.some((prefix) => description.startsWith(prefix));
  }
  function removeLine(i: number) {
    if (lines.length <= 1) return;
    const line = lines[i];
    const nextIsTax = !isGeneratedTaxLine(line) && isGeneratedTaxLine(lines[i + 1]);
    if (isGeneratedTaxLine(line) && i > 0 && (lines[i - 1].description ?? "").includes(NET_MARKER)) {
      const source = lines[i - 1];
      const taxAmount = round2((Number(line.debit) || 0) + (Number(line.credit) || 0));
      const side = (Number(source.debit) || 0) > 0 ? "debit" : "credit";
      setLines((current) => current
        .filter((_, k) => k !== i)
        .map((entry, k) => k === i - 1
          ? { ...entry, [side]: round2((Number(entry[side]) || 0) + taxAmount), description: (entry.description ?? "").replace(NET_MARKER, "").trim() || null }
          : entry));
    } else {
      setLines((current) => {
        const remaining = current.filter((_, k) => k !== i && !(nextIsTax && k === i + 1));
        return remaining.length ? remaining : [emptyLine()];
      });
    }
    setTaxPopoverLine(null);
  }

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
    if (autoCopyDesc) setLines((ls) => ls.map((l) => isGeneratedTaxLine(l) ? l : ({
      ...l, description: `${v}${(l.description ?? "").includes(NET_MARKER) ? NET_MARKER : ""}` || null,
    })));
  }
  function copyDescToLines() {
    setLines((ls) => ls.map((l) => isGeneratedTaxLine(l) ? l : ({
      ...l, description: `${desc}${(l.description ?? "").includes(NET_MARKER) ? NET_MARKER : ""}` || null,
    })));
  }

  function resolveTaxAccount(direction: "input" | "output"): number | null {
    const taxDirection: TaxDirection = direction === "input" ? "purchase" : "sales";
    if (selectedTax && !isTaxEnabledFor(selectedTax, taxDirection)) {
      setErr(uiText(
        direction === "input" ? "الضريبة المختارة غير مفعّلة للمشتريات" : "الضريبة المختارة غير مفعّلة للمبيعات",
        direction === "input" ? "The selected tax is not enabled for purchases" : "The selected tax is not enabled for sales",
        language,
      ));
      return null;
    }
    if (selectedTax?.accountId != null) {
      if (!accounts.some((account) => account.id === selectedTax.accountId)) {
        setErr(uiText("حساب الضريبة المختارة غير موجود في شجرة الحسابات", "The selected tax account is missing from the chart of accounts", language));
        return null;
      }
      return selectedTax.accountId;
    }
    const fallbackCode = direction === "input" ? VAT_IN_CODE : VAT_OUT_CODE;
    const fallbackId = accounts.find((account) => account.code === fallbackCode)?.id;
    if (!fallbackId) {
      setErr(uiText(
        `لا يوجد حساب ضريبة ${direction === "input" ? "المشتريات" : "المبيعات"} — حدّد حسابًا في شاشة الضرائب أو أضف الحساب ${fallbackCode}`,
        `No ${direction === "input" ? "purchase" : "sales"} tax account is configured. Set one in Taxes or add account ${fallbackCode}.`,
        language,
      ));
      return null;
    }
    return fallbackId;
  }

  function applyTaxToLine(direction: "input" | "output", sourceIndex: number, zeroRated = false) {
    if (readOnly) return;
    const source = lines[sourceIndex];
    const side = direction === "input" ? "debit" : "credit";
    const description = (source?.description ?? "").trim();
    const existingTaxIndex = isGeneratedTaxLine(lines[sourceIndex + 1]) ? sourceIndex + 1 : -1;
    const existingTax = existingTaxIndex >= 0 ? lines[existingTaxIndex] : undefined;
    const wasInclusive = description.includes(NET_MARKER);
    if (!source?.accountId || isGeneratedTaxLine(source)) {
      setErr(uiText(
        direction === "input" ? "اختر سطر مشتريات مدينًا صالحًا" : "اختر سطر مبيعات دائنًا صالحًا",
        direction === "input" ? "Choose a valid debit purchase line" : "Choose a valid credit sales line",
        language,
      ));
      return;
    }
    if (wasInclusive && !existingTax) {
      setErr(uiText(
        "تعذر إعادة احتساب السطر الشامل؛ أعد إدخال المبلغ الإجمالي أولاً",
        "This inclusive line has no linked tax line to restore its gross amount; re-enter the gross amount first",
        language,
      ));
      return;
    }
    const previousTaxAmount = wasInclusive
      ? round2((Number(existingTax?.debit) || 0) + (Number(existingTax?.credit) || 0))
      : 0;
    const amount = round2((Number(source[side]) || 0) + previousTaxAmount);
    if (amount <= 0) {
      setErr(uiText(
        direction === "input" ? "اختر سطر مشتريات مدينًا صالحًا" : "اختر سطر مبيعات دائنًا صالحًا",
        direction === "input" ? "Choose a valid debit purchase line" : "Choose a valid credit sales line",
        language,
      ));
      return;
    }
    const accountId = resolveTaxAccount(direction);
    if (accountId == null) return;
    if (source.accountId === accountId) {
      setErr(uiText("لا يمكن احتساب الضريبة على سطر يستخدم حساب الضريبة نفسه", "Tax cannot be calculated on the tax account line", language));
      return;
    }
    const rate = Number(vatRate);
    const taxAmount = zeroRated ? 0 : (vatMode === "inclusive"
      ? round2(amount * rate / (100 + rate))
      : round2(amount * rate / 100));
    if (!zeroRated && taxAmount <= 0) {
      setErr(uiText("نسبة الضريبة صفر؛ استخدم خيار الضريبة الصفرية", "The tax rate is zero; use the zero-rated option", language));
      return;
    }
    const baseDescription = (source.description ?? "").replace(NET_MARKER, "").trim() || null;
    const updatedSource: ManualJeLine = vatMode === "inclusive" && !zeroRated
      ? {
          ...source,
          [side]: round2(amount - taxAmount),
          description: baseDescription ? `${baseDescription}${NET_MARKER}` : NET_MARKER.trim(),
        }
      : { ...source, [side]: amount, description: baseDescription };
    const taxLine: ManualJeLine = {
      ...emptyLine(),
      accountId,
      debit: zeroRated ? 0 : (direction === "input" ? taxAmount : 0),
      credit: zeroRated ? 0 : (direction === "output" ? taxAmount : 0),
      description: zeroRated
        ? `ضريبة صفرية — ${direction === "input" ? "مشتريات / مدخلات" : "مبيعات / مخرجات"} (0%) على ${fmt(amount)}`
        : `${direction === "input" ? "ضريبة المدخلات — مشتريات" : "ضريبة المخرجات — مبيعات"} ${ratePctLabel}${vatMode === "inclusive" ? " (شاملة)" : ""} ${vatMode === "inclusive" ? "من" : "على"} ${fmt(amount)}`,
      costCenterId: null,
    };
    setLines((current) => {
      const next = [...current];
      next[sourceIndex] = updatedSource;
      if (existingTaxIndex >= 0) next[existingTaxIndex] = taxLine;
      else next.splice(sourceIndex + 1, 0, taxLine);
      return next;
    });
    setTaxPopoverLine(null);
    setErr(null);
  }

  function changeVatMode(nextMode: "exclusive" | "inclusive") {
    if (readOnly || taxesLoading || nextMode === vatMode) return;
    if (applyVat(nextMode, true)) setVatMode(nextMode);
  }

  function applyVat(mode: "exclusive" | "inclusive" = vatMode, existingOnly = false): boolean {
    const hasUnlinkedInclusiveLine = lines.some((line, index) =>
      !isGeneratedTaxLine(line)
      && (line.description ?? "").includes(NET_MARKER)
      && !isGeneratedTaxLine(lines[index + 1])
    );
    if (existingOnly && hasUnlinkedInclusiveLine) {
      setErr(uiText(
        "تعذر إعادة احتساب سطر شامل بلا سطر ضريبة مرتبط؛ أعد إدخال المبلغ الإجمالي",
        "An inclusive line has no linked tax row to restore its gross amount; re-enter the gross amount",
        language,
      ));
      return false;
    }
    const hasTaxedLinesToRecalculate = lines.some((line, index) =>
      !isGeneratedTaxLine(line)
      && isGeneratedTaxLine(lines[index + 1])
      && !(lines[index + 1].description ?? "").startsWith("ضريبة صفرية")
    );
    if (existingOnly && !hasTaxedLinesToRecalculate) return true;
    if (!Number.isFinite(vatRate) || vatRate <= 0) {
      setErr(uiText("نسبة الضريبة صفر؛ استخدم الضريبة الصفرية لكل سطر", "Tax rate is zero; use the per-line zero-rated option", language));
      return false;
    }
    const out: ManualJeLine[] = [];
    let applied = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (isGeneratedTaxLine(line)) continue;
      const existingTax = isGeneratedTaxLine(lines[index + 1]) ? lines[index + 1] : undefined;
      if (existingTax && (existingTax.description ?? "").startsWith("ضريبة صفرية")) {
        out.push(line, existingTax);
        index += 1;
        continue;
      }
      const wasInclusive = (line.description ?? "").includes(NET_MARKER);
      if (wasInclusive && !existingTax) {
        setErr(uiText(
          "تعذر إعادة احتساب سطر شامل بلا سطر ضريبة مرتبط؛ أعد إدخال المبلغ الإجمالي",
          "An inclusive line has no linked tax row to restore its gross amount; re-enter the gross amount",
          language,
        ));
        return false;
      }
      if (existingOnly && !existingTax) {
        out.push(line);
        continue;
      }
      const debit = Number(line.debit) || 0;
      const credit = Number(line.credit) || 0;
      if (!line.accountId || isVatAccount(line.accountId) || (debit <= 0 && credit <= 0)) {
        out.push(line);
        if (existingTax) { out.push(existingTax); index += 1; }
        continue;
      }
      const direction = debit > 0 ? "input" : "output";
      const taxAccountId = resolveTaxAccount(direction);
      if (taxAccountId == null) return false;
      if (line.accountId === taxAccountId) {
        out.push(line);
        if (existingTax) { out.push(existingTax); index += 1; }
        continue;
      }
      const side = direction === "input" ? "debit" : "credit";
      const previousTaxAmount = wasInclusive
        ? round2((Number(existingTax?.debit) || 0) + (Number(existingTax?.credit) || 0))
        : 0;
      const amount = round2((direction === "input" ? debit : credit) + previousTaxAmount);
      const taxAmount = mode === "exclusive"
        ? round2(amount * vatRate / 100)
        : round2(amount * vatRate / (100 + vatRate));
      const baseDescription = (line.description ?? "").replace(NET_MARKER, "").trim() || null;
      const source = mode === "inclusive"
        ? {
            ...line,
            [side]: round2(amount - taxAmount),
            description: baseDescription ? `${baseDescription}${NET_MARKER}` : NET_MARKER.trim(),
          }
        : { ...line, [side]: amount, description: baseDescription };
      out.push(source, {
        ...emptyLine(),
        ...(existingTax?.id != null ? { id: existingTax.id } : {}),
        accountId: taxAccountId,
        debit: direction === "input" ? taxAmount : 0,
        credit: direction === "output" ? taxAmount : 0,
        description: `${direction === "input" ? "ضريبة المدخلات — مشتريات" : "ضريبة المخرجات — مبيعات"} ${ratePctLabel}${mode === "inclusive" ? " (شاملة)" : ""} ${mode === "inclusive" ? "من" : "على"} ${fmt(amount)}`,
        costCenterId: null,
      });
      applied += 1;
      if (existingTax) index += 1;
    }
    if (applied === 0) {
      if (existingOnly) return true;
      setErr(uiText("لا توجد سطور مدين أو دائن مؤهلة للضريبة", "No eligible debit or credit lines to tax", language));
      return false;
    }
    setLines(out);
    setTaxPopoverLine(null);
    setErr(null);
    return true;
  }

  function buildPayload(status: JeStatus) {
    const cleaned = lines
      .filter((l) => l.accountId && (
        (Number(l.debit) || 0) > 0
        || (Number(l.credit) || 0) > 0
        || (l.description ?? "").startsWith("ضريبة صفرية")
      ))
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
      reference: reference.trim() || null,
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
      if (ev.key === "Escape") {
        ev.preventDefault();
        if (taxPopoverLine != null) { setTaxPopoverLine(null); return; }
        onCancel();
        return;
      }
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
  }, [busy, readOnly, lines, date, desc, reference, entryType, docNumber, branchId, costCenterId, taxPopoverLine]);

  const title = isEdit ? `تعديل القيد ${init?.entryNo ?? ""}` : state.kind === "duplicate" ? `نسخة من ${init?.entryNo ?? ""}` : "إضافة قيد يومية يدوي";

  const badgeText = isEdit ? (init?.entryNo ?? "") : (docNumber || suggestedNo);

  return (
    <div className="zdoc-form zje-form" data-layout={journalLayout}>
      <style>{journalEntryTemplateStyles}</style>
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

      <div className="zje-layout-row">
        <label className="zje-layout-label">
          {uiText("قالب شاشة القيد", "Journal-entry layout", language)}
          <small>{uiText("حُفظ بشكل مستقل عن قالب فواتير المبيعات", "Saved independently from the sales-invoice layout", language)}</small>
        </label>
        <select className="zje-layout-select" value={journalLayout}
          data-testid="input-journal-entry-layout"
          onChange={(e) => setJournalEntryLayout(e.target.value as DocumentEditorLayout)}>
          <option value="classic">{uiText("كلاسيكي", "Classic", language)}</option>
          <option value="quick">{uiText("سريع", "Quick", language)}</option>
          <option value="modern">{uiText("حديث", "Modern", language)}</option>
          <option value="erp">{uiText("نظام ERP", "ERP", language)}</option>
        </select>
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

      <div className="zje-section zje-header-grid">
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
        <Field label={uiText("المرجع", "Reference", language)}>
          <input value={reference} onChange={(e) => setReference(e.target.value)} style={input}
            data-testid="input-journal-entry-reference"
            placeholder={uiText("رقم المستند أو مرجعه", "Document number or reference", language)} />
        </Field>
      </div>

      <div className="zje-section">
        <Field label="البيان العام"><input value={desc} onChange={(e) => onHeaderDescChange(e.target.value)} style={input} /></Field>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 13, color: "#475569" }}>
          <input type="checkbox" checked={autoCopyDesc} onChange={(e) => setAutoCopyDesc(e.target.checked)} />
          نسخ البيان العام تلقائياً لكل سطر
          <button type="button" onClick={copyDescToLines} style={{ ...btnLink, marginInlineStart: 8 }}>نسخ الآن</button>
        </label>
      </div>

      <div className="zje-section zje-header-grid zje-dimension-grid">
        <Field label="الفرع">
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label="مركز التكلفة (افتراضي للسطور)">
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} options={ccOptions} style={input} />
        </Field>
      </div>

      <div className="zje-tax-toolbar">
        <strong style={{ fontSize: 13 }}>{uiText("الضريبة:", "Tax:", language)}</strong>
        <div data-testid="control-journal-entry-tax-selector">
          <SearchCombobox value={selectedTaxId}
            onChange={(v) => setSelectedTaxId(v === "" ? "" : Number(v))}
            disabled={taxesLoading || readOnly}
            style={{ ...input, width: 290 }}
            options={[
              { value: "", label: uiText(`معدل الإعدادات (${fmt(getTaxRate())}%)`, `Settings rate (${fmt(getTaxRate())}%)`, language) },
              ...taxes.map((tax) => ({
                value: tax.id,
                label: `${tax.code ? `${tax.code} — ` : ""}${tax.nameAr} (${fmt(tax.rateValue)}%)`,
              })),
            ]} />
        </div>
        <span style={{ color: "#64748b", fontSize: 12 }}>
          {selectedTax ? `${selectedTax.nameAr} · ${ratePctLabel}` : `${uiText("معدل الإعدادات", "Settings rate", language)} · ${ratePctLabel}`}
        </span>
        <select value={vatMode} onChange={(e) => changeVatMode(e.target.value as "exclusive" | "inclusive")} disabled={readOnly || taxesLoading} style={{ ...input, width: 260 }}>
          <option value="exclusive">{uiText("غير شامل — تُضاف الضريبة للمبلغ", "Exclusive — add tax to amount", language)}</option>
          <option value="inclusive">{uiText("شامل — المبلغ يتضمن الضريبة", "Inclusive — amount includes tax", language)}</option>
        </select>
        <button type="button" onClick={() => applyVat()} disabled={readOnly || taxesLoading}
          data-testid="button-recalculate-journal-entry-tax" style={btnSecondary}>
          {uiText("إعادة احتساب الضريبة لكل السطور", "Recalculate tax for all lines", language)}
        </button>
      </div>

      <div className="zje-lines-wrap">
        <Table>
          <thead><tr>
            <Th style={{ minWidth: 200 }}>الحساب</Th><Th>البيان</Th><Th style={{ width: 180 }}>مركز التكلفة</Th>
            <Th style={{ width: 120 }}>مدين</Th><Th style={{ width: 120 }}>دائن</Th>
            <Th style={{ width: 58 }}>{uiText("ضريبة", "Tax", language)}</Th><Th style={{ width: 42 }}></Th>
          </tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const isTaxLine = isGeneratedTaxLine(l);
              const isZeroRated = (l.description ?? "").startsWith("ضريبة صفرية");
              return (
                <tr key={i}>
                  <Td>
                    <SearchCombobox value={l.accountId} onChange={(v) => setLine(i, { accountId: Number(v) })} style={input} options={accountOptions} />
                  </Td>
                  <Td><input value={l.description ?? ""} onChange={(e) => setLine(i, { description: e.target.value || null })} style={input} /></Td>
                  <Td>
                    <SearchCombobox value={l.costCenterId ?? ""} onChange={(v) => setLine(i, { costCenterId: v === "" ? null : Number(v) })} style={input} options={ccOptions} />
                  </Td>
                  <Td><input type="number" step="0.01" value={l.debit || (isZeroRated && (l.description ?? "").includes("مشتريات") ? "0.00" : "")} disabled={readOnly} onFocus={() => setActiveLine(i)} onChange={(e) => setLine(i, { debit: Number(e.target.value) || 0, credit: 0 })} style={input} /></Td>
                  <Td><input type="number" step="0.01" value={l.credit || (isZeroRated && (l.description ?? "").includes("مبيعات") ? "0.00" : "")} disabled={readOnly} onFocus={() => setActiveLine(i)} onChange={(e) => setLine(i, { credit: Number(e.target.value) || 0, debit: 0 })} style={input} /></Td>
                  <Td style={{ position: "relative", overflow: "visible", textAlign: "center", whiteSpace: "nowrap" }}>
                    {isTaxLine ? (
                      <span title={uiText("سطر ضريبة", "Tax line", language)} style={{ color: "#64748b", fontSize: 11, fontWeight: 700 }}>
                        {isZeroRated ? "0%" : "%"}
                      </span>
                    ) : (
                      <>
                        <button type="button" disabled={readOnly || taxesLoading}
                          data-testid={`button-journal-line-tax-${i}`}
                          aria-label={uiText("خيارات الضريبة لهذا السطر", "Tax options for this line", language)}
                          aria-expanded={taxPopoverLine === i}
                          onClick={(e) => toggleTaxPopover(i, e.currentTarget)}
                          style={{ ...btnLink, border: "1px solid var(--je-border)", borderRadius: 6, padding: "4px 7px", color: "var(--je-accent)", fontWeight: 800 }}>
                          %
                        </button>
                        {taxPopoverLine === i && (
                          <div className="zje-tax-popover" role="dialog"
                            style={{ top: taxPopoverPosition?.top ?? 8, left: taxPopoverPosition?.left ?? 8 }}
                            aria-label={uiText("خيارات ضريبة السطر", "Line tax options", language)}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                              <strong>{uiText("معالجة الضريبة", "Tax treatment", language)}</strong>
                              <button type="button" onClick={() => setTaxPopoverLine(null)} style={btnLink} aria-label={uiText("إغلاق", "Close", language)}>×</button>
                            </div>
                            <div style={{ margin: "5px 0", color: "#64748b", fontSize: 11 }}>
                              {selectedTax ? `${selectedTax.nameAr} · ${ratePctLabel}` : `${uiText("معدل الإعدادات", "Settings rate", language)} · ${ratePctLabel}`}
                            </div>
                            <label style={{ display: "flex", alignItems: "center", gap: 6, margin: "7px 0", fontSize: 12 }}>
                              <input type="checkbox" checked={vatMode === "inclusive"} disabled={taxesLoading || readOnly} onChange={(e) => changeVatMode(e.target.checked ? "inclusive" : "exclusive")} />
                              {uiText("المبلغ شامل الضريبة", "Amount includes tax", language)}
                            </label>
                            <button type="button" disabled={readOnly || !(Number(l.debit) > 0)}
                              data-testid={`button-journal-purchase-tax-${i}`}
                              onClick={() => applyTaxToLine("input", i)} style={btnSecondary}>
                              {uiText("ضريبة مشتريات / مدخلات", "Purchase / input tax", language)}
                            </button>
                            <button type="button" disabled={readOnly || !(Number(l.debit) > 0)}
                              data-testid={`button-journal-purchase-zero-tax-${i}`}
                              onClick={() => applyTaxToLine("input", i, true)} style={btnSecondary}>
                              {uiText("مشتريات — صفرية 0%", "Purchase — zero-rated 0%", language)}
                            </button>
                            <button type="button" disabled={readOnly || !(Number(l.credit) > 0)}
                              data-testid={`button-journal-sales-tax-${i}`}
                              onClick={() => applyTaxToLine("output", i)} style={btnSecondary}>
                              {uiText("ضريبة مبيعات / مخرجات", "Sales / output tax", language)}
                            </button>
                            <button type="button" disabled={readOnly || !(Number(l.credit) > 0)}
                              data-testid={`button-journal-sales-zero-tax-${i}`}
                              onClick={() => applyTaxToLine("output", i, true)} style={btnSecondary}>
                              {uiText("مبيعات — صفرية 0%", "Sales — zero-rated 0%", language)}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </Td>
                  <Td><button onClick={() => removeLine(i)} type="button" disabled={readOnly} style={{ ...btnLink, color: "#dc2626" }}>×</button></Td>
                </tr>
              );
            })}
            <tr style={{ background: "var(--je-grid)", fontWeight: 700 }}>
              <Td colSpan={3 as any}>الإجمالي</Td>
              <Td num>{fmt(totalDr)}</Td>
              <Td num>{fmt(totalCr)}</Td>
              <Td></Td><Td></Td>
            </tr>
          </tbody>
        </Table>
      </div>

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
      <div class="je-docmeta">${uiText("التاريخ:", "Date:", language)} ${jeEscapeHtml(formatUiDate(data.entryDate, language))} • ${uiText("النوع:", "Type:", language)} ${jeEscapeHtml(typeLabel)}${data.reference ? ` • ${uiText("المرجع:", "Reference:", language)} ${jeEscapeHtml(data.reference)}` : ""}</div>
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
