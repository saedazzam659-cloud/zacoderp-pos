export type CsvRow = Record<string, string>;

function parseCsvGrid(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function parseWrappedItemRows(text: string, expectedWidth: number): string[][] {
  const outerRows = parseCsvGrid(text);
  const output: string[][] = [];
  for (let index = 1; index < outerRows.length; index += 1) {
    const outer = outerRows[index];
    if (outer.length !== 1) {
      if (outer.length === expectedWidth) {
        output.push(outer);
        continue;
      }
      throw new Error(`سطر ${index + 1} لا يطابق عدد أعمدة ملف الأصناف.`);
    }
    let inner = parseCsvGrid(outer[0])[0] ?? [];
    if (inner.length !== expectedWidth && index + 1 < outerRows.length && outerRows[index + 1].length === 1) {
      // Some legacy exporters split a quoted item description over two CSV
      // records. Close the broken description at the join only when the
      // repaired row has exactly the declared number of columns.
      const repaired = parseCsvGrid(`${outer[0]}"${outerRows[index + 1][0]}`)[0] ?? [];
      if (repaired.length === expectedWidth) {
        inner = repaired;
        index += 1;
      }
    }
    if (inner.length !== expectedWidth) {
      throw new Error(`تعذر إصلاح سطر الأصناف ${index + 1} بأمان؛ لم تُسقط أي بيانات.`);
    }
    output.push(inner);
  }
  return output;
}

function headerIndex(header: string[]): Map<string, number> {
  return new Map(header.map((cell, index) => [
    cell.replace(/^\uFEFF/, "").trim().toLocaleLowerCase(),
    index,
  ]));
}

export function isInvoiceHeaderCsv(text: string): boolean {
  const headers = headerIndex(parseCsvGrid(text)[0] ?? []);
  return headers.has("invoiceno") && headers.has("clientno") && headers.has("summarytotal");
}

export function isPurchaseOrderHeaderCsv(text: string): boolean {
  const headers = headerIndex(parseCsvGrid(text)[0] ?? []);
  return headers.has("purchaseorderno") && headers.has("supplierno") && headers.has("summarytotal");
}

export function isInvoiceItemsCsv(text: string): boolean {
  const headers = headerIndex(parseCsvGrid(text)[0] ?? []);
  return headers.has("no") && headers.has("item") && headers.has("unit_price") && headers.has("quantity");
}

function value(row: string[], headers: Map<string, number>, name: string): string {
  const index = headers.get(name.toLocaleLowerCase());
  return index == null ? "" : String(row[index] ?? "").trim();
}

function toNumber(value: string, fallback = 0): number {
  const parsed = Number(value.replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value: number): string {
  return value.toFixed(2);
}

export function decodeInvoiceCsv(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^\uFEFF/, "");
  } catch {
    // Legacy Windows exports commonly use Windows-1256 for Arabic text.
    return new TextDecoder("windows-1256").decode(data).replace(/^\uFEFF/, "");
  }
}

/**
 * Converts a linked Invoices.csv + Invoice_items.csv export into the ERP's
 * unified historical invoice row contract. No invoice or master data is
 * created here; callers still run the normal review and master matching.
 */
function convertLinkedInvoiceCsv(
  invoicesText: string,
  itemsText: string,
  sourceKind: "sales" | "purchase",
): { rows: CsvRow[]; warnings: string[] } {
  const invoiceGrid = parseCsvGrid(invoicesText);
  const itemGrid = parseCsvGrid(itemsText);
  if (invoiceGrid.length < 2 || itemGrid.length < 2) {
    throw new Error("ملفا الفواتير والأصناف يجب أن يحتوي كل منهما على عناوين وصفوف بيانات.");
  }

  const invoiceHeaders = headerIndex(invoiceGrid[0]);
  const itemHeaders = headerIndex(itemGrid[0]);
  const numberField = sourceKind === "sales" ? "InvoiceNo" : "PurchaseOrderNo";
  const partyNumberField = sourceKind === "sales" ? "ClientNo" : "SupplierNo";
  const businessNameField = sourceKind === "sales" ? "ClientBusinessName" : "SupplierBusinessName";
  const firstNameField = sourceKind === "sales" ? "ClientFirstName" : "SupplierFirstName";
  const lastNameField = sourceKind === "sales" ? "ClientLastName" : "SupplierLastName";
  const documentLabel = sourceKind === "sales" ? "فاتورة المبيعات" : "فاتورة المشتريات";
  const requiredInvoiceFields = [numberField.toLocaleLowerCase(), "date", partyNumberField.toLocaleLowerCase(), "currencycode", "summarytotal"];
  const requiredItemFields = ["no", "item", "unit_price", "quantity", "subtotal", "subtotal_without_tax", "tax1_value", "tax1_amount"];
  if (requiredInvoiceFields.some((field) => !invoiceHeaders.has(field))) {
    throw new Error(`ملف الرؤوس لا يحتوي أعمدة ${numberField} و${partyNumberField} والتاريخ والعملة والإجمالي المطلوبة.`);
  }
  if (requiredItemFields.some((field) => !itemHeaders.has(field))) {
    throw new Error("ملف الأصناف لا يحتوي أعمدة الفاتورة والصنف والسعر والكمية والضريبة المطلوبة.");
  }

  const invoiceByNumber = new Map<string, string[]>();
  for (const row of invoiceGrid.slice(1)) {
    const number = value(row, invoiceHeaders, numberField);
    if (!number) continue;
    if (invoiceByNumber.has(number)) throw new Error(`رقم الفاتورة ${number} مكرر في ملف الرؤوس.`);
    invoiceByNumber.set(number, row);
  }

  const width = itemGrid[0].length;
  const itemRows = parseWrappedItemRows(itemsText, width);
  const itemsByInvoice = new Map<string, string[][]>();
  for (const row of itemRows) {
    const rawNumber = value(row, itemHeaders, "no");
    const number = rawNumber.replace(/^[\uFEFF?]+/, "");
    if (!number) continue;
    const current = itemsByInvoice.get(number) ?? [];
    current.push(row);
    itemsByInvoice.set(number, current);
  }

  const missingItems = [...invoiceByNumber.keys()].filter((number) => !itemsByInvoice.has(number));
  const orphanItems = [...itemsByInvoice.keys()].filter((number) => !invoiceByNumber.has(number));
  if (missingItems.length || orphanItems.length) {
    throw new Error(
      `تعذر ربط الملفين بالكامل: ${missingItems.length} فاتورة بلا سطور و${orphanItems.length} رقم صنف بلا رأس فاتورة.`,
    );
  }

  const rows: CsvRow[] = [];
  const warnings: string[] = [];
  for (const [number, header] of invoiceByNumber) {
    const lines = itemsByInvoice.get(number) ?? [];
    const currency = value(header, invoiceHeaders, "CurrencyCode").toUpperCase();
    const paymentStatus = value(header, invoiceHeaders, "PaymentStatus");
    const normalizedPaymentStatus = paymentStatus.toLocaleLowerCase().replace(/\s+/g, " ").trim();
    const paid = toNumber(value(header, invoiceHeaders, "SummaryPaid"));
    if (paid > 0 || normalizedPaymentStatus === "paid" || normalizedPaymentStatus === "partial paid") {
      warnings.push(`${documentLabel} ${number}: المصدر يذكر دفعة سابقة؛ الملفان لا يحتويان وسيلة أو مستند التحصيل لربطها.`);
    }

    const subtotal = lines.reduce((sum, line) => sum + toNumber(value(line, itemHeaders, "subtotal_without_tax")), 0);
    const vatAmount = lines.reduce((sum, line) => sum + toNumber(value(line, itemHeaders, "tax1_amount")), 0);
    const sourceTotal = toNumber(value(header, invoiceHeaders, "SummaryTotal"), Number.NaN);
    const lineTotal = lines.reduce((sum, line) => sum + toNumber(value(line, itemHeaders, "subtotal")), 0);
    if (!Number.isFinite(sourceTotal) || Math.abs(lineTotal - sourceTotal) > Math.max(0.02, lines.length * 0.01)) {
      throw new Error(`إجمالي سطور ${documentLabel} ${number} لا يطابق إجمالي الرأس؛ أوقفنا التحويل بدل تغيير المبالغ.`);
    }
    const partyName = value(header, invoiceHeaders, businessNameField)
      || [value(header, invoiceHeaders, firstNameField), value(header, invoiceHeaders, lastNameField)].filter(Boolean).join(" ");
    for (const line of lines) {
      rows.push({
        source_doc_number: number,
        document_date: value(header, invoiceHeaders, "Date") || value(header, invoiceHeaders, "IssueDate"),
        source_invoice_number: "",
        party_code: value(header, invoiceHeaders, partyNumberField),
        party_name: partyName,
        branch_code: "",
        item_code: "",
        item_name: value(line, itemHeaders, "item"),
        unit_code: "",
        unit_name: "",
        warehouse_code: "",
        qty: value(line, itemHeaders, "quantity"),
        free_qty: "0",
        unit_price: value(line, itemHeaders, "unit_price"),
        discount_percent: "0",
        line_discount_amount: "0",
        vat_rate: value(line, itemHeaders, "tax1_value"),
        line_total: value(line, itemHeaders, "subtotal"),
        subtotal: roundMoney(subtotal),
        vat_amount: roundMoney(vatAmount),
        discount_amount: value(header, invoiceHeaders, "SummaryDiscount") || "0",
        total_amount: value(header, invoiceHeaders, "SummaryTotal"),
        payment_type: paid <= 0 && normalizedPaymentStatus === "unpaid" ? "credit" : "",
        currency_code: currency,
        exchange_rate: currency === "SAR" ? "1" : "",
        cash_box_code: "",
        bank_account_code: "",
        price_includes_vat: "false",
        total_expenses_loaded: "0",
        line_notes: value(line, itemHeaders, "description"),
      });
    }
  }
  return { rows, warnings };
}

export function convertLinkedSalesInvoiceCsv(invoicesText: string, itemsText: string) {
  return convertLinkedInvoiceCsv(invoicesText, itemsText, "sales");
}

export function convertLinkedPurchaseInvoiceCsv(invoicesText: string, itemsText: string) {
  const converted = convertLinkedInvoiceCsv(invoicesText, itemsText, "purchase");
  return {
    ...converted,
    warnings: [
      "رأس الملف يستخدم PurchaseOrderNo وليس رقم فاتورة المورد؛ راجع رقم المستند وتأكد أنه يطابق رقم الفاتورة.",
      "ملف أمر الشراء لا يثبت استلام البضاعة؛ لا تُرحّل حركة المخزون إلا بعد تأكيد الكميات المستلمة فعليًا.",
      ...converted.warnings,
    ],
  };
}
