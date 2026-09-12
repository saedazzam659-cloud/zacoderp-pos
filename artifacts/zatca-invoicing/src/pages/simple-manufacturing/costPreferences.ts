import type {
  ManufacturingCostCategory,
  ManufacturingCostMode,
} from "./types";

/**
 * This preference is deliberately separate from an order's cost configuration.
 * It is only a convenience for choosing the category mode on a new order.
 * Source ids, amounts, counterpart accounts, treatments, and periods are
 * order/accounting facts and must never be copied from a previous order.
 */
export const SIMPLE_MANUFACTURING_COST_PREFS = "simpleManufacturingWizardCostModes";

export const SIMPLE_MANUFACTURING_COST_CATEGORIES: readonly ManufacturingCostCategory[] = [
  "payroll",
  "fixed_asset_depreciation",
  "prepaid_amortization",
];

export type SimpleManufacturingCostModes = Record<
  ManufacturingCostCategory,
  ManufacturingCostMode
>;

export const DEFAULT_SIMPLE_MANUFACTURING_COST_MODES: SimpleManufacturingCostModes = {
  payroll: "none",
  fixed_asset_depreciation: "none",
  prepaid_amortization: "none",
};

const isCostMode = (value: unknown): value is ManufacturingCostMode =>
  value === "none" || value === "linked" || value === "manual";

/**
 * Scope the server-side blob to both the authenticated user and effective
 * tenant. The server already stores uiPreferences on the user row; including
 * both identities in the screen key prevents a SuperAdmin's acting-company
 * switch from reusing this user's choices in another tenant.
 */
export function simpleManufacturingCostPrefsScreen(
  userId: number | string | null | undefined,
  tenantId: number | string | null | undefined,
): string | null {
  if (userId == null || tenantId == null) return null;
  return `${SIMPLE_MANUFACTURING_COST_PREFS}:${String(userId)}:${String(tenantId)}`;
}

/**
 * Read only the safe category mode fields from a durable preference blob.
 * Unknown keys and all order-specific values are intentionally ignored.
 */
export function sanitizeSimpleManufacturingCostModes(
  value: unknown,
): SimpleManufacturingCostModes {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const modes = candidate.modes && typeof candidate.modes === "object" && !Array.isArray(candidate.modes)
    ? candidate.modes as Record<string, unknown>
    : candidate;

  return SIMPLE_MANUFACTURING_COST_CATEGORIES.reduce<SimpleManufacturingCostModes>(
    (result, category) => {
      const mode = modes[category];
      result[category] = isCostMode(mode)
        ? mode
        : DEFAULT_SIMPLE_MANUFACTURING_COST_MODES[category];
      return result;
    },
    { ...DEFAULT_SIMPLE_MANUFACTURING_COST_MODES },
  );
}

/**
 * The only payload written by the wizard's explicit preference save action.
 * Do not add source ids, monetary values, account ids, treatments, or periods.
 */
export function serializeSimpleManufacturingCostModes(
  modes: Partial<Record<ManufacturingCostCategory, unknown>>,
): { version: 1; modes: SimpleManufacturingCostModes } {
  return {
    version: 1,
    modes: sanitizeSimpleManufacturingCostModes(modes),
  };
}