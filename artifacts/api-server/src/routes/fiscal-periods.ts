import { Router } from "express";
import { db } from "@workspace/db";
import { fiscalYearsTable, fiscalPeriodsTable } from "@workspace/db";
import { eq, and, asc, ne } from "drizzle-orm";
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

    // Locked: permanently_closed cannot be changed
    if (current.status === "permanently_closed") {
      res.status(400).json({ error: "لا يمكن التعديل على فترة مغلقة نهائياً" }); return;
    }
    // Closed → only allowed: re-open or permanently close
    if (current.status === "closed" && status === "open") {
      // allow re-open
    }

    const [updated] = await db.update(fiscalPeriodsTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(fiscalPeriodsTable.id, id)).returning();

    res.json({ ok: true, period: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "خطأ" });
  }
});

// ─── PATCH /api/fiscal-years/:id/status — close/reopen entire year ─────
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
      res.status(400).json({ error: "لا يمكن التعديل على سنة مالية مغلقة نهائياً" }); return;
    }

    const [updated] = await db.update(fiscalYearsTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(fiscalYearsTable.id, id)).returning();

    // Cascade to periods (without overwriting permanently_closed)
    await db.update(fiscalPeriodsTable)
      .set({ status, updatedAt: new Date() })
      .where(and(
        eq(fiscalPeriodsTable.fiscalYearId, id),
        eq(fiscalPeriodsTable.companyId, cid),
        ne(fiscalPeriodsTable.status, "permanently_closed"),
      ));

    res.json({ ok: true, year: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "خطأ" });
  }
});

export default router;
