import { and, asc, desc, eq } from "drizzle-orm";
import {
  db,
  contractingBillAdditionsTable,
  contractingBillDeductionsTable,
  contractingBillLinesTable,
  contractingBillPenaltiesTable,
  contractingContractBoqLinesTable,
  contractingContractorsTable,
  contractingOwnerContractsTable,
  contractingProgressBillsTable,
  contractingProjectsTable,
  contractingSubContractsTable,
  contractingWorkItemsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AuthUser } from "../middleware/auth.js";
import { contractingBranchAllowed } from "./contracting-security.js";
import { ensureContractingAccountingTables } from "./contracting-accounting-storage.js";
import { ensureContractingBillDetailsTables, contractingBillsReport } from "./contracting-bill-details-service.js";
import { ensureContractingBoqTables } from "./contracting-boq-service.js";
import { reportBillIsCertified, reportOwnerContractScope } from "./contracting-report-math.js";
import { sumExactCents } from "./contracting-bill-adjustment-math.js";

type BranchUser = Pick<AuthUser, "id" | "role" | "viewAllBranches" | "branchIds">;

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function rowsOf(value: any): any[] {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.rows) ? value.rows : [];
}

function error(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function billIsCertified(bill: any): boolean {
  return reportBillIsCertified(String(bill.status ?? ""), bill.reversalJournalEntryId);
}

function isVariation(contract: any): boolean {
  return ["change_order", "addendum"].includes(String(contract.contractType));
}

function contractScopeKey(row: any): string {
  return `${row.direction}:${row.contractBaseId ?? row.contractId ?? "project"}`;
}

function latestByScope(rows: any[]): Map<string, any> {
  const latest = new Map<string, any>();
  for (const row of rows) {
    const key = contractScopeKey(row);
    const existing = latest.get(key);
    const rowDate = String(row.billDate ?? "");
    const existingDate = String(existing?.billDate ?? "");
    if (!existing || rowDate > existingDate || (rowDate === existingDate && Number(row.id) > Number(existing.id))) {
      latest.set(key, row);
    }
  }
  return latest;
}

function settlementKindForDirection(direction: string): string {
  return direction === "incoming" ? "bill_payment" : "bill_receipt";
}

async function readableProject(companyId: number, projectId: number, user?: BranchUser | null) {
  const [project] = await db.select().from(contractingProjectsTable).where(and(
    eq(contractingProjectsTable.id, projectId),
    eq(contractingProjectsTable.companyId, companyId),
  ));
  if (!project) throw error("المشروع غير موجود", 404);
  if (user && !contractingBranchAllowed(user, project.branchId)) {
    throw error("لا تملك صلاحية فرع المشروع", 403);
  }
  return project;
}

/**
 * Read-only project reporting facade.
 *
 * It deliberately consumes the existing bill report and accounting/detail
 * services. In particular, cumulative bill values are selected from the
 * latest certified row per contract/BOQ line; they are never summed.
 */
export async function getContractingProjectReports(
  companyId: number,
  projectId: number,
  user?: BranchUser | null,
) {
  if (!user) throw error("غير مصرح", 401);
  const project = await readableProject(companyId, projectId, user);

  // These are additive/self-healing stores used by existing detail/accounting
  // screens. Ensuring them here keeps this read endpoint safe during rolling
  // upgrades and for older tenants.
  await Promise.all([
    ensureContractingBoqTables(),
    ensureContractingBillDetailsTables(),
    ensureContractingAccountingTables(),
  ]);

  const [ownerContracts, subContracts, contractors, boqLines, billLineRows, deductionRows, penaltyRows, additionRows, workItemCostRows, materialResult] =
    await Promise.all([
      db.select().from(contractingOwnerContractsTable).where(and(
        eq(contractingOwnerContractsTable.companyId, companyId),
        eq(contractingOwnerContractsTable.projectId, projectId),
      )).orderBy(asc(contractingOwnerContractsTable.id)),
      db.select().from(contractingSubContractsTable).where(and(
        eq(contractingSubContractsTable.companyId, companyId),
        eq(contractingSubContractsTable.projectId, projectId),
      )).orderBy(asc(contractingSubContractsTable.id)),
      db.select({ id: contractingContractorsTable.id, name: contractingContractorsTable.name })
        .from(contractingContractorsTable)
        .where(eq(contractingContractorsTable.companyId, companyId)),
      db.select({
        id: contractingContractBoqLinesTable.id,
        projectId: contractingContractBoqLinesTable.projectId,
        workItemId: contractingContractBoqLinesTable.workItemId,
        direction: contractingContractBoqLinesTable.direction,
        ownerContractId: contractingContractBoqLinesTable.ownerContractId,
        subcontractorContractId: contractingContractBoqLinesTable.subcontractorContractId,
        lineCode: contractingContractBoqLinesTable.lineCode,
        description: contractingContractBoqLinesTable.description,
        unit: contractingContractBoqLinesTable.unit,
        quantity: contractingContractBoqLinesTable.quantity,
        unitPrice: contractingContractBoqLinesTable.unitPrice,
        totalAmount: contractingContractBoqLinesTable.totalAmount,
        workItemCode: contractingWorkItemsTable.code,
        workItemName: contractingWorkItemsTable.nameAr,
      }).from(contractingContractBoqLinesTable).leftJoin(
        contractingWorkItemsTable,
        and(
          eq(contractingWorkItemsTable.id, contractingContractBoqLinesTable.workItemId),
          eq(contractingWorkItemsTable.companyId, companyId),
        ),
      ).where(and(
        eq(contractingContractBoqLinesTable.companyId, companyId),
        eq(contractingContractBoqLinesTable.projectId, projectId),
      )).orderBy(asc(contractingContractBoqLinesTable.id)),
      db.select().from(contractingBillLinesTable).where(and(
        eq(contractingBillLinesTable.companyId, companyId),
        eq(contractingBillLinesTable.projectId, projectId),
      )).orderBy(asc(contractingBillLinesTable.id)),
      db.select().from(contractingBillDeductionsTable).where(and(
        eq(contractingBillDeductionsTable.companyId, companyId),
        eq(contractingBillDeductionsTable.projectId, projectId),
      )).orderBy(asc(contractingBillDeductionsTable.id)),
      db.select().from(contractingBillPenaltiesTable).where(and(
        eq(contractingBillPenaltiesTable.companyId, companyId),
        eq(contractingBillPenaltiesTable.projectId, projectId),
      )).orderBy(asc(contractingBillPenaltiesTable.id)),
      db.select().from(contractingBillAdditionsTable).where(and(
        eq(contractingBillAdditionsTable.companyId, companyId),
        eq(contractingBillAdditionsTable.projectId, projectId),
      )).orderBy(asc(contractingBillAdditionsTable.id)),
      db.select({
        totalActualCost: contractingWorkItemsTable.totalActualCost,
      }).from(contractingWorkItemsTable).where(and(
        eq(contractingWorkItemsTable.companyId, companyId),
        eq(contractingWorkItemsTable.projectId, projectId),
      )),
      db.execute(sql`
        SELECT direction, total_cost, status
          FROM contracting_material_movements
         WHERE company_id = ${companyId}
           AND project_id = ${projectId}
           AND status = 'posted'
      `),
    ]);

  const [billsReport, settlementResult] = await Promise.all([
    contractingBillsReport(companyId, { projectId }, user),
    db.execute(sql`
      SELECT id, bill_id, owner_contract_id, subcontractor_contract_id, kind,
             direction, amount, applied_amount, settlement_date, status, notes, idempotency_key
        FROM contracting_accounting_settlements
       WHERE company_id = ${companyId}
         AND project_id = ${projectId}
       ORDER BY settlement_date ASC, id ASC
    `),
  ]);

  const allBills = Array.isArray(billsReport?.bills) ? billsReport.bills : [];
  const billById = new Map(allBills.map((bill: any) => [Number(bill.id), bill]));
  const sourceBillRows = await db.select().from(contractingProgressBillsTable).where(and(
    eq(contractingProgressBillsTable.companyId, companyId),
    eq(contractingProgressBillsTable.projectId, projectId),
  )).orderBy(desc(contractingProgressBillsTable.billDate), desc(contractingProgressBillsTable.id));
  const sourceBillById = new Map(sourceBillRows.map((bill: any) => [Number(bill.id), bill]));
  const settlements = rowsOf(settlementResult);
  const postedSettlements = settlements.filter(row => String(row.status) === "posted");
  const settlementByBill = new Map<number, any[]>();
  for (const settlement of postedSettlements) {
    if (settlement.bill_id == null) continue;
    const id = Number(settlement.bill_id);
    const bucket = settlementByBill.get(id) ?? [];
    bucket.push(settlement);
    settlementByBill.set(id, bucket);
  }
  const contractorNameById = new Map(contractors.map(contractor => [Number(contractor.id), contractor.name] as const));

  const certifiedRows = allBills.filter((bill: any) => billIsCertified({
    ...bill,
    reversalJournalEntryId: sourceBillById.get(Number(bill.id))?.reversalJournalEntryId,
  }));
  const latestCertified = latestByScope(certifiedRows);

  const ownerBaseContracts = ownerContracts.filter((contract: any) => !isVariation(contract));
  const baseOwner = ownerBaseContracts
    .slice()
    .sort((left: any, right: any) => Number(right.id) - Number(left.id))[0];
  const baseContractValue = numberValue(baseOwner?.value ?? project.contractValue);
  const approvedVariationRows = ownerContracts.filter((contract: any) =>
    isVariation(contract) && String(contract.status) === "approved",
  );
  const approvedVariationsValue = approvedVariationRows.reduce(
    (sum: number, contract: any) => sum + numberValue(contract.value), 0,
  );
  const adjustedContractValue = baseContractValue + approvedVariationsValue;
  const subcontractBaseValue = subContracts.reduce((sum: number, contract: any) => sum + numberValue(contract.value), 0);

  function sideRows(direction: "outgoing" | "incoming") {
    return certifiedRows.filter(row => String(row.direction) === direction);
  }

  function actualPaidForBill(row: any): number {
    const posted = settlementByBill.get(Number(row.id)) ?? [];
    return posted
      .filter(settlement => settlement.kind === settlementKindForDirection(String(row.direction))
        || settlement.kind === "advance_application")
      .reduce((sum, settlement) => sum + numberValue(settlement.amount), 0);
  }

  function dueForBill(row: any): number {
    // contractingBillsReport has already applied the signed settlement
    // adjustment: raw net + additions - ordinary deductions - penalties.
    // Do not subtract detail rows a second time here.
    return Math.max(0, numberValue(row.netAmount) - actualPaidForBill(row));
  }

  function sideDashboard(direction: "outgoing" | "incoming") {
    const rows = sideRows(direction);
    const latest = Array.from(latestCertified.values()).filter(row => String(row.direction) === direction);
    const isOwner = direction === "outgoing";
    const adjusted = isOwner ? adjustedContractValue : subcontractBaseValue;
    // The bill service already distinguishes current work from cumulative
    // work. Select only the latest cumulative value for each exact scope.
    const executed = latest.reduce((sum, row) => sum + numberValue(row.cumulativeWorks ?? row.grossWorks), 0);
    const actualPaid = Number(sumExactCents(rows.map((row) => actualPaidForBill(row))));
    const due = Number(sumExactCents(rows.map((row) => dueForBill(row))));
    const retention = rows.reduce((sum, row) => sum + numberValue(row.retentions), 0);
    const advanceActual = postedSettlements
      .filter(settlement => String(settlement.direction) === direction
        && settlement.kind === (isOwner ? "advance_receipt" : "advance_payment"))
      .reduce((sum, settlement) => sum + numberValue(settlement.amount), 0);
    const advanceRecovered = postedSettlements
      .filter(settlement => String(settlement.direction) === direction && settlement.kind === "advance_application")
      .reduce((sum, settlement) => sum + numberValue(settlement.amount), 0);
    return {
      baseContractValue: rounded(isOwner ? baseContractValue : subcontractBaseValue),
      approvedVariationsValue: rounded(isOwner ? approvedVariationsValue : 0),
      adjustedContractValue: rounded(adjusted),
      executedValue: rounded(executed),
      remainingValue: rounded(Math.max(0, adjusted - executed)),
      billCount: rows.length,
      certifiedBillCount: rows.length,
      actualPaid: rounded(actualPaid),
      due: rounded(due),
      advanceActual: rounded(advanceActual),
      advanceRecovered: rounded(advanceRecovered),
      advanceRemaining: rounded(Math.max(0, advanceActual - advanceRecovered)),
      retention: rounded(retention),
    };
  }

  const owner = sideDashboard("outgoing");
  const subcontract = sideDashboard("incoming");
  const latestBill = allBills
    .filter((bill: any) => String(bill.status) !== "cancelled" && String(bill.status) !== "reversed")
    .slice()
    .sort((left: any, right: any) => String(right.billDate).localeCompare(String(left.billDate))
      || Number(right.id) - Number(left.id))[0] ?? null;

  const dashboard = {
    // Top-level values intentionally represent owner revenue. Subcontract
    // costs are available separately below and are never netted into these
    // revenue KPIs.
    ...owner,
    state: project.status,
    ownerRevenue: owner,
    subcontractCost: subcontract,
    latestBill: latestBill ? {
      id: latestBill.id,
      billNumber: latestBill.billNumber,
      billDate: latestBill.billDate,
      direction: latestBill.direction,
      status: latestBill.status,
      state: latestBill.status,
      contractorName: latestBill.contractorName ?? contractorNameById.get(Number(latestBill.contractorId)) ?? null,
      settlementStatus: (settlementByBill.get(Number(latestBill.id)) ?? []).length > 0 ? "posted" : "unsettled",
    } : null,
  };

  const lineByBoq = new Map<number, any[]>();
  let unmappedCertifiedLineCount = 0;
  for (const line of billLineRows) {
    const sourceBill = sourceBillById.get(Number(line.billId));
    if (!sourceBill || !billIsCertified(sourceBill)) continue;
    if (line.boqLineId == null) {
      unmappedCertifiedLineCount += 1;
      continue;
    }
    const bucket = lineByBoq.get(Number(line.boqLineId)) ?? [];
    bucket.push({ ...line, bill: sourceBill });
    lineByBoq.set(Number(line.boqLineId), bucket);
  }
  const boqStatement = boqLines.map((line: any) => {
    const expectedDirection = String(line.direction) === "subcontract" ? "incoming" : "outgoing";
    const matching = (lineByBoq.get(Number(line.id)) ?? []).filter(row =>
      String(row.bill.direction) === expectedDirection
      && (expectedDirection === "outgoing"
        ? Number(row.bill.ownerContractId) === Number(line.ownerContractId)
        : Number(row.bill.subcontractorContractId) === Number(line.subcontractorContractId)),
    );
    const latest = matching
      .slice()
      .sort((left, right) => String(right.bill.billDate).localeCompare(String(left.bill.billDate))
        || Number(right.bill.id) - Number(left.bill.id))[0];
    const cumulativeQty = numberValue(latest?.cumulativeQty);
    const cumulativeValue = numberValue(latest?.cumulativeValue);
    return {
      id: line.id,
      direction: line.direction,
      lineCode: line.lineCode ?? line.workItemCode,
      description: line.description ?? line.workItemName,
      unit: line.unit,
      contractQuantity: numberValue(line.quantity),
      unitPrice: numberValue(line.unitPrice),
      contractValue: numberValue(line.totalAmount),
      priorQuantity: numberValue(latest?.previousQty),
      currentQuantity: numberValue(latest?.currentQty),
      cumulativeQuantity: cumulativeQty,
      remainingQuantity: rounded(Math.max(0, numberValue(line.quantity) - cumulativeQty)),
      priorValue: numberValue(latest?.previousValue),
      currentValue: numberValue(latest?.currentValue),
      cumulativeValue,
      remainingValue: rounded(Math.max(0, numberValue(line.totalAmount) - cumulativeValue)),
      completionPercent: numberValue(line.quantity) > 0
        ? rounded(Math.min(100, cumulativeQty / numberValue(line.quantity) * 100)) : 0,
      latestBillId: latest?.billId ?? null,
      latestBillNumber: latest?.bill.billNumber ?? null,
      latestBillStatus: latest?.bill.status ?? null,
    };
  });

  const billRows = allBills.map((row: any) => ({
    ...row,
    payments: billIsCertified({
      ...row,
      reversalJournalEntryId: sourceBillById.get(Number(row.id))?.reversalJournalEntryId,
    }) ? rounded(actualPaidForBill(row)) : 0,
    outstanding: billIsCertified({
      ...row,
      reversalJournalEntryId: sourceBillById.get(Number(row.id))?.reversalJournalEntryId,
    }) ? rounded(dueForBill(row)) : 0,
    actualPaid: billIsCertified({
      ...row,
      reversalJournalEntryId: sourceBillById.get(Number(row.id))?.reversalJournalEntryId,
    }) ? rounded(actualPaidForBill(row)) : 0,
    dueAmount: billIsCertified({
      ...row,
      reversalJournalEntryId: sourceBillById.get(Number(row.id))?.reversalJournalEntryId,
    }) ? rounded(dueForBill(row)) : 0,
    settlementStatus: (settlementByBill.get(Number(row.id)) ?? []).length > 0 ? "posted" : "unsettled",
    state: row.status,
  }));

  const cumulative = certifiedRows.map((row: any) => ({
    id: row.id,
    billNumber: row.billNumber,
    billDate: row.billDate,
    direction: row.direction,
    status: row.status,
    contractId: row.contractId,
    contractBaseId: row.contractBaseId,
    previousValue: numberValue(row.previousWorks),
    currentValue: numberValue(row.currentWorks),
    cumulativeValue: numberValue(row.cumulativeWorks),
    remainingValue: numberValue(row.remainingContract),
    completionPercent: numberValue(row.completionPercent),
    actualPaid: rounded(actualPaidForBill(row)),
    dueAmount: rounded(dueForBill(row)),
    settlementStatus: (settlementByBill.get(Number(row.id)) ?? []).length > 0 ? "posted" : "unsettled",
  }));

  const advance = postedSettlements
    .filter(settlement => ["advance_receipt", "advance_payment", "advance_application"].includes(String(settlement.kind)))
    .map(settlement => ({
      id: settlement.id,
      billId: settlement.bill_id == null ? null : Number(settlement.bill_id),
      billNumber: settlement.bill_id == null ? null : billById.get(Number(settlement.bill_id))?.billNumber ?? null,
      direction: settlement.direction,
      kind: settlement.kind,
      amount: numberValue(settlement.amount),
      appliedAmount: numberValue(settlement.applied_amount),
      settlementDate: settlement.settlement_date,
      status: settlement.status,
      statusLabel: "posted",
      notes: settlement.notes ?? null,
    }));

  const retention = certifiedRows.map((row: any) => ({
    billId: row.id,
    billNumber: row.billNumber,
    billDate: row.billDate,
    direction: row.direction,
    status: row.status,
    retention: numberValue(row.retentions),
    released: (settlementByBill.get(Number(row.id)) ?? [])
      .filter(settlement => settlement.kind === "retention_receipt" || settlement.kind === "retention_payment")
      .reduce((sum, settlement) => sum + numberValue(settlement.amount), 0),
    settlementStatus: (settlementByBill.get(Number(row.id)) ?? []).some(settlement =>
      settlement.kind === "retention_receipt" || settlement.kind === "retention_payment") ? "posted" : "unsettled",
  }));

  const billIdSet = new Set(allBills.map((bill: any) => Number(bill.id)));
  const deductions = [
    ...deductionRows.filter((row: any) => billIdSet.has(Number(row.billId))).map((row: any) => ({
      id: row.id, billId: row.billId, kind: row.kind, reason: row.reason, amount: numberValue(row.amount),
      percentage: row.percentage, reference: row.reference, source: "deduction",
    })),
    ...penaltyRows.filter((row: any) => billIdSet.has(Number(row.billId))).map((row: any) => ({
      id: row.id, billId: row.billId, kind: "penalty", reason: row.reason, amount: numberValue(row.amount),
      percentage: null, reference: row.reference, source: "penalty", penaltyType: row.penaltyType,
    })),
    ...additionRows.filter((row: any) => billIdSet.has(Number(row.billId))).map((row: any) => ({
      id: row.id, billId: row.billId, kind: "addition", reason: row.reason, amount: numberValue(row.amount),
      percentage: row.rate, reference: row.reference, source: "addition",
    })),
    ...postedSettlements.filter(settlement => settlement.bill_id != null).map(settlement => ({
      id: settlement.id,
      billId: Number(settlement.bill_id),
      kind: settlement.kind,
      reason: settlement.notes ?? "تسوية محاسبية مرحّلة",
      amount: numberValue(settlement.amount),
      percentage: null,
      reference: settlement.idempotency_key ?? null,
      source: "settlement",
    })),
  ];

  const variations = ownerContracts.map((contract: any) => {
    const base = isVariation(contract)
      ? ownerContracts.find((candidate: any) => Number(candidate.id) === Number(contract.parentContractId))
      : contract;
    const baseValue = numberValue(base?.value ?? 0);
    const approvedChildren = ownerContracts.filter((candidate: any) =>
      isVariation(candidate) && String(candidate.status) === "approved"
      && Number(candidate.parentContractId) === Number(base?.id),
    );
    const approvedValue = approvedChildren.reduce((sum: number, child: any) => sum + numberValue(child.value), 0);
    return {
      id: contract.id,
      contractNumber: contract.contractNumber,
      contractType: contract.contractType,
      parentContractId: contract.parentContractId,
      status: contract.status,
      approved: String(contract.status) === "approved",
      originalValue: rounded(baseValue),
      variationValue: isVariation(contract) ? numberValue(contract.value) : approvedValue,
      adjustedValue: rounded(baseValue + approvedValue),
    };
  });

  const projectActualCost = numberValue(project.actualCost);
  const workItemActualCost = workItemCostRows.reduce(
    (sum, row) => sum + numberValue(row.totalActualCost), 0,
  );
  const materialRows = rowsOf(materialResult);
  const materialActualCost = materialRows.reduce((sum, row) => {
    const amount = numberValue(row.total_cost);
    return sum + (String(row.direction) === "return" ? -amount : amount);
  }, 0);
  // Project actualCost is the authoritative consolidated figure when present.
  // Work-item actuals and posted material issues are only a transparent
  // fallback for older projects that predate that field; they are never added
  // to it and planned resource totals are never treated as actual.
  const actualCost = projectActualCost > 0
    ? projectActualCost
    : Math.max(0, workItemActualCost + materialActualCost);
  const actualCostAvailable = projectActualCost > 0 || workItemActualCost > 0 || materialActualCost > 0;
  const costSource = projectActualCost > 0
    ? "contracting_projects.actualCost"
    : actualCostAvailable ? "work_items.totalActualCost + posted_material_movements" : null;
  const profitability = {
    revenue: owner.executedValue,
    actualCost: actualCostAvailable ? rounded(actualCost) : null,
    estimatedCost: null,
    profit: actualCostAvailable ? rounded(owner.executedValue - actualCost) : null,
    marginPercent: actualCostAvailable && owner.executedValue > 0
      ? rounded((owner.executedValue - actualCost) / owner.executedValue * 100) : null,
    costAvailable: actualCostAvailable,
    costSource,
    note: "الربحية تستخدم التكلفة الفعلية المتاحة فقط؛ لا تجمع تكلفة المقاول الباطن أو المخزون مرتين، ولا تعتبر موارد التخطيط تكلفة فعلية.",
  };

  const limitations = [
    "التنفيذ التراكمي يعتمد على آخر مستخلص معتمد لكل عقد/بند، ولا يجمع القيم التراكمية المتكررة.",
    "استرداد الدفعة المقدمة والدفعات الفعلية يعتمدان على التسويات المحاسبية بحالة posted فقط.",
    "الربحية لا تقدّر تكلفة مستقبلية؛ تستخدم project.actualCost أو مصادر التنفيذ الفعلية القديمة كبديل واضح، ولا تجمع تكلفة المقاول الباطن أو المخزون مرتين.",
    ...(unmappedCertifiedLineCount > 0
      ? [`يوجد ${unmappedCertifiedLineCount} سطر مستخلص معتمد قديم غير مربوط بسطر BOQ؛ لم يُخمّن ربطه.`]
      : []),
  ];

  const reports = {
    boqStatement,
    executedQuantities: boqStatement,
    bills: billRows,
    cumulative,
    advance,
    retention,
    deductions,
    variations,
    profitability,
  };

  return {
    project: {
      id: project.id,
      code: project.code,
      nameAr: project.nameAr,
      branchId: project.branchId,
      status: project.status,
    },
    dashboard,
    reports,
    limitations,
    completeness: {
      certifiedBillCount: certifiedRows.length,
      unmappedCertifiedLineCount,
    profitabilityActualCostAvailable: actualCostAvailable,
    },
  };
}