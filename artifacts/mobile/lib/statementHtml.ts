/**
 * Browser-free statement print template shared by web and native.
 * Both adapters pass historical ledger lines; this module never fetches or
 * calculates server-side balances. Keep the letterhead/table identical on both.
 */
export interface StatementLine {
  /** Detail-only text under its parent transaction; never changes totals. */
  detail?: boolean;
  id?: number | null;
  journalEntryId?: number | null;
  date: string;
  docType?: string;
  type: string;
  docNumber?: string | null;
  journalEntryNumber?: string | null;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}
export interface StatementCompany {
  nameAr?: string | null; nameEn?: string | null; crNumber?: string | null;
  vatNumber?: string | null; phone?: string | null; city?: string | null;
  district?: string | null; street?: string | null; buildingNumber?: string | null;
  postalCode?: string | null; logo?: string | null; brandLogo?: string | null;
}
export interface StatementAccount {
  code?: string | null; nameAr?: string | null; nameEn?: string | null;
  legalName?: string | null; level?: string | number | null;
  partyNameAr?: string | null; partyNameEn?: string | null;
}
export interface StatementVisibleCols {
  docType?: boolean; date?: boolean; docNumber?: boolean; type?: boolean;
  debit?: boolean; credit?: boolean; balance?: boolean; description?: boolean;
}
export interface StatementHtmlOpts {
  mode: 'customer' | 'supplier' | 'general';
  company?: StatementCompany | null;
  account: StatementAccount;
  from: string; to: string; opening: number; lines: StatementLine[];
  totals: { debit: number; credit: number }; closing: number;
  filename: string; autoPrint?: boolean;
  fmt?: (n: number) => string;
  branchName?: string | null; visibleCols?: StatementVisibleCols;
  userName?: string | null;
  /** Native passes this for stable print dates when building offline. */
  printedAt?: Date;
}

export const escapeStatementHtml = (value: unknown): string =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function safeImage(value: unknown): string | null {
  if (value == null) return null;
  const src = String(value).trim();
  if (/[\u0000-\u001f\u007f"'<>`\s]/.test(src)) return null;
  return /^(?:data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+|https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+)$/.test(src) ? src : null;
}

export function renderStatementHtml(opts: StatementHtmlOpts): string {
  const { company, account, mode, lines, from, to, opening, totals, closing } = opts;
  const e = escapeStatementHtml;
  const fmt = opts.fmt ?? ((n: number) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const show = (key: keyof StatementVisibleCols) => key !== 'type' && opts.visibleCols?.[key] !== false;
  const keys = (['date', 'docType', 'docNumber', 'debit', 'credit', 'balance', 'description'] as const).filter(show);
  const headings: Record<(typeof keys)[number], string> = {
    date: 'التاريخ', docType: 'نوع الوثيقة', docNumber: 'الرقم',
    debit: 'مدين', credit: 'دائن', balance: 'الرصيد', description: 'الشرح',
  };
  const cell = (key: (typeof keys)[number], l: StatementLine): string => {
    switch (key) {
      case 'date': return e(l.date);
      case 'docType': return e(l.docType || '—');
      case 'docNumber': return e(l.docNumber || (l.id != null ? `#${l.id}` : '—'));
      case 'debit': return l.debit ? e(fmt(l.debit)) : '0.00';
      case 'credit': return l.credit ? e(fmt(l.credit)) : '0.00';
      case 'balance': return e(fmt(l.balance));
      case 'description': return e(l.description);
    }
  };
  const logo = safeImage(company?.logo);
  const brand = safeImage(company?.brandLogo);
  const name = company?.nameAr || company?.nameEn || '—';
  const address = [company?.buildingNumber, company?.street, company?.district, company?.city, company?.postalCode].filter(Boolean).join(' - ');
  const openingDebit = mode === 'supplier' ? Math.max(0, -opening) : Math.max(0, opening);
  const openingCredit = mode === 'supplier' ? Math.max(0, opening) : Math.max(0, -opening);
  const openingCells: Partial<Record<(typeof keys)[number], string>> = {
    date: e(from), docType: 'رصيد افتتاحي', docNumber: '—',
    debit: openingDebit ? e(fmt(openingDebit)) : '0.00',
    credit: openingCredit ? e(fmt(openingCredit)) : '0.00',
    balance: e(fmt(opening)), description: '—',
  };
  const first = keys.filter(k => ['date', 'docType', 'docNumber'].includes(k)).length;
  const totalCells = `${first ? `<td colspan="${first}">الإجمالي</td>` : ''}${keys.filter(k => !['date', 'docType', 'docNumber'].includes(k)).map(k =>
    k === 'description' ? '<td>—</td>' :
    `<td class="mono num ${k === 'balance' ? 'strong' : k}">${k === 'debit' ? e(fmt(totals.debit)) : k === 'credit' ? e(fmt(totals.credit)) : e(fmt(closing))}</td>`).join('')}`;
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"/><title>${e(opts.filename)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;600;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Tajawal', 'Segoe UI', Tahoma, Arial, sans-serif;
      direction: rtl;
      font-size: 10pt;
      color: #0f172a;
      background: #fff;
      padding: 0;
    }
    .doc { padding: 0; max-width: 100%; }
    table.data th.desc,
    table.data td.desc {
      width: 45%;
      min-width: 60mm;
      white-space: normal;
      word-break: break-word;
    }
    .page-header {
      padding: 6mm 2mm 3mm;
    }
    .page-header .co-row {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 10px;
      align-items: start;
    }
    .co-side { font-size: 8.5pt; line-height: 1.35; color: #475569; }
    .co-side .name { font-size: 10.5pt; font-weight: 700; color: #0f172a; margin-bottom: 1px; }
    .co-side .name-latin { font-size: 8.5pt; font-weight: 500; color: #64748b; margin-bottom: 2px; }
    .co-side .row { white-space: nowrap; }
    .co-side .lbl { color: #94a3b8; }
    .co-side.right { text-align: right; }
    .co-side .mono { font-family: 'Courier New', monospace; }
    .co-center { text-align: center; }
    .co-logo {
      width: 56px; height: 56px;
      border: 1px solid #e2e8f0; border-radius: 50%;
      background: #fff;
      display: inline-flex; align-items: center; justify-content: center;
      overflow: hidden;
      margin: 0 auto;
    }
    .co-logo img { max-width: 90%; max-height: 90%; object-fit: contain; }
    .logo-fallback { font-weight: 700; color: #94a3b8; font-size: 11pt; }
    .co-brand { text-align: left; }
    .co-brand img { width: 56px; height: 56px; object-fit: contain; }
    .title-bar {
      margin-top: 4mm;
      text-align: center;
    }
    .title-bar .doc-title {
      font-size: 13pt; font-weight: 800; color: #000;
      margin-bottom: 3mm;
    }
    .title-bar .period-range {
      display: inline-flex;
      gap: 8mm;
      margin-top: 2mm;
      padding: 1.5mm 4mm;
      border: 1px solid #cbd5e1;
      border-radius: 3mm;
      background: #f8fafc;
      font-size: 9pt;
    }
    .title-bar .period-range .seg { display: inline-flex; gap: 4px; align-items: baseline; }
    .title-bar .period-range .lbl { color: #64748b; }
    .title-bar .period-range .val {
      font-family: 'Courier New', monospace;
      color: #0f172a;
      font-weight: 700;
    }
    .black-rule {
      height: 0;
      border: 0;
      border-top: 1.5pt solid #000;
      margin: 0;
    }
    .party-strip {
      padding: 3mm 2mm 4mm;
      text-align: right;
    }
    .party-strip .party-row {
      font-size: 9.5pt; color: #334155;
      line-height: 1.7;
    }
    .party-strip .party-name {
      font-size: 11pt; font-weight: 800; color: #0f172a;
    }
    .party-strip .party-name-latin {
      font-size: 9pt; color: #64748b; margin-inline-start: 6px;
    }
    .party-strip .lbl { color: #94a3b8; }
    .party-strip .mono { font-family: 'Courier New', monospace; }
    table.page-frame {
      width: 100%;
      border-collapse: collapse;
      border: 0;
    }
    table.page-frame > thead { display: table-header-group; }
    table.page-frame > tfoot { display: table-footer-group; }
    table.page-frame > thead > tr > td,
    table.page-frame > tfoot > tr > td {
      padding: 0;
      border: 0;
    }
    table.data {
      width: 100%;
      border-collapse: collapse;
      font-size: 9pt;
      border: 1px solid #cbd5e1;
      border-radius: 0;
      overflow: hidden;
      margin-top: 2mm;
    }
    table.data thead tr { background: #f1f5f9; color: #334155; }
    table.data thead th {
      padding: 4px 5px;
      font-weight: 700;
      border-bottom: 1px solid #cbd5e1;
      text-align: center;
      white-space: nowrap;
      font-size: 9pt;
    }
    table.data tbody td {
      padding: 3px 5px;
      border-top: 1px solid #e2e8f0;
      vertical-align: middle;
      text-align: start;
      line-height: 1.25;
    }
    table.data tbody td.num { text-align: center; }
    table.data tbody td.mono { font-family: 'Courier New', monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }
    table.data tbody td.debit { color: #0369a1; font-weight: 600; }
    table.data tbody td.credit { color: #047857; font-weight: 600; }
    table.data tbody td.muted { color: #cbd5e1; }
    table.data tbody td.strong { font-weight: 700; color: #0f172a; }
    table.data tr.even { background: #f8fafc; }
    table.data tr.odd  { background: #ffffff; }
    table.data tbody tr.opening { background: #fffbeb; }
    table.data tbody tr.opening td.lbl { font-style: italic; color: #64748b; }
    table.data tbody tr.totals {
      background: #f1f5f9;
      font-weight: 700;
      color: #0f172a;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    table.data tbody tr.totals td {
      border-top: 2px solid #94a3b8;
      padding: 5px 5px;
      font-size: 9.5pt;
    }
    .empty { text-align: center; padding: 18px; color: #94a3b8; }
    .page-footer-fixed {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 3mm 8mm 6mm;
      border-top: 1px solid #cbd5e1;
      background: #fff;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 8.5pt;
      color: #475569;
    }
    .page-footer-fixed .ftr-date { direction: ltr; }
    .page-footer-fixed .ftr-user { font-weight: 600; color: #0f172a; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .page-header, .party-strip, table.data thead tr,
      table.data tbody tr.opening, table.data tbody tr.totals,
      table.data tr.even, .page-footer-fixed, .black-rule,
      .title-bar .period-range {
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }
    }
    @page {
      margin: 0 8mm 0 8mm;
      size: A4 portrait;
    }
    .page-header { padding-top: 12mm; }
    table.page-frame { margin-bottom: 22mm; }
  </style>
</head>
<body>
  <table class="page-frame">
    <thead>
      <tr><td>
        <div class="page-header">
          <div class="co-row">
            <div class="co-side right">
              <div class="name">${e(company?.nameAr || '—')}</div>
              ${company?.crNumber ? `<div class="row"><span class="lbl">س.ت</span> : ${e(company.crNumber)}</div>` : ''}
              ${company?.vatNumber ? `<div class="row"><span class="lbl">الرقم الضريبي</span> : ${e(company.vatNumber)}</div>` : ''}
              ${company?.phone ? `<div class="row"><span class="lbl">الجوال</span> : ${e(company.phone)}</div>` : ''}
              ${address ? `<div class="row"><span class="lbl">العنوان</span> : ${e(address)}</div>` : ''}
            </div>
            <div class="co-center">
              <div class="co-logo">${logo ? `<img src="${logo}" alt="${e(name).replace(/"/g, '&quot;').replace(/'/g, '&#39;')}" />` : `<div class="logo-fallback">${e(name.trim().slice(0, 2))}</div>`}</div>
            </div>
            <div class="co-brand">${brand ? `<img src="${brand}" alt="" />` : ''}</div>
          </div>
          <div class="title-bar">
            <div class="doc-title">${mode === 'supplier' ? 'كشف حساب مورد' : 'كشف حساب'}</div>
            <div class="period-range">
              <span class="seg"><span class="lbl">من تاريخ:</span> <span class="val">${e(from)}</span></span>
              <span class="seg"><span class="lbl">إلى تاريخ:</span> <span class="val">${e(to)}</span></span>
            </div>
          </div>
          <hr class="black-rule" />
          <div class="party-strip">
            <div class="party-row">
              <span class="lbl">${mode === 'supplier' ? 'اسم المورد' : mode === 'general' ? 'الحساب' : 'اسم العميل'}:</span>
              <span class="party-name">${e(account.partyNameAr || account.nameAr || account.nameEn || '—')}</span>
              ${account.partyNameEn ? `<span class="party-name-latin" dir="ltr">(${e(account.partyNameEn)})</span>` : ''}
            </div>
            <div class="party-row">
              <span class="lbl">رمز الحساب:</span>
              <span class="mono">${e(account.code || '—')}</span>
            </div>
            <div class="party-row">
              <span class="lbl">مستوى الحساب:</span>
              ${e(account.level != null ? String(account.level) : '—')}
            </div>
            ${opts.branchName ? `
            <div class="party-row">
              <span class="lbl">الفرع:</span> ${e(opts.branchName)}
            </div>` : ''}
          </div>
        </div>
      </td></tr>
    </thead>
    <tbody>
      <tr><td>
        <table class="data">
          <thead>
            <tr>${keys.map(k => `<th${k === 'description' ? ' class="desc"' : ''}>${headings[k]}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            <tr class="opening">
              ${keys.map(k => `<td${k === 'date' ? ' class="mono"' : k === 'docType' ? ' class="lbl"' : k === 'debit' || k === 'credit' ? ' class="mono num"' : k === 'balance' ? ' class="mono num strong"' : ''}>${openingCells[k]}</td>`).join('')}
            </tr>
            ${lines.length ? lines.map((l, i) => l.detail ? `<tr class="${i % 2 === 0 ? 'even' : 'odd'}"><td colspan="${Math.max(1, keys.length)}" class="desc">${e(l.description)}</td></tr>` :
              `<tr class="${i % 2 === 0 ? 'even' : 'odd'}">${keys.map(k => `<td${k === 'date' || k === 'docNumber' ? ' class="mono"' : k === 'debit' || k === 'credit' ? ` class="mono num ${Number(l[k]) ? k : 'muted'}"` : k === 'balance' ? ' class="mono num strong"' : k === 'description' ? ' class="desc"' : ''}>${cell(k, l)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${Math.max(1, keys.length)}" class="empty">لا توجد حركات في الفترة المحددة</td></tr>`}
            ${lines.length ? `<tr class="totals">${totalCells}</tr>` : ''}
          </tbody>
        </table>
      </td></tr>
    </tbody>
  </table>
  <div class="page-footer-fixed">
    <div class="ftr-date">تاريخ الطباعة: ${(opts.printedAt ?? new Date()).toLocaleDateString('ar-SA-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
    ${opts.userName ? `<div class="ftr-user">اسم المستخدم: ${e(opts.userName)}</div>` : `<div></div>`}
  </div>
  <script>
    ${opts.autoPrint !== false ? `window.onload = function(){ setTimeout(function(){ window.print(); }, 600); };` : ''}
  </script>
</body>
</html>`;
}