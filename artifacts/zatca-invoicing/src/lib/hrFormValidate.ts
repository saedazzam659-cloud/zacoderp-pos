// Client-side validation helpers for HR forms (Arabic-first messages).
// Mirrors the server-side rules in api-server/src/lib/hrValidate.ts so the
// user gets an instant, friendly message instead of a raw DB error.

const AR_DIGITS = /[٠-٩۰-۹]/g;
const AR_MAP: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

export function normDigits(v: any): string {
  return String(v ?? "").replace(AR_DIGITS, (d) => AR_MAP[d] ?? d).trim();
}

/**
 * Normalize a date-ish string to ISO YYYY-MM-DD.
 * Accepts: YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY, DD-MM-YYYY (with Arabic digits too).
 * Returns null for empty values. Returns undefined when the value is present
 * but cannot be parsed into a REAL calendar date (caller should reject).
 */
export function toIsoDate(v: any): string | null | undefined {
  const s = normDigits(v);
  if (!s) return null;
  let y = 0, m = 0, d = 0;
  let match = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) { y = +match[1]; m = +match[2]; d = +match[3]; }
  else {
    match = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (match) { d = +match[1]; m = +match[2]; y = +match[3]; }
    else return undefined;
  }
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Money: >= 0 finite number. Returns undefined when invalid. */
export function toMoney(v: any): number | undefined {
  if (v == null || v === "") return 0;
  const n = Number(normDigits(v));
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

export function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

export type HrFieldError = { field: string; tab?: string; message: string };

/**
 * Generic form checker. Rules run in order; the first failure is returned so
 * the caller can toast it and jump to its tab.
 */
export class HrFormCheck {
  errors: HrFieldError[] = [];
  clean: Record<string, any> = {};

  date(form: any, field: string, label: string, tab?: string) {
    const iso = toIsoDate(form[field]);
    if (iso === undefined) {
      this.errors.push({ field, tab, message: `صيغة التاريخ غير صحيحة في «${label}» — استخدم يوم/شهر/سنة ميلادي` });
    } else {
      this.clean[field] = iso;
    }
    return this;
  }

  requiredDate(form: any, field: string, label: string, tab?: string) {
    const iso = toIsoDate(form[field]);
    if (!iso) {
      this.errors.push({ field, tab, message: iso === undefined
        ? `صيغة التاريخ غير صحيحة في «${label}» — استخدم يوم/شهر/سنة ميلادي`
        : `«${label}» مطلوب` });
    } else {
      this.clean[field] = iso;
    }
    return this;
  }

  money(form: any, field: string, label: string, tab?: string) {
    const n = toMoney(form[field]);
    if (n === undefined) {
      this.errors.push({ field, tab, message: `قيمة «${label}» يجب أن تكون رقمًا موجبًا أو صفر` });
    } else {
      this.clean[field] = n;
    }
    return this;
  }

  positiveMoney(form: any, field: string, label: string, tab?: string) {
    const n = toMoney(form[field]);
    if (n === undefined || !(n > 0)) {
      this.errors.push({ field, tab, message: `«${label}» مطلوب ويجب أن يكون أكبر من صفر` });
    } else {
      this.clean[field] = n;
    }
    return this;
  }

  intRange(form: any, field: string, label: string, min: number, max: number, tab?: string) {
    const raw = form[field];
    if (raw == null || raw === "") return this;
    const n = Number(normDigits(raw));
    if (!Number.isInteger(n) || n < min || n > max) {
      this.errors.push({ field, tab, message: `«${label}» يجب أن يكون رقمًا صحيحًا بين ${min} و ${max}` });
    } else {
      this.clean[field] = n;
    }
    return this;
  }

  email(form: any, field: string, label: string, tab?: string) {
    const v = String(form[field] ?? "").trim();
    if (v && !isValidEmail(v)) {
      this.errors.push({ field, tab, message: `«${label}» غير صحيح — تأكد من صيغة البريد الإلكتروني` });
    } else {
      this.clean[field] = v || null;
    }
    return this;
  }

  digits(form: any, field: string, label: string, minLen: number, maxLen: number, tab?: string) {
    const v = normDigits(form[field]).replace(/[\s-]/g, "");
    if (v && !(new RegExp(`^\\+?\\d{${minLen},${maxLen}}$`).test(v))) {
      this.errors.push({ field, tab, message: `«${label}» يجب أن يحتوي على أرقام فقط (${minLen}–${maxLen} رقم)` });
    } else {
      this.clean[field] = v || null;
    }
    return this;
  }

  /** end >= start when both present (reads from clean if already normalized). */
  order(startField: string, endField: string, message: string, tab?: string) {
    const s = this.clean[startField];
    const e = this.clean[endField];
    if (s && e && String(e) < String(s)) this.errors.push({ field: endField, tab, message });
    return this;
  }

  custom(cond: boolean, field: string, message: string, tab?: string) {
    if (cond) this.errors.push({ field, tab, message });
    return this;
  }

  get first(): HrFieldError | null {
    return this.errors[0] ?? null;
  }
}
