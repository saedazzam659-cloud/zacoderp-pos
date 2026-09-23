import {
  assertAllocationCapacity,
  calculateSourceAllocation,
} from "./productionCostAllocation.js";

export const CONTRACTING_COST_CATEGORIES = [
  "material",
  "labor",
  "equipment",
  "depreciation",
  "purchases",
  "subcontract",
  "direct_expense",
] as const;

export type ContractingCostCategory = typeof CONTRACTING_COST_CATEGORIES[number];

export const CONTRACTING_SOURCE_CATEGORY: Record<string, ContractingCostCategory> = {
  payroll_snapshot: "labor",
  fixed_asset_depreciation: "depreciation",
  purchase_invoice_line: "purchases",
  subcontract_bill: "subcontract",
};

export function sourceCategory(sourceType: string): ContractingCostCategory {
  const category = CONTRACTING_SOURCE_CATEGORY[sourceType];
  if (!category) {
    throw Object.assign(new Error("نوع مصدر التكلفة غير مدعوم"), {
      status: 422,
      code: "UNSUPPORTED_COST_SOURCE",
    });
  }
  return category;
}

export function validateSourceCategory(
  sourceType: string,
  requested: unknown,
): ContractingCostCategory {
  const defaultCategory = sourceCategory(sourceType);
  const category = String(requested ?? defaultCategory) as ContractingCostCategory;
  const allowed: Record<string, ContractingCostCategory[]> = {
    payroll_snapshot: ["labor"],
    fixed_asset_depreciation: ["depreciation", "equipment"],
    purchase_invoice_line: ["purchases", "direct_expense"],
    subcontract_bill: ["subcontract"],
  };
  if (!allowed[sourceType]?.includes(category)) {
    throw Object.assign(new Error("فئة التكلفة لا تتوافق مع نوع المصدر"), {
      status: 422,
      code: "SOURCE_CATEGORY_MISMATCH",
    });
  }
  return category;
}

export function analyticalAllocationAmount(input: {
  sourceAmount: number;
  alreadyAllocated: number;
  amount?: number | null;
  sharePct?: number | null;
}): { amount: number; sharePct: number | null; basis: "amount" | "percentage" } {
  const { sourceAmount, alreadyAllocated } = input;
  const percentage = input.sharePct == null ? null : Number(input.sharePct);
  const amount = input.amount == null
    ? calculateSourceAllocation(sourceAmount, Number(percentage))
    : Number(Number(input.amount).toFixed(2));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error("مبلغ التوزيع يجب أن يكون أكبر من صفر"), { status: 422 });
  }
  assertAllocationCapacity(sourceAmount, alreadyAllocated, amount);
  return {
    amount,
    sharePct: percentage,
    basis: input.amount == null ? "percentage" : "amount",
  };
}

export function categoryCoverage(categories: Iterable<string>) {
  const present = new Set(categories);
  const rows = CONTRACTING_COST_CATEGORIES.map(category => ({
    category,
    available: present.has(category),
    amount: present.has(category) ? 0 : null,
  }));
  return {
    complete: rows.every(row => row.available),
    missingCategories: rows.filter(row => !row.available).map(row => row.category),
    categories: rows,
  };
}