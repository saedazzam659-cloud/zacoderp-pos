import { and, eq } from "drizzle-orm";
import {
  db,
  costCentersTable,
  contractingProjectsTable,
  contractingResourcesTable,
  contractingWorkItemResourcesTable,
  contractingWorkItemsTable,
} from "@workspace/db";
import {
  listStoredResourceAnalyses,
  listStoredWorkItems,
  readIntegratedActualCosts,
} from "./contracting-execution-storage.js";
// Registers the posted-source adapter. The module depends only on the storage
// seam (not this execution facade), so the import cannot fabricate planning
// costs or create a journal cycle.
import "./contracting-cost-allocation-service.js";

type WorkItemInput = Record<string, unknown>;

function failure(message: string, status = 400): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function optionalId(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw failure(`${label} غير صالح`);
  return parsed;
}

function nonNegative(value: unknown, label: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw failure(`${label} يجب أن يكون رقماً غير سالب`);
  return parsed;
}

function percent(value: unknown, label: string, nullable = false): number | null {
  if (nullable && (value == null || value === "")) return null;
  const parsed = nonNegative(value, label);
  if (parsed > 100) throw failure(`${label} يجب ألا يتجاوز 100`);
  return parsed;
}

function money(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

function quantity(value: number): string {
  return (Math.round((value + Number.EPSILON) * 10000) / 10000).toFixed(4);
}

function dateValue(value: unknown, label: string): string | null {
  if (value == null || value === "") return null;
  const result = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    throw failure(`${label} غير صالح`);
  }
  return result;
}

function validateDateRange(start: string | null, end: string | null, label: string): void {
  if (start && end && start > end) throw failure(`تاريخ بداية ${label} يجب ألا يتجاوز تاريخ النهاية`);
}

async function assertCostCenter(companyId: number, costCenterId: number | null): Promise<void> {
  if (costCenterId == null) return;
  const [center] = await db.select({ id: costCentersTable.id }).from(costCentersTable).where(and(
    eq(costCentersTable.id, costCenterId),
    eq(costCentersTable.companyId, companyId),
    eq(costCentersTable.isActive, true),
  ));
  if (!center) throw failure("مركز التكلفة غير صالح أو غير نشط");
}

async function assertParent(
  companyId: number,
  projectId: number,
  parentWorkItemId: number | null,
  currentId?: number,
): Promise<void> {
  if (parentWorkItemId == null) return;
  const items = await listStoredWorkItems(companyId, projectId);
  const byId = new Map(items.map((item) => [item.id, item]));
  if (!byId.has(parentWorkItemId)) throw failure("بند WBS الأب يجب أن يكون من نفس المشروع");
  const seen = new Set<number>();
  let cursor: number | null = parentWorkItemId;
  while (cursor != null) {
    if (cursor === currentId || seen.has(cursor)) throw failure("لا يمكن إنشاء دورة في هيكل WBS");
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentWorkItemId ?? null;
  }
}

function workItemValues(input: WorkItemInput, current?: typeof contractingWorkItemsTable.$inferSelect) {
  const plannedQty = nonNegative(input.plannedQty ?? current?.plannedQty, "الكمية المخططة");
  // unitCost is retained as the legacy API/storage name. In execution planning
  // it is explicitly the estimated unit cost, never an actual rate.
  const estimatedUnitCost = nonNegative(input.estimatedUnitCost ?? input.unitCost ?? current?.unitCost, "تكلفة الوحدة التقديرية");
  const actualQty = nonNegative(input.actualQty ?? current?.actualQty, "الكمية الفعلية");
  const progress = percent(input.progressPercent ?? current?.progressPercent, "نسبة الإنجاز") ?? 0;
  const plannedStartDate = dateValue(input.plannedStartDate ?? current?.plannedStartDate, "تاريخ البداية المخطط");
  const plannedEndDate = dateValue(input.plannedEndDate ?? current?.plannedEndDate, "تاريخ النهاية المخطط");
  const actualStartDate = dateValue(input.actualStartDate ?? current?.actualStartDate, "تاريخ البداية الفعلي");
  const actualEndDate = dateValue(input.actualEndDate ?? current?.actualEndDate, "تاريخ النهاية الفعلي");
  validateDateRange(plannedStartDate, plannedEndDate, "التخطيط");
  validateDateRange(actualStartDate, actualEndDate, "التنفيذ الفعلي");
  return {
    plannedQty,
    estimatedUnitCost,
    actualQty,
    progress,
    plannedStartDate,
    plannedEndDate,
    actualStartDate,
    actualEndDate,
  };
}

export async function listExecutionWorkItems(companyId: number, projectId: number) {
  const items = await listStoredWorkItems(companyId, projectId);
  const analyses = await listStoredResourceAnalyses(companyId, projectId, items.map((item) => item.id));
  const actualCosts = await readIntegratedActualCosts({
    companyId,
    projectId,
    workItemIds: items.map((item) => item.id),
  });
  const analysesByItem = new Map<number, Array<Record<string, unknown>>>();
  for (const row of analyses) {
    const list = analysesByItem.get(row.analysis.workItemId) ?? [];
    list.push({ ...row.analysis, resourceName: row.resourceName, resourceType: row.resourceType, resourceUnit: row.resourceUnit });
    analysesByItem.set(row.analysis.workItemId, list);
  }
  return items.map((item) => {
    const actual = actualCosts.get(item.id) ?? { amount: 0, complete: false, sources: [] };
    const budget = Number(item.totalPlannedCost || 0);
    const earnedValue = budget * (Number(item.progressPercent || 0) / 100);
    const variance = earnedValue - actual.amount;
    return {
      ...item,
      estimatedUnitCost: item.unitCost,
      estimatedBudget: item.totalPlannedCost,
      totalActualCost: money(actual.amount),
      actualCostComplete: actual.complete,
      actualCostIncomplete: !actual.complete,
      actualCostSources: actual.sources ?? [],
      actualCostMissingCategories: actual.missingCategories ?? [],
      actualCostBoqLinked: actual.boqLinked === true,
      earnedValue: money(earnedValue),
      costPerformanceIndex: actual.amount > 0 ? earnedValue / actual.amount : 0,
      costVariance: money(variance),
      resourceAnalyses: analysesByItem.get(item.id) ?? [],
    };
  });
}

export async function createExecutionWorkItem(
  companyId: number,
  projectId: number,
  input: WorkItemInput,
) {
  const nameAr = String(input.nameAr ?? "").trim();
  if (!nameAr) throw failure("الاسم مطلوب");
  const values = workItemValues(input);
  const parentWorkItemId = optionalId(input.parentWorkItemId, "بند WBS الأب");
  const costCenterId = optionalId(input.costCenterId, "مركز التكلفة");
  await Promise.all([
    assertParent(companyId, projectId, parentWorkItemId),
    assertCostCenter(companyId, costCenterId),
  ]);
  const [row] = await db.insert(contractingWorkItemsTable).values({
    companyId,
    projectId,
    parentWorkItemId,
    code: input.code == null ? null : String(input.code).trim() || null,
    nameAr,
    description: input.description == null ? null : String(input.description),
    category: String(input.category ?? "other"),
    unit: String(input.unit ?? "m3"),
    plannedQty: quantity(values.plannedQty),
    actualQty: quantity(values.actualQty),
    unitCost: money(values.estimatedUnitCost),
    totalPlannedCost: money(values.plannedQty * values.estimatedUnitCost),
    // Never derive actual cost from estimated rates.
    totalActualCost: "0",
    progressPercent: money(values.progress),
    plannedStartDate: values.plannedStartDate,
    plannedEndDate: values.plannedEndDate,
    actualStartDate: values.actualStartDate,
    actualEndDate: values.actualEndDate,
    status: String(input.status ?? "pending"),
    contractorId: optionalId(input.contractorId, "المقاول"),
    costCenterId,
    notes: input.notes == null ? null : String(input.notes),
  }).returning();
  return row;
}

export async function updateExecutionWorkItem(
  companyId: number,
  id: number,
  input: WorkItemInput,
) {
  const [current] = await db.select().from(contractingWorkItemsTable).where(and(
    eq(contractingWorkItemsTable.id, id),
    eq(contractingWorkItemsTable.companyId, companyId),
  ));
  if (!current) throw failure("بند التنفيذ غير موجود", 404);
  if (input.nameAr !== undefined && !String(input.nameAr).trim()) {
    throw failure("الاسم مطلوب");
  }
  const values = workItemValues(input, current);
  const parentWorkItemId = input.parentWorkItemId === undefined
    ? current.parentWorkItemId
    : optionalId(input.parentWorkItemId, "بند WBS الأب");
  const costCenterId = input.costCenterId === undefined
    ? current.costCenterId
    : optionalId(input.costCenterId, "مركز التكلفة");
  await Promise.all([
    assertParent(companyId, current.projectId, parentWorkItemId, current.id),
    assertCostCenter(companyId, costCenterId),
  ]);
  const [row] = await db.update(contractingWorkItemsTable).set({
    parentWorkItemId,
    code: input.code === undefined ? current.code : String(input.code ?? "").trim() || null,
    nameAr: input.nameAr === undefined ? current.nameAr : String(input.nameAr).trim(),
    description: input.description === undefined ? current.description : String(input.description ?? "") || null,
    category: input.category === undefined ? current.category : String(input.category),
    unit: input.unit === undefined ? current.unit : String(input.unit),
    plannedQty: quantity(values.plannedQty),
    actualQty: quantity(values.actualQty),
    unitCost: money(values.estimatedUnitCost),
    totalPlannedCost: money(values.plannedQty * values.estimatedUnitCost),
    // Preserve no manually-entered/estimated actual cost.
    totalActualCost: current.totalActualCost,
    progressPercent: money(values.progress),
    plannedStartDate: values.plannedStartDate,
    plannedEndDate: values.plannedEndDate,
    actualStartDate: values.actualStartDate,
    actualEndDate: values.actualEndDate,
    status: input.status === undefined ? current.status : String(input.status),
    contractorId: input.contractorId === undefined ? current.contractorId : optionalId(input.contractorId, "المقاول"),
    costCenterId,
    notes: input.notes === undefined ? current.notes : String(input.notes ?? "") || null,
    updatedAt: new Date(),
  }).where(and(
    eq(contractingWorkItemsTable.id, id),
    eq(contractingWorkItemsTable.companyId, companyId),
  )).returning();
  return row;
}

export async function syncExecutionProjectProgress(companyId: number, projectId: number): Promise<void> {
  const items = await listStoredWorkItems(companyId, projectId);
  const totalWeight = items.reduce((sum, item) => sum + Number(item.totalPlannedCost), 0);
  const weighted = totalWeight > 0
    ? items.reduce((sum, item) => sum + Number(item.progressPercent) * Number(item.totalPlannedCost), 0) / totalWeight
    : items.reduce((sum, item) => sum + Number(item.progressPercent), 0) / Math.max(items.length, 1);
  await db.update(contractingProjectsTable).set({
    progressPercent: money(weighted),
    // actualCost is intentionally untouched: only the integration cost reader
    // can establish whether the source set is complete.
    updatedAt: new Date(),
  }).where(and(
    eq(contractingProjectsTable.id, projectId),
    eq(contractingProjectsTable.companyId, companyId),
  ));
}

export async function upsertResourceAnalysis(
  companyId: number,
  projectId: number,
  workItemId: number,
  input: Record<string, unknown>,
  analysisId?: number,
) {
  const resourceId = optionalId(input.resourceId, "المورد");
  if (resourceId == null) throw failure("المورد مطلوب");
  const [workItem] = await db.select({ id: contractingWorkItemsTable.id }).from(contractingWorkItemsTable).where(and(
    eq(contractingWorkItemsTable.id, workItemId),
    eq(contractingWorkItemsTable.companyId, companyId),
    eq(contractingWorkItemsTable.projectId, projectId),
  ));
  if (!workItem) throw failure("بند التنفيذ غير صالح لهذا المشروع");
  const [resource] = await db.select().from(contractingResourcesTable).where(and(
    eq(contractingResourcesTable.id, resourceId),
    eq(contractingResourcesTable.companyId, companyId),
    eq(contractingResourcesTable.projectId, projectId),
  ));
  if (!resource) throw failure("المورد يجب أن يكون مورداً موجوداً في نفس المشروع");
  const plannedQty = nonNegative(input.plannedQty, "الكمية المخططة");
  const wastagePercent = percent(input.wastagePercent, "نسبة الهالك", true);
  const estimatedUnitCost = nonNegative(input.estimatedUnitCost ?? resource.unitCost, "تكلفة الوحدة التقديرية");
  const estimatedTotalCost = plannedQty * (1 + Number(wastagePercent ?? 0) / 100) * estimatedUnitCost;
  const values = {
    companyId,
    projectId,
    workItemId,
    resourceId,
    plannedQty: quantity(plannedQty),
    wastagePercent: wastagePercent == null ? null : quantity(wastagePercent),
    estimatedUnitCost: money(estimatedUnitCost),
    estimatedTotalCost: money(estimatedTotalCost),
    notes: input.notes == null ? null : String(input.notes),
    updatedAt: new Date(),
  };
  if (analysisId == null) {
    const [row] = await db.insert(contractingWorkItemResourcesTable).values(values).returning();
    return row;
  }
  const [row] = await db.update(contractingWorkItemResourcesTable).set(values).where(and(
    eq(contractingWorkItemResourcesTable.id, analysisId),
    eq(contractingWorkItemResourcesTable.companyId, companyId),
    eq(contractingWorkItemResourcesTable.projectId, projectId),
    eq(contractingWorkItemResourcesTable.workItemId, workItemId),
  )).returning();
  if (!row) throw failure("تحليل المورد غير موجود", 404);
  return row;
}

export async function deleteResourceAnalysis(companyId: number, analysisId: number): Promise<void> {
  const [row] = await db.delete(contractingWorkItemResourcesTable).where(and(
    eq(contractingWorkItemResourcesTable.id, analysisId),
    eq(contractingWorkItemResourcesTable.companyId, companyId),
  )).returning({ id: contractingWorkItemResourcesTable.id });
  if (!row) throw failure("تحليل المورد غير موجود", 404);
}
