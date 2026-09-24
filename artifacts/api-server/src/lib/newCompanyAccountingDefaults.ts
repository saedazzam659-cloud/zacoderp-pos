import { accountingMappingsTable, accountsTable, db } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  DEFAULT_MAPPINGS,
  seedDefaultAccountingMappings,
  type DefaultMapping,
  type SeedDefaultsResult,
} from "./accountingMappings.js";
import { seedDefaultChartOfAccounts } from "./seedDefaultChartOfAccounts.js";
import { DEFAULT_CHART_OF_ACCOUNTS } from "./defaultChartOfAccounts.js";

// The first five entries use the exact /accounting-mappings/seed-lc account
// definitions. The two adjustment names/types follow the documented
// warehouse_adjustment role labels; 41 and 55 are the commercial chart's
// revenue and other-expense parents respectively.
export const NEW_COMPANY_MAPPING_ACCOUNTS = [
  { code: "1150", nameAr: "هامش الاعتماد المستندي", nameEn: "Letter of Credit Margin", accountType: "asset", parentCode: null },
  { code: "2150", nameAr: "الاعتمادات المستندية المفتوحة", nameEn: "Open Letters of Credit", accountType: "liability", parentCode: null },
  { code: "5830", nameAr: "عمولة فتح الاعتماد المستندي", nameEn: "LC Opening Commission", accountType: "expense", parentCode: null },
  { code: "5835", nameAr: "مصاريف الاعتماد المستندي", nameEn: "LC Expenses (Shipping/Insurance/Customs)", accountType: "expense", parentCode: null },
  { code: "5840", nameAr: "فروق عملة الاعتماد المستندي", nameEn: "LC FX Differences", accountType: "expense", parentCode: null },
  { code: "4104", nameAr: "زيادة جرد / ربح تسوية", nameEn: "Inventory Adjustment Gain", accountType: "revenue", parentCode: "41" },
  { code: "5504", nameAr: "عجز جرد / خسارة تسوية", nameEn: "Inventory Adjustment Loss", accountType: "expense", parentCode: "55" },
] as const;

// The warehouse-transfer role config explicitly says source and destination
// may share the same inventory account (with different warehouse/branch).
// 11081 is employee advances in the commercial COA, not inventory.
// The LC setup also explicitly leaves its bank and inventory roles to the
// company; the generic template's 1150 is the LC *margin*, not either role.
export const NEW_COMPANY_MAPPING_CODE_CORRECTIONS = [
  { documentType: "warehouse_transfer", roleKey: "inventory_destination", accountCode: "11051" },
  { documentType: "letter_of_credit", roleKey: "inventory", accountCode: "11051" },
  { documentType: "letter_of_credit", roleKey: "bank", accountCode: "11021" },
] as const;

/** Existing industry/template rows always win, even if deliberately null. */
export function pendingNewCompanyMappingCorrections(
  existing: readonly { documentType: string; roleKey: string }[],
): DefaultMapping[] {
  const keys = new Set(existing.map((m) => `${m.documentType}::${m.roleKey}`));
  return NEW_COMPANY_MAPPING_CODE_CORRECTIONS.filter((m) =>
    !keys.has(`${m.documentType}::${m.roleKey}`),
  ).map((m) => ({ ...m }));
}

export interface NewCompanyAccountingDefaultsResult {
  coaInserted: number;
  mappingAccountsInserted: number;
  mappings: SeedDefaultsResult;
  /** False if any canonical role still has no account belonging to this company. */
  complete: boolean;
  /** Canonical codes absent from the company's COA for unresolved roles. */
  missingAccountCodes: string[];
  /** Roles left unwired (including null or invalid existing mappings). */
  unresolvedMappings: DefaultMapping[];
}

/**
 * Inspect canonical roles after the additive seeder has run. An industry
 * template may have mapped a role to a different, valid company account, so
 * absence of the canonical code alone does not mean the role is unresolved.
 */
export function unresolvedNewCompanyMappingDefaults(
  mappings: readonly Pick<DefaultMapping, "documentType" | "roleKey" | "accountCode">[],
  mappedAccounts: readonly { documentType: string; roleKey: string; accountId: number | null }[],
  companyAccountIds: ReadonlySet<number>,
): DefaultMapping[] {
  const byRole = new Map(mappedAccounts.map((m) => [`${m.documentType}::${m.roleKey}`, m.accountId]));
  return mappings.filter((m) => {
    const id = byRole.get(`${m.documentType}::${m.roleKey}`);
    return id == null || !companyAccountIds.has(id);
  }).map((m) => ({ ...m }));
}

/**
 * Invoke ONLY for a newly created company, after industry/template setup.
 * Does not change existing chart rows or mappings: an existing chart is left
 * alone, and industry mappings (including locked and deliberately blank rows)
 * are never overwritten. Only documented, missing canonical accounts are
 * provisioned. If a template has intentionally left a role blank, report it
 * and fail explicitly rather than silently declaring a complete setup.
 */
export async function seedNewCompanyAccountingDefaults(
  companyId: number,
): Promise<NewCompanyAccountingDefaultsResult> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new Error(`Invalid new company id: ${companyId}`);
  }

  // The standard seeder itself checks for any existing chart and skips it.
  // In particular, never merge the commercial chart into an industry chart.
  const { inserted: coaInserted } = await seedDefaultChartOfAccounts(companyId);
  let mappingAccountsInserted = 0;
  await db.transaction(async (tx) => {
    const existingAccounts = await tx.select({
      id: accountsTable.id, code: accountsTable.code,
    }).from(accountsTable).where(eq(accountsTable.companyId, companyId));
    const codeToId = new Map(existingAccounts.map((a) => [a.code, a.id]));
    const existingMappings = await tx.select({
      documentType: accountingMappingsTable.documentType,
      roleKey: accountingMappingsTable.roleKey,
      accountId: accountingMappingsTable.accountId,
    }).from(accountingMappingsTable).where(eq(accountingMappingsTable.companyId, companyId));
    const roleToAccountId = new Map(existingMappings.map((m) => [`${m.documentType}::${m.roleKey}`, m.accountId]));
    const corrections = pendingNewCompanyMappingCorrections(existingMappings);
    const correctedCodes = new Map(corrections.map((m) => [`${m.documentType}::${m.roleKey}`, m.accountCode]));
    const neededCodes = new Set(DEFAULT_MAPPINGS.filter((m) =>
      !m.documentType.startsWith("contracting_") &&
      !roleToAccountId.has(`${m.documentType}::${m.roleKey}`),
    ).map((m) => correctedCodes.get(`${m.documentType}::${m.roleKey}`) ?? m.accountCode));
    for (const corrected of corrections) neededCodes.add(corrected.accountCode);

    // Only import a missing ancestor from the published commercial chart,
    // never infer a parent from a custom account's numeric prefix.
    async function ensureStandardParent(code: string): Promise<number> {
      const hit = codeToId.get(code);
      if (hit != null) return hit;
      const standard = DEFAULT_CHART_OF_ACCOUNTS.find((row) => row.code === code);
      if (!standard) throw new Error(`Missing canonical account parent ${code} for new company ${companyId}`);
      const parentId = standard.parentCode ? await ensureStandardParent(standard.parentCode) : null;
      const [created] = await tx.insert(accountsTable).values({
        companyId, parentId, code: standard.code, nameAr: standard.nameAr,
        nameEn: standard.nameEn, accountType: standard.accountType,
        reportDirection: standard.reportDirection, level: standard.level,
        isPosting: standard.isPosting, isActive: standard.isActive,
      }).returning({ id: accountsTable.id });
      codeToId.set(code, created.id);
      mappingAccountsInserted++;
      return created.id;
    }

    for (const account of NEW_COMPANY_MAPPING_ACCOUNTS) {
      if (!neededCodes.has(account.code) || codeToId.has(account.code)) continue;
      const parentId = account.parentCode ? await ensureStandardParent(account.parentCode) : null;
      const [created] = await tx.insert(accountsTable).values({
        companyId, parentId, code: account.code, nameAr: account.nameAr,
        nameEn: account.nameEn, accountType: account.accountType,
        level: account.parentCode ? 4 : 1, isPosting: true, isActive: true,
        reportDirection: account.accountType === "revenue" || account.accountType === "expense"
          ? "income_statement" : "balance_sheet",
      }).returning({ id: accountsTable.id });
      codeToId.set(account.code, created.id);
      mappingAccountsInserted++;
    }
    for (const code of neededCodes) {
      if (!codeToId.has(code) && DEFAULT_CHART_OF_ACCOUNTS.some((row) => row.code === code)) {
        await ensureStandardParent(code);
      }
    }

    // Insert only when no industry/template mapping exists. The standard
    // seeder then fills every remaining role without overwriting anything.
    for (const corrected of corrections) {
      const accountId = codeToId.get(corrected.accountCode);
      if (!accountId) continue; // Explicit incomplete error below if chart is malformed.
      await tx.insert(accountingMappingsTable).values({
        companyId, documentType: corrected.documentType,
        roleKey: corrected.roleKey, accountId,
      }).onConflictDoNothing({
        target: [accountingMappingsTable.companyId, accountingMappingsTable.documentType, accountingMappingsTable.roleKey],
      });
    }
  });
  const mappings = await seedDefaultAccountingMappings(companyId, { excludeContracting: true });

  const rows = await db.select({
    documentType: accountingMappingsTable.documentType,
    roleKey: accountingMappingsTable.roleKey,
    accountId: accountingMappingsTable.accountId,
  }).from(accountingMappingsTable).where(eq(accountingMappingsTable.companyId, companyId));
  const ids = [...new Set(rows.flatMap((row) => row.accountId == null ? [] : [row.accountId]))];
  const ownedAccounts = ids.length
    ? await db.select({ id: accountsTable.id }).from(accountsTable)
      .where(and(eq(accountsTable.companyId, companyId), inArray(accountsTable.id, ids)))
    : [];
  const unresolvedMappings = unresolvedNewCompanyMappingDefaults(
    DEFAULT_MAPPINGS.filter((m) => !m.documentType.startsWith("contracting_")),
    rows, new Set(ownedAccounts.map((row) => row.id)),
  );
  const missingAccountCodes = [...new Set(
    unresolvedMappings.map((m) => m.accountCode).filter((code) => mappings.missingAccountCodes.includes(code)),
  )];
  if (unresolvedMappings.length) {
    throw new Error(
      `New company ${companyId} accounting defaults incomplete: missing account codes [${missingAccountCodes.join(", ")}]; unresolved mappings [${unresolvedMappings.map((m) => `${m.documentType}.${m.roleKey}`).join(", ")}]`,
    );
  }
  return {
    coaInserted,
    mappingAccountsInserted,
    mappings,
    complete: true,
    missingAccountCodes,
    unresolvedMappings,
  };
}