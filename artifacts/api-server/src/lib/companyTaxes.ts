import { db } from "@workspace/db";
import { taxesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

// Lazily ensure a company has its protected ZATCA system VAT tax (KSA 15%).
// Called from the taxes list/default endpoints so every tenant always has at
// least one undeletable, ZATCA-aligned tax. If the company has no default tax
// yet, the seeded system tax becomes the default so new documents inherit 15%.
export async function ensureCompanyTaxes(companyId: number): Promise<void> {
  const existingSystem = await db
    .select({ id: taxesTable.id })
    .from(taxesTable)
    .where(and(eq(taxesTable.companyId, companyId), eq(taxesTable.isSystem, true)))
    .limit(1);
  if (existingSystem.length) return;

  const anyDefault = await db
    .select({ id: taxesTable.id })
    .from(taxesTable)
    .where(and(eq(taxesTable.companyId, companyId), eq(taxesTable.isDefault, true)))
    .limit(1);

  await db.insert(taxesTable).values({
    companyId,
    code: "VAT15",
    nameAr: "ضريبة القيمة المضافة 15%",
    nameEn: "VAT 15%",
    rate: "15",
    rateType: "percent",
    isActive: true,
    isSystem: true,
    isDefault: anyDefault.length === 0,
  });
}
