// Shared HR input validation + friendly DB-error mapping.
// Goal: no raw "Failed query: insert into ..." ever reaches the end user —
// every user mistake becomes a clear Arabic 400, and unexpected DB errors
// become a generic Arabic 500 (the real cause is logged server-side).

export class HrValidationError extends Error {
  code = "VALIDATION" as const;
  constructor(message: string) { super(message); }
}

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Normalize Arabic-Indic / Persian digits to Latin and trim. */
export function normDigits(v: any): string {
  let s = String(v ?? "").trim();
  for (let i = 0; i < 10; i++) {
    s = s.split(AR_DIGITS[i]).join(String(i)).split(FA_DIGITS[i]).join(String(i));
  }
  return s;
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Coerce a user-supplied date to ISO (YYYY-MM-DD) or null when empty.
 * Accepts: YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY, DD/MM/YYYY (and Arabic digits).
 * Throws a 400-mapped HrValidationError on anything unparseable — this is the
 * class of input that used to surface as a raw Postgres "Failed query" error.
 */
export function dateOrNull(v: any, label: string): string | null {
  if (v == null || v === "") return null;
  const s = normDigits(v).replace(/\s+/g, "");
  let y = 0, m = 0, d = 0;
  let match = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) { y = +match[1]; m = +match[2]; d = +match[3]; }
  else {
    match = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (match) { d = +match[1]; m = +match[2]; y = +match[3]; }
  }
  if (!match || !isRealDate(y, m, d) || y < 1900 || y > 2200) {
    throw new HrValidationError(`${label}: تاريخ غير صالح (${String(v)}). الصيغة المطلوبة: يوم/شهر/سنة`);
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function requireDate(v: any, label: string): string {
  const iso = dateOrNull(v, label);
  if (!iso) throw new HrValidationError(`${label} مطلوب`);
  return iso;
}

/** end >= start (both ISO or null → no check). */
export function assertDateOrder(startIso: string | null, endIso: string | null, msg: string): void {
  if (startIso && endIso && endIso < startIso) throw new HrValidationError(msg);
}

/**
 * Coerce a money/decimal field to a numeric string. Empty → "0".
 * Accepts Arabic digits and thousands separators; rejects negatives/garbage.
 */
export function moneyOrZero(v: any, label: string): string {
  if (v == null || v === "") return "0";
  const s = normDigits(v).replace(/[,\s٬]/g, "").replace("٫", ".");
  const n = Number(s);
  if (!Number.isFinite(n)) throw new HrValidationError(`${label}: قيمة رقمية غير صالحة (${String(v)})`);
  if (n < 0) throw new HrValidationError(`${label}: لا يمكن أن تكون قيمة سالبة`);
  if (n > 999999999) throw new HrValidationError(`${label}: القيمة أكبر من الحد المسموح`);
  return String(n);
}

export function intOrDefault(v: any, def: number, label: string, min = 0, max = 100000): number {
  if (v == null || v === "") return def;
  const n = Number(normDigits(v));
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new HrValidationError(`${label}: يجب أن يكون رقماً صحيحاً`);
  if (n < min || n > max) throw new HrValidationError(`${label}: يجب أن يكون بين ${min} و ${max}`);
  return n;
}

/** Positive amount (> 0) as numeric string. */
export function requirePositiveMoney(v: any, label: string): string {
  const s = moneyOrZero(v, label);
  if (!(Number(s) > 0)) throw new HrValidationError(`${label}: يجب أن يكون أكبر من صفر`);
  return s;
}

export function emailOrNull(v: any): string | null {
  if (v == null || String(v).trim() === "") return null;
  const s = String(v).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) {
    throw new HrValidationError(`البريد الإلكتروني غير صالح (${s})`);
  }
  return s;
}

export function mobileOrNull(v: any): string | null {
  if (v == null || String(v).trim() === "") return null;
  const s = normDigits(v).replace(/[\s()-]/g, "");
  if (!/^\+?\d{8,15}$/.test(s)) {
    throw new HrValidationError(`رقم الجوال غير صالح (${String(v)}) — أرقام فقط (8-15 رقماً)`);
  }
  return s;
}

/** Optional identity-style number: digits only after normalization. */
export function idNumberOrNull(v: any, label: string): string | null {
  if (v == null || String(v).trim() === "") return null;
  const s = normDigits(v);
  if (!/^\d{5,20}$/.test(s)) {
    throw new HrValidationError(`${label}: أرقام فقط (5-20 رقماً) بدون رموز أو مسافات`);
  }
  return s;
}

/** Optional HH:MM (24h) time. */
export function timeOrNull(v: any, label: string): string | null {
  if (v == null || String(v).trim() === "") return null;
  const s = normDigits(v);
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) {
    throw new HrValidationError(`${label}: صيغة الوقت غير صالحة — المطلوب ساعة:دقيقة (مثل 08:30)`);
  }
  return `${String(+m[1]).padStart(2, "0")}:${m[2]}`;
}

/** Restrict a free-text enum-ish field to a known set (or default). */
export function oneOf(v: any, allowed: string[], def: string, label: string): string {
  if (v == null || v === "") return def;
  const s = String(v);
  if (!allowed.includes(s)) throw new HrValidationError(`${label}: قيمة غير معروفة (${s})`);
  return s;
}

/**
 * Uniform error responder for HR mutating routes.
 * - HrValidationError / tagged code VALIDATION → 400 with its Arabic message.
 * - Errors carrying an explicit `status` keep it.
 * - Known Postgres SQLSTATEs → friendly Arabic 400s.
 * - Everything else → generic Arabic 500 (real message logged, never sent).
 */
export function respondHrError(req: any, res: any, e: any): void {
  if (e instanceof HrValidationError || e?.code === "VALIDATION") {
    res.status(400).json({ error: e.message }); return;
  }
  if (typeof e?.status === "number" && e.status >= 400 && e.status < 600) {
    res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.fields ? { fields: e.fields } : {}) });
    return;
  }
  const pgCode = e?.code ?? e?.cause?.code;
  const msg = String(e?.message ?? "");
  const map: Record<string, string> = {
    "22007": "أحد التواريخ المدخلة غير صالح — تأكد من صيغة التاريخ (يوم/شهر/سنة)",
    "22008": "أحد التواريخ المدخلة خارج النطاق المسموح",
    "22P02": "أحد الحقول الرقمية يحتوي قيمة غير رقمية — تأكد من الأرقام المدخلة",
    "22003": "قيمة رقمية أكبر من الحد المسموح",
    "22001": "أحد الحقول النصية أطول من الحد المسموح",
    "23502": "حقل إلزامي ناقص — أكمل البيانات المطلوبة",
    "23503": "قيمة مرتبطة غير موجودة (موظف/حساب/فرع) — حدّث الصفحة وحاول مجدداً",
    "23505": "البيانات مكررة — يوجد سجل آخر بنفس الرقم أو الكود",
  };
  if (pgCode && map[pgCode]) { res.status(400).json({ error: map[pgCode] }); return; }
  // Drizzle wraps PG errors as "Failed query: ..." — never leak that to users.
  try { req?.log?.error?.({ err: msg.slice(0, 2000) }, "hr: unexpected mutation error"); } catch { /* noop */ }
  res.status(500).json({ error: "حدث خطأ غير متوقع أثناء الحفظ. لم يتم حفظ البيانات — راجع المدخلات وحاول مرة أخرى." });
}
