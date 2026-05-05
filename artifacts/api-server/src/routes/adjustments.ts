import { Router } from "express";
import { db } from "@workspace/db";
import {
  accountingAdjustmentsTable, accountingAdjustmentRunsTable,
  accountsTable, journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { and, eq, asc, desc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { assertWritableForDate } from "../lib/periodGuard.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("accounts"));
router.use(moduleAudit("accounts"));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
function isISO(s: any): s is string {
  if (typeof s !== "string") return false;
  const m = ISO.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// ─── Helpers: month iteration over a [start, end] date range ─────────────
const pad = (n: number) => String(n).padStart(2, "0");
const ymOf = (iso: string) => iso.slice(0, 7);
const lastDayUTC = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
function* monthsBetween(startISO: string, endISO: string): Generator<{ ym: string; isoDate: string }> {
  const [sy, sm] = startISO.split("-").map(Number);
  const [ey, em] = endISO.split("-").map(Number);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    const ym = `${y}-${pad(m)}`;
    // Use the last day of the month as the canonical entry date — this is
    // what most accounting policies expect for adjustment recognition.
    const isoDate = `${y}-${pad(m)}-${pad(lastDayUTC(y, m - 1))}`;
    yield { ym, isoDate };
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
}

// ─── GET /api/adjustments — list all adjustments for the company ─────────
router.get("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(accountingAdjustmentsTable)
      .where(eq(accountingAdjustmentsTable.companyId, cid))
      .orderBy(desc(accountingAdjustmentsTable.createdAt));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message ?? "خطأ" }); }
});

// ─── GET /api/adjustments/:id — single adjustment + its run history ──────
router.get("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const [row] = await db.select().from(accountingAdjustmentsTable)
      .where(and(eq(accountingAdjustmentsTable.id, id), eq(accountingAdjustmentsTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "التسوية غير موجودة" }); return; }

    const runs = await db.select().from(accountingAdjustmentRunsTable)
      .where(eq(accountingAdjustmentRunsTable.adjustmentId, id))
      .orderBy(asc(accountingAdjustmentRunsTable.periodMonth));
    res.json({ adjustment: row, runs });
  } catch (e: any) { res.status(500).json({ error: e.message ?? "خطأ" }); }
});

async function validateAccounts(cid: number, expenseId: number, contraId: number) {
  const accs = await db.select().from(accountsTable).where(eq(accountsTable.companyId, cid));
  const byId = new Map(accs.map(a => [a.id, a]));
  const exp = byId.get(expenseId);
  const ctr = byId.get(contraId);
  if (!exp) throw new Error("الحساب المصروف غير موجود في هذه الشركة");
  if (!ctr) throw new Error("الحساب المقابل غير موجود في هذه الشركة");
  if (!exp.isPosting) throw new Error("الحساب المصروف يجب أن يكون حساب ترحيل (ليس رئيسي)");
  if (!ctr.isPosting) throw new Error("الحساب المقابل يجب أن يكون حساب ترحيل (ليس رئيسي)");
  return { exp, ctr };
}

// ─── POST /api/adjustments — create a new adjustment ─────────────────────
router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { type, name, expenseAccountId, contraAccountId, totalAmount, startDate, endDate, autoGenerate, notes } = req.body ?? {};

    if (!["prepaid", "accrued"].includes(type)) {
      res.status(400).json({ error: "نوع التسوية غير صالح (prepaid/accrued فقط)" }); return;
    }
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "اسم التسوية مطلوب" }); return;
    }
    if (!isISO(startDate) || !isISO(endDate)) {
      res.status(400).json({ error: "تواريخ البداية والنهاية مطلوبة (YYYY-MM-DD)" }); return;
    }
    if (endDate < startDate) {
      res.status(400).json({ error: "تاريخ النهاية يجب أن يكون بعد البداية" }); return;
    }
    const total = Number(totalAmount);
    if (!Number.isFinite(total) || total <= 0) {
      res.status(400).json({ error: "المبلغ الإجمالي يجب أن يكون رقم موجب" }); return;
    }
    const expId = Number(expenseAccountId);
    const ctrId = Number(contraAccountId);
    if (!Number.isFinite(expId) || !Number.isFinite(ctrId) || expId === ctrId) {
      res.status(400).json({ error: "حسابا المصروف والمقابل مطلوبان ويجب أن يكونا مختلفين" }); return;
    }
    try { await validateAccounts(cid, expId, ctrId); }
    catch (e: any) { res.status(400).json({ error: e.message }); return; }

    // monthly amount = total / number of full months in [start, end]
    let months = 0;
    for (const _ of monthsBetween(startDate, endDate)) months++;
    if (months <= 0) { res.status(400).json({ error: "لا توجد أشهر كافية بين التاريخين" }); return; }
    const monthlyAmount = (total / months).toFixed(2);

    const [created] = await db.insert(accountingAdjustmentsTable).values({
      companyId:        cid,
      type,
      name:             name.trim(),
      expenseAccountId: expId,
      contraAccountId:  ctrId,
      totalAmount:      String(total),
      startDate, endDate,
      monthlyAmount,
      autoGenerate:     autoGenerate !== false,
      status:           "active",
      notes:            notes || null,
    }).returning();

    res.status(201).json(created);
  } catch (e: any) { res.status(500).json({ error: "فشل إنشاء التسوية: " + (e.message ?? "خطأ") }); }
});

// ─── PUT /api/adjustments/:id — update adjustment metadata ───────────────
router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const { name, autoGenerate, status, notes } = req.body ?? {};

    const patch: any = { updatedAt: new Date() };
    if (typeof name === "string" && name.trim()) patch.name = name.trim();
    if (typeof autoGenerate === "boolean") patch.autoGenerate = autoGenerate;
    if (status && ["active", "completed", "cancelled"].includes(status)) patch.status = status;
    if (typeof notes === "string" || notes === null) patch.notes = notes;

    const [updated] = await db.update(accountingAdjustmentsTable).set(patch)
      .where(and(eq(accountingAdjustmentsTable.id, id), eq(accountingAdjustmentsTable.companyId, cid)))
      .returning();
    if (!updated) { res.status(404).json({ error: "التسوية غير موجودة" }); return; }
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /api/adjustments/:id — delete (only if no runs) ──────────────
router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const runs = await db.select({ id: accountingAdjustmentRunsTable.id })
      .from(accountingAdjustmentRunsTable)
      .where(eq(accountingAdjustmentRunsTable.adjustmentId, id));
    if (runs.length > 0) {
      res.status(400).json({ error: `لا يمكن حذف تسوية لها ${runs.length} قيد مولّد — قم بإلغائها بدلاً من الحذف` });
      return;
    }

    const r = await db.delete(accountingAdjustmentsTable)
      .where(and(eq(accountingAdjustmentsTable.id, id), eq(accountingAdjustmentsTable.companyId, cid)))
      .returning();
    if (r.length === 0) { res.status(404).json({ error: "التسوية غير موجودة" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/adjustments/:id/generate — generate the monthly journal
 * entries for an adjustment. Idempotent: skips months that already have a
 * run row. Stops if any target month falls in a closed period.
 *
 * Bookkeeping per month:
 *   prepaid   →   Expense (Dr)       to  Prepaid asset (Cr)   monthlyAmount
 *   accrued   →   Expense (Dr)       to  Accrued liability(Cr) monthlyAmount
 *
 * In both cases the *expenseAccountId* is debited and the *contraAccountId*
 * is credited — the only distinction between the two types is conceptual
 * (which side of the BS the contra account lives on).
 */
router.post("/:id/generate", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const [adj] = await db.select().from(accountingAdjustmentsTable)
      .where(and(eq(accountingAdjustmentsTable.id, id), eq(accountingAdjustmentsTable.companyId, cid)));
    if (!adj) { res.status(404).json({ error: "التسوية غير موجودة" }); return; }
    if (adj.status !== "active") {
      res.status(400).json({ error: `لا يمكن توليد قيود لتسوية بحالة ${adj.status}` });
      return;
    }

    // Pull existing runs to skip already-generated months
    const existingRuns = await db.select({ ym: accountingAdjustmentRunsTable.periodMonth })
      .from(accountingAdjustmentRunsTable).where(eq(accountingAdjustmentRunsTable.adjustmentId, id));
    const generated = new Set(existingRuns.map(r => r.ym));

    const skipped: { ym: string; reason: string }[] = [];
    const created: { ym: string; entryId: number }[] = [];
    const monthly = adj.monthlyAmount;

    for (const { ym, isoDate } of monthsBetween(adj.startDate, adj.endDate)) {
      if (generated.has(ym)) continue;

      const writability = await assertWritableForDate(cid, isoDate);
      if (!writability.ok) {
        skipped.push({ ym, reason: writability.reason });
        continue;
      }

      const [entry] = await db.insert(journalEntriesTable).values({
        companyId:   cid,
        entryDate:   isoDate,
        description: `${adj.type === "prepaid" ? "تسوية مصروف مقدم" : "تسوية مصروف مستحق"} — ${adj.name} (${ym})`,
        entryType:   adj.type === "prepaid" ? "adjustment_prepaid" : "adjustment_accrued",
        status:      "posted",
        periodId:    writability.period?.id ?? null,
      }).returning();

      await db.insert(journalEntryLinesTable).values([
        { entryId: entry.id, accountId: adj.expenseAccountId, debit: monthly, credit: "0", sortOrder: 0,
          description: `قسط ${ym} لـ ${adj.name}` },
        { entryId: entry.id, accountId: adj.contraAccountId,  debit: "0", credit: monthly, sortOrder: 1,
          description: `قسط ${ym} لـ ${adj.name}` },
      ]);

      // onConflictDoNothing protects against the rare case where two requests
      // race past the in-memory `generated` set check — the DB-level unique
      // index (adjustment_id, period_month) is the final arbiter.
      const inserted = await db.insert(accountingAdjustmentRunsTable).values({
        adjustmentId: adj.id, companyId: cid, periodMonth: ym,
        journalEntryId: entry.id, amount: monthly,
      }).onConflictDoNothing().returning();

      if (inserted.length === 0) {
        // Another concurrent caller already booked this month — roll back the
        // orphan JE we just created so we don't double-post.
        await db.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, entry.id));
        await db.delete(journalEntriesTable).where(eq(journalEntriesTable.id, entry.id));
        skipped.push({ ym, reason: "تم توليده من جلسة متزامنة" });
        continue;
      }

      created.push({ ym, entryId: entry.id });
    }

    // Mark adjustment completed when every month has a run
    let totalMonths = 0;
    for (const _ of monthsBetween(adj.startDate, adj.endDate)) totalMonths++;
    const finalRuns = await db.select({ id: accountingAdjustmentRunsTable.id })
      .from(accountingAdjustmentRunsTable).where(eq(accountingAdjustmentRunsTable.adjustmentId, id));
    if (finalRuns.length >= totalMonths) {
      await db.update(accountingAdjustmentsTable).set({ status: "completed", updatedAt: new Date() })
        .where(eq(accountingAdjustmentsTable.id, id));
    }

    res.json({ ok: true, created, skipped, totalMonths, alreadyGenerated: generated.size });
  } catch (e: any) { res.status(500).json({ error: "فشل التوليد: " + (e.message ?? "خطأ") }); }
});

/**
 * POST /api/adjustments/run-due — bulk-generate for every active adjustment
 * with `auto_generate=true`. Used by a "Run all due adjustments" button or
 * a cron-like trigger. Returns a summary per adjustment.
 */
router.post("/run-due", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const adjustments = await db.select().from(accountingAdjustmentsTable).where(and(
      eq(accountingAdjustmentsTable.companyId, cid),
      eq(accountingAdjustmentsTable.status, "active"),
      eq(accountingAdjustmentsTable.autoGenerate, true),
    ));

    const summary: any[] = [];
    for (const adj of adjustments) {
      const existingRuns = await db.select({ ym: accountingAdjustmentRunsTable.periodMonth })
        .from(accountingAdjustmentRunsTable).where(eq(accountingAdjustmentRunsTable.adjustmentId, adj.id));
      const generated = new Set(existingRuns.map(r => r.ym));
      const monthly = adj.monthlyAmount;
      const today = new Date().toISOString().slice(0, 10);
      const created: string[] = [];
      const skipped: { ym: string; reason: string }[] = [];

      for (const { ym, isoDate } of monthsBetween(adj.startDate, adj.endDate)) {
        if (generated.has(ym)) continue;
        // Only generate months whose end-date is <= today (don't pre-book future months)
        if (isoDate > today) break;

        const writability = await assertWritableForDate(cid, isoDate);
        if (!writability.ok) { skipped.push({ ym, reason: writability.reason }); continue; }

        const [entry] = await db.insert(journalEntriesTable).values({
          companyId: cid, entryDate: isoDate,
          description: `${adj.type === "prepaid" ? "تسوية مصروف مقدم" : "تسوية مصروف مستحق"} — ${adj.name} (${ym})`,
          entryType: adj.type === "prepaid" ? "adjustment_prepaid" : "adjustment_accrued",
          status: "posted", periodId: writability.period?.id ?? null,
        }).returning();
        await db.insert(journalEntryLinesTable).values([
          { entryId: entry.id, accountId: adj.expenseAccountId, debit: monthly, credit: "0", sortOrder: 0 },
          { entryId: entry.id, accountId: adj.contraAccountId,  debit: "0", credit: monthly, sortOrder: 1 },
        ]);
        const inserted = await db.insert(accountingAdjustmentRunsTable).values({
          adjustmentId: adj.id, companyId: cid, periodMonth: ym,
          journalEntryId: entry.id, amount: monthly,
        }).onConflictDoNothing().returning();
        if (inserted.length === 0) {
          // Concurrent caller already created this month — undo the orphan JE.
          await db.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, entry.id));
          await db.delete(journalEntriesTable).where(eq(journalEntriesTable.id, entry.id));
          skipped.push({ ym, reason: "race" });
          continue;
        }
        created.push(ym);
      }
      summary.push({ adjustmentId: adj.id, name: adj.name, type: adj.type, created, skipped });
    }

    res.json({ ok: true, summary, total: summary.reduce((s, x) => s + x.created.length, 0) });
  } catch (e: any) { res.status(500).json({ error: "فشل التشغيل: " + (e.message ?? "خطأ") }); }
});

export default router;
