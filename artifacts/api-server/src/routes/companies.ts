import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { companiesTable, usersTable, subscriptionsTable, invoicesTable, invoiceLineItemsTable, customersTable, suppliersTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { CreateCompanyBody, UpdateCompanyBody } from "@workspace/api-zod";
import { extractAuth } from "../middleware/auth.js";
import { requirePermission, audit } from "../middleware/permissions.js";
import { seedDefaultChartOfAccounts } from "../lib/seedDefaultChartOfAccounts.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Hard auth gate — every endpoint here touches tenant-level data, so anonymous
// callers must be rejected before reaching any handler. Admin / superadmin then
// pass all granular permission checks below.
router.use(extractAuth);
router.use((req: Request, res: Response, next: NextFunction) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

router.get("/", async (req, res) => {
  // Exclude soft-deleted companies — those live in the recycle bin and
  // are accessed exclusively through GET /admin/companies/deleted.
  const companies = await db
    .select()
    .from(companiesTable)
    .where(isNull(companiesTable.deletedAt))
    .orderBy(companiesTable.createdAt);
  res.json(companies);
});

router.post("/", async (req, res) => {
  const parsed = CreateCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  const [company] = await db.insert(companiesTable).values({
    nameAr: data.nameAr,
    nameEn: data.nameEn,
    vatNumber: data.vatNumber,
    crNumber: data.crNumber,
    city: data.city,
    district: data.district,
    street: data.street,
    buildingNumber: data.buildingNumber,
    postalCode: data.postalCode,
    additionalNumber: data.additionalNumber,
    country: data.country ?? "SA",
    industryName: data.industryName,
    invoiceType: data.invoiceType ?? "both",
    isSandbox: data.isSandbox ?? false,
    serialNumber: data.serialNumber,
    deviceSerial1: data.deviceSerial1,
    deviceSerial2: data.deviceSerial2,
    deviceSerial3: data.deviceSerial3,
    zatcaCsid: data.zatcaCsid,
    zatcaPcsid: data.zatcaPcsid,
  }).returning();

  // Auto-seed the standard commercial chart of accounts so the new tenant
  // can post journal entries immediately without a manual import step.
  // Failures are logged but do not block company creation — the user can
  // re-seed later from the chart-of-accounts screen.
  try {
    await seedDefaultChartOfAccounts(company.id);
  } catch (err) {
    logger.error({ err, companyId: company.id }, "default-coa.seed-failed");
  }

  res.status(201).json(company);
});

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  // Soft-deleted companies are off-limits to every regular consumer; only
  // /admin/companies/deleted exposes them.
  const [company] = await db
    .select()
    .from(companiesTable)
    .where(and(eq(companiesTable.id, id), isNull(companiesTable.deletedAt)));
  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }
  res.json(company);
});

router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const parsed = UpdateCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  // Refuse to update soft-deleted companies — restoring is the only way
  // to make a trashed tenant editable again.
  const [company] = await db.update(companiesTable).set({
    ...data,
    updatedAt: new Date(),
  }).where(and(eq(companiesTable.id, id), isNull(companiesTable.deletedAt))).returning();
  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }
  res.json(company);
});

// PATCH /:id/general-settings — update logo + decimal places + auto-posting toggle
router.patch("/:id/general-settings", async (req, res) => {
  const id = parseInt(req.params.id);
  const {
    logo, decimalPlaces, autoPostingEnabled,
    printFooterInvoice, printFooterReturn, printShowTimestamp, printShowZatcaBrand,
    // Per-doc-type print preferences (auto-print toggle + template name).
    // Each `printAutoAfterSave*` is a boolean; each `printTemplate*` is
    // either "a4" or "thermal".  Validated below before write so we never
    // persist garbage that other surfaces would have to defensively parse.
    printAutoAfterSaveSales, printAutoAfterSaveReceipt,
    printAutoAfterSavePayment, printAutoAfterSaveJournal,
    printTemplateSales, printTemplateReceipt,
    printTemplatePayment, printTemplateJournal,
  } = req.body as {
    logo?: string; decimalPlaces?: number; autoPostingEnabled?: boolean;
    printFooterInvoice?: string; printFooterReturn?: string;
    printShowTimestamp?: boolean; printShowZatcaBrand?: boolean;
    printAutoAfterSaveSales?: boolean; printAutoAfterSaveReceipt?: boolean;
    printAutoAfterSavePayment?: boolean; printAutoAfterSaveJournal?: boolean;
    printTemplateSales?: string; printTemplateReceipt?: string;
    printTemplatePayment?: string; printTemplateJournal?: string;
  };
  const updates: Record<string, any> = { updatedAt: new Date() };
  if (logo !== undefined) updates.logo = logo;
  if (decimalPlaces !== undefined) {
    const dp = Number(decimalPlaces);
    if (isNaN(dp) || dp < 0 || dp > 4) {
      res.status(400).json({ error: "عدد الأرقام العشرية يجب أن يكون بين 0 و 4" }); return;
    }
    updates.decimalPlaces = dp;
  }
  if (autoPostingEnabled !== undefined) {
    updates.autoPostingEnabled = !!autoPostingEnabled;
  }
  if (printFooterInvoice !== undefined) {
    const v = String(printFooterInvoice).trim();
    if (v.length > 200) {
      res.status(400).json({ error: "نص تذييل الفاتورة يجب ألا يتجاوز 200 حرف" }); return;
    }
    updates.printFooterInvoice = v;
  }
  if (printFooterReturn !== undefined) {
    const v = String(printFooterReturn).trim();
    if (v.length > 200) {
      res.status(400).json({ error: "نص تذييل المرتجع يجب ألا يتجاوز 200 حرف" }); return;
    }
    updates.printFooterReturn = v;
  }
  if (printShowTimestamp !== undefined) updates.printShowTimestamp = !!printShowTimestamp;
  if (printShowZatcaBrand !== undefined) updates.printShowZatcaBrand = !!printShowZatcaBrand;
  // Auto-print toggles — coerce to boolean.
  if (printAutoAfterSaveSales   !== undefined) updates.printAutoAfterSaveSales   = !!printAutoAfterSaveSales;
  if (printAutoAfterSaveReceipt !== undefined) updates.printAutoAfterSaveReceipt = !!printAutoAfterSaveReceipt;
  if (printAutoAfterSavePayment !== undefined) updates.printAutoAfterSavePayment = !!printAutoAfterSavePayment;
  if (printAutoAfterSaveJournal !== undefined) updates.printAutoAfterSaveJournal = !!printAutoAfterSaveJournal;
  // Template selectors — restrict to the two layouts the app actually
  // implements.  Anything else is rejected up-front so a typo in the
  // client doesn't silently disable auto-print downstream.
  const validTemplate = (v: any) => v === "a4" || v === "thermal";
  for (const [key, val] of [
    ["printTemplateSales",    printTemplateSales],
    ["printTemplateReceipt",  printTemplateReceipt],
    ["printTemplatePayment",  printTemplatePayment],
    ["printTemplateJournal",  printTemplateJournal],
  ] as const) {
    if (val !== undefined) {
      if (!validTemplate(val)) {
        res.status(400).json({ error: `قيمة نموذج الطباعة غير صالحة لـ ${key}` }); return;
      }
      updates[key] = val;
    }
  }
  const [company] = await db.update(companiesTable).set(updates)
    .where(eq(companiesTable.id, id)).returning();
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
  res.json(company);
});

// PATCH /:id/menu-permissions — update which menus are visible for company users
router.patch("/:id/menu-permissions", async (req, res) => {
  const id = parseInt(req.params.id);
  const { menuPermissions } = req.body as { menuPermissions?: string };
  if (!menuPermissions) {
    res.status(400).json({ error: "menuPermissions مطلوب" });
    return;
  }
  // Validate JSON
  try { JSON.parse(menuPermissions); } catch {
    res.status(400).json({ error: "menuPermissions يجب أن يكون JSON صالح" });
    return;
  }
  const [company] = await db.update(companiesTable).set({
    menuPermissions,
    updatedAt: new Date(),
  }).where(eq(companiesTable.id, id)).returning();
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
  res.json(company);
});

// PATCH /:id/zatca-settings — update device info + sandbox toggle (called by company users)
router.patch("/:id/zatca-settings", async (req, res) => {
  const id = parseInt(req.params.id);
  const { serialNumber, deviceSerial1, deviceSerial2, deviceSerial3, isSandbox } = req.body;
  const [company] = await db.update(companiesTable).set({
    ...(serialNumber !== undefined && { serialNumber }),
    ...(deviceSerial1 !== undefined && { deviceSerial1 }),
    ...(deviceSerial2 !== undefined && { deviceSerial2 }),
    ...(deviceSerial3 !== undefined && { deviceSerial3 }),
    ...(isSandbox !== undefined && { isSandbox }),
    updatedAt: new Date(),
  }).where(eq(companiesTable.id, id)).returning();
  if (!company) { res.status(404).json({ error: "Company not found" }); return; }
  res.json(company);
});

// Authorization helper: only superadmin or an admin of this same company.
// Pass `readOnly=true` for GET endpoints — cashiers in the same company also
// need to read POS settings so they can map payment methods to the right
// cashbox/bank account when ringing up a sale.
function authorizePosSettings(req: any, res: any, id: number, readOnly = false): boolean {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرّح" }); return false; }
  if (u.role === "superadmin") return true;
  if (u.companyId === id) {
    if (readOnly) return true;
    if (u.role === "admin") return true;
  }
  res.status(403).json({ error: "ليست لديك صلاحية لهذه العملية" });
  return false;
}

// Coerce to a positive integer or null. Anything else → "invalid".
function toNullableId(v: unknown): number | null | "invalid" {
  if (v === null || v === undefined || v === "" || v === 0) return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return "invalid";
  return n;
}

// GET /:id/pos-settings — current POS payment-method → account mappings.
router.get("/:id/pos-settings", extractAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: "معرّف الشركة غير صالح" }); return; }
  if (!authorizePosSettings(req, res, id, true)) return;
  const [c] = await db.select({
    posCashCashBoxId:       companiesTable.posCashCashBoxId,
    posCardBankAccountId:   companiesTable.posCardBankAccountId,
    posAppleBankAccountId:  companiesTable.posAppleBankAccountId,
    posWalletBankAccountId: companiesTable.posWalletBankAccountId,
  }).from(companiesTable).where(eq(companiesTable.id, id));
  if (!c) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
  res.json(c);
});

// PATCH /:id/pos-settings — admin/superadmin sets the cashbox/bank-account for each POS method.
router.patch("/:id/pos-settings", extractAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: "معرّف الشركة غير صالح" }); return; }
  if (!authorizePosSettings(req, res, id)) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: Record<string, any> = { updatedAt: new Date() };
  for (const key of [
    "posCashCashBoxId",
    "posCardBankAccountId",
    "posAppleBankAccountId",
    "posWalletBankAccountId",
  ] as const) {
    if (key in body) {
      const v = toNullableId(body[key]);
      if (v === "invalid") { res.status(400).json({ error: `قيمة ${key} غير صالحة` }); return; }
      updates[key] = v;
    }
  }

  const [company] = await db.update(companiesTable).set(updates)
    .where(eq(companiesTable.id, id)).returning();
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
  res.json({
    posCashCashBoxId:       company.posCashCashBoxId,
    posCardBankAccountId:   company.posCardBankAccountId,
    posAppleBankAccountId:  company.posAppleBankAccountId,
    posWalletBankAccountId: company.posWalletBankAccountId,
  });
});

// DELETE /:id — SOFT delete. Sets companies.deletedAt and deactivates every
// company user (so nobody can keep an active session on a "deleted" tenant).
// The company stays in the recycle bin until SuperAdmin either restores it
// or hard-deletes it from /admin/companies/deleted. NO related rows are
// touched here — restore must yield exactly the original tenant.
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "معرّف الشركة غير صالح" });
      return;
    }
    // Atomic: company-flip + force-logout must succeed or fail together.
    // Otherwise a partial failure could leave a "deleted" tenant whose
    // users keep working sessions, or active users on a still-live tenant.
    const company = await db.transaction(async (tx) => {
      const [c] = await tx
        .update(companiesTable)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(companiesTable.id, id), isNull(companiesTable.deletedAt)))
        .returning();
      if (!c) return null;
      // Force-logout: clear session tokens and mark inactive so any open
      // browser tab on this tenant fails the next /api/auth/me check.
      await tx.update(usersTable)
        .set({ isActive: false, sessionToken: null, sessionId: null, updatedAt: new Date() })
        .where(eq(usersTable.companyId, id));
      return c;
    });
    if (!company) {
      res.status(404).json({ error: "الشركة غير موجودة أو محذوفة بالفعل" });
      return;
    }
    res.status(204).send();
  } catch (err: any) {
    res.status(500).json({ error: "فشل الحذف: " + (err.message ?? "خطأ غير متوقع") });
  }
});

export default router;
