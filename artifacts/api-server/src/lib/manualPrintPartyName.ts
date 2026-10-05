const MAX_MANUAL_PRINT_PARTY_NAME_LENGTH = 200;

/**
 * A manual party name is a print-only fallback, never a replacement for a
 * linked customer/supplier and never accepted for credit documents.
 */
export function normalizeManualPrintPartyName(
  value: unknown,
  paymentType: unknown,
  hasLinkedParty: boolean,
): string | null {
  if (hasLinkedParty || (paymentType !== "cash" && paymentType !== "bank")) return null;
  if (typeof value !== "string") return null;
  const name = value.trim().slice(0, MAX_MANUAL_PRINT_PARTY_NAME_LENGTH);
  return name || null;
}
