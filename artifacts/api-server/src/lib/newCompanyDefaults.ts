import { db, companiesTable, sequencesTable, sequenceLogsTable, sequenceCountersTable, SEQUENCE_TX_TYPES } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import ar from "../../../zatca-invoicing/src/i18n/locales/ar.json";

// The settings screen and new-company defaults use the same Arabic labels.
const sequenceNamesAr: Record<string, string> = ar.sequences.tx;

/**
 * Fresh-company-only settings. Call after the legacy template step: that step
 * can copy arbitrary template numbering definitions, so replace only THIS new
 * company's rows with predictable counters. Never call on existing tenants.
 *
 * Variants that issue numbers into the same document table share a counter:
 * an invoice paid cash and one paid by bank cannot both be "00001".
 * Auto-generated JEs likewise share the journal_entry counter.
 */
export function newCompanySequenceGroups(): string[][] {
  const groups = new Map<string, string[]>();
  for (const type of SEQUENCE_TX_TYPES) {
    const key = type === "journal_entry" || [
      "adjustment_entry", "fa_depreciation", "fa_acquisition", "fa_disposal",
      "hr_payroll", "hr_loan", "hr_eos", "hr_custody", "contracting_bill_je",
      "opening_balance_je", "stock_transfer_je", "stock_adjustment_je",
    ].includes(type) ? "journal_entry"
      : /^(sales_invoice|purchase_invoice|sales_return|purchase_return|receipt_voucher|payment_voucher)_(cash|credit|bank|foreign|mobile)$/.test(type)
        ? type.replace(/_(cash|credit|bank|foreign|mobile)$/, "")
        : type;
    const group = groups.get(key) ?? [];
    group.push(type);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export async function seedNewCompanyDefaults(
  companyId: number,
  database: Pick<typeof db, "transaction"> = db,
): Promise<void> {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error("Invalid new company id");
  await database.transaction(async (tx) => {
    const [company] = await tx.select({ id: companiesTable.id }).from(companiesTable)
      .where(eq(companiesTable.id, companyId)).for("update");
    if (!company) throw new Error(`New company ${companyId} does not exist`);

    const existing = await tx.select({
      id: sequencesTable.id,
      startNumber: sequencesTable.startNumber,
      currentNumber: sequencesTable.currentNumber,
    }).from(sequencesTable).where(eq(sequencesTable.companyId, companyId)).for("update");
    if (existing.some((row) => row.currentNumber > row.startNumber || row.currentNumber < row.startNumber)) {
      throw new Error(`Cannot reset issued or modified sequences for company ${companyId}`);
    }
    if (existing.length) {
      const ids = existing.map((row) => row.id);
      const [log] = await tx.select({ id: sequenceLogsTable.id }).from(sequenceLogsTable)
        .where(inArray(sequenceLogsTable.sequenceId, ids)).limit(1);
      const [counter] = await tx.select({ id: sequenceCountersTable.id }).from(sequenceCountersTable)
        .where(inArray(sequenceCountersTable.sequenceId, ids)).limit(1);
      if (log || counter) throw new Error(`Cannot reset sequences with usage for company ${companyId}`);
    }

    // Roll settings and numbering back together if any sequence insertion fails.
    await tx.update(companiesTable).set({
      menuLayout: "topnav",
      hideQuickAddBar: true,
      updatedAt: new Date(),
    }).where(eq(companiesTable.id, companyId));
    await tx.delete(sequencesTable).where(eq(sequencesTable.companyId, companyId));
    await tx.insert(sequencesTable).values(newCompanySequenceGroups().map((types) => {
      const nameAr = sequenceNamesAr[types[0]];
      if (!nameAr) throw new Error(`Missing Arabic sequence label: ${types[0]}`);
      return {
        companyId,
        code: types[0].toUpperCase(),
        nameAr,
        nameEn: types[0],
        prefix: "",
        monthPattern: "",
        startNumber: 1,
        currentNumber: 1,
        padLength: 5,
        isActive: true,
        monthlyReset: false,
        applySourcePrefixes: false,
        branchIds: [],
        fiscalPeriodIds: [],
        transactionTypes: types,
      };
    }));
  });
}