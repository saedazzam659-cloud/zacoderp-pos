export type PosShiftInvoice = {
  id: number;
  docNumber: string | null;
  invoiceDate: string;
  totalAmount: string;
  vatAmount: string;
  status: string;
  paymentType: string;
  notes?: string | null;
  createdAt: string;
};

export type PosShiftDetail = {
  id: number;
  openedAt: string;
  closedAt: string | null;
  openingCash: string;
  shiftName?: string | null;
  closingCash?: string | null;
  difference?: string | null;
  user?: { nameAr?: string | null; username?: string | null } | null;
  branch?: { nameAr?: string | null } | null;
  cashBox?: { nameAr?: string | null } | null;
  invoices: PosShiftInvoice[];
  invoiceCount: number;
  totalSales: number;
};

export type PosShiftCashReport = {
  movements: Array<{
    id: string;
    code?: string | null;
    date: string;
    description?: string | null;
    amount: number;
    kind: string;
    createdAt?: string | null;
  }>;
  openingCash: number;
  cashSales: number;
  movementNet: number;
  expectedCash: number;
};

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);

type PrintLanguage = "ar" | "en";
const text = (language: PrintLanguage, ar: string, en: string) => language === "ar" ? ar : en;
const money = (value: unknown, language: PrintLanguage) =>
  `${new Intl.NumberFormat(language === "ar" ? "ar-SA" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(Number(value) || 0)} ${text(language, "ر.س", "SAR")}`;

const dateTime = (value: string | null | undefined, language: PrintLanguage) =>
  value ? new Date(value).toLocaleString(language === "ar" ? "ar-SA" : "en-US") : "—";

const paymentLabel = (value: string, language: PrintLanguage) => ({
  cash: text(language, "نقدي", "Cash"),
  bank: text(language, "شبكة", "Card"),
  mixed: text(language, "مختلط", "Mixed"),
}[value] || value);

const invoiceStatusLabel = (value: string, language: PrintLanguage) => ({
  posted: text(language, "مرحّلة", "Posted"),
  draft: text(language, "مسودة", "Draft"),
  cancelled: text(language, "ملغاة", "Cancelled"),
}[value] || value);

const movementLabel = (value: string, language: PrintLanguage) => ({
  expense: text(language, "مصروف", "Expense"),
  withdrawal: text(language, "سحب", "Withdrawal"),
  deposit: text(language, "إيداع", "Deposit"),
  transfer: text(language, "تحويل", "Transfer"),
}[value] || value);

export function openPosShiftPrintWindow(language: PrintLanguage = "ar"): Window | null {
  const printWindow = window.open("", "_blank");
  if (printWindow) {
    printWindow.document.open();
    printWindow.document.write(
      `<!doctype html><html lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}"><meta charset="utf-8"><title>${text(language, "تقرير الوردية", "Shift report")}</title><body style="font:16px sans-serif;padding:32px">${text(language, "جارٍ إعداد تقرير الوردية للطباعة…", "Preparing the shift report for printing…")}</body></html>`,
    );
    printWindow.document.close();
  }
  return printWindow;
}

export function printPosShiftReport(
  printWindow: Window,
  session: PosShiftDetail,
  cash: PosShiftCashReport,
  language: PrintLanguage = "ar",
) {
  const postedInvoices = session.invoices.filter((invoice) => invoice.status === "posted");
  const invoiceRows = session.invoices.length
    ? session.invoices.map((invoice, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(invoice.docNumber || `#${invoice.id}`)}</td>
          <td>${escapeHtml(dateTime(invoice.invoiceDate || invoice.createdAt, language))}</td>
          <td>${escapeHtml(paymentLabel(invoice.paymentType, language) || "—")}</td>
          <td>${escapeHtml(invoice.notes || "—")}</td>
          <td>${escapeHtml(invoiceStatusLabel(invoice.status, language))}</td>
          <td class="amount">${money(invoice.totalAmount, language)}</td>
        </tr>`).join("")
    : `<tr><td colspan="7" class="empty">${text(language, "لا توجد فواتير في هذه الوردية.", "No invoices in this shift.")}</td></tr>`;

  const movementRows = cash.movements.length
    ? cash.movements.map((movement, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(dateTime(movement.createdAt || movement.date, language))}</td>
          <td>${escapeHtml(movement.code || "—")}</td>
          <td>${escapeHtml(movementLabel(movement.kind, language))}</td>
          <td>${escapeHtml(movement.description || "—")}</td>
          <td class="amount ${movement.amount < 0 ? "negative" : "positive"}">${money(movement.amount, language)}</td>
        </tr>`).join("")
    : `<tr><td colspan="6" class="empty">${text(language, "لا توجد حركات نقدية إضافية.", "No additional cash movements.")}</td></tr>`;
  const difference = Number(session.difference ?? 0);
  const differenceLabel = difference < 0
    ? text(language, "عجز", "Shortage")
    : difference > 0
      ? text(language, "زيادة", "Overage")
      : text(language, "مطابق", "Balanced");
  const differenceClass = difference < 0 ? "negative" : difference > 0 ? "positive" : "";

  const html = `<!doctype html>
    <html lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}">
      <head>
        <meta charset="utf-8">
        <title>${text(language, "تقرير حركة الوردية", "Shift activity report")} #${escapeHtml(session.id)}</title>
        <style>
          *{box-sizing:border-box}body{font-family:Arial,Tahoma,sans-serif;color:#17212b;margin:24px;font-size:12px}
          h1{font-size:22px;margin:0 0 6px}h2{font-size:15px;margin:24px 0 8px}
          .muted{color:#637080}.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #059681;padding-bottom:14px}
          .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 18px;margin:14px 0}
          .meta div{padding:7px 0;border-bottom:1px solid #e5e9ed}.meta b{display:block;color:#687581;font-size:10px;margin-bottom:3px}
          .summary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
          .summary div{border:1px solid #dce4e7;border-radius:8px;padding:10px}.summary b{display:block;color:#687581;font-size:10px;margin-bottom:5px}
          .summary strong{font-size:14px}.expected{background:#eaf8f4;border-color:#91d5c7!important}.variance{background:#fff7ed}
          table{width:100%;border-collapse:collapse;font-size:10px}th,td{border:1px solid #dce2e6;padding:7px;text-align:start}
          th{background:#f1f5f6;font-weight:700}.amount{white-space:nowrap;font-weight:700}.positive{color:#087d63}.negative{color:#b42318}
          .empty{text-align:center;color:#697682;padding:14px}.foot{margin-top:24px;border-top:1px solid #dce2e6;padding-top:10px;color:#697682}
          .actions{margin-bottom:16px}.actions button{border:0;border-radius:7px;padding:10px 18px;background:#078f7d;color:white;font-weight:bold;cursor:pointer}
          @page{size:A4;margin:12mm}@media print{body{margin:0}.actions{display:none}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}}
        </style>
      </head>
      <body>
        <div class="actions"><button onclick="window.print()">${text(language, "طباعة التقرير", "Print report")}</button></div>
        <header class="head">
          <div><h1>${text(language, "تقرير حركة وإغلاق الوردية", "Shift activity and closing report")}</h1><div class="muted">${text(language, "نقاط البيع — تقرير تفصيلي تلقائي", "POS — automatic detailed report")}</div></div>
          <strong>${text(language, "رقم الوردية:", "Shift number:")} ${escapeHtml(session.id)}</strong>
        </header>
        <section class="meta">
          <div><b>${text(language, "الكاشير", "Cashier")}</b>${escapeHtml(session.user?.nameAr || session.user?.username || "—")}</div>
          <div><b>${text(language, "الفرع", "Branch")}</b>${escapeHtml(session.branch?.nameAr || "—")}</div>
          <div><b>${text(language, "الخزينة", "Cash box")}</b>${escapeHtml(session.cashBox?.nameAr || "—")}</div>
          <div><b>${text(language, "الوردية", "Shift")}</b>${escapeHtml(session.shiftName || "—")}</div>
          <div><b>${text(language, "بداية الوردية", "Shift opened")}</b>${escapeHtml(dateTime(session.openedAt, language))}</div>
          <div><b>${text(language, "إغلاق الوردية", "Shift closed")}</b>${escapeHtml(dateTime(session.closedAt, language))}</div>
          <div><b>${text(language, "عدد الفواتير المرحلة", "Posted invoices")}</b>${postedInvoices.length}</div>
        </section>
        <section class="summary">
          <div><b>${text(language, "النقد الافتتاحي", "Opening cash")}</b><strong>${money(cash.openingCash, language)}</strong></div>
          <div><b>${text(language, "مبيعات نقدية", "Cash sales")}</b><strong>${money(cash.cashSales, language)}</strong></div>
          <div><b>${text(language, "صافي الإيداعات والسحوبات والتحويلات", "Net deposits, withdrawals, and transfers")}</b><strong>${money(cash.movementNet, language)}</strong></div>
          <div><b>${text(language, "إجمالي المبيعات المرحلة", "Total posted sales")}</b><strong>${money(session.totalSales, language)}</strong></div>
          <div><b>${text(language, "عدد الفواتير", "Invoice count")}</b><strong>${postedInvoices.length}</strong></div>
          <div class="expected"><b>${text(language, "النقد المتوقع في الخزينة", "Expected cash in cash box")}</b><strong>${money(cash.expectedCash, language)}</strong></div>
          <div><b>${text(language, "النقدية الفعلية بعد الجرد", "Counted cash")}</b><strong>${session.closingCash == null ? "—" : money(session.closingCash, language)}</strong></div>
          <div class="variance"><b>${text(language, "فرق الجرد", "Cash difference")}</b><strong class="${differenceClass}">${differenceLabel} · ${money(Math.abs(difference), language)}</strong></div>
        </section>
        <h2>${text(language, "فواتير الوردية", "Shift invoices")}</h2>
        <table><thead><tr><th>#</th><th>${text(language, "رقم الفاتورة", "Invoice number")}</th><th>${text(language, "التاريخ", "Date")}</th><th>${text(language, "طريقة الدفع", "Payment method")}</th><th>${text(language, "البيان / نوع الطلب", "Description / order type")}</th><th>${text(language, "الحالة", "Status")}</th><th>${text(language, "الإجمالي", "Total")}</th></tr></thead><tbody>${invoiceRows}</tbody></table>
        <h2>${text(language, "الحركات النقدية", "Cash movements")}</h2>
        <table><thead><tr><th>#</th><th>${text(language, "التاريخ والوقت", "Date and time")}</th><th>${text(language, "رقم الحركة", "Movement number")}</th><th>${text(language, "النوع", "Type")}</th><th>${text(language, "البيان", "Description")}</th><th>${text(language, "المبلغ", "Amount")}</th></tr></thead><tbody>${movementRows}</tbody></table>
        <div class="foot">${text(language, "تم إنشاء التقرير تلقائيًا عند إغلاق الوردية. إغلاق الخزينة محسوب من النقد الافتتاحي ومبيعات النقد وصافي الحركات المسجلة.", "This report was generated automatically when the shift closed. Expected cash is calculated from opening cash, cash sales, and net recorded movements.")}</div>
        <script>window.addEventListener("load",()=>setTimeout(()=>window.print(),350));</script>
      </body>
    </html>`;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}
