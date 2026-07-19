/**
 * Shared "detailed" journal-entry print template.
 *
 * Single source of truth for the A4 journal-entry sheet used by BOTH:
 *   - the journal-entries LIST screen (blue print button / "تفصيلي مع الأطراف"
 *     bulk template), and
 *   - the journal-entry FORM's "طباعة" button,
 * so the two paths always produce byte-identical output.
 *
 * Callers pre-resolve everything screen-specific (account labels, entry-type
 * and status labels, cost-center labels) into plain strings so this module
 * stays free of react-query / i18n / auth dependencies.
 */
import { buildLetterheadHtml, letterheadCss, wrapWithLetterhead } from "@/lib/printLetterhead";
import { fmt2 } from "@/lib/format";

export interface JournalPrintLine {
  accountLabel: string;
  description?: string | null;
  debit: number;
  credit: number;
  costCenterLabel?: string | null;
}

export interface JournalPrintEntry {
  docNo: string;
  entryDate: string;
  typeLabel: string;
  statusLabel: string;
  description?: string | null;
  lines: JournalPrintLine[];
}

export interface JournalPrintLabels {
  sheetTitle: string;   // "القيود المحاسبية"
  doc: string;          // "رقم المستند"
  date: string;         // "التاريخ"
  type: string;         // "النوع"
  desc: string;         // "البيان"
  debit: string;        // "مدين"
  credit: string;       // "دائن"
  status: string;       // "الحالة"
  account: string;      // "الحساب"
  lineDesc: string;     // "البيان" (line-level)
  costCenter: string;   // "مركز التكلفة"
  lineNo: string;       // "م"
  subtotal: string;     // "الإجمالي"
  noLines: string;      // "لا توجد أطراف لهذا القيد."
  grandTotal: string;   // "الإجمالي العام"
  totalDebit: string;   // "إجمالي المدين"
  totalCredit: string;  // "إجمالي الدائن"
  printBtn: string;     // "طباعة PDF"
}

export interface JournalPrintOptions {
  company: any;                 // user.company — letterhead source
  isRtl: boolean;
  oneEntryPerPage?: boolean;
  labels: JournalPrintLabels;
  /** Overlay a big diagonal "مسودة • DRAFT" watermark (unsaved form print). */
  draftWatermark?: boolean;
}

const escapeHtml = (s: any) =>
  String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function buildDetailedJournalPrintHtml(
  entries: JournalPrintEntry[],
  opts: JournalPrintOptions,
): string {
  const { company, isRtl, labels: L } = opts;
  const oneEntryPerPage = !!opts.oneEntryPerPage;
  const dir = isRtl ? "rtl" : "ltr";
  const lang = isRtl ? "ar" : "en";
  const align = isRtl ? "right" : "left";
  // Per-user request (2026-07-19): journal prints use the SPLIT letterhead —
  // company block at the start side, brand mark (علامة تجارية) at the end
  // side, with a bigger logo (2× width / 1.5× height).
  const letterhead = buildLetterheadHtml(company, { accent: "navy", size: "md", layout: "split" });

  // Grand totals across every printed entry (footer banner — shown only when
  // more than one entry is printed; a single entry's subtotal row already
  // carries the same numbers, so repeating them would be the exact kind of
  // duplication we removed from the header).
  const grandDebit  = entries.reduce((s, e) => s + e.lines.reduce((a, l) => a + Number(l.debit  || 0), 0), 0);
  const grandCredit = entries.reduce((s, e) => s + e.lines.reduce((a, l) => a + Number(l.credit || 0), 0), 0);

  // The per-page title strip is shown when each entry is its own page —
  // and also for a single-entry print (form's طباعة button) so the sheet
  // still carries a document title. It intentionally shows ONLY the title:
  // doc number / date / type / status already live in the badges right
  // below it, printing them here too was the duplicated header bug.
  const showPageHead = oneEntryPerPage || entries.length === 1;

  const entrySections = entries.map((e) => {
    const lines = e.lines;
    const subDebit  = lines.reduce((s, ln) => s + Number(ln.debit  || 0), 0);
    const subCredit = lines.reduce((s, ln) => s + Number(ln.credit || 0), 0);

    const linesHtml = lines.length === 0
      ? `<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:10px;">${escapeHtml(L.noLines)}</td></tr>`
      : lines.map((ln, i) => `<tr>
          <td class="num center">${i + 1}</td>
          <td>${escapeHtml(ln.accountLabel)}</td>
          <td>${escapeHtml(ln.description ?? "")}</td>
          <td class="num end">${fmt2(ln.debit)}</td>
          <td class="num end">${fmt2(ln.credit)}</td>
          <td>${escapeHtml(ln.costCenterLabel ?? "")}</td>
        </tr>`).join("");

    const perPageHead = showPageHead ? `
  <header class="page-head">
    <div class="page-title">${escapeHtml(L.sheetTitle)}</div>
  </header>` : "";
    // Per-user request (2026-07-19): the standalone "إجمالي المدين / إجمالي
    // الدائن" strip under the table was removed — the tfoot الإجمالي row
    // already carries the same numbers.
    const perPageTotals = "";

    const sigRow = `
  <div class="sig-row">
    <div class="sig"><div class="sig-role">${isRtl ? "إعداد" : "Prepared By"}</div><div class="sig-line">${isRtl ? "الاسم والتوقيع" : "Name & Signature"}</div></div>
    <div class="sig"><div class="sig-role">${isRtl ? "مراجعة" : "Reviewed By"}</div><div class="sig-line">${isRtl ? "الاسم والتوقيع" : "Name & Signature"}</div></div>
    <div class="sig"><div class="sig-role">${isRtl ? "اعتماد" : "Approved By"}</div><div class="sig-line">${isRtl ? "الاسم والتوقيع" : "Name & Signature"}</div></div>
  </div>`;

    return `
<section class="entry">
  ${perPageHead}
  <div class="entry-head">
    <div class="entry-title">
      <span class="badge">${escapeHtml(L.doc)}: ${escapeHtml(e.docNo)}</span>
      <span class="badge">${escapeHtml(L.date)}: ${escapeHtml(e.entryDate)}</span>
      <span class="badge">${escapeHtml(L.type)}: ${escapeHtml(e.typeLabel)}</span>
      <span class="badge">${escapeHtml(L.status)}: ${escapeHtml(e.statusLabel)}</span>
    </div>
    ${e.description ? `<div class="entry-desc"><b>${escapeHtml(L.desc)}:</b> ${escapeHtml(e.description)}</div>` : ""}
  </div>
  <table class="lines">
    <thead>
      <tr>
        <th style="width:36px;">${escapeHtml(L.lineNo)}</th>
        <th>${escapeHtml(L.account)}</th>
        <th>${escapeHtml(L.lineDesc)}</th>
        <th style="width:90px;">${escapeHtml(L.debit)}</th>
        <th style="width:90px;">${escapeHtml(L.credit)}</th>
        <th style="width:120px;">${escapeHtml(L.costCenter)}</th>
      </tr>
    </thead>
    <tbody>${linesHtml}</tbody>
    <tfoot>
      <tr>
        <td colspan="3" class="end"><b>${escapeHtml(L.subtotal)}</b></td>
        <td class="num end"><b>${fmt2(subDebit)}</b></td>
        <td class="num end"><b>${fmt2(subCredit)}</b></td>
        <td></td>
      </tr>
    </tfoot>
  </table>
  ${perPageTotals}
  ${sigRow}
</section>`;
  }).join("");

  const watermark = opts.draftWatermark
    ? `<div style="position:fixed;top:40%;left:0;right:0;text-align:center;font-size:90px;font-weight:900;color:rgba(185,28,28,0.10);transform:rotate(-22deg);pointer-events:none;letter-spacing:8px;z-index:0;">مسودة • DRAFT</div>`
    : "";

  const grandBanner = entries.length > 1 ? `
<div class="grand">
  <span>${escapeHtml(L.grandTotal)} — ${escapeHtml(L.totalDebit)}: <b>${fmt2(grandDebit)}</b></span>
  <span>${escapeHtml(L.totalCredit)}: <b>${fmt2(grandCredit)}</b></span>
</div>` : "";

  return `<!DOCTYPE html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(L.sheetTitle)}</title>
<style>
@page { size: A4 portrait; margin: 7mm 8mm 13mm 8mm; @bottom-center { content: "صفحة " counter(page) " من " counter(pages); font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; font-size: 9pt; color: #475569; } }
@media print { thead { display: table-header-group; } .entry { page-break-inside: avoid; } ${oneEntryPerPage ? ".entry { page-break-after: always; } .entry:last-of-type { page-break-after: auto; }" : ""} }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; padding:0; direction:${dir}; }
${letterheadCss({ accent: "navy", size: "md", layout: "split" })}
.entry { margin: 0 0 14px; border:1px solid #cbd5e1; border-radius:6px; padding:6px 8px; background:#fff; }
.entry-head { margin-bottom:6px; }
.entry-title { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:4px; }
.badge { display:inline-block; padding:2px 8px; background:#eef2ff; color:#1e3a8a; border:1px solid #c7d2fe; border-radius:999px; font-size:10.5px; font-weight:600; }
.entry-desc { font-size:11px; color:#334155; margin-top:2px; }
table.lines { width:100%; border-collapse:collapse; font-size:10.5px; margin-top:4px; }
table.lines thead th { background:#1e3a8a; color:#fff; padding:4px 6px; border:1px solid #1e3a8a; text-align:${align}; font-weight:600; }
table.lines tbody td { padding:3px 6px; border:1px solid #d1d5db; text-align:${align}; }
table.lines tbody tr:nth-child(even) td { background:#f8fafc; }
table.lines tfoot td { padding:4px 6px; border:1px solid #cbd5e1; background:#f1f5f9; }
.num { font-family: "Consolas",monospace; }
/* Amount cells align RIGHT everywhere (international convention) — the
   tbody/tfoot selectors below outrank generic cell rules so body rows and
   the totals row always match (the old .end class left-aligned the tfoot
   totals in RTL while tbody amounts stayed right-aligned). */
.end { text-align:right; }
table.lines tbody td.num, table.lines tfoot td.num { text-align:right; }
.center { text-align:center; }
.grand { margin-top:6px; padding:8px 12px; background:#1e3a8a; color:#fff; border-radius:6px; display:flex; justify-content:space-between; gap:18px; font-size:12px; }
.page-head { text-align:center; margin: 0 0 6px; padding-bottom:4px; border-bottom:2px solid #1e3a8a; }
.page-head .page-title { margin:4px 0 2px; font-size:14px; font-weight:600; color:#1e3a8a; }
.page-totals { display:flex; gap:18px; justify-content:space-around; margin-top:6px; padding:6px 12px; background:#1e3a8a; color:#fff; border-radius:6px; font-size:12px; }
.page-totals span, .page-totals b { color:#fff; }
.sig-row { display:flex; justify-content:space-between; gap:24px; margin:14px 8px 2px; text-align:center; page-break-inside:avoid; }
.sig-row .sig { flex:1; }
.sig-row .sig-role { font-weight:700; font-size:12px; margin-bottom:22px; }
.sig-row .sig-line { border-top:1px solid #111; padding-top:5px; color:#475569; font-size:10px; max-width:180px; margin:0 auto; }
.print-btn { position:fixed; top:10px; ${isRtl ? "left" : "right"}:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">${escapeHtml(L.printBtn)}</button>
${watermark}
${wrapWithLetterhead(letterhead, `${entrySections}
${grandBanner}`)}
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
}

/** Shared localStorage key for the "قيد لكل صفحة" print preference. */
export const JE_ONE_PER_PAGE_LS_KEY = "zatca_je_one_per_page";
