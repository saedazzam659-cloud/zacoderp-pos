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

function inferPrintFieldFromLabel(
  text: string,
  document: PrintDocumentKey,
): string | undefined {
  const value = text.toLocaleLowerCase();
  if (/^(?:تاريخ التسليم|التسليم المتوقع|expected delivery)\b/.test(value)) return "deliveryDate";
  if (/^(?:رقم الفاتورة المرتبطة|linked invoice(?:\s*(?:no\.?|number))?)\b/.test(value)) return "invoiceNumber";
  if (/^(?:رقم (?:المستند|السند|الفاتورة|عرض(?: السعر)?|الأمر)|(?:invoice|document|voucher)\s*(?:no\.?|number))\b/.test(value)) return "documentNumber";
  if (/^(?:التاريخ|تاريخ (?:السند|الفاتورة|العرض|الأمر)|(?:invoice|document|voucher|order)?\s*date)\b/.test(value)) return "date";
  if (/^(?:طريقة الدفع|payment method)\b/.test(value)) return "paymentMethod";
  if (/^(?:العملة|currency)\b/.test(value)) return "currency";
  if (/^(?:سعر الصرف|exchange rate)\b/.test(value)) return "exchangeRate";
  if (/^(?:الفرع|branch)\b/.test(value)) return "branch";
  if (/^(?:مندوب المبيعات|مندوب|salesperson|sales representative)\b/.test(value)) return "seller";
  if (/^(?:ملاحظات|notes)\b/.test(value)) return "notes";
  if (/^(?:الشروط والأحكام|الشروط|terms(?:\s*&\s*conditions)?)\b/.test(value)) return "terms";
  if (/^(?:الحالة|status)\b/.test(value)) return "status";
  if (/^(?:رمز النقدية|اسم النقدية|الخزينة|cash box|treasury)\b/.test(value)) return "treasury";
  if (/^(?:حساب البنك|الحساب|account)\b/.test(value)) return "account";
  if (/^(?:بيان السند|البيان|الوصف|description)\b/.test(value)) return "description";
  if (/^(?:تاريخ الطباعة|وقت الطباعة|printed at)\b/.test(value)) return "printedAt";
  if (/^(?:توقيع|المدير المالي|مدير الحسابات|signature)\b/.test(value)) return "signatures";
  return undefined;
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
