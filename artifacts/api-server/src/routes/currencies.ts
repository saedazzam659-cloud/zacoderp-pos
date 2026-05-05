import { Router } from "express";
import { db } from "@workspace/db";
import { currenciesTable, exchangeRatesTable } from "@workspace/db";
import { eq, and, asc, desc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("currencies"));
router.use(moduleAudit("currencies"));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

// ════════════════════════════════════════════
// CURRENCIES
// ════════════════════════════════════════════

router.get("/", async (req, res) => {
  try {
    const cid = getCid(req);
    const rows = cid
      ? await db.select().from(currenciesTable).where(eq(currenciesTable.companyId, cid)).orderBy(asc(currenciesTable.code))
      : [];
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { code, nameAr, nameEn, symbol, isDefault, isActive, notes } = req.body;
    if (!code || !nameAr) { res.status(400).json({ error: "الكود والاسم العربي مطلوبان" }); return; }

    if (isDefault) {
      await db.update(currenciesTable).set({ isDefault: false }).where(eq(currenciesTable.companyId, cid));
    }

    const [row] = await db.insert(currenciesTable).values({
      companyId: cid, code, nameAr, nameEn: nameEn || null,
      symbol: symbol || null, isDefault: isDefault ?? false,
      isActive: isActive ?? true, notes: notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const { code, nameAr, nameEn, symbol, isDefault, isActive, notes } = req.body;

    if (isDefault) {
      await db.update(currenciesTable).set({ isDefault: false }).where(eq(currenciesTable.companyId, cid));
    }

    const [row] = await db.update(currenciesTable).set({
      code, nameAr, nameEn: nameEn || null,
      symbol: symbol || null, isDefault: isDefault ?? false,
      isActive: isActive ?? true, notes: notes || null,
      updatedAt: new Date(),
    }).where(and(eq(currenciesTable.id, id), eq(currenciesTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "العملة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const rates = await db.select().from(exchangeRatesTable)
      .where(and(
        eq(exchangeRatesTable.companyId, cid),
      ));
    const linked = rates.filter(r => r.fromCurrencyId === id || r.toCurrencyId === id);
    if (linked.length > 0) {
      res.status(400).json({ error: "لا يمكن حذف عملة مرتبطة بمعاملات تحويل" }); return;
    }
    await db.delete(currenciesTable).where(and(eq(currenciesTable.id, id), eq(currenciesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// RATE LOOKUP — multi-currency conversion helper
// Used by anywhere that needs to convert a foreign-currency amount
// into the company's base currency at a historical date (IAS 21).
//
// Strategy:
//   1) If `fromCode === toCode` → rate is exactly 1.
//   2) Find the most recent exchange_rates row with effective_date ≤ asOf
//      AND from_currency = fromCode AND to_currency = toCode → return its rate.
//   3) Try the inverse (toCode → fromCode) and return 1/rate.
//   4) Otherwise return rate=1 with `fallback=true` so the UI can warn.
// ════════════════════════════════════════════
router.get("/lookup-rate", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const fromCode = String(req.query.fromCode ?? "").toUpperCase().trim();
    const toCode   = String(req.query.toCode   ?? "").toUpperCase().trim();
    const asOf     = String(req.query.asOf ?? new Date().toISOString().slice(0, 10));
    if (!fromCode || !toCode) { res.status(400).json({ error: "fromCode و toCode مطلوبان" }); return; }

    if (fromCode === toCode) {
      res.json({ rate: "1", source: "identity", fromCode, toCode, asOf });
      return;
    }

    const codes = await db.select().from(currenciesTable)
      .where(eq(currenciesTable.companyId, cid));
    const fromCur = codes.find(c => c.code.toUpperCase() === fromCode);
    const toCur   = codes.find(c => c.code.toUpperCase() === toCode);
    if (!fromCur || !toCur) {
      res.json({ rate: "1", source: "missing-currency", fromCode, toCode, asOf, fallback: true });
      return;
    }

    // IAS 21: only use rates with effective_date ≤ asOf (historical rate as
    // at the transaction date). Never return a future rate — surface a
    // fallback flag so the UI can warn the user to enter one manually.
    const direct = await db.select().from(exchangeRatesTable)
      .where(and(
        eq(exchangeRatesTable.companyId, cid),
        eq(exchangeRatesTable.fromCurrencyId, fromCur.id),
        eq(exchangeRatesTable.toCurrencyId,   toCur.id),
      ))
      .orderBy(desc(exchangeRatesTable.effectiveDate))
      .limit(20);
    const direct1 = direct.find(r => r.effectiveDate <= asOf);
    if (direct1) {
      res.json({
        rate: String(direct1.rate),
        source: "direct",
        effectiveDate: direct1.effectiveDate,
        fromCode, toCode, asOf,
      });
      return;
    }

    const inverse = await db.select().from(exchangeRatesTable)
      .where(and(
        eq(exchangeRatesTable.companyId, cid),
        eq(exchangeRatesTable.fromCurrencyId, toCur.id),
        eq(exchangeRatesTable.toCurrencyId,   fromCur.id),
      ))
      .orderBy(desc(exchangeRatesTable.effectiveDate))
      .limit(20);
    const inv1 = inverse.find(r => r.effectiveDate <= asOf);
    if (inv1) {
      const r = Number(inv1.rate);
      if (r > 0) {
        res.json({
          rate: (1 / r).toFixed(6),
          source: "inverse",
          effectiveDate: inv1.effectiveDate,
          fromCode, toCode, asOf,
        });
        return;
      }
    }

    res.json({ rate: "1", source: "no-rate", fromCode, toCode, asOf, fallback: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// EXCHANGE RATES
// ════════════════════════════════════════════

router.get("/rates", async (req, res) => {
  try {
    const cid = getCid(req);
    const rows = cid
      ? await db.select().from(exchangeRatesTable)
          .where(eq(exchangeRatesTable.companyId, cid))
          .orderBy(desc(exchangeRatesTable.effectiveDate))
      : [];
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/rates", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { fromCurrencyId, toCurrencyId, rate, effectiveDate, notes } = req.body;
    if (!fromCurrencyId || !toCurrencyId || !rate || !effectiveDate) {
      res.status(400).json({ error: "جميع الحقول مطلوبة" }); return;
    }
    const [row] = await db.insert(exchangeRatesTable).values({
      companyId: cid,
      fromCurrencyId: Number(fromCurrencyId),
      toCurrencyId:   Number(toCurrencyId),
      rate:           String(rate),
      effectiveDate,
      notes: notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/rates/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const { fromCurrencyId, toCurrencyId, rate, effectiveDate, notes } = req.body;
    const [row] = await db.update(exchangeRatesTable).set({
      fromCurrencyId: Number(fromCurrencyId),
      toCurrencyId:   Number(toCurrencyId),
      rate:           String(rate),
      effectiveDate,
      notes: notes || null,
      updatedAt: new Date(),
    }).where(and(eq(exchangeRatesTable.id, id), eq(exchangeRatesTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "معامل التحويل غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/rates/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    await db.delete(exchangeRatesTable).where(and(eq(exchangeRatesTable.id, id), eq(exchangeRatesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
