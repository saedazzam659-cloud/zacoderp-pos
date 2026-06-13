import { useEffect, useMemo, useState } from "react";
import {
  listJournalEntries, postingCenterPost, postingCenterUnpost,
  type JournalEntry,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, ErrorMsg, Empty,
  btnPrimary, btnSecondary, fmt, input,
} from "./_adminUi";
import { currencySymbol } from "../lib/currency";

type StatusFilter = "draft" | "posted" | "all";

// "نوع الحركة" filter — each entry maps a user-facing module to the set of
// journal_entries_local.source_type values it covers. "" = all modules. The
// posting center aggregates EVERY module through its journal entry, so this is
// purely a client-side filter over the already-fetched rows; the post / unpost
// math stays untouched in its original module.
const MODULE_FILTERS: { value: string; label: string; match: (s: string | null) => boolean }[] = [
  { value: "", label: "كل الأنواع", match: () => true },
  { value: "sales_invoice", label: "فواتير المبيعات", match: (s) => s === "sales_invoice" },
  { value: "purchase_invoice", label: "فواتير المشتريات", match: (s) => s === "purchase_invoice" || s === "purchase" },
  { value: "sales_return", label: "مرتجعات المبيعات", match: (s) => s === "sales_return" },
  { value: "purchase_return", label: "مرتجعات المشتريات", match: (s) => s === "purchase_return" },
  { value: "voucher", label: "السندات", match: (s) => s === "voucher" },
  { value: "treasury_transfer", label: "تحويلات الخزينة", match: (s) => s === "treasury_transfer" },
  { value: "closing", label: "قيود الإقفال", match: (s) => s === "closing" },
  { value: "manual", label: "القيود اليدوية", match: (s) => s == null || s === "manual" },
];

const SOURCE_LABEL: Record<string, string> = {
  sales_invoice: "فاتورة مبيعات",
  purchase_invoice: "فاتورة مشتريات",
  purchase: "فاتورة مشتريات",
  sales_return: "مرتجع مبيعات",
  purchase_return: "مرتجع مشتريات",
  voucher: "سند",
  treasury_transfer: "تحويل خزينة",
  closing: "قيد إقفال",
  manual: "يدوي",
};

const ENTRY_TYPE_LABEL: Record<string, string> = {
  general: "قيد عام",
  opening: "قيد افتتاحي",
  closing: "قيد إقفال",
  adjustment: "قيد تسوية",
  depreciation: "قيد إهلاك",
};

function sourceLabel(source: string | null): string {
  if (source == null) return "يدوي";
  return SOURCE_LABEL[source] ?? source;
}

function StatusTag({ status }: { status: JournalEntry["status"] }) {
  const m = status === "posted"
    ? { l: "مرحّل", c: "#15803d" }
    : { l: "مسودة", c: "#b45309" };
  return (
    <span style={{ background: m.c + "20", color: m.c, padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
      {m.l}
    </span>
  );
}

export default function PostingCenter() {
  const [rows, setRows] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("draft");
  const [moduleFilter, setModuleFilter] = useState<string>("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    setLoading(true); setErr(null);
    try {
      const list = await listJournalEntries(500);
      setRows(list);
    } catch (e: any) {
      setErr(e?.message ?? "فشل تحميل القيود");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    const mod = MODULE_FILTERS.find((m) => m.value === moduleFilter) ?? MODULE_FILTERS[0];
    return rows.filter(
      (e) =>
        (statusFilter === "all" || e.status === statusFilter) &&
        mod.match(e.sourceType),
    );
  }, [rows, statusFilter, moduleFilter]);

  // Drop any selections no longer visible under the current filter.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(filtered.map((e) => e.id));
      const next = new Set<number>();
      for (const id of prev) if (visible.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [filtered]);

  const allVisibleSelected = filtered.length > 0 && filtered.every((e) => selected.has(e.id));

  function toggleAll() {
    setSelected((prev) => {
      if (filtered.every((e) => prev.has(e.id)) && filtered.length > 0) {
        const next = new Set(prev);
        for (const e of filtered) next.delete(e.id);
        return next;
      }
      const next = new Set(prev);
      for (const e of filtered) next.add(e.id);
      return next;
    });
  }
  function toggleRow(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const selectedRows = useMemo(
    () => rows.filter((e) => selected.has(e.id)),
    [rows, selected],
  );
  const selectedDraftIds = useMemo(
    () => selectedRows.filter((e) => e.status === "draft").map((e) => e.id),
    [selectedRows],
  );
  const selectedPostedIds = useMemo(
    () => selectedRows.filter((e) => e.status === "posted").map((e) => e.id),
    [selectedRows],
  );

  async function doPost() {
    if (selectedDraftIds.length === 0) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      const count = await postingCenterPost(selectedDraftIds);
      setSelected(new Set());
      await refresh();
      setNotice(`تم ترحيل ${count} قيد`);
    } catch (e: any) {
      setErr(e?.message ?? "فشل الترحيل");
    } finally {
      setBusy(false);
    }
  }

  async function doUnpost() {
    if (selectedPostedIds.length === 0) return;
    if (!confirm(`إلغاء ترحيل ${selectedPostedIds.length} قيد؟ ستُعاد لحالة مسودة وتُلغى آثارها على الأرصدة.`)) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      const count = await postingCenterUnpost(selectedPostedIds);
      setSelected(new Set());
      await refresh();
      setNotice(`تم إلغاء ترحيل ${count} قيد`);
    } catch (e: any) {
      setErr(e?.message ?? "فشل إلغاء الترحيل");
    } finally {
      setBusy(false);
    }
  }

  const sym = currencySymbol();
  const tabs: { value: StatusFilter; label: string }[] = [
    { value: "draft", label: "غير المرحّلة" },
    { value: "posted", label: "المرحّلة" },
    { value: "all", label: "الكل" },
  ];

  return (
    <Page title="مركز الترحيل" subtitle="ترحيل وإلغاء ترحيل القيود والمستندات">
      <Card style={{ marginBottom: 12 }}>
        <div style={{ padding: 12, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 4 }}>
            {tabs.map((t) => (
              <button key={t.value} type="button" onClick={() => setStatusFilter(t.value)}
                style={{ ...(statusFilter === t.value ? btnPrimary : btnSecondary), padding: "6px 14px" }}>
                {t.label}
              </button>
            ))}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#475569" }}>
            نوع الحركة:
            <select value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)}
              style={{ ...input, width: "auto", padding: "6px 10px" }}>
              {MODULE_FILTERS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
          <span style={{ color: "#64748b", fontSize: 13 }}>{filtered.length} قيد — {selected.size} محدد</span>
        </div>
      </Card>

      {err && <ErrorMsg text={err} />}
      {notice && (
        <div style={{ padding: 8, background: "#f0fdf4", color: "#15803d", border: "1px solid #bbf7d0", borderRadius: 6, fontSize: 13, marginBottom: 8 }}>
          ✓ {notice}
        </div>
      )}

      <Card>
        {loading ? (
          <Empty text="... جاري التحميل" />
        ) : filtered.length === 0 ? (
          <Empty text="لا توجد قيود مطابقة" />
        ) : (
          <Table>
            <thead><tr>
              <Th style={{ width: 40 }}>
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label="تحديد الكل" />
              </Th>
              <Th>رقم القيد</Th>
              <Th>التاريخ</Th>
              <Th>البيان</Th>
              <Th>المصدر</Th>
              <Th>النوع</Th>
              <Th style={{ textAlign: "left" }}>مدين</Th>
              <Th style={{ textAlign: "left" }}>دائن</Th>
              <Th>الحالة</Th>
            </tr></thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id} style={{ background: selected.has(e.id) ? "#eff6ff" : undefined }}>
                  <Td>
                    <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleRow(e.id)} aria-label={`تحديد ${e.entryNo}`} />
                  </Td>
                  <Td mono style={{ fontWeight: 600 }}>{e.entryNo}</Td>
                  <Td>{e.entryDate}</Td>
                  <Td>{e.description ?? "—"}</Td>
                  <Td>{sourceLabel(e.sourceType)}</Td>
                  <Td>{ENTRY_TYPE_LABEL[e.entryType] ?? e.entryType}</Td>
                  <Td num>{fmt(e.totalDebit)} {sym}</Td>
                  <Td num>{fmt(e.totalCredit)} {sym}</Td>
                  <Td><StatusTag status={e.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", marginTop: 12 }}>
        <span style={{ color: "#64748b", fontSize: 13, marginInlineEnd: "auto" }}>
          {selectedDraftIds.length} مسودة · {selectedPostedIds.length} مرحّل محدد
        </span>
        <button type="button" onClick={() => void doPost()}
          disabled={busy || selectedDraftIds.length === 0}
          style={{ ...btnPrimary, opacity: (busy || selectedDraftIds.length === 0) ? 0.5 : 1, cursor: (busy || selectedDraftIds.length === 0) ? "not-allowed" : "pointer" }}>
          ترحيل المحدد ({selectedDraftIds.length})
        </button>
        <button type="button" onClick={() => void doUnpost()}
          disabled={busy || selectedPostedIds.length === 0}
          style={{ ...btnSecondary, opacity: (busy || selectedPostedIds.length === 0) ? 0.5 : 1, cursor: (busy || selectedPostedIds.length === 0) ? "not-allowed" : "pointer" }}>
          إلغاء ترحيل المحدد ({selectedPostedIds.length})
        </button>
      </div>
    </Page>
  );
}
