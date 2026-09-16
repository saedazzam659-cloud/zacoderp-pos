/** Display-only estimates; the server revalidates quantities and money on save/approval. */
export type ExecutionLine = {
  id?: number | null;
  boqLineId: number | null;
  workItemName?: string | null;
  workItemCode?: string | null;
  boqLineCode?: string | null;
  unit?: string | null;
  unitSnapshot?: string | null;
  unitPriceSnapshot?: string | null;
  boqUnitPrice?: string | null;
  contractQty?: string | null;
  previousQty: string;
  currentQty: string;
  currentValue: string;
  previousValue: string;
  certificationPercent?: string | null;
  priorPendingCertifiedValue?: string | null;
  currentExecutionCertifiedValue?: string | null;
  executionValue?: string | null;
  previousPendingValue?: string | null;
  pendingValue?: string | null;
  certificationReason?: string | null;
  changeOrderId?: number | null;
  changeOrderSubcontractId?: number | null;
};

export type ExecutionInput = {
  currentQty: string;
  certificationPercent: string;
  priorPendingCertifiedValue: string;
  certificationReason: string;
};
export type ExecutionInputs = Record<number, ExecutionInput>;

export function executionInput(row: ExecutionLine): ExecutionInput {
  return {
    currentQty: String(row.currentQty ?? "0"),
    certificationPercent: String(row.certificationPercent ?? "100"),
    priorPendingCertifiedValue: String(row.priorPendingCertifiedValue ?? "0"),
    certificationReason: row.certificationReason ?? "",
  };
}
export function executionInputs(rows: ExecutionLine[]): ExecutionInputs {
  return Object.fromEntries(rows.filter(row => row.boqLineId != null)
    .map(row => [row.boqLineId!, executionInput(row)]));
}
const cents = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
export function executionEstimate(row: ExecutionLine, input: ExecutionInput) {
  const qty = Number(input.currentQty);
  const percent = Number(input.certificationPercent);
  const release = Number(input.priorPendingCertifiedValue);
  const rate = Number(row.unitPriceSnapshot ?? row.boqUnitPrice
    ?? (Number(row.currentQty) > 0 ? Number(row.executionValue ?? row.currentValue) / Number(row.currentQty) : 0));
  const previousQty = Number(row.previousQty);
  const previousPending = Number(row.previousPendingValue ?? 0);
  const executionValue = cents(qty * rate);
  const certifiedCurrent = cents(executionValue * percent / 100);
  return {
    executionValue, certifiedCurrent,
    certifiedTotal: cents(certifiedCurrent + release),
    cumulativeQty: previousQty + qty,
    remainingQty: Number(row.contractQty ?? 0) - previousQty - qty,
    pending: cents(previousPending + executionValue - certifiedCurrent - release),
    previousPending,
  };
}
export function executionValidation(rows: ExecutionLine[], values: ExecutionInputs): string | null {
  for (const row of rows) {
    if (row.boqLineId == null) continue;
    const input = values[row.boqLineId] ?? executionInput(row);
    const qty = Number(input.currentQty), percent = Number(input.certificationPercent);
    const release = Number(input.priorPendingCertifiedValue);
    const prefix = `${row.workItemName || row.boqLineCode || "البند"}: `;
    if (input.currentQty.trim() === "" || !Number.isFinite(qty) || qty < 0) return prefix + "أدخل كمية تنفيذ صحيحة";
    if (input.certificationPercent.trim() === "" || !Number.isFinite(percent) || percent < 0 || percent > 100) return prefix + "نسبة الاعتماد يجب أن تكون بين 0 و100";
    if (!Number.isFinite(release) || release < 0 || release > Number(row.previousPendingValue ?? 0) + 0.001) return prefix + "اعتماد المعلّق يتجاوز الرصيد المتاح";
    if (row.contractQty != null && executionEstimate(row, input).remainingQty < -0.0001) return prefix + "التنفيذ يتجاوز كمية العقد؛ يلزم أمر تغيير معتمد";
    if (((qty > 0 && percent < 100) || release > 0) && !input.certificationReason.trim()) return prefix + "اكتب سبب الاعتماد الجزئي أو مرجع اعتماد المعلّق";
  }
  return null;
}
export function executionPayload(rows: ExecutionLine[], values: ExecutionInputs) {
  return rows.filter(row => row.boqLineId != null).map(row => ({
    boqLineId: row.boqLineId!,
    ...(values[row.boqLineId!] ?? executionInput(row)),
  }));
}