const DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/** Normalize text for case-insensitive Arabic/English and Arabic-digit search. */
export function normalizeSearch(value: unknown): string {
  return String(value ?? '')
    .replace(/[٠-٩۰-۹]/g, (digit) => DIGITS[digit] ?? digit)
    .trim()
    .toLocaleLowerCase();
}