/**
 * Hijri (Umm al-Qura) ⇄ Gregorian conversion helpers.
 *
 * Gregorian → Hijri uses the browser-native Intl "islamic-umalqura" calendar
 * (the official Saudi civil calendar). Hijri → Gregorian has no native API, so
 * we estimate the Gregorian date from the mean Hijri year/month lengths and
 * then scan ±5 days until the round-trip through Intl matches exactly — this
 * keeps both directions on the SAME Umm al-Qura tables (no drift).
 */

export type HijriParts = { y: number; m: number; d: number };

const HIJRI_FMT = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", {
  day: "numeric",
  month: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const DAY_MS = 86_400_000;

function isoToUtcMs(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : null;
}

function hijriPartsAt(utcMs: number): HijriParts | null {
  try {
    const parts = HIJRI_FMT.formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const y = get("year"), m = get("month"), d = get("day");
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    return { y, m, d };
  } catch {
    return null;
  }
}

/** ISO `YYYY-MM-DD` (Gregorian) → Umm al-Qura Hijri parts, or null. */
export function gregorianIsoToHijri(iso: string): HijriParts | null {
  const ms = isoToUtcMs(iso);
  return ms === null ? null : hijriPartsAt(ms);
}

/** Loose sanity range for Hijri birth-type dates. */
export function isPlausibleHijri(h: HijriParts): boolean {
  return h.y >= 1200 && h.y <= 1600 && h.m >= 1 && h.m <= 12 && h.d >= 1 && h.d <= 30;
}

/**
 * Umm al-Qura Hijri date → Gregorian ISO `YYYY-MM-DD`, or null when the day
 * doesn't exist (e.g. 30th of a 29-day month) or is out of the Intl tables.
 */
export function hijriToGregorianIso(h: HijriParts): string | null {
  if (!isPlausibleHijri(h)) return null;
  // Mean-length estimate anchored on 1 Muharram 1 AH ≈ 622-07-19 (Gregorian).
  const estDays = (h.y - 1) * 354.36667 + (h.m - 1) * 29.530589 + (h.d - 1);
  const est = Date.UTC(622, 6, 19) + Math.round(estDays) * DAY_MS;
  for (let off = -5; off <= 5; off++) {
    const ms = est + off * DAY_MS;
    const rt = hijriPartsAt(ms);
    if (rt && rt.y === h.y && rt.m === h.m && rt.d === h.d) {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }
  return null;
}

/** Hijri parts → display text `DD/MM/YYYY` (latin digits). */
export function formatHijriParts(h: HijriParts): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(h.d)}/${p2(h.m)}/${h.y}`;
}

/** Arabic month names (Umm al-Qura order) for tooltips/labels. */
export const HIJRI_MONTHS_AR = [
  "محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة",
  "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة",
] as const;

/**
 * Parse a user-typed Hijri string `DD/MM/YYYY` (also accepts `D/M/YYYY`,
 * Arabic-Indic digits, and `-` or `.` separators). Returns null when the text
 * is not a COMPLETE date — callers should treat null as "still typing".
 */
export function parseHijriText(text: string): HijriParts | null {
  const latin = text.replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)));
  const m = /^\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\s*$/.exec(latin);
  if (!m) return null;
  const h = { d: Number(m[1]), m: Number(m[2]), y: Number(m[3]) };
  return isPlausibleHijri(h) ? h : null;
}
