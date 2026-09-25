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
import { contractingCostReportBreakdown } from "./contracting-cost-allocation-service.js";
import { categoryCoverage } from "./contracting-cost-allocation-helper.js";
import { contractingQuotedNet } from "./contracting-accounting-math.js";

type BranchUser = Pick<AuthUser, "id" | "role" | "viewAllBranches" | "branchIds">;

type ProjectHierarchyRow = {
  id: number;
  name: string;
  parentId: number | null;
};

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
const netContractValue = (contract: any): number =>
  contract ? numberValue(contractingQuotedNet(contract.value ?? "0", contract.vatPercent ?? "15", contract.priceIncludesVat === true)) : 0;

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
 * parent_id is an additive compatibility column because contracting projects
 * predate project hierarchies. Keep this close to the only feature that reads
 * it so old tenant databases can serve the endpoint during a rolling upgrade.
 */
export async function ensureContractingProjectHierarchy(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE IF EXISTS contracting_projects
      ADD COLUMN IF NOT EXISTS parent_id INTEGER NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ctg_proj_parent_idx
      ON contracting_projects(company_id, parent_id)
  `);
}

async function descendantProjects(
  companyId: number,
  projectId: number,
  user: BranchUser,
): Promise<ProjectHierarchyRow[]> {
  const unrestricted = user.role === "admin" || user.role === "superadmin" || user.viewAllBranches;
  const branchIds = (user.branchIds ?? []).map(Number).filter(Number.isInteger);
  const branchPredicate = unrestricted
    ? sql`TRUE`
    : branchIds.length > 0
      ? sql`p.branch_id IN (${sql.join(branchIds.map(id => sql`${id}`), sql`, `)})`
      : sql`FALSE`;
  const childBranchPredicate = unrestricted
    ? sql`TRUE`
    : branchIds.length > 0
      ? sql`child.branch_id IN (${sql.join(branchIds.map(id => sql`${id}`), sql`, `)})`
      : sql`FALSE`;

  const result = await db.execute(sql`
    WITH RECURSIVE project_tree AS (
      SELECT p.id, p.name_ar, p.parent_id, ARRAY[p.id]::integer[] AS path, 0 AS depth
        FROM contracting_projects p
       WHERE p.company_id = ${companyId}
         AND p.id = ${projectId}
         AND ${branchPredicate}
      UNION ALL
      SELECT child.id, child.name_ar, child.parent_id,
             tree.path || child.id, tree.depth + 1
        FROM contracting_projects child
        JOIN project_tree tree ON child.parent_id = tree.id
       WHERE child.company_id = ${companyId}
         AND ${childBranchPredicate}
         AND NOT child.id = ANY(tree.path)
    )
    SELECT id, name_ar, parent_id, depth
      FROM project_tree
     ORDER BY depth ASC, id ASC
  `);
  return rowsOf(result).map(row => ({
    id: Number(row.id),
    name: String(row.name_ar ?? ""),
    parentId: row.parent_id == null ? null : Number(row.parent_id),
  }));
}

function sumMetric(rows: any[], key: string): number {
  return rounded(rows.reduce((sum, row) => sum + numberValue(row?.[key]), 0));
}

function aggregateSide(rows: any[]) {
  const latestBill = rows.map(row => row?.latestBill).filter(Boolean)
    .sort((left, right) => String(right.billDate ?? "").localeCompare(String(left.billDate ?? ""))
      || Number(right.id) - Number(left.id))[0] ?? null;
  return {
    baseContractValue: sumMetric(rows, "baseContractValue"),
    approvedVariationsValue: sumMetric(rows, "approvedVariationsValue"),
    adjustedContractValue: sumMetric(rows, "adjustedContractValue"),
    executedValue: sumMetric(rows, "executedValue"),
    remainingValue: sumMetric(rows, "remainingValue"),
    billCount: sumMetric(rows, "billCount"),
    certifiedBillCount: sumMetric(rows, "certifiedBillCount"),
    actualPaid: sumMetric(rows, "actualPaid"),
    due: sumMetric(rows, "due"),
    advanceActual: sumMetric(rows, "advanceActual"),
    advanceRecovered: sumMetric(rows, "advanceRecovered"),
    advanceRemaining: sumMetric(rows, "advanceRemaining"),
    retention: sumMetric(rows, "retention"),
    latestBill,
  };
}

/**
 * Combines already isolated per-project reports. Additive money/count fields
 * are summed; percentages and cumulative certificate rows are never averaged
 * or re-summed. Detail arrays are concatenated once and retain projectId.
 */
export function aggregateProjectReportRollup(entries: Array<{ projectId: number; report: any }>) {
  const owner = aggregateSide(entries.map(entry => entry.report.dashboard.ownerRevenue));
  const subcontract = aggregateSide(entries.map(entry => entry.report.dashboard.subcontractCost));
  const detailNames = ["boqStatement", "executedQuantities", "bills", "cumulative", "advance", "retention", "deductions", "variations", "pricingProfitability", "costSources"];
  const reports: Record<string, any> = {};
  for (const name of detailNames) {
    reports[name] = entries.flatMap(entry =>
      (entry.report.reports[name] ?? []).map((row: any) => ({ ...row, projectId: entry.projectId })));
  }
  const rollupCostCoverage = categoryCoverage(
    reports.costSources.map((row: any) => String(row.category)),
  );
  reports.costReconciliation = {
    authoritativeActualCost: null,
    sourceBreakdownTotal: sumMetric(reports.costSources, "amount"),
    consolidatedProjectActualCost: null,
    variance: null,
    coverageComplete: rollupCostCoverage.complete,
    missingCategories: rollupCostCoverage.missingCategories,
    note: rollupCostCoverage.complete
      ? "تفصيل مصادر التكلفة مكتمل لكل المشاريع في النطاق."
      : "تغطية التجميع غير مكتملة؛ الفئات المفقودة ليست صفراً.",
  };

  const profitabilityRows = entries.map(entry => entry.report.reports.profitability);
  const revenue = sumMetric(profitabilityRows, "revenue");
  const availableCosts = profitabilityRows.filter(row => row?.costAvailable);
  const actualCost = sumMetric(availableCosts, "actualCost");
  const completeCostCoverage = entries.length > 0 && availableCosts.length === entries.length;
  reports.profitability = {
    revenue,
    actualCost: completeCostCoverage ? actualCost : null,
    estimatedCost: null,
    profit: completeCostCoverage ? rounded(revenue - actualCost) : null,
    marginPercent: completeCostCoverage && revenue > 0
      ? rounded((revenue - actualCost) / revenue * 100) : null,
    costAvailable: completeCostCoverage,
    costCoverageProjectCount: availableCosts.length,
    projectCount: entries.length,
    costSource: "project report actual-cost sources",
    note: "هامش التجميع مشتق من إجمالي الإيراد والتكلفة المتاحة، ولا يجمع نسب المشاريع أو متوسطاتها.",
  };

  return {
    dashboard: {
      ...owner,
      state: entries[0]?.report.dashboard.state ?? null,
      ownerRevenue: owner,
      subcontractCost: subcontract,
      latestBill: entries.map(entry => entry.report.dashboard.latestBill).filter(Boolean)
        .sort((left, right) => String(right.billDate ?? "").localeCompare(String(left.billDate ?? ""))
          || Number(right.id) - Number(left.id))[0] ?? null,
    },
    reports,
    limitations: Array.from(new Set(entries.flatMap(entry => entry.report.limitations ?? []))),
    completeness: {
      certifiedBillCount: sumMetric(entries.map(entry => entry.report.completeness), "certifiedBillCount"),
      unmappedCertifiedLineCount: sumMetric(entries.map(entry => entry.report.completeness), "unmappedCertifiedLineCount"),
      profitabilityActualCostAvailable: completeCostCoverage,
    },
  };
}

export function buildBoqPricingProfitability(boqLines: any[]) {
  const subcontractByOwner = new Map<number, any[]>();
  for (const line of boqLines) {
    if (String(line.direction) !== "subcontract" || line.sourceOwnerLineId == null) continue;
    const id = Number(line.sourceOwnerLineId);
    const bucket = subcontractByOwner.get(id) ?? [];
    bucket.push(line);
    subcontractByOwner.set(id, bucket);
  }
  return boqLines.filter(line => String(line.direction) === "owner").map(line => {
    const mapped = subcontractByOwner.get(Number(line.id)) ?? [];
    const expectedRevenue = rounded(numberValue(line.totalAmount));
    const expectedMappedCost = rounded(mapped.reduce((sum, child) => sum + numberValue(child.totalAmount), 0));
    const expectedProfit = rounded(expectedRevenue - expectedMappedCost);
    return {
      ownerBoqLineId: line.id,
      mappedSubcontractLineIds: mapped.map(child => child.id),
      expectedRevenue,
      expectedMappedCost,
      expectedProfit,
      expectedMarginPercent: expectedRevenue > 0 ? rounded(expectedProfit / expectedRevenue * 100) : null,
    };
  });
}

/**
 * Read-only project reporting facade.
 *
 * It deliberately consumes the existing bill report and accounting/detail
 * services. In particular, cumulative bill values are selected from the
 * latest certified row per contract/BOQ line; they are never summed.
 */
async function getLocalContractingProjectReports(
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
        sourceOwnerLineId: contractingContractBoqLinesTable.sourceOwnerLineId,
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

  const [billsReport, settlementResult, analyticalCosts] = await Promise.all([
    contractingBillsReport(companyId, { projectId }, user),
    db.execute(sql`
      SELECT id, bill_id, owner_contract_id, subcontractor_contract_id, kind,
             direction, amount, applied_amount, taxable_advance_invoice_id,
             taxable_base_amount, taxable_vat_amount, settlement_date, status, notes, idempotency_key
        FROM contracting_accounting_settlements
       WHERE company_id = ${companyId}
         AND project_id = ${projectId}
       ORDER BY settlement_date ASC, id ASC
    `),
    contractingCostReportBreakdown(companyId, projectId),
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
  const baseContractValue = baseOwner ? netContractValue(baseOwner) : numberValue(project.contractValue);
  const approvedVariationRows = ownerContracts.filter((contract: any) =>
    isVariation(contract) && String(contract.status) === "approved",
  );
  const approvedVariationsValue = approvedVariationRows.reduce(
    (sum: number, contract: any) => sum + netContractValue(contract), 0,
  );
  const adjustedContractValue = baseContractValue + approvedVariationsValue;
  const subcontractBaseValue = subContracts.reduce((sum: number, contract: any) => sum + netContractValue(contract), 0);

  function sideRows(direction: "outgoing" | "incoming") {
    return certifiedRows.filter(row => String(row.direction) === direction);
  }

  function actualPaidForBill(row: any): number {
    const posted = settlementByBill.get(Number(row.id)) ?? [];
    return posted
      .filter(settlement => settlement.kind === settlementKindForDirection(String(row.direction))
        || settlement.kind === "advance_application")
      .reduce((sum, settlement) => sum + numberValue(settlement.amount)
        + (settlement.kind === "advance_application" ? numberValue(settlement.taxable_vat_amount) : 0), 0);
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
      sourceOwnerLineId: line.sourceOwnerLineId ?? null,
    };
  });
  const pricingProfitability = buildBoqPricingProfitability(boqLines);
  const pricingByOwnerLine = new Map(pricingProfitability.map(row => [Number(row.ownerBoqLineId), row]));
  for (const row of boqStatement) {
    if (String(row.direction) === "owner") {
      Object.assign(row, pricingByOwnerLine.get(Number(row.id)) ?? {});
    }
  }

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
      taxableAdvanceInvoiceId: settlement.taxable_advance_invoice_id == null ? null : Number(settlement.taxable_advance_invoice_id),
      prepaidVatAmount: numberValue(settlement.taxable_vat_amount),
      grossAppliedAmount: numberValue(settlement.amount) +
        (settlement.kind === "advance_application" ? numberValue(settlement.taxable_vat_amount) : 0),
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
    const baseValue = netContractValue(base);
    const approvedChildren = ownerContracts.filter((candidate: any) =>
      isVariation(candidate) && String(candidate.status) === "approved"
      && Number(candidate.parentContractId) === Number(base?.id),
    );
    const approvedValue = approvedChildren.reduce((sum: number, child: any) => sum + netContractValue(child), 0);
    return {
      id: contract.id,
      contractNumber: contract.contractNumber,
      contractType: contract.contractType,
      parentContractId: contract.parentContractId,
      status: contract.status,
      approved: String(contract.status) === "approved",
      originalValue: rounded(baseValue),
      variationValue: isVariation(contract) ? netContractValue(contract) : approvedValue,
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
  // Posted analytical allocations exclude inventory movements, which already
  // have a first-class contracting source table. Add each source family once:
  // materials from posted movements, all other categories from allocations.
  const allocatedNonMaterialCost = analyticalCosts.sources
    .filter(row => row.category !== "material")
    .reduce((sum, row) => sum + numberValue(row.amount), 0);
  const analyticalCostAvailable = analyticalCosts.sources.length > 0;
  // Once explicit analytical references exist they are the authoritative
  // execution breakdown. project.actualCost is retained as a legacy fallback:
  // material posting already increments it, so adding allocations to that
  // field would count issued inventory twice and still obscure attribution.
  const fallbackActualCost = projectActualCost > 0
    ? projectActualCost
    : workItemActualCost > 0 ? workItemActualCost : materialActualCost;
  const actualCost = analyticalCostAvailable
    ? Math.max(0, materialActualCost + allocatedNonMaterialCost)
    : Math.max(0, fallbackActualCost);
  const actualCostAvailable = projectActualCost > 0
    || analyticalCostAvailable || workItemActualCost > 0 || materialActualCost > 0;
  const costSource = analyticalCostAvailable
    ? "posted_material_movements + analytical_posted_source_allocations"
    : projectActualCost > 0
      ? "contracting_projects.actualCost"
      : workItemActualCost > 0
        ? "work_items.totalActualCost"
        : materialActualCost > 0 ? "posted_material_movements" : null;
  const costSources = [
    ...(materialActualCost !== 0 ? [{
      category: "material",
      sourceType: "contracting_material_movement",
      amount: rounded(materialActualCost),
      allocationCount: materialRows.length,
      reversalCount: materialRows.filter(row => String(row.direction) === "return").length,
      ownership: "inventory",
    }] : []),
    ...analyticalCosts.sources.map(row => ({ ...row, ownership: "analytical_reference" })),
  ];
  const effectiveCostCoverage = categoryCoverage(costSources.map(row => row.category));
  const costReconciliation = {
    authoritativeActualCost: actualCostAvailable ? rounded(actualCost) : null,
    sourceBreakdownTotal: rounded(materialActualCost + allocatedNonMaterialCost),
    consolidatedProjectActualCost: projectActualCost > 0 ? rounded(projectActualCost) : null,
    variance: projectActualCost > 0
      ? rounded(projectActualCost - materialActualCost - allocatedNonMaterialCost)
      : analyticalCostAvailable ? 0 : null,
    coverageComplete: effectiveCostCoverage.complete,
    missingCategories: effectiveCostCoverage.missingCategories,
    note: effectiveCostCoverage.complete
      ? "التفصيل التحليلي مكتمل حسب الفئات المعرفة."
      : "الفئات المفقودة غير مكتملة وليست صفراً. تكلفة المواد مأخوذة من حركات المخزون مرة واحدة، وتكلفة الباطن التحليلية لا تُجمع مع لوحة المستخلصات.",
  };
  const profitability = {
    revenue: owner.executedValue,
    actualCost: actualCostAvailable ? rounded(actualCost) : null,
    estimatedCost: null,
    profit: actualCostAvailable ? rounded(owner.executedValue - actualCost) : null,
    marginPercent: actualCostAvailable && owner.executedValue > 0
      ? rounded((owner.executedValue - actualCost) / owner.executedValue * 100) : null,
    costAvailable: actualCostAvailable,
    costSource,
    costCoverageComplete: effectiveCostCoverage.complete,
    missingCostCategories: effectiveCostCoverage.missingCategories,
    note: "الربحية تستخدم التكلفة الفعلية المتاحة فقط؛ المواد من حركة المخزون، وبقية المصادر من مراجع التوزيع التحليلي، دون تكرار تكلفة الباطن أو القيود.",
  };

  const limitations = [
    "التنفيذ التراكمي يعتمد على آخر مستخلص معتمد لكل عقد/بند، ولا يجمع القيم التراكمية المتكررة.",
    "استرداد الدفعة المقدمة والدفعات الفعلية يعتمدان على التسويات المحاسبية بحالة posted فقط.",
    "الربحية لا تقدّر تكلفة مستقبلية؛ تستخدم project.actualCost أو مصادر التنفيذ الفعلية القديمة كبديل واضح، ولا تجمع تكلفة المقاول الباطن أو المخزون مرتين.",
    ...(unmappedCertifiedLineCount > 0
      ? [`يوجد ${unmappedCertifiedLineCount} سطر مستخلص معتمد قديم غير مربوط بسطر BOQ؛ لم يُخمّن ربطه.`]
      : []),
    ...(!effectiveCostCoverage.complete
      ? [`تغطية فئات التكلفة التحليلية غير مكتملة: ${effectiveCostCoverage.missingCategories.join("، ")}؛ لا تُعرض الفئات المفقودة كصفر.`]
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
    pricingProfitability,
    costSources,
    costReconciliation,
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

export async function getContractingProjectReports(
  companyId: number,
  projectId: number,
  user?: BranchUser | null,
  options: { includeDescendants?: boolean } = {},
) {
  if (!user) throw error("غير مصرح", 401);
  await ensureContractingProjectHierarchy();
  const local = await getLocalContractingProjectReports(companyId, projectId, user);
  if (!options.includeDescendants) return local;

  const hierarchyRows = await descendantProjects(companyId, projectId, user);

  const entries = [{ projectId, report: local }];
  for (const project of hierarchyRows) {
    if (project.id === projectId) continue;
    entries.push({
      projectId: project.id,
      report: await getLocalContractingProjectReports(companyId, project.id, user),
    });
  }
  const rollup = aggregateProjectReportRollup(entries);
  return {
    ...local,
    dashboard: rollup.dashboard,
    reports: rollup.reports,
    limitations: rollup.limitations,
    completeness: rollup.completeness,
    hierarchy: {
      includesDescendants: true,
      projectIds: hierarchyRows.map(project => project.id),
      projects: hierarchyRows,
      localSummary: local.dashboard,
      summary: rollup.dashboard,
    },
  };
}