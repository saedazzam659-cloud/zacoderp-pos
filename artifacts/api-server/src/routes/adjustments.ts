import { Router } from "express";
import { db } from "@workspace/db";
import {
  accountingAdjustmentsTable, accountingAdjustmentRunsTable,
  accountsTable, journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { and, eq, asc, desc, inArray, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { resolvePostingStatus } from "../lib/postingStatus.js";
import { fullAuditFor } from "../lib/journalAudit.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import { runDueAdjustmentsForCompany, ADJ_LOCK_CLASS } from "../lib/adjustmentPosting.js";

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

// Compute recognized & remaining for a list of adjustments in one query.
// Recognized = SUM(runs.amount), Remaining = totalAmount - recognized.
async function enrichWithRecognition<T extends { id: number; totalAmount: string }>(rows: T[]):
  Promise<(T & { recognizedAmount: string; remainingAmount: string; runCount: number })[]> {
  if (rows.length === 0) return [] as any;
  const ids = rows.map(r => r.id);
  const sums = await db
    .select({
      adjustmentId: accountingAdjustmentRunsTable.adjustmentId,
      total:        sql<string>`COALESCE(SUM(${accountingAdjustmentRunsTable.amount}), 0)`,
      cnt:          sql<number>`COUNT(*)::int`,
    })
    .from(accountingAdjustmentRunsTable)
    .where(inArray(accountingAdjustmentRunsTable.adjustmentId, ids))
    .groupBy(accountingAdjustmentRunsTable.adjustmentId);
  const map = new Map(sums.map(s => [s.adjustmentId, { sum: Number(s.total), cnt: Number(s.cnt) }]));
  return rows.map(r => {
    const m = map.get(r.id) ?? { sum: 0, cnt: 0 };
    const total = Number(r.totalAmount);
    const remaining = Math.max(0, total - m.sum);
    return {
      ...r,
      recognizedAmount: m.sum.toFixed(2),
      remainingAmount:  remaining.toFixed(2),
      runCount:         m.cnt,
    };
  });
}

// ─── GET /api/adjustments — list all adjustments for the company ─────────
router.get("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(accountingAdjustmentsTable)
      .where(eq(accountingAdjustmentsTable.companyId, cid))
      .orderBy(desc(accountingAdjustmentsTable.createdAt));
    const enriched = await enrichWithRecognition(rows);
    res.json(enriched);
  } catch (e: any) { res.status(500).json({ error: e.message ?? "خطأ" }); }
});

// ─── GET /api/adjustments/pending-carry-forward?asOf=YYYY-MM-DD ──────────
// Returns active adjustments whose end-date is <= cutoff AND have a positive
// remaining balance — i.e. candidates for "carry forward to next year" at
// period close. The wizard uses this to surface unfinished prepaids.
router.get("/pending-carry-forward", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const asOf = String(req.query.asOf ?? "");
    if (!isISO(asOf)) { res.status(400).json({ error: "asOf مطلوب (YYYY-MM-DD)" }); return; }

    const rows = await db.select().from(accountingAdjustmentsTable).where(and(
      eq(accountingAdjustmentsTable.companyId, cid),
      eq(accountingAdjustmentsTable.status, "active"),
      eq(accountingAdjustmentsTable.carryForwardEnabled, true),
    ));
    const enriched = await enrichWithRecognition(rows);
    // Only those whose schedule does not extend past the cutoff but still
    // carry a remaining balance > 0.01 (rounding tolerance).
    const candidates = enriched.filter(r =>
      r.endDate <= asOf && Number(r.remainingAmount) >= 0.01,
    );
    res.json({ asOf, candidates });
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

    // Children created via carry-forward
    const children = await db.select().from(accountingAdjustmentsTable)
      .where(and(
        eq(accountingAdjustmentsTable.parentAdjustmentId, id),
        eq(accountingAdjustmentsTable.companyId, cid),
      ));

    const [enriched] = await enrichWithRecognition([row]);
    res.json({ adjustment: enriched, runs, children });
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
    const {
      name, autoGenerate, status, notes, carryForwardEnabled,
      totalAmount, startDate, endDate, expenseAccountId, contraAccountId,
    } = req.body ?? {};

    const patch: any = { updatedAt: new Date() };
    if (typeof name === "string" && name.trim()) patch.name = name.trim();
    if (typeof autoGenerate === "boolean") patch.autoGenerate = autoGenerate;
    if (typeof carryForwardEnabled === "boolean") patch.carryForwardEnabled = carryForwardEnabled;
    if (status && ["active", "completed", "cancelled"].includes(status)) patch.status = status;
    if (typeof notes === "string" || notes === null) patch.notes = notes;

    // ── Financial fields (amount / dates / accounts) ────────────────────
    // Editable with automatic re-spread: months already generated keep their
    // booked runs untouched; the NEW monthly installment for the REMAINING
    // (un-generated) months = (newTotal − recognized) / remainingMonths.
    const wantsFinancial =
      totalAmount !== undefined || startDate !== undefined || endDate !== undefined ||
      expenseAccountId !== undefined || contraAccountId !== undefined;

    if (!wantsFinancial) {
      const [updated] = await db.update(accountingAdjustmentsTable).set(patch)
        .where(and(eq(accountingAdjustmentsTable.id, id), eq(accountingAdjustmentsTable.companyId, cid)))
        .returning();
      if (!updated) { res.status(404).json({ error: "التسوية غير موجودة" }); return; }
      res.json(updated);
      return;
    }

    try {
      const updated = await db.transaction(async (tx) => {
        // Advisory lock (same class+id as /generate and run-due/scheduler):
        // blocks concurrent month posting between our SUM and the
        // monthly-amount rewrite. Row FOR UPDATE alone is NOT enough because
        // generation writes runs without touching this row.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADJ_LOCK_CLASS}, ${id})`);
        const [adj] = await tx.execute(sql`
          SELECT * FROM accounting_adjustments
          WHERE id = ${id} AND company_id = ${cid}
          FOR UPDATE
        `).then((r: any) => r.rows ?? r);
        if (!adj) throw Object.assign(new Error("التسوية غير موجودة"), { status: 404 });
        if (!["active", "completed"].includes(adj.status))
          throw Object.assign(new Error(`لا يمكن تعديل البيانات المالية لتسوية بحالة ${adj.status}`), { status: 400 });

        const runs = await tx.select({
          ym: accountingAdjustmentRunsTable.periodMonth,
          amount: accountingAdjustmentRunsTable.amount,
        }).from(accountingAdjustmentRunsTable)
          .where(eq(accountingAdjustmentRunsTable.adjustmentId, id));
        const generated = new Set(runs.map(r => r.ym));
        const recognized = runs.reduce((s, r) => s + Number(r.amount), 0);
        const lastGeneratedYm = runs.reduce((mx, r) => (r.ym > mx ? r.ym : mx), "");

        // Dates
        const newStart = startDate !== undefined ? startDate : adj.start_date;
        const newEnd   = endDate   !== undefined ? endDate   : adj.end_date;
        if (!isISO(newStart) || !isISO(newEnd))
          throw Object.assign(new Error("تواريخ غير صالحة (YYYY-MM-DD)"), { status: 400 });
        if (newEnd < newStart)
          throw Object.assign(new Error("تاريخ النهاية يجب أن يكون بعد البداية"), { status: 400 });
        if (runs.length > 0 && newStart !== adj.start_date)
          throw Object.assign(new Error("لا يمكن تغيير تاريخ البداية بعد توليد أول قيد — عدّل تاريخ النهاية أو المبلغ فقط"), { status: 400 });
        if (runs.length > 0 && ymOf(newEnd) < lastGeneratedYm)
          throw Object.assign(new Error(`تاريخ النهاية الجديد يسبق آخر شهر مولَّد (${lastGeneratedYm}) — ألغِ قيود الأشهر الزائدة أولاً`), { status: 400 });

        // Amount
        const newTotal = totalAmount !== undefined ? Number(totalAmount) : Number(adj.total_amount);
        if (!Number.isFinite(newTotal) || newTotal <= 0)
          throw Object.assign(new Error("المبلغ الإجمالي يجب أن يكون رقم موجب"), { status: 400 });
        if (newTotal < recognized - 0.005)
          throw Object.assign(new Error(
            `المبلغ الجديد (${newTotal.toFixed(2)}) أقل من المُحقّق بالفعل (${recognized.toFixed(2)})`,
          ), { status: 400 });

        // Accounts (affect FUTURE JEs only — booked JEs keep their accounts)
        const newExp = expenseAccountId !== undefined ? Number(expenseAccountId) : adj.expense_account_id;
        const newCtr = contraAccountId  !== undefined ? Number(contraAccountId)  : adj.contra_account_id;
        if (!Number.isFinite(newExp) || !Number.isFinite(newCtr) || newExp === newCtr)
          throw Object.assign(new Error("حسابا المصروف والمقابل مطلوبان ويجب أن يكونا مختلفين"), { status: 400 });
        try { await validateAccounts(cid, newExp, newCtr); }
        catch (e: any) { throw Object.assign(new Error(e.message), { status: 400 }); }

        // Re-spread the un-recognized remainder over remaining months
        let remainingMonths = 0;
        for (const { ym } of monthsBetween(newStart, newEnd)) {
          if (!generated.has(ym)) remainingMonths++;
        }
        const remainder = newTotal - recognized;
        if (remainingMonths === 0 && remainder > 0.01)
          throw Object.assign(new Error("لا توجد أشهر متبقية لتوزيع الرصيد الجديد — مدّد تاريخ النهاية"), { status: 400 });
        const newMonthly = remainingMonths > 0
          ? (remainder / remainingMonths).toFixed(2)
          : adj.monthly_amount;

        patch.totalAmount      = newTotal.toFixed(2);
        patch.startDate        = newStart;
        patch.endDate          = newEnd;
        patch.expenseAccountId = newExp;
        patch.contraAccountId  = newCtr;
        patch.monthlyAmount    = newMonthly;
        // Extending a completed adjustment re-opens it (unless caller set an
        // explicit status in the same request).
        if (adj.status === "completed" && remainder > 0.01 && !patch.status) patch.status = "active";

        const [row] = await tx.update(accountingAdjustmentsTable).set(patch)
          .where(and(eq(accountingAdjustmentsTable.id, id), eq(accountingAdjustmentsTable.companyId, cid)))
          .returning();
        return row;
      });
      res.json(updated);
    } catch (e: any) {
      res.status(e.status ?? 500).json({ error: e.message ?? "خطأ" });
    }
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

    const result = await db.transaction(async (tx) => {
      // Serialize against the financial-edit PUT and the run-due scheduler.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADJ_LOCK_CLASS}, ${id})`);

      // Re-read UNDER the lock — a concurrent edit may have just re-spread
      // the monthly amount / extended the end date / changed the status.
      const [adj] = await tx.select().from(accountingAdjustmentsTable)
        .where(and(eq(accountingAdjustmentsTable.id, id), eq(accountingAdjustmentsTable.companyId, cid)));
      if (!adj) return { error: 404 as const };
      if (adj.status !== "active") return { error: 400 as const, status: adj.status };

      // Pull existing runs to skip already-generated months
      const existingRuns = await tx.select({ ym: accountingAdjustmentRunsTable.periodMonth })
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

        const jeStatus = await resolvePostingStatus(cid, "adjustment");
        // JE draws its own continuous "journal_entry" number (null when no active
        // sequence — preserves prior numberless behavior).
        const jeDocNumber = (await nextSequenceNumber(cid, "journal_entry", {
          userId: (req as any).authUser?.id ?? null, refTable: "journal_entries",
          branchId: null, docDate: isoDate,
        })) ?? null;
        const [entry] = await tx.insert(journalEntriesTable).values({
          companyId:   cid,
          docNumber:   jeDocNumber,
          entryDate:   isoDate,
          description: `${adj.type === "prepaid" ? "تسوية مصروف مقدم" : "تسوية مصروف مستحق"} — ${adj.name} (${ym})`,
          entryType:   adj.type === "prepaid" ? "adjustment_prepaid" : "adjustment_accrued",
          status:      jeStatus,
          periodId:    writability.period?.id ?? null,
          ...fullAuditFor(req, jeStatus),
        }).returning();

        await tx.insert(journalEntryLinesTable).values([
          { entryId: entry.id, accountId: adj.expenseAccountId, debit: monthly, credit: "0", sortOrder: 0,
            description: `قسط ${ym} لـ ${adj.name}` },
          { entryId: entry.id, accountId: adj.contraAccountId,  debit: "0", credit: monthly, sortOrder: 1,
            description: `قسط ${ym} لـ ${adj.name}` },
        ]);

        // onConflictDoNothing protects against the rare case where two requests
        // race past the in-memory `generated` set check — the DB-level unique
        // index (adjustment_id, period_month) is the final arbiter.
        const inserted = await tx.insert(accountingAdjustmentRunsTable).values({
          adjustmentId: adj.id, companyId: cid, periodMonth: ym,
          journalEntryId: entry.id, amount: monthly,
        }).onConflictDoNothing().returning();

        if (inserted.length === 0) {
          // Another concurrent caller already booked this month — roll back the
          // orphan JE we just created so we don't double-post.
          await tx.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, entry.id));
          await tx.delete(journalEntriesTable).where(eq(journalEntriesTable.id, entry.id));
          skipped.push({ ym, reason: "تم توليده من جلسة متزامنة" });
          continue;
        }

        created.push({ ym, entryId: entry.id });
        generated.add(ym);
      }

      // Mark adjustment completed when every month has a run
      let totalMonths = 0;
      for (const _ of monthsBetween(adj.startDate, adj.endDate)) totalMonths++;
      if (generated.size >= totalMonths && totalMonths > 0) {
        await tx.update(accountingAdjustmentsTable).set({ status: "completed", updatedAt: new Date() })
          .where(eq(accountingAdjustmentsTable.id, id));
      }

      return { error: null, created, skipped, totalMonths, alreadyGenerated: existingRuns.length };
    });

    if (result.error === 404) { res.status(404).json({ error: "التسوية غير موجودة" }); return; }
    if (result.error === 400) {
      res.status(400).json({ error: `لا يمكن توليد قيود لتسوية بحالة ${result.status}` });
      return;
    }
    res.json({ ok: true, created: result.created, skipped: result.skipped,
      totalMonths: result.totalMonths, alreadyGenerated: result.alreadyGenerated });
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
    // Same helper the auto scheduler runs hourly — manual button stays as a
    // "run it now" lever with identical behaviour.
    const out = await runDueAdjustmentsForCompany(cid, req);
    res.json({ ok: true, summary: out.summary, total: out.total });
  } catch (e: any) { res.status(500).json({ error: "فشل التشغيل: " + (e.message ?? "خطأ") }); }
});

/**
 * POST /api/adjustments/:id/carry-forward — roll the un-recognized portion of
 * an adjustment into a brand-new "child" adjustment for the next fiscal year.
 *
 * Use case (per user requirement):
 *   Prepaid rent of 2,000 — 1,600 already recognized over 8 months, contract
 *   ends 31-12-2026 → at year-end close, the remaining 400 should not vanish.
 *   It should roll into a new adjustment for 2027 covering the next 2 months
 *   (or however long the user wants), keeping the same expense + asset
 *   accounts so the BS balance amortizes cleanly into the new period.
 *
 * Mechanics:
 *   1. Compute remaining = totalAmount - SUM(runs.amount). Refuse if <= 0.
 *   2. Validate new dates (newStartDate must be after the parent's last
 *      recognized month; newEndDate must be after newStartDate).
 *   3. Create a new adjustments row:
 *        parent_adjustment_id = id
 *        total_amount         = remaining
 *        monthly_amount       = remaining / months_in_new_window
 *        status               = "active"
 *        carry_forward_enabled inherited
 *      (No JE is posted — the BS contra account naturally carries balance
 *      across periods. The child's monthly /generate then continues
 *      amortising the remaining 400 against that already-existing balance.)
 *   4. Mark parent.status = "carried_forward" so it disappears from the
 *      "due" run list but stays for audit reference.
 */
router.post("/:id/carry-forward", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const { newStartDate, newEndDate } = req.body ?? {};
    if (!isISO(newStartDate) || !isISO(newEndDate)) {
      res.status(400).json({ error: "تواريخ البداية والنهاية الجديدة مطلوبة (YYYY-MM-DD)" }); return;
    }
    if (newEndDate < newStartDate) {
      res.status(400).json({ error: "تاريخ نهاية الترحيل يجب أن يكون بعد البداية" }); return;
    }

    // Compute new monthly = remaining / number of months in new window
    let months = 0;
    for (const _ of monthsBetween(newStartDate, newEndDate)) months++;
    if (months <= 0) { res.status(400).json({ error: "النافذة الجديدة لا تحوي أشهر صالحة" }); return; }

    // Wrap the entire compute-and-create flow in a transaction with a row
    // lock on the parent adjustment. This prevents two concurrent
    // carry-forward calls from racing, AND prevents a concurrent /generate
    // request from booking a new run between our SUM and the parent close.
    // The unique partial index `adj_one_child_per_parent_uq` is the
    // belt-and-braces backstop in case the lock is somehow bypassed.
    let result: { recognized: number; remaining: number; newMonthly: string; child: any };
    try {
      result = await db.transaction(async (tx) => {
        const [parent] = await tx.execute(sql`
          SELECT * FROM accounting_adjustments
          WHERE id = ${id} AND company_id = ${cid}
          FOR UPDATE
        `).then((r: any) => r.rows ?? r);
        if (!parent) throw Object.assign(new Error("التسوية الأصلية غير موجودة"), { status: 404 });
        if (parent.status === "carried_forward")
          throw Object.assign(new Error("هذه التسوية مُرحَّلة بالفعل — راجع التسوية الفرعية الناتجة"), { status: 400 });
        if (parent.status === "cancelled")
          throw Object.assign(new Error("لا يمكن ترحيل تسوية ملغاة"), { status: 400 });
        if (parent.status === "completed")
          throw Object.assign(new Error("هذه التسوية مكتملة — لا يوجد ما يُرحَّل"), { status: 400 });
        if (parent.status !== "active")
          throw Object.assign(new Error(`لا يمكن ترحيل تسوية بحالة ${parent.status}`), { status: 400 });
        if (newStartDate <= parent.end_date)
          throw Object.assign(new Error(
            `تاريخ بداية الترحيل (${newStartDate}) يجب أن يكون بعد تاريخ نهاية التسوية الأصلية (${parent.end_date})`,
          ), { status: 400 });

        // Compute remaining via runs sum (under the parent's row lock so no
        // /generate can sneak a run in between this SUM and the parent close)
        const [agg] = await tx
          .select({ total: sql<string>`COALESCE(SUM(${accountingAdjustmentRunsTable.amount}), 0)` })
          .from(accountingAdjustmentRunsTable)
          .where(eq(accountingAdjustmentRunsTable.adjustmentId, id));
        const recognized = Number(agg?.total ?? 0);
        const totalAmt   = Number(parent.total_amount);
        const remaining  = totalAmt - recognized;
        if (remaining < 0.01) {
          throw Object.assign(new Error(
            `لا يوجد رصيد متبقٍ للترحيل — تم استحقاق ${recognized.toFixed(2)} من أصل ${totalAmt.toFixed(2)}`,
          ), { status: 400 });
        }
        const newMonthly = (remaining / months).toFixed(2);

        // Create the child — onConflictDoNothing on the partial unique index
        // catches the concurrency race that the row lock should already have
        // prevented; we treat conflict as "another caller already did it".
        const [child] = await tx.insert(accountingAdjustmentsTable).values({
          companyId:           cid,
          type:                parent.type,
          name:                `${parent.name} — ترحيل ${newStartDate.slice(0, 4)}`,
          expenseAccountId:    parent.expense_account_id,
          contraAccountId:     parent.contra_account_id,
          totalAmount:         remaining.toFixed(2),
          startDate:           newStartDate,
          endDate:             newEndDate,
          monthlyAmount:       newMonthly,
          autoGenerate:        parent.auto_generate,
          carryForwardEnabled: parent.carry_forward_enabled,
          parentAdjustmentId:  parent.id,
          status:              "active",
          notes:               `مُرحَّل من التسوية #${parent.id} — رصيد متبقٍ ${remaining.toFixed(2)} من أصل ${totalAmt.toFixed(2)}`,
        }).onConflictDoNothing({ target: accountingAdjustmentsTable.parentAdjustmentId }).returning();

        if (!child) {
          throw Object.assign(new Error("تم ترحيل هذه التسوية للتو من جلسة أخرى — أعد التحميل لرؤية التسوية الفرعية"), { status: 409 });
        }

        await tx.update(accountingAdjustmentsTable)
          .set({ status: "carried_forward", updatedAt: new Date() })
          .where(eq(accountingAdjustmentsTable.id, parent.id));

        return { recognized, remaining, newMonthly, child };
      });
    } catch (e: any) {
      const status = e?.status ?? 500;
      res.status(status).json({ error: status === 500 ? "فشل الترحيل: " + (e.message ?? "خطأ") : e.message });
      return;
    }

    res.status(201).json({
      ok: true,
      parent: { id, status: "carried_forward" },
      child: result.child,
      summary: {
        recognized:     result.recognized.toFixed(2),
        carriedForward: result.remaining.toFixed(2),
        newMonthly:     result.newMonthly,
        months,
      },
    });
  } catch (e: any) { res.status(500).json({ error: "فشل الترحيل: " + (e.message ?? "خطأ") }); }
});

export default router;
