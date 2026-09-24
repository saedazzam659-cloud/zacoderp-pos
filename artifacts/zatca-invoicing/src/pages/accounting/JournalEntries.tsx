import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useFormatters, fmt2 } from "@/lib/format";
import { safeLogoSrc } from "@/lib/export";
import { buildLetterheadHtml, letterheadCss, wrapWithLetterhead } from "@/lib/printLetterhead";
import {
  buildDetailedJournalPrintHtml,
  type JournalPrintEntry,
  type JournalPrintLabels,
} from "@/lib/journalPrint";
import { useAuth } from "@/contexts/AuthContext";
import { journalEntriesApi } from "@/lib/journalEntriesApi";
import {
  JOURNAL_REGISTER_DEFAULT_PAGE_SIZE,
  JOURNAL_REGISTER_PAGE_SIZES,
  safeJournalRegisterPageSize,
} from "@/lib/journalRegisterPaging";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus, Pencil, Trash2, BookOpen, ArrowUpDown, ArrowUp, ArrowDown, CheckCircle2, FileText, Printer, Copy,
  FileSpreadsheet, FileDown, X, Calendar, Loader2, ChevronDown, Receipt, LayoutGrid, Award, Eye,
  ShieldAlert, Globe2, Monitor, MapPin, User as UserIcon, Clock, RotateCcw,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import * as XLSX from "xlsx";
import { saveWorkbook } from "@/lib/saveFile";
import { cn } from "@/lib/utils";
import {
  downloadCsv, useAuditGridLayout, useColumnResize,
} from "@/lib/auditGridLayout";
import {
  type AdvFilter, isAdvActive, matchAdv, describeAdv,
} from "@/lib/advFilter";
import { AdvFilterPopover } from "@/components/auditGrid/AdvFilterPopover";
import {
  AuditGridBulkBar, AuditGridPagination, ColumnReorderPopover,
  FooterColorPicker, HeaderColorPicker, HeaderSelectCheckbox, RowSelectCheckbox,
} from "@/components/auditGrid/AuditGridControls";
import {
  rowToneFor, SEL_TONE, DocColorLegend, buildToneTooltip, type LegendItem,
} from "@/lib/docRowTone";
import { DateField } from "@/components/ui/date-field";
import { useDemoActionGate } from "@/hooks/use-demo-action-gate";
import { sourceDocumentUrl } from "@/lib/sourceDocumentLinks";

// Maps a journal-entry's `entryType` + resolved `sourceId` to the route of the
// source document that produced it. For sourced entry types we ALWAYS return a
// route — when `sourceId` is missing (older posts that didn't carry a
// docNumber forward, or rows whose source we couldn't resolve) we fall back to
// the source module's list page so the user still lands on the right place
// instead of the journal-entry edit modal. Returns null only for genuinely
// manual / general entries that have no source to drill into.
type ColType = "text" | "num" | "none";
interface ColDef {
  key: string;
  label: string;
  type: ColType;
  valueOf: (e: any, ctx: Ctx) => string | number;
}
interface Ctx { entryTypes: Record<string, string>; statusLabels: Record<string, string>; }

export default function JournalEntries() {
    const gate = useDemoActionGate();
  const { user } = useAuth() as any;
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const ENTRY_TYPES: Record<string, string> = {
    general:      t("journalEntries.typeGeneral"),
    opening:      t("journalEntries.typeOpening"),
    closing:      t("journalEntries.typeClosing"),
    adjustment:   t("journalEntries.typeAdjustment"),
    depreciation: t("journalEntries.typeDepreciation"),
  };
  const STATUS_MAP: Record<string, { label: string; cls: string }> = {
    draft:  { label: t("journalEntries.statusDraft"),  cls: "bg-amber-100 text-amber-800 border-amber-300" },
    posted: { label: t("journalEntries.statusPosted"), cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
    voided: { label: t("journalEntries.statusVoided"), cls: "bg-rose-100 text-rose-800 border-rose-300" },
  };

  // Column descriptors — defined inside the component so we can localize
  // labels via `t()`. They're cheap to recreate per render and keeping them
  // in scope means `valueOf` can close over Arabic translations.
  const COL_DOC_L    = t("journalEntries.docNumber");
  const COL_DATE_L   = t("journalEntries.date");
  const COL_TYPE_L   = t("journalEntries.type");
  const COL_DESC_L   = t("journalEntries.description");
  const COL_DEBIT_L  = t("journalEntries.debit");
  const COL_CREDIT_L = t("journalEntries.credit");
  const COL_STATUS_L = t("journalEntries.status");

  // Memoized on `t`: on data-heavy companies a fresh COLUMNS array every
  // render used to invalidate the `filtered` useMemo below on EVERY render
  // (selection, hover, dialog open …) re-filtering + re-sorting thousands of
  // rows each time — a major source of the perceived hang on this screen.
  const COLUMNS: ColDef[] = useMemo(() => [
    { key: "_sel",   label: "",           type: "none", valueOf: () => "" },
    { key: "_idx",   label: "#",          type: "none", valueOf: () => "" },
    { key: "doc",    label: COL_DOC_L,    type: "text", valueOf: (e) => e.docNumber ?? `QYD-${String(e.id).padStart(4, "0")}` },
    { key: "date",   label: COL_DATE_L,   type: "text", valueOf: (e) => e.entryDate ?? "" },
    { key: "type",   label: COL_TYPE_L,   type: "text", valueOf: (e, c) => c.entryTypes[e.entryType] ?? e.entryType ?? "" },
    { key: "desc",   label: COL_DESC_L,   type: "text", valueOf: (e) => e.description ?? "" },
    { key: "debit",  label: COL_DEBIT_L,  type: "num",  valueOf: (e) => Number(e.totalDebit  ?? 0) },
    { key: "credit", label: COL_CREDIT_L, type: "num",  valueOf: (e) => Number(e.totalCredit ?? 0) },
    { key: "status", label: COL_STATUS_L, type: "text", valueOf: (e, c) => c.statusLabels[e.status] ?? e.status ?? "" },
    // Audit columns — show who created and who posted each entry. Pure
    // display columns, populated by the LIST endpoint via a username join;
    // older rows that pre-date the audit columns render an em-dash.
    { key: "createdBy", label: t("journalEntries.createdBy", { defaultValue: "أنشأه" }),
      type: "text", valueOf: (e) => e.createdByName ?? "—" },
    { key: "postedBy",  label: t("journalEntries.postedBy",  { defaultValue: "رحّله" }),
      type: "text", valueOf: (e) => e.postedByName  ?? "—" },
    { key: "_act",   label: t("journalEntries.actions"), type: "none", valueOf: () => "" },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t]);
  const DATA_KEYS = useMemo(() => COLUMNS.filter(c => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map(c => c.key), [COLUMNS]);
  const ALL_KEYS  = useMemo(() => COLUMNS.map(c => c.key), [COLUMNS]);

  const ctx: Ctx = useMemo(() => ({
    entryTypes: ENTRY_TYPES,
    statusLabels: Object.fromEntries(Object.entries(STATUS_MAP).map(([k, v]) => [k, v.label])),
  }), [t]);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "posted" | "voided">("all");
  // Date-range filter (inclusive). Compared against `entryDate` in the
  // entries list, which is stored as YYYY-MM-DD so plain string compare is
  // safe and avoids any timezone shifting issues.
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const applyDatePreset = (preset: "today" | "week" | "month" | "year") => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const todayStr = fmt(now);
    if (preset === "today") {
      setDateFrom(todayStr);
      setDateTo(todayStr);
    } else if (preset === "week") {
      const start = new Date(now);
      start.setDate(now.getDate() - 6);
      setDateFrom(fmt(start));
      setDateTo(todayStr);
    } else if (preset === "month") {
      setDateFrom(fmt(new Date(now.getFullYear(), now.getMonth(), 1)));
      setDateTo(todayStr);
    } else if (preset === "year") {
      setDateFrom(fmt(new Date(now.getFullYear(), 0, 1)));
      setDateTo(todayStr);
    }
  };
  const clearDateRange = () => { setDateFrom(""); setDateTo(""); };

  /* ── Month color accent ────────────────────────────────────────────────
     A subtle 4px coloured border on the leading edge of each row, keyed
     to the month of `entryDate`. Lets the eye group entries by month at
     a glance without competing with the status-tone background or the
     selection highlight. Twelve hand-picked Tailwind tones that read well
     against both the slate body and amber/blue row tints. */
  const MONTH_BORDERS: Record<number, string> = {
    1:  "border-s-4 border-s-rose-400",      // يناير
    2:  "border-s-4 border-s-pink-400",      // فبراير
    3:  "border-s-4 border-s-fuchsia-400",   // مارس
    4:  "border-s-4 border-s-purple-400",    // أبريل
    5:  "border-s-4 border-s-violet-400",    // مايو
    6:  "border-s-4 border-s-indigo-400",    // يونيو
    7:  "border-s-4 border-s-blue-400",      // يوليو
    8:  "border-s-4 border-s-sky-400",       // أغسطس
    9:  "border-s-4 border-s-teal-400",      // سبتمبر
    10: "border-s-4 border-s-emerald-400",   // أكتوبر
    11: "border-s-4 border-s-amber-500",     // نوفمبر
    12: "border-s-4 border-s-orange-500",    // ديسمبر
  };
  const MONTH_NAMES_AR: Record<number, string> = {
    1: "يناير", 2: "فبراير", 3: "مارس", 4: "أبريل", 5: "مايو", 6: "يونيو",
    7: "يوليو", 8: "أغسطس", 9: "سبتمبر", 10: "أكتوبر", 11: "نوفمبر", 12: "ديسمبر",
  };
  const monthAccentFor = (entryDate: string | null | undefined): string => {
    const m = String(entryDate ?? "").match(/^(\d{4})-(\d{2})/);
    if (!m) return "";
    const month = Number(m[2]);
    return MONTH_BORDERS[month] ?? "";
  };

  const [deleteId, setDeleteId] = useState<number | null>(null);
  // Convert-to-general dialog: rescues an ORPHANED locked entry (its source
  // document was deleted) into a general draft, keeping the document number so
  // the numbering sequence stays gap-free. Only shown for `isOrphanLocked` rows.
  const [convertId, setConvertId] = useState<number | null>(null);
  // Manager-only forensic audit dialog. The eye button is rendered only for
  // admin/superadmin roles; the server enforces the same check on /audit so
  // even crafted requests can't leak IPs to non-managers.
  const isManager = user?.role === "admin" || user?.role === "superadmin";
  const [auditId, setAuditId] = useState<number | null>(null);
  const auditQuery = useQuery({
    queryKey: ["journal-audit", auditId],
    queryFn:  () => journalEntriesApi.audit(auditId!),
    enabled:  auditId !== null,
    staleTime: 30_000,
  });

  /* ── Per-column sort (cycles asc → desc → none on header click) ─────────
     Persisted per-tenant in localStorage so the chosen column + direction
     survives page refreshes, navigation away, and re-opening the screen.
     Key mirrors the auditGridLayout pattern: `<screenSlug>.sort.v1.c<cid>`. */
  const SORT_LS_KEY = `journalEntriesAuditGrid.sort.v1.c${cid ?? "anon"}`;
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(() => {
    try {
      const raw = localStorage.getItem(SORT_LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.key === "string" && (parsed.dir === "asc" || parsed.dir === "desc")) {
        return { key: parsed.key, dir: parsed.dir };
      }
    } catch { /* ignore corrupt LS */ }
    return null;
  });
  // Persist on change; remove the key entirely when sort is cleared so the
  // grid returns to its natural (server) order on next visit.
  useEffect(() => {
    try {
      if (sort) localStorage.setItem(SORT_LS_KEY, JSON.stringify(sort));
      else      localStorage.removeItem(SORT_LS_KEY);
    } catch { /* ignore quota */ }
  }, [sort, SORT_LS_KEY]);
  // Re-hydrate when tenant changes — different companies should have their
  // own preferred sort (matches how layout/colWidths/etc. behave).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SORT_LS_KEY);
      if (!raw) { setSort(null); return; }
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.key === "string" && (parsed.dir === "asc" || parsed.dir === "desc")) {
        setSort({ key: parsed.key, dir: parsed.dir });
      } else {
        setSort(null);
      }
    } catch { setSort(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);
  const cycleSort = (key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc")        return { key, dir: "desc" };
      return null;
    });
  };

  const layout = useAuditGridLayout({
    screenSlug: "journalEntriesAuditGrid",
    cid,
    dataKeys: DATA_KEYS,
    allColKeys: ALL_KEYS,
  });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);

  const { pageSize, page, setPage, setPageSize } = layout;
  const deferredSearch = useDeferredValue(search);
  // A legacy shared-grid preference can still contain `0 = show all`. Keep
  // the very first render bounded, then migrate that preference so it cannot
  // freeze the browser again on the next visit.
  const serverLimit = safeJournalRegisterPageSize(pageSize);
  useEffect(() => {
    if (pageSize === 0) setPageSize(JOURNAL_REGISTER_DEFAULT_PAGE_SIZE);
  }, [pageSize, setPageSize]);
  const pageQuery = useQuery({
    queryKey: ["journal-entries", cid, page, serverLimit, deferredSearch, statusFilter, dateFrom, dateTo, sort],
    queryFn: () => journalEntriesApi.listPage({
      cid,
      page,
      limit: serverLimit,
      q: deferredSearch.trim(),
      status: statusFilter,
      dateFrom,
      dateTo,
      sortKey: sort?.key,
      sortDir: sort?.dir,
    }),
    enabled: !!user,
    placeholderData: (previous) => previous,
  });
  const entries = pageQuery.data?.items ?? [];
  const isLoading = pageQuery.isLoading;
  const serverTotal = pageQuery.data?.total ?? 0;
  const serverTotals = pageQuery.data?.totals ?? { debit: 0, credit: 0 };
  const allTotals = pageQuery.data?.allTotals ?? { debit: 0, credit: 0, count: 0 };

  // Used only by detailed bulk-print to label account ids. Fetch through the
  // query cache on demand instead of downloading the whole COA on page open.
  const API_URL = (import.meta as any).env?.VITE_API_URL ?? "";
  const buildAuthHeaders = (): Record<string, string> => {
    const token = localStorage.getItem("zatca_token");
    return token
      ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
      : { "Content-Type": "application/json" };
  };
  const fetchAccountsList = () => qc.fetchQuery<any[]>({
    queryKey: ["accounts-flat", cid],
    queryFn: async () => {
      const url = cid ? `${API_URL}/api/accounts?companyId=${cid}` : `${API_URL}/api/accounts`;
      const res = await fetch(url, { headers: buildAuthHeaders() });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => journalEntriesApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal-entries", cid] });
      setDeleteId(null);
    },
  });

  /* ── Gap-fill (استرجاع رقم قيد محذوف) ────────────────────────────────
     Re-creates a DELETED journal-entry number as an empty DRAFT, filling
     the gap in the numbering. Server bypasses the sequence engine, rejects
     numbers already in use (409), and always lands the entry as draft. */
  const [gapFillOpen, setGapFillOpen] = useState(false);
  const [gapFillNumber, setGapFillNumber] = useState("");
  const [gapFillDate, setGapFillDate] = useState("");
  // ── Gap-scan (فحص النواقص): pick a date range → server lists every missing
  //    serial number in that range so the user can re-create them one by one.
  const [gapScanFrom, setGapScanFrom] = useState("");
  const [gapScanTo, setGapScanTo] = useState("");
  const [gapScanResult, setGapScanResult] = useState<import("../../lib/journalEntriesApi").GapScanResponse | null>(null);
  const [gapScanLoading, setGapScanLoading] = useState(false);
  const [gapScanError, setGapScanError] = useState<string | null>(null);
  const runGapScan = async () => {
    if (!gapScanFrom || !gapScanTo) return;
    setGapScanLoading(true);
    setGapScanError(null);
    setGapScanResult(null);
    try {
      setGapScanResult(await journalEntriesApi.gapScan(gapScanFrom, gapScanTo, cid ?? undefined));
    } catch (e: any) {
      setGapScanError(e?.message || "تعذّر فحص النواقص");
    } finally {
      setGapScanLoading(false);
    }
  };
  const gapFillMutation = useMutation({
    mutationFn: () => journalEntriesApi.create({
      gapFill:   true,
      docNumber: gapFillNumber.trim(),
      entryDate: gapFillDate,
      entryType: "general",
      lines:     [],
    }),
    onSuccess: (_data, _vars) => {
      qc.invalidateQueries({ queryKey: ["journal-entries", cid] });
      const created = gapFillNumber.trim();
      // If the user is working from a scan-result list, keep the dialog open
      // and just drop the created number from the list so they can continue
      // filling the remaining gaps one by one.
      if (gapScanResult && gapScanResult.missing.some((m) => m.docNumber === created)) {
        setGapScanResult({
          ...gapScanResult,
          missing: gapScanResult.missing.filter((m) => m.docNumber !== created),
        });
        setGapFillNumber("");
        setGapFillDate("");
      } else {
        setGapFillOpen(false);
        setGapFillNumber("");
        setGapFillDate("");
      }
    },
    onError: (e: any) => {
      alert(e?.message || "تعذّر إنشاء القيد");
    },
  });

  const convertMutation = useMutation({
    mutationFn: (id: number) => journalEntriesApi.convertToGeneral(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal-entries", cid] });
      setConvertId(null);
    },
    onError: (e: any) => {
      alert(e?.message || "تعذّر تحويل القيد");
      setConvertId(null);
    },
  });

  /* ── Bulk-action helpers ─────────────────────────────────────────────── */
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // Entry deletes are subject to multiple server-side guards (already-posted,
  // referenced from a source doc, period-locked). We run them sequentially and
  // surface a per-row failure summary so the user knows which rows survived.
  async function bulkRun(
    ids: number[],
    fn: (id: number) => Promise<any>,
  ): Promise<{ ok: number; failures: string[] }> {
    setBulkBusy(true);
    let ok = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try { await fn(id); ok++; } catch (e: any) { failures.push(e?.message || String(e)); }
    }
    setBulkBusy(false);
    qc.invalidateQueries({ queryKey: ["journal-entries", cid] });
    layout.clearSelection();
    return { ok, failures };
  }

  const selectedIds = useMemo(
    () => Array.from(layout.selected).map((x) => Number(x)).filter((n) => Number.isFinite(n)),
    [layout.selected],
  );

  // Subset of selectedIds whose status is currently "draft" — only those rows
  // can actually be posted. We compute it here so the bulk-post button shows
  // the *real* count it will operate on (e.g. "ترحيل (3)" out of 5 selected).
  const draftSelectedIds = useMemo(() => {
    const idSet = new Set(selectedIds);
    return (entries as any[])
      .filter((e: any) => idSet.has(e.id) && e.status === "draft")
      .map((e: any) => e.id as number);
  }, [selectedIds, entries]);

  // Subset of selectedIds whose status is currently "posted" — only those rows
  // can actually be UN-posted (فك الترحيل). Mirror of draftSelectedIds so the
  // bulk-unpost button shows the real count it will operate on.
  const postedSelectedIds = useMemo(() => {
    const idSet = new Set(selectedIds);
    return (entries as any[])
      .filter((e: any) => idSet.has(e.id) && e.status === "posted")
      .map((e: any) => e.id as number);
  }, [selectedIds, entries]);

  /* ── Bulk UNPOST handler — flips every selected POSTED entry back to draft.
        Server-side guards stay authoritative: locked source-doc JEs
        (LOCKED_ENTRY_TYPES), FA-linked entries and closed-period entries are
        rejected per-row and surface in the failure summary. ────────────── */
  async function handleBulkUnpost() {
    if (postedSelectedIds.length === 0) return;
    if (!window.confirm(
      `سيتم فك ترحيل ${postedSelectedIds.length} قيد — ستتحول إلى مسودة ويُلغى أثرها من كل التقارير حتى يُعاد ترحيلها. متابعة؟`
    )) return;
    const { ok, failures } = await bulkRun(
      postedSelectedIds,
      async (id) => { await journalEntriesApi.unpost(id); },
    );
    if (failures.length > 0) {
      const periodLocked = failures.filter((m) =>
        m.includes("مقفلة") || m.includes("مغلقة")
      );
      if (periodLocked.length === failures.length) {
        window.alert(
          `لا يمكن فك الترحيل في فترة مقفلة\n\n` +
          `تم فك ترحيل ${ok} من ${postedSelectedIds.length} قيد. ` +
          `${failures.length} قيد بتاريخ يقع داخل فترة مالية مقفلة.\n\n` +
          `افتح "الفترات المالية" وأعد فتح الفترة المعنيّة، ثم أعد المحاولة.`
        );
      } else {
        window.alert(
          `فك ترحيل القيود: ${ok}/${postedSelectedIds.length}\n` +
          `${failures.length} قيد فشل (قيود مصدرها مستند أو مرتبطة بأصل ثابت تُفك من شاشتها الأصلية):\n• ${failures.slice(0, 5).join("\n• ")}`,
        );
      }
    } else if (ok > 0) {
      window.alert(`تم فك ترحيل ${ok} قيد بنجاح`);
    }
  }

  /* ── Bulk post handler — flips every selected DRAFT entry to "posted".
        Server enforces balance, auto-lock and period guards so failures
        surface in the per-row failure summary. ──────────────────────── */
  async function handleBulkPost() {
    if (draftSelectedIds.length === 0) return;
    if (!window.confirm(`سيتم ترحيل ${draftSelectedIds.length} قيد. متابعة؟`)) return;
    const { ok, failures } = await bulkRun(
      draftSelectedIds,
      async (id) => { await journalEntriesApi.post(id); },
    );
    if (failures.length > 0) {
      // If every failure was a closed-period block, lead with the friendly
      // headline so the user immediately understands the cause and the fix
      // (re-open the fiscal period). Otherwise fall back to the generic list.
      const periodLocked = failures.filter((m) =>
        m.includes("لا يمكن الترحيل في فترة مقفلة") ||
        m.includes("مقفلة") || m.includes("مغلقة")
      );
      if (periodLocked.length === failures.length) {
        window.alert(
          `لا يمكن الترحيل في فترة مقفلة\n\n` +
          `تم ترحيل ${ok} من ${draftSelectedIds.length} قيد. ` +
          `${failures.length} قيد بتاريخ يقع داخل فترة مالية مقفلة (إقفال ناعم أو نهائي).\n\n` +
          `للترحيل: افتح "الفترات المالية" وأعد فتح الفترة المعنيّة، ثم أعد المحاولة.`
        );
      } else {
        window.alert(
          `ترحيل القيود: ${ok}/${draftSelectedIds.length}\n` +
          `${failures.length} قيد فشل:\n• ${failures.slice(0, 5).join("\n• ")}`,
        );
      }
    } else if (ok > 0) {
      window.alert(`تم ترحيل ${ok} قيد بنجاح`);
    }
  }

  async function confirmBulkDelete() {
    setBulkDeleteOpen(false);
    if (selectedIds.length === 0) return;
    const { ok, failures } = await bulkRun(
      selectedIds,
      async (id) => { await journalEntriesApi.remove(id); },
    );
    // Lightweight in-app feedback — the page already lacks a toast hook here,
    // so we surface the result via a non-blocking alert when something failed.
    if (failures.length > 0) {
      window.alert(
        `${t("journalEntries.delete")}: ${ok}/${selectedIds.length}\n` +
        `${failures.length} عنصر فشل:\n• ${failures.slice(0, 5).join("\n• ")}`,
      );
    }
  }

  // Per-column advanced filter (two conditions joined by AND/OR) — shared
  // primitives in lib/advFilter.ts + components/auditGrid/AdvFilterPopover.
  // Declared BEFORE the filter useMemo so the captured `colAdv` is initialised
  // by the time React runs the memo callback on first render (avoids TDZ).
  const [colAdv, setColAdv] = useState<Record<string, AdvFilter>>({});
  const clearColAdv = (key: string) =>
    setColAdv(prev => { const n = { ...prev }; delete n[key]; return n; });
  const clearAllColFilters = () => { clearColFilters(); setColAdv({}); };

  /* ── Filtering ── */
  // Basic filters and sort are applied by the paged endpoint. Advanced
  // per-column filters deliberately remain client-side because they are rich
  // display filters and apply to the currently loaded server page.
  const filtered = useMemo(() => {
    const rows = (entries as any[]).filter((e) => {
      for (const col of COLUMNS) {
        const adv = colAdv[col.key];
        if (!isAdvActive(adv)) continue;
        if (!matchAdv(col.valueOf(e, ctx), adv, col.type)) return false;
      }
      return true;
    });

    return rows;
  }, [entries, colAdv, ctx, COLUMNS]);

  /* ── Pagination ── */
  const totalPages = Math.max(1, Math.ceil(serverTotal / serverLimit));
  const safePage = Math.min(page, totalPages);
  useEffect(() => {
    if (safePage !== page) setPage(safePage);
  }, [safePage, page, setPage]);
  useEffect(() => {
    setPage(1);
  }, [deferredSearch, statusFilter, dateFrom, dateTo, sort?.key, sort?.dir, pageSize, setPage]);
  const paged = filtered;
  const pageStart = serverTotal === 0 ? 0 : (safePage - 1) * serverLimit + 1;
  const pageEnd = Math.min((safePage - 1) * serverLimit + entries.length, serverTotal);

  // Endpoint totals reflect the active basic filters; advanced column filters
  // are intentionally page-local, so use visible-row totals only when one is
  // active.
  const hasAdvancedFilters = Object.values(colAdv).some(isAdvActive);
  const totals = hasAdvancedFilters
    ? filtered.reduce((a, e: any) => ({
        debit: a.debit + Number(e.totalDebit ?? 0),
        credit: a.credit + Number(e.totalCredit ?? 0),
      }), { debit: 0, credit: 0 })
    : serverTotals;
  const totalDebitAll = allTotals.debit;
  const totalCreditAll = allTotals.credit;

  /* ── Visible columns in user's saved order ── */
  const visibleColumns = useMemo(() => {
    const dataCols = layout.dataOrder
      .map((k) => COLUMNS.find((c) => c.key === k))
      .filter((c): c is ColDef => !!c)
      .filter((c) => !layout.hiddenSet.has(c.key));
    const sel = COLUMNS.find((c) => c.key === "_sel")!;
    const idx = COLUMNS.find((c) => c.key === "_idx")!;
    const act = COLUMNS.find((c) => c.key === "_act")!;
    return [sel, idx, ...dataCols, act];
  }, [layout.dataOrder, layout.hiddenSet, COLUMNS]);
  const reorderableCols = useMemo(
    () => DATA_KEYS.map((k) => COLUMNS.find((c) => c.key === k)!).map((c) => ({ key: c.key, label: c.label })),
    [DATA_KEYS, COLUMNS],
  );

  /* ── Existing exports (kept verbatim so PDF / print look identical) ── */
  // Exports are requested on demand instead of retaining every register row
  // in the list query. The endpoint may cap a request, so continue until its
  // reported total has been collected.
  const fetchExportRows = async (): Promise<any[]> => {
    const limit = 250;
    const first = await journalEntriesApi.listPage({
      cid, page: 1, limit, q: deferredSearch.trim(), status: statusFilter,
      dateFrom, dateTo, sortKey: sort?.key, sortDir: sort?.dir,
    });
    const all = [...first.items];
    for (let nextPage = 2; all.length < first.total; nextPage++) {
      const next = await journalEntriesApi.listPage({
        cid, page: nextPage, limit, q: deferredSearch.trim(), status: statusFilter,
        dateFrom, dateTo, sortKey: sort?.key, sortDir: sort?.dir,
      });
      if (next.items.length === 0) break;
      all.push(...next.items);
    }
    return hasAdvancedFilters
      ? all.filter((e) => COLUMNS.every((col) => {
          const adv = colAdv[col.key];
          return !isAdvActive(adv) || matchAdv(col.valueOf(e, ctx), adv, col.type);
        }))
      : all;
  };
  const buildRows = (source: any[] = filtered) => source.map((e: any) => ({
    [COL_DOC_L]:    e.docNumber ?? `QYD-${String(e.id).padStart(4, "0")}`,
    [COL_DATE_L]:   e.entryDate ?? "",
    [COL_TYPE_L]:   ENTRY_TYPES[e.entryType] ?? e.entryType ?? "",
    [COL_DESC_L]:   e.description ?? "",
    [COL_DEBIT_L]:  Number(e.totalDebit  ?? 0).toFixed(2),
    [COL_CREDIT_L]: Number(e.totalCredit ?? 0).toFixed(2),
    [COL_STATUS_L]: (STATUS_MAP[e.status] ?? STATUS_MAP.posted).label,
  }));

  const handleExportExcel = async () => {
      if (!(await gate('export'))) return;
    const rows = buildRows(await fetchExportRows());
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 32 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, t("journalEntries.title"));
    void saveWorkbook(wb, `journal-entries-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const escapeHtml = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

  const buildPrintHtml = (source: any[] = filtered) => {
    const rows = buildRows(source);
    const totalDebitOfRows  = source.reduce((s: number, e: any) => s + Number(e.totalDebit  ?? 0), 0);
    const totalCreditOfRows = source.reduce((s: number, e: any) => s + Number(e.totalCredit ?? 0), 0);
    const cols = Object.keys(rows[0] ?? { [COL_DOC_L]: "", [COL_DATE_L]: "", [COL_TYPE_L]: "", [COL_DESC_L]: "", [COL_DEBIT_L]: "", [COL_CREDIT_L]: "", [COL_STATUS_L]: "" });
    const today = new Date().toLocaleDateString(isRtl ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB");
    const dir = isRtl ? "rtl" : "ltr";
    const lang = isRtl ? "ar" : "en";
    const align = isRtl ? "right" : "left";
    const letterhead = buildLetterheadHtml(user?.company as any, { accent: "navy", size: "md" });
    return `<!DOCTYPE html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(t("journalEntries.printSheetTitle"))}</title>
<style>
@page { size: A4 landscape; margin: 12mm 12mm 22mm 12mm; @bottom-center { content: "صفحة " counter(page) " من " counter(pages); font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; font-size: 9pt; color: #475569; } }
@media print { thead { display: table-header-group; } }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; padding:0; }
${letterheadCss({ accent: "navy", size: "md" })}
.h { text-align:center; margin-bottom:8px; }
.h h1 { margin:0 0 4px; font-size:18px; }
.h .meta { font-size:11px; color:#555; }
.totals { display:flex; gap:16px; justify-content:center; margin:8px 0 12px; font-size:12px; }
.totals span b { color:#1e3a8a; }
table { width:100%; border-collapse:collapse; font-size:11px; }
thead th { background:#1e3a8a; color:#fff; padding:6px 8px; border:1px solid #1e3a8a; text-align:${align}; font-weight:600; }
tbody td { padding:5px 8px; border:1px solid #d1d5db; text-align:${align}; }
tbody tr:nth-child(even) td { background:#f5f7fb; }
.num { font-family: "Consolas",monospace; }
.print-btn { position:fixed; top:10px; ${isRtl ? "left" : "right"}:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">${escapeHtml(t("journalEntries.printPdf"))}</button>
${wrapWithLetterhead(`${letterhead}<div class="h"><h1>${escapeHtml(t("journalEntries.printSheetTitle"))}</h1>
<div class="meta">${escapeHtml(t("journalEntries.reportDate"))}: ${today} — ${escapeHtml(t("journalEntries.entriesCount", { count: rows.length }))}</div></div>`, `<div class="totals">
  <span>${escapeHtml(t("journalEntries.totalDebit"))}: <b>${fmt2(totalDebitOfRows)}</b></span>
  <span>${escapeHtml(t("journalEntries.totalCredit"))}: <b>${fmt2(totalCreditOfRows)}</b></span>
</div>
<table><thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
<tbody>${rows.map(r => `<tr>${cols.map(c => {
      const isNum = c === COL_DEBIT_L || c === COL_CREDIT_L;
      return `<td class="${isNum ? "num" : ""}">${escapeHtml((r as any)[c])}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table>`)}
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
  };

  const writePrintWindow = (w: Window, html: string) => {
    w.document.open(); w.document.write(html); w.document.close();
  };
  const openPrintWindow = (html: string) => {
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) return;
    writePrintWindow(w, html);
  };

  const openAsyncRegisterPrint = () => {
    // Open synchronously from the click gesture or Chrome treats the later
    // window.open (after fetching all filtered pages) as a blocked popup.
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) return;
    writePrintWindow(w, `<!doctype html><html dir="${isRtl ? "rtl" : "ltr"}"><body style="font-family:Tahoma;padding:24px">جاري تجهيز التقرير...</body></html>`);
    void fetchExportRows()
      .then((rows) => writePrintWindow(w, buildPrintHtml(rows)))
      .catch((error) => writePrintWindow(w, `<!doctype html><html dir="rtl"><body style="font-family:Tahoma;padding:24px;color:#991b1b">${escapeHtml(error?.message ?? "تعذر تجهيز التقرير")}</body></html>`));
  };
  const handleExportPDF = openAsyncRegisterPrint;
  const handlePrint = openAsyncRegisterPrint;

  /* ── Bulk print: render each selected entry as a full journal-entry sheet
        (header + every debit/credit line), not just a one-row summary. ─── */
  const [bulkPrintBusy, setBulkPrintBusy] = useState(false);
  // When true, the "detailed" / "professional" templates inject a hard
  // page-break between every entry so each printed sheet contains exactly
  // one journal entry — useful for archiving / signing one entry per page.
  // Persisted to localStorage so the user's choice sticks across sessions.
  const [oneEntryPerPage, setOneEntryPerPage] = useState<boolean>(() => {
    try { return localStorage.getItem("zatca_je_one_per_page") === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("zatca_je_one_per_page", oneEntryPerPage ? "1" : "0"); }
    catch { /* ignore quota / private mode */ }
  }, [oneEntryPerPage]);
  // Thin wrapper around the SHARED detailed template (lib/journalPrint.ts).
  // The journal-entry FORM's "طباعة" button uses the exact same builder, so
  // both paths always print identical sheets. This wrapper only resolves
  // screen-local data (account labels, type/status labels) into plain strings.
  const journalPrintLabels = (): JournalPrintLabels => ({
    sheetTitle: t("journalEntries.printSheetTitle"),
    doc:        COL_DOC_L,
    date:       COL_DATE_L,
    type:       COL_TYPE_L,
    desc:       COL_DESC_L,
    debit:      COL_DEBIT_L,
    credit:     COL_CREDIT_L,
    status:     COL_STATUS_L,
    account:    isRtl ? "الحساب" : "Account",
    lineDesc:   isRtl ? "البيان"  : "Description",
    costCenter: isRtl ? "مركز التكلفة" : "Cost Center",
    lineNo:     isRtl ? "م" : "#",
    subtotal:   isRtl ? "الإجمالي" : "Subtotal",
    noLines:    isRtl ? "لا توجد أطراف لهذا القيد." : "No lines for this entry.",
    grandTotal: isRtl ? "الإجمالي العام" : "Grand Total",
    totalDebit:  t("journalEntries.totalDebit"),
    totalCredit: t("journalEntries.totalCredit"),
    printBtn:    t("journalEntries.printPdf"),
  });

  const buildBulkPrintHtml = (
    entriesWithLines: any[],
    opts?: { oneEntryPerPage?: boolean },
    accountsList: any[] = [],
  ) => {
    const acctMap = new Map<number, any>(accountsList.map((a: any) => [a.id, a]));
    const printEntries: JournalPrintEntry[] = entriesWithLines.map((e: any) => ({
      docNo:       e.docNumber ?? `QYD-${String(e.id).padStart(4, "0")}`,
      entryDate:   e.entryDate ?? "",
      typeLabel:   ENTRY_TYPES[e.entryType] ?? e.entryType ?? "",
      statusLabel: (STATUS_MAP[e.status] ?? STATUS_MAP.posted).label,
      description: e.description ?? null,
      contractingRecoverySummaries: e.contractingRecoverySummaries,
      lines: (Array.isArray(e.lines) ? e.lines : []).map((ln: any) => {
        const acc = acctMap.get(Number(ln.accountId));
        return {
          accountLabel: acc
            ? `${acc.code ?? ""} — ${acc.nameAr ?? acc.nameEn ?? ""}`
            : `#${ln.accountId}`,
          description: ln.description ?? null,
          debit:  Number(ln.debit  ?? 0),
          credit: Number(ln.credit ?? 0),
          costCenterLabel: ln.costCenter ?? null,
        };
      }),
    }));
    return buildDetailedJournalPrintHtml(printEntries, {
      company: user?.company as any,
      isRtl,
      oneEntryPerPage: !!opts?.oneEntryPerPage,
      labels: journalPrintLabels(),
    });
  };

  /* ─── 5 print templates the user can pick from the bulk-bar dropdown.
         Each template builds its own self-contained HTML document and the
         dropdown decides which one to invoke based on `templateId`.
         Templates 2/4/5 need full line details, templates 1/3 work from the
         summary list rows alone (faster — no extra fetch).  ──────────── */
  type PrintTemplateId = "summary" | "detailed" | "compact" | "thermal" | "professional";

  const PRINT_TEMPLATES: { id: PrintTemplateId; label: string; desc: string; icon: any; needsLines: boolean }[] = [
    { id: "summary",      label: "ملخص أفقي A4",        desc: "جدول بصف لكل قيد — مناسب للعرض السريع", icon: LayoutGrid, needsLines: false },
    { id: "detailed",     label: "تفصيلي مع الأطراف",   desc: "صفحة لكل قيد بكامل أطرافه (مدين/دائن)", icon: FileText,   needsLines: true  },
    { id: "compact",      label: "مدمج (خط صغير)",       desc: "جدول مضغوط — أكبر عدد قيود في صفحة",     icon: FileSpreadsheet, needsLines: false },
    { id: "thermal",      label: "حراري 80mm",          desc: "إيصال طابعة حرارية — قيد لكل إيصال",     icon: Receipt,    needsLines: true  },
    { id: "professional", label: "احترافي مع التوقيعات", desc: "تنسيق رسمي مع خانات للتوقيعات والاعتماد", icon: Award,      needsLines: true  },
  ];

  // Compact summary: same data as buildPrintHtml but smaller font + tighter
  // rows so the user can fit ~50% more entries per A4 page.
  const buildCompactPrintHtml = (source: any[]) => {
    const rows = buildRows(source);
    const totalDebit  = source.reduce((s: number, e: any) => s + Number(e.totalDebit  ?? 0), 0);
    const totalCredit = source.reduce((s: number, e: any) => s + Number(e.totalCredit ?? 0), 0);
    const cols = Object.keys(rows[0] ?? { [COL_DOC_L]: "", [COL_DATE_L]: "", [COL_TYPE_L]: "", [COL_DESC_L]: "", [COL_DEBIT_L]: "", [COL_CREDIT_L]: "", [COL_STATUS_L]: "" });
    const today = new Date().toLocaleDateString(isRtl ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB");
    const dir = isRtl ? "rtl" : "ltr";
    const align = isRtl ? "right" : "left";
    const letterhead = buildLetterheadHtml(user?.company as any, {
      accent: "navy",
      size: "md",
      extraMetaHtml: `${escapeHtml(t("journalEntries.printSheetTitle"))} — ${escapeHtml(today)} — ${rows.length} قيد`,
    });
    return `<!DOCTYPE html><html dir="${dir}"><head><meta charset="utf-8"><title>${escapeHtml(t("journalEntries.printSheetTitle"))}</title>
<style>
@page { size: A4 landscape; margin: 8mm; @bottom-center { content: counter(page) " / " counter(pages); font-size:8pt; color:#475569; } }
body { font-family: "Segoe UI","Tahoma",sans-serif; color:#111; margin:0; font-size:9pt; }
${letterheadCss({ accent: "navy", size: "md" })}
table { width:100%; border-collapse:collapse; }
thead th { background:#1e3a8a; color:#fff; padding:3px 5px; border:1px solid #1e3a8a; text-align:${align}; font-weight:600; font-size:8.5pt; }
tbody td { padding:2.5px 5px; border:1px solid #e5e7eb; text-align:${align}; }
tbody tr:nth-child(even) td { background:#f8fafc; }
tfoot td { padding:4px 5px; border:1px solid #cbd5e1; background:#1e3a8a; color:#fff; font-weight:600; }
.num { font-family: "Consolas",monospace; }
.print-btn { position:fixed; top:8px; ${isRtl ? "left" : "right"}:8px; padding:6px 12px; background:#1e3a8a; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:10pt; }
@media print { .print-btn { display:none; } thead { display: table-header-group; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
${wrapWithLetterhead(letterhead, `<table><thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
<tbody>${rows.map(r => `<tr>${cols.map(c => {
  const isNum = c === COL_DEBIT_L || c === COL_CREDIT_L;
  return `<td class="${isNum ? "num" : ""}">${escapeHtml((r as any)[c])}</td>`;
}).join("")}</tr>`).join("")}</tbody>
<tfoot><tr><td colspan="${cols.length - 3}" style="text-align:${align};">الإجمالي</td>
<td class="num">${fmt2(totalDebit)}</td><td class="num">${fmt2(totalCredit)}</td><td></td></tr></tfoot>
</table>`)}
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
  };

  // Thermal 80mm: narrow receipt-style printout, one "ticket" per entry. Uses
  // a tight monospace-friendly layout so it renders cleanly on POS thermal
  // printers (and still looks fine on a regular printer).
  const buildThermalPrintHtml = (entriesWithLines: any[], accountsList: any[] = []) => {
    const acctMap = new Map<number, any>(accountsList.map((a: any) => [a.id, a]));
    const today = new Date().toLocaleDateString(isRtl ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB");
    const dir = isRtl ? "rtl" : "ltr";
    const company = user?.company as any;
    const safeLogo = safeLogoSrc(company?.logo);
    const companyName = company?.nameAr ?? "";
    const sections = entriesWithLines.map((e: any) => {
      const docNo  = e.docNumber ?? `QYD-${String(e.id).padStart(4, "0")}`;
      const lines: any[] = Array.isArray(e.lines) ? e.lines : [];
      const subDebit  = lines.reduce((s, ln) => s + Number(ln.debit  ?? 0), 0);
      const subCredit = lines.reduce((s, ln) => s + Number(ln.credit ?? 0), 0);
      const linesHtml = lines.length === 0
        ? `<div class="empty">— لا توجد أطراف —</div>`
        : lines.map((ln) => {
            const acc = acctMap.get(Number(ln.accountId));
            const accLabel = acc ? `${acc.code ?? ""} ${acc.nameAr ?? acc.nameEn ?? ""}`.trim() : `#${ln.accountId}`;
            const amt = Number(ln.debit) > 0 ? `مدين ${fmt2(ln.debit)}` : `دائن ${fmt2(ln.credit)}`;
            return `<div class="ln"><div class="acc">${escapeHtml(accLabel)}</div><div class="amt">${escapeHtml(amt)}</div>${ln.description ? `<div class="dsc">${escapeHtml(ln.description)}</div>` : ""}</div>`;
          }).join("");
      return `<section class="ticket">
        ${safeLogo ? `<div class="logo"><img src="${safeLogo}" alt="" /></div>` : ""}
        <div class="title">${escapeHtml(companyName)}</div>
        ${company?.crNumber ? `<div class="sub">س.ت: ${escapeHtml(company.crNumber)}</div>` : ""}
        ${company?.vatNumber ? `<div class="sub">ض.ق.م: ${escapeHtml(company.vatNumber)}</div>` : ""}
        ${company?.phone ? `<div class="sub">جوال: ${escapeHtml(company.phone)}</div>` : ""}
        <div class="sub">قيد محاسبي</div>
        <div class="hr"></div>
        <div class="row"><span>رقم القيد</span><b>${escapeHtml(docNo)}</b></div>
        <div class="row"><span>التاريخ</span><b>${escapeHtml(e.entryDate ?? "")}</b></div>
        <div class="row"><span>النوع</span><b>${escapeHtml(ENTRY_TYPES[e.entryType] ?? e.entryType ?? "")}</b></div>
        <div class="row"><span>الحالة</span><b>${escapeHtml((STATUS_MAP[e.status] ?? STATUS_MAP.posted).label)}</b></div>
        ${e.description ? `<div class="desc">${escapeHtml(e.description)}</div>` : ""}
        <div class="hr"></div>
        ${linesHtml}
        <div class="hr"></div>
        <div class="row"><span>إجمالي مدين</span><b>${fmt2(subDebit)}</b></div>
        <div class="row"><span>إجمالي دائن</span><b>${fmt2(subCredit)}</b></div>
        <div class="footer">طُبع: ${escapeHtml(today)}</div>
      </section>`;
    }).join("");
    return `<!DOCTYPE html><html dir="${dir}"><head><meta charset="utf-8"><title>قيود حرارية</title>
<style>
@page { size: 80mm auto; margin: 4mm 3mm; }
body { font-family: "Segoe UI","Tahoma",sans-serif; color:#000; margin:0; padding:0; font-size:10pt; width:74mm; }
.ticket { padding:6px 2px 10px; border-bottom: 2px dashed #94a3b8; page-break-after: always; }
.ticket:last-child { border-bottom:none; page-break-after: auto; }
.logo { text-align:center; margin-bottom:4px; }
.logo img { max-height:40px; max-width:60mm; }
.title { font-size:12pt; font-weight:700; text-align:center; }
.sub { font-size:9pt; text-align:center; color:#475569; margin-bottom:4px; }
.hr { border-top:1px dashed #94a3b8; margin:5px 0; }
.row { display:flex; justify-content:space-between; gap:6px; font-size:9.5pt; padding:1.5px 0; }
.row span { color:#475569; }
.row b { font-weight:600; }
.desc { padding:3px 0; font-size:9pt; color:#1f2937; }
.ln { padding:3px 0; border-top:1px dotted #d1d5db; }
.ln:first-child { border-top:none; }
.ln .acc { font-weight:600; font-size:9.5pt; }
.ln .amt { font-family: "Consolas",monospace; font-size:9.5pt; color:#1e3a8a; }
.ln .dsc { color:#475569; font-size:8.5pt; }
.empty { text-align:center; color:#94a3b8; padding:6px 0; font-size:9pt; }
.footer { text-align:center; color:#475569; font-size:8.5pt; margin-top:6px; }
.print-btn { position:fixed; top:8px; ${isRtl ? "left" : "right"}:8px; padding:5px 10px; background:#1e3a8a; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:9pt; }
@media print { .print-btn { display:none; } body { width: auto; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
${sections}
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
  };

  // Professional: formal letterhead-style A4 with shaded entry banner, line
  // table, and a signature block per entry (preparer / reviewer / approver).
  const buildProfessionalPrintHtml = (
    entriesWithLines: any[],
    opts?: { oneEntryPerPage?: boolean },
    accountsList: any[] = [],
  ) => {
    const acctMap = new Map<number, any>(accountsList.map((a: any) => [a.id, a]));
    const oneEntryPerPage = !!opts?.oneEntryPerPage;
    const today = new Date().toLocaleDateString(isRtl ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB");
    const dir = isRtl ? "rtl" : "ltr";
    const align = isRtl ? "right" : "left";
    const letterhead = buildLetterheadHtml(user?.company as any, {
      accent: "navy",
      size: "md",
      extraMetaHtml: `تاريخ الطباعة: ${escapeHtml(today)} — ${entriesWithLines.length} قيد`,
    });
    const sections = entriesWithLines.map((e: any) => {
      const docNo  = e.docNumber ?? `QYD-${String(e.id).padStart(4, "0")}`;
      const lines: any[] = Array.isArray(e.lines) ? e.lines : [];
      const subDebit  = lines.reduce((s, ln) => s + Number(ln.debit  ?? 0), 0);
      const subCredit = lines.reduce((s, ln) => s + Number(ln.credit ?? 0), 0);
      const linesHtml = lines.length === 0
        ? `<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:12px;">لا توجد أطراف لهذا القيد</td></tr>`
        : lines.map((ln, i) => {
            const acc = acctMap.get(Number(ln.accountId));
            const accLabel = acc ? `${escapeHtml(acc.code ?? "")} — ${escapeHtml(acc.nameAr ?? acc.nameEn ?? "")}` : `#${escapeHtml(ln.accountId)}`;
            return `<tr>
              <td class="num center">${i + 1}</td>
              <td>${accLabel}</td>
              <td>${escapeHtml(ln.description ?? "")}</td>
              <td class="num end">${fmt2(ln.debit ?? 0)}</td>
              <td class="num end">${fmt2(ln.credit ?? 0)}</td>
            </tr>`;
          }).join("");
      // Per-user request (2026-07-19): the standalone "إجمالي المدين / إجمالي
      // الدائن" strip under the table was removed here too (same as the
      // shared lib/journalPrint.ts builder) — the tfoot الإجمالي row already
      // carries the same numbers.
      const perPageTotals = "";
      return `<section class="entry">
        <div class="banner">
          <div class="banner-l">
            <div class="docno">قيد رقم: <b>${escapeHtml(docNo)}</b></div>
            <div class="docmeta">التاريخ: ${escapeHtml(e.entryDate ?? "")} • النوع: ${escapeHtml(ENTRY_TYPES[e.entryType] ?? e.entryType ?? "")}</div>
          </div>
          <div class="banner-r">
            <div class="status status-${escapeHtml(e.status)}">${escapeHtml((STATUS_MAP[e.status] ?? STATUS_MAP.posted).label)}</div>
          </div>
        </div>
        ${e.description ? `<div class="desc"><b>البيان:</b> ${escapeHtml(e.description)}</div>` : ""}
        <table>
          <thead>
            <tr>
              <th style="width:38px;">م</th>
              <th>الحساب</th>
              <th>الوصف</th>
              <th style="width:100px;">مدين</th>
              <th style="width:100px;">دائن</th>
            </tr>
          </thead>
          <tbody>${linesHtml}</tbody>
          <tfoot>
            <tr>
              <td colspan="3" class="end"><b>الإجمالي</b></td>
              <td class="num end"><b>${fmt2(subDebit)}</b></td>
              <td class="num end"><b>${fmt2(subCredit)}</b></td>
            </tr>
          </tfoot>
        </table>
        ${perPageTotals}
        <div class="signs">
          <div class="sign"><div class="sign-line"></div><div class="sign-label">المحاسب / المُعدّ</div></div>
          <div class="sign"><div class="sign-line"></div><div class="sign-label">المراجع</div></div>
          <div class="sign"><div class="sign-line"></div><div class="sign-label">المدير المالي / الاعتماد</div></div>
        </div>
      </section>`;
    }).join("");
    return `<!DOCTYPE html><html dir="${dir}"><head><meta charset="utf-8"><title>قيود — تنسيق احترافي</title>
<style>
@page { size: A4 portrait; margin: 14mm 14mm 22mm 14mm; @bottom-center { content: "صفحة " counter(page) " من " counter(pages); font-family: "Segoe UI","Tahoma",sans-serif; font-size:9pt; color:#475569; } }
body { font-family: "Segoe UI","Tahoma","Arial",sans-serif; color:#111; margin:0; }
${letterheadCss({ accent: "navy", size: "md" })}
.entry { page-break-inside: avoid; margin-bottom:18px; border:1px solid #cbd5e1; border-radius:8px; padding:10px 12px; }
${oneEntryPerPage ? "@media print { .entry { page-break-after: always; } .entry:last-of-type { page-break-after: auto; } }" : ""}
.banner { display:flex; justify-content:space-between; align-items:center; padding:8px 10px; background:#eef2ff; border-radius:6px; margin-bottom:8px; border-left: 4px solid #1e3a8a; }
.banner .docno { font-size:11pt; color:#1e3a8a; }
.banner .docmeta { font-size:9.5pt; color:#475569; margin-top:2px; }
.status { padding:3px 10px; border-radius:999px; font-size:9pt; font-weight:600; border:1px solid; }
.status-posted    { background:#d1fae5; color:#065f46; border-color:#6ee7b7; }
.status-draft     { background:#fef3c7; color:#92400e; border-color:#fcd34d; }
.status-cancelled { background:#fee2e2; color:#991b1b; border-color:#fca5a5; }
.status-voided    { background:#fee2e2; color:#991b1b; border-color:#fca5a5; }
.desc { font-size:10pt; color:#1f2937; margin:4px 0 8px; padding:6px 10px; background:#f8fafc; border-radius:4px; }
table { width:100%; border-collapse:collapse; font-size:10pt; }
thead th { background:#1e3a8a; color:#fff; padding:6px 8px; border:1px solid #1e3a8a; text-align:${align}; }
tbody td { padding:5px 8px; border:1px solid #d1d5db; text-align:${align}; }
tbody tr:nth-child(even) td { background:#f8fafc; }
tfoot td { padding:6px 8px; border:1px solid #cbd5e1; background:#f1f5f9; }
.num { font-family: "Consolas",monospace; }
/* Amounts align RIGHT everywhere (international convention) so body rows
   and the totals row always match in both RTL and LTR prints. */
.end { text-align:right; }
tbody td.num, tfoot td.num { text-align:right; }
.center { text-align:center; }
.signs { display:flex; justify-content:space-around; gap:14px; margin-top:22px; padding-top:6px; }
.sign { flex:1; text-align:center; }
.sign-line { border-top:1.5px solid #475569; margin-top:36px; }
.sign-label { margin-top:4px; font-size:9pt; color:#475569; }
.page-totals { display:flex; gap:18px; justify-content:space-around; margin-top:10px; padding:9px 14px; background:#1e3a8a; color:#fff; border-radius:6px; font-size:11pt; font-weight:600; }
.page-totals span, .page-totals b { color:#fff; }
.print-btn { position:fixed; top:10px; ${isRtl ? "left" : "right"}:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:11pt; }
@media print { .print-btn { display:none; } thead { display: table-header-group; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
${wrapWithLetterhead(letterhead, sections)}
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
  };

  // Print only the rows the user has selected via checkboxes — fetches each
  // selected entry's full details (with lines) so we can show every debit/credit
  // line per entry, not just the aggregate totals from the list response.
  const handleBulkPrint = async () => {
    await handleBulkPrintWith("detailed");
  };

  // Unified entry point used by the dropdown — fetches full lines for templates
  // that need them, then dispatches to the right HTML builder.
  const handleBulkPrintWith = async (templateId: PrintTemplateId) => {
      if (!(await gate('print'))) return;
    const ids = Array.from(layout.selected).map((x) => Number(x)).filter(Number.isFinite);
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const selectedRows = (entries as any[]).filter((e: any) => idSet.has(e.id));
    if (selectedRows.length === 0) return;

    const tpl = PRINT_TEMPLATES.find((p) => p.id === templateId)!;
    setBulkPrintBusy(true);
    try {
      const source = tpl.needsLines
        ? await Promise.all(selectedRows.map(async (row: any) => {
            try {
              const full = await journalEntriesApi.get(row.id, cid);
              return {
                ...row, ...full,
                totalDebit:  full?.totalDebit  ?? row.totalDebit  ?? 0,
                totalCredit: full?.totalCredit ?? row.totalCredit ?? 0,
                lines: Array.isArray(full?.lines) ? full.lines : [],
              };
            } catch { return { ...row, lines: [] }; }
          }))
        : selectedRows;
      const accountsList = tpl.needsLines ? await fetchAccountsList() : [];

      let html = "";
      switch (templateId) {
        case "summary":      html = buildPrintHtml(source); break;
        case "detailed":     html = buildBulkPrintHtml(source, { oneEntryPerPage }, accountsList); break;
        case "compact":      html = buildCompactPrintHtml(source); break;
        case "thermal":      html = buildThermalPrintHtml(source, accountsList); break;
        case "professional": html = buildProfessionalPrintHtml(source, { oneEntryPerPage }, accountsList); break;
      }
      openPrintWindow(html);
    } finally {
      setBulkPrintBusy(false);
    }
  };

  /* ─── Selected-rows export to PDF (just opens the summary template — the
        in-window print dialog lets the user "Save as PDF") and to Excel
        (XLSX file restricted to the selected entries). ────────────────── */
  const handleBulkExportPDF = async () => {
      if (!(await gate('print'))) return;
    if (selectedIds.length === 0) return;
    const idSet = new Set(selectedIds);
    const sel = (entries as any[]).filter((e: any) => idSet.has(e.id));
    if (sel.length === 0) return;
    openPrintWindow(buildPrintHtml(sel));
  };

  const handleBulkExportExcel = async () => {
      if (!(await gate('export'))) return;
    if (selectedIds.length === 0) return;
    const idSet = new Set(selectedIds);
    const sel = (entries as any[]).filter((e: any) => idSet.has(e.id));
    if (sel.length === 0) return;
    const rows = buildRows(sel);
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 32 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, t("journalEntries.title"));
    void saveWorkbook(wb, `journal-entries-selected-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  /* ── Quick CSV export (uses visible columns + filtered set) ── */
  async function exportCsv() {
      if (!(await gate('export'))) return;
    const source = await fetchExportRows();
    if (source.length === 0) return;
    const header = ["#", ...visibleColumns.filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map((c) => c.label)];
    const rows = source.map((e: any, i: number) => [
      i + 1,
      ...visibleColumns
        .filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act")
        .map((c) => {
          const v = c.valueOf(e, ctx);
          return c.type === "num" ? Number(v).toFixed(2) : String(v);
        }),
    ]);
    downloadCsv(`journal-entries-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  }

  const { theme, footerTheme, colWidths, colFilters, clearColFilters } = layout;

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <BookOpen className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">{t("journalEntries.title")}</h1>
            <p className="text-xs text-muted-foreground">{t("journalEntries.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          {/* Solid green "New Entry" button (visual far-left in RTL) */}
          <Button
            onClick={() => navigate("/accounting/journals/new")}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
          >
            <Plus className="h-4 w-4" />
            {t("journalEntries.newEntry")}
          </Button>
          {/* Grouped export pill: PDF | Excel | Print */}
          <div className="inline-flex items-stretch rounded-md border border-slate-300 bg-white shadow-sm overflow-hidden">
            <Button
              variant="ghost" size="sm" onClick={handleExportPDF}
              className="h-9 rounded-none gap-1.5 text-red-700 hover:bg-red-50 hover:text-red-700 px-3"
            >
              <FileDown className="h-4 w-4" /> {t("journalEntries.pdf")}
            </Button>
            <div className="w-px bg-slate-200" />
            <Button
              variant="ghost" size="sm" onClick={handleExportExcel}
              className="h-9 rounded-none gap-1.5 text-green-700 hover:bg-green-50 hover:text-green-700 px-3"
            >
              <FileSpreadsheet className="h-4 w-4" /> {t("journalEntries.excel")}
            </Button>
            <div className="w-px bg-slate-200" />
            <Button
              variant="ghost" size="sm" onClick={handlePrint}
              className="h-9 rounded-none gap-1.5 text-slate-700 hover:bg-slate-50 hover:text-slate-700 px-3"
            >
              <Printer className="h-4 w-4" /> {t("accountingReports.print")}
            </Button>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="border-2">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <FileText className="h-8 w-8 text-blue-500 bg-blue-50 rounded-lg p-1.5" />
              <div>
                <p className="text-xs text-muted-foreground">{t("journalEntries.totalEntries")}</p>
                <p className="text-2xl font-bold text-foreground">{allTotals.count}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-2">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <ArrowUpDown className="h-8 w-8 text-green-500 bg-green-50 rounded-lg p-1.5" />
              <div>
                <p className="text-xs text-muted-foreground">{t("journalEntries.totalDebit")}</p>
                <p className="text-2xl font-bold text-green-600">{fmt(totalDebitAll)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-2">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-8 w-8 text-purple-500 bg-purple-50 rounded-lg p-1.5" />
              <div>
                <p className="text-xs text-muted-foreground">{t("journalEntries.totalCredit")}</p>
                <p className="text-2xl font-bold text-purple-600">{fmt(totalCreditAll)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Audit-grid toolbar ───────────────────────────────────────────── */}
      <div className={cn("rounded-t-lg overflow-hidden border shadow-sm transition-colors", theme.border)}>
        <div className={cn("px-3 py-2 flex items-center gap-2 flex-wrap transition-colors", theme.bar, theme.text)}>
          <div className={cn("flex-1 text-sm font-bold tracking-wide flex items-center gap-2", theme.text)}>
            <BookOpen className="h-4 w-4 opacity-90" />
            {t("journalEntries.log")}
          </div>
          <div className="flex items-center gap-1.5">
            <HeaderColorPicker layout={layout} isRtl={isRtl} />
            <FooterColorPicker layout={layout} isRtl={isRtl} />
            <ColumnReorderPopover layout={layout} isRtl={isRtl} columns={reorderableCols} />
            <Button type="button" size="sm" variant="ghost"
              className={cn("h-7 px-2 text-xs gap-1", theme.btn)} onClick={exportCsv}>
              <FileSpreadsheet className="h-3.5 w-3.5" />
              تصدير CSV
            </Button>
            {/* SuperAdmin-only governance tool — hidden from company admins/users.
                Server enforces the same 403 guard, this is just UI gating. */}
            {user?.role === "superadmin" && (
              <Button type="button" size="sm" variant="ghost"
                className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
                onClick={() => setGapFillOpen(true)}
                data-testid="button-gap-fill">
                <RotateCcw className="h-3.5 w-3.5" />
                استرجاع رقم محذوف
              </Button>
            )}
          </div>
        </div>

        <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs">
          <Input
            placeholder={t("journalEntries.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs w-56"
          />
          <div className="flex gap-1">
            {(["all", "draft", "posted", "voided"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={cn(
                  "px-2 py-1 rounded text-[11px] font-medium border transition-colors",
                  statusFilter === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100",
                )}
              >
                {s === "all" ? t("journalEntries.statusAll", { defaultValue: "الكل" }) : (STATUS_MAP[s]?.label ?? s)}
              </button>
            ))}
          </div>
          {(Object.values(colFilters).some((v) => v) || Object.values(colAdv).some(isAdvActive)) && (
            <Button type="button" size="sm" variant="ghost"
              className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50"
              onClick={clearAllColFilters} title="مسح فلاتر الأعمدة">
              <X className="h-3.5 w-3.5 me-1" />
              مسح فلاتر الأعمدة
            </Button>
          )}
          {/* ── Date-range filter ─────────────────────────────────────────
              Compact, attractive picker: a calendar icon, two date inputs
              labelled "من / إلى", and four quick-preset chips (today,
              7-day, this-month, this-year). Active range gets a soft
              blue gradient highlight + clear button so it's obvious a
              date filter is engaged. */}
          <div className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2 py-1 transition-all",
            (dateFrom || dateTo)
              ? "bg-gradient-to-l from-blue-50 via-indigo-50 to-violet-50 border-blue-300 shadow-sm dark:from-blue-950/40 dark:via-indigo-950/40 dark:to-violet-950/40 dark:border-blue-800"
              : "bg-white border-slate-300",
          )}>
            <Calendar className={cn(
              "h-3.5 w-3.5",
              (dateFrom || dateTo) ? "text-blue-700" : "text-slate-500",
            )} />
            <span className="text-[11px] text-slate-600 font-medium">من</span>
            <DateField
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              max={dateTo || undefined}
              className="h-6 text-[11px] w-[115px] px-1.5 border-slate-300 bg-white"
              data-testid="filter-date-from"
            />
            <span className="text-[11px] text-slate-600 font-medium">إلى</span>
            <DateField
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              min={dateFrom || undefined}
              className="h-6 text-[11px] w-[115px] px-1.5 border-slate-300 bg-white"
              data-testid="filter-date-to"
            />
            {/* Preset chips — single click to fill both ends */}
            <div className="flex items-center gap-0.5 ms-1 ps-1.5 border-s border-slate-300">
              {([
                { k: "today", label: "اليوم" },
                { k: "week",  label: "٧ أيام" },
                { k: "month", label: "الشهر" },
                { k: "year",  label: "السنة" },
              ] as const).map((p) => (
                <button
                  key={p.k}
                  type="button"
                  onClick={() => applyDatePreset(p.k)}
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium text-slate-600 hover:bg-blue-100 hover:text-blue-800 transition-colors"
                  data-testid={`filter-date-preset-${p.k}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {(dateFrom || dateTo) && (
              <button
                type="button"
                onClick={clearDateRange}
                className="flex items-center justify-center h-5 w-5 rounded text-rose-600 hover:bg-rose-100 transition-colors"
                title="مسح فلتر التاريخ"
                data-testid="filter-date-clear"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex-1" />
          <span className="text-slate-700 font-medium">
            {serverTotal} {t("journalEntries.itemLabel", { defaultValue: "قيد" })}
            {hasAdvancedFilters && filtered.length !== entries.length && <span className="text-slate-400"> / {entries.length}</span>}
          </span>
        </div>
        {/* ── Bulk-action bar (visible only when one or more rows selected) ── */}
        <AuditGridBulkBar
          count={layout.selected.size}
          onClear={layout.clearSelection}
          busy={bulkBusy}
        >
          {/* Print — split button: clicking the body uses the default
              "detailed" template; clicking the chevron opens a menu with all
              5 templates. Each item shows a short description so the user
              picks the right one without trial-and-error. */}
          <DropdownMenu>
            <div className="inline-flex items-stretch rounded-md overflow-hidden">
              <Button
                type="button" size="sm"
                className="h-7 px-3 text-xs gap-1 rounded-none bg-blue-700 hover:bg-blue-600 text-white"
                onClick={handleBulkPrint}
                disabled={selectedIds.length === 0 || bulkPrintBusy}
                title={`${t("accountingReports.print")} (${selectedIds.length}) — تفصيلي مع الأطراف`}
                data-testid="bulk-print"
              >
                {bulkPrintBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
                {t("accountingReports.print")} ({selectedIds.length})
              </Button>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button" size="sm"
                  className="h-7 px-1.5 text-xs rounded-none bg-blue-800 hover:bg-blue-700 text-white border-r border-blue-900/30"
                  disabled={selectedIds.length === 0 || bulkPrintBusy}
                  title="اختر قالب الطباعة"
                  aria-label="اختر قالب الطباعة"
                  data-testid="bulk-print-template"
                >
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </div>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="text-xs text-slate-500 font-normal">
                قوالب الطباعة — للقيود المحددة ({selectedIds.length})
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {/* Page-layout toggle — applies to "تفصيلي" and "احترافي"
                  (the two per-entry templates). When ON, each selected
                  journal entry prints on its own A4 sheet — ideal for
                  archiving / signing one entry per page. Compact / summary
                  / thermal templates ignore this flag by design. */}
              <label
                className="flex items-start gap-2 px-2 py-2 mx-1 my-1 rounded-md bg-amber-50 border border-amber-200 cursor-pointer hover:bg-amber-100 select-none"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={oneEntryPerPage}
                  onChange={(e) => setOneEntryPerPage(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-amber-600 cursor-pointer"
                  data-testid="toggle-one-entry-per-page"
                />
                <div className="flex flex-col">
                  <span className="text-[12px] font-medium text-amber-900">كل قيد في صفحة منفصلة</span>
                  <span className="text-[10px] text-amber-700 leading-tight">
                    يطبق على القوالب التفصيلية والاحترافية فقط
                  </span>
                </div>
              </label>
              <DropdownMenuSeparator />
              {PRINT_TEMPLATES.map((tpl) => {
                const Icon = tpl.icon;
                return (
                  <DropdownMenuItem
                    key={tpl.id}
                    onSelect={(e) => { e.preventDefault(); void handleBulkPrintWith(tpl.id); }}
                    className="flex items-start gap-2 cursor-pointer py-2"
                    data-testid={`print-template-${tpl.id}`}
                  >
                    <Icon className="h-4 w-4 mt-0.5 text-blue-700 shrink-0" />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-slate-900">{tpl.label}</span>
                      <span className="text-[11px] text-slate-500 leading-tight">{tpl.desc}</span>
                    </div>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Selected-rows export — Excel + PDF act on the *selected* entries
              only (the page header pill exports ALL filtered rows). */}
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-green-700 hover:bg-green-600 text-white"
            onClick={handleBulkExportExcel}
            disabled={selectedIds.length === 0}
            title={`تصدير المحدد إلى Excel (${selectedIds.length})`}
            data-testid="bulk-export-excel"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Excel ({selectedIds.length})
          </Button>
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-red-700 hover:bg-red-600 text-white"
            onClick={handleBulkExportPDF}
            disabled={selectedIds.length === 0}
            title={`تصدير المحدد إلى PDF (${selectedIds.length})`}
            data-testid="bulk-export-pdf"
          >
            <FileDown className="h-3.5 w-3.5" />
            PDF ({selectedIds.length})
          </Button>
          {/* Post (ترحيل) — only enabled when at least one selected row is a
              draft. Posted/cancelled rows are silently skipped server-side
              guards already enforce balance + auto-lock + period rules. */}
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-emerald-600 hover:bg-emerald-500 text-white"
            onClick={handleBulkPost}
            disabled={bulkBusy || draftSelectedIds.length === 0}
            title={
              draftSelectedIds.length === 0
                ? "لا توجد قيود مسودة في التحديد لترحيلها"
                : `ترحيل (${draftSelectedIds.length})`
            }
            data-testid="bulk-post"
          >
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            ترحيل ({draftSelectedIds.length})
          </Button>
          {/* Unpost (فك الترحيل) — only enabled when at least one selected row
              is posted. Server guards reject locked source-doc / FA-linked /
              closed-period entries per-row. */}
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-amber-600 hover:bg-amber-500 text-white"
            onClick={handleBulkUnpost}
            disabled={bulkBusy || postedSelectedIds.length === 0}
            title={
              postedSelectedIds.length === 0
                ? "لا توجد قيود مرحّلة في التحديد لفك ترحيلها"
                : `فك الترحيل (${postedSelectedIds.length})`
            }
            data-testid="bulk-unpost"
          >
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            فك الترحيل ({postedSelectedIds.length})
          </Button>
          {/* Edit / Duplicate — single-row actions promoted from the row "_act"
              column into the bulk bar. They route to the form page for the one
              selected entry, and are disabled unless exactly one row is picked
              so the intent stays unambiguous. */}
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-slate-700 hover:bg-slate-600 text-white"
            onClick={() => { if (selectedIds.length === 1) navigate(`/accounting/journals/${selectedIds[0]}`); }}
            disabled={selectedIds.length !== 1}
            title={
              selectedIds.length === 0
                ? "حدّد قيداً واحداً أولاً"
                : selectedIds.length > 1
                  ? "هذا الإجراء يعمل على قيد واحد فقط — قلّل التحديد"
                  : t("journalEntries.actions", { defaultValue: "تعديل (خصائص)" })
            }
            data-testid="bulk-edit"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t("journalEntries.edit", { defaultValue: "تعديل" })}
          </Button>
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-sky-600 hover:bg-sky-500 text-white"
            onClick={() => { if (selectedIds.length === 1) navigate(`/accounting/journals/new?from=${selectedIds[0]}`); }}
            disabled={selectedIds.length !== 1}
            title={
              selectedIds.length === 0
                ? "حدّد قيداً واحداً أولاً"
                : selectedIds.length > 1
                  ? "هذا الإجراء يعمل على قيد واحد فقط — قلّل التحديد"
                  : "نسخة مماثلة"
            }
            data-testid="bulk-duplicate"
          >
            <Copy className="h-3.5 w-3.5" />
            نسخة مماثلة
          </Button>
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-rose-600 hover:bg-rose-500 text-white"
            onClick={() => setBulkDeleteOpen(true)}
            disabled={bulkBusy || selectedIds.length === 0}
            title={`${t("journalEntries.delete")} (${selectedIds.length})`}
          >
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {t("journalEntries.delete")} ({selectedIds.length})
          </Button>
        </AuditGridBulkBar>
      </div>

      {/* ── Audit-grid table ─────────────────────────────────────────────── */}
      {(() => {
        const items: LegendItem[] = [
          { kind: "draft",     count: filtered.filter((e: any) => e.status === "draft").length },
          { kind: "posted",    count: filtered.filter((e: any) => e.status === "posted").length },
          { kind: "cancelled", count: filtered.filter((e: any) => e.status === "cancelled").length },
        ];
        return <DocColorLegend items={items} />;
      })()}

      <div className="border border-slate-300 rounded-b-lg bg-white overflow-hidden shadow-sm -mt-3">
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          {isLoading ? (
            <div className="py-16 text-center text-muted-foreground text-sm">{t("journalEntries.loading")}</div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <BookOpen className="h-10 w-10 text-muted-foreground/30 mx-auto" />
              <p className="text-muted-foreground text-sm">{t("journalEntries.noEntries")}</p>
              <Button variant="outline" size="sm" onClick={() => navigate("/accounting/journals/new")}>
                <Plus className={cn("h-3.5 w-3.5", isRtl ? "ml-1" : "mr-1")} />
                {t("journalEntries.createFirstEntry")}
              </Button>
            </div>
          ) : (
            <table ref={tableRef} className="w-full text-[11px] border-collapse" dir={isRtl ? "rtl" : "ltr"}>
              <colgroup>
                {visibleColumns.map((col) => (
                  <col key={col.key} data-col-key={col.key}
                    style={colWidths[col.key] ? { width: `${colWidths[col.key]}px` } : undefined} />
                ))}
              </colgroup>
              <thead className="sticky top-0 z-10">
                <tr className="bg-gradient-to-b from-slate-100 to-slate-200 text-slate-700">
                  {visibleColumns.map((col, idx) => {
                    if (col.key === "_sel") {
                      const visibleIds = paged.map((e: any) => Number(e.id));
                      return (
                        <th
                          key={col.key}
                          data-col-key={col.key}
                          style={colWidths[col.key] ? { width: `${colWidths[col.key]}px`, minWidth: `${colWidths[col.key]}px` } : undefined}
                          className="relative px-2 py-1.5 border border-slate-300 text-center font-semibold whitespace-nowrap text-[10.5px] w-9"
                        >
                          <HeaderSelectCheckbox
                            allSelected={layout.isAllSelected(visibleIds)}
                            someSelected={layout.isSomeSelected(visibleIds)}
                            onToggle={() => layout.toggleAll(visibleIds)}
                            disabled={visibleIds.length === 0 || bulkBusy}
                          />
                        </th>
                      );
                    }
                    const sortable = col.type !== "none";
                    const isSorted  = sort?.key === col.key;
                    const SortIcon  = !sortable ? null
                      : isSorted ? (sort!.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
                    return (
                      <th
                        key={col.key}
                        data-col-key={col.key}
                        style={colWidths[col.key] ? { width: `${colWidths[col.key]}px`, minWidth: `${colWidths[col.key]}px` } : undefined}
                        className={cn(
                          "relative px-2 py-1.5 border border-slate-300 text-center font-semibold whitespace-nowrap text-[10.5px]",
                          sortable && "cursor-pointer hover:bg-slate-200 select-none",
                          isSorted && "bg-blue-100 text-blue-900",
                        )}
                        onClick={sortable ? () => cycleSort(col.key) : undefined}
                        title={sortable ? "اضغط للترتيب — تصاعدي / تنازلي / إلغاء" : undefined}
                      >
                        <span className="inline-flex items-center justify-center gap-1">
                          {col.label}
                          {SortIcon && (
                            <SortIcon className={cn("h-3 w-3", isSorted ? "text-blue-700" : "text-slate-400 opacity-60")} />
                          )}
                          {col.type !== "none" && (
                            <span onClick={(e) => e.stopPropagation()}>
                              <AdvFilterPopover
                                colLabel={col.label || col.key}
                                colType={col.type}
                                value={colAdv[col.key]}
                                active={isAdvActive(colAdv[col.key])}
                                onApply={(v) => setColAdv((prev) => ({ ...prev, [col.key]: v }))}
                                onClear={() => clearColAdv(col.key)}
                              />
                            </span>
                          )}
                        </span>
                        <span
                          {...gripProps(col.key, idx)}
                          onClick={(e) => e.stopPropagation()}
                          className="print:hidden absolute top-0 bottom-0 w-2 cursor-col-resize select-none touch-none hover:bg-blue-400/60 active:bg-blue-500/80 z-20"
                          style={{ insetInlineEnd: -4 }}
                        />
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {paged.map((entry: any, idx: number) => {
                  const absIdx = (safePage - 1) * serverLimit + idx;
                  const st = STATUS_MAP[entry.status] ?? STATUS_MAP.posted;
                  const docLabel = entry.docNumber ?? `QYD-${String(entry.id).padStart(4, "0")}`;
                  const sourceUrl = sourceDocumentUrl(entry.entryType, entry.sourceId);
                  const rid = Number(entry.id);
                  const isSel = layout.isSelected(rid);
                  const renderCell = (col: ColDef) => {
                    switch (col.key) {
                      case "_sel":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <RowSelectCheckbox
                              checked={isSel}
                              onToggle={() => layout.toggleRow(rid)}
                              ariaLabel={`تحديد القيد ${docLabel}`}
                            />
                          </td>
                        );
                      case "_idx":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{absIdx + 1}</td>;
                      case "doc":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 font-mono font-semibold text-center">
                            {sourceUrl ? (
                              <button
                                type="button"
                                className="text-primary hover:underline"
                                title={t("journalEntries.openSource")}
                                onClick={(e) => { e.stopPropagation(); navigate(sourceUrl); }}
                              >
                                {docLabel}
                              </button>
                            ) : (
                              <span className="text-primary">{docLabel}</span>
                            )}
                          </td>
                        );
                      case "date":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap text-slate-600">
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="h-3 w-3 opacity-70" />
                              {entry.entryDate}
                            </span>
                          </td>
                        );
                      case "type":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-600">{ENTRY_TYPES[entry.entryType] ?? entry.entryType}</td>;
                      case "desc":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 truncate text-slate-600", colWidths.desc ? "" : "max-w-[260px]")} title={entry.description ?? ""}>{entry.description ?? "—"}</td>;
                      case "debit":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-emerald-700 font-medium">{fmt(Number(entry.totalDebit ?? 0))}</td>;
                      case "credit":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-rose-700 font-medium">{fmt(Number(entry.totalCredit ?? 0))}</td>;
                      case "status":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <span className={cn("inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border", st.cls)}>{st.label}</span>
                          </td>
                        );
                      case "createdBy": {
                        // Audit display: username with a small user icon, or em-dash
                        // for legacy rows that pre-date the audit columns. Wrapped
                        // in a soft slate chip so the column reads as metadata.
                        const name = (entry as any).createdByName as string | null | undefined;
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap">
                            {name ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-700 px-2 py-0.5 text-[11px] font-medium" data-testid={`cell-createdby-${entry.id}`}>
                                <UserIcon className="h-3 w-3 opacity-70" />
                                {name}
                              </span>
                            ) : (
                              <span className="text-slate-400 text-xs">—</span>
                            )}
                          </td>
                        );
                      }
                      case "postedBy": {
                        const name = (entry as any).postedByName as string | null | undefined;
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap">
                            {name ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 text-[11px] font-medium" data-testid={`cell-postedby-${entry.id}`}>
                                <UserIcon className="h-3 w-3 opacity-70" />
                                {name}
                              </span>
                            ) : (
                              <span className="text-slate-400 text-xs">—</span>
                            )}
                          </td>
                        );
                      }
                      case "_act":
                        // Edit + Duplicate moved to the top toolbar (acts on
                        // the single-selected row). The per-row Delete stays
                        // here because it's the only fast destructive path
                        // that doesn't require selection first.
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <div className="flex items-center justify-center gap-0.5">
                              {isManager && (
                                <Button
                                  variant="ghost" size="icon"
                                  className="h-6 w-6 text-indigo-600 hover:bg-indigo-50 hover:text-indigo-700"
                                  onClick={(e) => { e.stopPropagation(); setAuditId(entry.id); }}
                                  title={t("journalEntries.auditTrail", { defaultValue: "سجل التدقيق (المدير)" })}
                                  data-testid={`button-audit-${entry.id}`}
                                >
                                  <Eye className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {entry.status === "posted" && !sourceDocumentUrl(entry.entryType, null) && (
                                <Button
                                  variant="ghost" size="icon"
                                  className="h-6 w-6 text-amber-600 hover:bg-amber-50 hover:text-amber-700"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    if (!window.confirm(
                                      `فك ترحيل القيد ${entry.docNumber ?? `#${entry.id}`} وتحويله إلى مسودة؟\n` +
                                      `سيُلغى أثره من كل التقارير حتى يُعاد ترحيله.` +
                                      (String(entry.entryType ?? "").startsWith("adjustment")
                                        ? `\nقيد تسوية شهرية: سيتحول إلى مسودة بنفس رقم التسلسل — عدّله ثم أعد ترحيله وسيحتفظ بنفس الرقم.`
                                        : "")
                                    )) return;
                                    try {
                                      await journalEntriesApi.unpost(entry.id);
                                      qc.invalidateQueries({ queryKey: ["journal-entries", cid] });
                                    } catch (err: any) {
                                      window.alert(err?.message ?? "فشل فك الترحيل — قد يكون القيد مصدره مستند أو داخل فترة مقفلة");
                                    }
                                  }}
                                  title="فك وتحويل إلى مسودة"
                                  data-testid={`button-unpost-${entry.id}`}
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {entry.isOrphanLocked && (
                                <Button
                                  variant="ghost" size="icon"
                                  className="h-6 w-6 text-amber-600 hover:bg-amber-50 hover:text-amber-700"
                                  onClick={(e) => { e.stopPropagation(); setConvertId(entry.id); }}
                                  title="تحويل إلى قيد عام (مسودة) — قيد يتيم بلا مستند مصدر"
                                  data-testid={`button-convert-general-${entry.id}`}
                                >
                                  <FileText className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button
                                variant="ghost" size="icon"
                                className="h-6 w-6 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                onClick={(e) => { e.stopPropagation(); setDeleteId(entry.id); }}
                                title={t("journalEntries.delete", { defaultValue: "حذف" })}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </td>
                        );
                      default:
                        return <td key={col.key} className="px-2 py-1 border border-slate-200" />;
                    }
                  };
                  return (
                    <tr
                      key={entry.id}
                      data-testid={`row-journal-entry-${entry.id}`}
                      data-status={entry.status}
                      className={cn(
                        "transition-colors cursor-pointer",
                        isSel ? SEL_TONE : rowToneFor({ status: entry.status }),
                        monthAccentFor(entry.entryDate),
                      )}
                      onClick={(e) => {
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || (e.target as HTMLElement).closest("button,a,input")) return;
                        layout.toggleRow(rid);
                      }}
                      onDoubleClick={() => navigate(`/accounting/journals/${entry.id}?tab=lines`)}
                      title={(() => {
                        const m = String(entry.entryDate ?? "").match(/^(\d{4})-(\d{2})/);
                        const monthLabel = m ? `${MONTH_NAMES_AR[Number(m[2])]} ${m[1]}` : "";
                        const statusTip = buildToneTooltip({ status: entry.status });
                        return monthLabel ? `${monthLabel} • ${statusTip}` : statusTip;
                      })()}
                    >
                      {visibleColumns.map(renderCell)}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className={cn("text-[11px] font-semibold", footerTheme.bg, footerTheme.text)}>
                  {visibleColumns.map((col, i) => {
                    // _sel sits at index 0; the "الإجمالي:" label belongs in the next cell.
                    if (col.key === "_sel") {
                      return <td key={col.key} className={cn("px-2 py-2 border", footerTheme.border)} />;
                    }
                    if (i === 1) {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end whitespace-nowrap", footerTheme.border)}>الإجمالي:</td>;
                    }
                    if (col.key === "debit") {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end font-mono", footerTheme.border)}>{fmt(totals.debit)}</td>;
                    }
                    if (col.key === "credit") {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end font-mono", footerTheme.border)}>{fmt(totals.credit)}</td>;
                    }
                    return <td key={col.key} className={cn("px-2 py-2 border", footerTheme.border)} />;
                  })}
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <AuditGridPagination
          layout={layout}
          totalRows={serverTotal}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel={t("journalEntries.itemLabel", { defaultValue: "قيد" })}
          pageSizeOptions={JOURNAL_REGISTER_PAGE_SIZES}
        />
      </div>

      {/* Audit-trail dialog (manager-only) — surfaces who/where/when created
          and posted each entry. Renders a tidy two-column layout (created vs
          posted) with username, timestamp, IP, country, and a friendly
          browser/OS device label. Older rows missing audit data show "—". */}
      {/* ── Gap-fill dialog: استرجاع رقم قيد محذوف كمسودة ─────────────── */}
      <Dialog open={gapFillOpen} onOpenChange={(o) => { if (!o) setGapFillOpen(false); }}>
        <DialogContent dir={isRtl ? "rtl" : "ltr"} className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <RotateCcw className="h-4 w-4" />
              استرجاع رقم قيد محذوف
            </DialogTitle>
            <DialogDescription>
              أدخل رقم القيد المحذوف وتاريخه — سيتم إنشاؤه كقيد <b>مسودة</b> فارغ بنفس الرقم
              لسدّ الفجوة في التسلسل، ويمكنك تعديل بنوده لاحقاً. لن يؤثر على التقارير حتى يتم ترحيله.
            </DialogDescription>
          </DialogHeader>

          {/* ── فحص النواقص: حدد فترة → السيرفر يستخرج كل الأرقام المفقودة ── */}
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 space-y-2">
            <div className="text-xs font-semibold text-slate-700">فحص النواقص في فترة</div>
            <div className="flex items-end gap-2 flex-wrap">
              <div>
                <label className="text-[11px] text-slate-600 block mb-1">من</label>
                <DateField
                  value={gapScanFrom}
                  onChange={(e) => setGapScanFrom(e.target.value)}
                  className="h-8 text-sm w-36"
                  data-testid="input-gap-scan-from"
                />
              </div>
              <div>
                <label className="text-[11px] text-slate-600 block mb-1">إلى</label>
                <DateField
                  value={gapScanTo}
                  onChange={(e) => setGapScanTo(e.target.value)}
                  className="h-8 text-sm w-36"
                  data-testid="input-gap-scan-to"
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-8"
                disabled={!gapScanFrom || !gapScanTo || gapScanLoading}
                onClick={runGapScan}
                data-testid="button-gap-scan"
              >
                {gapScanLoading && <Loader2 className="h-3.5 w-3.5 animate-spin me-1" />}
                بحث عن النواقص
              </Button>
            </div>
            {gapScanError && (
              <div className="text-xs text-rose-700">{gapScanError}</div>
            )}
            {gapScanResult && (
              gapScanResult.missing.length === 0 ? (
                <div className="text-xs text-emerald-700">
                  لا توجد أرقام ناقصة في هذه الفترة — التسلسل مكتمل ✓
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-xs text-slate-600">
                    عدد الأرقام الناقصة: <b>{gapScanResult.missing.length}</b>
                    {gapScanResult.truncated && " (تم عرض أول 500 فقط — ضيّق الفترة)"}
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded border border-slate-200 bg-white divide-y divide-slate-100">
                    {gapScanResult.missing.map((m) => (
                      <div key={m.docNumber} className="flex items-center justify-between px-2 py-1.5 text-xs">
                        <span dir="ltr" className="font-mono">{m.docNumber}</span>
                        <span className="text-slate-500">{m.suggestedDate ?? "—"}</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px]"
                          disabled={gapFillMutation.isPending}
                          onClick={() => {
                            setGapFillNumber(m.docNumber);
                            if (m.suggestedDate) setGapFillDate(m.suggestedDate);
                          }}
                          data-testid={`button-gap-pick-${m.docNumber}`}
                        >
                          استرجاع
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>

          <div className="space-y-3 py-1">
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1">رقم القيد</label>
              <Input
                value={gapFillNumber}
                onChange={(e) => setGapFillNumber(e.target.value)}
                placeholder="مثال: QYD/06/1727"
                dir="ltr"
                className="h-8 text-sm"
                data-testid="input-gap-fill-number"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1">تاريخ القيد</label>
              <DateField
                value={gapFillDate}
                onChange={(e) => setGapFillDate(e.target.value)}
                className="h-8 text-sm"
                data-testid="input-gap-fill-date"
              />
            </div>
          </div>
          <DialogFooter className="flex-row-reverse gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!gapFillNumber.trim() || !gapFillDate || gapFillMutation.isPending}
              onClick={() => gapFillMutation.mutate()}
              data-testid="button-gap-fill-save"
            >
              {gapFillMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin me-1" />}
              إنشاء كمسودة
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setGapFillOpen(false)}>
              إلغاء
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={auditId !== null} onOpenChange={(o) => !o && setAuditId(null)}>
        <DialogContent dir={isRtl ? "rtl" : "ltr"} className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="h-5 w-5 text-indigo-600" />
              {t("journalEntries.auditTrail", { defaultValue: "سجل التدقيق" })}
              {auditId != null && <span className="text-xs text-muted-foreground">#{auditId}</span>}
            </DialogTitle>
            <DialogDescription>
              {t("journalEntries.auditTrailDesc", {
                defaultValue: "بيانات التتبع للموظف الذي أنشأ وقام بترحيل القيد (للمدراء فقط).",
              })}
            </DialogDescription>
          </DialogHeader>

          {auditQuery.isLoading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin me-2" /> جاري التحميل…
            </div>
          ) : auditQuery.isError ? (
            <div className="py-6 text-sm text-rose-700">
              {(auditQuery.error as any)?.message || "تعذّر تحميل سجل التدقيق"}
            </div>
          ) : auditQuery.data ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              {(["created", "posted"] as const).map((kind) => {
                const ev = kind === "created" ? auditQuery.data!.created : auditQuery.data!.posted;
                const titleAr = kind === "created" ? "الإنشاء" : "الترحيل";
                if (!ev) {
                  return (
                    <div key={kind} className="border rounded-md p-3 bg-slate-50">
                      <div className="font-semibold mb-2">{titleAr}</div>
                      <div className="text-xs text-muted-foreground">— لم يتم بعد —</div>
                    </div>
                  );
                }
                const fmtAt = (s: string | null) => {
                  if (!s) return "—";
                  try { return new Date(s).toLocaleString(isRtl ? "ar-SA-u-ca-gregory-nu-latn" : "en-US"); }
                  catch { return s; }
                };
                const Row = ({ icon: Ico, label, value }: { icon: any; label: string; value: string | null }) => (
                  <div className="flex items-start gap-2 text-xs py-1">
                    <Ico className="h-3.5 w-3.5 mt-0.5 text-slate-500 shrink-0" />
                    <div className="text-slate-500 w-20 shrink-0">{label}</div>
                    <div className="font-medium text-slate-800 break-all">{value || "—"}</div>
                  </div>
                );
                return (
                  <div key={kind} className="border rounded-md p-3 bg-white" data-testid={`audit-block-${kind}`}>
                    <div className="font-semibold mb-2 text-indigo-700">{titleAr}</div>
                    <Row icon={UserIcon} label="المستخدم" value={ev.username || (ev.userId ? `#${ev.userId}` : null)} />
                    <Row icon={Clock}    label="الوقت"    value={fmtAt(ev.at)} />
                    <Row icon={MapPin}   label="IP"       value={ev.ip} />
                    <Row icon={Globe2}   label="الدولة"  value={ev.country} />
                    <Row icon={Monitor}  label="الجهاز"  value={ev.device} />
                    {ev.userAgent && (
                      <details className="mt-2">
                        <summary className="text-[10px] text-slate-500 cursor-pointer">User-Agent الكامل</summary>
                        <div className="text-[10px] text-slate-600 mt-1 break-all">{ev.userAgent}</div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          <DialogFooter className="flex-row-reverse gap-2">
            <Button variant="outline" onClick={() => setAuditId(null)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("journalEntries.confirmDelete")}</AlertDialogTitle>
            <AlertDialogDescription>{t("journalEntries.confirmDeleteDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>{t("journalEntries.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            >
              {t("journalEntries.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Convert orphaned locked entry → general draft */}
      <AlertDialog open={convertId !== null} onOpenChange={() => setConvertId(null)}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle>تحويل إلى قيد عام (مسودة)</AlertDialogTitle>
            <AlertDialogDescription>
              هذا القيد يتيم (أُنشئ تلقائياً من مستند مصدر لم يعد موجوداً). سيتم تحويله إلى قيد
              عام بحالة «مسودة» مع الاحتفاظ برقم المستند كما هو — بحيث لا تنشأ فجوة في تسلسل
              الأرقام، وبلا أي أثر على التقارير. بعدها يمكنك تعديله أو حذفه كأي قيد يدوي. متابعة؟
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>{t("journalEntries.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={convertMutation.isPending}
              onClick={(e) => { e.preventDefault(); convertId && convertMutation.mutate(convertId); }}
            >
              {convertMutation.isPending ? "جارٍ التحويل…" : "تحويل"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk-delete confirm */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("journalEntries.confirmDelete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {`سيتم محاولة حذف ${selectedIds.length} قيد. القيود المرحَّلة أو المرتبطة بمستند مصدر سيتم تجاوزها.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>{t("journalEntries.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmBulkDelete}
            >
              {`${t("journalEntries.delete")} (${selectedIds.length})`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
