import { useEffect, useMemo, useState } from "react";
import {
  listJournalEntries, postingCenterPost, postingCenterUnpost,
  postingCenterDocuments, postSalesInvoice, postPurchase, financialTxPost,
  type JournalEntry, type UnpostedDoc,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, ErrorMsg, Empty,
  btnPrimary, btnSecondary, fmt, input,
} from "./_adminUi";
import { currencySymbol } from "../lib/currency";
import { useDataRefresh } from "../lib/dataBus";

type StatusFilter = "draft" | "posted" | "all";

// A unified posting-center row. Two shapes share the grid:
//   • kind "je"  — a journal entry (draft manual JEs + ALL posted JEs).
//   • kind "doc" — an UNPOSTED source document (draft sales/purchase invoice or
//                  voucher) that has NO journal entry yet. Posting it creates
//                  the JE via the document's own post path.
type Row = {
  key: string;                 // "je:<id>" | "<docType>:<id>" — unique across tables
  kind: "je" | "doc";
  id: number;
  no: string;
  date: string;
  description: string | null;
  source: string | null;       // source_type / voucher tx_type — drives label
  party: string | null;
  debit: number;
  credit: number;
  status: "draft" | "posted";
  docType?: UnpostedDoc["docType"];      // doc rows only
};

// "نوع الحركة" filter — each entry maps a user-facing module to the set of
// source_type values it covers. "" = all modules. Purely a client-side filter.
const MODULE_FILTERS: { value: string; label: string; match: (s: string | null) => boolean }[] = [
  { value: "", label: "كل الأنواع", match: () => true },
  { value: "sales_customers", label: "المبيعات والعملاء", match: (s) => s === "sale" || s === "sale_cogs" },
  { value: "sales_customers_return", label: "مرتجعات المبيعات والعملاء", match: (s) => s === "sale_return" || s === "sale_return_cogs" },
  { value: "pos_sale", label: "مبيعات نقاط البيع", match: (s) => s === "pos_sale" || s === "pos_sale_cogs" },
  { value: "pos_return", label: "مرتجعات نقاط البيع", match: (s) => s === "pos_return" || s === "pos_return_cogs" },
  { value: "purchase", label: "فواتير المشتريات", match: (s) => s === "purchase" },
  { value: "purchase_return", label: "مرتجعات المشتريات", match: (s) => s === "purchase_return" },
  { value: "goods_receipt", label: "سندات الاستلام", match: (s) => s === "goods_receipt" },
  { value: "voucher", label: "السندات (قبض/صرف)", match: (s) => s === "receipt" || s === "payment" },
  { value: "supplier_settlement", label: "تسوية الموردين", match: (s) => s === "supplier_settlement" },
  { value: "treasury_transfer", label: "تحويلات الخزينة", match: (s) => s === "treasury_transfer" },
  { value: "opening_balance", label: "الأرصدة الافتتاحية", match: (s) => s === "opening_balance" },
  { value: "lc_funding", label: "تمويل الاعتمادات", match: (s) => s === "lc_funding" },
  { value: "closing", label: "قيود الإقفال", match: (s) => s === "closing" },
  { value: "manual", label: "القيود اليدوية", match: (s) => s == null || s === "manual" },
];

const SOURCE_LABEL: Record<string, string> = {
  sale: "فاتورة مبيعات",
  sale_cogs: "تكلفة بضاعة مباعة",
  sale_return: "مرتجع مبيعات",
  sale_return_cogs: "عكس تكلفة بضاعة مباعة",
  pos_sale: "فاتورة نقاط بيع",
  pos_sale_cogs: "تكلفة بضاعة - نقاط بيع",
  pos_return: "مرتجع نقاط بيع",
  pos_return_cogs: "عكس تكلفة - نقاط بيع",
  purchase: "فاتورة مشتريات",
  purchase_return: "مرتجع مشتريات",
  goods_receipt: "سند استلام",
  supplier_settlement: "تسوية مورد",
  receipt: "سند قبض",
  payment: "سند صرف",
  treasury_transfer: "تحويل خزينة",
  opening_balance: "رصيد افتتاحي",
  lc_funding: "تمويل اعتماد",
  closing: "قيد إقفال",
  manual: "يدوي",
};

function sourceLabel(source: string | null): string {
  if (source == null) return "يدوي";
  return SOURCE_LABEL[source] ?? source;
}

function StatusTag({ status }: { status: Row["status"] }) {
  const m = status === "posted"
    ? { l: "مرحّل", c: "#15803d" }
    : { l: "غير مرحّل", c: "#b45309" };
  return (
    <span style={{ background: m.c + "20", color: m.c, padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
      {m.l}
    </span>
  );
}

function jeToRow(e: JournalEntry): Row {
  return {
    key: `je:${e.id}`, kind: "je", id: e.id, no: e.entryNo, date: e.entryDate,
    description: e.description, source: e.sourceType, party: null,
    debit: e.totalDebit, credit: e.totalCredit, status: e.status,
  };
}

function docToRow(d: UnpostedDoc): Row {
  return {
    key: `${d.docType}:${d.id}`, kind: "doc", id: d.id, no: d.docNo, date: d.docDate,
    description: d.description, source: d.sourceType, party: d.partyName,
    debit: d.total, credit: d.total, status: "draft", docType: d.docType,
  };
}

export default function PostingCenter() {
  const [jes, setJes] = useState<JournalEntry[]>([]);
  const [docs, setDocs] = useState<UnpostedDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("draft");
  const [moduleFilter, setModuleFilter] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    setLoading(true); setErr(null);
    try {
      const [jeList, docList] = await Promise.all([
        listJournalEntries(500),
        postingCenterDocuments(),
      ]);
      setJes(jeList);
      setDocs(docList);
    } catch (e: any) {
      setErr(e?.message ?? "فشل تحميل القيود");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);
  // Auto-refresh when any document/journal entry changes elsewhere in the app.
  useDataRefresh(["journal", "invoices", "vouchers"], () => { void refresh(); });

  // Unified rows: every unposted document (no JE yet) + every journal entry.
  const allRows = useMemo<Row[]>(
    () => [...docs.map(docToRow), ...jes.map(jeToRow)],
    [docs, jes],
  );

  const filtered = useMemo(() => {
    const mod = MODULE_FILTERS.find((m) => m.value === moduleFilter) ?? MODULE_FILTERS[0];
    return allRows.filter(
      (r) =>
        (statusFilter === "all" || r.status === statusFilter) &&
        mod.match(r.source),
    );
  }, [allRows, statusFilter, moduleFilter]);

  // Drop any selections no longer visible under the current filter.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(filtered.map((r) => r.key));
      const next = new Set<string>();
      for (const k of prev) if (visible.has(k)) next.add(k);
      return next.size === prev.size ? prev : next;
    });
  }, [filtered]);

  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.key));

  function toggleAll() {
    setSelected((prev) => {
      if (filtered.every((r) => prev.has(r.key)) && filtered.length > 0) {
        const next = new Set(prev);
        for (const r of filtered) next.delete(r.key);
        return next;
      }
      const next = new Set(prev);
      for (const r of filtered) next.add(r.key);
      return next;
    });
  }
  function toggleRow(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const selectedRows = useMemo(
    () => filtered.filter((r) => selected.has(r.key)),
    [filtered, selected],
  );
  const selectedDraft = useMemo(
    () => selectedRows.filter((r) => r.status === "draft"),
    [selectedRows],
  );
  const selectedPosted = useMemo(
    () => selectedRows.filter((r) => r.status === "posted"),
    [selectedRows],
  );

  async function doPost() {
    if (selectedDraft.length === 0) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      let count = 0;
      // Draft DOCUMENTS post through their own per-type post path (each creates
      // the journal entry + applies stock / shadow on post). Draft JEs (manual +
      // any remaining source-type drafts) go through the bulk posting center.
      for (const r of selectedDraft) {
        if (r.kind !== "doc") continue;
        if (r.docType === "sale") await postSalesInvoice(r.id);
        else if (r.docType === "purchase") await postPurchase(r.id);
        else if (r.docType === "voucher") await financialTxPost(r.id);
        count++;
      }
      const jeIds = selectedDraft.filter((r) => r.kind === "je").map((r) => r.id);
      if (jeIds.length > 0) count += await postingCenterPost(jeIds);
      setSelected(new Set());
      await refresh();
      setNotice(`تم ترحيل ${count} مستند`);
    } catch (e: any) {
      setErr(e?.message ?? "فشل الترحيل");
    } finally {
      setBusy(false);
    }
  }

  async function doUnpost() {
    if (selectedPosted.length === 0) return;
    if (!confirm(`إلغاء ترحيل ${selectedPosted.length} مستند؟ ستُعاد لحالة غير مرحّل وتُلغى آثارها على الأرصدة.`)) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      // Posted rows are always journal entries (a posted document carries its
      // JE). The posting center unpost cascades source-doc JEs to the document's
      // own unpost (deletes JE + reverses stock/shadow).
      const jeIds = selectedPosted.filter((r) => r.kind === "je").map((r) => r.id);
      const count = jeIds.length > 0 ? await postingCenterUnpost(jeIds) : 0;
      setSelected(new Set());
      await refresh();
      setNotice(`تم إلغاء ترحيل ${count} مستند`);
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
          <span style={{ color: "#64748b", fontSize: 13 }}>{filtered.length} مستند — {selected.size} محدد</span>
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
          <Empty text="لا توجد مستندات مطابقة" />
        ) : (
          <Table>
            <thead><tr>
              <Th style={{ width: 40 }}>
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label="تحديد الكل" />
              </Th>
              <Th>الرقم</Th>
              <Th>التاريخ</Th>
              <Th>البيان</Th>
              <Th>المصدر</Th>
              <Th>الطرف</Th>
              <Th style={{ textAlign: "left" }}>مدين</Th>
              <Th style={{ textAlign: "left" }}>دائن</Th>
              <Th>الحالة</Th>
            </tr></thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.key} style={{ background: selected.has(r.key) ? "#eff6ff" : undefined }}>
                  <Td>
                    <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggleRow(r.key)} aria-label={`تحديد ${r.no}`} />
                  </Td>
                  <Td mono style={{ fontWeight: 600 }}>{r.no}</Td>
                  <Td>{r.date}</Td>
                  <Td>{r.description ?? "—"}</Td>
                  <Td>{sourceLabel(r.source)}</Td>
                  <Td>{r.party ?? "—"}</Td>
                  <Td num>{fmt(r.debit)} {sym}</Td>
                  <Td num>{fmt(r.credit)} {sym}</Td>
                  <Td><StatusTag status={r.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", marginTop: 12 }}>
        <span style={{ color: "#64748b", fontSize: 13, marginInlineEnd: "auto" }}>
          {selectedDraft.length} غير مرحّل · {selectedPosted.length} مرحّل محدد
        </span>
        <button type="button" onClick={() => void doPost()}
          disabled={busy || selectedDraft.length === 0}
          style={{ ...btnPrimary, opacity: (busy || selectedDraft.length === 0) ? 0.5 : 1, cursor: (busy || selectedDraft.length === 0) ? "not-allowed" : "pointer" }}>
          ترحيل المحدد ({selectedDraft.length})
        </button>
        <button type="button" onClick={() => void doUnpost()}
          disabled={busy || selectedPosted.length === 0}
          style={{ ...btnSecondary, opacity: (busy || selectedPosted.length === 0) ? 0.5 : 1, cursor: (busy || selectedPosted.length === 0) ? "not-allowed" : "pointer" }}>
          إلغاء ترحيل المحدد ({selectedPosted.length})
        </button>
      </div>
    </Page>
  );
}
