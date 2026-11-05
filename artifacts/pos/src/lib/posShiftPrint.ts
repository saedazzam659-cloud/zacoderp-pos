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

const money = (value: unknown) =>
  `${new Intl.NumberFormat("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(Number(value) || 0)} ر.س`;

const dateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("ar-SA") : "—";

const paymentLabel: Record<string, string> = {
  cash: "نقدي",
  bank: "شبكة",
  mixed: "مختلط",
};

const invoiceStatusLabel: Record<string, string> = {
  posted: "مرحّلة",
  draft: "مسودة",
  cancelled: "ملغاة",
};

const movementLabel: Record<string, string> = {
  expense: "مصروف",
  withdrawal: "سحب",
  deposit: "إيداع",
  transfer: "تحويل",
};

export function openPosShiftPrintWindow(): Window | null {
  const printWindow = window.open("", "_blank");
  if (printWindow) {
    printWindow.document.open();
    printWindow.document.write(
      "<!doctype html><html lang='ar' dir='rtl'><meta charset='utf-8'><title>تقرير الوردية</title><body style='font:16px sans-serif;padding:32px'>جارٍ إعداد تقرير الوردية للطباعة…</body></html>",
    );
    printWindow.document.close();
  }
  return printWindow;
}

export function printPosShiftReport(
  printWindow: Window,
  session: PosShiftDetail,
  cash: PosShiftCashReport,
) {
  const postedInvoices = session.invoices.filter((invoice) => invoice.status === "posted");
  const invoiceRows = session.invoices.length
    ? session.invoices.map((invoice, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(invoice.docNumber || `#${invoice.id}`)}</td>
          <td>${escapeHtml(dateTime(invoice.invoiceDate || invoice.createdAt))}</td>
          <td>${escapeHtml(paymentLabel[invoice.paymentType] || invoice.paymentType || "—")}</td>
          <td>${escapeHtml(invoice.notes || "—")}</td>
          <td>${escapeHtml(invoiceStatusLabel[invoice.status] || invoice.status)}</td>
          <td class="amount">${money(invoice.totalAmount)}</td>
        </tr>`).join("")
    : `<tr><td colspan="7" class="empty">لا توجد فواتير في هذه الوردية.</td></tr>`;

  const movementRows = cash.movements.length
    ? cash.movements.map((movement, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(dateTime(movement.createdAt || movement.date))}</td>
          <td>${escapeHtml(movement.code || "—")}</td>
          <td>${escapeHtml(movementLabel[movement.kind] || movement.kind)}</td>
          <td>${escapeHtml(movement.description || "—")}</td>
          <td class="amount ${movement.amount < 0 ? "negative" : "positive"}">${money(movement.amount)}</td>
        </tr>`).join("")
    : `<tr><td colspan="6" class="empty">لا توجد حركات نقدية إضافية.</td></tr>`;

  const html = `<!doctype html>
    <html lang="ar" dir="rtl">
      <head>
        <meta charset="utf-8">
        <title>تقرير حركة الوردية #${escapeHtml(session.id)}</title>
        <style>
          *{box-sizing:border-box}body{font-family:Arial,Tahoma,sans-serif;color:#17212b;margin:24px;font-size:12px}
          h1{font-size:22px;margin:0 0 6px}h2{font-size:15px;margin:24px 0 8px}
          .muted{color:#637080}.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #059681;padding-bottom:14px}
          .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 18px;margin:14px 0}
          .meta div{padding:7px 0;border-bottom:1px solid #e5e9ed}.meta b{display:block;color:#687581;font-size:10px;margin-bottom:3px}
          .summary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
          .summary div{border:1px solid #dce4e7;border-radius:8px;padding:10px}.summary b{display:block;color:#687581;font-size:10px;margin-bottom:5px}
          .summary strong{font-size:14px}.expected{background:#eaf8f4;border-color:#91d5c7!important}
          table{width:100%;border-collapse:collapse;font-size:10px}th,td{border:1px solid #dce2e6;padding:7px;text-align:right}
          th{background:#f1f5f6;font-weight:700}.amount{white-space:nowrap;font-weight:700}.positive{color:#087d63}.negative{color:#b42318}
          .empty{text-align:center;color:#697682;padding:14px}.foot{margin-top:24px;border-top:1px solid #dce2e6;padding-top:10px;color:#697682}
          .actions{margin-bottom:16px}.actions button{border:0;border-radius:7px;padding:10px 18px;background:#078f7d;color:white;font-weight:bold;cursor:pointer}
          @page{size:A4;margin:12mm}@media print{body{margin:0}.actions{display:none}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}}
        </style>
      </head>
      <body>
        <div class="actions"><button onclick="window.print()">طباعة التقرير</button></div>
        <header class="head">
          <div><h1>تقرير حركة وإغلاق الوردية</h1><div class="muted">نقاط البيع — تقرير تفصيلي تلقائي</div></div>
          <strong>رقم الوردية: ${escapeHtml(session.id)}</strong>
        </header>
        <section class="meta">
          <div><b>الكاشير</b>${escapeHtml(session.user?.nameAr || session.user?.username || "—")}</div>
          <div><b>الفرع</b>${escapeHtml(session.branch?.nameAr || "—")}</div>
          <div><b>الخزينة</b>${escapeHtml(session.cashBox?.nameAr || "—")}</div>
          <div><b>بداية الوردية</b>${escapeHtml(dateTime(session.openedAt))}</div>
          <div><b>إغلاق الوردية</b>${escapeHtml(dateTime(session.closedAt))}</div>
          <div><b>عدد الفواتير المرحلة</b>${postedInvoices.length}</div>
        </section>
        <section class="summary">
          <div><b>النقد الافتتاحي</b><strong>${money(cash.openingCash)}</strong></div>
          <div><b>مبيعات نقدية</b><strong>${money(cash.cashSales)}</strong></div>
          <div><b>صافي الإيداعات والسحوبات والتحويلات</b><strong>${money(cash.movementNet)}</strong></div>
          <div><b>إجمالي المبيعات المرحلة</b><strong>${money(session.totalSales)}</strong></div>
          <div><b>عدد الفواتير</b><strong>${postedInvoices.length}</strong></div>
          <div class="expected"><b>النقد المتوقع في الخزينة</b><strong>${money(cash.expectedCash)}</strong></div>
        </section>
        <h2>فواتير الوردية</h2>
        <table><thead><tr><th>#</th><th>رقم الفاتورة</th><th>التاريخ</th><th>طريقة الدفع</th><th>البيان / نوع الطلب</th><th>الحالة</th><th>الإجمالي</th></tr></thead><tbody>${invoiceRows}</tbody></table>
        <h2>الحركات النقدية</h2>
        <table><thead><tr><th>#</th><th>التاريخ والوقت</th><th>رقم الحركة</th><th>النوع</th><th>البيان</th><th>المبلغ</th></tr></thead><tbody>${movementRows}</tbody></table>
        <div class="foot">تم إنشاء التقرير تلقائيًا عند إغلاق الوردية. إغلاق الخزينة محسوب من النقد الافتتاحي ومبيعات النقد وصافي الحركات المسجلة.</div>
        <script>window.addEventListener("load",()=>setTimeout(()=>window.print(),350));</script>
      </body>
    </html>`;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}
