// Bulk invoice import (Task #228) — upload many invoices from an Excel/CSV
// file instead of keying each one into the POS register.
//
// Flow: upload/paste → "معاينة والتحقق" parses + validates every row against
// ZATCA rules → operator sees valid/invalid invoices with plain-Arabic
// reasons and can FIX FIELDS INLINE (re-validates live) or re-upload → only
// fully-valid invoices are created, each through the SAME offline-invoice
// path the register uses (generateZatcaQr + saveOfflineInvoice), so they
// land in the normal pending → sync → ZATCA submission flow. Rejected
// invoices are NEVER silently dropped — they stay on screen with reasons.

import { useMemo, useRef, useState } from "react";
import { listItems, type LocalItem } from "../lib/items";
import { listCustomers, type LocalCustomer } from "../lib/customers";
import { useTaxSettings } from "../lib/taxSettings";
import { generateZatcaQr } from "../lib/zatca";
import { saveOfflineInvoice } from "../lib/invoices";
import {
  parseInvoiceCsv,
  validateInvoices,
  buildInvoicePayload,
  ImportParseError,
  SAMPLE_INVOICE_CSV,
  type ImportRowDraft,
  type ValidatedInvoice,
} from "../lib/invoiceImport";

type Props = { sellerName?: string; sellerVat?: string };

type CommitResult = {
  created: number;
  invoiceNos: string[];
  failed: number;
};

export default function InvoiceImport({
  sellerName = "ZACOD POS",
  sellerVat = "300000000000003",
}: Props) {
  const tax = useTaxSettings();
  const [csvText, setCsvText] = useState("");
  const [drafts, setDrafts] = useState<ImportRowDraft[] | null>(null);
  const [items, setItems] = useState<LocalItem[]>([]);
  const [customers, setCustomers] = useState<LocalCustomer[]>([]);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const requireSaVat = (tax.country || "SA").toUpperCase() === "SA";

  const invoices = useMemo<ValidatedInvoice[] | null>(() => {
    if (!drafts) return null;
    return validateInvoices(drafts, {
      items,
      customers,
      defaultVatRate: tax.rate,
      taxMode: tax.mode,
      requireSaVatFormat: requireSaVat,
    });
  }, [drafts, items, customers, tax.rate, tax.mode, requireSaVat]);

  const summary = useMemo(() => {
    if (!invoices) return null;
    const valid = invoices.filter((i) => i.valid).length;
    const invalid = invoices.length - valid;
    const lines = invoices.reduce((s, i) => s + i.lines.length, 0);
    const total = invoices.filter((i) => i.valid).reduce((s, i) => s + i.grandTotal, 0);
    return { valid, invalid, lines, invoices: invoices.length, total };
  }, [invoices]);

  async function buildPreview() {
    setToast(null);
    setResult(null);
    if (!csvText.trim()) {
      setToast({ kind: "err", text: "الصق محتوى الملف أو ارفعه أولاً." });
      return;
    }
    try {
      const parsed = parseInvoiceCsv(csvText);
      const [its, custs] = await Promise.all([listItems(), listCustomers()]);
      setItems(its);
      setCustomers(custs);
      setDrafts(parsed);
    } catch (e) {
      const msg = e instanceof ImportParseError ? e.message : (e as any)?.message ?? "تعذّر قراءة الملف.";
      setToast({ kind: "err", text: msg });
      setDrafts(null);
    }
  }

  /** Patch a single line-level field (qty/unitPrice/vatRate/itemCode/barcode/itemName). */
  function patchRow(rowNum: number, patch: Partial<ImportRowDraft>) {
    setDrafts((prev) => prev?.map((d) => (d.rowNum === rowNum ? { ...d, ...patch } : d)) ?? prev);
  }

  /** Patch an invoice-level field across every row sharing the same ref. */
  function patchInvoice(inv: ValidatedInvoice, patch: Partial<ImportRowDraft>) {
    const rowNums = new Set(inv.lines.map((l) => l.draft.rowNum));
    setDrafts((prev) => prev?.map((d) => (rowNums.has(d.rowNum) ? { ...d, ...patch } : d)) ?? prev);
  }

  async function commit() {
    if (!invoices) return;
    const valids = invoices.filter((i) => i.valid);
    if (valids.length === 0) {
      setToast({ kind: "err", text: "لا توجد فواتير صالحة للإنشاء — صحّح الأخطاء أولاً." });
      return;
    }
    setCommitting(true);
    setToast(null);
    const invoiceNos: string[] = [];
    // Only rows whose invoice actually SAVED are removed afterwards — a failed
    // save keeps its rows on screen so the operator can retry (never dropped).
    const savedRowNums = new Set<number>();
    let failed = 0;
    try {
      for (const inv of valids) {
        const ts = new Date().toISOString();
        const payload = buildInvoicePayload(inv, ts);
        try {
          const qr = await generateZatcaQr({
            sellerName,
            vatNumber: sellerVat,
            timestamp: ts,
            invoiceTotal: inv.grandTotal.toFixed(2),
            vatTotal: inv.vat.toFixed(2),
          });
          const key =
            (crypto as any).randomUUID?.() ??
            `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
          const saved = await saveOfflineInvoice(payload, qr ?? undefined, undefined, key);
          invoiceNos.push(saved.invoiceNo);
          for (const l of inv.lines) savedRowNums.add(l.draft.rowNum);
        } catch {
          failed += 1;
        }
      }
      setResult({ created: invoiceNos.length, invoiceNos, failed });
      // Remove ONLY successfully-saved invoices; invalid AND failed-to-save
      // invoices stay on screen with their reasons. Rejected rows are never dropped.
      setDrafts((prev) => {
        const remaining = prev?.filter((d) => !savedRowNums.has(d.rowNum)) ?? [];
        return remaining.length ? remaining : null;
      });
      if (failed > 0) {
        setToast({ kind: "err", text: `تم إنشاء ${invoiceNos.length} فاتورة، وفشل حفظ ${failed}. الفواتير الفاشلة لا تزال ظاهرة — حاول مجددًا.` });
      }
    } finally {
      setCommitting(false);
    }
  }

  async function downloadTemplate() {
    const withBom = "\uFEFF" + SAMPLE_INVOICE_CSV;
    const isTauri =
      typeof window !== "undefined" &&
      ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
    if (isTauri) {
      try {
        const { invoke } = await import("../lib/tauri-shim");
        const saved = await invoke<string | null>("save_text_file", {
          content: withBom,
          suggestedName: "invoice_import_template.csv",
          filterName: "CSV",
          filterExt: "csv",
        });
        if (saved) setToast({ kind: "ok", text: `✅ تم حفظ النموذج: ${saved}` });
        return;
      } catch {
        /* fall through to anchor */
      }
    }
    const blob = new Blob([withBom], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "invoice_import_template.csv";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { setCsvText(String(reader.result ?? "")); setDrafts(null); setResult(null); };
    reader.readAsText(f, "utf-8");
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.header}>
        <div>
          <h2 style={S.h2}>استيراد الفواتير من ملف</h2>
          <div style={S.sub}>ارفع عدة فواتير دفعة واحدة من Excel/CSV — يتم التحقق من كل صف وفق متطلبات ZATCA قبل الإنشاء.</div>
        </div>
        <button onClick={downloadTemplate} style={S.btnGhost}>📥 تحميل نموذج CSV</button>
      </div>

      <div style={S.infoBox}>
        <b>كيف يعمل:</b> كل صف = بند فاتورة. الصفوف التي تحمل نفس <code>invoiceRef</code> تُجمَّع في فاتورة واحدة
        (اترك العمود فارغًا لتصبح كل صف فاتورة مستقلة). الفاتورة الضريبية <code>standard</code> تتطلب اسم العميل
        ورقمه الضريبي (15 رقمًا). يُعاد احتساب الضريبة تلقائيًا من الكمية × السعر — لا يُعتمد على إجمالي الملف.
      </div>

      <div style={S.section}>
        <div style={S.label}>الملف</div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={S.file} />
          <span style={S.muted}>أو الصق محتوى الملف بالأسفل</span>
        </div>
      </div>

      <textarea
        value={csvText}
        onChange={(e) => { setCsvText(e.target.value); setDrafts(null); setResult(null); }}
        placeholder={SAMPLE_INVOICE_CSV}
        rows={7}
        style={S.textarea}
      />

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={buildPreview} disabled={!csvText.trim() || committing} style={S.btnPrimary}>
          👁️ معاينة والتحقق
        </button>
        {invoices && (summary?.valid ?? 0) > 0 && (
          <button onClick={commit} disabled={committing} style={S.btnApply}>
            {committing ? "... جاري الإنشاء" : `✅ إنشاء الفواتير الصالحة (${summary?.valid})`}
          </button>
        )}
      </div>

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      {result && (
        <div style={S.successBox}>
          <div style={S.successTitle}>🎉 تم إنشاء {result.created} فاتورة بنجاح</div>
          {result.failed > 0 && <div style={S.successFail}>فشل {result.failed} فاتورة — لا تزال ظاهرة بالأسفل للمراجعة.</div>}
          {result.invoiceNos.length > 0 && (
            <div style={S.successNos}>
              {result.invoiceNos.slice(0, 12).map((n) => <span key={n} style={S.noChip}>{n}</span>)}
              {result.invoiceNos.length > 12 && <span style={S.muted}>+{result.invoiceNos.length - 12} أخرى</span>}
            </div>
          )}
          <div style={S.muted}>الفواتير المُنشأة متاحة الآن في «الفواتير غير المرفوعة» وستُرفع للسحابة عند المزامنة.</div>
        </div>
      )}

      {invoices && summary && (
        <div style={S.previewBox}>
          <div style={S.summaryRow}>
            <span style={S.chipOk}>✅ {summary.valid} صالحة</span>
            <span style={S.chipBad}>⛔ {summary.invalid} مرفوضة</span>
            <span style={S.chipTotal}>{summary.invoices} فاتورة · {summary.lines} بند</span>
            {summary.valid > 0 && <span style={S.chipMoney}>إجمالي الصالح: {summary.total.toFixed(2)}</span>}
          </div>

          {invoices.map((inv) => (
            <InvoiceCard
              key={inv.groupKey}
              inv={inv}
              onPatchRow={patchRow}
              onPatchInvoice={patchInvoice}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InvoiceCard({
  inv,
  onPatchRow,
  onPatchInvoice,
}: {
  inv: ValidatedInvoice;
  onPatchRow: (rowNum: number, patch: Partial<ImportRowDraft>) => void;
  onPatchInvoice: (inv: ValidatedInvoice, patch: Partial<ImportRowDraft>) => void;
}) {
  return (
    <div style={inv.valid ? S.cardOk : S.cardBad}>
      <div style={S.cardHead}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={inv.valid ? S.badgeOk : S.badgeBad}>{inv.valid ? "✅ صالحة" : "⛔ مرفوضة"}</span>
          <b style={{ fontSize: 14 }}>{inv.invoiceRef || "(بدون مرجع)"}</b>
          <select
            value={inv.invoiceType}
            onChange={(e) => onPatchInvoice(inv, { invoiceType: e.target.value })}
            style={S.headSelect}
          >
            <option value="simplified">مبسطة (Simplified)</option>
            <option value="standard">ضريبية (Standard)</option>
          </select>
          <select
            value={inv.paymentMethod}
            onChange={(e) => onPatchInvoice(inv, { paymentMethod: e.target.value })}
            style={S.headSelect}
          >
            <option value="cash">نقداً</option>
            <option value="card">بطاقة</option>
          </select>
        </div>
        <div style={S.cardTotals}>
          <span>الصافي {inv.subtotal.toFixed(2)}</span>
          <span>الضريبة {inv.vat.toFixed(2)}</span>
          <b>الإجمالي {inv.grandTotal.toFixed(2)}</b>
        </div>
      </div>

      <div style={S.custRow}>
        <label style={S.fieldLbl}>العميل
          <input
            value={inv.customerName}
            onChange={(e) => onPatchInvoice(inv, { customerName: e.target.value })}
            placeholder="اسم العميل"
            style={S.headInput}
          />
        </label>
        <label style={S.fieldLbl}>الرقم الضريبي
          <input
            value={inv.customerVat}
            onChange={(e) => onPatchInvoice(inv, { customerVat: e.target.value })}
            placeholder="15 رقمًا"
            style={{ ...S.headInput, direction: "ltr", textAlign: "left" }}
          />
        </label>
      </div>

      {inv.errors.length > 0 && (
        <ul style={S.errList}>
          {inv.errors.map((er, i) => <li key={i}>{er}</li>)}
        </ul>
      )}

      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>#</th>
            <th style={S.th}>الصنف (مطابَق)</th>
            <th style={S.th}>باركود</th>
            <th style={S.th}>كود</th>
            <th style={S.th}>الكمية</th>
            <th style={S.th}>سعر الوحدة</th>
            <th style={S.th}>%الضريبة</th>
            <th style={S.th}>الإجمالي</th>
            <th style={S.th}>الأخطاء والإصلاح المقترح</th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l) => (
            <tr key={l.draft.rowNum} style={l.errors.length ? S.rowBad : undefined}>
              <td style={S.td}>{l.draft.rowNum}</td>
              <td style={S.td}>{l.matchedItemName ?? <span style={S.muted}>{l.draft.itemName || "—"}</span>}</td>
              <td style={S.tdEdit}>
                <input value={l.draft.barcode} onChange={(e) => onPatchRow(l.draft.rowNum, { barcode: e.target.value })} style={S.cellMono} />
              </td>
              <td style={S.tdEdit}>
                <input value={l.draft.itemCode} onChange={(e) => onPatchRow(l.draft.rowNum, { itemCode: e.target.value })} style={S.cellMono} />
              </td>
              <td style={S.tdEdit}>
                <input value={l.draft.quantity} onChange={(e) => onPatchRow(l.draft.rowNum, { quantity: e.target.value })} style={S.cellNum} />
              </td>
              <td style={S.tdEdit}>
                <input value={l.draft.unitPrice} onChange={(e) => onPatchRow(l.draft.rowNum, { unitPrice: e.target.value })} style={S.cellNum} />
              </td>
              <td style={S.tdEdit}>
                <input value={l.draft.vatRate} onChange={(e) => onPatchRow(l.draft.rowNum, { vatRate: e.target.value })} placeholder="افتراضي" style={S.cellNum} />
              </td>
              <td style={S.tdNum}>{l.lineTotal.toFixed(2)}</td>
              <td style={S.tdErr}>{l.errors.join(" • ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const S = {
  wrap: { padding: 24, maxWidth: 1320, margin: "0 auto", display: "flex", flexDirection: "column" as const, gap: 14 } as const,
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12 } as const,
  h2: { fontSize: 22, fontWeight: 700, color: "#0f172a", margin: 0 } as const,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4, maxWidth: 760, lineHeight: 1.6 } as const,
  infoBox: { background: "#f0f9ff", border: "1px solid #bae6fd", color: "#075985", borderRadius: 10, padding: 12, fontSize: 12.5, lineHeight: 1.8 } as const,
  section: { display: "flex", flexDirection: "column" as const, gap: 8 } as const,
  label: { fontSize: 13, fontWeight: 600, color: "#334155" } as const,
  file: { padding: 8, border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "inherit" } as const,
  muted: { fontSize: 12, color: "#94a3b8" } as const,
  textarea: {
    width: "100%", padding: 12, fontFamily: "ui-monospace, monospace", fontSize: 12,
    border: "1px solid #cbd5e1", borderRadius: 8, direction: "ltr" as const,
    resize: "vertical" as const, boxSizing: "border-box" as const,
  } as const,
  btnPrimary: { padding: "10px 20px", background: "#0ea5e9", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 14, fontFamily: "inherit" } as const,
  btnApply: { padding: "10px 20px", background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 14, fontFamily: "inherit" } as const,
  btnGhost: { padding: "8px 14px", background: "#fff", color: "#0ea5e9", border: "1px solid #bae6fd", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 } as const,
  ok: { padding: 10, background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", borderRadius: 8, fontSize: 13 } as const,
  err: { padding: 10, background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 8, fontSize: 13 } as const,
  successBox: { background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column" as const, gap: 8 } as const,
  successTitle: { fontSize: 16, fontWeight: 800, color: "#166534" } as const,
  successFail: { fontSize: 13, color: "#b45309", fontWeight: 600 } as const,
  successNos: { display: "flex", gap: 6, flexWrap: "wrap" as const, alignItems: "center" } as const,
  noChip: { padding: "3px 10px", background: "#dcfce7", color: "#166534", borderRadius: 999, fontSize: 11, fontFamily: "ui-monospace, monospace" } as const,
  previewBox: { display: "flex", flexDirection: "column" as const, gap: 12 } as const,
  summaryRow: { display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "center" } as const,
  chipOk: { padding: "4px 12px", background: "#dcfce7", color: "#166534", borderRadius: 999, fontSize: 12, fontWeight: 700 } as const,
  chipBad: { padding: "4px 12px", background: "#fee2e2", color: "#991b1b", borderRadius: 999, fontSize: 12, fontWeight: 700 } as const,
  chipTotal: { padding: "4px 12px", background: "#f1f5f9", color: "#334155", borderRadius: 999, fontSize: 12, fontWeight: 700 } as const,
  chipMoney: { padding: "4px 12px", background: "#dbeafe", color: "#1e40af", borderRadius: 999, fontSize: 12, fontWeight: 700 } as const,
  cardOk: { background: "#fff", border: "1px solid #bbf7d0", borderRadius: 12, padding: 12, display: "flex", flexDirection: "column" as const, gap: 10 } as const,
  cardBad: { background: "#fffbfb", border: "1px solid #fecaca", borderRadius: 12, padding: 12, display: "flex", flexDirection: "column" as const, gap: 10 } as const,
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" as const } as const,
  badgeOk: { padding: "3px 10px", background: "#dcfce7", color: "#166534", borderRadius: 999, fontSize: 12, fontWeight: 700 } as const,
  badgeBad: { padding: "3px 10px", background: "#fee2e2", color: "#991b1b", borderRadius: 999, fontSize: 12, fontWeight: 700 } as const,
  headSelect: { padding: "4px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontFamily: "inherit", fontSize: 12, background: "#fff" } as const,
  cardTotals: { display: "flex", gap: 12, fontSize: 12, color: "#334155", alignItems: "center" } as const,
  custRow: { display: "flex", gap: 12, flexWrap: "wrap" as const } as const,
  fieldLbl: { display: "flex", flexDirection: "column" as const, gap: 4, fontSize: 11, color: "#64748b", fontWeight: 600 } as const,
  headInput: { padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontFamily: "inherit", fontSize: 13, minWidth: 220 } as const,
  errList: { margin: 0, paddingInlineStart: 18, color: "#b91c1c", fontSize: 12, lineHeight: 1.7 } as const,
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 12 } as const,
  th: { padding: "6px 8px", background: "#f8fafc", textAlign: "right" as const, borderBottom: "1px solid #e2e8f0", fontWeight: 700, color: "#475569", whiteSpace: "nowrap" as const } as const,
  td: { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const,
  tdEdit: { padding: "3px 4px", borderBottom: "1px solid #f1f5f9" } as const,
  tdNum: { padding: "6px 8px", borderBottom: "1px solid #f1f5f9", textAlign: "left" as const, fontWeight: 700, color: "#0f172a" } as const,
  tdErr: { padding: "6px 8px", borderBottom: "1px solid #f1f5f9", fontSize: 11, color: "#b91c1c", maxWidth: 360 } as const,
  rowBad: { background: "#fff5f5" } as const,
  cellMono: { width: "100%", padding: "4px 6px", border: "1px solid #e2e8f0", borderRadius: 5, fontFamily: "ui-monospace, monospace", fontSize: 11, direction: "ltr" as const, boxSizing: "border-box" as const } as const,
  cellNum: { width: 72, padding: "4px 6px", border: "1px solid #e2e8f0", borderRadius: 5, fontFamily: "ui-monospace, monospace", fontSize: 11, direction: "ltr" as const, textAlign: "left" as const, boxSizing: "border-box" as const } as const,
};
