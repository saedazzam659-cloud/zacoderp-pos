export type PrintDocumentKey =
  | "sales_invoice"
  | "sales_quotation"
  | "sales_return"
  | "sales_order"
  | "purchase_order"
  | "purchase_invoice"
  | "receipt_voucher"
  | "payment_voucher";

export type PrintFieldVisibility = Partial<
  Record<PrintDocumentKey, Record<string, boolean>>
>;

export function isPrintFieldVisible(
  settings: PrintFieldVisibility | null | undefined,
  document: PrintDocumentKey,
  field: string,
  fallback = true,
): boolean {
  const value = settings?.[document]?.[field];
  return typeof value === "boolean" ? value : fallback;
}

export function shouldRenderPrintColumn(
  settings: PrintFieldVisibility | null | undefined,
  document: PrintDocumentKey | undefined,
  field: string,
  hasData: boolean,
): boolean {
  return hasData && (
    !document || isPrintFieldVisible(settings, document, field)
  );
}

/**
 * Removes explicitly hidden fields and table columns from generated print
 * HTML. Existing templates opt in with data-print-field/data-print-column
 * attributes; unmarked content is left untouched.
 */
export function applyPrintFieldVisibility(
  html: string,
  document: PrintDocumentKey,
  settings: PrintFieldVisibility | null | undefined,
): string {
  const hiddenFields = new Set(
    Object.entries(settings?.[document] ?? {})
      .filter(([, visible]) => visible === false)
      .map(([field]) => field),
  );
  if (hiddenFields.size === 0 || typeof DOMParser === "undefined") return html;

  const parsed = new DOMParser().parseFromString(html, "text/html");
  markLabeledPrintFields(parsed, document);
  markTableColumns(parsed);
  for (const image of Array.from(parsed.querySelectorAll<HTMLImageElement>('img[alt*="qr" i], img[alt*="zatca" i]'))) {
    image.dataset.printField = [image.dataset.printField, "qr"].filter(Boolean).join(" ");
  }
  for (const placeholder of Array.from(parsed.querySelectorAll<HTMLElement>("div"))) {
    if (/^\s*qr\s*zatca\s*$/i.test(placeholder.textContent ?? "")) {
      placeholder.dataset.printField = [placeholder.dataset.printField, "qr"].filter(Boolean).join(" ");
    }
  }
  for (const element of Array.from(parsed.querySelectorAll<HTMLElement>("[data-print-field]"))) {
    const fields = (element.dataset.printField ?? "").split(/\s+/).filter(Boolean);
    if (fields.some((field) => hiddenFields.has(field))) element.remove();
  }

  const hiddenColumns = new Set(
    [...hiddenFields].filter((field) => PRINT_COLUMN_FIELDS.has(field)),
  );
  if (hiddenColumns.size > 0) {
    const markedCells = Array.from(
      parsed.querySelectorAll<HTMLElement>("[data-print-column]"),
    );
    const tables = new Set(markedCells.map((cell) => cell.closest("table")).filter(Boolean));
    for (const table of tables) {
      const cells = Array.from(table!.querySelectorAll<HTMLElement>("[data-print-column]"));
      const hiddenInTable = new Set(
        cells
          .map((cell) => cell.dataset.printColumn ?? "")
          .filter((field) => hiddenColumns.has(field)),
      );
      if (hiddenInTable.size === 0) continue;
      for (const cell of cells) {
        if (hiddenColumns.has(cell.dataset.printColumn ?? "")) cell.remove();
      }
      for (const row of Array.from(table!.querySelectorAll<HTMLTableRowElement>("tr"))) {
        for (const cell of Array.from(row.cells)) {
          if (cell.hasAttribute("data-print-column") || cell.colSpan <= 1) continue;
          cell.colSpan = Math.max(1, cell.colSpan - hiddenInTable.size);
        }
      }
    }
  }

  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

function markLabeledPrintFields(parsed: Document, document: PrintDocumentKey): void {
  const candidates = Array.from(
    parsed.querySelectorAll<HTMLElement>("div,span,p,td,th,label,strong,b,small"),
  );
  for (const candidate of candidates) {
    if (candidate.children.length > 0) continue;
    const text = (candidate.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const field = inferPrintFieldFromLabel(text, document);
    if (!field) continue;

    let target: HTMLElement = candidate;
    const parent = candidate.parentElement;
    if (
      parent &&
      parent !== parsed.body &&
      parent.tagName !== "TR" &&
      !parent.hasAttribute("data-print-field") &&
      (candidate.matches(".lbl,.label,.k") ||
        candidate.tagName === "TD" ||
        (!text.includes(":") && parent.children.length >= 2 && parent.children.length <= 3))
    ) {
      target = parent;
    }
    const existing = new Set((target.dataset.printField ?? "").split(/\s+/).filter(Boolean));
    existing.add(field);
    target.dataset.printField = [...existing].join(" ");
  }
}

function markTableColumns(parsed: Document): void {
  for (const table of Array.from(parsed.querySelectorAll<HTMLTableElement>("table"))) {
    const headerRow = Array.from(table.rows).find((row) =>
      Array.from(row.cells).some((cell) => cell.tagName === "TH"),
    );
    if (!headerRow) continue;
    for (const [index, header] of Array.from(headerRow.cells).entries()) {
      if (header.colSpan > 1) continue;
      const field = header.dataset.printColumn || inferPrintColumnFromLabel(header.textContent ?? "");
      if (!field || !PRINT_COLUMN_FIELDS.has(field)) continue;
      header.dataset.printColumn = field;
      for (const row of Array.from(table.rows)) {
        const cell = row.cells.item(index);
        if (cell) cell.dataset.printColumn = field;
      }
    }
  }
}

function inferPrintColumnFromLabel(text: string): string | undefined {
  const value = text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  if (/^(?:رمز الصنف|كود الصنف|item code|sku)$/.test(value)) return "itemCode";
  if (/^(?:الصنف(?:\s*\/\s*الخدمة)?|اسم الصنف|المنتج|item(?: name)?|product)$/.test(value)) return "itemName";
  if (/^(?:الكمية|qty|quantity)$/.test(value)) return "quantity";
  if (/^(?:الكمية المجانية|مجاني|free qty|free quantity)$/.test(value)) return "freeQuantity";
  if (/^(?:الوحدة|وحدة القياس|unit)$/.test(value)) return "unit";
  if (/^(?:سعر الوحدة|السعر|unit price|price)$/.test(value)) return "unitPrice";
  if (/^(?:نسبة الخصم|discount %|discount percent(?:age)?)$/.test(value)) return "discountPercent";
  if (/^(?:قيمة الخصم|discount amount)$/.test(value)) return "discountAmount";
  if (/^(?:نسبة الضريبة|tax rate|vat rate)$/.test(value)) return "taxRate";
  if (/^(?:قيمة الضريبة|الضريبة|tax amount|vat amount)$/.test(value)) return "taxAmount";
  if (/^(?:إجمالي السطر|إجمالي الصنف|الإجمالي|line total|total)$/.test(value)) return "lineTotal";
  if (/^(?:الوصف|البيان|description)$/.test(value)) return "description";
  if (/^(?:الحساب|اسم الحساب|account)$/.test(value)) return "account";
  if (/^(?:الإجمالي قبل الخصم|subtotal)$/.test(value)) return "subtotal";
  if (/^(?:الإجمالي النهائي|الصافي شامل الضريبة|grand total)$/.test(value)) return "grandTotal";
  return undefined;
}

export function inferPrintFieldFromLabel(
  text: string,
  document: PrintDocumentKey,
): string | undefined {
  const value = text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  if (startsWithPrintLabel(value, ["صالح حتى", "تاريخ الانتهاء", "valid until", "valid through"])) return "validUntil";
  if (startsWithPrintLabel(value, ["تاريخ التسليم", "التسليم المتوقع", "expected delivery"])) return "deliveryDate";
  if (startsWithPrintLabel(value, ["رقم الفاتورة المرتبطة", "linked invoice", "linked invoice no", "linked invoice number"])) return "invoiceNumber";
  if (startsWithPrintLabel(value, [
    "رقم المستند", "رقم السند", "رقم الفاتورة", "رقم عرض", "رقم عرض السعر", "رقم الأمر",
    "invoice no", "invoice number", "document no", "document number", "voucher no", "voucher number",
  ])) return "documentNumber";
  if (startsWithPrintLabel(value, [
    "التاريخ", "تاريخ السند", "تاريخ الفاتورة", "تاريخ العرض", "تاريخ الأمر",
    "date", "invoice date", "document date", "voucher date", "order date",
  ])) return "date";
  if (startsWithPrintLabel(value, ["طريقة الدفع", "payment method"])) return "paymentMethod";
  if (startsWithPrintLabel(value, ["العملة", "currency"])) return "currency";
  if (startsWithPrintLabel(value, ["سعر الصرف", "exchange rate"])) return "exchangeRate";
  if (startsWithPrintLabel(value, ["الفرع", "branch"])) return "branch";
  if (startsWithPrintLabel(value, ["مندوب المبيعات", "مندوب", "salesperson", "sales representative"])) return "seller";
  if (startsWithPrintLabel(value, ["ملاحظات", "notes"])) return "notes";
  if (startsWithPrintLabel(value, ["الشروط والأحكام", "الشروط", "terms", "terms & conditions"])) return "terms";
  if (startsWithPrintLabel(value, ["الحالة", "status"])) return "status";
  if (startsWithPrintLabel(value, ["رمز النقدية", "اسم النقدية", "الخزينة", "cash box", "treasury"])) return "treasury";
  if (startsWithPrintLabel(value, ["حساب البنك", "الحساب", "account"])) return "account";
  if (startsWithPrintLabel(value, ["بيان السند", "البيان", "الوصف", "description"])) return "description";
  if (startsWithPrintLabel(value, ["تاريخ الطباعة", "وقت الطباعة", "printed at"])) return "printedAt";
  if (startsWithPrintLabel(value, ["توقيع", "المدير المالي", "مدير الحسابات", "signature"])) return "signatures";
  return undefined;
}

function startsWithPrintLabel(value: string, labels: string[]): boolean {
  return labels.some((label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}(?=$|[\\s:：#.–-])`, "i").test(value);
  });
}

const PRINT_COLUMN_FIELDS = new Set([
  "itemCode",
  "itemName",
  "quantity",
  "freeQuantity",
  "unit",
  "unitPrice",
  "discountPercent",
  "discountAmount",
  "taxRate",
  "taxAmount",
  "lineTotal",
  "subtotal",
  "grandTotal",
  "description",
  "account",
]);
