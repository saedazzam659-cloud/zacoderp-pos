import { Router } from "express";
import { db } from "@workspace/db";
import { taxesTable, accountsTable, branchesTable, costCentersTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { ensureCompanyTaxes } from "../lib/companyTaxes.js";

const router = Router();
router.use(extractAuth);
// Permission gate uses the "accounts" module key to match the frontend
// (App.tsx PermRoute module="accounts" + Layout nav permKey "accounts").
// Taxes live UNDER «الحسابات العامة» and have no separate grantable
// permission key, so gating on "taxes" would let a user SEE the screen
// (granted "accounts") yet hit 403 on every tax mutation. Company-level
// gate is identical either way (COMPANY_MODULE_GATE maps both to "accounts").
router.use(requireModulePermission("accounts"));
router.use(moduleAudit("taxes"));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

const VALID_RATE_TYPES = new Set(["percent", "fixed"]);

// Validate that the referenced GL account belongs to this company (soft check).
async function accountOk(cid: number, id: any): Promise<boolean> {
  if (id === undefined || id === null || id === "") return true;
  const [row] = await db.select({ id: accountsTable.id }).from(accountsTable)
    .where(and(eq(accountsTable.id, Number(id)), eq(accountsTable.companyId, cid)));
  return !!row;
}
async function branchOk(cid: number, id: any): Promise<boolean> {
  if (id === undefined || id === null || id === "") return true;
  const [row] = await db.select({ id: branchesTable.id }).from(branchesTable)
    .where(and(eq(branchesTable.id, Number(id)), eq(branchesTable.companyId, cid)));
  return !!row;
}
// Cost center is stored as a CODE (text), mirroring journal_entry_lines.cost_center.
// Validate that a cost center with this code exists for the same company (parity
// with the account/branch ownership checks).
async function costCenterOk(cid: number, code: any): Promise<boolean> {
  if (code === undefined || code === null || String(code).trim() === "") return true;
  const [row] = await db.select({ id: costCentersTable.id }).from(costCentersTable)
    .where(and(eq(costCentersTable.code, String(code).trim()), eq(costCentersTable.companyId, cid)));
  return !!row;
}

function intOrNull(v: any): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function strOrNull(v: any): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// ─── LIST ───────────────────────────────────────────────────────────────────
// Lazily ensures the protected ZATCA system VAT exists for the company.
router.get("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    await ensureCompanyTaxes(cid);
    const rows = await db.select().from(taxesTable)
      .where(eq(taxesTable.companyId, cid))
      .orderBy(asc(taxesTable.code));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DEFAULT ──────────────────────────────────────────────────────────────────
// Returns the company default tax (falls back to the system tax). Registered
// BEFORE /:id so the literal "default" is not swallowed by the param route.
router.get("/default", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    await ensureCompanyTaxes(cid);
    const [def] = await db.select().from(taxesTable)
      .where(and(eq(taxesTable.companyId, cid), eq(taxesTable.isDefault, true)));
    if (def) { res.json(def); return; }
    const [sys] = await db.select().from(taxesTable)
      .where(and(eq(taxesTable.companyId, cid), eq(taxesTable.isSystem, true)));
    res.json(sys ?? null);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET ONE ──────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const [row] = await db.select().from(taxesTable)
      .where(and(eq(taxesTable.id, id), eq(taxesTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "الضريبة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── CREATE ───────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const code   = strOrNull(b.code);
    const nameAr = strOrNull(b.nameAr);
    if (!code || !nameAr) { res.status(400).json({ error: "كود الضريبة واسمها العربي مطلوبان" }); return; }

    const rateType = VALID_RATE_TYPES.has(b.rateType) ? b.rateType : "percent";
    const rateNum  = Number(b.rate);
    if (!Number.isFinite(rateNum) || rateNum < 0) { res.status(400).json({ error: "نسبة/قيمة الضريبة غير صالحة" }); return; }

    if (!(await accountOk(cid, b.accountId)))            { res.status(400).json({ error: "الحساب المحدد غير صحيح" }); return; }
    if (!(await accountOk(cid, b.salesTaxAccountId)))    { res.status(400).json({ error: "حساب ضريبة المبيعات غير صحيح" }); return; }
    if (!(await accountOk(cid, b.purchaseTaxAccountId))) { res.status(400).json({ error: "حساب ضريبة المشتريات غير صحيح" }); return; }
    if (!(await branchOk(cid, b.branchId)))              { res.status(400).json({ error: "الفرع المحدد غير صحيح" }); return; }
    if (!(await costCenterOk(cid, b.costCenter)))        { res.status(400).json({ error: "مركز التكلفة المحدد غير صحيح" }); return; }

    const makeDefault = b.isDefault === true;

    const row = await db.transaction(async (tx) => {
      if (makeDefault) {
        await tx.update(taxesTable).set({ isDefault: false })
          .where(and(eq(taxesTable.companyId, cid), eq(taxesTable.isDefault, true)));
      }
      const [created] = await tx.insert(taxesTable).values({
        companyId: cid,
        code, nameAr,
        nameEn: strOrNull(b.nameEn),
        rate: String(rateNum),
        rateType,
        currencyCode: strOrNull(b.currencyCode),
        branchId: intOrNull(b.branchId),
        costCenter: strOrNull(b.costCenter),
        accountId: intOrNull(b.accountId),
        salesTaxAccountId: intOrNull(b.salesTaxAccountId),
        purchaseTaxAccountId: intOrNull(b.purchaseTaxAccountId),
        isActive: b.isActive === false ? false : true,
        isDefault: makeDefault,
        isSystem: false, // never client-settable
        notes: strOrNull(b.notes),
      }).returning();
      return created;
    });
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── SET DEFAULT ────────────────────────────────────────────────────────────
// Registered BEFORE PUT/DELETE /:id is irrelevant (different methods) but kept
// above for clarity. Atomically clears the prior default and sets this one.
router.post("/:id/set-default", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const row = await db.transaction(async (tx) => {
      const [target] = await tx.select().from(taxesTable)
        .where(and(eq(taxesTable.id, id), eq(taxesTable.companyId, cid)));
      if (!target) return null;
      await tx.update(taxesTable).set({ isDefault: false })
        .where(and(eq(taxesTable.companyId, cid), eq(taxesTable.isDefault, true)));
      const [updated] = await tx.update(taxesTable)
        .set({ isDefault: true, isActive: true, updatedAt: new Date() })
        .where(and(eq(taxesTable.id, id), eq(taxesTable.companyId, cid))).returning();
      return updated;
    });
    if (!row) { res.status(404).json({ error: "الضريبة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const b = req.body ?? {};

    const [existing] = await db.select().from(taxesTable)
      .where(and(eq(taxesTable.id, id), eq(taxesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "الضريبة غير موجودة" }); return; }

    const code   = strOrNull(b.code) ?? existing.code;
    const nameAr = strOrNull(b.nameAr) ?? existing.nameAr;

    // System (ZATCA) tax: rate + rateType are locked at 15% percent so the
    // ZATCA path is never broken. Other fields (names, accounts, active) editable.
    let rateType = existing.rateType;
    let rateStr  = existing.rate;
    if (!existing.isSystem) {
      if (b.rateType !== undefined) rateType = VALID_RATE_TYPES.has(b.rateType) ? b.rateType : existing.rateType;
      if (b.rate !== undefined) {
        const rateNum = Number(b.rate);
        if (!Number.isFinite(rateNum) || rateNum < 0) { res.status(400).json({ error: "نسبة/قيمة الضريبة غير صالحة" }); return; }
        rateStr = String(rateNum);
      }
    }

    if (b.accountId !== undefined && !(await accountOk(cid, b.accountId)))                       { res.status(400).json({ error: "الحساب المحدد غير صحيح" }); return; }
    if (b.salesTaxAccountId !== undefined && !(await accountOk(cid, b.salesTaxAccountId)))       { res.status(400).json({ error: "حساب ضريبة المبيعات غير صحيح" }); return; }
    if (b.purchaseTaxAccountId !== undefined && !(await accountOk(cid, b.purchaseTaxAccountId))) { res.status(400).json({ error: "حساب ضريبة المشتريات غير صحيح" }); return; }
    if (b.branchId !== undefined && !(await branchOk(cid, b.branchId)))                          { res.status(400).json({ error: "الفرع المحدد غير صحيح" }); return; }
    if (b.costCenter !== undefined && !(await costCenterOk(cid, b.costCenter)))                   { res.status(400).json({ error: "مركز التكلفة المحدد غير صحيح" }); return; }

    // System tax must remain active (it is the ZATCA fallback).
    const nextActive = existing.isSystem ? true : (b.isActive !== undefined ? b.isActive === true : existing.isActive);
    const makeDefault = b.isDefault === true && !existing.isDefault;

    const row = await db.transaction(async (tx) => {
      if (makeDefault) {
        await tx.update(taxesTable).set({ isDefault: false })
          .where(and(eq(taxesTable.companyId, cid), eq(taxesTable.isDefault, true)));
      }
      const [updated] = await tx.update(taxesTable).set({
        code, nameAr,
        nameEn: b.nameEn !== undefined ? strOrNull(b.nameEn) : existing.nameEn,
        rate: rateStr,
        rateType,
        currencyCode: b.currencyCode !== undefined ? strOrNull(b.currencyCode) : existing.currencyCode,
        branchId: b.branchId !== undefined ? intOrNull(b.branchId) : existing.branchId,
        costCenter: b.costCenter !== undefined ? strOrNull(b.costCenter) : existing.costCenter,
        accountId: b.accountId !== undefined ? intOrNull(b.accountId) : existing.accountId,
        salesTaxAccountId: b.salesTaxAccountId !== undefined ? intOrNull(b.salesTaxAccountId) : existing.salesTaxAccountId,
        purchaseTaxAccountId: b.purchaseTaxAccountId !== undefined ? intOrNull(b.purchaseTaxAccountId) : existing.purchaseTaxAccountId,
        isActive: nextActive,
        isDefault: makeDefault ? true : existing.isDefault,
        updatedAt: new Date(),
      }).where(and(eq(taxesTable.id, id), eq(taxesTable.companyId, cid))).returning();
      return updated;
    });
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE ───────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const [existing] = await db.select().from(taxesTable)
      .where(and(eq(taxesTable.id, id), eq(taxesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "الضريبة غير موجودة" }); return; }
    if (existing.isSystem) { res.status(400).json({ error: "لا يمكن حذف ضريبة النظام (ضريبة هيئة الزكاة والدخل)" }); return; }
    if (existing.isDefault) { res.status(400).json({ error: "لا يمكن حذف الضريبة الافتراضية — عيّن ضريبة افتراضية أخرى أولاً" }); return; }
    await db.delete(taxesTable).where(and(eq(taxesTable.id, id), eq(taxesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
