// Client wrapper for financial-report data (التقارير المالية).
// A single command returns posted journal-entry lines (optionally filtered by
// date / branch / cost-center / account); the report pages derive the trial
// balance, income statement, balance sheet, and account statement from them.

import { invoke } from "./tauri-shim";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export type LedgerLine = {
  accountId: number;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  debit: number;
  credit: number;
  entryDate: string;
  entryNo: string;
  description: string | null;
  sourceType: string | null;
  branchId: number | null;
  costCenterId: number | null;
};

export type LedgerFilter = {
  toDate?: string | null;
  branchId?: number | null;
  costCenterId?: number | null;
  accountId?: number | null;
};

export async function reportLedgerLines(filter: LedgerFilter = {}): Promise<LedgerLine[]> {
  if (!hasTauri()) return [];
  return await invoke<LedgerLine[]>("report_ledger_lines", {
    toDate: filter.toDate ?? null,
    branchId: filter.branchId ?? null,
    costCenterId: filter.costCenterId ?? null,
    accountId: filter.accountId ?? null,
  });
}

/** A balance bucket grouped by account, used by trial balance / statements. */
export type AccountBucket = {
  accountId: number;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  debit: number;
  credit: number;
};

/** Account "توجيه" classification derived purely from its type. */
export function accountStatementTarget(type: AccountType): "balance_sheet" | "income_statement" {
  return type === "revenue" || type === "expense" ? "income_statement" : "balance_sheet";
}
