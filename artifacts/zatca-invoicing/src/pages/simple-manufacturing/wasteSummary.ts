/**
 * Waste facts used by both the compact order summary and the closure form.
 *
 * Stage quantities are already snapshots in the order's finished-product
 * unit after applying the explicit stage factor.  Never derive waste from
 * planned minus produced: a routed order may have partial output, rework, or
 * a separately entered header-only loss.
 */
export type WasteStage = {
  status?: string | null;
  wasteQty?: number | string | null;
  wasteUnitFactor?: number | string | null;
  wasteClassification?: string | null;
};

function quantity(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function completedStage(stage: WasteStage): boolean {
  return stage.status === "done" || stage.status === "completed";
}

export type StageWasteSummary = {
  total: number;
  normal: number;
  abnormal: number;
};

/**
 * Aggregate only completed, non-skipped stages. A saved pending-stage draft
 * remains visible in execution history but is not part of closure evidence.
 * Unknown/legacy classifications follow the backend's abnormal bucket rather
 * than being silently treated as normal.
 */
export function stageWasteSummary(stages: readonly WasteStage[]): StageWasteSummary {
  return stages.reduce<StageWasteSummary>((summary, stage) => {
    if (!completedStage(stage)) return summary;
    const converted = Math.max(0, quantity(stage.wasteQty)) *
      Math.max(0, quantity(stage.wasteUnitFactor ?? 1) || 1);
    summary.total += converted;
    if (stage.wasteClassification === "normal") summary.normal += converted;
    else summary.abnormal += converted;
    return summary;
  }, { total: 0, normal: 0, abnormal: 0 });
}

/**
 * Header waste is an explicit reconciliation input. The only amount added
 * here is the header value beyond converted stage waste; planned/actual
 * differences are deliberately not involved.
 */
export function additionalHeaderWaste(
  headerWaste: unknown,
  stages: readonly WasteStage[],
): number {
  return Math.max(0, quantity(headerWaste) - stageWasteSummary(stages).total);
}

export function formatWasteQuantity(value: number): string {
  return String(Number(value.toFixed(6)));
}