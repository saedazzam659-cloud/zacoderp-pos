import { Router } from "express";
import { db } from "@workspace/db";
import {
  fiscalYearsTable, fiscalPeriodsTable,
  journalEntriesTable, journalEntryLinesTable, accountsTable,
  accountingAdjustmentsTable, accountingAdjustmentRunsTable,
} from "@workspace/db";
import { eq, and, asc, ne, gte, lte, sql, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

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
// Strict calendar validation: rejects 2026-02-31, 2026-13-01, etc.
function isISO(s: any): s is string {
  if (typeof s !== "string") return false;
  const m = ISO.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // UTC date construction; check round-trip preserves the components
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const ARABIC_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

const pad = (n: number) => String(n).padStart(2, "0");
const toISO = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
// Last day of month using UTC math (timezone-agnostic)
const lastDayOfMonthUTC = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const parseISO = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m: m - 1, d };
};

// Build monthly periods covering [startDate, endDate] inclusively, no gaps/overlap.
// Uses pure integer math on (y, m, d) tuples — timezone-agnostic.
function buildMonthlyPeriods(startDate: string, endDate: string) {
  const start = parseISO(startDate);
  const end   = parseISO(endDate);
  const periods: { name: string; startDate: string; endDate: string; sequence: number }[] = [];

  let cy = start.y, cm = start.m, cd = start.d;
  let seq = 1;

  // safety guard against runaway loops (max 240 periods = 20 years)
  for (let i = 0; i < 240; i++) {
    const periodStart = toISO(cy, cm, cd);
    const monthEndDay = lastDayOfMonthUTC(cy, cm);

    // The candidate period end is end-of-month of (cy, cm).
    // Clamp to fiscal end if the fiscal end falls inside this month.
    let py = cy, pm = cm, pd = monthEndDay;
    const endIsInThisMonth = end.y === cy && end.m === cm;
    const endIsBeforeThisMonth =
      end.y < cy || (end.y === cy && end.m < cm);
    if (endIsBeforeThisMonth) break; // safety
    if (endIsInThisMonth && end.d < monthEndDay) {
      pd = end.d;
    }
    const periodEnd = toISO(py, pm, pd);

    periods.push({
      name: `${ARABIC_MONTHS[cm]} ${cy}`,
      startDate: periodStart,
      endDate: periodEnd,
      sequence: seq++,
    });

    // Stop when we've reached the fiscal end
    if (py === end.y && pm === end.m && pd === end.d) break;

    // Move cursor to first day of next month
    cm += 1;
    if (cm > 11) { cm = 0; cy += 1; }
    cd = 1;
  }
  return periods;
}

// Tenant-safe range overlap test using string compare (works for ISO dates)
const rangesOverlap = (aStart: string, aEnd: string, bStart: string, bEnd: string) =>
  aStart <= bEnd && aEnd >= bStart;

// ─── GET /api/fiscal-years — list all fiscal years for the company ──────
router.get("/years", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(fiscalYearsTable)
      .where(eq(fiscalYearsTable.companyId, cid))
      .orderBy(asc(fiscalYearsTable.startDate));
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "خطأ" });
  }
});

// ─── GET /api/fiscal-years/:id — single year with its periods ──────────
router.get("/years/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const [year] = await db.select().from(fiscalYearsTable)
      .where(and(eq(fiscalYearsTable.id, id), eq(fiscalYearsTable.companyId, cid)));
    if (!year) { res.status(404).json({ error: "السنة المالية غير موجودة" }); return; }

    const periods = await db.select().from(fiscalPeriodsTable)
      .where(and(eq(fiscalPeriodsTable.fiscalYearId, id), eq(fiscalPeriodsTable.companyId, cid)))
      .orderBy(asc(fiscalPeriodsTable.sequence));

    res.json({ year, periods });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "خطأ" });
  }
});

// ─── POST /api/fiscal-years — create a fiscal year + auto monthly periods ──
router.post("/years", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { name, startDate, endDate } = req.body ?? {};

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "اسم السنة المالية مطلوب" }); return;
    }
    if (!isISO(startDate) || !isISO(endDate)) {
      res.status(400).json({ error: "تواريخ غير صالحة (YYYY-MM-DD)" }); return;
    }
    if (endDate <= startDate) {
      res.status(400).json({ error: "تاريخ النهاية يجب أن يكون بعد تاريخ البداية" }); return;
    }

    // No overlap with other fiscal years (string compare on ISO dates is safe & TZ-agnostic)
    const others = await db.select().from(fiscalYearsTable).where(eq(fiscalYearsTable.companyId, cid));
    for (const y of others) {
      if (rangesOverlap(startDate, endDate, y.startDate, y.endDate)) {
        res.status(409).json({ error: `يوجد تداخل مع السنة المالية: ${y.name}` }); return;
      }
    }

    const [created] = await db.insert(fiscalYearsTable).values({
      companyId: cid, name: name.trim(), startDate, endDate, status: "open",
    }).returning();

    const periods = buildMonthlyPeriods(startDate, endDate).map(p => ({
      ...p, companyId: cid, fiscalYearId: created.id, status: "open" as const,
    }));
    const insertedPeriods = await db.insert(fiscalPeriodsTable).values(periods).returning();

    res.json({ ok: true, year: created, periods: insertedPeriods });
  } catch (err: any) {
    res.status(500).json({ error: "فشل الإنشاء: " + (err.message ?? "خطأ") });
  }
});

// ─── DELETE /api/fiscal-years/:id — delete year (only if all periods are still open) ──
router.delete("/years/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const periods = await db.select().from(fiscalPeriodsTable)
      .where(and(eq(fiscalPeriodsTable.fiscalYearId, id), eq(fiscalPeriodsTable.companyId, cid)));
    if (periods.some(p => p.status !== "open")) {
      res.status(400).json({ error: "لا يمكن حذف سنة مالية تحتوي على فترات مغلقة" }); return;
    }

    const r = await db.delete(fiscalYearsTable)
      .where(and(eq(fiscalYearsTable.id, id), eq(fiscalYearsTable.companyId, cid))).returning();
    if (r.length === 0) { res.status(404).json({ error: "السنة المالية غير موجودة" }); return; }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "خطأ" });
  }
});

// ─── PATCH /api/fiscal-periods/:id/status — change a period status ─────
// IFRS-aligned: this endpoint ONLY handles re-opening a soft-closed period
// (closed → open). Direct flips to "closed" or "permanently_closed" are
// REFUSED — those must run through the wizard endpoints (/soft-close +
// /hard-close) which validate drafts/unbalanced entries and require the
// closing JEs (closing_revenue/expense + closing_transfer_*) to exist.
// Bypassing them was the root cause of periods that ended up "closed
// نهائي" with zero closing entries posted.
router.patch("/periods/:id/status", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    if (!["open", "closed", "permanently_closed"].includes(status)) {
      res.status(400).json({ error: "حالة غير صالحة" }); return;
    }

    const [current] = await db.select().from(fiscalPeriodsTable)
      .where(and(eq(fiscalPeriodsTable.id, id), eq(fiscalPeriodsTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "الفترة غير موجودة" }); return; }

    if (current.status === "permanently_closed") {
      res.status(400).json({
        error: "لا يمكن التعديل على فترة مغلقة نهائياً. يحتاج فك القفل صلاحية سوبر أدمن (force-reopen)"
      });
      return;
    }

    // Re-open a soft-closed period — only legal direct transition here.
    if (current.status === "closed" && status === "open") {
      const [updated] = await db.update(fiscalPeriodsTable)
        .set({ status: "open", updatedAt: new Date() })
        .where(eq(fiscalPeriodsTable.id, id)).returning();
      res.json({ ok: true, period: updated });
      return;
    }

    // No-op (already in requested status)
    if (current.status === status) { res.json({ ok: true, period: current, noop: true }); return; }

    // Direct close / permanently_close attempts → push the user through the
    // proper closing wizard so the IFRS validation and closing JEs run.
    if (status === "closed") {
      res.status(400).json({
        error: "لا يمكن إقفال الفترة مباشرة من هنا. استخدم «معالج الإقفال» الذي يتحقق من القيود غير المرحّلة وأرصدة الإيرادات/المصروفات قبل الإقفال الناعم.",
        useWizard: true,
        endpoint: `/api/fiscal/periods/${id}/soft-close`,
      });
      return;
    }
    if (status === "permanently_closed") {
      res.status(400).json({
        error: "لا يمكن الإقفال النهائي مباشرة من هنا. استخدم «معالج الإقفال»: إقفال الأرباح والخسائر → ترحيل الأرباح إلى الأرباح المحتجزة → الإقفال الناعم → الإقفال النهائي. هذا يضمن ترحيل قيود الإقفال المحاسبية قبل تأمين الفترة نهائياً.",
        useWizard: true,
        endpoint: `/api/fiscal/periods/${id}/hard-close`,
      });
      return;
    }

    res.status(400).json({ error: `انتقال غير مسموح: ${current.status} → ${status}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "خطأ" });
  }
});

// ─── PATCH /api/fiscal-years/:id/status — close/reopen entire year ─────
// IFRS-aligned: a year-level close is a *rollup* status — it can only flip
// to "closed" once every period inside is at least "closed", and to
// "permanently_closed" once every period is "permanently_closed" (which
// means the wizard ran and posted closing JEs for each of them). Re-open
// (→ open) is always allowed. Bypassing this was the root cause of years
// shown as "permanently_closed" while their periods still had open P&L
// balances and zero closing entries.
router.patch("/years/:id/status", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    if (!["open", "closed", "permanently_closed"].includes(status)) {
      res.status(400).json({ error: "حالة غير صالحة" }); return;
    }

    const [current] = await db.select().from(fiscalYearsTable)
      .where(and(eq(fiscalYearsTable.id, id), eq(fiscalYearsTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "السنة المالية غير موجودة" }); return; }
    if (current.status === "permanently_closed") {
      res.status(400).json({
        error: "لا يمكن التعديل على سنة مالية مغلقة نهائياً. يحتاج فك القفل صلاحية سوبر أدمن (force-reopen على إحدى فتراتها)"
      });
      return;
    }
    if (current.status === status) { res.json({ ok: true, year: current, noop: true }); return; }

    // Re-open (→ open) is always allowed — cascades to soft-closed periods
    // (but never reopens an already permanently_closed period).
    if (status === "open") {
      const [updated] = await db.update(fiscalYearsTable)
        .set({ status: "open", updatedAt: new Date() })
        .where(eq(fiscalYearsTable.id, id)).returning();
      await db.update(fiscalPeriodsTable)
        .set({ status: "open", updatedAt: new Date() })
        .where(and(
          eq(fiscalPeriodsTable.fiscalYearId, id),
          eq(fiscalPeriodsTable.companyId, cid),
          eq(fiscalPeriodsTable.status, "closed"),
        ));
      res.json({ ok: true, year: updated, reopenedSoftClosed: true });
      return;
    }

    // For a year-level close, every constituent period must already be at
    // the matching (or stronger) status — meaning the user already ran the
    // wizard for each of them. We don't auto-run the wizard here because
    // each period needs its own P&L summary + retained-earnings selection.
    const periods = await db.select({ id: fiscalPeriodsTable.id, name: fiscalPeriodsTable.name, status: fiscalPeriodsTable.status })
      .from(fiscalPeriodsTable)
      .where(and(
        eq(fiscalPeriodsTable.fiscalYearId, id),
        eq(fiscalPeriodsTable.companyId, cid),
      ));

    if (periods.length === 0) {
      res.status(400).json({ error: "السنة المالية لا تحتوي على فترات — لا يوجد ما يُقفل" });
      return;
    }

    if (status === "closed") {
      // Every period must be at least closed (closed or permanently_closed).
      const stillOpen = periods.filter(p => p.status === "open");
      if (stillOpen.length > 0) {
        res.status(400).json({
          error: `لا يمكن إقفال السنة قبل إقفال جميع فتراتها. ${stillOpen.length} فترة لم تُقفل بعد. استخدم «معالج الإقفال» لكل فترة على حدة.`,
          stillOpenPeriods: stillOpen.map(p => ({ id: p.id, name: p.name })),
        });
        return;
      }
    }
    if (status === "permanently_closed") {
      // Every period must be permanently_closed (i.e. closing JEs verified).
      const notFinal = periods.filter(p => p.status !== "permanently_closed");
      if (notFinal.length > 0) {
        res.status(400).json({
          error: `لا يمكن الإقفال النهائي للسنة قبل الإقفال النهائي لجميع فتراتها. ${notFinal.length} فترة لم تُقفل نهائياً بعد. شغّل «معالج الإقفال» (مع ترحيل الأرباح للأرباح المحتجزة) لكل فترة، ثم أعد المحاولة.`,
          notFinalPeriods: notFinal.map(p => ({ id: p.id, name: p.name, status: p.status })),
        });
        return;
      }
    }

    const [updated] = await db.update(fiscalYearsTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(fiscalYearsTable.id, id)).returning();

    res.json({ ok: true, year: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "خطأ" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
//   CLOSING ENGINE
// ─────────────────────────────────────────────────────────────────────────
// The closing flow follows the standard period-end sequence:
//   1) validate         — surface draft/unbalanced/missing-adjustment issues
//   2) close-pl         — zero out revenue & expenses into a PL summary account
//   3) transfer-profit  — move the PL summary balance to retained earnings
//   4) soft-close       — flip status open → closed (still re-openable)
//   5) hard-close       — flip status closed → permanently_closed (final)
// Each step is independently re-callable (idempotent where possible) so the
// user can iterate on errors without rolling back the whole flow.

async function fetchPeriod(cid: number, id: number) {
  const [row] = await db.select().from(fiscalPeriodsTable)
    .where(and(eq(fiscalPeriodsTable.id, id), eq(fiscalPeriodsTable.companyId, cid)));
  return row ?? null;
}

/**
 * Sum debit/credit per account across every JE line whose entry falls in the
 * period's date range. Restricted to a specific account_type so the caller
 * can build closing entries for revenue / expense / equity slices.
 */
async function balancesByType(
  cid: number, startDate: string, endDate: string, accountType: "revenue" | "expense" | "equity",
) {
  const rows = await db.select({
    accountId: journalEntryLinesTable.accountId,
    debit:     sql<string>`coalesce(sum(${journalEntryLinesTable.debit}), 0)`,
    credit:    sql<string>`coalesce(sum(${journalEntryLinesTable.credit}), 0)`,
  })
  .from(journalEntryLinesTable)
  .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
  .innerJoin(accountsTable, eq(journalEntryLinesTable.accountId, accountsTable.id))
  .where(and(
    eq(journalEntriesTable.companyId, cid),
    eq(journalEntriesTable.status, "posted"),
    gte(journalEntriesTable.entryDate, startDate),
    lte(journalEntriesTable.entryDate, endDate),
    eq(accountsTable.accountType, accountType),
  ))
  .groupBy(journalEntryLinesTable.accountId);

  return rows.map(r => ({
    accountId: r.accountId!,
    debit:     parseFloat(r.debit  || "0"),
    credit:    parseFloat(r.credit || "0"),
    balance:   parseFloat(r.debit || "0") - parseFloat(r.credit || "0"),
  }));
}

// ─── GET /api/fiscal/periods/:id/validate — pre-close health check ──────
router.get("/periods/:id/validate", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const period = await fetchPeriod(cid, id);
    if (!period) { res.status(404).json({ error: "الفترة غير موجودة" }); return; }

    // 1) Draft entries inside the period?
    const drafts = await db.select({ id: journalEntriesTable.id, docNumber: journalEntriesTable.docNumber, entryDate: journalEntriesTable.entryDate })
      .from(journalEntriesTable).where(and(
        eq(journalEntriesTable.companyId, cid),
        eq(journalEntriesTable.status, "draft"),
        gte(journalEntriesTable.entryDate, period.startDate),
        lte(journalEntriesTable.entryDate, period.endDate),
      ));

    // 2) Unbalanced posted entries?
    const balRows = await db.select({
      entryId: journalEntryLinesTable.entryId,
      debit:   sql<string>`coalesce(sum(${journalEntryLinesTable.debit}), 0)`,
      credit:  sql<string>`coalesce(sum(${journalEntryLinesTable.credit}), 0)`,
    })
    .from(journalEntryLinesTable)
    .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
    .where(and(
      eq(journalEntriesTable.companyId, cid),
      eq(journalEntriesTable.status, "posted"),
      gte(journalEntriesTable.entryDate, period.startDate),
      lte(journalEntriesTable.entryDate, period.endDate),
    ))
    .groupBy(journalEntryLinesTable.entryId);
    const unbalanced = balRows.filter(r => Math.abs(parseFloat(r.debit || "0") - parseFloat(r.credit || "0")) > 0.01);

    // 3) Active adjustments missing a run for any month inside this period?
    const ymOf = (d: string) => d.slice(0, 7);
    const adjustments = await db.select().from(accountingAdjustmentsTable).where(and(
      eq(accountingAdjustmentsTable.companyId, cid),
      eq(accountingAdjustmentsTable.status, "active"),
    ));
    const missingAdjustments: { adjustmentId: number; name: string; missingMonths: string[] }[] = [];
    for (const adj of adjustments) {
      // Months where adj is active that fall within the period
      const adjStart = adj.startDate < period.startDate ? period.startDate : adj.startDate;
      const adjEnd   = adj.endDate   > period.endDate   ? period.endDate   : adj.endDate;
      if (adjStart > adjEnd) continue;
      const monthsNeeded: string[] = [];
      let [y, m] = adjStart.split("-").map(Number);
      const [ey, em] = adjEnd.split("-").map(Number);
      while (y < ey || (y === ey && m <= em)) {
        monthsNeeded.push(`${y}-${String(m).padStart(2, "0")}`);
        m++; if (m > 12) { m = 1; y++; }
      }
      const runs = await db.select({ ym: accountingAdjustmentRunsTable.periodMonth })
        .from(accountingAdjustmentRunsTable).where(eq(accountingAdjustmentRunsTable.adjustmentId, adj.id));
      const generatedSet = new Set(runs.map(r => r.ym));
      const missing = monthsNeeded.filter(ym => !generatedSet.has(ym));
      if (missing.length > 0) missingAdjustments.push({ adjustmentId: adj.id, name: adj.name, missingMonths: missing });
    }

    const issues: string[] = [];
    if (drafts.length > 0)             issues.push(`يوجد ${drafts.length} قيد غير مرحّل`);
    if (unbalanced.length > 0)         issues.push(`يوجد ${unbalanced.length} قيد غير متوازن`);
    if (missingAdjustments.length > 0) issues.push(`يوجد ${missingAdjustments.length} تسوية لم يتم توليد قيودها`);

    res.json({
      ok: issues.length === 0,
      period: { id: period.id, name: period.name, status: period.status, startDate: period.startDate, endDate: period.endDate },
      issues,
      drafts: drafts.slice(0, 50),
      unbalanced: unbalanced.slice(0, 50),
      missingAdjustments,
    });
  } catch (e: any) { res.status(500).json({ error: e.message ?? "خطأ" }); }
});

// ─── POST /api/fiscal/periods/:id/close-pl — zero out revenue & expense ──
// Body: { plSummaryAccountId: number }
// Creates 2 posted journal entries dated on period.endDate:
//   (a) Dr each revenue account by its credit balance, Cr PL summary    (close revenue)
//   (b) Dr PL summary, Cr each expense account by its debit balance     (close expenses)
router.post("/periods/:id/close-pl", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { plSummaryAccountId } = req.body ?? {};
    if (!Number.isFinite(id) || !Number.isFinite(Number(plSummaryAccountId))) {
      res.status(400).json({ error: "معرّف الفترة و حساب أرباح وخسائر مطلوبان" }); return;
    }
    const period = await fetchPeriod(cid, id);
    if (!period) { res.status(404).json({ error: "الفترة غير موجودة" }); return; }
    if (period.status !== "open") { res.status(400).json({ error: "الفترة ليست مفتوحة" }); return; }

    const [pl] = await db.select().from(accountsTable).where(and(
      eq(accountsTable.id, Number(plSummaryAccountId)), eq(accountsTable.companyId, cid),
    ));
    if (!pl) { res.status(400).json({ error: "حساب الأرباح والخسائر غير موجود" }); return; }
    if (pl.accountType !== "equity") { res.status(400).json({ error: "حساب الأرباح والخسائر يجب أن يكون من نوع حقوق ملكية" }); return; }
    if (!pl.isPosting) { res.status(400).json({ error: "حساب الأرباح والخسائر يجب أن يكون حساب ترحيل" }); return; }

    const revenue  = await balancesByType(cid, period.startDate, period.endDate, "revenue");
    const expenses = await balancesByType(cid, period.startDate, period.endDate, "expense");

    // Filter out zero-balance lines
    const revLines  = revenue.filter(r  => Math.abs(r.credit - r.debit)   > 0.005);
    const expLines  = expenses.filter(e => Math.abs(e.debit  - e.credit) > 0.005);
    if (revLines.length === 0 && expLines.length === 0) {
      res.status(400).json({ error: "لا توجد إيرادات أو مصروفات لإقفالها في هذه الفترة" }); return;
    }

    const created: { type: "revenue" | "expense"; entryId: number; total: number }[] = [];

    // (a) Close revenues — Dr each revenue (by its credit-balance), Cr PL summary
    if (revLines.length > 0) {
      const totalRev = revLines.reduce((s, r) => s + (r.credit - r.debit), 0);
      const [revEntry] = await db.insert(journalEntriesTable).values({
        companyId: cid, entryDate: period.endDate,
        description: `قيد إقفال الإيرادات — ${period.name}`,
        entryType: "closing_revenue", status: "posted", periodId: period.id,
      }).returning();
      const lines = [
        ...revLines.map((r, i) => ({
          entryId: revEntry.id, accountId: r.accountId,
          debit: (r.credit - r.debit).toFixed(2), credit: "0",
          description: "إقفال رصيد إيرادات", sortOrder: i,
        })),
        { entryId: revEntry.id, accountId: pl.id,
          debit: "0", credit: totalRev.toFixed(2),
          description: "إجمالي الإيرادات → الأرباح والخسائر", sortOrder: revLines.length },
      ];
      await db.insert(journalEntryLinesTable).values(lines);
      created.push({ type: "revenue", entryId: revEntry.id, total: totalRev });
    }

    // (b) Close expenses — Dr PL summary, Cr each expense (by its debit-balance)
    if (expLines.length > 0) {
      const totalExp = expLines.reduce((s, e) => s + (e.debit - e.credit), 0);
      const [expEntry] = await db.insert(journalEntriesTable).values({
        companyId: cid, entryDate: period.endDate,
        description: `قيد إقفال المصروفات — ${period.name}`,
        entryType: "closing_expense", status: "posted", periodId: period.id,
      }).returning();
      const lines = [
        { entryId: expEntry.id, accountId: pl.id,
          debit: totalExp.toFixed(2), credit: "0",
          description: "الأرباح والخسائر → إجمالي المصروفات", sortOrder: 0 },
        ...expLines.map((e, i) => ({
          entryId: expEntry.id, accountId: e.accountId,
          debit: "0", credit: (e.debit - e.credit).toFixed(2),
          description: "إقفال رصيد مصروفات", sortOrder: i + 1,
        })),
      ];
      await db.insert(journalEntryLinesTable).values(lines);
      created.push({ type: "expense", entryId: expEntry.id, total: totalExp });
    }

    const totalRev = created.find(c => c.type === "revenue")?.total ?? 0;
    const totalExp = created.find(c => c.type === "expense")?.total ?? 0;
    res.json({ ok: true, created, netIncome: totalRev - totalExp });
  } catch (e: any) { res.status(500).json({ error: "فشل إقفال الأرباح والخسائر: " + (e.message ?? "خطأ") }); }
});

// ─── POST /api/fiscal/periods/:id/transfer-profit — PL → Retained ────────
// Body: { plSummaryAccountId, retainedEarningsAccountId }
// Reads the current balance of plSummaryAccountId across the period range
// and transfers it to retained earnings (profit → credit RE; loss → debit RE).
router.post("/periods/:id/transfer-profit", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { plSummaryAccountId, retainedEarningsAccountId } = req.body ?? {};
    if (!Number.isFinite(id)
        || !Number.isFinite(Number(plSummaryAccountId))
        || !Number.isFinite(Number(retainedEarningsAccountId))
        || plSummaryAccountId === retainedEarningsAccountId) {
      res.status(400).json({ error: "معرّفات الحسابات مطلوبة وغير متطابقة" }); return;
    }

    const period = await fetchPeriod(cid, id);
    if (!period) { res.status(404).json({ error: "الفترة غير موجودة" }); return; }
    if (period.status !== "open") { res.status(400).json({ error: "الفترة ليست مفتوحة" }); return; }

    const accs = await db.select().from(accountsTable).where(and(
      eq(accountsTable.companyId, cid),
      inArray(accountsTable.id, [Number(plSummaryAccountId), Number(retainedEarningsAccountId)]),
    ));
    const pl = accs.find(a => a.id === Number(plSummaryAccountId));
    const re = accs.find(a => a.id === Number(retainedEarningsAccountId));
    if (!pl || !re) { res.status(400).json({ error: "الحسابات غير موجودة في هذه الشركة" }); return; }
    if (pl.accountType !== "equity" || re.accountType !== "equity") {
      res.status(400).json({ error: "كلا الحسابين يجب أن يكونا من نوع حقوق ملكية" }); return;
    }

    // Pull the current PL balance over the period date range (after close-pl ran)
    const [agg] = await db.select({
      debit:  sql<string>`coalesce(sum(${journalEntryLinesTable.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalEntryLinesTable.credit}), 0)`,
    })
    .from(journalEntryLinesTable)
    .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
    .where(and(
      eq(journalEntriesTable.companyId, cid),
      eq(journalEntriesTable.status, "posted"),
      gte(journalEntriesTable.entryDate, period.startDate),
      lte(journalEntriesTable.entryDate, period.endDate),
      eq(journalEntryLinesTable.accountId, pl.id),
    ));
    const debit  = parseFloat(agg?.debit  || "0");
    const credit = parseFloat(agg?.credit || "0");
    const net    = credit - debit; // positive → profit, negative → loss

    if (Math.abs(net) < 0.005) {
      res.status(400).json({ error: "رصيد الأرباح والخسائر صفر — لا يوجد ما يُرحّل" }); return;
    }

    const isProfit = net > 0;
    const amount = Math.abs(net).toFixed(2);
    const [entry] = await db.insert(journalEntriesTable).values({
      companyId: cid, entryDate: period.endDate,
      description: `ترحيل ${isProfit ? "أرباح" : "خسائر"} الفترة — ${period.name}`,
      entryType: isProfit ? "closing_transfer_profit" : "closing_transfer_loss",
      status: "posted", periodId: period.id,
    }).returning();

    // Profit: Dr PL summary, Cr Retained earnings
    // Loss:   Dr Retained earnings, Cr PL summary
    const lines = isProfit
      ? [
          { entryId: entry.id, accountId: pl.id, debit: amount, credit: "0",
            description: "إقفال رصيد الأرباح والخسائر", sortOrder: 0 },
          { entryId: entry.id, accountId: re.id, debit: "0", credit: amount,
            description: "إضافة صافي الربح للأرباح المحتجزة", sortOrder: 1 },
        ]
      : [
          { entryId: entry.id, accountId: re.id, debit: amount, credit: "0",
            description: "تخفيض الأرباح المحتجزة بصافي الخسارة", sortOrder: 0 },
          { entryId: entry.id, accountId: pl.id, debit: "0", credit: amount,
            description: "إقفال رصيد الأرباح والخسائر", sortOrder: 1 },
        ];
    await db.insert(journalEntryLinesTable).values(lines);

    res.json({ ok: true, entryId: entry.id, isProfit, amount: parseFloat(amount), net });
  } catch (e: any) { res.status(500).json({ error: "فشل ترحيل الأرباح: " + (e.message ?? "خطأ") }); }
});

// ─── POST /api/fiscal/periods/:id/soft-close — open → closed ─────────────
// Runs validate first; refuses if any blocker exists. The user can pass
// `force: true` to override (logged but allowed).
router.post("/periods/:id/soft-close", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const force = req.body?.force === true;

    const period = await fetchPeriod(cid, id);
    if (!period) { res.status(404).json({ error: "الفترة غير موجودة" }); return; }
    if (period.status !== "open") { res.status(400).json({ error: "الفترة ليست مفتوحة" }); return; }

    // Inline validation re-run (don't call the route handler — keep it pure)
    const drafts = await db.select({ id: journalEntriesTable.id })
      .from(journalEntriesTable).where(and(
        eq(journalEntriesTable.companyId, cid),
        eq(journalEntriesTable.status, "draft"),
        gte(journalEntriesTable.entryDate, period.startDate),
        lte(journalEntriesTable.entryDate, period.endDate),
      ));
    const balRows = await db.select({
      entryId: journalEntryLinesTable.entryId,
      debit:   sql<string>`coalesce(sum(${journalEntryLinesTable.debit}), 0)`,
      credit:  sql<string>`coalesce(sum(${journalEntryLinesTable.credit}), 0)`,
    })
    .from(journalEntryLinesTable)
    .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
    .where(and(
      eq(journalEntriesTable.companyId, cid),
      eq(journalEntriesTable.status, "posted"),
      gte(journalEntriesTable.entryDate, period.startDate),
      lte(journalEntriesTable.entryDate, period.endDate),
    ))
    .groupBy(journalEntryLinesTable.entryId);
    const unbalanced = balRows.filter(r => Math.abs(parseFloat(r.debit || "0") - parseFloat(r.credit || "0")) > 0.01);

    // IFRS-aligned guard: revenue/expense accounts must be zeroed out via
    // close-pl before soft-closing the period. Otherwise the user ends up
    // with a "closed" period whose income statement still carries balances
    // — which is exactly the bug that left fiscal year 2025 in a broken
    // state for company 18 (closed without closing entries).
    // `force=true` still allows monthly soft-close where P&L closing only
    // happens at year-end, but the response now reports the open balances
    // so the UI can warn explicitly.
    const revBal  = await balancesByType(cid, period.startDate, period.endDate, "revenue");
    const expBal  = await balancesByType(cid, period.startDate, period.endDate, "expense");
    const openRev = revBal.filter(r => Math.abs(r.balance) > 0.005);
    const openExp = expBal.filter(r => Math.abs(r.balance) > 0.005);
    const plOpen  = openRev.length > 0 || openExp.length > 0;

    if (!force && (drafts.length > 0 || unbalanced.length > 0 || plOpen)) {
      const reasons: string[] = [];
      if (drafts.length > 0)     reasons.push(`${drafts.length} قيد غير مرحّل`);
      if (unbalanced.length > 0) reasons.push(`${unbalanced.length} قيد غير متوازن`);
      if (plOpen) reasons.push(
        `حسابات الإيرادات والمصروفات لم تُقفل بعد (${openRev.length} إيراد، ${openExp.length} مصروف برصيد غير صفري). شغّل "إقفال الأرباح والخسائر" ثم "ترحيل الأرباح" أولاً`
      );
      res.status(400).json({
        error: "لا يمكن إقفال الفترة — " + reasons.join("؛ ") + ". استخدم force=true لتجاوز التحذير",
        drafts: drafts.length, unbalanced: unbalanced.length,
        openRevenueAccounts: openRev.length, openExpenseAccounts: openExp.length,
        requiresPlClose: plOpen,
      });
      return;
    }

    const [updated] = await db.update(fiscalPeriodsTable)
      .set({ status: "closed", updatedAt: new Date() })
      .where(eq(fiscalPeriodsTable.id, id)).returning();
    res.json({ ok: true, period: updated, forced: force, plClosed: !plOpen });
  } catch (e: any) { res.status(500).json({ error: e.message ?? "خطأ" }); }
});

// ─── POST /api/fiscal/periods/:id/hard-close — closed → permanently_closed ──
// IFRS-aligned: hard-close is irreversible (audit-trail final state), so we
// MUST verify that the closing-entries cycle actually ran. Specifically:
//   • At least one `closing_revenue` OR `closing_expense` JE exists for the
//     period (the close-pl step ran), AND
//   • At least one `closing_transfer_profit` OR `closing_transfer_loss` JE
//     exists for the period (the transfer-profit step ran).
// Without these checks, hitting hard-close prematurely (as happened with
// fiscal year 2025 for company 18) leaves the books mathematically wrong
// AND permanently locked. There is intentionally NO `force` override here —
// recovery requires the SuperAdmin force-reopen endpoint below.
router.post("/periods/:id/hard-close", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const period = await fetchPeriod(cid, id);
    if (!period) { res.status(404).json({ error: "الفترة غير موجودة" }); return; }
    if (period.status === "permanently_closed") { res.json({ ok: true, alreadyClosed: true }); return; }
    if (period.status !== "closed") {
      res.status(400).json({ error: "يجب إجراء الإقفال الناعم أولاً قبل الإقفال النهائي" });
      return;
    }

    // Verify closing entries exist for this period.
    const closingEntries = await db.select({
      entryType: journalEntriesTable.entryType,
    }).from(journalEntriesTable).where(and(
      eq(journalEntriesTable.companyId, cid),
      eq(journalEntriesTable.periodId, period.id),
      inArray(journalEntriesTable.entryType, [
        "closing_revenue", "closing_expense",
        "closing_transfer_profit", "closing_transfer_loss",
      ]),
    ));
    const types = new Set(closingEntries.map(e => e.entryType));
    const hasPlClose   = types.has("closing_revenue") || types.has("closing_expense");
    const hasTransfer  = types.has("closing_transfer_profit") || types.has("closing_transfer_loss");

    // If the period has no revenue/expense activity at all, close-pl is
    // legitimately a no-op and there's nothing to transfer. Allow the
    // hard-close in that case (e.g. dormant company / sub-period).
    const revBal = await balancesByType(cid, period.startDate, period.endDate, "revenue");
    const expBal = await balancesByType(cid, period.startDate, period.endDate, "expense");
    const hadPlActivity =
      revBal.some(r => Math.abs(r.balance) > 0.005) ||
      expBal.some(e => Math.abs(e.balance) > 0.005) ||
      hasPlClose;

    if (hadPlActivity && (!hasPlClose || !hasTransfer)) {
      const missing: string[] = [];
      if (!hasPlClose)  missing.push('قيد إقفال الإيرادات/المصروفات (Close P&L)');
      if (!hasTransfer) missing.push('قيد ترحيل صافي الربح أو الخسارة (Transfer Profit)');
      res.status(400).json({
        error: "لا يمكن الإقفال النهائي — قيود الإقفال المحاسبية لم تُولَّد لهذه الفترة. المفقود: " + missing.join("، "),
        missing,
        hasClosePl: hasPlClose,
        hasTransferProfit: hasTransfer,
      });
      return;
    }

    const [updated] = await db.update(fiscalPeriodsTable)
      .set({ status: "permanently_closed", updatedAt: new Date() })
      .where(eq(fiscalPeriodsTable.id, id)).returning();
    res.json({ ok: true, period: updated });
  } catch (e: any) { res.status(500).json({ error: e.message ?? "خطأ" }); }
});

// ─── POST /api/fiscal/periods/:id/force-reopen — SuperAdmin recovery ─────
// Last-resort escape hatch for periods that were prematurely hard-closed
// (status === "permanently_closed") without the required closing entries.
// The standard PATCH /status endpoint refuses to touch permanently_closed
// periods, which is correct under IFRS — but it leaves no recovery path
// when the closing flow itself was misused.
//
// Restrictions:
//   • SuperAdmin role only (regular admins cannot bypass IFRS audit lock).
//   • Requires a non-empty `reason` string in the body — logged to the
//     server log as an audit trail.
//   • Sets status back to "open" so the standard close-pl → transfer-profit
//     → soft-close → hard-close cycle can be redone properly.
//   • Cascades to the parent fiscal year if it's also permanently_closed,
//     so the year doesn't stay locked while one of its periods is open.
router.post("/periods/:id/force-reopen", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    if ((req as any).authUser?.role !== "superadmin") {
      res.status(403).json({ error: "هذا الإجراء متاح للسوبر أدمن فقط" }); return;
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const reason = String(req.body?.reason ?? "").trim();
    if (reason.length < 10) {
      res.status(400).json({ error: "سبب فك القفل مطلوب (10 أحرف على الأقل)" }); return;
    }

    const period = await fetchPeriod(cid, id);
    if (!period) { res.status(404).json({ error: "الفترة غير موجودة" }); return; }
    if (period.status === "open") { res.json({ ok: true, alreadyOpen: true }); return; }

    (req as any).log?.warn?.({
      action: "fiscal_period_force_reopen",
      companyId: cid,
      periodId: period.id,
      periodName: period.name,
      previousStatus: period.status,
      userId: (req as any).authUser?.id,
      reason,
    }, `SuperAdmin force-reopened fiscal period ${period.name}`);

    const [updated] = await db.update(fiscalPeriodsTable)
      .set({ status: "open", updatedAt: new Date() })
      .where(eq(fiscalPeriodsTable.id, id)).returning();

    // If the parent year is anything other than open (closed or
    // permanently_closed), unlock it too — otherwise the year-level
    // writability guard would still block writes inside the just-reopened
    // period (dates in period gaps would also remain blocked).
    await db.update(fiscalYearsTable)
      .set({ status: "open", updatedAt: new Date() })
      .where(and(
        eq(fiscalYearsTable.id, period.fiscalYearId),
        eq(fiscalYearsTable.companyId, cid),
        ne(fiscalYearsTable.status, "open"),
      ));

    res.json({ ok: true, period: updated, reason });
  } catch (e: any) { res.status(500).json({ error: e.message ?? "خطأ" }); }
});

export default router;
