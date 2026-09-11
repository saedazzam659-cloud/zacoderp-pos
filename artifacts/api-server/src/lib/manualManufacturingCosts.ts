export const MANUFACTURING_COST_CATEGORIES = [
  "payroll",
  "fixed_asset_depreciation",
  "prepaid_amortization",
] as const;

export type ManufacturingCostCategory = typeof MANUFACTURING_COST_CATEGORIES[number];
export type ManufacturingCostMode = "none" | "linked" | "manual";

export type ManufacturingCostConfiguration = Record<ManufacturingCostCategory, {
  mode: ManufacturingCostMode;
  amount: number;
  description: string;
  counterpartAccountId: number | null;
}>;

export function normalizedManualAmount(value: unknown): number {
  if (value == null || value === "") return 0;
  const amount = Number(value);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

/**
 * Manual costs stay as order configuration until issue. Account ownership,
 * activity, and posting checks belong to the transaction that creates/issues
 * the order, not to this side-effect-free normalizer.
 */
export function sanitizeManufacturingCostConfiguration(
  value: unknown,
): ManufacturingCostConfiguration {
  const input = value && typeof value === "object"
    ? value as Record<string, any> : {};
  const result = {} as ManufacturingCostConfiguration;
  for (const category of MANUFACTURING_COST_CATEGORIES) {
    const raw = input[category] && typeof input[category] === "object"
      ? input[category] as Record<string, any> : {};
    const mode = ["none", "linked", "manual"].includes(String(raw.mode))
      ? String(raw.mode) as ManufacturingCostMode : "none";
    const counterpartAccountId = Number.isInteger(Number(raw.counterpartAccountId)) &&
      Number(raw.counterpartAccountId) > 0
      ? Number(raw.counterpartAccountId) : null;
    result[category] = {
      mode,
      amount: Math.max(0, normalizedManualAmount(raw.amount)),
      description: typeof raw.description === "string"
        ? raw.description.trim().slice(0, 500) : "",
      counterpartAccountId,
    };
  }
  return result;
}

export function validateManufacturingCostConfiguration(
  value: unknown,
  hasExplicitConfiguration: boolean,
): ManufacturingCostConfiguration {
  const input = value && typeof value === "object"
    ? value as Record<string, any> : {};
  const normalized = sanitizeManufacturingCostConfiguration(value);
  if (!hasExplicitConfiguration) return normalized;
  for (const category of MANUFACTURING_COST_CATEGORIES) {
    const raw = input[category];
    if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
      throw Object.assign(new Error(`إعداد تكلفة ${category} غير صحيح`), { status: 400 });
    }
    const rawMode = raw?.mode == null || raw.mode === "" ? "none" : String(raw.mode);
    if (!["none", "linked", "manual"].includes(rawMode)) {
      throw Object.assign(new Error(`طريقة تكلفة ${category} غير صحيحة`), { status: 400 });
    }
    if (raw?.amount != null && raw.amount !== "" &&
        (!Number.isFinite(Number(raw.amount)) || Number(raw.amount) < 0)) {
      throw Object.assign(new Error(`مبلغ تكلفة ${category} يجب أن يكون صفراً أو موجباً`), { status: 400 });
    }
    const entry = normalized[category];
    if (entry.mode !== "manual" && entry.amount > 0) {
      throw Object.assign(new Error(`المبلغ اليدوي لا يُقبل إلا عند اختيار الطريقة اليدوية (${category})`), { status: 400 });
    }
    if (entry.mode === "manual" && entry.amount > 0 &&
        (!entry.description || !entry.counterpartAccountId)) {
      throw Object.assign(new Error(`المبلغ اليدوي الموجب يتطلب وصفاً وحساباً مقابلاً (${category})`), { status: 400 });
    }
  }
  return normalized;
}

export function manualCostEntries(meta: unknown): Array<{
  category: ManufacturingCostCategory;
  amount: number;
  description: string;
  counterpartAccountId: number;
}> {
  const configuration = (meta && typeof meta === "object"
    ? (meta as Record<string, unknown>).costConfiguration : null);
  const normalized = sanitizeManufacturingCostConfiguration(configuration);
  return MANUFACTURING_COST_CATEGORIES.flatMap((category) => {
    const entry = normalized[category];
    return entry.mode === "manual" && entry.amount > 0 && entry.counterpartAccountId
      ? [{ category, amount: entry.amount, description: entry.description,
          counterpartAccountId: entry.counterpartAccountId }]
      : [];
  });
}

export function manualCostTotal(
  meta: unknown,
  categories?: ManufacturingCostCategory[],
): number {
  const allowed = categories ? new Set(categories) : null;
  const total = manualCostEntries(meta)
    .filter((entry) => !allowed || allowed.has(entry.category))
    .reduce((sum, entry) => sum + entry.amount, 0);
  return Number(total.toFixed(2));
}