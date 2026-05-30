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
  currencyCode: string;
};
export type SupplierInput = {
  code: string | null; nameAr: string; nameEn: string | null;
  phone: string | null; vatNumber: string | null; notes: string | null;
  currencyCode?: string;
  /** Opening balance amount (native, > 0). Posted as a JE on create only. */
  openingBalance?: number;
  /** "debit" (مدين) or "credit" (دائن — default for suppliers, we owe them). */
  openingNature?: "debit" | "credit";
  openingDate?: string;
};

export type CashBox = { id: number; name: string; balance: number; accountId: number | null; currencyCode: string };
export type Bank = { id: number; name: string; accountNo: string | null; balance: number; accountId: number | null; currencyCode: string };

// ─── Multi-currency (Task #209) ──────────────────────────────────────
export type Currency = {
  code: string; nameAr: string; nameEn: string | null; symbol: string | null;
  decimals: number; isBase: boolean; isActive: boolean;
  currentRate: number | null; rateAsOf: string | null;
};
export type CurrencyInput = {
  code: string; nameAr: string; nameEn: string | null; symbol: string | null;
  decimals?: number; isActive?: boolean;
};
export type CurrencyRate = {
  id: number; currencyCode: string; rateToBase: number;
  asOfDate: string; notes: string | null; createdAt: string;
};
export type CurrencyRateInput = {
  currencyCode: string; rateToBase: number; asOfDate: string; notes: string | null;
};
export type TreasuryKind = "cash" | "bank";
export type TreasuryTransfer = {
  id: number; transferNo: string; transferDate: string;
  fromKind: TreasuryKind; fromId: number; fromName: string | null; fromCurrency: string;
  toKind: TreasuryKind;   toId: number;   toName: string | null;   toCurrency: string;
  amountFrom: number; amountTo: number; exchangeRate: number; fxDiff: number;
  jeId: number | null; notes: string | null;
};
export type TreasuryTransferInput = {
  transferDate: string;
  fromKind: TreasuryKind; fromId: number;
  toKind: TreasuryKind;   toId: number;
  amountFrom: number; amountTo: number;
  notes: string | null;
};

export type PurchaseLine = {
  id?: number; itemId: number; itemName?: string;
  qty: number; unitCost: number; vatRate: number; lineTotal: number;
  // Line-level unit of measure. unitPrice/unitCost & qty are per the SELECTED
  // unit; conversionFactor (= uom.baseQty) converts qty to BASE units for stock
  // & COGS only — it does NOT change the monetary line total.
  uomId?: number | null; uomName?: string | null; conversionFactor?: number;
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
  warehouseId?: number | null;
  branchId?: number | null; costCenterId?: number | null;
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
  notes: string | null; warehouseId?: number | null;
  branchId?: number | null; costCenterId?: number | null;
  lines: PurchaseLine[];
};

export type SalesLine = {
  id?: number; itemId: number; itemName?: string;
  qty: number; unitPrice: number; vatRate: number; lineTotal: number;
  // Line-level unit of measure. unitPrice & qty are per the SELECTED unit;
  // conversionFactor (= uom.baseQty) converts qty to BASE units for stock &
  // COGS only — it does NOT change the monetary line total.
  uomId?: number | null; uomName?: string | null; conversionFactor?: number;
};
export type SalesInvoice = {
  id: number; invoiceNo: string; customerId: number | null; customerName: string | null;
  invoiceDate: string; subtotal: number; vatTotal: number; grandTotal: number; cogsTotal: number;
  paymentMethod: PaymentMethod; cashBoxId: number | null; bankId: number | null;
  jeId: number | null; notes: string | null; lines: SalesLine[];
};
export type SalesInvoiceInput = {
  customerId: number | null; invoiceDate: string; paymentMethod: PaymentMethod;
  cashBoxId: number | null; bankId: number | null; notes: string | null;
  warehouseId?: number | null;
  branchId?: number | null; costCenterId?: number | null;
  lines: SalesLine[];
};

export type SalesReturn = {
  id: number; returnNo: string; customerId: number | null; customerName: string | null;
  invoiceId: number | null; returnDate: string;
  subtotal: number; vatTotal: number; grandTotal: number; cogsTotal: number;
  paymentMethod: PaymentMethod; cashBoxId: number | null; bankId: number | null;
  jeId: number | null; notes: string | null; lines: SalesLine[];
};
export type SalesReturnInput = {
  customerId: number | null; invoiceId: number | null; returnDate: string;
  paymentMethod: PaymentMethod; cashBoxId: number | null; bankId: number | null;
  notes: string | null; warehouseId?: number | null;
  branchId?: number | null; costCenterId?: number | null;
  lines: SalesLine[];
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
  branchId?: number | null; costCenterId?: number | null;
};

export type JournalEntryLine = {
  id?: number | null; accountId: number; accountCode?: string | null; accountName?: string | null;
  debit: number; credit: number; description: string | null;
};
export type JeEntryType = "general" | "opening" | "closing" | "adjustment" | "depreciation";
export type JeStatus = "draft" | "posted";
export type JournalEntry = {
  id: number; entryNo: string; entryDate: string; description: string | null;
  totalDebit: number; totalCredit: number;
  sourceType: string | null; sourceId: number | null;
  entryType: JeEntryType; status: JeStatus;
  branchId: number | null; costCenterId: number | null;
  lines: JournalEntryLine[];
};

// Manual-form line carries a per-line cost center (the system `JournalEntryLine`
// deliberately does not, to avoid touching the system document call-sites).
export type ManualJeLine = {
  id?: number | null; accountId: number; accountCode?: string | null; accountName?: string | null;
  debit: number; credit: number; description: string | null; costCenterId?: number | null;
};
export type ManualJeDetail = {
  id: number; entryNo: string; entryDate: string; description: string | null;
  entryType: JeEntryType; status: JeStatus; sourceType: string | null;
  branchId: number | null; costCenterId: number | null;
  totalDebit: number; totalCredit: number;
  lines: ManualJeLine[];
};
export type ManualJeInput = {
  entryDate: string; description: string | null;
  entryType?: JeEntryType;
  /** Manual document-number override; omit/empty to consume the next sequence. */
  docNumber?: string | null;
  status?: JeStatus;
  branchId?: number | null; costCenterId?: number | null;
  lines: ManualJeLine[];
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
export async function createCashBox(name: string, currencyCode = "SAR"): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("cash_boxes_create", { input: { name, accountId: null, currencyCode } });
}
export async function updateCashBox(id: number, name: string, currencyCode = "SAR"): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("cash_boxes_update", { id, input: { name, accountId: null, currencyCode } });
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
export async function createBank(name: string, accountNo: string | null, currencyCode = "SAR"): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("banks_create", { input: { name, accountNo, currencyCode } });
}
export async function updateBank(id: number, name: string, accountNo: string | null, currencyCode = "SAR"): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("banks_update", { id, input: { name, accountNo, currencyCode } });
}
export async function deleteBank(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("banks_delete", { id });
}

// ─── Currencies (Task #209) ──────────────────────────────────────────
export async function listCurrencies(activeOnly = false): Promise<Currency[]> {
  if (!hasTauri()) return [];
  return await invoke<Currency[]>("currencies_list", { activeOnly });
}
export async function createCurrency(input: CurrencyInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("currency_create", { input });
}
export async function updateCurrency(code: string, input: CurrencyInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("currency_update", { code, input });
}
export async function deleteCurrency(code: string): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("currency_delete", { code });
}

// ─── Exchange rates ──────────────────────────────────────────────────
export async function listCurrencyRates(currencyCode?: string, limit = 500): Promise<CurrencyRate[]> {
  if (!hasTauri()) return [];
  return await invoke<CurrencyRate[]>("currency_rates_list", { currencyCode: currencyCode ?? null, limit });
}
export async function upsertCurrencyRate(input: CurrencyRateInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("currency_rate_upsert", { input });
}
export async function deleteCurrencyRate(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("currency_rate_delete", { id });
}

// ─── Treasury transfers ──────────────────────────────────────────────
export async function listTreasuryTransfers(limit = 200): Promise<TreasuryTransfer[]> {
  if (!hasTauri()) return [];
  return await invoke<TreasuryTransfer[]>("treasury_transfers_list", { limit });
}
export async function createTreasuryTransfer(input: TreasuryTransferInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("treasury_transfer_create", { input });
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

// ─── Sales invoices ──────────────────────────────────────────────────
export async function listSalesInvoices(limit = 200): Promise<SalesInvoice[]> {
  if (!hasTauri()) return [];
  return await invoke<SalesInvoice[]>("sales_invoices_list", { limit });
}
export async function getSalesInvoice(id: number): Promise<SalesInvoice> {
  if (!hasTauri()) notImpl();
  return await invoke<SalesInvoice>("sales_invoice_get", { id });
}
export async function createSalesInvoice(input: SalesInvoiceInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("sales_invoice_create", { input });
}

// ─── Sales returns ───────────────────────────────────────────────────
export async function listSalesReturns(limit = 200): Promise<SalesReturn[]> {
  if (!hasTauri()) return [];
  return await invoke<SalesReturn[]>("sales_returns_list", { limit });
}
export async function getSalesReturn(id: number): Promise<SalesReturn> {
  if (!hasTauri()) notImpl();
  return await invoke<SalesReturn>("sales_return_get", { id });
}
export async function createSalesReturn(input: SalesReturnInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("sales_return_create", { input });
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
export async function getJournalEntryDetail(id: number): Promise<ManualJeDetail> {
  if (!hasTauri()) notImpl();
  return await invoke<ManualJeDetail>("journal_entry_detail", { id });
}
export async function createJournalEntry(input: ManualJeInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("journal_entry_create", { input });
}
export async function updateJournalEntry(id: number, input: ManualJeInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("journal_entry_update", { id, input });
}
export async function postJournalEntry(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("journal_entry_post", { id });
}
export async function unpostJournalEntry(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("journal_entry_unpost", { id });
}
export async function deleteJournalEntry(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("journal_entry_delete", { id });
}
export async function peekJournalEntryNumber(): Promise<string> {
  if (!hasTauri()) return "";
  return await invoke<string>("journal_entry_peek_number");
}

// ─── Document numbering series ───────────────────────────────────────
export type NumberSeriesDocType =
  | "journal_entry" | "purchase" | "purchase_return" | "sales_invoice" | "sales_return";
export type NumberSeries = {
  docType: NumberSeriesDocType;
  prefix: string;
  nextNumber: number;
  padding: number;
};
export async function listNumberSeries(): Promise<NumberSeries[]> {
  if (!hasTauri()) return [];
  return await invoke<NumberSeries[]>("number_series_list");
}
export async function updateNumberSeries(s: NumberSeries): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("number_series_update", {
    docType: s.docType, prefix: s.prefix, nextNumber: s.nextNumber, padding: s.padding,
  });
}
