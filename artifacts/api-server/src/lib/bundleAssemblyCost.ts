import { toStorageDecimal } from "./unitConversion.js";

export const BUNDLE_ASSEMBLY_REASON = "__BUNDLE_ASSEMBLY_V1__";

export function parseBundleAssemblyRequestId(notes: unknown): string | null {
  const match = String(notes ?? "").match(/\[bundle-assembly-request:([a-z0-9-]{16,80})\]/i);
  return match?.[1] ?? null;
}

export function deriveBundleAssemblyUnitCost(
  actualMaterialCost: number,
  outputQuantityInEntryUnit: number,
): number {
  if (!Number.isFinite(actualMaterialCost) || actualMaterialCost < 0) {
    throw new Error("Actual material cost must be a non-negative finite number");
  }
  if (!Number.isFinite(outputQuantityInEntryUnit) || outputQuantityInEntryUnit <= 0) {
    throw new Error("Assembly output quantity must be a positive finite number");
  }

  return Number(toStorageDecimal(
    String(actualMaterialCost / outputQuantityInEntryUnit),
    4,
    "half_up",
  ));
}