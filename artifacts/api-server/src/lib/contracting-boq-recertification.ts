import { and, asc, eq, sql } from "drizzle-orm";
import {
  contractingBillLinesTable,
  contractingContractBoqLinesTable,
  contractingOwnerContractsTable,
  contractingProgressBillsTable,
  contractingSubContractsTable,
} from "@workspace/db";
import { calculateBoqCertification } from "./contracting-boq-certification.js";

type Bill = typeof contractingProgressBillsTable.$inferSelect;
type Tx = any;

const CERTIFIED = ["approved", "certified", "posted", "partially_paid", "paid"];

function failure(message: string, status = 422): Error & { status: number } {
  const result = new Error(message) as Error & { status: number };
  result.status = status;
  return result;
}

function money(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

function quantity(value: number): string {
  return (Math.round((value + Number.EPSILON) * 10000) / 10000).toFixed(4);
}

async function lockContract(tx: Tx, companyId: number, projectId: number, bill: Bill): Promise<boolean> {
  if (bill.direction === "incoming") {
    if (bill.subcontractorContractId == null) return false;
    const result = await tx.execute(sql`
      SELECT id FROM contracting_sub_contracts
       WHERE id = ${bill.subcontractorContractId}
         AND company_id = ${companyId}
         AND project_id = ${projectId}
       FOR UPDATE
    `);
    return result.rows.length > 0;
  } else {
    if (bill.ownerContractId == null) return false;
    const result = await tx.execute(sql`
      SELECT id FROM contracting_owner_contracts
       WHERE id = ${bill.ownerContractId}
         AND company_id = ${companyId}
         AND project_id = ${projectId}
       FOR UPDATE
    `);
    return result.rows.length > 0;
  }
}

async function lockVariation(
  tx: Tx,
  companyId: number,
  projectId: number,
  bill: Bill,
  id: number,
) {
  if (bill.direction === "incoming") {
    await tx.execute(sql`
      SELECT id FROM contracting_sub_contracts
       WHERE id = ${id} AND company_id = ${companyId} AND project_id = ${projectId}
       FOR UPDATE
    `);
  } else {
    await tx.execute(sql`
      SELECT id FROM contracting_owner_contracts
       WHERE id = ${id} AND company_id = ${companyId} AND project_id = ${projectId}
       FOR UPDATE
    `);
  }
}

/**
 * A source line cannot be reversed while a later certified bill still
 * consumes its physical execution or releases its pending certification.
 * Reversals therefore proceed from the latest dependent bill backwards.
 */
export async function assertNoBoqCertificationDependents(
  tx: Tx,
  companyId: number,
  bill: Bill,
) {
  const sourceLines = await tx.select({
    line: contractingBillLinesTable,
  }).from(contractingBillLinesTable).where(and(
    eq(contractingBillLinesTable.companyId, companyId),
    eq(contractingBillLinesTable.projectId, bill.projectId),
    eq(contractingBillLinesTable.billId, bill.id),
  ));
  const boqSources = sourceLines.filter((row: any) => row.line.boqLineId != null);
  if (boqSources.length === 0) return;
  if (!await lockContract(tx, companyId, bill.projectId, bill)) {
    throw failure("لا يمكن عكس مستخلص BOQ مرتبط بعقد غير محدد", 409);
  }
  for (const source of boqSources) {
    const sourceLine = source.line;
    const dependents = await tx.select({
      line: contractingBillLinesTable,
      billDate: contractingProgressBillsTable.billDate,
      billId: contractingProgressBillsTable.id,
      status: contractingProgressBillsTable.status,
      direction: contractingProgressBillsTable.direction,
      ownerContractId: contractingProgressBillsTable.ownerContractId,
      subcontractorContractId: contractingProgressBillsTable.subcontractorContractId,
    }).from(contractingBillLinesTable).innerJoin(
      contractingProgressBillsTable,
      eq(contractingProgressBillsTable.id, contractingBillLinesTable.billId),
    ).where(and(
      eq(contractingBillLinesTable.companyId, companyId),
      eq(contractingBillLinesTable.projectId, bill.projectId),
      eq(contractingBillLinesTable.boqLineId, sourceLine.boqLineId!),
      eq(contractingProgressBillsTable.companyId, companyId),
      eq(contractingProgressBillsTable.projectId, bill.projectId),
      bill.direction === "incoming"
        ? and(
          eq(contractingProgressBillsTable.direction, "incoming"),
          eq(contractingProgressBillsTable.subcontractorContractId, bill.subcontractorContractId!),
        )
        : and(
          eq(contractingProgressBillsTable.direction, "outgoing"),
          eq(contractingProgressBillsTable.ownerContractId, bill.ownerContractId!),
        ),
      sql`${contractingProgressBillsTable.status} IN (${sql.join(CERTIFIED.map((status) => sql`${status}`), sql`, `)})`,
    ));
    for (const dependent of dependents) {
      if (dependent.billId === bill.id) continue;
      const later = String(dependent.billDate) > String(bill.billDate)
        || (String(dependent.billDate) === String(bill.billDate) && dependent.billId > bill.id);
      if (!later) continue;
      const dependentAllocations = Array.isArray(dependent.line.pendingCertificationAllocations)
        ? dependent.line.pendingCertificationAllocations
        : [];
      const releasesSource = dependentAllocations.some((allocation: any) =>
        Number(allocation?.sourceLineId) === Number(sourceLine.id)
        && Number(allocation?.amount ?? 0) > 0,
      );
      if (Number(dependent.line.currentQty) > 0 || releasesSource) {
        throw failure(
          "لا يمكن عكس أو تصحيح مصدر BOQ قبل عكس المستخلصات المعتمدة التابعة له أولاً",
          409,
        );
      }
    }
  }
}

async function approvedVariationLine(
  tx: Tx,
  companyId: number,
  bill: Bill,
  baseLine: typeof contractingContractBoqLinesTable.$inferSelect,
  variationId: number | null,
) {
  if (variationId == null) {
    return {
      quantity: Number(baseLine.quantity),
      unitPrice: Number(baseLine.unitPrice),
      unit: baseLine.unit,
    };
  }
  await lockVariation(tx, companyId, bill.projectId, bill, variationId);
  if (bill.direction === "incoming") {
    const [variation] = await tx.select().from(contractingSubContractsTable).where(and(
      eq(contractingSubContractsTable.id, variationId),
      eq(contractingSubContractsTable.companyId, companyId),
      eq(contractingSubContractsTable.projectId, bill.projectId),
    ));
    if (!variation || variation.contractType !== "change_order" || variation.status !== "approved") {
      throw failure("مرجع أمر تغيير الباطن غير معتمد أو غير صالح");
    }
    const parentId = variation.parentContractId;
    if (parentId !== bill.subcontractorContractId) {
      throw failure("مرجع أمر تغيير الباطن لا يتبع عقد المستخلص");
    }
  } else {
    const [variation] = await tx.select().from(contractingOwnerContractsTable).where(and(
      eq(contractingOwnerContractsTable.id, variationId),
      eq(contractingOwnerContractsTable.companyId, companyId),
      eq(contractingOwnerContractsTable.projectId, bill.projectId),
    ));
    if (!variation
      || !["change_order", "addendum"].includes(String(variation.contractType))
      || variation.status !== "approved") {
      throw failure("مرجع أمر التغيير غير معتمد أو غير صالح");
    }
    if (variation.parentContractId !== bill.ownerContractId) {
      throw failure("مرجع أمر التغيير لا يتبع عقد المستخلص");
    }
  }
  const [line] = await tx.select().from(contractingContractBoqLinesTable).where(and(
    eq(contractingContractBoqLinesTable.companyId, companyId),
    eq(contractingContractBoqLinesTable.projectId, bill.projectId),
    eq(contractingContractBoqLinesTable.baseLineId, baseLine.id),
    eq(contractingContractBoqLinesTable.workItemId, baseLine.workItemId),
    bill.direction === "incoming"
      ? and(
        eq(contractingContractBoqLinesTable.direction, "subcontract"),
        eq(contractingContractBoqLinesTable.subcontractorContractId, variationId),
        sql`${contractingContractBoqLinesTable.ownerContractId} IS NULL`,
      )
      : and(
        eq(contractingContractBoqLinesTable.direction, "owner"),
        eq(contractingContractBoqLinesTable.ownerContractId, variationId),
        sql`${contractingContractBoqLinesTable.subcontractorContractId} IS NULL`,
      ),
  )).for("update");
  if (!line) throw failure("أمر التغيير المعتمد لا يحتوي على سطر BOQ مرتبط بالسطر الأساسي");
  const delta = line.quantityDelta == null ? Number(line.quantity) : Number(line.quantityDelta);
  const rateDelta = line.unitPriceDelta == null ? null : Number(line.unitPriceDelta);
  const unitPrice = rateDelta == null
    ? line.unitPriceOverride == null ? Number(line.unitPrice) : Number(line.unitPriceOverride)
    : Number(baseLine.unitPrice) + rateDelta;
  if (unitPrice < -0.0001) throw failure("سعر أمر التغيير لا يمكن أن يكون سالباً");
  return {
    quantity: Math.max(0, Number(baseLine.quantity) + delta),
    unitPrice: Math.max(0, unitPrice),
    unit: line.unit,
  };
}

/**
 * Re-certifies one draft bill while the caller's transaction holds the bill
 * and exact contract locks. It intentionally considers every certified row,
 * not only rows earlier than the draft date, so a backdated draft cannot
 * overwrite a later certified chronology.
 */
export async function recertifyBoqBill(
  tx: Tx,
  companyId: number,
  bill: Bill,
) {
  const contractLocked = await lockContract(tx, companyId, bill.projectId, bill);
  const rows = await tx.select({
    line: contractingBillLinesTable,
    boq: contractingContractBoqLinesTable,
    billDate: contractingProgressBillsTable.billDate,
    sourceBillId: contractingProgressBillsTable.id,
    billStatus: contractingProgressBillsTable.status,
    billDirection: contractingProgressBillsTable.direction,
    billOwnerContractId: contractingProgressBillsTable.ownerContractId,
    billSubcontractorContractId: contractingProgressBillsTable.subcontractorContractId,
  }).from(contractingBillLinesTable)
    .innerJoin(
      contractingContractBoqLinesTable,
      and(
        eq(contractingContractBoqLinesTable.id, contractingBillLinesTable.boqLineId),
        eq(contractingContractBoqLinesTable.companyId, companyId),
      ),
    )
    .innerJoin(
      contractingProgressBillsTable,
      eq(contractingProgressBillsTable.id, contractingBillLinesTable.billId),
    )
    .where(and(
      eq(contractingBillLinesTable.companyId, companyId),
      eq(contractingBillLinesTable.billId, bill.id),
    ))
    .orderBy(asc(contractingBillLinesTable.id));
  if (rows.length === 0) return { lineCount: 0 };
  if (!contractLocked) throw failure("لا يمكن إعادة اعتماد BOQ لسطر مرتبط بعقد غير محدد", 409);
  const seen = new Set<number>();
  for (const current of rows) {
    const line = current.line;
    const [baseLine] = await tx.select().from(contractingContractBoqLinesTable)
      .where(and(
        eq(contractingContractBoqLinesTable.id, current.boq.id),
        eq(contractingContractBoqLinesTable.companyId, companyId),
      ))
      .for("update");
    if (!baseLine) throw failure("سطر BOQ غير موجود أثناء إعادة التحقق", 409);
    const belongsToContract = bill.direction === "incoming"
      ? baseLine.direction === "subcontract"
        && baseLine.subcontractorContractId === bill.subcontractorContractId
        && baseLine.ownerContractId == null
      : baseLine.direction === "owner"
        && baseLine.ownerContractId === bill.ownerContractId
        && baseLine.subcontractorContractId == null;
    if (!belongsToContract) {
      throw failure("سطر BOQ لا يتبع العقد المحدد للمستخلص", 409);
    }
    if (seen.has(baseLine.id)) throw failure("لا يمكن اعتماد مستخلص يحتوي على سطر BOQ مكرر", 409);
    seen.add(baseLine.id);
    const variationId = bill.direction === "incoming"
      ? line.changeOrderSubcontractId
      : line.changeOrderId;
    const terms = await approvedVariationLine(tx, companyId, bill, baseLine, variationId);
    const certified = await tx.select({
      line: contractingBillLinesTable,
      billDate: contractingProgressBillsTable.billDate,
      billId: contractingProgressBillsTable.id,
      status: contractingProgressBillsTable.status,
      direction: contractingProgressBillsTable.direction,
      ownerContractId: contractingProgressBillsTable.ownerContractId,
      subcontractorContractId: contractingProgressBillsTable.subcontractorContractId,
    }).from(contractingBillLinesTable).innerJoin(
      contractingProgressBillsTable,
      eq(contractingProgressBillsTable.id, contractingBillLinesTable.billId),
    ).where(and(
      eq(contractingBillLinesTable.companyId, companyId),
      eq(contractingBillLinesTable.boqLineId, baseLine.id),
      eq(contractingProgressBillsTable.companyId, companyId),
      eq(contractingProgressBillsTable.projectId, bill.projectId),
      sql`${contractingProgressBillsTable.status} IN (${sql.join(CERTIFIED.map((status) => sql`${status}`), sql`, `)})`,
      bill.direction === "incoming"
        ? and(
          eq(contractingProgressBillsTable.direction, "incoming"),
          eq(contractingProgressBillsTable.subcontractorContractId, bill.subcontractorContractId!),
        )
        : and(
          eq(contractingProgressBillsTable.direction, "outgoing"),
          eq(contractingProgressBillsTable.ownerContractId, bill.ownerContractId!),
        ),
    )).orderBy(asc(contractingProgressBillsTable.billDate), asc(contractingProgressBillsTable.id), asc(contractingBillLinesTable.id));
    let previousQty = 0;
    let previousValue = 0;
    const priorCertificationLines: Array<typeof line> = [];
    for (const prior of certified) {
      if (prior.billId === bill.id) continue;
      const later = String(prior.billDate) > String(bill.billDate)
        || (String(prior.billDate) === String(bill.billDate) && prior.billId > bill.id);
      if (later) {
        throw failure(
          `لا يمكن اعتماد مستخلص مؤرخ ${bill.billDate} بعد مستخلص معتمد لاحقاً؛ صحح التاريخ أو اعتمد المستخلص السابق أولاً`,
          409,
        );
      }
      previousQty += Number(prior.line.currentQty);
      previousValue += Number(prior.line.currentValue);
      priorCertificationLines.push(prior.line);
    }
    const currentQty = Number(line.currentQty);
    if (!Number.isFinite(currentQty) || currentQty < 0) throw failure("كمية سطر BOQ غير صالحة");
    if (previousQty + currentQty > terms.quantity + 0.0001) {
      throw failure("الاعتماد يرفض تجاوز كمية BOQ بعد إعادة التحقق من كل المستخلصات المعتمدة", 409);
    }
    let certification;
    try {
      certification = calculateBoqCertification({
        currentQty,
        unitPrice: terms.unitPrice,
        contractQuantity: terms.quantity,
        certificationPercent: line.certificationPercent,
        priorPendingCertifiedValue: line.priorPendingCertifiedValue,
        certificationReason: line.certificationReason,
        priorLines: priorCertificationLines,
      });
    } catch (caught) {
      throw failure((caught as Error)?.message ?? "بيانات اعتماد BOQ غير صالحة", 409);
    }
    const currentValue = Number(certification.currentValue);
    if (previousValue + currentValue > terms.quantity * terms.unitPrice + 0.01) {
      throw failure("الاعتماد يرفض تجاوز قيمة BOQ بعد إعادة التحقق من كل المستخلصات المعتمدة", 409);
    }
    await tx.update(contractingBillLinesTable).set({
      unitSnapshot: terms.unit,
      unitPriceSnapshot: money(terms.unitPrice),
      previousQty: quantity(previousQty),
      currentQty: quantity(currentQty),
      cumulativeQty: quantity(previousQty + currentQty),
      previousValue: money(previousValue),
      currentValue: money(currentValue),
      cumulativeValue: money(previousValue + currentValue),
      executionValue: certification.executionValue,
      certificationPercent: certification.certificationPercent,
      currentExecutionCertifiedValue: certification.currentExecutionCertifiedValue,
      priorPendingCertifiedValue: certification.priorPendingCertifiedValue,
      certificationReason: String(line.certificationReason ?? "").trim() || null,
      pendingCertificationAllocations: certification.pendingCertificationAllocations,
      updatedAt: new Date(),
    }).where(and(
      eq(contractingBillLinesTable.id, line.id),
      eq(contractingBillLinesTable.companyId, companyId),
    ));
  }
  return { lineCount: rows.length };
}