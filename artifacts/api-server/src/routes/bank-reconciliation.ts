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
  bankAccountsTable,
  journalEntriesTable,
  journalEntryLinesTable,
} from "@workspace/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { extractAuth, resolveCompanyId, getAllowedBranchIds, branchScopeSpread } from "../middleware/auth.js";
import { requireModulePermission } from "../middleware/permissions.js";

const router: Router = Router();
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

/** Loose date parser supporting many common bank formats. Returns yyyy-mm-dd or "". */
function parseDate(raw: any): string {
  if (raw == null) return "";
  if (typeof raw === "number") return excelSerialToISO(raw) ?? "";
  const s = String(raw).trim();
  if (!s) return "";
  // Already ISO?
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const y = iso[1], m = iso[2].padStart(2, "0"), d = iso[3].padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  // dd/mm/yyyy or dd-mm-yyyy or dd.mm.yyyy (also yyyy/mm/dd, mm/dd/yyyy).
  // Disambiguation: if either of the first two parts is > 12 we know which
  // is the day; otherwise we default to **dd/mm** (Saudi/EU convention used
  // by all local bank statements). PDF/CSV exports of US-formatted files
  // are rare here, so dd/mm is the safer assumption.
  const m1 = s.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})/);
  if (m1) {
    const a = m1[1], b = m1[2], c = m1[3];
    let y: string, mo: string, d: string;
    if (a.length === 4) {
      // yyyy/mm/dd
      y = a; mo = b; d = c;
    } else if (c.length === 4 || c.length === 2) {
      const A = Number(a), B = Number(b);
      if (A > 12 && B <= 12) { d = a; mo = b; }       // unambiguous dd/mm
      else if (B > 12 && A <= 12) { d = b; mo = a; }  // unambiguous mm/dd
      else { d = a; mo = b; }                          // default dd/mm (SA)
      y = c.length === 4 ? c : `20${c.padStart(2, "0")}`;
    } else {
      d = a; mo = b; y = c;
    }
    const yy = y.padStart(4, "20");
    const mm = mo.padStart(2, "0");
    const dd = d.padStart(2, "0");
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) {
      return `${yy}-${mm}-${dd}`;
    }
  }
  // Last resort: native Date parse
  const d2 = new Date(s);
  if (!isNaN(d2.getTime()) && d2.getFullYear() > 1990 && d2.getFullYear() < 2100) {
    return d2.toISOString().slice(0, 10);
  }
  return "";
}

/** Parse an arbitrary string/number into a finite number, or null. Handles
 *  thousands separators ("1,234.56"), Arabic-Indic digits, parentheses for
 *  negatives ("(123.45)") and trailing CR/DR markers. */
function parseAmount(raw: any): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;
  // Arabic-Indic → Western digits
  s = s.replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(/[\u06f0-\u06f9]/g, d => String(d.charCodeAt(0) - 0x06f0));
  // Strip currency symbols, spaces, NBSP, RTL marks
  s = s.replace(/[\u200e\u200f\u202a-\u202e\s]+/g, "");
  s = s.replace(/(?:SAR|SR|ر\.?س\.?|﷼|USD|\$|EUR|€)/gi, "");
  let sign = 1;
  if (/^\(.+\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/(?:^|[^A-Z])(DR|DEBIT)\b/i.test(s)) sign = -1;
  if (/(?:^|[^A-Z])(CR|CREDIT)\b/i.test(s)) sign = 1;
  s = s.replace(/[A-Za-z]+/g, "");
  s = s.replace(/,/g, "");
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

    // Strip the date out and collect all numeric tokens in order
    const after = line.slice((dm.index ?? 0) + dm[1].length);
    const nums: number[] = [];
    const matches = after.match(numRe) ?? [];
    for (const m of matches) {
      const v = parseAmount(m);
      if (v != null) nums.push(v);
    }
    if (nums.length === 0) continue;

    // Description = everything before the last numbers
    const lastIdx = after.lastIndexOf(matches[matches.length - 1]);
    const description = after.slice(0, lastIdx).replace(/\s{2,}/g, " ").trim();

    let debit = 0, credit = 0, balance: number | null = null;
    if (nums.length >= 3) {
      // Probably: debit, credit, balance (or credit, debit, balance)
      const [a, b, c] = nums.slice(-3);
      // Heuristic: column with smaller magnitude that's not zero is the
      // movement. We can't reliably tell which is debit vs credit from
      // text alone, so we pick the side based on description keywords
      // and fall back to "credit" (money out).
      const movement = a !== 0 ? a : b;
      const isDeposit = /(deposit|credit|إيداع|وارد|تحويل\s*إليكم?)/i.test(description);
      if (isDeposit) debit = Math.abs(movement); else credit = Math.abs(movement);
      balance = c;
    } else if (nums.length === 2) {
      // Probably: amount, balance
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

/** Decode a base64 payload (with or without data-URL prefix) into a Buffer. */
function decodeBase64(payload: string): Buffer {
  const idx = payload.indexOf("base64,");
  const b64 = idx >= 0 ? payload.slice(idx + 7) : payload;
  return Buffer.from(b64, "base64");
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
      const mod = await import("pdf-parse");
      const pdfParse: any = (mod as any).default ?? mod;
      const data = await pdfParse(buf);
      const r = textToTx(String(data?.text ?? ""));
      txns = r.txns;
      warnings = r.warnings;
    } else if (ext === "docx" || ext === "doc") {
      const mod = await import("mammoth");
      const mammoth: any = (mod as any).default ?? mod;
      const { value } = await mammoth.extractRawText({ buffer: buf });
      const r = textToTx(String(value ?? ""));
      txns = r.txns;
      warnings = r.warnings;
    } else {
      res.status(400).json({ error: `صيغة غير مدعومة: .${ext || "?"} — المدعوم: xlsx, xls, csv, pdf, docx` });
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
    const bankAccountId = Number(req.query.bankAccountId);
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if (!Number.isFinite(bankAccountId) || !from || !to) {
      res.status(400).json({ error: "bankAccountId, from, to مطلوبة" });
      return;
    }

    // Resolve GL accountId + branch isolation. Mirror the visibility rules
    // used by /api/bank-accounts: a row is visible when it is shared
    // (`branchIds IS NULL AND branchId IS NULL`), when its `branchIds`
    // overlaps the user's allowed branches, or — for legacy rows that
    // never got migrated to the array — when its single `branchId` is
    // in the allowed list.
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
        eq(journalEntryLinesTable.accountId, bank.accountId),
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
        eq(journalEntryLinesTable.accountId, bank.accountId),
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

export default router;
