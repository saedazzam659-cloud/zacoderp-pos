// Bank Reconciliation
// ───────────────────────────────────────────────────────────────────────────
// Stateless utility endpoints used by the "مطابقة كشف البنك" screen.
//   • POST /parse        — accept an uploaded statement file (Excel/CSV/PDF/Word)
//                          as base64 and return the detected transactions.
//   • GET  /book-ledger  — return the GL-derived bank ledger (posted journal
//                          entries against the bank account's GL account)
//                          formatted to match the parsed-statement shape so
//                          the frontend can run a unified diff.
// No data is persisted; results are returned to the caller and forgotten.

import { Router } from "express";
import { db } from "@workspace/db";
import {
  accountsTable,
  bankAccountsTable,
  journalEntriesTable,
  journalEntryLinesTable,
} from "@workspace/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { extractAuth, resolveCompanyId, getAllowedBranchIds, branchScopeSpread } from "../middleware/auth.js";
import { requireModulePermission } from "../middleware/permissions.js";
import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";
import { logAiUsage, requireAiFeature } from "../middleware/requireAiFeature.js";
import { AsyncLocalStorage } from "node:async_hooks";



const router: Router = Router();

// ─────────────────────────────────────────────────────────────────────────
// Gemini-first transparent redirect (see notes in routes/ai.ts).
// Re-binds OPENAI_BASE/KEY (declared elsewhere in this file) to a sentinel
// "AI_PROXY" string and shadows the global fetch with a local one that
// intercepts the sentinel URL, dispatches via aiChat, and returns a
// Response-shaped object so existing r.ok/r.json()/r.text() callsites
// continue to work unchanged. AsyncLocalStorage threads `req` through
// so the feature-gate's logAiUsage counter still advances.
// ─────────────────────────────────────────────────────────────────────────
const __aiReqStore = new AsyncLocalStorage<any>();
router.use((req, _res, next) => { __aiReqStore.run(req, () => next()); });

const __nativeFetch = globalThis.fetch;
async function fetch(input: any, init?: any): Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }> {
  if (typeof input === "string" && input.startsWith("AI_PROXY")) {
    const body = (() => { try { return JSON.parse(init?.body ?? "{}"); } catch { return {}; } })();
    const result = await aiChat(body.messages ?? [], {
      json:      body.response_format?.type === "json_object",
      maxTokens: body.max_completion_tokens ?? body.max_tokens ?? 2048,
      providers: ["gemini"],
  });
    const req = __aiReqStore.getStore();
    if (req) {
      try {
        await logAiUsage(req, result.ok
          ? { status: "allowed", provider: result.provider }
          : { status: "error",   meta: { reason: result.reason } });
      } catch { /* logging must never break the call */ }
    }
    if (!result.ok) {
      return { ok: false, status: 502, json: async () => ({ error: result.reason }), text: async () => result.reason };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: result.text } }] }),
      text: async () => result.text,
    };
  }
  return (__nativeFetch as any)(input, init);
}


router.use(extractAuth);
router.use((req: any, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});
router.use(requireModulePermission("bank_accounts"));

// ── Shared transaction shape ─────────────────────────────────────────────
export type ParsedTx = {
  /** ISO yyyy-mm-dd; empty when the row had no parseable date. */
  date: string;
  description: string;
  /** Money INTO the bank (deposits / credits to the bank from the bank's POV). */
  debit: number;
  /** Money OUT of the bank (withdrawals / debits to the bank from the bank's POV). */
  credit: number;
  /** Optional running balance reported by the bank. */
  balance?: number | null;
  /** Optional reference number (cheque #, transaction id, …). */
  ref?: string | null;
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** Excel serial date → yyyy-mm-dd. Excel epoch is 1899-12-30. */
function excelSerialToISO(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0 || n > 60000) return null;
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Convert any Arabic-Indic digits in the string to Western digits.
 *  Bank statements (especially OCR'd ones) frequently mix ١٢٣ and 123. */
function normalizeDigits(s: string): string {
  return s
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, d => String(d.charCodeAt(0) - 0x06f0));
}

/** Map English/Arabic month names to 1-12. */
const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
  // Arabic Gregorian month names (most common variants).
  "يناير": 1, "كانون الثاني": 1, "فبراير": 2, "شباط": 2,
  "مارس": 3, "آذار": 3, "اذار": 3,
  "ابريل": 4, "أبريل": 4, "نيسان": 4,
  "مايو": 5, "أيار": 5, "ايار": 5,
  "يونيو": 6, "حزيران": 6, "يونية": 6,
  "يوليو": 7, "تموز": 7, "يولية": 7,
  "اغسطس": 8, "أغسطس": 8, "آب": 8, "اب": 8,
  "سبتمبر": 9, "ايلول": 9, "أيلول": 9,
  "اكتوبر": 10, "أكتوبر": 10, "تشرين الاول": 10, "تشرين الأول": 10,
  "نوفمبر": 11, "تشرين الثاني": 11,
  "ديسمبر": 12, "كانون الاول": 12, "كانون الأول": 12,
};

/** Loose date parser supporting many common bank formats. Returns yyyy-mm-dd or "".
 *  CRITICAL: This function NEVER uses `new Date(str)` for parsing because Node's
 *  built-in parser is timezone-sensitive — e.g. `new Date("2025-05-22").toISOString()`
 *  in a TZ-offset container can return "2025-05-21" or "2025-05-23", which is the
 *  classic off-by-one bug in bank reconciliation. All branches below construct the
 *  ISO string from the source digits directly, with no Date math at all. */
function parseDate(raw: any): string {
  if (raw == null) return "";
  if (typeof raw === "number") return excelSerialToISO(raw) ?? "";
  let s = String(raw).trim();
  if (!s) return "";
  // Arabic-Indic → Western digits first so all subsequent regexes work.
  s = normalizeDigits(s);
  // Strip RTL/LTR marks and any leading Hijri-prefix junk like "هـ" that
  // some statements interleave with the Gregorian date.
  s = s.replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim();

  // ── 1. ISO: yyyy-mm-dd (or yyyy/mm/dd, yyyy.mm.dd) ───────────────────
  const iso = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (iso) {
    const y = iso[1];
    const m = iso[2].padStart(2, "0");
    const d = iso[3].padStart(2, "0");
    if (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      return `${y}-${m}-${d}`;
    }
  }

  // ── 2. dd/mm/yyyy or mm/dd/yyyy or dd-mm-yyyy or dd.mm.yyyy ──────────
  // Disambiguation: if either of the first two parts is > 12 we know which
  // is the day; otherwise default to **dd/mm** (Saudi/EU convention used by
  // all local bank statements). US-formatted statements (mm/dd) are very rare
  // here and tagged-amount columns make this safe.
  const m1 = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m1) {
    const a = m1[1], b = m1[2], c = m1[3];
    let d: string, mo: string;
    const A = Number(a), B = Number(b);
    if (A > 12 && B <= 12) { d = a; mo = b; }       // unambiguous dd/mm
    else if (B > 12 && A <= 12) { d = b; mo = a; }  // unambiguous mm/dd
    else { d = a; mo = b; }                          // default dd/mm (SA)
    const dd = d.padStart(2, "0");
    const mm = mo.padStart(2, "0");
    // 2-digit year → assume 20xx (no bank gives 19xx statements in practice)
    const yy = c.length === 4 ? c : `20${c.padStart(2, "0")}`;
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) {
      return `${yy}-${mm}-${dd}`;
    }
  }

  // ── 3. "22 May 2025" / "22-May-2025" / "22 مايو 2025" ────────────────
  const m2 = s.match(/^(\d{1,2})[\s\-\/]+([A-Za-z\u0600-\u06ff]+)[\s\-\/]+(\d{2,4})/);
  if (m2) {
    const d = m2[1].padStart(2, "0");
    const monthKey = m2[2].toLowerCase().normalize("NFC");
    const mNum = MONTH_NAMES[monthKey] ?? MONTH_NAMES[monthKey.slice(0, 3)];
    if (mNum) {
      const mm = String(mNum).padStart(2, "0");
      const yy = m2[3].length === 4 ? m2[3] : `20${m2[3].padStart(2, "0")}`;
      if (Number(d) >= 1 && Number(d) <= 31) return `${yy}-${mm}-${d}`;
    }
  }

  // ── 4. "May 22, 2025" (US long-form) ─────────────────────────────────
  const m3 = s.match(/^([A-Za-z\u0600-\u06ff]+)[\s\-\/]+(\d{1,2})[,\s\-\/]+(\d{2,4})/);
  if (m3) {
    const monthKey = m3[1].toLowerCase().normalize("NFC");
    const mNum = MONTH_NAMES[monthKey] ?? MONTH_NAMES[monthKey.slice(0, 3)];
    if (mNum) {
      const mm = String(mNum).padStart(2, "0");
      const d = m3[2].padStart(2, "0");
      const yy = m3[3].length === 4 ? m3[3] : `20${m3[3].padStart(2, "0")}`;
      if (Number(d) >= 1 && Number(d) <= 31) return `${yy}-${mm}-${d}`;
    }
  }

  // Deliberately NO `new Date(s)` fallback — see header comment. Returning ""
  // is safer: the row is skipped with a warning rather than silently shifted.
  return "";
}

/** Parse an arbitrary string/number into a finite number, or null. Handles
 *  thousands separators ("1,234.56"), Arabic-Indic digits and decimal mark
 *  (٬ thousands U+066C, ٫ decimal U+066B), European format ("1.234,56"),
 *  parentheses for negatives ("(123.45)") and trailing CR/DR markers. */
function parseAmount(raw: any): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;
  // Arabic-Indic → Western digits (both Eastern Arabic ٠-٩ and Persian ۰-۹)
  s = normalizeDigits(s);
  // Arabic decimal/thousands separators → Western equivalents.
  s = s.replace(/\u066B/g, ".").replace(/\u066C/g, ",");
  // Strip currency symbols, spaces, NBSP, RTL marks
  s = s.replace(/[\u200e\u200f\u202a-\u202e\s]+/g, "");
  s = s.replace(/(?:SAR|SR|ر\.?س\.?|﷼|USD|\$|EUR|€)/gi, "");
  let sign = 1;
  if (/^\(.+\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/(?:^|[^A-Z])(DR|DEBIT)\b/i.test(s)) sign = -1;
  if (/(?:^|[^A-Z])(CR|CREDIT)\b/i.test(s)) sign = 1;
  s = s.replace(/[A-Za-z]+/g, "");

  // Decimal-separator disambiguation. Three cases:
  //   "1,234.56"   → comma=thousands, dot=decimal  (Anglo / Saudi default)
  //   "1.234,56"   → dot=thousands, comma=decimal  (European)
  //   "1234,56"    → comma=decimal (no dot in string)
  //   "1234.56"    → dot=decimal
  //   "1,234"      → comma=thousands (no fractional part, integer)
  //   "1,23"       → comma=decimal (1.23 — common European typing)
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  if (hasDot && hasComma) {
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    if (lastComma > lastDot) {
      // European: 1.234,56 → 1234.56
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // Anglo: 1,234.56 → 1234.56
      s = s.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    // Single comma. If exactly one comma followed by 1-2 digits at the end,
    // treat it as a decimal mark (European "1234,56" or "12,5"). Otherwise
    // it's a thousands separator (e.g. "1,234" → 1234).
    const m = s.match(/^(-?\d+),(\d{1,2})$/);
    if (m) s = `${m[1]}.${m[2]}`;
    else s = s.replace(/,/g, "");
  }

  if (!s || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

/** Detect column index by matching the header against a list of synonyms. */
function findCol(headers: string[], synonyms: RegExp[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] ?? "").trim().toLowerCase();
    if (!h) continue;
    if (synonyms.some(re => re.test(h))) return i;
  }
  return -1;
}

const HDR_DATE = [/^date$/, /^trans(?:action)?\s*date$/, /^posting\s*date$/, /^value\s*date$/, /تاريخ/];
const HDR_DESC = [/^desc/, /^narration/, /^details?$/, /^particulars?$/, /^remarks?$/, /^memo$/, /بيان/, /تفاصيل/, /وصف/, /ملاحظات?/];
const HDR_DEBIT = [/^debit$/, /^withdraw/, /^paid\s*out$/, /^مدين$/, /سحب/, /منصرف/, /صادر/];
const HDR_CREDIT = [/^credit$/, /^deposit/, /^paid\s*in$/, /^دائن$/, /إيداع/, /وارد/];
const HDR_AMOUNT = [/^amount$/, /^value$/, /^مبلغ$/, /^القيمة$/];
const HDR_BALANCE = [/^balance$/, /^running\s*balance$/, /^closing\s*balance$/, /رصيد/];
const HDR_REF = [/^ref/, /^reference/, /^cheque/, /^check/, /^txn/, /^transaction\s*id$/, /مرجع/, /شيك/, /رقم\s*العملية/];

/**
 * Convert a 2-D matrix (header row + data rows) into ParsedTx[].
 * The header row is auto-detected: scan the first 20 rows for the one
 * that matches the most known synonyms.
 */
function rowsToTx(matrix: any[][]): { txns: ParsedTx[]; warnings: string[] } {
  const warnings: string[] = [];
  if (matrix.length === 0) return { txns: [], warnings: ["الملف فارغ"] };

  // Find best header row in the first 20 rows
  let bestRow = -1, bestScore = 0;
  for (let i = 0; i < Math.min(20, matrix.length); i++) {
    const row = matrix[i].map(c => String(c ?? "").trim().toLowerCase());
    let score = 0;
    if (findCol(row, HDR_DATE) >= 0) score++;
    if (findCol(row, HDR_DESC) >= 0) score++;
    if (findCol(row, HDR_DEBIT) >= 0 || findCol(row, HDR_CREDIT) >= 0 || findCol(row, HDR_AMOUNT) >= 0) score++;
    if (findCol(row, HDR_BALANCE) >= 0) score++;
    if (score > bestScore) { bestScore = score; bestRow = i; }
  }
  if (bestRow < 0 || bestScore < 2) {
    warnings.push("تعذّر التعرف على رؤوس الأعمدة. تأكد أن الكشف يحتوي على عمود تاريخ + بيان + مبلغ.");
    return { txns: [], warnings };
  }

  const headers = matrix[bestRow].map(c => String(c ?? "").trim().toLowerCase());
  const cDate = findCol(headers, HDR_DATE);
  const cDesc = findCol(headers, HDR_DESC);
  const cDebit = findCol(headers, HDR_DEBIT);
  const cCredit = findCol(headers, HDR_CREDIT);
  const cAmount = findCol(headers, HDR_AMOUNT);
  const cBalance = findCol(headers, HDR_BALANCE);
  const cRef = findCol(headers, HDR_REF);

  if (cDate < 0) { warnings.push("لم يُعثر على عمود تاريخ"); return { txns: [], warnings }; }
  const hasSplit = cDebit >= 0 || cCredit >= 0;
  if (!hasSplit && cAmount < 0) {
    warnings.push("لم يُعثر على أعمدة المبالغ (مدين/دائن أو مبلغ)");
    return { txns: [], warnings };
  }

  const txns: ParsedTx[] = [];
  for (let i = bestRow + 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row || row.every(c => c == null || String(c).trim() === "")) continue;
    const date = parseDate(row[cDate]);
    if (!date) continue;
    const desc = cDesc >= 0 ? String(row[cDesc] ?? "").trim() : "";
    let debit = 0, credit = 0;
    if (hasSplit) {
      const d = cDebit >= 0 ? parseAmount(row[cDebit]) : null;
      const c = cCredit >= 0 ? parseAmount(row[cCredit]) : null;
      // Bank statement convention: "Debit" column = money out of the
      // customer's bank account (withdrawal). From the bank-account
      // GL viewpoint that's a CREDIT (decreases the asset). We mirror
      // it so the final ParsedTx debits/credits match book convention:
      //   debit  = money INTO the bank (deposit)  → bank-statement "Credit"
      //   credit = money OUT  of the bank (withdraw) → bank-statement "Debit"
      if (d != null) credit = Math.abs(d);
      if (c != null) debit = Math.abs(c);
    } else {
      const a = parseAmount(row[cAmount]);
      if (a == null) continue;
      if (a >= 0) debit = a; else credit = Math.abs(a);
    }
    if (debit === 0 && credit === 0) continue;
    const bal = cBalance >= 0 ? parseAmount(row[cBalance]) : null;
    const ref = cRef >= 0 ? (String(row[cRef] ?? "").trim() || null) : null;
    txns.push({ date, description: desc, debit, credit, balance: bal, ref });
  }
  if (txns.length === 0) warnings.push("تم التعرف على الأعمدة لكن لم يُستخرج أي حركة. تأكد من تنسيق التواريخ والأرقام.");
  return { txns, warnings };
}

/** Heuristic line-based extractor used when the file is text-only (PDF/Word).
 *  Looks for lines that start (or contain) a recognizable date and at least
 *  one numeric amount. The last 1-3 numbers on the line are interpreted as
 *  amount(s) + optional running balance. */
function textToTx(text: string): { txns: ParsedTx[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!text || !text.trim()) return { txns: [], warnings: ["لم يُستخرج أي نص من الملف"] };

  // ── Format detection ──────────────────────────────────────────────────
  // Saudi bank PDFs (NCB/Al-Ahli, Al-Rajhi, Riyad …) render each
  // transaction as 3 separate text lines after pdf-parse:
  //   Line A: "<balance> SAR  <credit> SAR  <debit> SAR"   (RTL columns)
  //   Line B: free-form Arabic description
  //   Line C: "YYYY/MM/DD"
  // We try a multi-line parser first, then fall back to the legacy
  // single-line parser for other formats.
  //
  // We also try to detect the statement header totals (e.g. "Number Of
  // Deposits 194 / Withdrawals 555") so we can warn if the parser
  // missed a lot of rows.
  const expected = detectHeaderCounts(text);

  const multi = parseMultiLineSarFormat(text);
  if (multi.txns.length >= 5) {
    if (expected && expected.total > 0) {
      const got = multi.txns.length;
      const ratio = got / expected.total;
      if (ratio < 0.9) {
        multi.warnings.push(
          `الكشف يذكر ${expected.total} حركة (إيداع ${expected.deposits} + سحب ${expected.withdrawals}) — استُخرج ${got} فقط. راجع الكشف لو فيه صفوف ناقصة.`,
        );
      } else {
        multi.warnings.push(`تم استخراج ${got} حركة من ${expected.total} مذكورة في رأس الكشف.`);
      }
    }
    return multi;
  }

  // ── Fallback: legacy single-line parser ──────────────────────────────
  const dateRe = /(\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/;
  const numRe = /-?\(?[\d\u0660-\u0669\u06f0-\u06f9][\d\u0660-\u0669\u06f0-\u06f9,]*(?:\.[\d\u0660-\u0669\u06f0-\u06f9]+)?\)?/g;

  const txns: ParsedTx[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.length < 8) continue;
    const dm = line.match(dateRe);
    if (!dm) continue;
    const date = parseDate(dm[1]);
    if (!date) continue;

    const after = line.slice((dm.index ?? 0) + dm[1].length);
    const nums: number[] = [];
    const matches = after.match(numRe) ?? [];
    for (const m of matches) {
      const v = parseAmount(m);
      if (v != null) nums.push(v);
    }
    if (nums.length === 0) continue;

    const lastIdx = after.lastIndexOf(matches[matches.length - 1]);
    const description = after.slice(0, lastIdx).replace(/\s{2,}/g, " ").trim();

    let debit = 0, credit = 0, balance: number | null = null;
    if (nums.length >= 3) {
      const [a, b, c] = nums.slice(-3);
      const movement = a !== 0 ? a : b;
      const isDeposit = /(deposit|credit|إيداع|وارد|تحويل\s*إليكم?)/i.test(description);
      if (isDeposit) debit = Math.abs(movement); else credit = Math.abs(movement);
      balance = c;
    } else if (nums.length === 2) {
      const [a, bal] = nums.slice(-2);
      const isDeposit = /(deposit|credit|إيداع|وارد)/i.test(description);
      if (a >= 0 && isDeposit) debit = a;
      else if (a >= 0) credit = a;
      else credit = Math.abs(a);
      balance = bal;
    } else {
      const a = nums[nums.length - 1];
      if (a >= 0) credit = a; else debit = Math.abs(a);
    }

    if (debit === 0 && credit === 0) continue;
    txns.push({ date, description, debit, credit, balance, ref: null });
  }

  if (txns.length === 0) {
    warnings.push("تعذّر استخراج الحركات من النص. الكشوف بصيغة PDF تختلف من بنك لآخر — يفضّل تحميل الكشف بصيغة Excel/CSV من البنك.");
  } else {
    warnings.push("استخراج تجريبي من نص PDF/Word: راجع المبالغ والاتجاه (مدين/دائن) قبل الاعتماد عليها.");
  }
  return { txns, warnings };
}

/**
 * Try to read the deposit/withdrawal totals from the statement header.
 * Used purely for sanity warnings — never affects parsed rows.
 */
function detectHeaderCounts(text: string):
  | { deposits: number; withdrawals: number; total: number }
  | null {
  const dep = text.match(/Number\s*Of\s*Deposits\s*(\d{1,6})/i)
    ?? text.match(/عدد\s*ال[إا]يداعات[^\d]{0,20}(\d{1,6})/);
  const wd = text.match(/Number\s*Of\s*Withdrawals\s*(\d{1,6})/i)
    ?? text.match(/عدد\s*السحوبات[^\d]{0,20}(\d{1,6})/);
  if (!dep && !wd) return null;
  const deposits = dep ? Number(dep[1]) : 0;
  const withdrawals = wd ? Number(wd[1]) : 0;
  return { deposits, withdrawals, total: deposits + withdrawals };
}

/**
 * Multi-line parser for Saudi bank PDFs (NCB/Al-Ahli style):
 *   amounts line  → "<balance> SAR  <credit> SAR  <debit> SAR"
 *   description   → one or more free-text lines (Arabic)
 *   date          → "YYYY/MM/DD" alone (or with extra Hijri date)
 *
 * In the extracted text the visual right-to-left order means the FIRST
 * SAR amount is the BALANCE, the second is CREDIT, the third is DEBIT.
 * A row with `0.00 SAR` in the credit slot is a withdrawal; `0.00 SAR`
 * in the debit slot is a deposit.
 */
function parseMultiLineSarFormat(
  text: string,
): { txns: ParsedTx[]; warnings: string[] } {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Match "1,234.56 SAR" tokens (also negative / parenthesised)
  const sarTokenRe = /-?\(?[\d,]+(?:\.\d+)?\)?\s*SAR\b/gi;
  // Match a date line: just a YYYY/MM/DD (Gregorian) optionally followed
  // by a Hijri date or whitespace.
  const dateOnlyRe = /^\s*(\d{4}\/\d{1,2}\/\d{1,2})(?:\s|$)/;

  type Pending = { amounts: number[]; descLines: string[] };
  let pending: Pending | null = null;
  const txns: ParsedTx[] = [];

  for (const line of lines) {
    const sarMatches = line.match(sarTokenRe);
    if (sarMatches && sarMatches.length >= 2) {
      // New transaction header — flush any half-built one
      const amounts = sarMatches
        .map((t) => parseAmount(t.replace(/SAR/gi, "").trim()))
        .filter((n): n is number => n != null);
      pending = { amounts, descLines: [] };
      // Anything else on this line is part of the description
      const rest = line.replace(sarTokenRe, " ").replace(/\s{2,}/g, " ").trim();
      if (rest) pending.descLines.push(rest);
      continue;
    }

    const dm = line.match(dateOnlyRe);
    if (dm && pending && pending.amounts.length >= 2) {
      const date = parseDate(dm[1]);
      if (date) {
        // amounts order in extracted text: [balance, credit, debit]
        // (visual RTL: الرصيد | دائن | مدين)
        const [balance, credit, debit] =
          pending.amounts.length >= 3
            ? pending.amounts.slice(0, 3)
            : [null as any, pending.amounts[0], pending.amounts[1]];
        const debitN = Math.abs(Number(debit) || 0);
        const creditN = Math.abs(Number(credit) || 0);
        if (debitN > 0 || creditN > 0) {
          const description = pending.descLines.join(" ").replace(/\s{2,}/g, " ").trim();
          txns.push({
            date,
            description: description.slice(0, 500),
            debit: debitN,
            credit: creditN,
            balance: balance != null ? Number(balance) : null,
            ref: null,
          });
        }
      }
      pending = null;
      continue;
    }

    // Otherwise it's part of the current description
    if (pending) {
      // Skip pure page numbers / repeated header noise
      if (/^\d{1,3}$/.test(line)) continue;
      if (/^Ref\.?\s*No/i.test(line)) continue;
      if (/الرقم\s*التسلسلي/.test(line)) continue;
      pending.descLines.push(line);
    }
  }

  return { txns, warnings };
}

/** Decode a base64 payload (with or without data-URL prefix) into a Buffer. */
function decodeBase64(payload: string): Buffer {
  const idx = payload.indexOf("base64,");
  const b64 = idx >= 0 ? payload.slice(idx + 7) : payload;
  return Buffer.from(b64, "base64");
}

// ── OCR helper: ask OpenAI vision to extract bank-statement transactions ─
// Used for image uploads (PNG/JPG/WEBP) and as a fallback for scanned PDFs.
// (OPENAI_BASE / OPENAI_KEY are declared further below for /ai-match — read
// from process.env directly here to avoid forward-reference issues.)
async function ocrTransactionsFromImage(
  buf: Buffer,
  mime: string,
  filename?: string,
): Promise<{ txns: ParsedTx[]; warnings: string[] }> {
  const baseUrl = "AI_PROXY";
  const apiKey  = "AI_PROXY";
  if (!isAIAvailable()) {
    throw new Error("القراءة الذكية غير مفعّلة على الخادم (AI_INTEGRATIONS_OPENAI_* مفقود).");
  }
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  const systemPrompt = `أنت محلل كشوف بنكية خبير ودقيق جداً في قراءة الأرقام والتواريخ.
مهمتك قراءة صورة كشف حساب بنكي واستخراج كل سطر حركة بدقة 100%.

أعد JSON فقط بهذا الشكل بدون أي شرح:
{ "transactions": [ { "date": "YYYY-MM-DD", "description": "نص الحركة", "debit": 0, "credit": 0, "balance": null, "ref": null } ] }

قواعد صارمة للتواريخ:
- صيغة ISO إلزامية: YYYY-MM-DD (مثال: 2025-05-22).
- السنة 4 أرقام كاملة دائماً. لو الكشف يعرضها 2 أرقام فقط استنتج 20XX من سياق الكشف.
- اقرأ اليوم والشهر بدقة — لا تخمّن. لو التاريخ في الصورة "22/5" فهو يوم 22 شهر 5 وليس العكس (التنسيق السعودي DD/MM).
- لا تضِف أو تطرح أيّ يوم على التاريخ. أعد التاريخ كما هو ظاهر في الصورة بالضبط.
- لو السطر بدون تاريخ صريح (مجرد امتداد لسطر سابق) ضع تاريخ الحركة السابقة نفسه.

قواعد صارمة للأرقام (أهم جزء — أخطاء OCR هنا تُفسد المطابقة كلها):
- "debit" = مبلغ دخل للبنك (إيداع / وارد). "credit" = مبلغ خرج من البنك (سحب / صادر).
- استخدم 0 للقيمة غير الموجودة، لا تستخدم null للمبالغ.
- اقرأ الأرقام رقماً رقماً بدون تقدير. الفاصلة العشرية نقطة (.) والآلاف بدون فواصل في الإخراج.
- انتبه جداً للأرقام المتشابهة: (5 ≠ 6)، (0 ≠ 8)، (3 ≠ 8)، (1 ≠ 7)، (4 ≠ 9). أعد قراءة كل رقم لو في أدنى شك.
- لا تقرّب الأرقام إطلاقاً. لو الصورة تعرض 500.00 أعد 500 (وليس 600). لو تعرض 1,234.56 أعد 1234.56 بالضبط.
- لو رقمين متجاورين في نفس الصف (مثل عمود مدين + عمود دائن) لا تجمعهما. كل عمود في حقله المخصص.
- ميّز بين عمود "الرصيد" (balance) وأعمدة الحركة (debit/credit) — لا تخلطهم.

قواعد عامة:
- تجاهل الرصيد الافتتاحي والختامي والإجماليات — استخرج فقط الحركات الفعلية.
- لو الصورة غير واضحة في صف معيّن، اترك ذلك الصف بدلاً من تخمين أرقامه.
- لو الصورة لا تحوي حركات، أرجع { "transactions": [] }.

قبل إرجاع JSON: راجع كل تاريخ وكل مبلغ مرة ثانية وتأكد أنك قرأت كل رقم بدقة من الصورة وليس من السياق.`;

  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: `استخرج كل حركات كشف البنك من ${filename ?? "الصورة المرفقة"}.` },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`فشل القراءة الذكية: ${r.status} ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content ?? "{}";
  let parsed: any;
  try { parsed = JSON.parse(content); } catch { throw new Error("استجابة OCR غير صالحة"); }
  const list = Array.isArray(parsed?.transactions) ? parsed.transactions : [];
  const warnings: string[] = [];
  const txns: ParsedTx[] = [];
  // Track suspicious rows where the amount equals a date component
  // (year / day / month). This catches the classic OCR column-mix where
  // the year "2025" or day "16" gets pulled into the amount column.
  let suspiciousCount = 0;
  for (const t of list) {
    const date = String(t?.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const debit = Number(t?.debit) || 0;
    const credit = Number(t?.credit) || 0;
    if (debit === 0 && credit === 0) continue;
    const balanceRaw = t?.balance;
    const balance =
      balanceRaw === null || balanceRaw === undefined || balanceRaw === ""
        ? null
        : (Number.isFinite(Number(balanceRaw)) ? Number(balanceRaw) : null);

    // ── Date-vs-amount sanity check ────────────────────────────────────
    const [yStr, mStr, dStr] = date.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    const d = Number(dStr);
    const amt = debit !== 0 ? debit : credit;
    const isWholeNumber = Number.isInteger(amt);
    // Flag if the amount looks like one of the date parts AND is a
    // round whole number with no decimals (real transactions almost
    // always have decimals or are larger than the date components).
    const looksLikeDatePart =
      isWholeNumber &&
      (amt === y ||           // 2025, 2026 …
        (amt === d && d > 0) || // 1..31
        (amt === m && m > 0));  // 1..12
    // Also catch year-like values even if date didn't match exactly
    const looksLikeYear = isWholeNumber && amt >= 1990 && amt <= 2100;

    if (looksLikeDatePart || looksLikeYear) {
      suspiciousCount++;
      // Skip the row entirely — including it would silently corrupt the
      // reconciliation. The user gets a warning to re-upload or enter
      // it manually.
      continue;
    }

    txns.push({
      date,
      description: String(t?.description ?? "").trim(),
      debit,
      credit,
      balance,
      ref: t?.ref ? String(t.ref).slice(0, 64) : null,
    });
  }
  if (suspiciousCount > 0) {
    warnings.push(
      `تم تجاهل ${suspiciousCount} حركة مشبوهة: قيمتها تطابق السنة/اليوم/الشهر — على الأرجح خلط بين عمود التاريخ وعمود المبلغ في القراءة الذكية. ارفع صورة أوضح أو أدخل هذه السطور يدوياً.`
    );
  }
  if (txns.length === 0) warnings.push("لم تُستخرج أي حركة من الصورة. تأكد أن الصورة واضحة وتحتوي جدول الحركات.");
  return { txns, warnings };
}

// ── POST /parse ──────────────────────────────────────────────────────────
router.post("/parse", async (req, res) => {
  try {
    const { filename, contentBase64 } = req.body as { filename?: string; contentBase64?: string };
    if (!contentBase64 || typeof contentBase64 !== "string") {
      res.status(400).json({ error: "contentBase64 مطلوب" });
      return;
    }
    const buf = decodeBase64(contentBase64);
    const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";

    let txns: ParsedTx[] = [];
    let warnings: string[] = [];

    if (ext === "xlsx" || ext === "xls" || ext === "csv") {
      const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
      // Pick the largest sheet (most rows) — usually the transactions.
      let bestSheet = wb.SheetNames[0];
      let bestRows = 0;
      for (const name of wb.SheetNames) {
        const sh = wb.Sheets[name];
        const rows: any[][] = XLSX.utils.sheet_to_json(sh, { header: 1, blankrows: false, defval: null }) as any[][];
        if (rows.length > bestRows) { bestRows = rows.length; bestSheet = name; }
      }
      const matrix: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[bestSheet], { header: 1, blankrows: false, defval: null }) as any[][];
      const r = rowsToTx(matrix);
      txns = r.txns;
      warnings = r.warnings;
    } else if (ext === "pdf") {
      // pdf-parse v2 exports a class — old `pdfParse(buf)` call no longer works.
      // pdfjs-dist v5 (transitively used by pdf-parse) references browser
      // Web APIs at module-load time: DOMMatrix, Path2D, ImageData. Node
      // does not provide them, so the dynamic import throws
      // `ReferenceError: DOMMatrix is not defined` once, which leaves
      // pdf-parse's __esm module partially initialized — every subsequent
      // `new PDFParse(...)` then fails with "PDFParse2 is not a constructor".
      // Text extraction (which is all we use) never actually touches canvas,
      // so installing minimal no-op stubs before the import is enough.
      const g = globalThis as any;
      if (typeof g.DOMMatrix === "undefined") g.DOMMatrix = class { constructor() {} };
      if (typeof g.Path2D    === "undefined") g.Path2D    = class { constructor() {} };
      if (typeof g.ImageData === "undefined") g.ImageData = class { constructor() {} };
      const { PDFParse } = await import("pdf-parse");
      const parser = new (PDFParse as any)({ data: new Uint8Array(buf) });
      const out = await parser.getText();
      const text = String(out?.text ?? "");
      const r = textToTx(text);
      txns = r.txns;
      warnings = r.warnings;

      // Temporary debug: when called with ?debug=1, dump the raw extracted
      // PDF text + the parsed transactions into the request log so we can
      // inspect exactly what the parser sees vs what it produces. This
      // helps diagnose off-by-one dates and balance/credit/debit column
      // mis-ordering for specific bank statement layouts (e.g. الراجحي).
      // Remove this block once parser is tuned for the target layouts.
      if (req.query.debug === "1") {
        const preview = text.length > 12000 ? text.slice(0, 12000) + "\n…[truncated]" : text;
        req.log.warn({
          msg: "[bank-reconciliation DEBUG] pdf text dump",
          filename,
          textLength: text.length,
          textPreview: preview,
          parsedCount: txns.length,
          firstFiveParsed: txns.slice(0, 5),
          lastFiveParsed: txns.slice(-5),
        }, "PDF parse debug dump");
      }
      // Scanned PDFs have no extractable text. The OCR helper accepts only
      // image MIME types (OpenAI vision rejects application/pdf), so we
      // surface a clear Arabic instruction to the user instead of attempting
      // a call that would fail. They can re-export the PDF as PNG/JPG or
      // upload pages as images and we'll OCR those.
      if (txns.length === 0 && text.trim().length < 40) {
        warnings = [
          "هذا الـ PDF يبدو ممسوحاً ضوئياً (لا يحوي نصاً قابلاً للقراءة).",
          "للقراءة الذكية: حوّل صفحاته إلى صور (PNG/JPG) وارفعها مباشرة — يمكنك رفع أكثر من صورة معاً وسيتم دمج الحركات تلقائياً.",
        ];
      }
    } else if (ext === "docx" || ext === "doc") {
      const mod = await import("mammoth");
      const mammoth: any = (mod as any).default ?? mod;
      const { value } = await mammoth.extractRawText({ buffer: buf });
      const r = textToTx(String(value ?? ""));
      txns = r.txns;
      warnings = r.warnings;
    } else if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp") {
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      const ocr = await ocrTransactionsFromImage(buf, mime, filename);
      txns = ocr.txns;
      warnings = ["تم استخدام القراءة الذكية لاستخراج الحركات من الصورة (OCR).", ...ocr.warnings];
    } else {
      res.status(400).json({ error: `صيغة غير مدعومة: .${ext || "?"} — المدعوم: xlsx, xls, csv, pdf, docx, png, jpg, jpeg, webp` });
      return;
    }

    // Sort ascending by date, stable.
    txns.sort((a, b) => a.date.localeCompare(b.date));
    res.json({ filename: filename ?? null, count: txns.length, warnings, transactions: txns });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "bank-reconciliation parse failed");
    res.status(500).json({ error: e?.message ?? "فشل تحليل الملف" });
  }
});

// ── GET /book-ledger ─────────────────────────────────────────────────────
// Returns the GL-derived ledger for a bank account in the given period,
// using the same posted-only filter as Trial Balance / Account Statement.
// Output shape mirrors ParsedTx so the frontend can run a unified diff.
router.get("/book-ledger", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
    if (!cid) { res.json({ opening: 0, transactions: [] }); return; }
    const bankAccountIdRaw = req.query.bankAccountId;
    const accountIdRaw = req.query.accountId;
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if ((!bankAccountIdRaw && !accountIdRaw) || !from || !to) {
      res.status(400).json({ error: "bankAccountId أو accountId مع from, to مطلوبة" });
      return;
    }

    // Resolve the GL accountId from either source:
    //   • bankAccountId → look up the bank-account row in the cash module
    //     (with branch isolation, mirroring /api/bank-accounts visibility).
    //   • accountId     → use a chart-of-accounts row directly. Useful when
    //     the company tracks the bank only as a GL account and never
    //     registered it in the cash & banks module.
    let glAccountId: number | null = null;
    if (bankAccountIdRaw) {
      const bankAccountId = Number(bankAccountIdRaw);
      if (!Number.isFinite(bankAccountId)) {
        res.status(400).json({ error: "bankAccountId غير صالح" });
        return;
      }
      const [bank] = await db
        .select({
          accountId: bankAccountsTable.accountId,
          branchId: bankAccountsTable.branchId,
          branchIds: bankAccountsTable.branchIds,
          companyId: bankAccountsTable.companyId,
        })
        .from(bankAccountsTable)
        .where(eq(bankAccountsTable.id, bankAccountId))
        .limit(1);
      if (!bank || bank.companyId !== cid || !bank.accountId) {
        res.json({ opening: 0, transactions: [] });
        return;
      }
      const allowed = getAllowedBranchIds(req);
      if (allowed) {
        const ownedBranchIds = bank.branchIds ?? (bank.branchId != null ? [bank.branchId] : null);
        const isShared = ownedBranchIds == null;
        const overlaps = ownedBranchIds != null && ownedBranchIds.some(b => allowed.includes(b));
        if (!isShared && !overlaps) {
          res.json({ opening: 0, transactions: [] });
          return;
        }
      }
      glAccountId = bank.accountId;
    } else {
      const accountId = Number(accountIdRaw);
      if (!Number.isFinite(accountId)) {
        res.status(400).json({ error: "accountId غير صالح" });
        return;
      }
      const [acc] = await db
        .select({ id: accountsTable.id, companyId: accountsTable.companyId })
        .from(accountsTable)
        .where(eq(accountsTable.id, accountId))
        .limit(1);
      if (!acc || acc.companyId !== cid) {
        res.json({ opening: 0, transactions: [] });
        return;
      }
      glAccountId = acc.id;
    }
    // Branch scope on the JE side: when the user is restricted to a subset
    // of branches we must filter journal_entry_lines accordingly so that
    // movements posted from a different branch against this same shared
    // bank account aren't leaked. NULL-branch JEs (system/opening) stay
    // visible — that's the documented `effectiveBranchCondition` semantic.
    const jeBranchScope = branchScopeSpread(req, journalEntriesTable.branchId, undefined);

    // Opening = previousDebit - previousCredit (strictly before `from`)
    const [prev] = await db
      .select({
        debit: sql<string>`COALESCE(SUM(${journalEntryLinesTable.debit}), 0)`,
        credit: sql<string>`COALESCE(SUM(${journalEntryLinesTable.credit}), 0)`,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
      .where(and(
        eq(journalEntryLinesTable.accountId, glAccountId),
        eq(journalEntriesTable.companyId, cid),
        eq(journalEntriesTable.status, "posted"),
        sql`${journalEntriesTable.entryDate} < ${from}`,
        ...jeBranchScope,
      ));
    const opening = Number(prev?.debit ?? 0) - Number(prev?.credit ?? 0);

    const rows = await db
      .select({
        entryId: journalEntriesTable.id,
        docNumber: journalEntriesTable.docNumber,
        entryDate: journalEntriesTable.entryDate,
        description: sql<string>`COALESCE(${journalEntryLinesTable.description}, ${journalEntriesTable.description}, '')`,
        debit: journalEntryLinesTable.debit,
        credit: journalEntryLinesTable.credit,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
      .where(and(
        eq(journalEntryLinesTable.accountId, glAccountId),
        eq(journalEntriesTable.companyId, cid),
        eq(journalEntriesTable.status, "posted"),
        gte(journalEntriesTable.entryDate, from),
        lte(journalEntriesTable.entryDate, to),
        ...jeBranchScope,
      ))
      .orderBy(journalEntriesTable.entryDate, journalEntriesTable.id);

    const transactions = rows.map(r => ({
      id: `je-${r.entryId}`,
      date: String(r.entryDate),
      description: String(r.description ?? ""),
      debit: Number(r.debit ?? 0),
      credit: Number(r.credit ?? 0),
      ref: r.docNumber ?? null,
    }));

    res.json({ opening, transactions });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "bank-reconciliation book-ledger failed");
    res.status(500).json({ error: e?.message ?? "فشل جلب القيود" });
  }
});

// ── POST /ai-match ───────────────────────────────────────────────────────
// AI-powered smart matching. Handles consolidated journal entries that map
// to many individual bank transactions (e.g., one salary JE of 100,000 that
// matches 20 bank transfers of 5,000 each), as well as the reverse case.
//
// Request body:
//   { book: BookTx[], bank: BankTx[], toleranceDays?: number }
// Response:
//   {
//     pairs:   [{ bookIds:[...], bankIds:[...], confidence, reason }],
//     unmatchedAnalysis: [{ side:"book"|"bank", id, likelyExplanation }],
//     summary: string
//   }
const OPENAI_BASE = "AI_PROXY";
const OPENAI_KEY = "AI_PROXY";

router.post("/ai-match", requireAiFeature("account_suggestions"), async (req, res) => {
  try {
    if (!isAIAvailable()) {
      res.status(500).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" });
      return;
    }
    const book = Array.isArray(req.body?.book) ? req.body.book : [];
    const bank = Array.isArray(req.body?.bank) ? req.body.bank : [];
    const toleranceDays = Math.min(15, Math.max(0, Number(req.body?.toleranceDays ?? 3)));
    if (book.length === 0 || bank.length === 0) {
      res.status(400).json({ error: "يجب توفير حركات دفترية وبنكية" });
      return;
    }

    // Trim payload to keep prompt manageable (~200 each side, descriptions to 80 chars)
    const trim = (arr: any[], max = 200) =>
      arr.slice(0, max).map((t: any) => ({
        id: String(t.id),
        date: String(t.date ?? "").slice(0, 10),
        desc: String(t.description ?? "").slice(0, 80),
        amount: Number(t.debit ?? 0) - Number(t.credit ?? 0),
        ref: t.ref ? String(t.ref).slice(0, 30) : null,
      }));
    const bookSlim = trim(book);
    const bankSlim = trim(bank);

    const systemPrompt = `أنت محاسب خبير في مطابقة كشوف البنوك. مهمتك مطابقة قيود اليومية مع حركات كشف البنك.

قواعد:
- "amount" موجب = إيداع (وارد للبنك)، سالب = سحب (صادر من البنك).
- يجب أن يتطابق اتجاه المبلغ (نفس الإشارة) في كل مجموعة.
- مجموع المبالغ في bookIds يجب أن يساوي مجموع المبالغ في bankIds (سماحية ±0.01).
- التواريخ يجب أن تكون متقاربة (سماحية ${toleranceDays} يوم).
- حالات شائعة:
  * 1↔1: قيد واحد = حركة بنكية واحدة (نفس المبلغ والتاريخ).
  * 1↔N: قيد رواتب مجمّع 100,000 = 20 تحويل بنكي 5,000 لكل موظف.
  * N↔1: عدة قيود مبيعات يومية = إيداع نقدي واحد في البنك.
  * N↔N: مجموعة قيود = مجموعة حركات بنفس الإجمالي.
- استخدم البيان (desc) والمرجع (ref) كدلائل (أسماء موظفين، أرقام شيكات، إلخ).
- لا تخمّن — إذا لم تكن واثقاً (confidence < 0.6) لا تطابق.

أعد JSON فقط بهذا الشكل:
{
  "pairs": [
    { "bookIds": ["..."], "bankIds": ["..."], "confidence": 0.0-1.0, "reason": "شرح موجز بالعربية" }
  ],
  "unmatchedAnalysis": [
    { "side": "book"|"bank", "id": "...", "likelyExplanation": "سبب محتمل لعدم وجود مطابق" }
  ],
  "summary": "ملخص عام للنتيجة"
}`;

    const userPayload = JSON.stringify({ book: bookSlim, bank: bankSlim });
    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 4096,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPayload },
        ],
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(502).json({ error: `فشل الذكاء الاصطناعي: ${r.status} ${txt.slice(0, 200)}` });
      return;
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any;
    try { parsed = JSON.parse(content); } catch { parsed = {}; }

    // Server-side validation: keep only pairs whose sums actually balance.
    const bookMap = new Map(book.map((t: any) => [String(t.id), Number(t.debit ?? 0) - Number(t.credit ?? 0)]));
    const bankMap = new Map(bank.map((t: any) => [String(t.id), Number(t.debit ?? 0) - Number(t.credit ?? 0)]));
    const seenBook = new Set<string>();
    const seenBank = new Set<string>();
    const validPairs: any[] = [];
    for (const p of (parsed.pairs ?? [])) {
      const bookIds = (p.bookIds ?? []).map(String).filter((id: string) => bookMap.has(id) && !seenBook.has(id));
      const bankIds = (p.bankIds ?? []).map(String).filter((id: string) => bankMap.has(id) && !seenBank.has(id));
      if (bookIds.length === 0 || bankIds.length === 0) continue;
      const bookSum = bookIds.reduce((s: number, id: string) => s + (bookMap.get(id) ?? 0), 0);
      const bankSum = bankIds.reduce((s: number, id: string) => s + (bankMap.get(id) ?? 0), 0);
      if (Math.abs(bookSum - bankSum) > 0.01) continue;
      bookIds.forEach((id: string) => seenBook.add(id));
      bankIds.forEach((id: string) => seenBank.add(id));
      validPairs.push({
        bookIds,
        bankIds,
        confidence: Math.max(0, Math.min(1, Number(p.confidence ?? 0.7))),
        reason: String(p.reason ?? ""),
        bookSum: Number(bookSum.toFixed(2)),
        bankSum: Number(bankSum.toFixed(2)),
      });
    }

    res.json({
      pairs: validPairs,
      unmatchedAnalysis: Array.isArray(parsed.unmatchedAnalysis) ? parsed.unmatchedAnalysis.slice(0, 50) : [],
      summary: String(parsed.summary ?? ""),
      stats: {
        totalProposed: (parsed.pairs ?? []).length,
        totalAccepted: validPairs.length,
        bookMatched: seenBook.size,
        bankMatched: seenBank.size,
      },
    });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "bank-reconciliation ai-match failed");
    res.status(500).json({ error: e?.message ?? "فشل المطابقة الذكية" });
  }
});

export default router;
