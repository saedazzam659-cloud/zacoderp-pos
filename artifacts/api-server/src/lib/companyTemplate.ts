import { db } from "@workspace/db";
import {
  companiesTable,
  accountsTable,
  customersTable,
  suppliersTable,
  employeesTable,
  salesRepsTable,
  cashBoxesTable,
  bankAccountsTable,
  sisterCompaniesTable,
  sequencesTable,
} from "@workspace/db";
import { eq, and, isNotNull, asc } from "drizzle-orm";
import { logger } from "./logger.js";
import { seedDefaultChartOfAccounts } from "./seedDefaultChartOfAccounts.js";

/**
 * ─── COMPANY TEMPLATE DEFAULTS ────────────────────────────────────────────────
 * Every NEW company (created from the SuperAdmin panel OR from public
 * self-registration on the main site) is seeded with the settings of a
 * designated TEMPLATE company (default: company id 10) instead of the
 * hard-coded generic defaults:
 *
 *  1. Display settings copied onto the companies row: menu layout
 *     (topnav/sidebar), invoice form layout (tabbed/classic) and all print
 *     template defaults.
 *  2. Numbering sequences: the template's sequence definitions are cloned
 *     (prefix / padding / month pattern / bound transaction types), with the
 *     counter reset to startNumber. Period/branch scoping is intentionally
 *     dropped (those ids belong to the template company). Additionally, per
 *     the product spec, the unified journal-entry sequence is created with
 *     monthlyReset=true + applySourcePrefixes=true so every auto-JE carries
 *     its source-module prefix and counters restart monthly.
 *  3. Chart of accounts: the template's tree is cloned in the same order
 *     (same codes/levels/parents), EXCLUDING the template company's own
 *     party sub-accounts — any account referenced by its customers,
 *     suppliers, employees (payable), sales reps, sister companies, cash
 *     boxes or bank accounts.
 *
 * Everything is best-effort: a missing/empty template company falls back to
 * the legacy default seeding and NEVER blocks company creation.
 */
export const TEMPLATE_COMPANY_ID = Number(process.env.TEMPLATE_COMPANY_ID ?? 10);

/** Clone display/print settings from the template company. */
async function cloneDisplaySettings(companyId: number, templateId: number): Promise<boolean> {
  const [tpl] = await db.select({
    menuLayout:              companiesTable.menuLayout,
    invoiceFormLayout:       companiesTable.invoiceFormLayout,
    printTemplateSales:      companiesTable.printTemplateSales,
    printTemplateReceipt:    companiesTable.printTemplateReceipt,
    printTemplatePayment:    companiesTable.printTemplatePayment,
    printTemplateJournal:    companiesTable.printTemplateJournal,
    printDefaultTemplate:    companiesTable.printDefaultTemplate,
    printEnabledTemplates:   companiesTable.printEnabledTemplates,
    printAutoAfterSaveSales:   companiesTable.printAutoAfterSaveSales,
    printAutoAfterSaveReceipt: companiesTable.printAutoAfterSaveReceipt,
    printAutoAfterSavePayment: companiesTable.printAutoAfterSavePayment,
    printAutoAfterSaveJournal: companiesTable.printAutoAfterSaveJournal,
  }).from(companiesTable).where(eq(companiesTable.id, templateId));
  if (!tpl) return false;
  await db.update(companiesTable).set({ ...tpl, updatedAt: new Date() })
    .where(eq(companiesTable.id, companyId));
  return true;
}

/**
 * Clone the template's sequence DEFINITIONS. When the template has several
 * sequences bound to the same transaction-type set (e.g. one per fiscal
 * year), only the most recently updated ACTIVE one is cloned — the clone is
 * universal (no fiscal-period/branch scoping, those ids are template-local).
 */
async function cloneSequences(companyId: number, templateId: number): Promise<number> {
  const existing = await db.select({ id: sequencesTable.id })
    .from(sequencesTable).where(eq(sequencesTable.companyId, companyId)).limit(1);
  if (existing.length > 0) return 0; // never double-seed

  const rows = await db.select().from(sequencesTable)
    .where(and(eq(sequencesTable.companyId, templateId), eq(sequencesTable.isActive, true)));
  if (rows.length === 0) return 0;

  // Deduplicate by bound transaction-type set → keep the newest definition.
  const byKey = new Map<string, typeof rows[number]>();
  for (const r of rows) {
    const key = JSON.stringify([...((r.transactionTypes as string[] | null) ?? [])].sort());
    const prev = byKey.get(key);
    if (!prev || (r.updatedAt && prev.updatedAt && r.updatedAt > prev.updatedAt)) byKey.set(key, r);
  }

  let inserted = 0;
  for (const r of byKey.values()) {
    const txTypes = ((r.transactionTypes as string[] | null) ?? []);
    const isJournal = txTypes.includes("journal_entry");
    // Spec: the unified JE sequence starts with monthly reset ON and
    // per-source-module prefixes ON. monthlyReset requires a month token in
    // the pattern — inherit the template's, else fall back to "{MM}/".
    const monthPattern = isJournal
      ? (r.monthPattern && /\{M{1,2}\}/.test(r.monthPattern) ? r.monthPattern : "{MM}/")
      : r.monthPattern;
    await db.insert(sequencesTable).values({
      companyId,
      code:     r.code,
      nameAr:   r.nameAr,
      nameEn:   r.nameEn,
      prefix:   r.prefix,
      monthPattern,
      startNumber:   r.startNumber,
      endNumber:     r.endNumber,
      currentNumber: r.startNumber,      // fresh counter for the new tenant
      padLength:     r.padLength,
      isActive:      true,
      monthlyReset:        isJournal ? true : r.monthlyReset,
      applySourcePrefixes: isJournal ? true : r.applySourcePrefixes,
      transactionTypes: txTypes,
      branchIds:        [],              // template-local ids — never copy
      fiscalPeriodIds:  [],              // universal: valid for every year
    });
    inserted++;
  }
  return inserted;
}

/** Account ids that are the template company's OWN party/entity sub-accounts. */
async function templatePartyAccountIds(templateId: number): Promise<Set<number>> {
  const out = new Set<number>();
  const collect = async (q: Promise<Array<{ accountId: number | null }>>) => {
    for (const r of await q) if (r.accountId != null) out.add(r.accountId);
  };
  await collect(db.select({ accountId: customersTable.accountId }).from(customersTable)
    .where(and(eq(customersTable.companyId, templateId), isNotNull(customersTable.accountId))));
  await collect(db.select({ accountId: suppliersTable.accountId }).from(suppliersTable)
    .where(and(eq(suppliersTable.companyId, templateId), isNotNull(suppliersTable.accountId))));
  await collect(db.select({ accountId: employeesTable.payableAccountId }).from(employeesTable)
    .where(and(eq(employeesTable.companyId, templateId), isNotNull(employeesTable.payableAccountId))));
  await collect(db.select({ accountId: salesRepsTable.accountId }).from(salesRepsTable)
    .where(and(eq(salesRepsTable.companyId, templateId), isNotNull(salesRepsTable.accountId))));
  await collect(db.select({ accountId: sisterCompaniesTable.accountId }).from(sisterCompaniesTable)
    .where(and(eq(sisterCompaniesTable.companyId, templateId), isNotNull(sisterCompaniesTable.accountId))));
  await collect(db.select({ accountId: cashBoxesTable.accountId }).from(cashBoxesTable)
    .where(and(eq(cashBoxesTable.companyId, templateId), isNotNull(cashBoxesTable.accountId))));
  await collect(db.select({ accountId: bankAccountsTable.accountId }).from(bankAccountsTable)
    .where(and(eq(bankAccountsTable.companyId, templateId), isNotNull(bankAccountsTable.accountId))));
  return out;
}

/**
 * Clone the template company's chart of accounts (structure + ordering),
 * skipping its party sub-accounts. Children of an excluded account are
 * excluded too. Insertion is level-ascending inside one transaction with
 * old→new parent-id mapping (same pattern as seedDefaultChartOfAccounts).
 */
async function cloneChartOfAccounts(companyId: number, templateId: number): Promise<number> {
  const excluded = await templatePartyAccountIds(templateId);
  const tplAccounts = await db.select().from(accountsTable)
    .where(eq(accountsTable.companyId, templateId))
    .orderBy(asc(accountsTable.level), asc(accountsTable.code));
  if (tplAccounts.length === 0) return 0;

  // Party-CONTAINER rule: if a parent has at least one referenced party
  // child (e.g. العملاء / الموردين groups), then EVERY posting-leaf child of
  // that parent is treated as a party sub-account too — this also catches
  // orphaned party accounts whose entity card was deleted or never linked,
  // so template-tenant party names cannot leak into new tenants.
  const childrenByParent = new Map<number, typeof tplAccounts>();
  for (const a of tplAccounts) {
    if (a.parentId == null) continue;
    const arr = childrenByParent.get(a.parentId) ?? [];
    arr.push(a);
    childrenByParent.set(a.parentId, arr);
  }
  const hasChildren = new Set(childrenByParent.keys());
  const partyParents = new Set<number>();
  for (const a of tplAccounts) {
    if (excluded.has(a.id) && a.parentId != null) partyParents.add(a.parentId);
  }
  for (const pid of partyParents) {
    for (const child of childrenByParent.get(pid) ?? []) {
      if (child.isPosting && !hasChildren.has(child.id)) excluded.add(child.id);
    }
  }

  // Named-person rule: partner current accounts (جاري الشريك …) carry a
  // person/company name but are not referenced by any entity table, so the
  // container rule above cannot see them. Exclude any posting leaf whose
  // Arabic name matches a known personal-subaccount pattern.
  const PARTY_NAME_PATTERNS = [/جاري\s+الشريك/];
  for (const a of tplAccounts) {
    if (!a.isPosting || hasChildren.has(a.id)) continue;
    if (PARTY_NAME_PATTERNS.some(p => p.test(a.nameAr ?? ""))) excluded.add(a.id);
  }

  return db.transaction(async (tx) => {
    const existing = await tx.select({ id: accountsTable.id })
      .from(accountsTable).where(eq(accountsTable.companyId, companyId)).limit(1);
    if (existing.length > 0) {
      logger.info({ companyId }, "template-coa.skip-existing");
      return 0;
    }
    const oldToNew = new Map<number, number>();
    let inserted = 0;
    for (const a of tplAccounts) {
      if (excluded.has(a.id)) continue;
      // Parent excluded (or unknown) ⇒ this whole branch is party-specific.
      if (a.parentId != null && !oldToNew.has(a.parentId)) continue;
      const [created] = await tx.insert(accountsTable).values({
        companyId,
        parentId: a.parentId != null ? oldToNew.get(a.parentId)! : null,
        code: a.code,
        nameAr: a.nameAr,
        nameEn: a.nameEn,
        accountType: a.accountType,
        reportDirection: a.reportDirection,
        level: a.level,
        isPosting: a.isPosting,
        isActive: a.isActive,
      }).returning({ id: accountsTable.id });
      oldToNew.set(a.id, created.id);
      inserted++;
    }
    logger.info({ companyId, inserted, excluded: excluded.size }, "template-coa.seeded");
    return inserted;
  });
}

/**
 * Apply every template default to a freshly created company. Best-effort:
 * each part is independent and failures only log — company creation is
 * never blocked. If — for ANY reason (template missing, empty, or clone
 * failure) — the new company ends up with zero accounts, the legacy default
 * chart of accounts is seeded instead so no tenant ever starts without a COA.
 */
export async function applyCompanyTemplateDefaults(companyId: number): Promise<{ applied: boolean; coaInserted: number }> {
  const templateId = TEMPLATE_COMPANY_ID;
  let applied = false;
  let coaInserted = 0;
  if (templateId && templateId !== companyId) {
    const [tpl] = await db.select({ id: companiesTable.id })
      .from(companiesTable).where(eq(companiesTable.id, templateId));
    if (!tpl) {
      logger.warn({ templateId }, "company-template.missing");
    } else {
      applied = true;
      try { await cloneDisplaySettings(companyId, templateId); }
      catch (err) { logger.error({ err, companyId }, "company-template.display-failed"); }
      try { await cloneSequences(companyId, templateId); }
      catch (err) { logger.error({ err, companyId }, "company-template.sequences-failed"); }
      try { coaInserted = await cloneChartOfAccounts(companyId, templateId); }
      catch (err) { logger.error({ err, companyId }, "company-template.coa-failed"); }
    }
  }
  // Safety net: a tenant must never start without a chart of accounts.
  // (seedDefaultChartOfAccounts is itself skip-if-existing, so this is safe
  // even when the industry templates or the clone above already seeded one.)
  try {
    const existing = await db.select({ id: accountsTable.id })
      .from(accountsTable).where(eq(accountsTable.companyId, companyId)).limit(1);
    if (existing.length === 0) {
      const r = await seedDefaultChartOfAccounts(companyId);
      logger.info({ companyId, inserted: r.inserted }, "company-template.coa-fallback-default");
    }
  } catch (err) {
    logger.error({ err, companyId }, "company-template.coa-fallback-failed");
  }
  return { applied, coaInserted };
}
