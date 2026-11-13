import { currencySymbol } from "./currency";
import { getCompanyProfile, getDecimals, getUiLanguage, uiText, type CompanyProfile, type UiLanguage } from "./appSettings";
import { applyNumberSystemToDocument } from "./numberDisplay";
import type { Account } from "./accounting";

type PrintCell = string | number | null | undefined;

export type AccountingReportPrintModel = {
  title: string;
  subtitle?: string;
  filters?: string[];
  orientation?: "portrait" | "landscape";
  summaries?: { label: string; value: PrintCell; emphasis?: boolean }[];
  sections: {
    title: string;
    columns: string[];
    rows: PrintCell[][];
    totalRow?: PrintCell[];
    emptyText?: string;
  }[];
  notice?: { text: string; balanced: boolean };
};

export function accountHierarchyPrintFilters(
  accounts: Account[],
  parentIds: number[],
  levelMode: "all" | "first" | "last",
  showZero: boolean,
): string[] {
  const selectedParents = accounts
    .filter((account) => parentIds.includes(account.id))
    .map((account) => `${account.code} — ${account.nameAr}`);
  const levelLabel = levelMode === "first"
    ? uiText("الحسابات الرئيسية فقط", "Parent accounts only")
    : levelMode === "last"
      ? uiText("الحسابات الفرعية فقط", "Leaf accounts only")
      : uiText("كل المستويات", "All levels");
  return [
    `${uiText("الحسابات الرئيسية", "Parent accounts")}: ${selectedParents.length ? selectedParents.join("، ") : uiText("الكل", "All")}`,
    `${uiText("المستوى", "Level")}: ${levelLabel}`,
    `${uiText("الحسابات الصفرية", "Zero-balance accounts")}: ${showZero ? uiText("إظهار", "Shown") : uiText("إخفاء", "Hidden")}`,
  ];
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function formatMoney(value: number, decimals: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function renderCell(value: PrintCell, decimals: number): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<td class="numeric">${escapeHtml(formatMoney(value, decimals))}</td>`;
  }
  return `<td>${escapeHtml(value ?? "")}</td>`;
}

function renderSection(
  section: AccountingReportPrintModel["sections"][number],
  decimals: number,
  language: UiLanguage,
): string {
  const headings = section.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const body = section.rows.length
    ? section.rows.map((row) => `<tr>${section.columns.map((_, index) => renderCell(row[index], decimals)).join("")}</tr>`).join("")
    : `<tr><td class="empty" colspan="${section.columns.length}">${escapeHtml(section.emptyText ?? uiText("لا توجد بيانات", "No data", language))}</td></tr>`;
  const total = section.totalRow
    ? `<tfoot><tr>${section.columns.map((_, index) => {
      const cell = section.totalRow![index];
      return typeof cell === "number" && Number.isFinite(cell)
        ? `<td class="numeric">${escapeHtml(formatMoney(cell, decimals))}</td>`
        : `<td>${escapeHtml(cell ?? "")}</td>`;
    }).join("")}</tr></tfoot>`
    : "";
  return `<section class="report-section"><h2>${escapeHtml(section.title)}</h2><table><thead><tr>${headings}</tr></thead><tbody>${body}</tbody>${total}</table></section>`;
}

function buildHtml(model: AccountingReportPrintModel, company: CompanyProfile): string {
  const language = getUiLanguage();
  const direction = language === "en" ? "ltr" : "rtl";
  const decimals = getDecimals();
  const logo = company.logo
    ? `<img class="company-logo" src="${escapeHtml(company.logo)}" alt="">`
    : "";
  const companyDetails = [
    company.phone && `${uiText("هاتف", "Phone", language)}: ${company.phone}`,
    company.address && `${uiText("العنوان", "Address", language)}: ${company.address}`,
    company.email && `${uiText("البريد الإلكتروني", "Email", language)}: ${company.email}`,
    company.cr && `${uiText("سجل تجاري", "CR", language)}: ${company.cr}`,
    company.vat && `${uiText("الرقم الضريبي", "VAT", language)}: ${company.vat}`,
  ].filter(Boolean).map(escapeHtml).join(" · ");
  const filters = model.filters?.filter(Boolean).length
    ? `<div class="filters">${model.filters.filter(Boolean).map((filter) => `<span>${escapeHtml(filter)}</span>`).join("")}</div>`
    : "";
  const summaries = model.summaries?.length
    ? `<div class="summary-grid">${model.summaries.map((item) => {
      const value = typeof item.value === "number" && Number.isFinite(item.value)
        ? formatMoney(item.value, decimals)
        : escapeHtml(item.value ?? "");
      return `<div class="summary-card${item.emphasis ? " emphasis" : ""}"><div class="summary-label">${escapeHtml(item.label)}</div><div class="summary-value">${value}</div></div>`;
    }).join("")}</div>`
    : "";
  const notice = model.notice
    ? `<div class="notice ${model.notice.balanced ? "good" : "warning"}">${escapeHtml(model.notice.text)}</div>`
    : "";
  const sections = model.sections.map((section) => renderSection(section, decimals, language)).join("");
  const printedAt = new Date().toLocaleString(language === "en" ? "en-GB" : "ar-EG");
  const currency = currencySymbol();

  return `<!doctype html>
<html lang="${language}" dir="${direction}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(model.title)}</title>
  <style>
    @page { size: A4 ${model.orientation ?? "portrait"}; margin: 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #172033; background: #fff; font-family: Arial, Tahoma, sans-serif; font-size: 11px; line-height: 1.5; }
    .page { width: 100%; }
    .company-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 12px; border-bottom: 2px solid #1d4ed8; }
    .identity { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .company-logo { width: auto; max-width: 78px; max-height: 58px; object-fit: contain; }
    .company-name { font-size: 17px; font-weight: 700; color: #102a43; }
    .company-details { margin-top: 3px; color: #64748b; font-size: 9px; }
    .currency { color: #475569; font-size: 10px; text-align: end; }
    .report-heading { margin: 16px 0 10px; }
    h1 { margin: 0; font-size: 19px; color: #0f172a; }
    .subtitle { color: #64748b; margin-top: 3px; font-size: 10px; }
    .filters { display: flex; flex-wrap: wrap; gap: 5px 14px; padding: 8px 10px; margin: 10px 0; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 5px; color: #475569; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: 8px; margin: 12px 0; }
    .summary-card { border: 1px solid #dbe3ef; border-radius: 5px; padding: 8px 10px; background: #fff; }
    .summary-card.emphasis { border-color: #93c5fd; background: #eff6ff; }
    .summary-label { color: #64748b; font-size: 9px; }
    .summary-value { margin-top: 4px; color: #0f172a; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .notice { margin: 10px 0; padding: 7px 10px; border-radius: 4px; font-weight: 700; }
    .notice.good { color: #166534; background: #f0fdf4; border: 1px solid #bbf7d0; }
    .notice.warning { color: #991b1b; background: #fef2f2; border: 1px solid #fecaca; }
    .report-section { margin: 14px 0; break-inside: auto; }
    h2 { margin: 0 0 6px; font-size: 13px; color: #1e3a5f; }
    table { width: 100%; border-collapse: collapse; table-layout: auto; }
    thead { display: table-header-group; }
    th { padding: 6px 7px; text-align: start; color: #334155; background: #eff4fa; border: 1px solid #cbd5e1; font-weight: 700; }
    td { padding: 5px 7px; border: 1px solid #e2e8f0; vertical-align: top; overflow-wrap: anywhere; }
    tbody tr:nth-child(even) { background: #f8fafc; }
    td.numeric { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
    td.empty { padding: 12px; color: #64748b; text-align: center; }
    tfoot td { background: #eef2f7; font-weight: 700; border-top: 2px solid #94a3b8; }
    .print-footer { margin-top: 18px; padding-top: 7px; border-top: 1px solid #cbd5e1; display: flex; justify-content: space-between; color: #64748b; font-size: 9px; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .report-section tr { break-inside: avoid; }
      .company-header { break-inside: avoid; }
      .print-footer { position: fixed; bottom: 0; left: 0; right: 0; }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="company-header">
      <div class="identity">${logo}<div><div class="company-name">${escapeHtml(company.name || uiText("الشركة", "Company", language))}</div><div class="company-details">${companyDetails}</div></div></div>
      <div class="currency">${escapeHtml(uiText("العملة", "Currency", language))}: ${escapeHtml(currency)}</div>
    </header>
    <div class="report-heading"><h1>${escapeHtml(model.title)}</h1>${model.subtitle ? `<div class="subtitle">${escapeHtml(model.subtitle)}</div>` : ""}</div>
    ${filters}
    ${summaries}
    ${notice}
    ${sections}
    <footer class="print-footer"><span>${escapeHtml(company.name || "")}</span><span>${escapeHtml(uiText("طُبع في", "Printed", language))}: ${escapeHtml(printedAt)}</span></footer>
  </main>
</body>
</html>`;
}

export function printAccountingReport(model: AccountingReportPrintModel): void {
  const html = buildHtml(model, getCompanyProfile());
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  const doc = win?.document;
  if (!win || !doc) {
    iframe.remove();
    return;
  }

  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    try { win.focus(); win.print(); } catch { /* user cancelled or printing is unavailable */ }
    setTimeout(() => iframe.remove(), 1500);
  };

  doc.open();
  doc.write(html);
  doc.close();
  applyNumberSystemToDocument(doc);
  try {
    const cssText = Array.from(doc.querySelectorAll("style")).map((style) => style.textContent || "").join("\n");
    const Sheet = (win as unknown as { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet;
    if (cssText && Sheet && "adoptedStyleSheets" in doc) {
      const sheet = new Sheet();
      sheet.replaceSync(cssText);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    }
  } catch { /* use inline styles when CSSOM is unavailable */ }

  if (doc.readyState === "complete") setTimeout(run, 200);
  else win.addEventListener("load", () => setTimeout(run, 200), { once: true });
  setTimeout(run, 1200);
}
