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

// Resolve the effective percent VAT rate (as a string) for a document's taxId.
// Used server-side as the authoritative line-VAT fallback so the rate no longer
// depends solely on the client-supplied per-line vatRate:
//   • taxId set + percent tax → that tax's rate (e.g. "14").
//   • taxId unset / fixed / unknown → "15" (KSA standard) so existing behaviour
//     and the ZATCA path are preserved.
// NOTE: this is a FALLBACK/default rate. A line that already carries its own
// explicit vatRate (mixed / zero-rated lines) keeps it; this only fills lines
// that omit a rate, matching how the header tax picker pre-fills the form.
export async function resolveTaxRate(
  companyId: number,
  taxId: number | null | undefined,
): Promise<string> {
  if (taxId !== null && taxId !== undefined && Number.isFinite(Number(taxId))) {
    const [t] = await db
      .select({ rate: taxesTable.rate, rateType: taxesTable.rateType })
      .from(taxesTable)
      .where(and(eq(taxesTable.id, Number(taxId)), eq(taxesTable.companyId, companyId)))
      .limit(1);
    if (t && t.rateType === "percent") {
      const n = Number(t.rate);
      if (Number.isFinite(n) && n >= 0) return String(n);
    }
  }
  return "15";
}
