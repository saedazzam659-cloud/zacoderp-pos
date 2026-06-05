// Bulk invoice import — parsing + ZATCA validation (Task #228).
//
// Pure, UI-free logic so it can be exercised in isolation. The screen
// (pages/InvoiceImport.tsx) owns the editable draft state and re-runs
// `validateInvoices` on every inline edit, so this module never mutates
// its inputs and never touches the DOM / Tauri.
//
// Each spreadsheet ROW is one invoice LINE. Rows that share the same
// `invoiceRef` are grouped into a single invoice; a blank ref makes the
// row its own one-line invoice. An invoice is only ever committed when
// EVERY line in it is valid AND the invoice-level header passes — never a
// partial document (ZATCA invoices are atomic).
//
// Validation deliberately recomputes VAT from quantity × unitPrice via the
// shared `computeTotals` (same engine the POS register uses) — file totals
// are never trusted.

import { computeTotals, type TaxMode } from "./taxSettings";
import type { LocalItem } from "./items";
import type { LocalCustomer } from "./customers";
import type { OfflineInvoicePayload } from "./invoices";

export type ZatcaInvoiceType = "standard" | "simplified";

// Canonical column keys + their accepted (case-insensitive) header aliases.
// The first alias is the canonical English header used in the template.
export const COLUMN_ALIASES: Record<keyof RawDraftFields, string[]> = {
  invoiceRef:     ["invoiceref", "invoiceno", "invoice", "ref", "رقم الفاتورة", "مرجع"],
  invoiceType:    ["invoicetype", "type", "نوع الفاتورة", "النوع"],
  customerName:   ["customername", "customer", "buyer", "اسم العميل", "العميل"],
  customerVat:    ["customervat", "vatnumber", "vat", "buyervat", "trn", "الرقم الضريبي"],
  itemCode:       ["itemcode", "code", "sku", "كود الصنف", "الكود"],
  barcode:        ["barcode", "ean", "الباركود"],
  itemName:       ["itemname", "item", "product", "اسم الصنف", "الصنف"],
  quantity:       ["quantity", "qty", "الكمية"],
  unitPrice:      ["unitprice", "price", "saleprice", "سعر الوحدة", "السعر"],
  vatRate:        ["vatrate", "taxrate", "نسبة الضريبة", "الضريبة"],
  paymentMethod:  ["paymentmethod", "payment", "طريقة الدفع", "الدفع"],
};

type RawDraftFields = {
  invoiceRef: string;
  invoiceType: string;
  customerName: string;
  customerVat: string;
  itemCode: string;
  barcode: string;
  itemName: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
  paymentMethod: string;
};

export interface ImportRowDraft extends RawDraftFields {
  /** 1-based source row number (header = 1) shown to the operator. */
  rowNum: number;
}

export const EDITABLE_TEMPLATE_HEADER =
  "invoiceRef,invoiceType,customerName,customerVat,itemCode,barcode,itemName,quantity,unitPrice,vatRate,paymentMethod";

export const SAMPLE_INVOICE_CSV = `${EDITABLE_TEMPLATE_HEADER}
INV-1001,standard,شركة الأفق التجارية,300000000000003,A001,6281007123456,ماء معدني 500مل,10,1.50,15,cash
INV-1001,standard,شركة الأفق التجارية,300000000000003,A002,,شيبس صغير,5,3.00,15,cash
INV-1002,simplified,,,A003,,قلم جاف أزرق,3,2.50,15,card
`;

// ─── CSV parsing (BOM + quotes + escapes + CRLF) ────────────────────────
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(cell); cell = ""; i++; continue; }
    if (c === "\n" || c === "\r") {
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") out.push(row);
      row = [];
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++; continue;
    }
    cell += c; i++;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}

export class ImportParseError extends Error {}

/** Parse raw CSV text into editable drafts. Throws ImportParseError with an
 *  Arabic, operator-friendly message when the file is empty or the header is
 *  missing the columns needed to identify an item. */
export function parseInvoiceCsv(text: string): ImportRowDraft[] {
  const grid = parseCsv(text);
  if (grid.length < 2) {
    throw new ImportParseError("الملف فارغ أو لا يحتوي على صف بيانات واحد على الأقل بعد العناوين.");
  }
  const header = grid[0].map((h) => h.trim().toLowerCase());
  const colIndex: Partial<Record<keyof RawDraftFields, number>> = {};
  (Object.keys(COLUMN_ALIASES) as (keyof RawDraftFields)[]).forEach((key) => {
    for (const alias of COLUMN_ALIASES[key]) {
      const idx = header.indexOf(alias.toLowerCase());
      if (idx >= 0) { colIndex[key] = idx; break; }
    }
  });

  // To create a line we must be able to identify the item by at least one of
  // barcode / itemCode / itemName, and have quantity + unitPrice.
  const hasItemId = colIndex.barcode != null || colIndex.itemCode != null || colIndex.itemName != null;
  if (!hasItemId) {
    throw new ImportParseError("لا بد من وجود عمود لتعريف الصنف: barcode أو itemCode أو itemName.");
  }
  if (colIndex.quantity == null || colIndex.unitPrice == null) {
    throw new ImportParseError("العمودان quantity و unitPrice مطلوبان لحساب الفاتورة.");
  }

  const get = (row: string[], key: keyof RawDraftFields): string => {
    const idx = colIndex[key];
    return idx != null ? (row[idx] ?? "").trim() : "";
  };

  const drafts: ImportRowDraft[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (row.every((c) => !c.trim())) continue; // skip blank lines
    drafts.push({
      rowNum: r + 1,
      invoiceRef: get(row, "invoiceRef"),
      invoiceType: get(row, "invoiceType"),
      customerName: get(row, "customerName"),
      customerVat: get(row, "customerVat"),
      itemCode: get(row, "itemCode"),
      barcode: get(row, "barcode"),
      itemName: get(row, "itemName"),
      quantity: get(row, "quantity"),
      unitPrice: get(row, "unitPrice"),
      vatRate: get(row, "vatRate"),
      paymentMethod: get(row, "paymentMethod"),
    });
  }
  if (drafts.length === 0) {
    throw new ImportParseError("لم يتم العثور على أي صف بيانات صالح.");
  }
  return drafts;
}

// ─── Validation ─────────────────────────────────────────────────────────
export interface ValidatedLine {
  draft: ImportRowDraft;
  matchedItemId: number | null;
  matchedItemName: string | null;
  qty: number;
  unitPrice: number;
  vatRate: number;
  lineSubtotal: number;
  lineVat: number;
  lineTotal: number;
  errors: string[];
}

export interface ValidatedInvoice {
  groupKey: string;
  invoiceRef: string;
  invoiceType: ZatcaInvoiceType;
  customerName: string;
  customerVat: string;
  matchedCustomerId: number | null;
  paymentMethod: "cash" | "card";
  lines: ValidatedLine[];
  subtotal: number;
  vat: number;
  grandTotal: number;
  errors: string[];
  valid: boolean;
}

export interface ValidateOptions {
  items: LocalItem[];
  customers: LocalCustomer[];
  defaultVatRate: number;
  taxMode: TaxMode;
  /** When true, customer VAT must match the KSA ZATCA format 3XXXXXXXXXXXX3. */
  requireSaVatFormat: boolean;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Returns the normalized type plus whether the raw value was understood.
 *  Blank ⇒ simplified (recognized default); a non-blank value that matches
 *  neither family is flagged so a typo can't silently downgrade a B2B
 *  (standard) invoice to a simplified one. */
function normalizeType(raw: string): { type: ZatcaInvoiceType; recognized: boolean } {
  const v = raw.trim().toLowerCase();
  if (!v) return { type: "simplified", recognized: true };
  if (/standard|ضريب|^tax|b2b/.test(v)) return { type: "standard", recognized: true };
  if (/simplif|مبسط|b2c/.test(v)) return { type: "simplified", recognized: true };
  return { type: "simplified", recognized: false };
}

function normalizePayment(raw: string): "cash" | "card" | null {
  const v = raw.trim().toLowerCase();
  if (!v) return "cash";
  if (/cash|نقد/.test(v)) return "cash";
  if (/card|بطاق|visa|mada|شبك/.test(v)) return "card";
  return null;
}

export function isValidCustomerVat(vat: string, requireSaFormat: boolean): boolean {
  const v = vat.trim();
  if (!v) return false;
  return requireSaFormat ? /^3\d{13}3$/.test(v) : /^\d{15}$/.test(v);
}

/** Group drafts by invoiceRef (blank ref ⇒ each row is its own invoice) and
 *  validate each resulting invoice + its lines. Pure: returns a fresh array. */
export function validateInvoices(
  drafts: ImportRowDraft[],
  opts: ValidateOptions,
): ValidatedInvoice[] {
  const byBarcode = new Map<string, LocalItem>();
  const byCode = new Map<string, LocalItem>();
  const byName = new Map<string, LocalItem>();
  for (const it of opts.items) {
    if (it.barcode) byBarcode.set(it.barcode.trim(), it);
    if (it.code) byCode.set(it.code.trim().toLowerCase(), it);
    if (it.nameAr) byName.set(it.nameAr.trim().toLowerCase(), it);
    if (it.nameEn) byName.set(it.nameEn.trim().toLowerCase(), it);
  }
  const custByVat = new Map<string, LocalCustomer>();
  const custByName = new Map<string, LocalCustomer>();
  for (const c of opts.customers) {
    if (c.vatNumber) custByVat.set(c.vatNumber.trim(), c);
    if (c.nameAr) custByName.set(c.nameAr.trim().toLowerCase(), c);
  }

  // Preserve first-seen order of groups.
  const order: string[] = [];
  const groups = new Map<string, ImportRowDraft[]>();
  for (const d of drafts) {
    const ref = d.invoiceRef.trim();
    const key = ref ? `ref:${ref.toLowerCase()}` : `row:${d.rowNum}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(d);
  }

  const out: ValidatedInvoice[] = [];
  for (const key of order) {
    const rows = groups.get(key)!;
    const head = rows[0];
    const invoiceErrors: string[] = [];

    const typeInfo = normalizeType(head.invoiceType);
    const invoiceType = typeInfo.type;
    if (!typeInfo.recognized) {
      invoiceErrors.push(`نوع الفاتورة «${head.invoiceType}» غير معروف — استخدم "standard" (ضريبية) أو "simplified" (مبسطة).`);
    }
    const customerName = head.customerName.trim();
    const customerVat = head.customerVat.trim();
    const payment = normalizePayment(head.paymentMethod);
    if (payment === null) {
      invoiceErrors.push(`طريقة الدفع «${head.paymentMethod}» غير معروفة — استخدم "cash" أو "card".`);
    }

    // Detect conflicting header data across rows of the same invoice so nothing
    // is silently dropped (first-row-wins would otherwise hide the mismatch).
    if (rows.slice(1).some((r) => r.customerName.trim() && r.customerName.trim() !== customerName)) {
      invoiceErrors.push("صفوف نفس الفاتورة تحمل أسماء عملاء مختلفة — وحّد اسم العميل أو افصل المراجع.");
    }
    if (rows.slice(1).some((r) => r.customerVat.trim() && r.customerVat.trim() !== customerVat)) {
      invoiceErrors.push("صفوف نفس الفاتورة تحمل أرقامًا ضريبية مختلفة — وحّد الرقم الضريبي.");
    }
    if (rows.slice(1).some((r) => r.invoiceType.trim() && normalizeType(r.invoiceType).type !== invoiceType)) {
      invoiceErrors.push("صفوف نفس الفاتورة تحمل أنواعًا مختلفة (ضريبية/مبسطة) — وحّد النوع أو افصل المراجع.");
    }
    if (rows.slice(1).some((r) => r.paymentMethod.trim() && normalizePayment(r.paymentMethod) !== payment)) {
      invoiceErrors.push("صفوف نفس الفاتورة تحمل طرق دفع مختلفة — وحّد طريقة الدفع.");
    }

    // Customer VAT format (validated whenever present, regardless of type).
    if (customerVat && !isValidCustomerVat(customerVat, opts.requireSaVatFormat)) {
      invoiceErrors.push(
        opts.requireSaVatFormat
          ? "الرقم الضريبي للعميل يجب أن يكون 15 رقمًا يبدأ وينتهي بالرقم 3."
          : "الرقم الضريبي للعميل يجب أن يكون 15 رقمًا.",
      );
    }

    // Standard (B2B) invoices require a named, VAT-registered buyer.
    if (invoiceType === "standard") {
      if (!customerName) invoiceErrors.push("الفاتورة الضريبية (Standard) تتطلب اسم العميل.");
      if (!customerVat) invoiceErrors.push("الفاتورة الضريبية (Standard) تتطلب الرقم الضريبي للعميل.");
    }

    const matchedCustomerId =
      (customerVat ? custByVat.get(customerVat)?.id : undefined) ??
      (customerName ? custByName.get(customerName.toLowerCase())?.id : undefined) ??
      null;

    const lines: ValidatedLine[] = rows.map((d) => {
      const errors: string[] = [];
      const barcode = d.barcode.trim();
      const code = d.itemCode.trim();
      const name = d.itemName.trim();
      const matched: LocalItem | null =
        (barcode ? byBarcode.get(barcode) ?? null : null) ??
        (code ? byCode.get(code.toLowerCase()) ?? null : null) ??
        (name ? byName.get(name.toLowerCase()) ?? null : null);
      if (!matched) {
        errors.push("لم يتم العثور على الصنف في الكتالوج — صحّح الباركود/الكود أو أضِف الصنف من شاشة الأصناف.");
      }

      const qty = Number(d.quantity);
      if (!d.quantity.trim() || !Number.isFinite(qty) || qty <= 0) {
        errors.push("الكمية يجب أن تكون رقمًا أكبر من صفر.");
      }
      const unitPrice = Number(d.unitPrice);
      if (!d.unitPrice.trim() || !Number.isFinite(unitPrice) || unitPrice < 0) {
        errors.push("سعر الوحدة يجب أن يكون رقمًا غير سالب.");
      }

      let vatRate = opts.defaultVatRate;
      if (d.vatRate.trim()) {
        const parsed = Number(d.vatRate);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
          errors.push("نسبة الضريبة يجب أن تكون رقمًا بين 0 و 100.");
        } else {
          vatRate = parsed;
        }
      }

      const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 0;
      const safePrice = Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0;
      const totals = computeTotals(safeQty * safePrice, vatRate, opts.taxMode);

      return {
        draft: d,
        matchedItemId: matched?.id ?? null,
        matchedItemName: matched?.nameAr ?? null,
        qty: safeQty,
        unitPrice: safePrice,
        vatRate,
        lineSubtotal: round2(totals.subtotal),
        lineVat: round2(totals.vat),
        lineTotal: round2(totals.grandTotal),
        errors,
      };
    });

    const subtotal = round2(lines.reduce((s, l) => s + l.lineSubtotal, 0));
    const vat = round2(lines.reduce((s, l) => s + l.lineVat, 0));
    const grandTotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    const valid = invoiceErrors.length === 0 && lines.every((l) => l.errors.length === 0) && lines.length > 0;

    out.push({
      groupKey: key,
      invoiceRef: head.invoiceRef.trim(),
      invoiceType,
      customerName,
      customerVat,
      matchedCustomerId,
      paymentMethod: payment ?? "cash",
      lines,
      subtotal,
      vat,
      grandTotal,
      errors: invoiceErrors,
      valid,
    });
  }
  return out;
}

/** Build the OfflineInvoicePayload for a VALID invoice. Callers must check
 *  `invoice.valid` first — this asserts every line has a matched item id. */
export function buildInvoicePayload(
  invoice: ValidatedInvoice,
  timestamp: string,
): OfflineInvoicePayload {
  return {
    paymentMethod: invoice.paymentMethod,
    timestamp,
    customerName: invoice.customerName || undefined,
    vatNumber: invoice.customerVat || undefined,
    subtotal: invoice.subtotal,
    vat: invoice.vat,
    grandTotal: invoice.grandTotal,
    lines: invoice.lines.map((l) => ({
      itemId: l.matchedItemId as number,
      nameAr: l.matchedItemName ?? l.draft.itemName,
      qty: l.qty,
      unitPrice: l.unitPrice,
      vatRate: l.vatRate,
    })),
  };
}
