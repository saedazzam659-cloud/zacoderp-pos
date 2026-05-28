// Client wrapper for accounting commands (Task #207).
// Tauri-only: standalone mode is the entry point. Browser-dev preview
// returns empty arrays / throws clear errors.

import { invoke } from "./tauri-shim";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}
function notImpl(): never { throw new Error("هذه الميزة متاحة في تطبيق سطح المكتب فقط"); }

// ─── Types ───────────────────────────────────────────────────────────
export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type Account = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  type: AccountType; parentId: number | null; isLeaf: boolean; balance: number;
};
export type AccountInput = {
  code: string; nameAr: string; nameEn: string | null;
  type: AccountType; parentId: number | null; isLeaf: boolean;
};

export type Supplier = {
  id: number; code: string | null; nameAr: string; nameEn: string | null;
  phone: string | null; vatNumber: string | null; balance: number; notes: string | null;
};
export type SupplierInput = {
  code: string | null; nameAr: string; nameEn: string | null;
  phone: string | null; vatNumber: string | null; notes: string | null;
};

export type CashBox = { id: number; name: string; balance: number; accountId: number | null };
export type Bank = { id: number; name: string; accountNo: string | null; balance: number; accountId: number | null };

export type PurchaseLine = {
  id?: number; itemId: number; itemName?: string;
  qty: number; unitCost: number; vatRate: number; lineTotal: number;
};
export type PaymentMethod = "credit" | "cash" | "bank";
export type Purchase = {
  id: number; invoiceNo: string; supplierId: number; supplierName: string | null;
  invoiceDate: string; subtotal: number; vatTotal: number; grandTotal: number;
  paymentMethod: PaymentMethod; cashBoxId: number | null; bankId: number | null;
  jeId: number | null; notes: string | null; lines: PurchaseLine[];
};
export type PurchaseInput = {
  supplierId: number; invoiceDate: string; paymentMethod: PaymentMethod;
  cashBoxId: number | null; bankId: number | null; notes: string | null;
  lines: PurchaseLine[];
};

export type PurchaseReturn = {
  id: number; returnNo: string; supplierId: number; supplierName: string | null;
  purchaseId: number | null; returnDate: string;
  subtotal: number; vatTotal: number; grandTotal: number;
  jeId: number | null; notes: string | null; lines: PurchaseLine[];
};
export type PurchaseReturnInput = {
  supplierId: number; purchaseId: number | null; returnDate: string;
  notes: string | null; lines: PurchaseLine[];
};

export type TxType = "receipt" | "payment";
export type PartyType = "customer" | "supplier" | "none";
export type FinancialTx = {
  id: number; txNo: string; txDate: string; txType: TxType;
  partyType: PartyType | null; partyId: number | null; partyName: string | null;
  cashBoxId: number | null; bankId: number | null; counterAccountId: number | null;
  amount: number; description: string | null; jeId: number | null;
};
export type FinancialTxInput = {
  txDate: string; txType: TxType;
  partyType: PartyType | null; partyId: number | null;
  cashBoxId: number | null; bankId: number | null; counterAccountId: number | null;
  amount: number; description: string | null;
};

export type JournalEntryLine = {
  id?: number | null; accountId: number; accountCode?: string | null; accountName?: string | null;
  debit: number; credit: number; description: string | null;
};
export type JournalEntry = {
  id: number; entryNo: string; entryDate: string; description: string | null;
  totalDebit: number; totalCredit: number;
  sourceType: string | null; sourceId: number | null;
  lines: JournalEntryLine[];
};
export type JournalEntryInput = {
  entryDate: string; description: string | null; lines: JournalEntryLine[];
};

// ─── Accounts ────────────────────────────────────────────────────────
export async function listAccounts(): Promise<Account[]> {
  if (!hasTauri()) return [];
  return await invoke<Account[]>("accounts_list");
}
export async function createAccount(input: AccountInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("accounts_create", { input });
}
export async function updateAccount(id: number, input: AccountInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("accounts_update", { id, input });
}
export async function deleteAccount(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("accounts_delete", { id });
}

// ─── Suppliers ───────────────────────────────────────────────────────
export async function listSuppliers(): Promise<Supplier[]> {
  if (!hasTauri()) return [];
  return await invoke<Supplier[]>("suppliers_list");
}
export async function createSupplier(input: SupplierInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("suppliers_create", { input });
}
export async function updateSupplier(id: number, input: SupplierInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("suppliers_update", { id, input });
}
export async function deleteSupplier(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("suppliers_delete", { id });
}

// ─── Cash boxes ──────────────────────────────────────────────────────
export async function listCashBoxes(): Promise<CashBox[]> {
  if (!hasTauri()) return [];
  return await invoke<CashBox[]>("cash_boxes_list");
}
export async function createCashBox(name: string): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("cash_boxes_create", { input: { name, accountId: null } });
}
export async function updateCashBox(id: number, name: string): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("cash_boxes_update", { id, input: { name, accountId: null } });
}
export async function deleteCashBox(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("cash_boxes_delete", { id });
}

// ─── Banks ───────────────────────────────────────────────────────────
export async function listBanks(): Promise<Bank[]> {
  if (!hasTauri()) return [];
  return await invoke<Bank[]>("banks_list");
}
export async function createBank(name: string, accountNo: string | null): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("banks_create", { input: { name, accountNo } });
}
export async function updateBank(id: number, name: string, accountNo: string | null): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("banks_update", { id, input: { name, accountNo } });
}
export async function deleteBank(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("banks_delete", { id });
}

// ─── Purchases ───────────────────────────────────────────────────────
export async function listPurchases(limit = 200): Promise<Purchase[]> {
  if (!hasTauri()) return [];
  return await invoke<Purchase[]>("purchases_list", { limit });
}
export async function getPurchase(id: number): Promise<Purchase> {
  if (!hasTauri()) notImpl();
  return await invoke<Purchase>("purchase_get", { id });
}
export async function createPurchase(input: PurchaseInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("purchase_create", { input });
}

// ─── Purchase returns ────────────────────────────────────────────────
export async function listPurchaseReturns(limit = 200): Promise<PurchaseReturn[]> {
  if (!hasTauri()) return [];
  return await invoke<PurchaseReturn[]>("purchase_returns_list", { limit });
}
export async function getPurchaseReturn(id: number): Promise<PurchaseReturn> {
  if (!hasTauri()) notImpl();
  return await invoke<PurchaseReturn>("purchase_return_get", { id });
}
export async function createPurchaseReturn(input: PurchaseReturnInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("purchase_return_create", { input });
}

// ─── Financial transactions ──────────────────────────────────────────
export async function listFinancialTx(limit = 200): Promise<FinancialTx[]> {
  if (!hasTauri()) return [];
  return await invoke<FinancialTx[]>("financial_tx_list", { limit });
}
export async function createFinancialTx(input: FinancialTxInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("financial_tx_create", { input });
}

// ─── Journal entries ─────────────────────────────────────────────────
export async function listJournalEntries(limit = 200): Promise<JournalEntry[]> {
  if (!hasTauri()) return [];
  return await invoke<JournalEntry[]>("journal_entries_list", { limit });
}
export async function getJournalEntry(id: number): Promise<JournalEntry> {
  if (!hasTauri()) notImpl();
  return await invoke<JournalEntry>("journal_entry_get", { id });
}
export async function createJournalEntry(input: JournalEntryInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("journal_entry_create", { input });
}
