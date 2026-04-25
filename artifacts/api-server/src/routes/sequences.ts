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

function fmt(prefix: string | null | undefined, n: number, padLength: number | null | undefined): string {
  const pad = padLength ?? 0;
  const padded = pad > 0 ? String(n).padStart(pad, "0") : String(n);
  return `${prefix ?? ""}${padded}`;
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

  const rows = await db.execute<{
    id: number;
    prefix: string | null; start_number: number; current_number: number;
    end_number: number; pad_length: number | null; code: string;
  }>(sql`
    SELECT id, prefix, start_number, current_number, end_number, pad_length, code
    FROM sequences
    WHERE company_id = ${cid}
      AND is_active = true
      AND transaction_types ? ${txType}
    ORDER BY id ASC
    LIMIT 1
  `);
  const seq = rows.rows?.[0];
  if (!seq) { res.json({ number: null, hasSequence: false }); return; }

  // Pull the per-branch counter (if any) and an "any counter exists?" flag in
  // a single round-trip. The flag drives the seeding heuristic for the case
  // where this branch has no counter yet.
  const counterRows = await db.execute<{
    branch_current: number | null; any_exists: boolean;
  }>(sql`
    SELECT
      (SELECT current_number FROM sequence_counters
        WHERE sequence_id = ${seq.id} AND branch_id = ${branchKey}) AS branch_current,
      EXISTS(SELECT 1 FROM sequence_counters WHERE sequence_id = ${seq.id}) AS any_exists
  `);
  const cRow = counterRows.rows?.[0];
  const branchCurrent = cRow?.branch_current ?? null;
  const anyExists     = !!cRow?.any_exists;

  const previewNumber = branchCurrent != null
    ? branchCurrent
    : (anyExists ? seq.start_number : Math.max(seq.start_number, seq.current_number));

  const exhausted = previewNumber > seq.end_number;
  res.json({
    number: exhausted ? null : fmt(seq.prefix, previewNumber, seq.pad_length),
    hasSequence: true,
    sequenceCode: seq.code,
    branchId: branchKey,
    exhausted,
  });
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
  // Disallow embedded prefix length pushing the formatted string beyond a
  // sane bound. Keeps DB indexes / printouts predictable.
  if ((prefix?.length ?? 0) + Math.max(pad, String(end).length) > 40)
    return "البادئة + طول الرقم تتجاوز الحد المسموح";
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
// of the requested transaction types. Prevents two competing counters for
// the same screen — the helper would non-deterministically pick one and
// users would see number jumps.
//
// `dbx` accepts either the global `db` or a transaction handle so callers
// can run the check + the subsequent write inside the same transaction
// (combined with the per-company advisory lock below) for atomic safety.
async function ensureNoTypeConflict(
  dbx: any, cid: number, types: string[], excludeId?: number,
): Promise<string | null> {
  if (!types.length) return null;
  const conflicts = await dbx.execute(sql`
    SELECT id, code, transaction_types
    FROM sequences
    WHERE company_id = ${cid}
      AND is_active = true
      ${excludeId ? sql`AND id <> ${excludeId}` : sql``}
      AND transaction_types ?| array[${sql.join(types.map((t: string) => sql`${t}`), sql`, `)}]
  `);
  const r = conflicts.rows?.[0] as any;
  if (!r) return null;
  return `الشاشة مرتبطة بالفعل بالمسلسل "${r.code}". قم بإلغاء تنشيطه أولاً أو ربط الشاشة منه.`;
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

      if (isActive) {
        const conflict = await ensureNoTypeConflict(tx, cid, req.body.transactionTypes);
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
        startNumber:      start,
        endNumber:        Number(req.body.endNumber),
        currentNumber:    req.body.currentNumber == null ? start : Number(req.body.currentNumber),
        padLength:        Number(req.body.padLength ?? 4),
        isActive,
        transactionTypes: req.body.transactionTypes,
      }).returning();
      return { status: 201, body: withUsage(row) };
    });

    res.status(result.status).json(result.body);
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
      existing.nameAr        = existing.name_ar        ?? existing.nameAr;
      existing.nameEn        = existing.name_en        ?? existing.nameEn;

      const merged = {
        code:             req.body.code             ?? existing.code,
        nameAr:           req.body.nameAr           ?? existing.nameAr,
        nameEn:           req.body.nameEn           ?? existing.nameEn,
        prefix:           req.body.prefix           ?? existing.prefix,
        startNumber:      req.body.startNumber      ?? existing.startNumber,
        endNumber:        req.body.endNumber        ?? existing.endNumber,
        currentNumber:    req.body.currentNumber    ?? existing.currentNumber,
        padLength:        req.body.padLength        ?? existing.padLength,
        isActive:         req.body.isActive         ?? existing.isActive,
        transactionTypes: req.body.transactionTypes ?? existing.transactionTypes,
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

      if (merged.isActive) {
        const conflict = await ensureNoTypeConflict(tx, cid, merged.transactionTypes as string[], id);
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
        startNumber:      Number(merged.startNumber),
        endNumber:        Number(merged.endNumber),
        currentNumber:    Number(merged.currentNumber),
        padLength:        Number(merged.padLength),
        isActive:         !!merged.isActive,
        transactionTypes: merged.transactionTypes,
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
