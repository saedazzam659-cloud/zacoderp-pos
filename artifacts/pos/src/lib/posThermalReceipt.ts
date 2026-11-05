import { getItemSalePrice, getSalePriceOptionName, getSalePriceOptions, type SalesInvoice } from "@/lib/api";

type ReceiptLine = {
  item: any;
  qty: number;
  selectedSaleOptionId?: string;
  modifierSelection?: Array<{ groupId: string; optionIds: string[] }>;
};

type PrintReceiptOptions = {
  invoice: SalesInvoice | null;
  cart: ReceiptLine[];
  subtotal: number;
  discountAmount: number;
  vatAmount: number;
  grandTotal: number;
  method: string;
  companyName: string;
  companyNameEn?: string;
  companyVatNumber?: string;
  companyCrNumber?: string;
  companyCity?: string;
  companyLogo: string | null;
  cashierName: string;
  widthMm?: 58 | 80;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}

function money(value: number): string {
  return new Intl.NumberFormat("ar-SA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function paymentLabel(method: string): string {
  return ({
    cash: "نقدي",
    card: "شبكة",
    apple: "Apple Pay",
    wallet: "محفظة إلكترونية",
    mixed: "دفع مختلط",
  } as Record<string, string>)[method] ?? method;
}

function receiptHtml(options: PrintReceiptOptions): string {
  const width = options.widthMm ?? 80;
  const printableWidth = width === 80 ? 72 : 52;
  const rows = options.cart.map(({ item, qty, selectedSaleOptionId, modifierSelection }) => {
    const price = getItemSalePrice(item, selectedSaleOptionId);
    const rawRate = item?.vatRate == null ? 15 : Number(item.vatRate);
    const vatRate = Number.isFinite(rawRate) ? rawRate : 15;
    const gross = price * qty;
    const discountShare = options.subtotal > 0
      ? options.discountAmount * gross / options.subtotal
      : 0;
    const net = Math.max(0, gross - discountShare);
    const vat = net * vatRate / 100;
    const total = net + vat;
    const option = selectedSaleOptionId
      ? getSalePriceOptions(item).find((candidate) => candidate.id === selectedSaleOptionId)
      : undefined;
    const optionName = getSalePriceOptionName(option) ?? "";
    const itemName = optionName
      ? `${item?.nameAr ?? item?.nameEn ?? "—"} — ${optionName}`
      : item?.nameAr ?? item?.nameEn ?? item?.code ?? "—";
    const selected = new Map((modifierSelection ?? []).map(entry => [entry.groupId, new Set(entry.optionIds)]));
    const selectedOptions = (item?.restaurantModifierGroups ?? []).flatMap((group: any) =>
      (group.options ?? []).filter((addon: any) => selected.get(group.id)?.has(addon.id))
        .map((addon: any) => ({ group, addon })),
    );
    const optionNames = selectedOptions.map(({ group, addon }: any) => `${group.nameAr}: ${addon.nameAr}`).join("، ");
    const mainRow = `<tr><td colspan="2" class="item-name">${escapeHtml(itemName)}${item?.code ? `<small>${escapeHtml(item.code)}</small>` : ""}${optionNames ? `<small>${escapeHtml(optionNames)}</small>` : ""}</td></tr>
      <tr class="line-detail">
        <td><span class="mono">${money(qty)} × ${money(price)}</span></td>
        <td class="mono tax">${money(vatRate)}%</td>
        <td class="mono amount">${money(total)}</td>
      </tr>`;
    const addonRows = selectedOptions.map(({ addon }: any) => {
      const consumption = Number(addon.consumptionQtyPerSelection) || 1;
      const addonGross = Number(addon.extraPrice) * qty;
      const addonDiscount = options.subtotal > 0 ? options.discountAmount * addonGross / options.subtotal : 0;
      const addonRate = Number.isFinite(Number(addon.vatRate)) ? Number(addon.vatRate) : vatRate;
      const addonTotal = Math.max(0, addonGross - addonDiscount) * (1 + addonRate / 100);
      const addonQty = qty * consumption;
      return `<tr><td colspan="2" class="item-name">${escapeHtml(addon.nameAr)} — ${escapeHtml(itemName)}</td></tr>
        <tr class="line-detail"><td><span class="mono">${money(addonQty)} × ${money(Number(addon.extraPrice) / consumption)}</span></td><td class="mono tax">${money(addonRate)}%</td><td class="mono amount">${money(addonTotal)}</td></tr>`;
    }).join("");
    return mainRow + addonRows;
  }).join("");
  const logo = options.companyLogo
    ? `<img class="logo" src="${escapeHtml(options.companyLogo)}" alt="">`
    : "";
  const invoiceNo = options.invoice?.docNumber || options.invoice?.id || "—";
  const date = options.invoice?.invoiceDate
    ? new Date(options.invoice.invoiceDate).toLocaleString("ar-SA-u-ca-gregory-nu-latn")
    : new Date().toLocaleString("ar-SA-u-ca-gregory-nu-latn");
  const currency = options.invoice?.currencyCode || "ر.س";

  return `<!doctype html>
  <html lang="ar" dir="rtl">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>إيصال ${escapeHtml(invoiceNo)}</title>
      <style>
        @page { size: ${width}mm auto; margin: 0; }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; width: ${width}mm; background: #fff; color: #000; }
        body { direction: rtl; font: 12px/1.5 Tahoma, Arial, sans-serif; }
        main { width: ${printableWidth}mm; max-width: ${printableWidth}mm; margin: 0 auto; padding: 3mm 1mm 5mm; }
        .center { text-align: center; }
        .logo { display: block; max-width: 42mm; max-height: 18mm; object-fit: contain; margin: 0 auto 2mm; }
        .company { font-size: 16px; font-weight: 800; overflow-wrap: anywhere; }
        .title { display: inline-block; margin: 2mm auto 1mm; border: 1.5px solid #000; padding: 1mm 4mm; font-weight: 800; }
        .meta { font-size: 11px; font-weight: 600; overflow-wrap: anywhere; }
        .mono { direction: ltr; unicode-bidi: isolate; font-family: Arial, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .rule { border-top: 1px dashed #555; margin: 2mm 0; }
        .info { display: flex; justify-content: space-between; gap: 4px; font-size: 11px; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 2mm; font-size: 11px; }
        td, th { vertical-align: top; padding: 1.2mm 0.5mm; }
        th { border-top: 1.5px solid #000; border-bottom: 1.5px solid #000; font-weight: 800; }
        .item-name { font-weight: 700; overflow-wrap: anywhere; }
        small { display: block; color: #333; font-size: 10px; }
        .line-detail td { border-bottom: 1px dashed #999; padding-top: 0; }
        .tax { text-align: center; width: 11mm; }
        .amount { text-align: left; font-weight: 700; width: 19mm; }
        .totals { margin-top: 2mm; }
        .total-row { display: flex; justify-content: space-between; gap: 4mm; padding: 1mm 0; }
        .grand { margin-top: 1mm; padding: 2mm 0; border-top: 1.5px solid #000; border-bottom: 1.5px solid #000; font-size: 15px; font-weight: 800; }
        footer { margin-top: 3mm; padding-top: 2mm; border-top: 1.5px solid #000; text-align: center; font-size: 10px; }
        @media print { html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      </style>
    </head>
    <body><main>
      <header class="center">
        ${logo}
        <div class="company">${escapeHtml(options.companyName || "اسم الشركة")}</div>
        ${options.companyNameEn ? `<div class="meta">${escapeHtml(options.companyNameEn)}</div>` : ""}
        <div class="meta">${[
          options.companyVatNumber ? `الرقم الضريبي: ${options.companyVatNumber}` : "",
          options.companyCrNumber ? `السجل التجاري: ${options.companyCrNumber}` : "",
          options.companyCity || "",
        ].filter(Boolean).map(escapeHtml).join(" · ")}</div>
        <div class="title">إيصال بيع</div>
        <div class="meta">رقم الفاتورة: <span class="mono">${escapeHtml(invoiceNo)}</span></div>
        <div class="meta">${escapeHtml(date)}</div>
      </header>
      <div class="rule"></div>
      <div class="info"><span>الكاشير</span><strong>${escapeHtml(options.cashierName || "—")}</strong></div>
      <div class="info"><span>طريقة الدفع</span><strong>${escapeHtml(paymentLabel(options.method))}</strong></div>
      <table>
        <thead><tr>
          <th style="text-align:right;">الصنف / الكمية × السعر</th>
          <th style="text-align:center;width:11mm;">ض.</th>
          <th style="text-align:left;width:19mm;">الإجمالي</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <section class="totals">
        <div class="total-row"><span>المجموع قبل الخصم</span><span class="mono">${money(options.subtotal)} ${escapeHtml(currency)}</span></div>
        ${options.discountAmount > 0 ? `<div class="total-row"><span>الخصم</span><span class="mono">− ${money(options.discountAmount)} ${escapeHtml(currency)}</span></div>` : ""}
        <div class="total-row"><span>ضريبة القيمة المضافة</span><span class="mono">${money(options.vatAmount)} ${escapeHtml(currency)}</span></div>
        <div class="total-row grand"><span>الإجمالي</span><span class="mono">${money(options.grandTotal)} ${escapeHtml(currency)}</span></div>
      </section>
      <div class="rule"></div>
      <div class="info"><span>عدد الأصناف</span><strong class="mono">${options.cart.length}</strong></div>
      <div class="info"><span>إجمالي الكميات</span><strong class="mono">${money(options.cart.reduce((sum, line) => sum + line.qty, 0))}</strong></div>
      <footer>شكراً لزيارتكم</footer>
    </main></body>
  </html>`;
}

export function printPosThermalReceipt(options: PrintReceiptOptions): boolean {
  const printWindow = window.open("", "_blank", "width=420,height=800");
  if (!printWindow) return false;
  printWindow.document.open();
  printWindow.document.write(receiptHtml(options));
  printWindow.document.close();
  const printWhenReady = async () => {
    await Promise.all(Array.from(printWindow.document.images).map((image) =>
      image.decode().catch(() => undefined),
    ));
    printWindow.focus();
    printWindow.addEventListener("afterprint", () => printWindow.close(), { once: true });
    window.setTimeout(() => {
      printWindow.print();
    }, 250);
  };
  if (printWindow.document.readyState === "complete") void printWhenReady();
  else printWindow.addEventListener("load", () => void printWhenReady(), { once: true });
  return true;
}
