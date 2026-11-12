import { invoke } from "./tauri-shim";
import { emitData } from "./dataBus";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}

function desktopOnly(): never {
  throw new Error("تسويات الحسابات متاحة في تطبيق POS Desktop فقط");
}

export type AccountingAdjustmentType = "prepaid" | "accrued";
export type AccountingAdjustmentStatus = "active" | "completed" | "cancelled" | "carried_forward";
export type AccountingAdjustment = {
  id: number;
  type: AccountingAdjustmentType;
  name: string;
  expenseAccountId: number;
  contraAccountId: number;
  costCenterId: number | null;
  totalAmount: number;
  startDate: string;
  endDate: string;
  monthlyAmount: number;
  autoGenerate: boolean;
  carryForwardEnabled: boolean;
  parentAdjustmentId: number | null;
  status: AccountingAdjustmentStatus;
  notes: string | null;
  recognizedAmount: number;
  remainingAmount: number;
  runCount: number;
  lastGeneratedMonth: string | null;
};

export type AccountingAdjustmentInput = {
  type: AccountingAdjustmentType;
  name: string;
  expenseAccountId: number;
  contraAccountId: number;
  costCenterId: number | null;
  totalAmount: number;
  startDate: string;
  endDate: string;
  autoGenerate: boolean;
  carryForwardEnabled: boolean;
  notes: string | null;
};

export type GenerateSummary = {
  adjustmentId: number;
  created: { periodMonth: string; entryId: number }[];
  skipped: { periodMonth: string; reason: string }[];
  totalMonths: number;
  alreadyGenerated: number;
};

export type RunDueResult = {
  total: number;
  summary: GenerateSummary[];
};

function changed() {
  emitData("journal", "accounts", "costCenters");
}

export async function listAccountingAdjustments(): Promise<AccountingAdjustment[]> {
  if (!hasTauri()) return [];
  return await invoke<AccountingAdjustment[]>("accounting_adjustments_list");
}

export async function createAccountingAdjustment(input: AccountingAdjustmentInput): Promise<number> {
  if (!hasTauri()) desktopOnly();
  const id = await invoke<number>("accounting_adjustment_create", { input });
  changed();
  return id;
}

export async function updateAccountingAdjustment(id: number, input: AccountingAdjustmentInput): Promise<void> {
  if (!hasTauri()) desktopOnly();
  await invoke("accounting_adjustment_update", { id, input });
  changed();
}

export async function setAccountingAdjustmentStatus(id: number, status: "active" | "cancelled"): Promise<void> {
  if (!hasTauri()) desktopOnly();
  await invoke("accounting_adjustment_set_status", { id, status });
  changed();
}

export async function deleteAccountingAdjustment(id: number): Promise<void> {
  if (!hasTauri()) desktopOnly();
  await invoke("accounting_adjustment_delete", { id });
  changed();
}

export async function generateAccountingAdjustment(id: number, asOfDate: string): Promise<GenerateSummary> {
  if (!hasTauri()) desktopOnly();
  const result = await invoke<GenerateSummary>("accounting_adjustment_generate", { id, asOfDate });
  changed();
  return result;
}

export async function runDueAccountingAdjustments(asOfDate: string): Promise<RunDueResult> {
  if (!hasTauri()) desktopOnly();
  const result = await invoke<RunDueResult>("accounting_adjustments_run_due", { asOfDate });
  changed();
  return result;
}

export async function carryForwardAccountingAdjustment(
  id: number, newStartDate: string, newEndDate: string,
): Promise<number> {
  if (!hasTauri()) desktopOnly();
  const childId = await invoke<number>("accounting_adjustment_carry_forward", {
    id, newStartDate, newEndDate,
  });
  changed();
  return childId;
}
