import { and, eq } from "drizzle-orm";
import {
  contractingBillAdditionsTable,
  contractingBillDeductionsTable,
  contractingBillPenaltiesTable,
} from "@workspace/db";
import {
  contractingAdjustmentAccountId,
  getContractingSettings,
} from "./contracting-settings.js";
import { calculateSignedContractingBillNet } from "./contracting-bill-adjustment-math.js";

type Executor = any;

export type ContractingAdjustmentDirection = "outgoing" | "incoming";

export type ContractingAdjustmentJournalLine = {
  accountId: number;
  debit: string;
  credit: string;
  description: string;
};

export type ContractingBillAdjustmentResult = {
  additions: Array<{
    amount: number;
    accountId: number;
    label: string;
  }>;
  mappedDeductions: Array<{
    amount: number;
    accountId: number;
    label: string;
  }>;
  mappedPenalties: Array<{
    amount: number;
    accountId: number;
    label: string;
  }>;
  additionsTotal: number;
  deductionsTotal: number;
  penaltiesTotal: number;
  /** Signed change to the bill's raw net amount: additions minus reductions. */
  signedTotal: number;
  /** Exact-cent signed change; use this instead of the legacy numeric projection. */
  signedAdjustmentAmount: string;
  adjustedNetAmount: number;
  /** Exact-cent adjusted net; the numeric field remains for existing callers. */
  adjustedNetAmountExact: string;
  total: number;
  journalLines: ContractingAdjustmentJournalLine[];
};

const numberValue = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const money = (value: number): string =>
  (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);

function failure(message: string, status = 422): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * Build the detail-adjustment portion of a contracting approval journal.
 *
 * The accounting approval transaction calls this after locking the bill.  It
 * is deliberately exported as the narrow integration contract for any future
 * advance-recovery worker: the worker can consume `journalLines` and the
 * signed totals without re-reading or inventing deduction/addition rows.
 *
 * Retention and advance rows are owned by the computed retention / advance
 * application flows. They are returned neither as generic lines nor in the
 * generic deduction total, preventing duplicate accounting.
 */
export async function buildContractingBillAdjustmentResult(
  tx: Executor,
  companyId: number,
  bill: {
    id: number;
    direction: ContractingAdjustmentDirection;
    netAmount: number | string;
  },
  mappings: Map<string, number>,
  receivableOrPayableAccountId: number,
): Promise<ContractingBillAdjustmentResult> {
  const [additions, deductions, penalties] = await Promise.all([
    tx.select().from(contractingBillAdditionsTable).where(and(
      eq(contractingBillAdditionsTable.companyId, companyId),
      eq(contractingBillAdditionsTable.billId, bill.id),
    )),
    tx.select().from(contractingBillDeductionsTable).where(and(
      eq(contractingBillDeductionsTable.companyId, companyId),
      eq(contractingBillDeductionsTable.billId, bill.id),
    )),
    tx.select().from(contractingBillPenaltiesTable).where(and(
      eq(contractingBillPenaltiesTable.companyId, companyId),
      eq(contractingBillPenaltiesTable.billId, bill.id),
    )),
  ]);
  const settings = await getContractingSettings(companyId);

  const unsupportedTaxTreatment = additions.find(
    (row: any) => String(row.taxTreatment) !== "non_taxable_settlement_adjustment",
  );
  if (unsupportedTaxTreatment) {
    throw failure(
      "المعالجة الضريبية للإضافة غير مدعومة؛ لم يتم تخفيض ضريبة القيمة المضافة تلقائياً",
      422,
    );
  }

  const additionRows = additions.filter((row: any) => numberValue(row.amount) > 0);
  const additionsWithAccounts = additionRows.map((row: any) => {
    const mappingKey = String(row.accountMappingKey ?? "").trim();
    const accountId = mappings.get(mappingKey)
      ?? contractingAdjustmentAccountId(settings, mappingKey);
    if (!mappingKey || !accountId) {
      throw failure(`مفتاح حساب الإضافة غير مربوط: ${mappingKey || "—"}`);
    }
    return {
      amount: numberValue(row.amount),
      accountId,
      label: `إضافة مالية — ${String(row.reason ?? "").trim()}`,
    };
  });

  const retentionRows = deductions.filter((row: any) => row.kind === "retention");
  if (retentionRows.length > 0) {
    const retentionTotal = retentionRows.reduce((sum: number, row: any) => sum + numberValue(row.amount), 0);
    // The bill's retentionAmount is already represented by the dedicated
    // retention journal role. A detail retention row is a legacy snapshot and
    // must not produce another journal line.
    if (Math.abs(retentionTotal - numberValue((bill as any).retentionAmount)) > 0.005) {
      throw failure("استقطاع المحتجزات في التفاصيل لا يطابق محتجزات القيد", 422);
    }
  }

  const advanceTotal = deductions
    .filter((row: any) => row.kind === "advance")
    .reduce((sum: number, row: any) => sum + numberValue(row.amount), 0);
  if (advanceTotal > 0.005) {
    throw failure("استرداد الدفعة المقدمة يتم تلقائياً من السلف الفعلية؛ احذف استقطاع السلفة اليدوي لتجنب التكرار", 422);
  }
  const mappedDeductions = deductions
    .filter((row: any) => !["retention", "advance", "settlement"].includes(String(row.kind)))
    .filter((row: any) => numberValue(row.amount) > 0)
    .map((row: any) => {
      const accountId = mappings.get("deduction")
        ?? mappings.get("deductions")
        ?? contractingAdjustmentAccountId(
          settings,
          row.kind === "materials" ? "material_deduction" : "other_deduction",
        );
      if (!accountId) throw failure("حساب الاستقطاعات غير مربوط؛ لم يتم تجاهل المبلغ");
      return {
        amount: numberValue(row.amount),
        accountId,
        label: `استقطاع ${String(row.kind)}`,
      };
    });

  const unsupportedSettlement = deductions
    .filter((row: any) => row.kind === "settlement")
    .reduce((sum: number, row: any) => sum + numberValue(row.amount), 0);
  if (unsupportedSettlement > 0.005) {
    throw failure("استقطاع التسوية يجب أن يتم من مسار تسوية المستخلص، وليس داخل قيد الاعتماد");
  }

  const mappedPenalties = penalties
    .filter((row: any) => numberValue(row.amount) > 0)
    .map((row: any) => {
      const accountKey = String(row.accountMappingKey ?? "").trim();
      const accountId = mappings.get(accountKey)
        ?? mappings.get("penalty")
        ?? mappings.get("penalties")
        ?? contractingAdjustmentAccountId(settings, "penalty");
      if (!accountId) throw failure("حساب الغرامات غير مربوط؛ لم يتم تجاهل المبلغ");
      return {
        amount: numberValue(row.amount),
        accountId,
        label: `غرامة ${String(row.penaltyType)}`,
      };
    });

  const additionsTotal = additionsWithAccounts.reduce((sum: number, row: { amount: number }) => sum + row.amount, 0);
  const deductionsTotal = mappedDeductions.reduce((sum: number, row: { amount: number }) => sum + row.amount, 0);
  const penaltiesTotal = mappedPenalties.reduce((sum: number, row: { amount: number }) => sum + row.amount, 0);
  const signedNet = calculateSignedContractingBillNet({
    rawNetAmount: bill.netAmount,
    additions,
    deductions,
    penalties,
  });
  const signedTotal = Number(signedNet.signedAdjustmentAmount);
  const adjustedNetAmount = Number(signedNet.adjustedNetAmount);
  const total = additionsTotal + deductionsTotal + penaltiesTotal;
  if (adjustedNetAmount <= 0 && numberValue(bill.netAmount) + signedTotal < -0.005) {
    throw failure("إجمالي الاستقطاعات والغرامات يتجاوز صافي المستخلص");
  }

  const outgoing = bill.direction === "outgoing";
  const journalLines: ContractingAdjustmentJournalLine[] = [];
  for (const row of additionsWithAccounts) {
    journalLines.push(outgoing
      ? { accountId: row.accountId, debit: "0.00", credit: money(row.amount), description: row.label }
      : { accountId: row.accountId, debit: money(row.amount), credit: "0.00", description: row.label });
  }
  for (const row of [...mappedDeductions, ...mappedPenalties]) {
    journalLines.push(outgoing
      ? { accountId: row.accountId, debit: money(row.amount), credit: "0.00", description: row.label }
      : { accountId: row.accountId, debit: "0.00", credit: money(row.amount), description: row.label });
  }
  if (total > 0) {
    journalLines.push(outgoing
      ? {
          accountId: receivableOrPayableAccountId,
          debit: money(additionsTotal),
          credit: money(deductionsTotal + penaltiesTotal),
          description: "صافي أثر الإضافات والاستقطاعات",
        }
      : {
          accountId: receivableOrPayableAccountId,
          debit: money(deductionsTotal + penaltiesTotal),
          credit: money(additionsTotal),
          description: "صافي أثر الإضافات والاستقطاعات",
        });
  }
  return {
    additions: additionsWithAccounts,
    mappedDeductions,
    mappedPenalties,
    additionsTotal,
    deductionsTotal,
    penaltiesTotal,
    signedTotal,
    signedAdjustmentAmount: signedNet.signedAdjustmentAmount,
    adjustedNetAmount,
    adjustedNetAmountExact: signedNet.adjustedNetAmount,
    total,
    journalLines,
  };
}