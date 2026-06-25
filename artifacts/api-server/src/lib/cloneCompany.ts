import bcrypt from "bcryptjs";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  userBranchesTable,
  subscriptionsTable,
  regionsTable,
  branchesTable,
  costCentersTable,
  currenciesTable,
  exchangeRatesTable,
  accountsTable,
  accountingMappingsTable,
  warehouseGroupsTable,
  warehousesTable,
  itemGroupsTable,
  unitsTable,
  cashBoxesTable,
  bankAccountsTable,
  sequencesTable,
  invoiceFieldPolicyProfilesTable,
  userInvoiceFieldPoliciesTable,
  customPrintTemplatesTable,
  securityNotificationRulesTable,
  workSessionSettingsTable,
  companyCloneRunsTable,
} from "@workspace/db";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CloneCompanyIdentity {
  nameAr: string;
  nameEn?: string | null;
  vatNumber: string;
  crNumber: string;
  city: string;
  district?: string | null;
  street: string;
  buildingNumber: string;
  postalCode: string;
  additionalNumber?: string | null;
  phone?: string | null;
  country?: string | null;
  industryName?: string | null;
}

export interface CloneCompanyAdmin {
  username: string;
  password: string;
  nameAr?: string | null;
  nameEn?: string | null;
  email?: string | null;
}

export interface CloneCompanyOptions {
  sourceCompanyId: number;
  identity: CloneCompanyIdentity;
  admin: CloneCompanyAdmin;
  copyUsers?: boolean;        // default true — copy other source users
  templateId?: number | null; // for the audit row only
  performedByUserId?: number | null;
}

export interface CloneCompanyResult {
  newCompanyId: number;
  newCompanyCode: string;
  adminUserId: number;
  counts: Record<string, number>;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

// Map a source FK through a srcId→newId map. Unknown / null src → null.
function remap(map: Map<number, number>, srcId: number | null | undefined): number | null {
  if (!isInt(srcId)) return null;
  return map.get(srcId) ?? null;
}

// Remap a jsonb / pg int[] of source ids, dropping any that don't map.
function remapArray(map: Map<number, number>, arr: unknown): number[] {
  if (!Array.isArray(arr)) return [];
  const out: number[] = [];
  for (const v of arr) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isInteger(n) && map.has(n)) out.push(map.get(n)!);
  }
  return out;
}

/**
 * Clone an existing company's SETUP (never its transactional data) into a brand
 * new company. The entire copy runs in ONE transaction: every write INSERTs into
 * the new company; the source company is only ever SELECTed from. On any error
 * the transaction rolls back, leaving zero partial state.
 */
export async function cloneCompany(opts: CloneCompanyOptions): Promise<CloneCompanyResult> {
  const sourceId = opts.sourceCompanyId;
  const copyUsers = opts.copyUsers !== false;

  // ── SAFETY: source must exist, be live, and never equal the (future) target.
  const [source] = await db.select().from(companiesTable).where(eq(companiesTable.id, sourceId));
  if (!source) throw new Error("الشركة المصدر غير موجودة");
  if (source.deletedAt) throw new Error("لا يمكن الاستنساخ من شركة محذوفة");

  const adminPasswordHash = await bcrypt.hash(opts.admin.password, 12);

  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };

  // ── SAFETY: snapshot a few source row counts to assert it's untouched after.
  const sourceCountBefore = await countSourceRows(sourceId);

  const result = await db.transaction(async (tx) => {
    // ── 1. New company row ──────────────────────────────────────────────────
    // SETTINGS copied verbatim; IDENTITY from input; secrets/counters/status
    // reset; FK columns (hr*/fa*/pos*) inserted NULL and back-filled later.
    const id = opts.identity;
    const [company] = await tx.insert(companiesTable).values({
      // identity (from wizard input)
      nameAr:           id.nameAr,
      nameEn:           id.nameEn ?? null,
      vatNumber:        id.vatNumber,
      crNumber:         id.crNumber,
      city:             id.city,
      district:         id.district ?? null,
      street:           id.street,
      buildingNumber:   id.buildingNumber,
      postalCode:       id.postalCode,
      additionalNumber: id.additionalNumber ?? null,
      phone:            id.phone ?? null,
      country:          id.country ?? source.country,
      industryName:     id.industryName ?? source.industryName,
      // settings (verbatim from source)
      invoiceType:               source.invoiceType,
      logo:                      source.logo,
      decimalPlaces:             source.decimalPlaces,
      showZeros:                 source.showZeros,
      menuPermissions:           source.menuPermissions,
      windowsModulePermissions:  source.windowsModulePermissions,
      autoPostingEnabled:        source.autoPostingEnabled,
      journalEntryFormMode:      source.journalEntryFormMode,
      journalSmartForm:          source.journalSmartForm,
      menuLayout:                source.menuLayout,
      autoPostJournalEntry:      source.autoPostJournalEntry,
      autoPostSales:             source.autoPostSales,
      autoPostPurchase:          source.autoPostPurchase,
      autoPostReceipt:           source.autoPostReceipt,
      autoPostPayment:           source.autoPostPayment,
      autoPostFinancial:         source.autoPostFinancial,
      autoPostCashTransfer:      source.autoPostCashTransfer,
      autoPostPayroll:           source.autoPostPayroll,
      autoPostProduction:        source.autoPostProduction,
      autoPostStockMovement:     source.autoPostStockMovement,
      autoPostGoodsReceipt:      source.autoPostGoodsReceipt,
      autoPostGoodsDelivery:     source.autoPostGoodsDelivery,
      autoPostAdjustment:        source.autoPostAdjustment,
      autoPostFaAcquisition:     source.autoPostFaAcquisition,
      autoPostFaDepreciation:    source.autoPostFaDepreciation,
      autoPostFaDisposal:        source.autoPostFaDisposal,
      faAutoDepDay:              source.faAutoDepDay,
      autoPostCtgOutgoingBill:   source.autoPostCtgOutgoingBill,
      autoPostCtgIncomingBill:   source.autoPostCtgIncomingBill,
      printFooterInvoice:        source.printFooterInvoice,
      printFooterReturn:         source.printFooterReturn,
      printShowTimestamp:        source.printShowTimestamp,
      printShowZatcaBrand:       source.printShowZatcaBrand,
      bankAccountText:           source.bankAccountText,
      printShowItemsSummary:     source.printShowItemsSummary,
      printEnabledTemplates:     source.printEnabledTemplates,
      printDefaultTemplate:      source.printDefaultTemplate,
      invoicePrintLanguage:      source.invoicePrintLanguage,
      sequenceDateSource:        source.sequenceDateSource,
      printAutoAfterSaveSales:   source.printAutoAfterSaveSales,
      printAutoAfterSaveReceipt: source.printAutoAfterSaveReceipt,
      printAutoAfterSavePayment: source.printAutoAfterSavePayment,
      printAutoAfterSaveJournal: source.printAutoAfterSaveJournal,
      printTemplateSales:        source.printTemplateSales,
      printTemplateReceipt:      source.printTemplateReceipt,
      printTemplatePayment:      source.printTemplatePayment,
      printTemplateJournal:      source.printTemplateJournal,
      autoBackupEnabled:         source.autoBackupEnabled,
      autoBackupFrequencyHours:  source.autoBackupFrequencyHours,
      autoBackupRetention:       source.autoBackupRetention,
      taxCalculationMode:        source.taxCalculationMode,
      enableOfflinePos:          source.enableOfflinePos,
      // reset / safe defaults
      invoiceCounter: 0,
      status:         "active",
      isSandbox:      false,
    } as typeof companiesTable.$inferInsert).returning({ id: companiesTable.id });

    const newCompanyId = company.id;
    const newCompanyCode = `ZTC-${newCompanyId}`;
    await tx.update(companiesTable)
      .set({ code: newCompanyCode })
      .where(eq(companiesTable.id, newCompanyId));
    bump("companies");

    // ── 2. Regions ──────────────────────────────────────────────────────────
    const regionMap = new Map<number, number>();
    const regions = await tx.select().from(regionsTable).where(eq(regionsTable.companyId, sourceId));
    for (const r of regions) {
      const { id: srcId, createdAt, updatedAt, companyId, ...rest } = r;
      const [ins] = await tx.insert(regionsTable)
        .values({ ...rest, companyId: newCompanyId } as typeof regionsTable.$inferInsert)
        .returning({ id: regionsTable.id });
      regionMap.set(srcId, ins.id);
    }
    bump("regions", regions.length);

    // ── 3. Branches ─────────────────────────────────────────────────────────
    const branchMap = new Map<number, number>();
    const branches = await tx.select().from(branchesTable).where(eq(branchesTable.companyId, sourceId));
    for (const b of branches) {
      const { id: srcId, createdAt, updatedAt, companyId, regionId, ...rest } = b;
      const [ins] = await tx.insert(branchesTable)
        .values({ ...rest, companyId: newCompanyId, regionId: remap(regionMap, regionId) } as typeof branchesTable.$inferInsert)
        .returning({ id: branchesTable.id });
      branchMap.set(srcId, ins.id);
    }
    bump("branches", branches.length);

    // ── 4. Users (new admin + optional copy of others) ──────────────────────
    const userMap = new Map<number, number>();
    const [adminUser] = await tx.insert(usersTable).values({
      username:     opts.admin.username,
      email:        opts.admin.email ?? null,
      passwordHash: adminPasswordHash,
      companyId:    newCompanyId,
      role:         "admin",
      nameAr:       opts.admin.nameAr ?? null,
      nameEn:       opts.admin.nameEn ?? null,
      isActive:     true,
    } as typeof usersTable.$inferInsert).returning({ id: usersTable.id });
    const adminUserId = adminUser.id;
    bump("users");

    if (copyUsers) {
      const srcUsers = await tx.select().from(usersTable).where(and(
        eq(usersTable.companyId, sourceId),
        ne(usersTable.username, opts.admin.username),
      ));
      for (const u of srcUsers) {
        const {
          id: srcId, createdAt, updatedAt, companyId,
          sessionToken, sessionId, currentSessionId, lastLoginAt,
          ...rest
        } = u;
        const [ins] = await tx.insert(usersTable).values({
          ...rest,
          companyId:        newCompanyId,
          sessionToken:     null,
          sessionId:        null,
          currentSessionId: null,
          lastLoginAt:      null,
        } as typeof usersTable.$inferInsert).returning({ id: usersTable.id });
        userMap.set(srcId, ins.id);
        bump("users");
      }
    }

    // ── 5. User ↔ branch links (only for copied users) ──────────────────────
    if (userMap.size > 0) {
      const srcUserIds = [...userMap.keys()];
      const links = await tx.select().from(userBranchesTable)
        .where(inArrayList(userBranchesTable.userId, srcUserIds));
      let linkCount = 0;
      for (const l of links) {
        const newUserId = userMap.get(l.userId);
        const newBranchId = remap(branchMap, l.branchId);
        if (newUserId == null || newBranchId == null) continue;
        await tx.insert(userBranchesTable)
          .values({ userId: newUserId, branchId: newBranchId } as typeof userBranchesTable.$inferInsert)
          .onConflictDoNothing();
        linkCount++;
      }
      bump("user_branches", linkCount);
    }

    // ── 6. Cost centers (two-pass for self-parent) ──────────────────────────
    const ccMap = new Map<number, number>();
    const costCenters = await tx.select().from(costCentersTable).where(eq(costCentersTable.companyId, sourceId));
    for (const c of costCenters) {
      const { id: srcId, createdAt, updatedAt, companyId, parentId, ...rest } = c;
      const [ins] = await tx.insert(costCentersTable)
        .values({ ...rest, companyId: newCompanyId, parentId: null } as typeof costCentersTable.$inferInsert)
        .returning({ id: costCentersTable.id });
      ccMap.set(srcId, ins.id);
    }
    for (const c of costCenters) {
      if (!isInt(c.parentId)) continue;
      const newId = ccMap.get(c.id);
      const newParent = ccMap.get(c.parentId);
      if (newId == null || newParent == null) continue;
      await tx.update(costCentersTable).set({ parentId: newParent }).where(eq(costCentersTable.id, newId));
    }
    bump("cost_centers", costCenters.length);

    // ── 7. Currencies ───────────────────────────────────────────────────────
    const currencyMap = new Map<number, number>();
    const currencies = await tx.select().from(currenciesTable).where(eq(currenciesTable.companyId, sourceId));
    for (const c of currencies) {
      const { id: srcId, createdAt, updatedAt, companyId, ...rest } = c;
      const [ins] = await tx.insert(currenciesTable)
        .values({ ...rest, companyId: newCompanyId } as typeof currenciesTable.$inferInsert)
        .returning({ id: currenciesTable.id });
      currencyMap.set(srcId, ins.id);
    }
    bump("currencies", currencies.length);

    // ── 8. Exchange rates ───────────────────────────────────────────────────
    const exRates = await tx.select().from(exchangeRatesTable).where(eq(exchangeRatesTable.companyId, sourceId));
    let exCount = 0;
    for (const r of exRates) {
      const { id: srcId, createdAt, updatedAt, companyId, fromCurrencyId, toCurrencyId, ...rest } = r;
      const nf = remap(currencyMap, fromCurrencyId);
      const nt = remap(currencyMap, toCurrencyId);
      if (nf == null || nt == null) continue;
      await tx.insert(exchangeRatesTable)
        .values({ ...rest, companyId: newCompanyId, fromCurrencyId: nf, toCurrencyId: nt } as typeof exchangeRatesTable.$inferInsert);
      exCount++;
    }
    bump("exchange_rates", exCount);

    // ── 9. Accounts (two-pass parentId; costCenterId via ccMap) ─────────────
    const accountMap = new Map<number, number>();
    const accounts = await tx.select().from(accountsTable).where(eq(accountsTable.companyId, sourceId));
    for (const a of accounts) {
      const { id: srcId, createdAt, updatedAt, companyId, parentId, costCenterId, ...rest } = a;
      const [ins] = await tx.insert(accountsTable).values({
        ...rest,
        companyId:    newCompanyId,
        parentId:     null,
        costCenterId: remap(ccMap, costCenterId),
      } as typeof accountsTable.$inferInsert).returning({ id: accountsTable.id });
      accountMap.set(srcId, ins.id);
    }
    for (const a of accounts) {
      if (!isInt(a.parentId)) continue;
      const newId = accountMap.get(a.id);
      const newParent = accountMap.get(a.parentId);
      if (newId == null || newParent == null) continue;
      await tx.update(accountsTable).set({ parentId: newParent }).where(eq(accountsTable.id, newId));
    }
    bump("accounts", accounts.length);

    // ── 10. Accounting mappings (posting config) ────────────────────────────
    const mappings = await tx.select().from(accountingMappingsTable).where(eq(accountingMappingsTable.companyId, sourceId));
    for (const m of mappings) {
      const { id: srcId, createdAt, updatedAt, companyId, accountId, ...rest } = m;
      await tx.insert(accountingMappingsTable)
        .values({ ...rest, companyId: newCompanyId, accountId: remap(accountMap, accountId) } as typeof accountingMappingsTable.$inferInsert);
    }
    bump("accounting_mappings", mappings.length);

    // ── 11. Warehouse groups ────────────────────────────────────────────────
    const whGroupMap = new Map<number, number>();
    const whGroups = await tx.select().from(warehouseGroupsTable).where(eq(warehouseGroupsTable.companyId, sourceId));
    for (const g of whGroups) {
      const { id: srcId, createdAt, updatedAt, companyId, ...rest } = g as any;
      const [ins] = await tx.insert(warehouseGroupsTable)
        .values({ ...rest, companyId: newCompanyId } as typeof warehouseGroupsTable.$inferInsert)
        .returning({ id: warehouseGroupsTable.id });
      whGroupMap.set(srcId, ins.id);
    }
    bump("warehouse_groups", whGroups.length);

    // ── 12. Warehouses ──────────────────────────────────────────────────────
    const warehouseMap = new Map<number, number>();
    const warehouses = await tx.select().from(warehousesTable).where(eq(warehousesTable.companyId, sourceId));
    for (const w of warehouses) {
      const { id: srcId, createdAt, updatedAt, companyId, groupId, branchId, ...rest } = w as any;
      const [ins] = await tx.insert(warehousesTable).values({
        ...rest,
        companyId: newCompanyId,
        groupId:   remap(whGroupMap, groupId),
        branchId:  remap(branchMap, branchId),
      } as typeof warehousesTable.$inferInsert).returning({ id: warehousesTable.id });
      warehouseMap.set(srcId, ins.id);
    }
    bump("warehouses", warehouses.length);

    // ── 13. Item groups ─────────────────────────────────────────────────────
    const itemGroups = await tx.select().from(itemGroupsTable).where(eq(itemGroupsTable.companyId, sourceId));
    for (const g of itemGroups) {
      const { id: srcId, createdAt, updatedAt, companyId, costAccountId, revenueAccountId, ...rest } = g as any;
      await tx.insert(itemGroupsTable).values({
        ...rest,
        companyId:        newCompanyId,
        costAccountId:    remap(accountMap, costAccountId),
        revenueAccountId: remap(accountMap, revenueAccountId),
      } as typeof itemGroupsTable.$inferInsert);
    }
    bump("item_groups", itemGroups.length);

    // ── 14. Units ───────────────────────────────────────────────────────────
    const units = await tx.select().from(unitsTable).where(eq(unitsTable.companyId, sourceId));
    for (const u of units) {
      const { id: srcId, createdAt, updatedAt, companyId, ...rest } = u as any;
      await tx.insert(unitsTable)
        .values({ ...rest, companyId: newCompanyId } as typeof unitsTable.$inferInsert);
    }
    bump("units", units.length);

    // ── 15. Cash boxes ──────────────────────────────────────────────────────
    const cashBoxMap = new Map<number, number>();
    const cashBoxes = await tx.select().from(cashBoxesTable).where(eq(cashBoxesTable.companyId, sourceId));
    for (const c of cashBoxes) {
      const { id: srcId, createdAt, companyId, branchId, currencyId, accountId, ...rest } = c;
      const [ins] = await tx.insert(cashBoxesTable).values({
        ...rest,
        companyId:  newCompanyId,
        branchId:   remap(branchMap, branchId),
        currencyId: remap(currencyMap, currencyId),
        accountId:  remap(accountMap, accountId),
      } as typeof cashBoxesTable.$inferInsert).returning({ id: cashBoxesTable.id });
      cashBoxMap.set(srcId, ins.id);
    }
    bump("cash_boxes", cashBoxes.length);

    // ── 16. Bank accounts ───────────────────────────────────────────────────
    const bankMap = new Map<number, number>();
    const banks = await tx.select().from(bankAccountsTable).where(eq(bankAccountsTable.companyId, sourceId));
    for (const b of banks) {
      const { id: srcId, createdAt, companyId, branchId, branchIds, currencyId, accountId, ...rest } = b;
      const mappedBranchIds = remapArray(branchMap, branchIds);
      const [ins] = await tx.insert(bankAccountsTable).values({
        ...rest,
        companyId:  newCompanyId,
        branchId:   remap(branchMap, branchId),
        branchIds:  mappedBranchIds.length ? mappedBranchIds : null,
        currencyId: remap(currencyMap, currencyId),
        accountId:  remap(accountMap, accountId),
      } as typeof bankAccountsTable.$inferInsert).returning({ id: bankAccountsTable.id });
      bankMap.set(srcId, ins.id);
    }
    bump("bank_accounts", banks.length);

    // ── 17. Sequences (numbering) — reset counters, drop fiscal scoping ──────
    const sequences = await tx.select().from(sequencesTable).where(eq(sequencesTable.companyId, sourceId));
    for (const s of sequences) {
      const { id: srcId, createdAt, updatedAt, companyId, currentNumber, branchIds, fiscalPeriodIds, ...rest } = s;
      await tx.insert(sequencesTable).values({
        ...rest,
        companyId:       newCompanyId,
        currentNumber:   s.startNumber,                  // reset running counter
        branchIds:       remapArray(branchMap, branchIds),
        fiscalPeriodIds: [],                             // new company has fresh fiscal years
      } as typeof sequencesTable.$inferInsert);
    }
    bump("sequences", sequences.length);

    // ── 18. Invoice field policy profiles ───────────────────────────────────
    const profileMap = new Map<number, number>();
    const profiles = await tx.select().from(invoiceFieldPolicyProfilesTable).where(eq(invoiceFieldPolicyProfilesTable.companyId, sourceId));
    for (const p of profiles) {
      const { id: srcId, createdAt, updatedAt, companyId, updatedBy, ...rest } = p;
      const [ins] = await tx.insert(invoiceFieldPolicyProfilesTable).values({
        ...rest,
        companyId: newCompanyId,
        updatedBy: remap(userMap, updatedBy) ?? adminUserId,
      } as typeof invoiceFieldPolicyProfilesTable.$inferInsert).returning({ id: invoiceFieldPolicyProfilesTable.id });
      profileMap.set(srcId, ins.id);
    }
    bump("invoice_field_policy_profiles", profiles.length);

    // ── 19. User ↔ invoice field policy assignments (copied users only) ─────
    if (userMap.size > 0 && profileMap.size > 0) {
      const srcUserIds = [...userMap.keys()];
      const assigns = await tx.select().from(userInvoiceFieldPoliciesTable)
        .where(inArrayList(userInvoiceFieldPoliciesTable.userId, srcUserIds));
      let aCount = 0;
      for (const a of assigns) {
        const nu = userMap.get(a.userId);
        const np = profileMap.get(a.profileId);
        if (nu == null || np == null) continue;
        await tx.insert(userInvoiceFieldPoliciesTable).values({
          userId:     nu,
          profileId:  np,
          assignedBy: remap(userMap, a.assignedBy) ?? adminUserId,
        } as typeof userInvoiceFieldPoliciesTable.$inferInsert).onConflictDoNothing();
        aCount++;
      }
      bump("user_invoice_field_policies", aCount);
    }

    // ── 20. Custom print templates ──────────────────────────────────────────
    const printTemplates = await tx.select().from(customPrintTemplatesTable).where(eq(customPrintTemplatesTable.companyId, sourceId));
    for (const t of printTemplates) {
      const { id: srcId, createdAt, updatedAt, companyId, createdBy, ...rest } = t;
      await tx.insert(customPrintTemplatesTable).values({
        ...rest,
        companyId: newCompanyId,
        createdBy: remap(userMap, createdBy),
      } as typeof customPrintTemplatesTable.$inferInsert);
    }
    bump("custom_print_templates", printTemplates.length);

    // ── 21. Security notification rules ─────────────────────────────────────
    const rules = await tx.select().from(securityNotificationRulesTable).where(eq(securityNotificationRulesTable.companyId, sourceId));
    for (const r of rules) {
      const { id: srcId, createdAt, updatedAt, companyId, createdByUserId, targetUserIds, branchIds, ...rest } = r;
      await tx.insert(securityNotificationRulesTable).values({
        ...rest,
        companyId:       newCompanyId,
        createdByUserId: remap(userMap, createdByUserId) ?? adminUserId,
        targetUserIds:   remapArray(userMap, targetUserIds),
        branchIds:       remapArray(branchMap, branchIds),
      } as typeof securityNotificationRulesTable.$inferInsert);
    }
    bump("security_notification_rules", rules.length);

    // ── 22. Work session settings (one row per company) ─────────────────────
    const [wss] = await tx.select().from(workSessionSettingsTable).where(eq(workSessionSettingsTable.companyId, sourceId));
    if (wss) {
      const { id: srcId, createdAt, updatedAt, companyId, defaultBranchId, updatedByUserId, ...rest } = wss;
      await tx.insert(workSessionSettingsTable).values({
        ...rest,
        companyId:       newCompanyId,
        defaultBranchId: remap(branchMap, defaultBranchId),
        updatedByUserId: remap(userMap, updatedByUserId) ?? adminUserId,
      } as typeof workSessionSettingsTable.$inferInsert);
      bump("work_session_settings");
    }

    // ── 23. Subscription (fresh dates; copy plan limits if source had one) ──
    const [srcSub] = await tx.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, sourceId));
    const today = new Date();
    const startDate = today.toISOString().slice(0, 10);
    const endDate = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate()).toISOString().slice(0, 10);
    if (srcSub) {
      await tx.insert(subscriptionsTable).values({
        companyId:     newCompanyId,
        plan:          srcSub.plan,
        maxUsers:      srcSub.maxUsers,
        maxBranches:   srcSub.maxBranches,
        maxWarehouses: srcSub.maxWarehouses,
        maxInvoices:   srcSub.maxInvoices,
        billingCycle:  srcSub.billingCycle,
        price:         srcSub.price,
        isActive:      true,
        startDate,
        endDate,
      } as typeof subscriptionsTable.$inferInsert);
    } else {
      await tx.insert(subscriptionsTable).values({
        companyId: newCompanyId,
        plan: "starter",
        startDate,
        endDate,
      } as typeof subscriptionsTable.$inferInsert);
    }
    bump("subscriptions");

    // ── 24. Back-fill company FK columns now that targets exist ─────────────
    await tx.update(companiesTable).set({
      hrSalariesExpenseAccountId:   remap(accountMap, source.hrSalariesExpenseAccountId),
      hrAllowancesExpenseAccountId: remap(accountMap, source.hrAllowancesExpenseAccountId),
      hrGosiExpenseAccountId:       remap(accountMap, source.hrGosiExpenseAccountId),
      hrEosExpenseAccountId:        remap(accountMap, source.hrEosExpenseAccountId),
      hrSalariesPayableAccountId:   remap(accountMap, source.hrSalariesPayableAccountId),
      hrGosiPayableAccountId:       remap(accountMap, source.hrGosiPayableAccountId),
      hrOtherDeductionsAccountId:   remap(accountMap, source.hrOtherDeductionsAccountId),
      hrEmployeeLoansAccountId:     remap(accountMap, source.hrEmployeeLoansAccountId),
      hrEmployeeCustodyAccountId:   remap(accountMap, source.hrEmployeeCustodyAccountId),
      hrEosProvisionAccountId:      remap(accountMap, source.hrEosProvisionAccountId),
      hrDefaultPayCashBoxId:        remap(cashBoxMap, source.hrDefaultPayCashBoxId),
      hrDefaultPayBankAccountId:    remap(bankMap, source.hrDefaultPayBankAccountId),
      faAssetCostAccountId:          remap(accountMap, source.faAssetCostAccountId),
      faAccumDepreciationAccountId:  remap(accountMap, source.faAccumDepreciationAccountId),
      faDepreciationExpenseAccountId: remap(accountMap, source.faDepreciationExpenseAccountId),
      faAcquisitionClearingAccountId: remap(accountMap, source.faAcquisitionClearingAccountId),
      faDisposalGainAccountId:       remap(accountMap, source.faDisposalGainAccountId),
      faDisposalLossAccountId:       remap(accountMap, source.faDisposalLossAccountId),
      posCashCashBoxId:       remap(cashBoxMap, source.posCashCashBoxId),
      posCardBankAccountId:   remap(bankMap, source.posCardBankAccountId),
      posAppleBankAccountId:  remap(bankMap, source.posAppleBankAccountId),
      posWalletBankAccountId: remap(bankMap, source.posWalletBankAccountId),
    }).where(eq(companiesTable.id, newCompanyId));

    return { newCompanyId, newCompanyCode, adminUserId };
  });

  // ── SAFETY: assert the source company was not mutated by the clone. ──────────
  const sourceCountAfter = await countSourceRows(sourceId);
  for (const k of Object.keys(sourceCountBefore)) {
    if (sourceCountBefore[k] !== sourceCountAfter[k]) {
      throw new Error(`خلل في الاستنساخ: تغيّرت بيانات الشركة المصدر (${k})`);
    }
  }

  return {
    newCompanyId: result.newCompanyId,
    newCompanyCode: result.newCompanyCode,
    adminUserId: result.adminUserId,
    counts,
  };
}

// Count a representative set of source-owned rows so we can prove the clone
// only ever INSERTed into the new company and never touched the source.
async function countSourceRows(companyId: number): Promise<Record<string, number>> {
  const one = async (table: any): Promise<number> => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` })
      .from(table).where(eq(table.companyId, companyId));
    return row?.n ?? 0;
  };
  return {
    accounts:   await one(accountsTable),
    branches:   await one(branchesTable),
    users:      await one(usersTable),
    cashBoxes:  await one(cashBoxesTable),
    currencies: await one(currenciesTable),
    sequences:  await one(sequencesTable),
  };
}

// Audit-row writer (best-effort; never throws into the caller's flow).
export async function recordCloneRun(row: typeof companyCloneRunsTable.$inferInsert): Promise<void> {
  try {
    await db.insert(companyCloneRunsTable).values(row);
  } catch {
    /* audit is best-effort */
  }
}

// drizzle's inArray needs a non-empty list guard.
function inArrayList(col: any, ids: number[]) {
  // ids is always non-empty at call sites (guarded by Map.size checks).
  return sql`${col} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`;
}
