import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { companiesTable, usersTable, subscriptionsTable, invoicesTable, invoiceLineItemsTable, customersTable, suppliersTable, cashBoxesTable, bankAccountsTable, accountsTable } from "@workspace/db";
import { eq, and, isNull, asc, sql } from "drizzle-orm";
import { CreateCompanyBody, UpdateCompanyBody } from "@workspace/api-zod";
import { z } from "zod";
import { extractAuth } from "../middleware/auth.js";
import { requirePermission, audit } from "../middleware/permissions.js";
import { seedDefaultChartOfAccounts } from "../lib/seedDefaultChartOfAccounts.js";
import { logger } from "../lib/logger.js";
import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";
import { requireAiFeature, logAiUsage } from "../middleware/requireAiFeature.js";
import { encryptSecret, testCompanySender } from "../lib/email.js";

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
    .where(and(
      isNull(companiesTable.deletedAt),
      eq(companiesTable.isInternalDemoWorkspace, false),
    ))
    .orderBy(companiesTable.createdAt);

  // SuperAdmin: merge companies that live on agent (full_shell) databases so
  // the dashboard can see/manage them too. Each agent row is tagged with
  // `agentInstanceId`/`agentName`; the client sends `?agent=<id>` back on
  // per-company admin ops so the handler re-routes into that agent DB.
  // Agent DB failures are per-agent non-fatal — the central list must load.
  const authUser = (req as any).authUser;
  if (authUser?.role === "superadmin") {
    try {
      const { listInitializedAgents } = await import("../lib/agentScope.js");
      const { runWithExternalDb } = await import("@workspace/db");
      const { getAgentDbContext } = await import("../lib/agentDb.js");
      const agents = await listInitializedAgents();
      const merged: any[] = [...companies];
      for (const agent of agents) {
        try {
          const ctx = getAgentDbContext(agent.id, agent.dbUrlEnc);
          const rows = await runWithExternalDb(ctx, async () =>
            db.select().from(companiesTable)
              .where(and(
                isNull(companiesTable.deletedAt),
                eq(companiesTable.isInternalDemoWorkspace, false),
              ))
              .orderBy(companiesTable.createdAt),
          );
          for (const r of rows) merged.push({ ...r, agentInstanceId: agent.id, agentName: agent.name });
        } catch (e: any) {
          logger.warn({ agentId: agent.id, err: e?.message }, "companies list: agent DB unreachable");
        }
      }
      res.json(merged);
      return;
    } catch (e: any) {
      logger.warn({ err: e?.message }, "companies list: agent merge failed");
    }
  }
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
    phone: data.phone,
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
    // New tenants default to the legacy "manual" journal-entry form mode
    // (close screen + return to list after each save). They can switch to
    // the faster "auto" continuous-entry mode from الإعدادات العامة.
    journalEntryFormMode: "manual",
  }).returning();

  // Seed the new tenant from the designated TEMPLATE company (display
  // settings, numbering sequences, chart of accounts — without the template's
  // party sub-accounts). Falls back to the generic default COA when the
  // template company doesn't exist. Failures are logged but do not block
  // company creation — the user can re-seed later.
  try {
    const { applyCompanyTemplateDefaults } = await import("../lib/companyTemplate.js");
    // Internally falls back to seedDefaultChartOfAccounts whenever the
    // template is missing/empty or its COA clone fails.
    await applyCompanyTemplateDefaults(company.id);
  } catch (err) {
    logger.error({ err, companyId: company.id }, "default-coa.seed-failed");
    try { await seedDefaultChartOfAccounts(company.id); } catch { /* logged above */ }
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

// PUT /:id/rename — SuperAdmin-only rename (nameAr / optional nameEn).
// `?agent=<id>` routes the rename into that agent's external DB via
// runWithAgentScope. Deliberately a dedicated route: the generic PUT
// requires the FULL UpdateCompanyBody, while rename patches one field.
router.put("/:id/rename", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "معرّف الشركة غير صالح" });
      return;
    }
    const u = (req as any).authUser;
    if (!u || u.role !== "superadmin") {
      res.status(403).json({ error: "تعديل اسم الشركة متاح للمشرف العام فقط" });
      return;
    }
    // Strict agent selector: a present-but-malformed `?agent=` must be
    // rejected, never silently treated as a central-DB request.
    const rawAgent = req.query?.agent;
    if (rawAgent !== undefined) {
      const agentId = Number(Array.isArray(rawAgent) ? rawAgent[0] : rawAgent);
      if (!Number.isInteger(agentId) || agentId <= 0) {
        res.status(400).json({ error: "معرّف الوكيل غير صالح" });
        return;
      }
    }
    const RenameBody = z.object({
      nameAr: z.string().trim().min(1, "اسم الشركة مطلوب").max(255),
      nameEn: z.string().trim().max(255).optional(),
    });
    const parsed = RenameBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
      return;
    }
    const { runWithAgentScope } = await import("../lib/agentScope.js");
    await runWithAgentScope(req, res, async () => {
      const [company] = await db.update(companiesTable).set({
        nameAr: parsed.data.nameAr,
        ...(parsed.data.nameEn !== undefined ? { nameEn: parsed.data.nameEn } : {}),
        updatedAt: new Date(),
      }).where(and(eq(companiesTable.id, id), isNull(companiesTable.deletedAt))).returning();
      if (!company) { res.status(404).json({ error: "Company not found" }); return; }
      res.json(company);
    });
  } catch (err: any) {
    res.status(500).json({ error: "فشل تعديل الاسم" });
  }
});

router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const isHomingOnly =
    (req.body as any)?.homeDomainId !== undefined &&
    Object.keys(req.body ?? {}).every((k) => k === "homeDomainId");
  const parsed = UpdateCompanyBody.safeParse(req.body);
  if (!parsed.success && !isHomingOnly) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  // A homing-only request carries no company fields — apply only the home patch.
  const data = parsed.success ? parsed.data : {};
  // «النطاق الموطن» — SuperAdmin-only: home/unhome the company on a gateway
  // domain (main or agent). Sent outside UpdateCompanyBody so tenant admins
  // can never self-modify their login-isolation domain.
  let homePatch: { homeDomainId?: number | null } = {};
  const rawHome = (req.body as any)?.homeDomainId;
  if (rawHome !== undefined) {
    const u = (req as any).authUser;
    if (u?.role !== "superadmin") {
      res.status(403).json({ error: "توطين النطاق متاح للمشرف العام فقط" });
      return;
    }
    if (rawHome === null || rawHome === 0 || rawHome === "") {
      homePatch = { homeDomainId: null };
    } else {
      const hid = Number(rawHome);
      if (!Number.isInteger(hid) || hid <= 0) {
        res.status(400).json({ error: "معرّف النطاق غير صالح" });
        return;
      }
      const { companyDomainsTable } = await import("@workspace/db");
      const [row] = await db.select({
        id: companyDomainsTable.id,
        domain: companyDomainsTable.domain,
        companyId: companyDomainsTable.companyId,
        isMain: companyDomainsTable.isMain,
      }).from(companyDomainsTable).where(eq(companyDomainsTable.id, hid)).limit(1);
      if (!row) {
        res.status(400).json({ error: "النطاق غير موجود في شاشة النطاقات" });
        return;
      }
      // Homing is only meaningful on GATEWAY hosts: the platform's main
      // domains or an agent instance's reverse-proxy domain (matched
      // case-insensitively, including extra_domains entries of any casing —
      // same predicate as /register's agent-domain detection).
      const agentHit = await db.execute(sql`
        SELECT 1 FROM agent_instances
        WHERE lower(domain) = lower(${row.domain})
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(coalesce(extra_domains, '[]'::jsonb)) AS d(val)
             WHERE lower(d.val) = lower(${row.domain})
           )
        LIMIT 1
      `);
      const isAgentDomain = ((agentHit as any).rows?.length ?? 0) > 0;
      if (!row.isMain && !isAgentDomain) {
        res.status(400).json({ error: "لا يمكن التوطين إلا على نطاق رئيسي أو نطاق وكيل" });
        return;
      }
      // Heal an earlier mis-bind: gateway (agent) domains must never be
      // single-company-bound, or host resolution force-logs everyone into
      // that one company.
      if (isAgentDomain && row.companyId != null) {
        await db.update(companyDomainsTable)
          .set({ companyId: null, isPrimary: false })
          .where(eq(companyDomainsTable.id, hid));
      }
      homePatch = { homeDomainId: hid };
    }
  }
  // Refuse to update soft-deleted companies — restoring is the only way
  // to make a trashed tenant editable again.
  const [company] = await db.update(companiesTable).set({
    ...data,
    ...homePatch,
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
    logo, logoBase64, logoMime,
    brandLogo, brandLogoBase64, brandLogoMime,
    decimalPlaces, showZeros, hideQuickAddBar, autoPostingEnabled,
    // Per-doc-type auto-posting toggles. Each one independently decides
    // whether saving that document immediately posts the resulting journal
    // entry. Validated as plain booleans below.
    autoPostJournalEntry,
    autoPostSales, allowDraftWithoutWarehouse, autoPostPurchase, autoPostReceipt, autoPostPayment,
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
    bankAccountText, printShowItemsSummary,
    printT14ShowEnSubtitle, printT14ShowAccountCode, printT14ShowAuditFooter,
    printEnabledTemplates, printDefaultTemplate,
    printDefaultTemplateQuotation, printDefaultTemplateOrder, printDefaultTemplateReturn,
    invoicePrintLanguage,
    sequenceDateSource,
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
    // Optional UX prefs (company-wide). `journalSmartForm` toggles the smart
    // "model" journal-entry form; `menuLayout` is "sidebar" | "topnav".
    journalSmartForm,
    menuLayout,
    // Invoice/document entry-form layout: "tabbed" (new SAP-style) | "classic".
    invoiceFormLayout,
    // Account-statement print layout: "classic" (per-page view) | "unified"
    // (shared exportStatementToPDF renderer). Validated below.
    statementPrintFormat,
    // VAT calc mode: "before_discount" | "after_discount". Validated below.
    taxCalculationMode,
    // Document-archiving control center config. Validated + coerced below.
    archiveSettings,
  } = req.body as {
    logo?: string; logoBase64?: string | null; logoMime?: string;
    brandLogo?: string | null; brandLogoBase64?: string | null; brandLogoMime?: string;
    decimalPlaces?: number; showZeros?: boolean; hideQuickAddBar?: boolean; autoPostingEnabled?: boolean;
    autoPostJournalEntry?: boolean;
    autoPostSales?: boolean; autoPostPurchase?: boolean;
    allowDraftWithoutWarehouse?: boolean;
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
    bankAccountText?: string | null; printShowItemsSummary?: boolean;
    printT14ShowEnSubtitle?: boolean; printT14ShowAccountCode?: boolean; printT14ShowAuditFooter?: boolean;
    printEnabledTemplates?: number[] | null; printDefaultTemplate?: number;
    printDefaultTemplateQuotation?: number | null;
    printDefaultTemplateOrder?: number | null;
    printDefaultTemplateReturn?: number | null;
    invoicePrintLanguage?: string;
    sequenceDateSource?: string;
    printAutoAfterSaveSales?: boolean; printAutoAfterSaveReceipt?: boolean;
    printAutoAfterSavePayment?: boolean; printAutoAfterSaveJournal?: boolean;
    printTemplateSales?: string; printTemplateReceipt?: string;
    printTemplatePayment?: string; printTemplateJournal?: string;
    journalEntryFormMode?: string;
    journalSmartForm?: boolean;
    menuLayout?: string;
    invoiceFormLayout?: string;
    statementPrintFormat?: string;
    taxCalculationMode?: string;
    archiveSettings?: {
      defaultMode?: string;
      screens?: Record<string, string>;
      allowedUserIds?: number[];
    } | null;
  };
  const updates: Record<string, any> = { updatedAt: new Date() };
  // The client sends the logo as raw base64 (+ mime) — never a "data:" URL —
  // because the production edge WAF blocks "data:...;base64,..." bodies with a
  // 403 HTML page. Rebuild the data URL here so the stored format (and every
  // consumer: print templates, UI) stays unchanged. `logo` (full data URL) is
  // still accepted for backward compatibility with any older caller.
  if (logoBase64 !== undefined) {
    if (logoBase64 === null || logoBase64 === "") {
      updates.logo = null;
    } else {
      if (logoBase64.length > 5 * 1024 * 1024) {
        res.status(400).json({ error: "حجم الشعار كبير جداً" }); return;
      }
      const mime = typeof logoMime === "string" && /^image\/[\w.+-]+$/.test(logoMime)
        ? logoMime : "image/png";
      updates.logo = `data:${mime};base64,${logoBase64}`;
    }
  } else if (logo !== undefined) {
    updates.logo = logo;
  }
  // Brand mark (العلامة التجارية) — same WAF-safe raw-base64 transport and the
  // same stored data-URL format as the main logo.
  if (brandLogoBase64 !== undefined) {
    if (brandLogoBase64 === null || brandLogoBase64 === "") {
      updates.brandLogo = null;
    } else {
      if (brandLogoBase64.length > 5 * 1024 * 1024) {
        res.status(400).json({ error: "حجم العلامة التجارية كبير جداً" }); return;
      }
      const mime = typeof brandLogoMime === "string" && /^image\/[\w.+-]+$/.test(brandLogoMime)
        ? brandLogoMime : "image/png";
      updates.brandLogo = `data:${mime};base64,${brandLogoBase64}`;
    }
  } else if (brandLogo !== undefined) {
    updates.brandLogo = brandLogo;
  }
  if (decimalPlaces !== undefined) {
    const dp = Number(decimalPlaces);
    if (isNaN(dp) || dp < 0 || dp > 4) {
      res.status(400).json({ error: "عدد الأرقام العشرية يجب أن يكون بين 0 و 4" }); return;
    }
    updates.decimalPlaces = dp;
  }
  // Display-only "show zeros" toggle — coerce to boolean so we never persist a
  // string. Affects how numeric inputs render 0; no impact on stored data.
  if (showZeros !== undefined) updates.showZeros = !!showZeros;
  // UX-only toggle: hide the quick add-item bar on document item tabs.
  if (hideQuickAddBar !== undefined) updates.hideQuickAddBar = !!hideQuickAddBar;
  if (autoPostingEnabled !== undefined) {
    updates.autoPostingEnabled = !!autoPostingEnabled;
  }
  // Per-doc-type auto-posting toggles — coerce to boolean so we never persist
  // a string "false" (which would be truthy in the form layer) by accident.
  if (autoPostJournalEntry !== undefined) updates.autoPostJournalEntry = !!autoPostJournalEntry;
  if (autoPostSales        !== undefined) updates.autoPostSales        = !!autoPostSales;
  // Sales-invoice save policy — allow saving without a warehouse as a draft.
  if (allowDraftWithoutWarehouse !== undefined) updates.allowDraftWithoutWarehouse = !!allowDraftWithoutWarehouse;
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
  if (bankAccountText !== undefined) {
    const bt = bankAccountText === null ? "" : String(bankAccountText).trim().slice(0, 500);
    updates.bankAccountText = bt === "" ? null : bt;
  }
  if (printShowItemsSummary !== undefined) updates.printShowItemsSummary = !!printShowItemsSummary;
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
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 15),
      )).sort((a, b) => a - b);
      updates.printEnabledTemplates = cleaned.length === 0 ? null : cleaned;
    }
  }
  if (printDefaultTemplate !== undefined) {
    const n = Number(printDefaultTemplate);
    if (!Number.isInteger(n) || n < 1 || n > 15) {
      res.status(400).json({ error: "النموذج الافتراضي يجب أن يكون رقماً بين 1 و 15" }); return;
    }
    updates.printDefaultTemplate = n;
  }
  // Per-doc-type default template overrides (nullable — null clears the
  // override so the doc type falls back to the company-wide default).
  for (const [key, val] of [
    ["printDefaultTemplateQuotation", printDefaultTemplateQuotation],
    ["printDefaultTemplateOrder",     printDefaultTemplateOrder],
    ["printDefaultTemplateReturn",    printDefaultTemplateReturn],
  ] as const) {
    if (val === undefined) continue;
    if (val === null) { updates[key] = null; continue; }
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1 || n > 15) {
      res.status(400).json({ error: "النموذج الافتراضي لنوع المستند يجب أن يكون رقماً بين 1 و 15 أو فارغاً" }); return;
    }
    updates[key] = n;
  }
  if (invoicePrintLanguage !== undefined) {
    const v = String(invoicePrintLanguage);
    if (v !== "ar" && v !== "en") {
      res.status(400).json({ error: "لغة طباعة الفاتورة يجب أن تكون 'ar' أو 'en'" }); return;
    }
    updates.invoicePrintLanguage = v;
  }
  if (sequenceDateSource !== undefined) {
    const v = String(sequenceDateSource);
    if (v !== "system" && v !== "document") {
      res.status(400).json({ error: "مصدر التاريخ للمسلسل يجب أن يكون 'system' أو 'document'" }); return;
    }
    updates.sequenceDateSource = v;
  }
  // Template-14 («الأصلي») visibility toggles — coerce to boolean.
  if (printT14ShowEnSubtitle  !== undefined) updates.printT14ShowEnSubtitle  = !!printT14ShowEnSubtitle;
  if (printT14ShowAccountCode !== undefined) updates.printT14ShowAccountCode = !!printT14ShowAccountCode;
  if (printT14ShowAuditFooter !== undefined) updates.printT14ShowAuditFooter = !!printT14ShowAuditFooter;
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
  // Smart "model" journal-entry form — pure UX flag, coerced to boolean.
  if (journalSmartForm !== undefined) updates.journalSmartForm = !!journalSmartForm;
  // Menu placement — only the two layouts the UI implements.
  if (menuLayout !== undefined) {
    if (menuLayout !== "sidebar" && menuLayout !== "topnav") {
      res.status(400).json({ error: "menuLayout يجب أن يكون 'sidebar' أو 'topnav'" });
      return;
    }
    updates.menuLayout = menuLayout;
  }
  // Invoice/document entry-form layout — only the two layouts the UI implements.
  if (invoiceFormLayout !== undefined) {
    if (invoiceFormLayout !== "tabbed" && invoiceFormLayout !== "classic") {
      res.status(400).json({ error: "invoiceFormLayout يجب أن يكون 'tabbed' أو 'classic'" });
      return;
    }
    updates.invoiceFormLayout = invoiceFormLayout;
  }
  // Account-statement print layout — only the two renderers we support.
  if (statementPrintFormat !== undefined) {
    if (statementPrintFormat !== "classic" && statementPrintFormat !== "unified") {
      res.status(400).json({ error: "statementPrintFormat يجب أن يكون 'classic' أو 'unified'" });
      return;
    }
    updates.statementPrintFormat = statementPrintFormat;
  }
  // Tax calc mode — only the two values the line calculators understand.
  if (taxCalculationMode !== undefined) {
    if (taxCalculationMode !== "before_discount" && taxCalculationMode !== "after_discount") {
      res.status(400).json({ error: "taxCalculationMode يجب أن يكون 'before_discount' أو 'after_discount'" });
      return;
    }
    updates.taxCalculationMode = taxCalculationMode;
  }
  // Document-archiving config — sanitize each mode to the allowed enum and
  // coerce the user-id list to clean integers so we never persist garbage.
  if (archiveSettings !== undefined) {
    if (archiveSettings === null) {
      updates.archiveSettings = null;
    } else {
      const MODES = ["local", "cloud", "off"] as const;
      const coerceMode = (m: any): "local" | "cloud" | "off" =>
        MODES.includes(m) ? m : "local";
      const rawScreens = archiveSettings.screens && typeof archiveSettings.screens === "object"
        ? archiveSettings.screens : {};
      const screens: Record<string, "local" | "cloud" | "off"> = {};
      for (const [k, v] of Object.entries(rawScreens)) {
        if (typeof k === "string" && k) screens[k.slice(0, 64)] = coerceMode(v);
      }
      const allowedUserIds = Array.isArray(archiveSettings.allowedUserIds)
        ? Array.from(new Set(
            archiveSettings.allowedUserIds
              .map((n) => Number(n))
              .filter((n) => Number.isInteger(n) && n > 0),
          ))
        : [];
      updates.archiveSettings = {
        defaultMode: coerceMode(archiveSettings.defaultMode),
        screens,
        allowedUserIds,
      };
    }
  }
  const [company] = await db.update(companiesTable).set(updates)
    .where(eq(companiesTable.id, id)).returning();
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
  res.json(company);
});

// ─── ضبط المرسلات — per-company sender settings ─────────────────────────────
// Each company may define its OWN outbound sender: an email address (+ SMTP
// credentials for that mailbox) and a WhatsApp number. General (non-security)
// emails scoped to the company are then sent FROM that address; when unset,
// the system default sender (zacoderp@outlook.com via system SMTP) is used.
// The SMTP password is stored encrypted (AES-256-GCM) and NEVER returned to
// the client — only a hasPassword flag.

function senderSettingsGuard(req: Request, res: Response): number | null {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return null; }
  const u = (req as any).authUser;
  if (!u) { res.status(401).json({ error: "غير مصرّح" }); return null; }
  if (u.role !== "superadmin" && !(u.companyId === id && u.role === "admin")) {
    res.status(403).json({ error: "ليست لديك صلاحية لتعديل إعدادات المرسلات لهذه الشركة" });
    return null;
  }
  return id;
}

// GET /:id/sender-settings — current sender config (password NEVER included).
router.get("/:id/sender-settings", async (req, res) => {
  const id = senderSettingsGuard(req, res); if (id == null) return;
  try {
    const [row] = await db
      .select({
        senderEmail: companiesTable.senderEmail,
        senderSmtpHost: companiesTable.senderSmtpHost,
        senderSmtpPort: companiesTable.senderSmtpPort,
        senderSmtpPassEnc: companiesTable.senderSmtpPassEnc,
        senderWhatsapp: companiesTable.senderWhatsapp,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, id));
    if (!row) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
    res.json({
      senderEmail: row.senderEmail ?? "",
      senderSmtpHost: row.senderSmtpHost ?? "",
      senderSmtpPort: row.senderSmtpPort ?? 587,
      hasPassword: !!row.senderSmtpPassEnc,
      senderWhatsapp: row.senderWhatsapp ?? "",
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "تعذّر جلب إعدادات المرسلات" });
  }
});

// PUT /:id/sender-settings — update sender config. Password semantics:
//   undefined → keep the stored password unchanged
//   ""        → clear the stored password
//   "xxx"     → encrypt and store the new password
router.put("/:id/sender-settings", async (req, res) => {
  const id = senderSettingsGuard(req, res); if (id == null) return;
  try {
    const { senderEmail, senderSmtpHost, senderSmtpPort, senderSmtpPass, senderWhatsapp } = req.body ?? {};
    const updates: Record<string, any> = { updatedAt: new Date() };

    if (senderEmail !== undefined) {
      const v = String(senderEmail ?? "").trim();
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        res.status(400).json({ error: "صيغة البريد الإلكتروني غير صحيحة" }); return;
      }
      updates.senderEmail = v || null;
    }
    if (senderSmtpHost !== undefined) {
      const v = String(senderSmtpHost ?? "").trim().slice(0, 255);
      updates.senderSmtpHost = v || null;
    }
    if (senderSmtpPort !== undefined) {
      if (senderSmtpPort === null || senderSmtpPort === "") {
        updates.senderSmtpPort = null;
      } else {
        const p = Number(senderSmtpPort);
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          res.status(400).json({ error: "منفذ SMTP غير صالح (1-65535)" }); return;
        }
        updates.senderSmtpPort = p;
      }
    }
    if (senderSmtpPass !== undefined) {
      if (senderSmtpPass === null || senderSmtpPass === "") {
        updates.senderSmtpPassEnc = null;
      } else {
        const v = String(senderSmtpPass);
        if (v.length > 512) { res.status(400).json({ error: "كلمة المرور طويلة جداً" }); return; }
        updates.senderSmtpPassEnc = encryptSecret(v);
      }
    }
    if (senderWhatsapp !== undefined) {
      const v = String(senderWhatsapp ?? "").trim().slice(0, 32);
      if (v && !/^\+?[0-9\s-]{6,}$/.test(v)) {
        res.status(400).json({ error: "صيغة رقم الواتساب غير صحيحة" }); return;
      }
      updates.senderWhatsapp = v || null;
    }

    const [updated] = await db
      .update(companiesTable)
      .set(updates)
      .where(eq(companiesTable.id, id))
      .returning({ id: companiesTable.id });
    if (!updated) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "تعذّر حفظ إعدادات المرسلات" });
  }
});

// POST /:id/sender-settings/test — send a test email using the company sender
// (strict: if company SMTP is configured it MUST work; no silent fallback).
router.post("/:id/sender-settings/test", async (req, res) => {
  const id = senderSettingsGuard(req, res); if (id == null) return;
  try {
    const to = String(req.body?.to ?? "").trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      res.status(400).json({ error: "أدخل بريداً إلكترونياً صحيحاً للاختبار" }); return;
    }
    const r = await testCompanySender(id, to);
    if (!r.ok) {
      res.status(502).json({ error: `فشل الإرسال: ${r.reason ?? "غير معروف"}`, usedSender: r.usedSender, source: r.source });
      return;
    }
    res.json({ ok: true, usedSender: r.usedSender, source: r.source });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "تعذّر إرسال رسالة الاختبار" });
  }
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
    street, buildingNumber, postalCode, additionalNumber, industryName, phone,
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
    ["phone", phone, 30, 0],
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
  // Module grants are a SuperAdmin-only control — for BOTH central and
  // agent-DB companies (the router middleware only guarantees a logged-in
  // user, not a role).
  if ((req as any).authUser?.role !== "superadmin") {
    res.status(403).json({ error: "هذه العملية للمشرف العام فقط" });
    return;
  }
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
  // `?agent=<id>`: module grants for an AGENT-DB company (SuperAdmin only).
  const { runWithAgentScope } = await import("../lib/agentScope.js");
  await runWithAgentScope(req, res, async () => {
    const [company] = await db.update(companiesTable).set({
      menuPermissions,
      updatedAt: new Date(),
    }).where(eq(companiesTable.id, id)).returning();
    if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
    res.json(company);
  });
});

// PATCH /:id/windows-module-permissions — SuperAdmin-controlled visibility of
// the Windows desktop-app (artifacts/pos-desktop) modules for this company.
// Stored as a JSON object { <windows module key>: boolean }. Pushed to the
// device through /api/sync/pull (settings entity). Kept separate from
// menuPermissions because the Windows app has its own screen/module set.
router.patch("/:id/windows-module-permissions", async (req, res) => {
  const id = parseInt(req.params.id);
  const u = (req as any).authUser;
  // SuperAdmin-only: this controls the desktop-app module policy for ANY tenant,
  // so it must never be writable by a company admin/user (cross-tenant tampering).
  if (!u || u.role !== "superadmin") {
    res.status(403).json({ error: "هذه العملية مخصصة لمدير النظام فقط" });
    return;
  }
  const { windowsModulePermissions } = req.body as { windowsModulePermissions?: string };
  if (!windowsModulePermissions) {
    res.status(400).json({ error: "windowsModulePermissions مطلوب" });
    return;
  }
  // Validate JSON
  try { JSON.parse(windowsModulePermissions); } catch {
    res.status(400).json({ error: "windowsModulePermissions يجب أن يكون JSON صالح" });
    return;
  }
  const [company] = await db.update(companiesTable).set({
    windowsModulePermissions,
    updatedAt: new Date(),
  }).where(eq(companiesTable.id, id)).returning();
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
  res.json(company);
});

// PATCH /:id/zatca-settings — update device info + sandbox toggle (called by company users)
router.patch("/:id/zatca-settings", async (req, res) => {
  const id = parseInt(req.params.id);
  const { serialNumber, deviceSerial1, deviceSerial2, deviceSerial3, isSandbox, zatcaEnvironment } = req.body;
  // `zatcaEnvironment` (sandbox|simulation|production) is authoritative for the
  // ZATCA gateway URL; keep the legacy `isSandbox` boolean in sync so older
  // readers (admin status derivation) stay correct — only "production" is live.
  const validEnv = zatcaEnvironment === "sandbox" || zatcaEnvironment === "simulation" || zatcaEnvironment === "production";
  const [company] = await db.update(companiesTable).set({
    ...(serialNumber !== undefined && { serialNumber }),
    ...(deviceSerial1 !== undefined && { deviceSerial1 }),
    ...(deviceSerial2 !== undefined && { deviceSerial2 }),
    ...(deviceSerial3 !== undefined && { deviceSerial3 }),
    ...(validEnv && { zatcaEnvironment, isSandbox: zatcaEnvironment !== "production" }),
    ...(!validEnv && isSandbox !== undefined && { isSandbox }),
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
router.post("/:id/pos-settings/ai-suggest", extractAuth, requireAiFeature("pos_ai"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: "معرّف الشركة غير صالح" }); return; }
  if (!authorizePosSettings(req, res, id)) return;

  if (!isAIAvailable()) {
    await logAiUsage(req, { status: "error", meta: { reason: "ai-not-configured" } });
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

    const result = await aiChat([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ], { json: true,
      maxTokens: 800,
      providers: ["gemini"] });
    if (!result.ok) {
      await logAiUsage(req, { status: "error", meta: { reason: result.reason } });
      res.status(502).json({ error: "فشل الذكاء الاصطناعي: " + result.reason });
      return;
    }
    const parsed: any = result.data ?? {};
    await logAiUsage(req, { status: "allowed", provider: result.provider });

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
    await logAiUsage(req, { status: "error", meta: { error: String(e?.message || e) } });
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
    // `?agent=<id>`: soft-delete an AGENT-DB company (SuperAdmin only).
    const { runWithAgentScope } = await import("../lib/agentScope.js");
    await runWithAgentScope(req, res, () => softDeleteCompany(id, res));
  } catch (err: any) {
    res.status(500).json({ error: "فشل الحذف: " + (err.message ?? "خطأ غير متوقع") });
  }
});
async function softDeleteCompany(id: number, res: Response) {
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
}

export default router;
