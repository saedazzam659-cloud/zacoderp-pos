// CRUD + reset + logs for the central document-numbering registry.
// All endpoints require admin (or superadmin) — sequences are a sensitive,
// company-wide setting and must NOT be editable by line operators.

import { Router } from "express";
import { db } from "@workspace/db";
import {
  sequencesTable, sequenceLogsTable, SEQUENCE_TX_TYPES,
} from "@workspace/db";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requireAdminRole, audit } from "../middleware/permissions.js";
import { subTypeFor } from "../lib/sequences.js";

const router = Router();
router.use(extractAuth);

const TX_SET = new Set<string>(SEQUENCE_TX_TYPES);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

// Render the optional dynamic month/year pattern (`{MM} {M} {YY} {YYYY}`)
// against the current date. Empty / null pattern → "" (legacy format).
// Kept in sync with the same helper in `lib/sequences.ts` so peek + issue
// always agree on the format.
function renderMonthPattern(pattern: string | null | undefined, now: Date = new Date()): string {
  if (!pattern) return "";
  const m  = now.getMonth() + 1;
  const y  = now.getFullYear();
  const MM = String(m).padStart(2, "0");
  const YY = String(y).slice(-2);
  return pattern
    .replace(/\{MM\}/g,   MM)
    .replace(/\{M\}/g,    String(m))
    .replace(/\{YYYY\}/g, String(y))
    .replace(/\{YY\}/g,   YY);
}

function fmt(
  prefix: string | null | undefined,
  n: number,
  padLength: number | null | undefined,
  monthPattern?: string | null,
  effectiveDate: Date = new Date(),
): string {
  const pad = padLength ?? 0;
  const padded = pad > 0 ? String(n).padStart(pad, "0") : String(n);
  return `${prefix ?? ""}${renderMonthPattern(monthPattern, effectiveDate)}${padded}`;
}

// Mirror of `resolveEffectiveDate` in `lib/sequences.ts`. When the company
// has opted into `sequence_date_source = "document"`, the `{MM}/{YY}/{YYYY}`
// tokens in the preview must reflect the document's date (the `?date=` query)
// — not today — so the badge the user sees on the form matches the number
// the issuance helper will actually persist on submit.
function resolveEffectiveDateForPreview(
  source: string | null | undefined,
  previewDate: Date,
): Date {
  if (source === "document") return previewDate;
  return new Date();
}

// ─── Public (authenticated) peek endpoint ──────────────────────────────────
// GET /api/sequences/peek/:txType?branchId=N
// Returns the formatted NEXT number for the active sequence bound to the
// given transaction type, WITHOUT incrementing the counter. If no active
// sequence is configured the response is { number: null, hasSequence: false }
// so callers can fall back to a free-typed input.
//
// Branch-aware: the preview must reflect the per-branch counter that
// `nextSequenceNumber` would actually issue for this (sequence, branch)
// pair. When `?branchId` is omitted (or 0), the company-wide sentinel
// counter is previewed — this is the correct preview for warehouse-scoped
// flows (stock_transfer / stock_adjustment / stock_count).
//
// Crucially: when no counter row exists yet for this (sequence, branch),
// the preview applies the SAME seeding rules as the issuance helper so the
// number the user sees on the form matches the number that will actually
// be persisted on submit:
//   - first counter on this sequence  → MAX(start_number, master.current_number)
//   - any later (new) branch counter  → start_number
//
// Available to any authenticated user (line operators need this to render
// the read-only document-number field on every form), but the response is
// scoped to the caller's company — no cross-tenant leakage.
router.get("/peek/:txType", async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  const txType = String(req.params.txType ?? "");
  if (!TX_SET.has(txType)) { res.status(400).json({ error: "نوع حركة غير معروف" }); return; }

  const rawBranch = req.query?.branchId;
  const parsedBranch = rawBranch != null && rawBranch !== "" ? Number(rawBranch) : 0;
  const branchKey = Number.isFinite(parsedBranch) && parsedBranch > 0 ? parsedBranch : 0;

  // Optional ?date=YYYY-MM-DD lets the client preview the number for a
  // specific document date (e.g. the editable invoiceDate on a form). When
  // omitted we use today — the natural default for a fresh document. The
  // date drives fiscal-period resolution: a sequence scoped to FY 2026 will
  // only be picked here when the date lands inside one of its periods.
  const rawDate = req.query?.date;
  const dateInput = rawDate != null && rawDate !== "" ? new Date(String(rawDate)) : new Date();
  const previewDate = isNaN(dateInput.getTime()) ? new Date() : dateInput;
  const dateStr = `${previewDate.getUTCFullYear()}-${String(previewDate.getUTCMonth() + 1).padStart(2, "0")}-${String(previewDate.getUTCDate()).padStart(2, "0")}`;

  // Find the fiscal period containing the preview date (if any). When the
  // date falls outside every configured period (e.g. before the first
  // fiscal year was created) we leave periodId as null — only universal
  // (empty fiscalPeriodIds) sequences then match.
  const periodRows = await db.execute<{ id: number }>(sql`
    SELECT id FROM fiscal_periods
    WHERE company_id = ${cid}
      AND start_date <= ${dateStr}
      AND end_date   >= ${dateStr}
    ORDER BY id ASC
    LIMIT 1
  `);
  const periodId = periodRows.rows?.[0]?.id ?? null;
  const periodMatchSql = periodId != null
    ? sql`OR fiscal_period_ids @> ${JSON.stringify([periodId])}::jsonb`
    : sql``;

  // Read the company-wide date-source setting (same column the issuance
  // helper consults). When the tenant has switched to "document", the
  // `{MM}/{YY}/{YYYY}` tokens must render against the previewDate — so the
  // badge the user sees on the form matches the number that will actually
  // be persisted on submit. Default "system" preserves legacy behaviour.
  const cfgRows = await db.execute<{ sequence_date_source: string | null }>(sql`
    SELECT sequence_date_source FROM companies WHERE id = ${cid} LIMIT 1
  `);
  const dateSource = cfgRows.rows?.[0]?.sequence_date_source ?? "system";
  const effectiveDate = resolveEffectiveDateForPreview(dateSource, previewDate);

  // Resolve the preview for a SINGLE transaction type. Extracted so the
  // opt-in per-payment-method split can try the payment-specific sub-type
  // first and transparently fall back to the unified base type when no
  // sub-type series is configured. Returns null when no active sequence is
  // bound to the type (caller then tries the next candidate).
  async function resolveForType(qType: string): Promise<{
    number: string | null; hasSequence: true; sequenceCode: string;
    branchId: number; exhausted: boolean;
  } | null> {
    // ORDER BY puts scoped matches first so a "FY 2026 override" sequence
    // wins over a tenant's existing universal sequence for documents that
    // belong to 2026 — matching the resolution logic in nextSequenceNumber.
    const rows = await db.execute<{
      id: number;
      prefix: string | null; start_number: number; current_number: number;
      end_number: number; pad_length: number | null; code: string;
      month_pattern: string | null; monthly_reset: boolean;
    }>(sql`
      SELECT id, prefix, start_number, current_number, end_number, pad_length, code, month_pattern, monthly_reset
      FROM sequences
      WHERE company_id = ${cid}
        AND is_active = true
        AND transaction_types ? ${qType}
        AND (jsonb_array_length(fiscal_period_ids) = 0 ${periodMatchSql})
      ORDER BY
        CASE WHEN jsonb_array_length(fiscal_period_ids) > 0 THEN 0 ELSE 1 END ASC,
        id ASC
      LIMIT 1
    `);
    const seq = rows.rows?.[0];
    if (!seq) return null;

    // Resolve the counter BUCKET this preview belongs to — IDENTICAL to the
    // issuance helper:
    //   • monthly_reset OFF → the single continuous "" sentinel row.
    //   • monthly_reset ON  → the per-month "YYYY-MM" row for the previewed date.
    const monthlyReset  = seq.monthly_reset === true;
    const previewPeriod = `${effectiveDate.getFullYear()}-${String(effectiveDate.getMonth() + 1).padStart(2, "0")}`;
    const counterPeriod = monthlyReset ? previewPeriod : "";

    // Pull the bucket counter (if any) and an "any counter exists?" flag in a
    // single round-trip. The flag drives the non-reset seeding heuristic.
    const counterRows = await db.execute<{
      bucket_current: number | null; any_exists: boolean;
    }>(sql`
      SELECT
        (SELECT current_number FROM sequence_counters
          WHERE sequence_id = ${seq.id} AND branch_id = ${branchKey} AND period = ${counterPeriod}) AS bucket_current,
        EXISTS(SELECT 1 FROM sequence_counters WHERE sequence_id = ${seq.id}) AS any_exists
    `);
    const cRow = counterRows.rows?.[0];
    const bucketCurrent = cRow?.bucket_current ?? null;
    const anyExists     = !!cRow?.any_exists;

    let previewNumber: number;
    if (bucketCurrent != null) {
      // Bucket already exists — preview its running number directly.
      previewNumber = bucketCurrent;
    } else if (monthlyReset) {
      // No counter for this month yet — mirror the helper's seed: start_number,
      // but never below what was already issued this month (logs) nor below a
      // legacy "" row being adopted on a monthly_reset toggle. (Read-only: the
      // preview never retires the legacy row — only the real issuance does.)
      let seed = seq.start_number;
      const renderedPrefix = `${seq.prefix ?? ""}${renderMonthPattern(seq.month_pattern, effectiveDate)}`;
      const escaped = renderedPrefix.replace(/([\\%_])/g, "\\$1");
      const logRows = await db.execute<{ mx: number | null }>(sql`
        SELECT MAX((regexp_match(generated_number, '(\\d+)$'))[1]::int) AS mx
        FROM sequence_logs
        WHERE sequence_id = ${seq.id}
          AND generated_number LIKE ${escaped + "%"} ESCAPE '\\'
      `);
      const logMax = logRows.rows?.[0]?.mx ?? null;
      if (logMax != null) seed = Math.max(seed, logMax + 1);
      const legacyRows = await db.execute<{ current_number: number; last_period: string | null }>(sql`
        SELECT current_number, last_period FROM sequence_counters
        WHERE sequence_id = ${seq.id} AND branch_id = ${branchKey} AND period = ''
      `);
      const legacy = legacyRows.rows?.[0];
      if (legacy && (legacy.last_period == null || legacy.last_period === counterPeriod)) {
        seed = Math.max(seed, legacy.current_number);
      }
      previewNumber = seed;
    } else {
      // Non-reset, no "" row yet — identical to the pre-period seeding rule.
      previewNumber = anyExists ? seq.start_number : Math.max(seq.start_number, seq.current_number);
    }

    const exhausted = previewNumber > seq.end_number;
    return {
      number: exhausted ? null : fmt(seq.prefix, previewNumber, seq.pad_length, seq.month_pattern, effectiveDate),
      hasSequence: true,
      sequenceCode: seq.code,
      branchId: branchKey,
      exhausted,
    };
  }

  // Opt-in per-payment-method split: when the client passes ?paymentType= and
  // the (base, paymentType) pair maps to a configured sub-type series, preview
  // THAT series; otherwise fall back to the unified base type. Mirrors the
  // issuance-time resolution in `nextSequenceForPayment`.
  const sub = subTypeFor(txType, req.query?.paymentType as string | undefined);
  let result = sub ? await resolveForType(sub) : null;
  if (!result) result = await resolveForType(txType);
  if (!result) { res.json({ number: null, hasSequence: false }); return; }
  res.json(result);
});

// ─── Admin-only management endpoints ───────────────────────────────────────
// Sequences management is admin-only at every level (sidebar, route, perm).
router.use(requireAdminRole);
router.use(audit("sequences", "view"));

// Validate the body for create/edit. Returns null on success or an error
// message string. Centralized so create + edit stay in sync.
function validatePayload(body: any): string | null {
  const code = String(body?.code ?? "").trim();
  const nameAr = String(body?.nameAr ?? "").trim();
  const prefix = String(body?.prefix ?? "");
  const start = Number(body?.startNumber);
  const end   = Number(body?.endNumber);
  const cur   = body?.currentNumber == null ? start : Number(body.currentNumber);
  const pad   = Number(body?.padLength ?? 4);
  const types = Array.isArray(body?.transactionTypes) ? body.transactionTypes : [];
  // branchIds is optional; an empty array (or omitted) means "all branches".
  // When provided, every entry must be a positive integer (branches.id is
  // serial starting at 1, so 0 / negatives are rejected).
  const branchIds = Array.isArray(body?.branchIds) ? body.branchIds : [];
  // fiscalPeriodIds is optional; an empty array (or omitted) means "all
  // periods" (universal). When non-empty, every entry must be a positive
  // integer matching fiscal_periods.id.
  const fiscalPeriodIds = Array.isArray(body?.fiscalPeriodIds) ? body.fiscalPeriodIds : [];

  if (!code)   return "الكود مطلوب";
  if (!nameAr) return "الاسم العربي مطلوب";
  if (!Number.isFinite(start) || start < 0) return "رقم البداية غير صالح";
  if (!Number.isFinite(end)   || end < start) return "رقم النهاية يجب أن يكون أكبر من أو يساوي رقم البداية";
  if (!Number.isFinite(cur)   || cur < start || cur > end + 1)
    return "الرقم الحالي خارج النطاق المسموح";
  if (!Number.isFinite(pad) || pad < 0 || pad > 12) return "طول التعبئة بالأصفار غير صالح";
  if (!Array.isArray(types) || types.length === 0)
    return "يجب اختيار شاشة واحدة على الأقل";
  for (const t of types) {
    if (!TX_SET.has(String(t))) return `نوع حركة غير معروف: ${t}`;
  }
  for (const b of branchIds) {
    const n = Number(b);
    if (!Number.isInteger(n) || n <= 0) return "قائمة الفروع غير صالحة";
  }
  for (const p of fiscalPeriodIds) {
    const n = Number(p);
    if (!Number.isInteger(n) || n <= 0) return "قائمة الفترات المالية غير صالحة";
  }
  // Disallow embedded prefix length pushing the formatted string beyond a
  // sane bound. Keeps DB indexes / printouts predictable.
  if ((prefix?.length ?? 0) + Math.max(pad, String(end).length) > 40)
    return "البادئة + طول الرقم تتجاوز الحد المسموح";
  // Optional dynamic month/year pattern: cap length defensively. Empty/null
  // is the legacy default and never validated. 32 chars is plenty for any
  // realistic combination of tokens + separators (e.g. "{YYYY}-{MM}-").
  const monthPattern = body?.monthPattern == null ? "" : String(body.monthPattern);
  if (monthPattern.length > 32)
    return "نمط الشهر/السنة طويل جداً (الحد الأقصى 32 حرفاً)";
  // Monthly reset MUST carry a month token in the pattern, otherwise the
  // counter would re-issue the same formatted number every month (e.g. PR-0001
  // in both January and February) and collide on the document-number unique
  // index. Require {MM} or {M} so each month produces a distinct stream.
  const monthlyReset = body?.monthlyReset === true || body?.monthlyReset === "true";
  if (monthlyReset && !/\{MM\}|\{M\}/.test(monthPattern))
    return "التصفير الشهري يتطلب إضافة كود الشهر {MM} أو {M} في نمط الشهر/السنة لتفادي تكرار الأرقام بين الشهور";
  return null;
}

// Augment a row with computed usage metrics for the UI.
function withUsage(r: any) {
  const used     = Math.max(0, (r.currentNumber ?? r.current_number) - (r.startNumber ?? r.start_number));
  const capacity = Math.max(1, (r.endNumber ?? r.end_number) - (r.startNumber ?? r.start_number) + 1);
  const usedPct  = Math.min(100, Math.round((used / capacity) * 100));
  return { ...r, usedCount: used, capacity, usedPct };
}

// ─── LIST ─────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(sequencesTable)
      .where(eq(sequencesTable.companyId, cid))
      .orderBy(asc(sequencesTable.code));
    res.json(rows.map(withUsage));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── KNOWN TX TYPES (for the multi-select) ────────────────────────────────────
router.get("/transaction-types", (_req, res) => {
  res.json(SEQUENCE_TX_TYPES);
});

// ─── GET ONE ──────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [row] = await db.select().from(sequencesTable)
      .where(and(eq(sequencesTable.id, id), eq(sequencesTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "المسلسل غير موجود" }); return; }
    res.json(withUsage(row));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── LOGS (paginated, last N) ─────────────────────────────────────────────────
router.get("/:id/logs", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id    = Number(req.params.id);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const rows = await db.select().from(sequenceLogsTable)
      .where(and(
        eq(sequenceLogsTable.sequenceId, id),
        eq(sequenceLogsTable.companyId, cid),
      ))
      .orderBy(desc(sequenceLogsTable.createdAt))
      .limit(limit);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Helper: ensure no OTHER active sequence in this company already binds any
// of the requested transaction types **within an overlapping fiscal-period
// scope**. The fiscal-period dimension lets a tenant run independent
// counters per year (FY2025 stays on old counter, FY2026 starts fresh), so
// two active sequences for the SAME tx-type are only in conflict when
// their period coverage truly overlaps:
//
//   • Both universal (empty fiscalPeriodIds) → CONFLICT
//       (both would claim every period — non-deterministic pick)
//   • One universal + one scoped               → ALLOWED
//       (the scoped one wins for its periods, universal covers the rest;
//        nextSequenceNumber orders scoped matches first)
//   • Both scoped, period sets disjoint        → ALLOWED
//       (each owns a distinct slice of the calendar)
//   • Both scoped, any shared period id        → CONFLICT
//
// `dbx` accepts either the global `db` or a transaction handle so callers
// can run the check + the subsequent write inside the same transaction
// (combined with the per-company advisory lock below) for atomic safety.
async function ensureNoTypeConflict(
  dbx: any,
  cid: number,
  types: string[],
  candidateFiscalPeriodIds: number[] | null | undefined,
  excludeId?: number,
): Promise<string | null> {
  if (!types.length) return null;
  const conflicts = await dbx.execute(sql`
    SELECT id, code, transaction_types, fiscal_period_ids
    FROM sequences
    WHERE company_id = ${cid}
      AND is_active = true
      ${excludeId ? sql`AND id <> ${excludeId}` : sql``}
      AND transaction_types ?| array[${sql.join(types.map((t: string) => sql`${t}`), sql`, `)}]
  `);
  const candidateSet = new Set((candidateFiscalPeriodIds ?? []).map(Number));
  const candidateUniversal = candidateSet.size === 0;
  for (const r of (conflicts.rows ?? []) as any[]) {
    const otherIdsRaw: unknown[] = Array.isArray(r.fiscal_period_ids) ? r.fiscal_period_ids : [];
    const otherIds: number[] = otherIdsRaw.map((x) => Number(x));
    const otherUniversal = otherIds.length === 0;
    if (candidateUniversal && otherUniversal) {
      return `الشاشة مرتبطة بالفعل بالمسلسل "${r.code}" (يغطي كل الفترات). قم بإلغاء تنشيطه، أو قَيِّد أحدهما بفترة مالية محددة.`;
    }
    if (!candidateUniversal && !otherUniversal) {
      const overlap = otherIds.some(id => candidateSet.has(id));
      if (overlap) {
        return `الشاشة مرتبطة بالفعل بالمسلسل "${r.code}" في فترة مالية متداخلة. اختر فترات مالية مختلفة لكل مسلسل.`;
      }
    }
    // universal × scoped → allowed; scoped wins for its periods.
  }
  return null;
}

// Two distinct advisory-lock keys (company-scoped). pg_advisory_xact_lock(int, int)
// uses the first arg as a "namespace" so we can never collide with other
// features that also use advisory locks keyed only by companyId.
//   1001 = sequences-table mutation lock (create / update / activate / reset)
const SEQ_LOCK_NS = 1001;

// ─── CREATE ───────────────────────────────────────────────────────────────────
router.post("/", audit("sequences", "create"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const err = validatePayload(req.body); if (err) { res.status(400).json({ error: err }); return; }

    const isActive = req.body.isActive ?? true;
    const start    = Number(req.body.startNumber);

    // Run the conflict check + uniqueness check + insert under a per-company
    // advisory lock so two concurrent admin requests cannot both pass the
    // "no other active sequence binds this tx-type" check and create
    // overlapping active sequences.
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEQ_LOCK_NS}, ${cid})`);

      // Normalize the candidate's fiscal period ids ONCE so the conflict
      // check and the insert use the exact same set (dedupe + integer cast).
      const candidatePeriodIds: number[] = Array.isArray(req.body.fiscalPeriodIds)
        ? Array.from(new Set<number>(req.body.fiscalPeriodIds.map((x: any) => Number(x))))
        : [];

      if (isActive) {
        const conflict = await ensureNoTypeConflict(tx, cid, req.body.transactionTypes, candidatePeriodIds);
        if (conflict) return { status: 409, body: { error: conflict } };
      }

      const [dup] = await tx.select().from(sequencesTable)
        .where(and(eq(sequencesTable.companyId, cid), eq(sequencesTable.code, String(req.body.code).trim())));
      if (dup) return { status: 409, body: { error: "الكود مستخدم بالفعل" } };

      const [row] = await tx.insert(sequencesTable).values({
        companyId:        cid,
        code:             String(req.body.code).trim(),
        nameAr:           String(req.body.nameAr).trim(),
        nameEn:           req.body.nameEn ? String(req.body.nameEn).trim() : null,
        prefix:           String(req.body.prefix ?? ""),
        // Optional dynamic month/year pattern inserted between prefix and the
        // running number at issuance time. NULL / empty string both mean
        // "legacy behaviour" (prefix + padded number, no month).
        monthPattern:     req.body.monthPattern ? String(req.body.monthPattern) : null,
        startNumber:      start,
        endNumber:        Number(req.body.endNumber),
        currentNumber:    req.body.currentNumber == null ? start : Number(req.body.currentNumber),
        padLength:        Number(req.body.padLength ?? 4),
        isActive,
        // Monthly reset toggle: restart the running counter at startNumber at
        // the beginning of each calendar month. Defaults to false (legacy
        // continuous numbering) when the client omits it.
        monthlyReset:     !!req.body.monthlyReset,
        transactionTypes: req.body.transactionTypes,
        // Normalize: dedupe + coerce to int. validatePayload already
        // rejected non-positive entries.
        branchIds: Array.isArray(req.body.branchIds)
          ? Array.from(new Set(req.body.branchIds.map((x: any) => Number(x))))
          : [],
        fiscalPeriodIds: candidatePeriodIds,
      }).returning();
      return { status: 201, body: withUsage(row) };
    });

    res.status(result.status).json(result.body);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── SEED PER-PAYMENT-METHOD SPLIT SERIES ─────────────────────────────────────
// POST /api/sequences/seed-payment-split
// One-click helper that creates the OPT-IN per-payment-method numbering series
// (sales/purchase invoices: نقدي/آجل/بنكي ; vouchers: نقدي/بنكي) with sensible
// default prefixes. Fully idempotent: a sub-type that already has an ACTIVE
// sequence is skipped, so re-running never duplicates. Codes are made unique
// per company. The user can freely edit prefix/start/padding afterwards from
// the normal sequence editor.
const SPLIT_DEFAULTS: ReadonlyArray<{ type: string; code: string; nameAr: string; nameEn: string; prefix: string }> = [
  { type: "sales_invoice_cash",     code: "SINV-CASH",   nameAr: "فاتورة مبيعات - نقدي",   nameEn: "Sales Invoice - Cash",      prefix: "SC-"  },
  { type: "sales_invoice_credit",   code: "SINV-CREDIT", nameAr: "فاتورة مبيعات - آجل",    nameEn: "Sales Invoice - Credit",    prefix: "SA-"  },
  { type: "sales_invoice_bank",     code: "SINV-BANK",   nameAr: "فاتورة مبيعات - بنكي",   nameEn: "Sales Invoice - Bank",      prefix: "SB-"  },
  { type: "purchase_invoice_cash",  code: "PINV-CASH",   nameAr: "فاتورة مشتريات - نقدي",  nameEn: "Purchase Invoice - Cash",   prefix: "PC-"  },
  { type: "purchase_invoice_credit",code: "PINV-CREDIT", nameAr: "فاتورة مشتريات - آجل",   nameEn: "Purchase Invoice - Credit", prefix: "PA-"  },
  { type: "purchase_invoice_bank",  code: "PINV-BANK",   nameAr: "فاتورة مشتريات - بنكي",  nameEn: "Purchase Invoice - Bank",   prefix: "PB-"  },
  { type: "receipt_voucher_cash",   code: "RV-CASH",     nameAr: "سند قبض - نقدي",         nameEn: "Receipt Voucher - Cash",    prefix: "RC-"  },
  { type: "receipt_voucher_bank",   code: "RV-BANK",     nameAr: "سند قبض - بنكي",         nameEn: "Receipt Voucher - Bank",    prefix: "RB-"  },
  { type: "payment_voucher_cash",   code: "PV-CASH",     nameAr: "سند صرف - نقدي",         nameEn: "Payment Voucher - Cash",    prefix: "PYC-" },
  { type: "payment_voucher_bank",   code: "PV-BANK",     nameAr: "سند صرف - بنكي",         nameEn: "Payment Voucher - Bank",    prefix: "PYB-" },
];

router.post("/seed-payment-split", audit("sequences", "create"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;

    const result = await db.transaction(async (tx) => {
      // Serialize against concurrent create/seed so two admins can't both pass
      // the "no active sequence for this sub-type" check and double-insert.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEQ_LOCK_NS}, ${cid})`);

      // Snapshot existing codes once so we can mint unique ones in-memory.
      const existing = await tx.select({ code: sequencesTable.code })
        .from(sequencesTable).where(eq(sequencesTable.companyId, cid));
      const usedCodes = new Set(existing.map(r => String(r.code)));
      const uniqueCode = (base: string): string => {
        if (!usedCodes.has(base)) { usedCodes.add(base); return base; }
        for (let i = 2; ; i++) {
          const c = `${base}-${i}`;
          if (!usedCodes.has(c)) { usedCodes.add(c); return c; }
        }
      };

      const created: string[] = [];
      const skipped: string[] = [];
      for (const d of SPLIT_DEFAULTS) {
        // Idempotent: skip sub-types that already have an ACTIVE sequence.
        const dup = await tx.execute<{ id: number }>(sql`
          SELECT id FROM sequences
          WHERE company_id = ${cid} AND is_active = true AND transaction_types ? ${d.type}
          LIMIT 1
        `);
        if (dup.rows?.length) { skipped.push(d.type); continue; }

        await tx.insert(sequencesTable).values({
          companyId:        cid,
          code:             uniqueCode(d.code),
          nameAr:           d.nameAr,
          nameEn:           d.nameEn,
          prefix:           d.prefix,
          monthPattern:     null,
          startNumber:      1,
          endNumber:        999999,
          currentNumber:    1,
          padLength:        4,
          isActive:         true,
          monthlyReset:     false,
          transactionTypes: [d.type],
          branchIds:        [],
          fiscalPeriodIds:  [],
        });
        created.push(d.type);
      }
      return { created, skipped };
    });

    res.status(201).json({ ...result, createdCount: result.created.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────
router.patch("/:id", audit("sequences", "edit"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    // Same per-company advisory lock as CREATE so we can't race when two
    // admins simultaneously toggle two sequences active for the same tx-type.
    // ALSO: lock the target row with FOR UPDATE so we serialize against the
    // issuance path (`nextSequenceNumber` also takes FOR UPDATE on this row).
    // Without this, PATCH could read a stale `currentNumber`, validate
    // invariants against it, then overwrite a newer value written by an
    // in-flight issuance — re-enabling duplicate document numbers.
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEQ_LOCK_NS}, ${cid})`);

      const lockedRows = await tx.execute(sql`
        SELECT * FROM sequences
        WHERE id = ${id} AND company_id = ${cid}
        FOR UPDATE
      `);
      const lockedValue = (lockedRows as { rows?: unknown }).rows ?? lockedRows;
      const lockedArr = (Array.isArray(lockedValue) ? lockedValue : []) as Array<Record<string, unknown>>;
      const existing = lockedArr[0];
      if (!existing) return { status: 404, body: { error: "المسلسل غير موجود" } };
      existing.startNumber   = existing.start_number   ?? existing.startNumber;
      existing.endNumber     = existing.end_number     ?? existing.endNumber;
      existing.currentNumber = existing.current_number ?? existing.currentNumber;
      existing.padLength     = existing.pad_length     ?? existing.padLength;
      existing.isActive      = existing.is_active      ?? existing.isActive;
      existing.transactionTypes = existing.transaction_types ?? existing.transactionTypes;
      existing.monthlyReset  = existing.monthly_reset  ?? existing.monthlyReset ?? false;
      existing.branchIds     = existing.branch_ids     ?? existing.branchIds ?? [];
      existing.fiscalPeriodIds = existing.fiscal_period_ids ?? existing.fiscalPeriodIds ?? [];
      existing.nameAr        = existing.name_ar        ?? existing.nameAr;
      existing.nameEn        = existing.name_en        ?? existing.nameEn;
      existing.monthPattern  = existing.month_pattern  ?? existing.monthPattern ?? null;

      // monthPattern is OPTIONAL: an explicit empty string from the client
      // means "clear the pattern", so we only fall back to the existing
      // value when the field is undefined (omitted) — not when it's "".
      const monthPatternIn = req.body.monthPattern;
      const mergedMonthPattern = monthPatternIn === undefined
        ? existing.monthPattern
        : (monthPatternIn ? String(monthPatternIn) : null);

      const merged = {
        code:             req.body.code             ?? existing.code,
        nameAr:           req.body.nameAr           ?? existing.nameAr,
        nameEn:           req.body.nameEn           ?? existing.nameEn,
        prefix:           req.body.prefix           ?? existing.prefix,
        monthPattern:     mergedMonthPattern,
        startNumber:      req.body.startNumber      ?? existing.startNumber,
        endNumber:        req.body.endNumber        ?? existing.endNumber,
        currentNumber:    req.body.currentNumber    ?? existing.currentNumber,
        padLength:        req.body.padLength        ?? existing.padLength,
        isActive:         req.body.isActive         ?? existing.isActive,
        monthlyReset:     req.body.monthlyReset     ?? existing.monthlyReset,
        transactionTypes: req.body.transactionTypes ?? existing.transactionTypes,
        branchIds:        req.body.branchIds        ?? existing.branchIds,
        fiscalPeriodIds:  req.body.fiscalPeriodIds  ?? existing.fiscalPeriodIds,
      };
      const err = validatePayload(merged);
      if (err) return { status: 400, body: { error: err } };

      // ── Integrity guard: once a sequence has issued at least one number,
      // the fields that determine the SHAPE of every issued document number
      // become immutable. Allowing edits here would let an admin re-issue a
      // previously-used number — a business-critical violation of audit /
      // numbering integrity.
      //
      // Post per-branch upgrade: the master `currentNumber` is no longer
      // moved during issuance (each branch has its own counter). The
      // canonical "has this sequence ever issued?" signal is therefore
      // `sequence_logs` — an append-only audit row is written for every
      // issuance regardless of which branch counter advanced.
      //
      // We also derive `highWaterMark` = MAX(per-branch currentNumber) so
      // raise-only checks on currentNumber/endNumber still protect against
      // shrinking past any branch's issued number.
      // Mutable while in use: name, isActive, endNumber (raise only),
      //                       currentNumber (raise only), transactionTypes.
      const usedRows = await tx.execute<{ used: boolean; high: number | null }>(sql`
        SELECT
          EXISTS(
            SELECT 1 FROM sequence_logs
            WHERE sequence_id = ${id} AND transaction_type <> '__reset__'
          ) AS used,
          (SELECT MAX(current_number) FROM sequence_counters WHERE sequence_id = ${id}) AS high
      `);
      const isUsed = !!usedRows.rows?.[0]?.used;
      // Per-branch counter holds the NEXT number to issue, so the highest
      // already-issued number is `high - 1`. Fall back to the master's
      // currentNumber for the legacy/no-counters path so the comparison is
      // never against NULL.
      const highWaterMark = (usedRows.rows?.[0]?.high ?? Number(existing.currentNumber)) - 1;
      if (isUsed) {
        if (Number(merged.startNumber) !== existing.startNumber) {
          return { status: 409, body: { error: "لا يمكن تعديل رقم البداية لمسلسل تم استخدامه" } };
        }
        if (String(merged.prefix ?? "") !== (existing.prefix ?? "")) {
          return { status: 409, body: { error: "لا يمكن تعديل البادئة لمسلسل تم استخدامه — أنشئ مسلسلاً جديداً بدلاً من ذلك" } };
        }
        if (Number(merged.padLength) !== existing.padLength) {
          return { status: 409, body: { error: "لا يمكن تعديل طول التعبئة بالأصفار لمسلسل تم استخدامه" } };
        }
        // currentNumber on master is now a display-only seed for new branch
        // counters; we still forbid lowering it below any branch's high
        // water mark to prevent surprise reuse on a freshly-created branch.
        if (Number(merged.currentNumber) <= highWaterMark) {
          return { status: 409, body: { error: "لا يمكن تخفيض الرقم الحالي لمسلسل مُستخدم — قد يؤدي إلى تكرار أرقام صادرة سابقاً" } };
        }
        if (Number(merged.endNumber) < highWaterMark) {
          return { status: 409, body: { error: "رقم النهاية يجب أن يكون أكبر من أو يساوي آخر رقم صادر" } };
        }
      }

      // Normalize the merged candidate set ONCE so the conflict check and
      // the UPDATE write see the exact same array — otherwise an admin could
      // pass duplicates that slip past the overlap check but reach the row.
      const mergedPeriodIds: number[] = Array.isArray(merged.fiscalPeriodIds)
        ? Array.from(new Set<number>((merged.fiscalPeriodIds as any[]).map((x) => Number(x))))
        : [];

      if (merged.isActive) {
        const conflict = await ensureNoTypeConflict(
          tx, cid, merged.transactionTypes as string[], mergedPeriodIds, id,
        );
        if (conflict) return { status: 409, body: { error: conflict } };
      }

      if (merged.code !== existing.code) {
        const [dup] = await tx.select().from(sequencesTable)
          .where(and(eq(sequencesTable.companyId, cid), eq(sequencesTable.code, String(merged.code).trim())));
        if (dup) return { status: 409, body: { error: "الكود مستخدم بالفعل" } };
      }

      const [row] = await tx.update(sequencesTable).set({
        code:             String(merged.code).trim(),
        nameAr:           String(merged.nameAr).trim(),
        nameEn:           merged.nameEn || null,
        prefix:           String(merged.prefix ?? ""),
        monthPattern:     merged.monthPattern ? String(merged.monthPattern) : null,
        startNumber:      Number(merged.startNumber),
        endNumber:        Number(merged.endNumber),
        currentNumber:    Number(merged.currentNumber),
        padLength:        Number(merged.padLength),
        isActive:         !!merged.isActive,
        monthlyReset:     !!merged.monthlyReset,
        transactionTypes: merged.transactionTypes,
        // Same dedupe-and-coerce normalization as CREATE keeps the column
        // shape stable regardless of which path wrote it.
        branchIds: Array.isArray(merged.branchIds)
          ? Array.from(new Set((merged.branchIds as any[]).map((x) => Number(x))))
          : [],
        fiscalPeriodIds: mergedPeriodIds,
        updatedAt:        new Date(),
      }).where(and(eq(sequencesTable.id, id), eq(sequencesTable.companyId, cid))).returning();
      return { status: 200, body: withUsage(row) };
    });

    res.status(result.status).json(result.body);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── RESET ────────────────────────────────────────────────────────────────────
// Resets the sequence back to startNumber. Destructive — would allow number
// reuse — so it requires both admin role AND, if the sequence has ever
// issued a number (per `sequence_logs`), an explicit `acknowledgeReuse: true`
// flag in the body so the operator opts in to the reuse risk.
//
// Per-branch model: issuance lives in `sequence_counters`, not in
// `sequences.current_number`. Resetting therefore wipes ALL per-branch
// counter rows for this sequence, so each branch will re-seed at
// `start_number` on its next issuance (matching a "factory reset" of the
// numbering stream). Master `sequences.current_number` is also rewound to
// `start_number` to keep the legacy/preview field aligned and to preserve
// the migration-seed heuristic for branches added after the reset.
//
// Logged as a synthetic __reset__ event and audit-tagged.
router.post("/:id/reset", audit("sequences", "edit"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    // All work runs inside one transaction so:
    //   (a) `SELECT ... FOR UPDATE` blocks any concurrent issuance from
    //       slipping a new number in after we read `isUsed` but before we
    //       wipe the counters — without this lock, a concurrent POST could
    //       bypass the acknowledgeReuse opt-in;
    //   (b) the synthetic __reset__ log row is committed atomically with
    //       the counter wipe, so we never have a numbering change without
    //       a paired audit entry.
    const result = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`
        SELECT * FROM sequences
        WHERE id = ${id} AND company_id = ${cid}
        FOR UPDATE
      `);
      const lockedValue = (lockedRows as { rows?: unknown }).rows ?? lockedRows;
      const lockedArr = (Array.isArray(lockedValue) ? lockedValue : []) as Array<Record<string, unknown>>;
      const existing = lockedArr[0];
      if (!existing) return { status: 404, body: { error: "المسلسل غير موجود" } };
      const startNumber = Number(existing.start_number ?? existing.startNumber);

      // "Used" is now driven by audit history (real issuance footprint),
      // not by master.current_number — which under the per-branch model is
      // never bumped during issuance and would always look "unused".
      // Filter out our own __reset__ rows so a previous reset doesn't
      // permanently force the acknowledgeReuse prompt on every later reset.
      const usedRows = await tx.execute<{ used: boolean }>(sql`
        SELECT EXISTS(
          SELECT 1 FROM sequence_logs
          WHERE sequence_id = ${id}
            AND transaction_type <> '__reset__'
        ) AS used
      `);
      const isUsed = !!usedRows.rows?.[0]?.used;
      if (isUsed && req.body?.acknowledgeReuse !== true) {
        return {
          status: 409,
          body: {
            error: "هذا المسلسل أصدر أرقاماً سابقاً. التصفير سيؤدي إلى احتمال تكرار أرقام صادرة. أكّد إعادة الاستخدام صراحةً للمتابعة.",
            requiresAcknowledgement: true,
          },
        };
      }

      // Wipe per-branch counters so every branch re-seeds at start_number on
      // its next issuance (independent streams, factory-reset semantics).
      await tx.execute(sql`DELETE FROM sequence_counters WHERE sequence_id = ${id}`);

      // Rewind master too. Keeps the displayed currentNumber aligned and
      // resets the migration-seed heuristic so the FIRST counter created
      // after the reset starts from start_number (not from a stale value).
      const [row] = await tx.update(sequencesTable).set({
        currentNumber: startNumber,
        updatedAt:     new Date(),
      }).where(and(eq(sequencesTable.id, id), eq(sequencesTable.companyId, cid))).returning();

      await tx.insert(sequenceLogsTable).values({
        sequenceId:      id,
        companyId:       cid,
        transactionType: "__reset__",
        generatedNumber: `reset → ${startNumber}`,
        userId:          (req as any).authUser?.id ?? null,
        refTable:        null,
        refId:           null,
      });
      return { status: 200, body: withUsage(row) };
    });

    res.status(result.status).json(result.body);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE ───────────────────────────────────────────────────────────────────
// Only allowed when the sequence has not yet issued any number AND has no log
// entries. Once used, sequences must be deactivated (isActive=false) instead
// of deleted so historical references stay intact.
router.delete("/:id", audit("sequences", "delete"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const result = await db.transaction(async (tx) => {
      const lockedExec = await tx.execute<{ id: number; startNumber: number; currentNumber: number }>(sql`
        SELECT id, start_number AS "startNumber", current_number AS "currentNumber"
        FROM sequences
        WHERE id = ${id} AND company_id = ${cid}
        FOR UPDATE
      `);
      const lockedValue = (lockedExec as { rows?: unknown }).rows ?? lockedExec;
      const lockedRows = (Array.isArray(lockedValue) ? lockedValue : []) as Array<{ id: number; startNumber: number; currentNumber: number }>;
      const existing = lockedRows[0];
      if (!existing) return { status: 404, body: { error: "المسلسل غير موجود" } };
      if (Number(existing.currentNumber) !== Number(existing.startNumber)) {
        return { status: 400, body: { error: "لا يمكن حذف مسلسل تم استخدامه — قم بإلغاء تنشيطه بدلاً من ذلك" } };
      }
      const logExec = await tx.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text AS count FROM sequence_logs WHERE sequence_id = ${id}
      `);
      const logValue = (logExec as { rows?: unknown }).rows ?? logExec;
      const logRows = (Array.isArray(logValue) ? logValue : []) as Array<{ count: string }>;
      if (Number(logRows[0]?.count ?? 0) > 0) {
        return { status: 400, body: { error: "لا يمكن حذف مسلسل له سجل عمليات — قم بإلغاء تنشيطه بدلاً من ذلك" } };
      }
      await tx.delete(sequencesTable).where(and(eq(sequencesTable.id, id), eq(sequencesTable.companyId, cid)));
      return { status: 200, body: { ok: true } };
    });
    res.status(result.status).json(result.body);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
