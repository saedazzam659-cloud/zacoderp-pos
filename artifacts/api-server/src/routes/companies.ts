import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { companiesTable, usersTable, subscriptionsTable, invoicesTable, invoiceLineItemsTable, customersTable, suppliersTable, cashBoxesTable, bankAccountsTable, accountsTable } from "@workspace/db";
import { eq, and, isNull, asc } from "drizzle-orm";
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
  // Authorization: only a SuperAdmin or an admin of THIS company may change
  // tenant-wide settings. Without this guard, any authenticated user (even
  // from a different company) could PATCH another tenant's logo, decimals,
  // posting flags, or journalEntryFormMode.
  const u = (req as any).authUser;
  if (!u) { res.status(401).json({ error: "غير مصرّح" }); return; }
  if (u.role !== "superadmin" && !(u.companyId === id && u.role === "admin")) {
    res.status(403).json({ error: "ليست لديك صلاحية لتعديل إعدادات هذه الشركة" });
    return;
  }
  const {
    logo, decimalPlaces, autoPostingEnabled,
    // Per-doc-type auto-posting toggles. Each one independently decides
    // whether saving that document immediately posts the resulting journal
    // entry. Validated as plain booleans below.
    autoPostJournalEntry,
    autoPostSales, autoPostPurchase, autoPostReceipt, autoPostPayment,
    autoPostFinancial, autoPostCashTransfer, autoPostPayroll,
    // Phase-1 additions: every other module that produces a JE.
    autoPostProduction, autoPostStockMovement, autoPostGoodsReceipt,
    autoPostGoodsDelivery, autoPostAdjustment,
    autoPostFaAcquisition, autoPostFaDepreciation, autoPostFaDisposal,
    faAutoDepDay,
    autoPostCtgOutgoingBill, autoPostCtgIncomingBill,
    faAssetCostAccountId, faAccumDepreciationAccountId,
    faDepreciationExpenseAccountId, faAcquisitionClearingAccountId,
    faDisposalGainAccountId, faDisposalLossAccountId,
    printFooterInvoice, printFooterReturn, printShowTimestamp, printShowZatcaBrand,
    printEnabledTemplates, printDefaultTemplate,
    // Per-doc-type print preferences (auto-print toggle + template name).
    // Each `printAutoAfterSave*` is a boolean; each `printTemplate*` is
    // either "a4" or "thermal".  Validated below before write so we never
    // persist garbage that other surfaces would have to defensively parse.
    printAutoAfterSaveSales, printAutoAfterSaveReceipt,
    printAutoAfterSavePayment, printAutoAfterSaveJournal,
    printTemplateSales, printTemplateReceipt,
    printTemplatePayment, printTemplateJournal,
    // Journal-entry form behavior: "auto" (keep form open + fresh draft) or
    // "manual" (navigate back to entries list after save). See companies
    // schema for the full semantics.
    journalEntryFormMode,
  } = req.body as {
    logo?: string; decimalPlaces?: number; autoPostingEnabled?: boolean;
    autoPostJournalEntry?: boolean;
    autoPostSales?: boolean; autoPostPurchase?: boolean;
    autoPostReceipt?: boolean; autoPostPayment?: boolean;
    autoPostFinancial?: boolean; autoPostCashTransfer?: boolean;
    autoPostPayroll?: boolean;
    autoPostProduction?: boolean; autoPostStockMovement?: boolean;
    autoPostGoodsReceipt?: boolean; autoPostGoodsDelivery?: boolean;
    autoPostAdjustment?: boolean;
    autoPostFaAcquisition?: boolean; autoPostFaDepreciation?: boolean;
    autoPostFaDisposal?: boolean;
    faAutoDepDay?: number;
    autoPostCtgOutgoingBill?: boolean; autoPostCtgIncomingBill?: boolean;
    faAssetCostAccountId?: number | null;
    faAccumDepreciationAccountId?: number | null;
    faDepreciationExpenseAccountId?: number | null;
    faAcquisitionClearingAccountId?: number | null;
    faDisposalGainAccountId?: number | null;
    faDisposalLossAccountId?: number | null;
    printFooterInvoice?: string; printFooterReturn?: string;
    printShowTimestamp?: boolean; printShowZatcaBrand?: boolean;
    printEnabledTemplates?: number[] | null; printDefaultTemplate?: number;
    printAutoAfterSaveSales?: boolean; printAutoAfterSaveReceipt?: boolean;
    printAutoAfterSavePayment?: boolean; printAutoAfterSaveJournal?: boolean;
    printTemplateSales?: string; printTemplateReceipt?: string;
    printTemplatePayment?: string; printTemplateJournal?: string;
    journalEntryFormMode?: string;
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
  // Per-doc-type auto-posting toggles — coerce to boolean so we never persist
  // a string "false" (which would be truthy in the form layer) by accident.
  if (autoPostJournalEntry !== undefined) updates.autoPostJournalEntry = !!autoPostJournalEntry;
  if (autoPostSales        !== undefined) updates.autoPostSales        = !!autoPostSales;
  if (autoPostPurchase     !== undefined) updates.autoPostPurchase     = !!autoPostPurchase;
  if (autoPostReceipt      !== undefined) updates.autoPostReceipt      = !!autoPostReceipt;
  if (autoPostPayment      !== undefined) updates.autoPostPayment      = !!autoPostPayment;
  if (autoPostFinancial    !== undefined) updates.autoPostFinancial    = !!autoPostFinancial;
  if (autoPostCashTransfer !== undefined) updates.autoPostCashTransfer = !!autoPostCashTransfer;
  if (autoPostPayroll      !== undefined) updates.autoPostPayroll      = !!autoPostPayroll;
  if (autoPostProduction    !== undefined) updates.autoPostProduction    = !!autoPostProduction;
  if (autoPostStockMovement !== undefined) updates.autoPostStockMovement = !!autoPostStockMovement;
  if (autoPostGoodsReceipt  !== undefined) updates.autoPostGoodsReceipt  = !!autoPostGoodsReceipt;
  if (autoPostGoodsDelivery !== undefined) updates.autoPostGoodsDelivery = !!autoPostGoodsDelivery;
  if (autoPostAdjustment    !== undefined) updates.autoPostAdjustment    = !!autoPostAdjustment;
  if (autoPostFaAcquisition  !== undefined) updates.autoPostFaAcquisition  = !!autoPostFaAcquisition;
  if (autoPostFaDepreciation !== undefined) updates.autoPostFaDepreciation = !!autoPostFaDepreciation;
  if (autoPostFaDisposal     !== undefined) updates.autoPostFaDisposal     = !!autoPostFaDisposal;
  if (faAutoDepDay !== undefined) {
    const d = Math.floor(Number(faAutoDepDay));
    if (!Number.isFinite(d) || d < 1 || d > 28) {
      res.status(400).json({ error: "يوم الترحيل التلقائي يجب أن يكون بين 1 و 28" }); return;
    }
    updates.faAutoDepDay = d;
  }
  if (autoPostCtgOutgoingBill !== undefined) updates.autoPostCtgOutgoingBill = !!autoPostCtgOutgoingBill;
  if (autoPostCtgIncomingBill !== undefined) updates.autoPostCtgIncomingBill = !!autoPostCtgIncomingBill;
  for (const k of [
    "faAssetCostAccountId","faAccumDepreciationAccountId","faDepreciationExpenseAccountId",
    "faAcquisitionClearingAccountId","faDisposalGainAccountId","faDisposalLossAccountId",
  ] as const) {
    const v = (req.body as any)[k];
    if (v !== undefined) updates[k] = v == null || v === "" ? null : Number(v);
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
  // Print template visibility list — accept an array of integer ids
  // (1..12), de-dup, drop garbage. Pass `null` (or empty array) to
  // reset to "all templates visible".
  if (printEnabledTemplates !== undefined) {
    if (printEnabledTemplates === null) {
      updates.printEnabledTemplates = null;
    } else if (!Array.isArray(printEnabledTemplates)) {
      res.status(400).json({ error: "قائمة النماذج المرئية يجب أن تكون مصفوفة" }); return;
    } else {
      const cleaned = Array.from(new Set(
        printEnabledTemplates
          .map((x) => Number(x))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12),
      )).sort((a, b) => a - b);
      updates.printEnabledTemplates = cleaned.length === 0 ? null : cleaned;
    }
  }
  if (printDefaultTemplate !== undefined) {
    const n = Number(printDefaultTemplate);
    if (!Number.isInteger(n) || n < 1 || n > 12) {
      res.status(400).json({ error: "النموذج الافتراضي يجب أن يكون رقماً بين 1 و 12" }); return;
    }
    updates.printDefaultTemplate = n;
  }
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
  // Journal-entry form mode — restrict to the two values the form actually
  // honors so a typo doesn't silently leave the field in an unknown state.
  if (journalEntryFormMode !== undefined) {
    if (journalEntryFormMode !== "auto" && journalEntryFormMode !== "manual") {
      res.status(400).json({ error: "journalEntryFormMode يجب أن يكون 'auto' أو 'manual'" });
      return;
    }
    updates.journalEntryFormMode = journalEntryFormMode;
  }
  const [company] = await db.update(companiesTable).set(updates)
    .where(eq(companiesTable.id, id)).returning();
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
  res.json(company);
});

// PATCH /:id/profile — tenant-facing identity edit (name, VAT, CR, address).
// Previously these fields were only editable by SuperAdmin via PUT /:id from
// the companies admin screen, which forced tenants to call support to fix a
// typo in their own VAT/CR. This endpoint exposes a narrow, whitelisted
// subset to anyone with the `company_profile.edit` permission on their own
// company — no other company can be touched.
router.patch("/:id/profile", async (req, res) => {
  const id = parseInt(req.params.id);
  const u = (req as any).authUser;
  if (!u) { res.status(401).json({ error: "غير مصرّح" }); return; }
  // SuperAdmin always allowed; otherwise must belong to THIS company AND
  // either be admin OR carry the company_profile.edit granular permission.
  if (u.role !== "superadmin") {
    if (u.companyId !== id) {
      res.status(403).json({ error: "لا يمكنك تعديل بيانات شركة أخرى" }); return;
    }
    const perms = (u.permissions || {}) as Record<string, any>;
    const cp = perms.company_profile;
    const hasEdit = u.role === "admin" || (cp && (cp.edit === true || cp === true));
    if (!hasEdit) {
      res.status(403).json({ error: "ليست لديك صلاحية تعديل بيانات الشركة" }); return;
    }
  }
  const {
    nameAr, nameEn, vatNumber, crNumber, country, city, district,
    street, buildingNumber, postalCode, additionalNumber, industryName,
  } = req.body as Record<string, string | undefined>;
  const updates: Record<string, any> = { updatedAt: new Date() };
  const setStr = (k: string, v: string | undefined, max = 200, min = 0) => {
    if (v === undefined) return null;
    const s = String(v).trim();
    if (s.length < min) return `${k} قصير جداً`;
    if (s.length > max) return `${k} يتجاوز الحد المسموح`;
    updates[k] = s;
    return null;
  };
  for (const [k, v, max, min] of [
    ["nameAr", nameAr, 200, 1], ["nameEn", nameEn, 200, 0],
    ["country", country, 2, 0], ["city", city, 100, 0],
    ["district", district, 100, 0], ["street", street, 200, 0],
    ["buildingNumber", buildingNumber, 20, 0], ["postalCode", postalCode, 10, 0],
    ["additionalNumber", additionalNumber, 20, 0], ["industryName", industryName, 100, 0],
  ] as const) {
    const err = setStr(k, v as any, max, min);
    if (err) { res.status(400).json({ error: err }); return; }
  }
  // VAT: ZATCA spec — exactly 15 digits, starts and ends with "3".
  if (vatNumber !== undefined) {
    const v = String(vatNumber).trim();
    if (v && !/^3\d{13}3$/.test(v)) {
      res.status(400).json({ error: "الرقم الضريبي يجب أن يكون 15 رقماً يبدأ وينتهي بـ 3" }); return;
    }
    updates.vatNumber = v;
  }
  if (crNumber !== undefined) {
    const v = String(crNumber).trim();
    if (v && !/^\d{4,15}$/.test(v)) {
      res.status(400).json({ error: "رقم السجل التجاري يجب أن يكون أرقاماً (4–15)" }); return;
    }
    updates.crNumber = v;
  }
  if (Object.keys(updates).length === 1) {
    res.status(400).json({ error: "لا يوجد ما يتم تحديثه" }); return;
  }
  const [company] = await db.update(companiesTable).set(updates)
    .where(and(eq(companiesTable.id, id), isNull(companiesTable.deletedAt))).returning();
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
  req.log?.info?.({ companyId: id, by: u.id, fields: Object.keys(updates) }, "company.profile.updated");
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

// POST /:id/pos-settings/ai-suggest — AI suggests cashbox + bank accounts for each POS payment method.
router.post("/:id/pos-settings/ai-suggest", extractAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: "معرّف الشركة غير صالح" }); return; }
  if (!authorizePosSettings(req, res, id)) return;

  const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const OPENAI_KEY = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!OPENAI_BASE || !OPENAI_KEY) {
    res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير متاحة" });
    return;
  }

  try {
    const [cashBoxes, bankAccounts, accounts] = await Promise.all([
      db.select({
        id: cashBoxesTable.id, code: cashBoxesTable.code, nameAr: cashBoxesTable.nameAr,
        nameEn: cashBoxesTable.nameEn, accountId: cashBoxesTable.accountId, isActive: cashBoxesTable.isActive,
      }).from(cashBoxesTable).where(eq(cashBoxesTable.companyId, id)).orderBy(asc(cashBoxesTable.code)),
      db.select({
        id: bankAccountsTable.id, code: bankAccountsTable.code, nameAr: bankAccountsTable.nameAr,
        nameEn: bankAccountsTable.nameEn, bankName: bankAccountsTable.bankName,
        accountId: bankAccountsTable.accountId, isActive: bankAccountsTable.isActive,
      }).from(bankAccountsTable).where(eq(bankAccountsTable.companyId, id)).orderBy(asc(bankAccountsTable.code)),
      db.select({
        id: accountsTable.id, code: accountsTable.code, nameAr: accountsTable.nameAr,
      }).from(accountsTable).where(eq(accountsTable.companyId, id)),
    ]);

    const cbs = cashBoxes.filter((c) => c.isActive).slice(0, 80);
    const bas = bankAccounts.filter((b) => b.isActive).slice(0, 80);
    if (cbs.length === 0 && bas.length === 0) {
      res.status(400).json({ error: "لا توجد صناديق نقدية أو حسابات بنكية معرّفة" });
      return;
    }
    const accMap = new Map(accounts.map((a) => [a.id, a]));
    const fmt = (ar: string, en: string | null | undefined) => en ? ar + " / " + en : ar;
    const accLabel = (accId: number | null | undefined) => {
      if (!accId) return "(بدون حساب محاسبي)";
      const a = accMap.get(accId);
      return a ? a.code + " — " + a.nameAr : "(بدون حساب محاسبي)";
    };

    const cbList = cbs.length
      ? cbs.map((c) => c.id + "|" + c.code + "|" + fmt(c.nameAr, c.nameEn) + "|" + accLabel(c.accountId)).join("\n")
      : "(لا توجد صناديق نقدية)";
    const baList = bas.length
      ? bas.map((b) => b.id + "|" + b.code + "|" + fmt(b.nameAr, b.nameEn) + (b.bankName ? " (" + b.bankName + ")" : "") + "|" + accLabel(b.accountId)).join("\n")
      : "(لا توجد حسابات بنكية)";

    const systemPrompt = "أنت خبير عمليات نقاط البيع في السعودية. ستحصل على قائمة الصناديق النقدية والحسابات البنكية للشركة. مهمتك: اختيار أنسب وجهة لكل طريقة دفع POS. قواعد:\n" +
      "- posCashCashBoxId: id من قائمة الصناديق النقدية فقط (للنقد المباشر).\n" +
      "- posCardBankAccountId / posAppleBankAccountId / posWalletBankAccountId: id من قائمة الحسابات البنكية فقط (مدى/فيزا/Apple Pay/STC Pay).\n" +
      "- فضّل الحسابات التي اسمها يدل على نقاط البيع/الشبكة/Apple Pay/المحفظة. إن لم يوجد تطابق واضح، اختر أول حساب بنكي عام نشط.\n" +
      "- إن لم توجد قائمة (فارغة)، أعد null.\n" +
      "ردّ بصيغة JSON فقط بهذا الشكل:\n" +
      "{\n" +
      '  "posCashCashBoxId":       { "id": <number|null>, "reason": "<سبب قصير بالعربية>" },\n' +
      '  "posCardBankAccountId":   { "id": <number|null>, "reason": "..." },\n' +
      '  "posAppleBankAccountId":  { "id": <number|null>, "reason": "..." },\n' +
      '  "posWalletBankAccountId": { "id": <number|null>, "reason": "..." }\n' +
      "}";
    const userMsg =
      "الصناديق النقدية (id|code|name|account):\n" + cbList +
      "\n\nالحسابات البنكية (id|code|name|account):\n" + baList;

    const r = await fetch(OPENAI_BASE + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + OPENAI_KEY },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMsg },
        ],
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(502).json({ error: "فشل الذكاء الاصطناعي: " + r.status + " " + txt.slice(0, 200) });
      return;
    }
    const data: any = await r.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(content); } catch { /* ignore */ }

    const validCb = new Set(cbs.map((c) => c.id));
    const validBa = new Set(bas.map((b) => b.id));
    const out: Record<string, { id: number | null; reason: string; label?: string }> = {};

    const pickFrom = (key: string, validSet: Set<number>, list: typeof cbs | typeof bas) => {
      const v = parsed?.[key] ?? {};
      const numId = Number.isFinite(Number(v?.id)) ? Number(v.id) : null;
      const okId = numId && validSet.has(numId) ? numId : null;
      const row = okId ? list.find((x) => x.id === okId) : undefined;
      out[key] = {
        id: okId,
        reason: String(v?.reason ?? ""),
        label: row ? fmt(row.nameAr, row.nameEn) : undefined,
      };
    };
    pickFrom("posCashCashBoxId",       validCb, cbs);
    pickFrom("posCardBankAccountId",   validBa, bas);
    pickFrom("posAppleBankAccountId",  validBa, bas);
    pickFrom("posWalletBankAccountId", validBa, bas);

    res.json({ suggestions: out, source: "ai" });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "AI suggestion failed" });
  }
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
