import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Printer,
  Loader2,
  ChevronDown,
  FileText,
  Layers,
  ScrollText,
  Newspaper,
} from "lucide-react";
import { safeLogoSrc } from "@/lib/export";

/* ─────────────────────────────────────────────────────────────────────────
   Shared bulk-print toolkit used by every list screen that supports
   "select N rows, then print them in one of several layouts".

   Design: each page already has its own `summary` (one-row-per-doc table)
   and `detailed` (full doc with line items) HTML builders. Rather than
   re-implementing those for every doc kind, this module:

     • Exposes generic "professional" + "compact" template builders that
       work off a small `DocAdapter` per page (header + totals + lines).
     • Provides a `<BulkPrintMenu>` dropdown that wires the page's existing
       summary/detailed builders alongside the shared professional/compact
       ones AND a "كل قيد في صفحة منفصلة" toggle (persisted to
       localStorage per kind).

   The toggle works by post-processing whichever HTML the chosen template
   returned — we inject `@media print { .doc, .entry { page-break-after:
   always } ... :last-of-type { page-break-after: auto } }` right before
   `</head>`. This works because every existing detailed builder wraps each
   document in a `.doc` (or `.entry`) section. No template rewrites needed.
   ───────────────────────────────────────────────────────────────────────── */

export const escapeHtml = (s: any) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );

export function openPrintWindow(html: string, onBlocked?: () => void) {
  const w = window.open("", "_blank", "width=1100,height=800");
  if (!w) {
    onBlocked?.();
    return false;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}

/** Inject extra @media-print page-break CSS into a finished HTML string.
 *  No-op if `enabled` is false. Targets both `.doc` (invoice-like pages)
 *  and `.entry` (journal entries / vouchers) so it works everywhere. */
export function injectOneEntryPerPage(html: string, enabled: boolean): string {
  if (!enabled) return html;
  const css =
    "<style>@media print {" +
    " .doc, .entry, section.doc, section.entry { page-break-after: always !important; }" +
    " .doc:last-of-type, .entry:last-of-type, section.doc:last-of-type, section.entry:last-of-type { page-break-after: auto !important; }" +
    "}</style>";
  return html.includes("</head>") ? html.replace("</head>", `${css}</head>`) : `${css}${html}`;
}

/* ─── Doc adapter — what each page provides about its own doc shape ─── */

export interface DocAdapterHeader {
  docNo: string;
  date: string;
  partyName: string;
  statusKey: string;
  statusLabel: string;
  currency?: string;
  notes?: string;
}
export interface DocAdapterLine {
  name: string;
  qty: number;
  unit?: string;
  unitPrice: number;
  vatAmount: number;
  total: number;
}
export interface DocAdapterTotals {
  subtotal: number;
  vat: number;
  total: number;
  discount?: number;
}
export interface DocAdapter<T = any> {
  /** "sales-invoice" | "purchase-order" | etc. — used for localStorage key. */
  kind: string;
  /** Localized title shown on the print sheet header. */
  title: string;
  /** "فاتورة" / "أمر بيع" / "عرض سعر" — used in the per-doc banner. */
  docTypeLabel: string;
  /** Filename prefix for the modal title. */
  partyLabel: string; // "العميل" / "المورد"
  getHeader: (d: T) => DocAdapterHeader;
  getTotals: (d: T) => DocAdapterTotals;
  getLines: (d: T) => DocAdapterLine[];
}

/* ─── Generic template builders ──────────────────────────────────────── */

interface CompanyInfo {
  nameAr?: string | null;
  nameEn?: string | null;
  vatNumber?: string | null;
  crNumber?: string | null;
  logo?: string | null;
}

const STATUS_TONE: Record<string, string> = {
  posted:    "background:#d1fae5;color:#065f46;border-color:#6ee7b7;",
  confirmed: "background:#d1fae5;color:#065f46;border-color:#6ee7b7;",
  accepted:  "background:#d1fae5;color:#065f46;border-color:#6ee7b7;",
  draft:     "background:#fef3c7;color:#92400e;border-color:#fcd34d;",
  sent:      "background:#dbeafe;color:#1e40af;border-color:#93c5fd;",
  converted: "background:#e0e7ff;color:#3730a3;border-color:#a5b4fc;",
  cancelled: "background:#fee2e2;color:#991b1b;border-color:#fca5a5;",
  rejected:  "background:#fee2e2;color:#991b1b;border-color:#fca5a5;",
  voided:    "background:#fee2e2;color:#991b1b;border-color:#fca5a5;",
};

/** "Professional" — formal letterhead with banner + lines + signature
 *  block per doc. Mirrors the JournalEntries professional template so
 *  the whole app feels consistent. A4 portrait, one doc per section. */
export function buildProfessionalDocsHtml<T>(
  docs: T[],
  adapter: DocAdapter<T>,
  company: CompanyInfo | null | undefined,
): string {
  const today = new Date().toLocaleDateString("ar-SA");
  const safeLogo = safeLogoSrc(company?.logo) ?? "";
  const companyName = company?.nameAr ?? company?.nameEn ?? "";
  const vat = company?.vatNumber ?? "";
  const cr  = company?.crNumber ?? "";

  const sections = docs.map((d) => {
    const h = adapter.getHeader(d);
    const tot = adapter.getTotals(d);
    const lines = adapter.getLines(d);
    const tone = STATUS_TONE[h.statusKey] ?? STATUS_TONE.draft;
    const linesHtml = lines.length === 0
      ? `<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:14px;">لا توجد بنود لهذه الوثيقة</td></tr>`
      : lines.map((l, i) => `<tr>
          <td class="num center">${i + 1}</td>
          <td>${escapeHtml(l.name)}</td>
          <td class="num end">${l.qty.toFixed(2)}${l.unit ? ` <span style="color:#64748b;font-size:9pt;">${escapeHtml(l.unit)}</span>` : ""}</td>
          <td class="num end">${l.unitPrice.toFixed(2)}</td>
          <td class="num end">${l.vatAmount.toFixed(2)}</td>
          <td class="num end">${l.total.toFixed(2)}</td>
        </tr>`).join("");

    return `<section class="doc">
      <div class="banner">
        <div class="banner-l">
          <div class="docno">${escapeHtml(adapter.docTypeLabel)} رقم: <b>${escapeHtml(h.docNo)}</b></div>
          <div class="docmeta">
            التاريخ: ${escapeHtml(h.date)}
            ${h.currency ? ` • العملة: ${escapeHtml(h.currency)}` : ""}
            • ${escapeHtml(adapter.partyLabel)}: <b>${escapeHtml(h.partyName)}</b>
          </div>
        </div>
        <div class="banner-r">
          <div class="status" style="${tone}">${escapeHtml(h.statusLabel)}</div>
        </div>
      </div>
      ${h.notes ? `<div class="desc"><b>ملاحظات:</b> ${escapeHtml(h.notes)}</div>` : ""}
      <table>
        <thead>
          <tr>
            <th style="width:30px;">م</th>
            <th>الصنف / الوصف</th>
            <th style="width:90px;">الكمية</th>
            <th style="width:90px;">السعر</th>
            <th style="width:90px;">الضريبة</th>
            <th style="width:100px;">الإجمالي</th>
          </tr>
        </thead>
        <tbody>${linesHtml}</tbody>
        <tfoot>
          ${tot.discount && tot.discount > 0 ? `<tr><td colspan="5" class="end">الخصم</td><td class="num end">${tot.discount.toFixed(2)}</td></tr>` : ""}
          <tr><td colspan="5" class="end">المجموع قبل الضريبة</td><td class="num end">${tot.subtotal.toFixed(2)}</td></tr>
          <tr><td colspan="5" class="end">إجمالي الضريبة</td><td class="num end">${tot.vat.toFixed(2)}</td></tr>
          <tr><td colspan="5" class="end"><b>الإجمالي النهائي</b></td><td class="num end"><b>${tot.total.toFixed(2)}</b></td></tr>
        </tfoot>
      </table>
      <div class="signs">
        <div class="sign"><div class="sign-line"></div><div class="sign-label">المُعدّ</div></div>
        <div class="sign"><div class="sign-line"></div><div class="sign-label">المراجع</div></div>
        <div class="sign"><div class="sign-line"></div><div class="sign-label">الاعتماد</div></div>
      </div>
    </section>`;
  }).join("");

  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escapeHtml(adapter.title)} — تنسيق احترافي</title>
<style>
@page { size: A4 portrait; margin: 14mm 14mm 22mm 14mm; @bottom-center { content: "صفحة " counter(page) " من " counter(pages); font-family:"Segoe UI",sans-serif; font-size:9pt; color:#475569; } }
* { box-sizing: border-box; }
body { font-family:"Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; }
.letterhead { display:flex; align-items:center; gap:12px; padding-bottom:10px; border-bottom:3px double #1e3a8a; margin-bottom:14px; }
.letterhead img { max-height:60px; max-width:140px; object-fit:contain; }
.letterhead .co { flex:1; }
.letterhead .co h1 { margin:0; font-size:16pt; color:#1e3a8a; }
.letterhead .co .reg { font-size:9pt; color:#475569; margin-top:3px; }
.letterhead .stamp { text-align:left; font-size:9pt; color:#475569; }
.doc { page-break-inside: avoid; margin-bottom:18px; border:1px solid #cbd5e1; border-radius:8px; padding:10px 12px; }
.banner { display:flex; justify-content:space-between; align-items:center; padding:8px 10px; background:#eef2ff; border-radius:6px; margin-bottom:8px; border-right: 4px solid #1e3a8a; }
.banner .docno { font-size:11pt; color:#1e3a8a; }
.banner .docmeta { font-size:9.5pt; color:#475569; margin-top:2px; }
.status { padding:3px 10px; border-radius:999px; font-size:9pt; font-weight:600; border:1px solid; }
.desc { font-size:10pt; color:#1f2937; margin:4px 0 8px; padding:6px 10px; background:#f8fafc; border-radius:4px; }
table { width:100%; border-collapse:collapse; font-size:10pt; }
thead th { background:#1e3a8a; color:#fff; padding:6px 8px; border:1px solid #1e3a8a; text-align:right; }
tbody td { padding:5px 8px; border:1px solid #d1d5db; text-align:right; }
tbody tr:nth-child(even) td { background:#f8fafc; }
tfoot td { padding:6px 8px; border:1px solid #cbd5e1; background:#f1f5f9; }
.num { font-family:"Consolas",monospace; }
.end { text-align:left; }
.center { text-align:center; }
.signs { display:flex; justify-content:space-around; gap:14px; margin-top:22px; padding-top:6px; }
.sign { flex:1; text-align:center; }
.sign-line { border-top:1.5px solid #475569; margin-top:36px; }
.sign-label { margin-top:4px; font-size:9pt; color:#475569; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:11pt; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
<div class="letterhead">
  ${safeLogo ? `<img src="${safeLogo}" alt="" />` : ""}
  <div class="co">
    <h1>${escapeHtml(companyName)}</h1>
    <div class="reg">${cr ? `س.ت: ${escapeHtml(cr)}` : ""}${cr && vat ? " • " : ""}${vat ? `الرقم الضريبي: ${escapeHtml(vat)}` : ""}</div>
  </div>
  <div class="stamp">تاريخ الطباعة<br/><b>${escapeHtml(today)}</b><br/>${docs.length} ${escapeHtml(adapter.docTypeLabel)}</div>
</div>
${sections}
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
}

/** "Compact" — slim card per doc (header + totals only, no line items).
 *  Lets the user fit ~6 docs per A4 page. Useful for quick desk reviews. */
export function buildCompactDocsHtml<T>(
  docs: T[],
  adapter: DocAdapter<T>,
  company: CompanyInfo | null | undefined,
): string {
  const today = new Date().toLocaleDateString("ar-SA");
  const safeLogo = safeLogoSrc(company?.logo) ?? "";
  const companyName = company?.nameAr ?? company?.nameEn ?? "";
  const grand = docs.reduce((acc, d) => {
    const t = adapter.getTotals(d);
    acc.sub += t.subtotal; acc.vat += t.vat; acc.tot += t.total;
    return acc;
  }, { sub: 0, vat: 0, tot: 0 });
  const cards = docs.map((d) => {
    const h = adapter.getHeader(d);
    const t = adapter.getTotals(d);
    const tone = STATUS_TONE[h.statusKey] ?? STATUS_TONE.draft;
    return `<div class="doc">
      <div class="row1">
        <span class="docno">${escapeHtml(adapter.docTypeLabel)} <b>${escapeHtml(h.docNo)}</b></span>
        <span class="status" style="${tone}">${escapeHtml(h.statusLabel)}</span>
      </div>
      <div class="row2">
        <span><b>التاريخ:</b> ${escapeHtml(h.date)}</span>
        <span><b>${escapeHtml(adapter.partyLabel)}:</b> ${escapeHtml(h.partyName)}</span>
        ${h.currency ? `<span><b>العملة:</b> ${escapeHtml(h.currency)}</span>` : ""}
      </div>
      <div class="row3">
        <span>المجموع: <b>${t.subtotal.toFixed(2)}</b></span>
        <span>الضريبة: <b>${t.vat.toFixed(2)}</b></span>
        <span class="g">الإجمالي: <b>${t.total.toFixed(2)}</b></span>
      </div>
    </div>`;
  }).join("");
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escapeHtml(adapter.title)} — مختصر</title>
<style>
@page { size: A4 portrait; margin: 10mm; }
* { box-sizing: border-box; }
body { font-family:"Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; }
.h { text-align:center; margin-bottom:10px; padding-bottom:8px; border-bottom:2px solid #1e3a8a; }
.h img { max-height:46px; max-width:140px; object-fit:contain; margin-bottom:4px; }
.h h1 { margin:0; font-size:15pt; color:#1e3a8a; }
.h .meta { font-size:10pt; color:#475569; margin-top:2px; }
.grand { display:flex; gap:14px; justify-content:center; margin:6px 0 12px; font-size:11pt; padding:6px 10px; background:#eef2ff; border-radius:6px; }
.grand b { color:#1e3a8a; }
.doc { page-break-inside: avoid; border:1px solid #cbd5e1; border-radius:8px; padding:8px 10px; margin-bottom:8px; background:#fff; }
.doc .row1 { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; }
.doc .docno { font-size:11pt; color:#1e3a8a; }
.doc .status { padding:2px 8px; border-radius:999px; font-size:9pt; border:1px solid; font-weight:600; }
.doc .row2 { display:flex; gap:14px; flex-wrap:wrap; font-size:10pt; color:#334155; margin-bottom:4px; padding-bottom:4px; border-bottom:1px dashed #e2e8f0; }
.doc .row3 { display:flex; gap:14px; flex-wrap:wrap; font-size:10pt; }
.doc .row3 .g { color:#0f766e; font-weight:600; margin-right:auto; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:11pt; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
<div class="h">
  ${safeLogo ? `<img src="${safeLogo}" alt="" />` : ""}
  <h1>${escapeHtml(companyName)} — ${escapeHtml(adapter.title)}</h1>
  <div class="meta">تاريخ الطباعة: ${today} — عدد الوثائق: ${docs.length}</div>
</div>
<div class="grand">
  <span>إجمالي المجموع: <b>${grand.sub.toFixed(2)}</b></span>
  <span>إجمالي الضريبة: <b>${grand.vat.toFixed(2)}</b></span>
  <span>الإجمالي العام: <b>${grand.tot.toFixed(2)}</b></span>
</div>
${cards}
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
}

/* ─── The dropdown component ─────────────────────────────────────────── */

export type BulkPrintTemplateId =
  | "summary"
  | "detailed"
  | "professional"
  | "compact";

export interface BulkPrintMenuProps<T> {
  /** Selected document IDs. Used to gate the trigger + show the count. */
  selectedIds: number[];
  /** All filtered docs (the menu picks the selected subset itself). */
  filteredDocs: T[];
  /** How to read an id off a doc (default: `(d) => d.id`). */
  getId?: (d: T) => number;
  /** Adapter for the shared professional/compact templates + party labels. */
  adapter: DocAdapter<T>;
  /** Company info for the letterhead. */
  company: CompanyInfo | null | undefined;
  /** Per-template HTML the page already builds. We always reuse the page's
   *  existing summary + detailed layouts so the look the user already
   *  knows is preserved as the default templates. */
  buildSummary: (selected: T[]) => string;
  buildDetailed: (selectedFull: T[]) => string;
  /** Detailed needs full doc with lines — this fetches one. */
  fetchFull: (id: number) => Promise<T>;
  /** Toast for "popup blocked" + fetch failures. */
  onPopupBlocked?: () => void;
  onFetchFailed?: (failed: number) => void;
  /** Optional handler for the page's existing primary "print list" button
   *  (the big blue button). When omitted, that button itself becomes the
   *  dropdown trigger. */
  primaryAction?: () => void;
  primaryLabel?: string;
}

export function BulkPrintMenu<T>(props: BulkPrintMenuProps<T>) {
  const {
    selectedIds, filteredDocs, getId = (d: any) => d.id,
    adapter, company,
    buildSummary, buildDetailed, fetchFull,
    onPopupBlocked, onFetchFailed,
  } = props;

  const storageKey = `zatca_bulkprint_one_per_page__${adapter.kind}`;
  const [oneEntryPerPage, setOneEntryPerPage] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, oneEntryPerPage ? "1" : "0"); }
    catch { /* private mode */ }
  }, [oneEntryPerPage, storageKey]);

  const [busy, setBusy] = useState(false);
  const disabled = selectedIds.length === 0 || busy;

  const TEMPLATES: { id: BulkPrintTemplateId; label: string; desc: string; icon: any; needsLines: boolean }[] = [
    { id: "summary",      label: "ملخص — جدول واحد",          desc: "صفّ واحد لكل وثيقة في جدول مع الإجماليات",  icon: ScrollText, needsLines: false },
    { id: "detailed",     label: "تفصيلي — مع البنود",         desc: "كل وثيقة مع كامل بنودها والإجمالي",         icon: FileText,   needsLines: true  },
    { id: "professional", label: "احترافي — ترويسة وتوقيع",   desc: "تنسيق رسمي مع شعار ومكان للتوقيع",          icon: Newspaper,  needsLines: true  },
    { id: "compact",      label: "مختصر — بطاقات",            desc: "بطاقة لكل وثيقة، عدة وثائق في الصفحة",       icon: Layers,     needsLines: false },
  ];

  async function run(templateId: BulkPrintTemplateId) {
    const idSet = new Set(selectedIds.map(Number));
    const ordered = (filteredDocs as any[]).filter((r) => idSet.has(Number(getId(r))));
    if (ordered.length === 0) return;
    const tpl = TEMPLATES.find((p) => p.id === templateId)!;

    setBusy(true);
    try {
      let source: any[] = ordered;
      if (tpl.needsLines) {
        let failed = 0;
        source = await Promise.all(
          ordered.map(async (row: any) => {
            try { return await fetchFull(getId(row)); }
            catch { failed += 1; return { ...row, lines: [] }; }
          }),
        );
        if (failed > 0) onFetchFailed?.(failed);
      }

      let html = "";
      switch (templateId) {
        case "summary":      html = buildSummary(source); break;
        case "detailed":     html = buildDetailed(source); break;
        case "professional": html = buildProfessionalDocsHtml(source, adapter, company); break;
        case "compact":      html = buildCompactDocsHtml(source, adapter, company); break;
      }
      html = injectOneEntryPerPage(html, oneEntryPerPage);
      const ok = openPrintWindow(html, onPopupBlocked);
      if (!ok) return;
    } finally {
      setBusy(false);
    }
  }

  const primaryAction = props.primaryAction ?? (() => run("detailed"));
  const primaryLabel  = props.primaryLabel  ?? "طباعة المحدّد";

  return (
    <DropdownMenu>
      <div className="inline-flex items-stretch rounded-md overflow-hidden">
        <Button
          type="button"
          size="sm"
          className="h-8 px-3 text-xs gap-1 rounded-none bg-blue-700 hover:bg-blue-600 text-white"
          onClick={() => { void primaryAction(); }}
          disabled={disabled}
          title={`${primaryLabel} (${selectedIds.length})`}
          data-testid="bulk-print"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
          {primaryLabel} ({selectedIds.length})
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            className="h-8 px-1.5 text-xs rounded-none bg-blue-800 hover:bg-blue-700 text-white border-r border-blue-900/30"
            disabled={disabled}
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
          قوالب الطباعة — للوثائق المحدّدة ({selectedIds.length})
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
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
            <span className="text-[12px] font-medium text-amber-900">كل وثيقة في صفحة منفصلة</span>
            <span className="text-[10px] text-amber-700 leading-tight">
              يُطبَّق على القوالب التفصيلية والاحترافية والمختصرة
            </span>
          </div>
        </label>
        <DropdownMenuSeparator />
        {TEMPLATES.map((tpl) => {
          const Icon = tpl.icon;
          return (
            <DropdownMenuItem
              key={tpl.id}
              onSelect={(e) => { e.preventDefault(); void run(tpl.id); }}
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
  );
}
