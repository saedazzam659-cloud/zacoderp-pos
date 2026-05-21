export interface InvoiceLineLike {
  itemId?: string | number | null;
  itemName?: string | null;
  unitId?: string | number | null;
  unit?: string | null;
  qty?: string | number | null;
  unitPrice?: string | number | null;
}

/**
 * Treat a row as "empty" (skip validation) when the user has NOT actively
 * touched it. All invoice forms initialize new rows with `qty: "1"` and
 * `unitPrice: "0"` — so we cannot use those defaults as a signal of intent.
 * The only reliable signals of user intent are:
 *   - picked an item (itemId set, OR typed itemName text), or
 *   - picked a unit (unitId set), or
 *   - changed qty to something other than 0/1/empty, or
 *   - entered a positive price.
 */
function isEmptyLine(l: InvoiceLineLike): boolean {
  const hasItem = !!(l.itemId || (l.itemName && String(l.itemName).trim()));
  const hasUnit = !!l.unitId;
  const qRaw    = l.qty;
  const pRaw    = l.unitPrice;
  const q       = Number(qRaw);
  const p       = Number(pRaw);
  // qty defaults to "1" — treat 0, 1, blank, NaN as "no intent on qty"
  const intentQty   = Number.isFinite(q) && q > 0 && q !== 1;
  // price defaults to "0" — treat 0, blank, NaN as "no intent on price"
  const intentPrice = Number.isFinite(p) && p > 0;
  return !hasItem && !hasUnit && !intentQty && !intentPrice;
}

export interface LineValidationResult {
  ok: boolean;
  title?: string;
  description?: string;
}

export function validateInvoiceLines(lines: InvoiceLineLike[]): LineValidationResult {
  const nonEmpty = lines.filter(l => !isEmptyLine(l));
  if (nonEmpty.length === 0) {
    return {
      ok: false,
      title: "⚠️ لا يمكن الحفظ — أضف صنفًا واحدًا على الأقل",
      description: "يجب إدخال سطر واحد على الأقل يحتوي على اسم الصنف ووحدة القياس والكمية وسعر البيع.",
    };
  }
  const errors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isEmptyLine(l)) continue;
    // Require IDs — not just display text — to mirror server expectations
    // and avoid round-trip 400s on typed-but-not-selected items/units.
    const missing: string[] = [];
    if (!l.itemId) missing.push("اسم الصنف");
    if (!l.unitId) missing.push("وحدة القياس");
    const q = Number(l.qty);
    if (!Number.isFinite(q) || q <= 0) missing.push("الكمية");
    const priceRaw = l.unitPrice;
    const p = Number(priceRaw);
    if (priceRaw === "" || priceRaw == null || !Number.isFinite(p) || p <= 0) missing.push("سعر البيع");
    if (missing.length) errors.push(`السطر ${i + 1}: ${missing.join("، ")}`);
  }
  if (errors.length) {
    return {
      ok: false,
      title: "⚠️ بيانات السطور ناقصة — لا يمكن حفظ الفاتورة",
      description: `الحقول الناقصة:\n${errors.join("\n")}`,
    };
  }
  return { ok: true };
}
