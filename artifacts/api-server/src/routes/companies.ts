import { Router } from "express";
import { db } from "@workspace/db";
import { companiesTable, usersTable, subscriptionsTable, invoicesTable, invoiceLineItemsTable, customersTable, suppliersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateCompanyBody, UpdateCompanyBody } from "@workspace/api-zod";
import { extractAuth } from "../middleware/auth.js";

const router = Router();

router.get("/", async (req, res) => {
  const companies = await db.select().from(companiesTable).orderBy(companiesTable.createdAt);
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
  res.status(201).json(company);
});

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, id));
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
  const [company] = await db.update(companiesTable).set({
    ...data,
    updatedAt: new Date(),
  }).where(eq(companiesTable.id, id)).returning();
  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }
  res.json(company);
});

// PATCH /:id/general-settings — update logo + decimal places + auto-posting toggle
router.patch("/:id/general-settings", async (req, res) => {
  const id = parseInt(req.params.id);
  const { logo, decimalPlaces, autoPostingEnabled } = req.body as {
    logo?: string; decimalPlaces?: number; autoPostingEnabled?: boolean;
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
function authorizePosSettings(req: any, res: any, id: number): boolean {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرّح" }); return false; }
  if (u.role === "superadmin") return true;
  if (u.role === "admin" && u.companyId === id) return true;
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
  if (!authorizePosSettings(req, res, id)) return;
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

router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // Cascade: delete all related records before deleting company
    const companyInvoices = await db.select({ id: invoicesTable.id }).from(invoicesTable).where(eq(invoicesTable.companyId, id));
    for (const inv of companyInvoices) {
      await db.delete(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, inv.id));
    }
    await db.delete(invoicesTable).where(eq(invoicesTable.companyId, id));
    await db.delete(customersTable).where(eq(customersTable.companyId, id));
    await db.delete(suppliersTable).where(eq(suppliersTable.companyId, id));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.companyId, id));
    await db.delete(usersTable).where(eq(usersTable.companyId, id));
    await db.delete(companiesTable).where(eq(companiesTable.id, id));

    res.status(204).send();
  } catch (err: any) {
    res.status(500).json({ error: "فشل الحذف: " + (err.message ?? "خطأ غير متوقع") });
  }
});

export default router;
