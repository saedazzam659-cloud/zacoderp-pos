export type RagmPdfTextItem = {
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
};

type TextRow = { page: number; y: number; items: RagmPdfTextItem[] };

const DIGIT_MAP: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

function asciiDigits(value: string) {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => DIGIT_MAP[digit] ?? digit);
}

function makeRows(items: RagmPdfTextItem[], tolerance = 3): TextRow[] {
  const rows: TextRow[] = [];
  for (const item of [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)) {
    let row = rows.find((candidate) => candidate.page === item.page && Math.abs(candidate.y - item.y) <= tolerance);
    if (!row) {
      row = { page: item.page, y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  return rows;
}

function textInCell(items: RagmPdfTextItem[], rtl = false): string {
  const ordered = [...items].sort((a, b) => rtl ? b.x - a.x : a.x - b.x);
  let result = "";
  let previous: RagmPdfTextItem | undefined;
  for (const item of ordered) {
    if (previous) {
      const gap = rtl
        ? previous.x - (item.x + item.width)
        : item.x - (previous.x + previous.width);
      if (gap > 3 && !result.endsWith(" ")) result += " ";
    }
    result += item.text;
    previous = item;
  }
  return result.replace(/\s+/g, " ").trim().normalize("NFKC");
}

function numberInRow(row: TextRow, minX: number, maxX: number): string {
  const candidates = row.items
    .filter((item) => item.x >= minX && item.x <= maxX)
    .map((item) => asciiDigits(item.text).replace(/[,\s]/g, ""))
    .filter((value) => /^-?\d+(?:\.\d+)?%?$/.test(value));
  return candidates[0] ?? "";
}

function numberValue(value: string, field: string): string {
  const normalized = asciiDigits(value).replace(/,/g, "").replace(/%$/, "").trim();
  if (!normalized || !Number.isFinite(Number(normalized))) {
    throw new Error(`قالب RAGM Cloud: تعذر قراءة ${field} من الفاتورة.`);
  }
  return normalized;
}

function labelItem(items: RagmPdfTextItem[], label: string): RagmPdfTextItem | undefined {
  const normalized = label.toLocaleLowerCase().trim();
  return items.find((item) => item.text.toLocaleLowerCase().trim() === normalized);
}

function valueNearLabel(rows: TextRow[], label: string, field: string): string {
  const anchors = rows.flatMap((row) => row.items).filter((item) =>
    item.text.toLocaleLowerCase().trim() === label.toLocaleLowerCase().trim(),
  );
  if (!anchors.length) throw new Error(`قالب RAGM Cloud: لم أجد خانة ${field}.`);
  const candidates = anchors.flatMap((anchor) => rows
    .filter((candidate) => candidate.page === anchor.page && Math.abs(candidate.y - anchor.y) <= 5)
    .flatMap((candidate) => candidate.items)
    .filter((item) => Math.abs(item.x - anchor.x) < 240)
    .map((item) => ({ item, value: asciiDigits(item.text).replace(/[,\s]/g, ""), anchor }))
    .filter(({ item, value }) => item !== anchor && /^\d+(?:\.\d+)?$/.test(value)));
  candidates.sort((a, b) => Math.abs(a.item.x - a.anchor.x) - Math.abs(b.item.x - b.anchor.x));
  if (!candidates[0]) throw new Error(`قالب RAGM Cloud: تعذر قراءة ${field}.`);
  return candidates[0].value;
}

function dateValue(items: RagmPdfTextItem[], dateLabel: RagmPdfTextItem): { date: string; time: string } {
  const headerRow = items.filter((item) => item.page === dateLabel.page && Math.abs(item.y - dateLabel.y) <= 3);
  const dateToken = headerRow.find((item) => /\b\d{1,2}[./-]\d{1,2}[./-]\d{4}\b/.test(asciiDigits(item.text)));
  if (!dateToken) throw new Error("قالب RAGM Cloud: تاريخ الفاتورة غير مقروء.");
  const match = asciiDigits(dateToken.text).match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (!match) throw new Error("قالب RAGM Cloud: تنسيق التاريخ غير مدعوم.");
  const [, day, month, year] = match;
  const isoDate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const time = headerRow.find((item) => /\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(item.text))?.text ?? "";
  const timeMatch = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!timeMatch) return { date: isoDate, time: "" };
  let hour = Number(timeMatch[1]) % 12;
  if (timeMatch[3].toUpperCase() === "PM") hour += 12;
  return { date: isoDate, time: `${String(hour).padStart(2, "0")}:${timeMatch[2]}:00` };
}

function parsePaymentType(items: RagmPdfTextItem[]): string {
  const text = items.map((item) => item.text).join(" ").normalize("NFKC").toLocaleLowerCase();
  if (text.includes("نقدي") || /\bcash\b/.test(text)) return "cash";
  if (text.includes("تحويل بنكي") || /\bbank transfer\b/.test(text)) return "bank";
  if (text.includes("آجل") || text.includes("اجل") || /\bcredit\b/.test(text)) return "credit";
  return "";
}

function itemRows(items: RagmPdfTextItem[], rows: TextRow[], headerY: number) {
  const headerYByPage = new Map<number, number>();
  for (const item of items) {
    if (item.text.toLocaleLowerCase().trim() === "item code" && !headerYByPage.has(item.page)) {
      headerYByPage.set(item.page, item.y);
    }
  }
  const codes = items.filter((item) =>
    item.x >= 35 && item.x <= 85 && item.y < (headerYByPage.get(item.page) ?? headerY) - 4
      && /^\s*[\da-z-]+\s*$/i.test(asciiDigits(item.text)),
  );
  const parsed = codes.map((code) => {
    const detailRow = rows
      .filter((row) => row.page === code.page && row.y < code.y && code.y - row.y <= 14)
      .sort((a, b) => Math.abs((code.y - a.y) - 6) - Math.abs((code.y - b.y) - 6))[0];
    if (!detailRow) throw new Error("قالب RAGM Cloud: لم أجد تفاصيل سطر الصنف المرتبطة بكوده.");
    const cell = (minX: number, maxX: number) => textInCell(
      detailRow.items.filter((item) => item.x >= minX && item.x <= maxX),
      true,
    );
    const itemName = cell(80, 227);
    const unitName = cell(228, 260);
    const quantity = numberInRow(detailRow, 300, 345);
    const unitPrice = numberInRow(detailRow, 260, 300);
    const discount = numberInRow(detailRow, 345, 378) || "0";
    const freeQty = numberInRow(detailRow, 378, 405) || "0";
    const netLineAmount = numberInRow(detailRow, 405, 442);
    const vatRate = numberInRow(detailRow, 442, 470);
    const vatAmount = numberInRow(detailRow, 470, 510);
    const total = numberInRow(detailRow, 510, 570);
    if (!itemName || !quantity || !unitPrice || !netLineAmount || !vatRate || !vatAmount || !total) {
      throw new Error("قالب RAGM Cloud: بيانات أحد أسطر الأصناف ناقصة أو لا تطابق القالب.");
    }
    return {
      item_code: asciiDigits(code.text).trim(),
      item_name: itemName,
      unit_name: unitName,
      unit_price: numberValue(unitPrice, "سعر الوحدة"),
      qty: numberValue(quantity, "الكمية"),
      discount_percent: numberValue(discount, "الخصم"),
      free_qty: numberValue(freeQty, "الكمية المجانية"),
      line_discount_amount: Math.max(
        0,
        Number(numberValue(unitPrice, "سعر الوحدة")) * Number(numberValue(quantity, "الكمية"))
          - Number(numberValue(netLineAmount, "صافي السطر")),
      ).toFixed(2),
      line_total: numberValue(netLineAmount, "صافي السطر"),
      vat_rate: numberValue(vatRate, "نسبة الضريبة"),
      vat_amount: numberValue(vatAmount, "ضريبة السطر"),
      printed_total: numberValue(total, "إجمالي السطر شامل الضريبة"),
    };
  });
  return parsed;
}

export function parseRagmCloudSalesInvoicePdf(items: RagmPdfTextItem[]) {
  const visibleText = items.map((item) => item.text).join(" ").toLocaleLowerCase();
  if (!visibleText.includes("invoice no") || !visibleText.includes("item description")
    || !visibleText.includes("vat amount") || !visibleText.includes("included vat net")) {
    throw new Error("الـPDF لا يطابق قالب فاتورة المبيعات المحدد RAGM Cloud.");
  }
  const invoiceLabel = labelItem(items, "invoice no");
  const accountLabel = labelItem(items, "account no");
  const dateLabel = labelItem(items, "date");
  const headerItems = items;
  const rows = makeRows(headerItems);
  if (!invoiceLabel || !accountLabel || !dateLabel) {
    throw new Error("قالب RAGM Cloud: بيانات رقم الفاتورة أو العميل أو التاريخ غير مكتملة.");
  }
  const sourceNumber = valueNearLabel(rows, "invoice no", "رقم الفاتورة");
  const partyCode = valueNearLabel(rows, "account no", "كود العميل");
  const date = dateValue(headerItems, dateLabel);
  const customerRow = rows.find((row) => row.page === dateLabel.page && Math.abs(row.y - dateLabel.y) <= 3);
  const partyName = customerRow
    ? textInCell(customerRow.items.filter((item) => item.x >= 135 && item.x <= 255), true)
      .replace(/[:：]/g, "").trim()
    : "";
  if (!partyName) throw new Error("قالب RAGM Cloud: اسم العميل غير مقروء.");

  const headerY = items.find((item) => item.text.toLocaleLowerCase().trim() === "item code")?.y;
  if (headerY == null) throw new Error("قالب RAGM Cloud: لم أجد جدول الأصناف.");
  const lines = itemRows(headerItems, rows, headerY);
  if (!lines.length) throw new Error("قالب RAGM Cloud: لا توجد أسطر أصناف قابلة للقراءة.");

  const joinedPageText = rows.map((row) => textInCell(row.items, true)).join(" ").normalize("NFKC").toLocaleLowerCase();
  const compactPageText = joinedPageText.replace(/\s+/g, "");
  const currencyCode = /\bsar\b/.test(visibleText)
    || ((compactPageText.includes("سعودي")) && /ريال|ریال|﷼/.test(compactPageText))
    ? "SAR"
    : "";
  const exchangeRate = currencyCode === "SAR" ? "1" : "";
  const subtotal = valueNearLabel(rows, "net vat excluded", "الإجمالي قبل الضريبة");
  const vatAmount = valueNearLabel(rows, "vat amount", "قيمة الضريبة");
  const discountAmount = valueNearLabel(rows, "discount amount", "إجمالي الخصم");
  const totalAmount = valueNearLabel(rows, "included vat net", "الإجمالي شامل الضريبة");
  const documentRows = lines.map((line) => ({
    source_doc_number: sourceNumber,
    document_date: date.date,
    source_datetime: date.time ? `${date.date}T${date.time}` : "",
    party_code: partyCode,
    party_name: partyName,
    branch_code: "",
    item_code: line.item_code,
    item_name: line.item_name,
    unit_code: "",
    unit_name: line.unit_name,
    warehouse_code: "",
    qty: line.qty,
    free_qty: line.free_qty,
    unit_price: line.unit_price,
    discount_percent: line.discount_percent,
    line_discount_amount: line.line_discount_amount,
    vat_rate: line.vat_rate,
    line_total: line.line_total,
    subtotal,
    vat_amount: numberValue(vatAmount, "قيمة الضريبة"),
    discount_amount: numberValue(discountAmount, "إجمالي الخصم"),
    total_amount: numberValue(totalAmount, "الإجمالي شامل الضريبة"),
    payment_type: parsePaymentType(headerItems),
    currency_code: currencyCode,
    exchange_rate: exchangeRate,
    price_includes_vat: "false",
    total_expenses_loaded: "0",
  }));
  // Refuse a parse if the printed line values do not reconcile with the invoice totals.
  const subtotalValue = Number(subtotal);
  const vatValue = Number(vatAmount);
  const totalValue = Number(totalAmount);
  const sumOfLines = lines.reduce((sum, line) => sum + Number(line.line_total), 0);
  const sumOfLineVat = lines.reduce((sum, line) => sum + Number(line.vat_amount), 0);
  const lineTotalsReconcile = lines.every((line) =>
    Math.abs(Number(line.line_total) + Number(line.vat_amount) - Number(line.printed_total)) <= 0.02,
  );
  if (![subtotalValue, vatValue, totalValue, sumOfLines].every(Number.isFinite)
    || Math.abs(subtotalValue + vatValue - totalValue) > 0.02
    || Math.abs(sumOfLines - subtotalValue) > 0.02
    || Math.abs(sumOfLineVat - vatValue) > 0.02
    || !lineTotalsReconcile) {
    throw new Error("قالب RAGM Cloud: إجماليات السطور لا تتطابق مع إجمالي الفاتورة؛ راجع PDF يدويًا.");
  }
  return documentRows;
}
