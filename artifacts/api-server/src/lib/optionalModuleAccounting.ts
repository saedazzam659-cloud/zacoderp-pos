import { db, accountsTable, accountingMappingsTable, companiesTable, manufacturingSettingsTable, journalEntriesTable, invoicesTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { DEFAULT_CHART_OF_ACCOUNTS } from "./defaultChartOfAccounts.js";

type Kind = "asset" | "liability" | "revenue" | "expense";
type AccountRow = typeof accountsTable.$inferSelect;
type AccountSpec = { code: string; nameAr: string; nameEn: string; type: Kind; parent: string };
const spec = (code: string, nameAr: string, nameEn: string, type: Kind, parent: string): AccountSpec =>
  ({ code, nameAr, nameEn, type, parent });

// Codes are deliberately outside the commercial chart. Never substitute an
// ordinary receivable/payable/inventory for advances, retention or WIP.
export const CONTRACTING_ACCOUNTS = [
  spec("11901", "سلف مقاولي الباطن", "Subcontractor advances", "asset", "11"),
  spec("11902", "محتجزات لدى العملاء", "Owner retention receivable", "asset", "11"),
  spec("11903", "أعمال مقاولات تحت التنفيذ", "Contract work in progress", "asset", "11"),
  spec("21901", "دفعات مقدمة من الملاك", "Owner advances", "liability", "21"),
  spec("21902", "محتجزات مقاولي الباطن", "Subcontractor retention payable", "liability", "21"),
  spec("41901", "إيرادات المقاولات", "Contract revenue", "revenue", "41"),
  spec("41902", "إضافات مستخلص المالك", "Owner bill additions", "revenue", "41"),
  spec("41903", "استقطاعات مستخلص الباطن", "Subcontract bill deductions", "revenue", "41"),
  spec("41904", "غرامات مستخلص الباطن", "Subcontract bill penalties", "revenue", "41"),
  spec("51901", "استقطاعات مستخلص المالك", "Owner bill deductions", "expense", "51"),
  spec("51902", "غرامات مستخلص المالك", "Owner bill penalties", "expense", "51"),
  spec("51903", "إضافات مستخلص الباطن", "Subcontract bill additions", "expense", "51"),
] as const;
export const MANUFACTURING_ACCOUNTS = [
  spec("11911", "مخزون المواد الخام", "Raw material inventory", "asset", "11"),
  spec("11912", "إنتاج تحت التشغيل", "Manufacturing work in progress", "asset", "11"),
  spec("11913", "مخزون الإنتاج التام", "Finished goods inventory", "asset", "11"),
  // Issue journals CREDIT these counterparts while DEBITing WIP; these
  // are accruals, not additional expenses that would double-count cost.
  spec("21911", "أجور الإنتاج المستحقة", "Accrued manufacturing labor", "liability", "21"),
  spec("21912", "استحقاق التكاليف الصناعية", "Manufacturing overhead accrual", "liability", "21"),
  spec("51913", "فروق تكلفة التصنيع", "Manufacturing variance", "expense", "51"),
  spec("51914", "هالك التصنيع", "Manufacturing waste", "expense", "51"),
] as const;

/** Industry/template rows are inputs to *fresh* provisioning, not a tenant's
 * hand-maintained accounting. Optional defaults are exclusively owned by the
 * module seeder, even if an industry spreadsheet uses old generic accounts. */
export const OPTIONAL_MODULE_ACCOUNT_CODES: ReadonlySet<string> = new Set(
  [...CONTRACTING_ACCOUNTS, ...MANUFACTURING_ACCOUNTS].map((a) => a.code),
);
export function isOptionalModuleTemplateMapping(documentType: string): boolean {
  return documentType.startsWith("contracting_") ||
    documentType.startsWith("manufacturing_") ||
    documentType.startsWith("production_");
}

type Role = readonly [string, string, string];
export const CONTRACTING_ROLES: readonly Role[] = [
  ["contracting_advance_receipt", "advance_liability", "21901"],
  ["contracting_advance_payment", "advance_asset", "11901"],
  ["contracting_advance_application", "advance_liability", "21901"],
  ["contracting_advance_application", "advance_asset", "11901"],
  ["contracting_advance_application", "receivable", "11031"],
  ["contracting_advance_application", "payable", "21011"],
  ["contracting_retention_receipt", "retention_receivable", "11902"],
  ["contracting_retention_payment", "retention_payable", "21902"],
  ["contracting_material_movement", "inventory", "11051"],
  ["contracting_material_movement", "wip", "11903"],
  ["contracting_outgoing_bill", "receivable", "11031"],
  ["contracting_outgoing_bill", "retention_receivable", "11902"],
  ["contracting_outgoing_bill", "revenue", "41901"],
  ["contracting_outgoing_bill", "vat_output", "21041"],
  ["contracting_incoming_bill", "wip", "11903"],
  ["contracting_incoming_bill", "vat_input", "11071"],
  ["contracting_incoming_bill", "payable", "21011"],
  ["contracting_incoming_bill", "retention_payable", "21902"],
  ...(["contracting_outgoing_bill", "contracting_incoming_bill"] as const).flatMap((doc): Role[] => {
    const outgoing = doc === "contracting_outgoing_bill";
    const addition = outgoing ? "41902" : "51903";
    const deduction = outgoing ? "51901" : "41903";
    const penalty = outgoing ? "51902" : "41904";
    return [[doc, "addition", addition], [doc, "deduction", deduction],
      [doc, "deductions", deduction], [doc, "penalty", penalty], [doc, "penalties", penalty]];
  }),
];

export const MANUFACTURING_FIELDS = {
  defaultRawInventoryAccountId: "11911",
  defaultWipAccountId: "11912",
  defaultFinishedGoodsAccountId: "11913",
  defaultLaborAccountId: "21911",
  defaultOverheadAccountId: "21912",
  defaultVarianceAccountId: "51913",
  defaultWasteAccountId: "51914",
} as const;

export function missingContractingRoles(
  existing: readonly { documentType: string; roleKey: string }[],
): readonly Role[] {
  const keys = new Set(existing.map((m) => `${m.documentType}:${m.roleKey}`));
  return CONTRACTING_ROLES.filter(([doc, role]) => !keys.has(`${doc}:${role}`));
}

export function missingManufacturingFields(
  existing: Partial<Record<keyof typeof MANUFACTURING_FIELDS, number | null>> | null,
): Partial<typeof MANUFACTURING_FIELDS> {
  return Object.fromEntries(Object.entries(MANUFACTURING_FIELDS)
    .filter(([field]) => existing?.[field as keyof typeof MANUFACTURING_FIELDS] == null));
}

export type AccountingModules = { contracting?: boolean; production?: boolean; simple_manufacturing?: boolean };
export function accountingModulesFromMenu(menu: string | null | undefined): AccountingModules {
  if (!menu) return {};
  const parsed = JSON.parse(menu);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid module permissions");
  return { contracting: parsed.contracting === true, production: parsed.production === true,
    simple_manufacturing: parsed.simple_manufacturing === true };
}

/** Called only for new tenants or a disabled→enabled transition, never at startup. */
export async function seedOptionalModuleAccounting(companyId: number, modules: AccountingModules) {
  if (!modules.contracting && !modules.production && !modules.simple_manufacturing) return { accountsInserted: 0, mappingsInserted: 0 };
  return db.transaction((tx) => seedOptionalModuleAccountingTx(tx, companyId, modules));
}

export function canRollbackFreshCompany(
  persisted: { id: number; code: string | null; createdAt: Date } | undefined,
  inserted: { id: number; code: string | null; createdAt: Date },
  hasFinancialDocuments: boolean,
): boolean {
  return !!persisted && persisted.id === inserted.id &&
    persisted.code === inserted.code &&
    persisted.createdAt.getTime() === inserted.createdAt.getTime() &&
    !hasFinancialDocuments;
}

/**
 * Compensate ONLY an insertion owned by the current creation request if the
 * optional module transaction fails. The old onboarding pipeline commits
 * the company/template before this step; leaving a usable-but-unconfigured
 * new tenant is worse than rolling back its own just-created row. Never use
 * this for existing-company activation. Caller retains and reports the error.
 */
export async function seedOptionalAccountingForFreshCompany(
  created: { id: number; createdAt: Date; code: string | null },
  modules: AccountingModules,
) {
  try {
    return await seedOptionalModuleAccounting(created.id, modules);
  } catch (failure) {
    try {
      await db.transaction(async (tx) => {
        const [row] = await tx.select({
          id: companiesTable.id, code: companiesTable.code, createdAt: companiesTable.createdAt,
        }).from(companiesTable).where(eq(companiesTable.id, created.id)).for("update");
        // Refuse to cascade over operational data even if someone gained
        // access to the newly inserted tenant before onboarding returned.
        const [journal] = await tx.select({ id: journalEntriesTable.id }).from(journalEntriesTable)
          .where(eq(journalEntriesTable.companyId, created.id)).limit(1);
        const [invoice] = await tx.select({ id: invoicesTable.id }).from(invoicesTable)
          .where(eq(invoicesTable.companyId, created.id)).limit(1);
        if (!canRollbackFreshCompany(row, created, !!journal || !!invoice))
          throw new Error("Fresh-company identity changed or company acquired financial documents; automatic rollback refused");
        const removed = await tx.delete(companiesTable)
          .where(and(eq(companiesTable.id, created.id),
            // pg timestamps may carry sub-millisecond precision not retained
            // by the JS Date returned at insertion. Identity was checked
            // under this row lock above; don't require a lossy Date equality.
            created.code === null ? isNull(companiesTable.code) : eq(companiesTable.code, created.code)))
          .returning({ id: companiesTable.id });
        if (removed.length !== 1) throw new Error("Fresh-company rollback did not remove exactly one company");
      });
    } catch (rollbackError) {
      throw new Error(`Optional accounting failed for newly created company ${created.id}; guarded rollback failed: ${(rollbackError as Error).message}; provisioning error: ${(failure as Error).message}`, { cause: failure });
    }
    throw new Error(`Optional accounting failed for new company ${created.id}; its fresh insertion was rolled back: ${(failure as Error).message}`, { cause: failure });
  }
}

export async function seedOptionalModuleAccountingTx(tx: any, companyId: number, modules: AccountingModules) {
  if (!modules.contracting && !modules.production && !modules.simple_manufacturing) return { accountsInserted: 0, mappingsInserted: 0 };
  {
    // Serialize simultaneous activation requests for this tenant.
    const [company] = await tx.select({ id: companiesTable.id }).from(companiesTable)
      .where(eq(companiesTable.id, companyId)).for("update");
    if (!company) throw new Error(`Company ${companyId} not found`);
    const existing = await tx.select().from(accountsTable).where(eq(accountsTable.companyId, companyId));
    const byCode = new Map<string, AccountRow>(existing.map((a: AccountRow) => [a.code, a]));
    let accountsInserted = 0;
    const catalog = [...(modules.contracting ? CONTRACTING_ACCOUNTS : []),
      ...(modules.production || modules.simple_manufacturing ? MANUFACTURING_ACCOUNTS : [])];
    const required = new Set(catalog.map((a) => a.code));
    if (modules.contracting) for (const [, , code] of CONTRACTING_ROLES) required.add(code);
    const defs = new Map(catalog.map((a) => [a.code, a]));
    const ensure = async (code: string): Promise<number> => {
      const definition = defs.get(code) ?? DEFAULT_CHART_OF_ACCOUNTS.find((a) => a.code === code);
      if (!definition) throw new Error(`No accounting default for ${code}`);
      const type = "type" in definition ? definition.type : definition.accountType;
      const parent = "parent" in definition ? definition.parent : definition.parentCode;
      const posting = "type" in definition ? true : definition.isPosting;
      const row = byCode.get(code);
      if (row) {
        // A matching number and GL type alone do not identify an account:
        // e.g. a custom chart may use the same asset code for prepaid rent.
        const sameMeaning = row.nameAr.trim() === definition.nameAr ||
          (!!row.nameEn && row.nameEn.trim().toLowerCase() === definition.nameEn?.trim().toLowerCase());
        if (row.accountType !== type || row.isPosting !== posting || !row.isActive || !sameMeaning)
          throw new Error(`Account code ${code} exists but is incompatible with ${definition.nameEn}; fix chart before module activation`);
        return row.id;
      }
      const parentId = parent ? await ensure(parent) : null;
      const [created] = await tx.insert(accountsTable).values({
        companyId, code, parentId, accountType: type, nameAr: definition.nameAr,
        nameEn: definition.nameEn, level: parent ? (byCode.get(parent)?.level ?? 0) + 1 : 1,
        isPosting: posting, isActive: true,
        reportDirection: type === "revenue" || type === "expense" ? "income_statement" : "balance_sheet",
      }).returning();
      byCode.set(code, created);
      accountsInserted++;
      return created.id;
    };
    for (const code of required) await ensure(code);
    let mappingsInserted = 0;
    if (modules.contracting) {
      const mapped = await tx.select({ documentType: accountingMappingsTable.documentType,
        roleKey: accountingMappingsTable.roleKey }).from(accountingMappingsTable)
        .where(eq(accountingMappingsTable.companyId, companyId));
      for (const [documentType, roleKey, code] of missingContractingRoles(mapped)) {
        const inserted = await tx.insert(accountingMappingsTable).values({
          companyId, documentType, roleKey, accountId: byCode.get(code)!.id,
        }).onConflictDoNothing().returning({ id: accountingMappingsTable.id });
        mappingsInserted += inserted.length;
      }
    }
    if (modules.production || modules.simple_manufacturing) {
      const [settings] = await tx.select().from(manufacturingSettingsTable)
        .where(eq(manufacturingSettingsTable.companyId, companyId));
      const defaults = Object.fromEntries(Object.entries(missingManufacturingFields(settings))
        .map(([key, code]) => [key, byCode.get(code)!.id]));
      if (settings) {
        if (Object.keys(defaults).length) await tx.update(manufacturingSettingsTable).set(defaults)
          .where(eq(manufacturingSettingsTable.id, settings.id));
      } else {
        await tx.insert(manufacturingSettingsTable).values({ companyId, ...defaults })
          .onConflictDoNothing({ target: manufacturingSettingsTable.companyId });
      }
    }
    return { accountsInserted, mappingsInserted };
  }
}