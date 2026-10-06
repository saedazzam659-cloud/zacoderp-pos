export type NormalizedMarketingPhone = {
  phone: string;
  normalizedPhone: string;
};

/**
 * Canonicalize punctuation and international dialing prefixes for duplicate
 * checks and wa.me links. The stored phone retains the user's formatting.
 */
export function normalizeCrmWhatsAppPhone(value: unknown): NormalizedMarketingPhone | null {
  const source = String(value ?? "").trim();
  if (!source) return null;

  const asciiDigits = source
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
  const compact = asciiDigits.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;

  let digits = compact.replace(/^\+/, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 7 || digits.length > 15) return null;

  return { phone: source, normalizedPhone: digits };
}
