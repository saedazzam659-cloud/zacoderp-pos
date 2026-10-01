import { and, eq } from "drizzle-orm";
import {
  companiesTable,
  contractingBillLinesTable,
  contractingProgressBillsTable,
  contractingProjectsTable,
} from "@workspace/db";

type CountryCode = "EG" | "JO";
type CurrencyCode = "EGP" | "JOD";

export type OwnerBillLineTaxSnapshot = {
  version: 1;
  countryCode: CountryCode;
  currencyCode: CurrencyCode;
  taxBase: string;
  taxRatePercent: string;
  taxAmount: string;
};

type SnapshotLineInput = {
  id: number;
  boqLineId: number | null;
  unitSnapshot: string | null;
  currentValue: string | number;
  quotedVatPercentSnapshot: string | number | null;
  quotedPriceComponentsSnapshot: unknown;
};

type SnapshotResult = {
  lineId: number;
  snapshot: OwnerBillLineTaxSnapshot | null;
  error: string | null;
};

const cents = (value: number): number =>
  Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) : Number.NaN;

const amount = (value: number): string => (value / 100).toFixed(2);

function errorForLine(line: SnapshotLineInput, headerRate: number): string | null {
  if (line.boqLineId == null) return "سطر المستخلص غير مرتبط ببند BOQ معتمد";
  if (!String(line.unitSnapshot ?? "").trim()) return "وحدة سطر المستخلص غير مثبتة عند الاعتماد";
  const rate = Number(line.quotedVatPercentSnapshot);
  if (!Number.isFinite(rate) || Math.abs(rate - headerRate) > 0.001) {
    return "ضريبة سعر سطر BOQ لا تطابق ضريبة المستخلص";
  }
  const components = line.quotedPriceComponentsSnapshot;
  if (components != null) {
    if (!Array.isArray(components) || components.length !== 1) {
      return "تسعير السطر يتضمن مكونات ضريبية متعددة أو غير واضحة";
    }
    const component = components[0] as Record<string, unknown> | null;
    if (!component || Math.abs(Number(component.vatPercent) - rate) > 0.001) {
      return "مكون السعر المثبت لا يطابق نسبة ضريبة السطر";
    }
  }
  const baseCents = cents(Number(line.currentValue));
  if (!Number.isFinite(baseCents) || baseCents <= 0) return "قيمة الضريبة المثبتة للسطر غير صالحة";
  return null;
}

/**
 * Derives tax evidence only for simple, linked BOQ lines. It never allocates
 * bill-level VAT across lines: line VAT is rounded independently and must
 * reconcile exactly to the approved bill header before any snapshot is usable.
 */
export function resolveOwnerBillLineTaxSnapshots(input: {
  countryCode: string;
  currencyCode: string | null;
  bill: {
    grossAmount: string | number;
    previousPaid: string | number;
    retentionAmount: string | number;
    dueAmount: string | number;
    vatPercent: string | number;
    vatAmount: string | number;
    netAmount: string | number;
  };
  lines: SnapshotLineInput[];
}): SnapshotResult[] {
  const countryCode = input.countryCode.toUpperCase();
  if (countryCode !== "EG" && countryCode !== "JO") return [];
  const expectedCurrency: CurrencyCode = countryCode === "EG" ? "EGP" : "JOD";
  const currencyCode = String(input.currencyCode ?? "").toUpperCase();
  if (currencyCode !== expectedCurrency) {
    return input.lines.map(line => ({
      lineId: line.id,
      snapshot: null,
      error: "عملة المشروع المحلية غير مثبتة أو لا تطابق دولة الشركة",
    }));
  }
  const headerRate = Number(input.bill.vatPercent);
  if (!Number.isFinite(headerRate) || headerRate < 0 || headerRate > 100) {
    return input.lines.map(line => ({
      lineId: line.id,
      snapshot: null,
      error: "نسبة ضريبة المستخلص غير صالحة",
    }));
  }

  const prepared = input.lines.map(line => {
    const error = errorForLine(line, headerRate);
    if (error) return { line, snapshot: null as OwnerBillLineTaxSnapshot | null, error };
    const taxBaseCents = cents(Number(line.currentValue));
    const rate = Number(line.quotedVatPercentSnapshot);
    const taxCents = cents((taxBaseCents / 100) * rate / 100);
    const snapshot: OwnerBillLineTaxSnapshot = {
      version: 1,
      countryCode: countryCode as CountryCode,
      currencyCode: expectedCurrency,
      taxBase: amount(taxBaseCents),
      taxRatePercent: rate.toFixed(2),
      taxAmount: amount(taxCents),
    };
    return {
      line,
      error: null,
      snapshot,
    };
  });

  if (prepared.some(row => row.error)) {
    return prepared.map(row => ({
      lineId: row.line.id,
      snapshot: row.snapshot,
      error: row.error,
    }));
  }

  const sumBaseCents = prepared.reduce((sum, row) => sum + cents(Number(row.snapshot!.taxBase)), 0);
  const sumTaxCents = prepared.reduce((sum, row) => sum + cents(Number(row.snapshot!.taxAmount)), 0);
  const periodGrossCents = cents(Number(input.bill.grossAmount) - Number(input.bill.previousPaid));
  const headerTaxCents = cents(Number(input.bill.vatAmount));
  const payableBeforeTaxCents = cents(Number(input.bill.netAmount) - Number(input.bill.vatAmount));
  const dueCents = cents(Number(input.bill.dueAmount));
  const accountingInvoiceTotalCents = cents(Number(input.bill.netAmount) + Number(input.bill.retentionAmount));
  const reconciles = Number.isFinite(periodGrossCents)
    && Number.isFinite(headerTaxCents)
    && sumBaseCents === periodGrossCents
    && sumTaxCents === headerTaxCents
    && payableBeforeTaxCents === dueCents
    // Retention remains a receivable, not a discount to the taxable service.
    && accountingInvoiceTotalCents === sumBaseCents + sumTaxCents;
  if (!reconciles) {
    return prepared.map(row => ({
      lineId: row.line.id,
      snapshot: null,
      error: "إجماليات البنود والضريبة لا تتطابق مع إجماليات المستخلص المعتمدة",
    }));
  }
  return prepared.map(row => ({ lineId: row.line.id, snapshot: row.snapshot, error: null }));
}

/**
 * Approval calls this after BOQ recertification and header amount calculation,
 * in the same transaction as the journal and status transition.
 */
export async function snapshotApprovedOwnerBillTaxLines(
  tx: any,
  companyId: number,
  bill: typeof contractingProgressBillsTable.$inferSelect,
): Promise<void> {
  if (bill.direction !== "outgoing" || bill.ownerContractId == null || bill.subcontractorContractId != null) return;
  const [company] = await tx.select({ country: companiesTable.country }).from(companiesTable)
    .where(eq(companiesTable.id, companyId)).limit(1);
  const countryCode = String(company?.country ?? "").toUpperCase();
  if (countryCode !== "EG" && countryCode !== "JO") return;

  const [project] = await tx.select({ currencyCode: contractingProjectsTable.currencyCode })
    .from(contractingProjectsTable).where(and(
      eq(contractingProjectsTable.id, bill.projectId),
      eq(contractingProjectsTable.companyId, companyId),
    )).limit(1);
  const lines = await tx.select().from(contractingBillLinesTable).where(and(
    eq(contractingBillLinesTable.companyId, companyId),
    eq(contractingBillLinesTable.projectId, bill.projectId),
    eq(contractingBillLinesTable.billId, bill.id),
  ));
  if (lines.length === 0) return;

  const resolved = resolveOwnerBillLineTaxSnapshots({
    countryCode,
    currencyCode: project?.currencyCode ?? null,
    bill,
    lines,
  });
  for (const row of resolved) {
    await tx.update(contractingBillLinesTable).set({
      localTaxSnapshot: row.snapshot,
      localTaxSnapshotError: row.error,
      updatedAt: new Date(),
    }).where(and(
      eq(contractingBillLinesTable.id, row.lineId),
      eq(contractingBillLinesTable.companyId, companyId),
      eq(contractingBillLinesTable.billId, bill.id),
    ));
  }
}