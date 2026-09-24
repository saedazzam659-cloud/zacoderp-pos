import {
  db, accountsTable, contractingAccountingSettlementsTable,
  contractingBillAdditionsTable, contractingBillDeductionsTable,
  contractingBillPenaltiesTable, contractingProgressBillsTable,
  contractingProjectsTable, journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { and, eq, inArray, or, isNull } from "drizzle-orm";
import { calculateSignedContractingBillNet, exactCents, formatExactCents } from "./contracting-bill-adjustment-math.js";
import { contractingBranchAllowed } from "./contracting-security.js";
import type { AuthUser } from "../middleware/auth.js";

export type ContractingRecoverySummary = {
  billId: number;
  billNumber: string;
  direction: "outgoing" | "incoming";
  currentWorkAmount: string | null;
  entitlementAmount: string;
  recoveryAmount: string;
  netAfterRecovery: string;
  settlementAmount: string | null;
  remainingAdvance: string | null;
  recoveryPercent: string | null;
  recoveryMethod: string | null;
  recoveryJournals: {
    id: number; number: string; amount: string;
    debitAccounts: string[]; creditAccounts: string[];
  }[];
};

const liveBillStatuses = ["approved", "posted", "partially_paid", "paid"];
const cashKinds = ["bill_receipt", "bill_payment"];
// Actual types emitted by contracting-accounting-service and by both cash
// voucher posting routes. Receipt/payment vouchers can contain allocations
// for several contracting bills in their one shared journal.
const relatedJournalTypes = new Set([
  "contracting_outgoing_bill", "contracting_incoming_bill", "contracting_bill_reversal",
  "contracting_advance_application", "contracting_advance_application_reversal",
  "contracting_settlement", "contracting_settlement_reversal",
  "receipt", "payment",
]);

/**
 * Read only: resolve relationships by persisted IDs, never by journal numbers
 * or descriptions. Null means the journal is unrelated (and needs no extra
 * property); an empty array means related records exist but are out of scope.
 */
export async function contractingJournalRecoverySummaries(
  companyId: number,
  journalId: number,
  entryType: string,
  user: Pick<AuthUser, "role" | "viewAllBranches" | "branchIds"> | null | undefined,
): Promise<ContractingRecoverySummary[] | null> {
  if (!relatedJournalTypes.has(entryType)) return null;
  const [linkedBills, linkedSettlements] = await Promise.all([
    db.select().from(contractingProgressBillsTable).where(and(
      eq(contractingProgressBillsTable.companyId, companyId),
      or(eq(contractingProgressBillsTable.journalEntryId, journalId),
        eq(contractingProgressBillsTable.reversalJournalEntryId, journalId)),
    )),
    db.select().from(contractingAccountingSettlementsTable).where(and(
      eq(contractingAccountingSettlementsTable.companyId, companyId),
      or(eq(contractingAccountingSettlementsTable.journalEntryId, journalId),
        eq(contractingAccountingSettlementsTable.reversalJournalEntryId, journalId)),
    )),
  ]);
  if (!linkedBills.length && !linkedSettlements.length) return null;

  const ids = [...new Set([
    ...linkedBills.map((b) => b.id),
    ...linkedSettlements.flatMap((s) => s.billId == null ? [] : [s.billId]),
  ])];
  if (!ids.length) return [];
  const bills = await db.select().from(contractingProgressBillsTable).where(and(
    eq(contractingProgressBillsTable.companyId, companyId),
    inArray(contractingProgressBillsTable.id, ids),
  ));
  if (!bills.length) return [];
  const projects = await db.select().from(contractingProjectsTable).where(and(
    eq(contractingProjectsTable.companyId, companyId),
    inArray(contractingProjectsTable.id, [...new Set(bills.map((b) => b.projectId))]),
  ));
  const visibleProjects = new Set(projects
    .filter((p) => contractingBranchAllowed(user, p.branchId)).map((p) => p.id));
  const visibleBills = bills.filter((b) => visibleProjects.has(b.projectId));
  if (!visibleBills.length) return [];

  const billIds = visibleBills.map((b) => b.id);
  const [applications, additions, deductions, penalties] = await Promise.all([
    db.select().from(contractingAccountingSettlementsTable).where(and(
      eq(contractingAccountingSettlementsTable.companyId, companyId),
      inArray(contractingAccountingSettlementsTable.billId, billIds),
      eq(contractingAccountingSettlementsTable.kind, "advance_application"),
      eq(contractingAccountingSettlementsTable.status, "posted"),
      isNull(contractingAccountingSettlementsTable.reversalJournalEntryId),
    )),
    db.select().from(contractingBillAdditionsTable).where(and(
      eq(contractingBillAdditionsTable.companyId, companyId),
      inArray(contractingBillAdditionsTable.billId, billIds),
    )),
    db.select().from(contractingBillDeductionsTable).where(and(
      eq(contractingBillDeductionsTable.companyId, companyId),
      inArray(contractingBillDeductionsTable.billId, billIds),
    )),
    db.select().from(contractingBillPenaltiesTable).where(and(
      eq(contractingBillPenaltiesTable.companyId, companyId),
      inArray(contractingBillPenaltiesTable.billId, billIds),
    )),
  ]);
  const relevantJournalIds = [...new Set([
    ...applications.flatMap((s) => s.journalEntryId == null ? [] : [s.journalEntryId]),
    ...visibleBills.flatMap((b) => b.journalEntryId == null ? [] : [b.journalEntryId]),
  ])];
  const journals = relevantJournalIds.length
    ? await db.select().from(journalEntriesTable).where(and(
      eq(journalEntriesTable.companyId, companyId), inArray(journalEntriesTable.id, relevantJournalIds),
      eq(journalEntriesTable.status, "posted"),
    )) : [];
  const postedIds = applications.flatMap((s) =>
    s.journalEntryId != null && journals.some((j) => j.id === s.journalEntryId) ? [s.journalEntryId] : []);
  const lines = postedIds.length
    ? await db.select().from(journalEntryLinesTable).where(inArray(journalEntryLinesTable.entryId, postedIds)) : [];
  const accountIds = [...new Set(lines.flatMap((l) => l.accountId == null ? [] : [l.accountId]))];
  const accounts = accountIds.length
    ? await db.select().from(accountsTable).where(and(
      eq(accountsTable.companyId, companyId), inArray(accountsTable.id, accountIds),
    )) : [];
  const accountNames = new Map(accounts.map((a) => [a.id, a.nameAr]));
  const journalById = new Map(journals.map((j) => [j.id, j]));

  // The bill's own approved previousPaid is the certified cumulative gross
  // preceding this bill, NOT cash paid. Never recompute it from other bills:
  // later edits/corrections must not change this historical work snapshot.
  return Promise.all(visibleBills.sort((a, b) => a.id - b.id).map(async (bill) => {
    const approvalSnapshot = bill.approvedAt != null && bill.journalEntryId != null
      && journalById.has(bill.journalEntryId)
      && (liveBillStatuses.includes(bill.status) || bill.reversalJournalEntryId != null);
    const active = liveBillStatuses.includes(bill.status)
      && bill.journalEntryId != null && journalById.has(bill.journalEntryId)
      && bill.reversalJournalEntryId == null;
    const recoveryRows = applications.filter((s) => s.billId === bill.id && s.projectId === bill.projectId
      && s.direction === bill.direction && s.journalEntryId != null && journalById.has(s.journalEntryId));
    const recovery = recoveryRows.reduce((sum, s) => sum + exactCents(s.amount), 0n);
    const entitlement = calculateSignedContractingBillNet({
      rawNetAmount: bill.netAmount,
      additions: additions.filter((s) => s.billId === bill.id),
      deductions: deductions.filter((s) => s.billId === bill.id),
      penalties: penalties.filter((s) => s.billId === bill.id),
    }).adjustedNetAmount;
    const cash = linkedSettlements.filter((s) => s.billId === bill.id
      && s.projectId === bill.projectId && s.status === "posted"
      && s.reversalJournalEntryId == null
      && s.journalEntryId === journalId && cashKinds.includes(s.kind));
    const grouped = new Map<number, bigint>();
    for (const s of recoveryRows) grouped.set(s.journalEntryId!,
      (grouped.get(s.journalEntryId!) ?? 0n) + exactCents(s.amount));
    return {
      billId: bill.id,
      billNumber: bill.billNumber,
      direction: bill.direction as "outgoing" | "incoming",
      currentWorkAmount: approvalSnapshot && bill.grossAmount != null && bill.previousPaid != null
        ? formatExactCents(
          (exactCents(bill.grossAmount) - exactCents(bill.previousPaid)) > 0n
            ? exactCents(bill.grossAmount) - exactCents(bill.previousPaid) : 0n,
        )
        : null,
      entitlementAmount: entitlement,
      recoveryAmount: formatExactCents(recovery),
      netAfterRecovery: formatExactCents(exactCents(entitlement) - recovery),
      settlementAmount: cash.length
        ? formatExactCents(cash.reduce((sum, s) => sum + exactCents(s.amount), 0n)) : null,
      remainingAdvance: active && bill.advanceRecoveryContractAdvanceAmount != null
        ? formatExactCents(exactCents(bill.advanceRecoveryRemainingAfter)) : null,
      recoveryPercent: active && bill.advanceRecoveryContractAdvanceAmount != null
        ? bill.advanceRecoveryPercent : null,
      recoveryMethod: active && bill.advanceRecoveryContractAdvanceAmount != null
        ? bill.advanceRecoveryMethod : null,
      recoveryJournals: [...grouped.entries()].sort(([a], [b]) => a - b).map(([id, amount]) => {
        const journalLines = lines.filter((l) => l.entryId === id);
        return {
          id, number: journalById.get(id)!.docNumber ?? "",
          amount: formatExactCents(amount),
          debitAccounts: [...new Set(journalLines.filter((l) => exactCents(l.debit) > 0n)
            .flatMap((l) => l.accountId != null && accountNames.has(l.accountId) ? [accountNames.get(l.accountId)!] : []))],
          creditAccounts: [...new Set(journalLines.filter((l) => exactCents(l.credit) > 0n)
            .flatMap((l) => l.accountId != null && accountNames.has(l.accountId) ? [accountNames.get(l.accountId)!] : []))],
        };
      }),
    };
  }));
}