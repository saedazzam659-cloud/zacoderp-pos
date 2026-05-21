// Bidirectional sync helper between the two per-line discount inputs that
// appear on sales documents:
//
//   • `discount`        — percentage (0–100)
//   • `discountAmount`  — absolute value in the document currency
//
// Before this helper the two fields were *independent* and the line total
// formula was `qty*price*(1 - disc/100) - discAmt` — so a user typing 10%
// + 20 SAR got DOUBLE the discount. The product spec (May 2026) is that
// the two inputs are two views of the SAME discount: typing into one
// auto-fills the other.
//
// The helper is intentionally pure (no React import) so it can be reused
// by every form's `updateLine` without coupling to the page module.
export interface LineLike {
  qty: string | number;
  unitPrice: string | number;
  discount: string;
  discountAmount: string;
}

function trimZeros(s: string) {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "") || "0";
}

/**
 * Returns the updated { discount, discountAmount } pair after the user
 * edits one of the two fields. When the line's gross (qty × price) is 0
 * we cannot derive the mirror value, so only the edited field is updated.
 *
 *   syncLineDiscount({qty:1,unitPrice:200,...}, "discount",       "10") → { discount:"10",  discountAmount:"20.00" }
 *   syncLineDiscount({qty:1,unitPrice:200,...}, "discountAmount", "20") → { discount:"10",  discountAmount:"20"    }
 */
export function syncLineDiscount(
  line: LineLike,
  field: "discount" | "discountAmount",
  rawValue: string,
): { discount: string; discountAmount: string } {
  const qty   = Number(line.qty)       || 0;
  const price = Number(line.unitPrice) || 0;
  const gross = qty * price;

  if (field === "discount") {
    const pct = Math.max(0, Math.min(100, Number(rawValue) || 0));
    if (gross > 0 && rawValue !== "" && rawValue !== ".") {
      const amt = (gross * pct) / 100;
      return { discount: rawValue, discountAmount: amt.toFixed(2) };
    }
    // Empty / non-numeric input — mirror a zero so the two stay coherent.
    if (rawValue === "" || pct === 0) {
      return { discount: rawValue, discountAmount: "0" };
    }
    return { discount: rawValue, discountAmount: line.discountAmount };
  }

  // field === "discountAmount"
  const amt = Math.max(0, Number(rawValue) || 0);
  if (gross > 0 && rawValue !== "" && rawValue !== ".") {
    // Clamp so the derived % is never >100 (over-discount).
    const cappedAmt = Math.min(amt, gross);
    const pct = (cappedAmt / gross) * 100;
    // Round to 4 dp then strip trailing zeros so "10.0000" → "10".
    const pctStr = trimZeros((Math.round(pct * 10000) / 10000).toFixed(4));
    return { discount: pctStr, discountAmount: rawValue };
  }
  if (rawValue === "" || amt === 0) {
    return { discount: "0", discountAmount: rawValue };
  }
  return { discount: line.discount, discountAmount: rawValue };
}

/**
 * Effective monetary discount for a line. Used by `calcLine` to avoid
 * double-counting when both fields are populated (the sync helper keeps
 * them consistent, so we treat them as one value). Falls back to deriving
 * from the percentage when only the % is set (legacy data path).
 */
export function effectiveLineDiscount(line: LineLike): number {
  const qty   = Number(line.qty)       || 0;
  const price = Number(line.unitPrice) || 0;
  const gross = qty * price;
  const amt = Math.max(0, Number(line.discountAmount) || 0);
  if (amt > 0) return Math.min(amt, gross);
  const pct = Math.max(0, Math.min(100, Number(line.discount) || 0));
  return (gross * pct) / 100;
}
