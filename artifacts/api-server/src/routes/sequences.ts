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
// Sequences management is admin-only at every level (sidebar, route, perm).
router.use(requireAdminRole);
router.use(audit("sequences", "view"));

const TX_SET = new Set<string>(SEQUENCE_TX_TYPES);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

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
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEQ_LOCK_NS}, ${cid})`);

      const [existing] = await tx.select().from(sequencesTable)
        .where(and(eq(sequencesTable.id, id), eq(sequencesTable.companyId, cid)));
      if (!existing) return { status: 404, body: { error: "المسلسل غير موجود" } };

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
// Resets currentNumber back to startNumber. Destructive — could allow number
// reuse — so it's gated to admin and explicitly logged.
router.post("/:id/reset", audit("sequences", "edit"), async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [existing] = await db.select().from(sequencesTable)
      .where(and(eq(sequencesTable.id, id), eq(sequencesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "المسلسل غير موجود" }); return; }

    const [row] = await db.update(sequencesTable).set({
      currentNumber: existing.startNumber,
      updatedAt:     new Date(),
    }).where(and(eq(sequencesTable.id, id), eq(sequencesTable.companyId, cid))).returning();

    // Log the reset as a synthetic entry so admins can see who reset and when.
    await db.insert(sequenceLogsTable).values({
      sequenceId:      id,
      companyId:       cid,
      transactionType: "__reset__",
      generatedNumber: `reset → ${existing.startNumber}`,
      userId:          (req as any).authUser?.id ?? null,
      refTable:        null,
      refId:           null,
    });
    res.json(withUsage(row));
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
    const [existing] = await db.select().from(sequencesTable)
      .where(and(eq(sequencesTable.id, id), eq(sequencesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "المسلسل غير موجود" }); return; }
    if (existing.currentNumber !== existing.startNumber) {
      res.status(400).json({ error: "لا يمكن حذف مسلسل تم استخدامه — قم بإلغاء تنشيطه بدلاً من ذلك" });
      return;
    }
    const [{ count }] = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM sequence_logs WHERE sequence_id = ${id}
    `).then((r: any) => r.rows ?? r);
    if (Number(count) > 0) {
      res.status(400).json({ error: "لا يمكن حذف مسلسل له سجل عمليات — قم بإلغاء تنشيطه بدلاً من ذلك" });
      return;
    }
    await db.delete(sequencesTable).where(and(eq(sequencesTable.id, id), eq(sequencesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
