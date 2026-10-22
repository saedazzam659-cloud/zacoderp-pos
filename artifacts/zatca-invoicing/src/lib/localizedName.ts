/**
 * Select a master-data name for the active UI language, falling back to the
 * other language when the preferred field is blank (including whitespace).
 */
export function localizedName(
  nameAr: string | null | undefined,
  nameEn: string | null | undefined,
  language: string | null | undefined,
): string {
  const english = language?.toLowerCase().startsWith("en") ?? false;
  const preferred = english ? nameEn : nameAr;
  const fallback = english ? nameAr : nameEn;
  return preferred?.trim() || fallback?.trim() || "";
}
