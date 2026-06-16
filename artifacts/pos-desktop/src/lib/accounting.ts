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
export type ReportDirection = "balance_sheet" | "income_statement";
export type Account = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  type: AccountType; parentId: number | null; isLeaf: boolean; balance: number;
  costCenterId: number | null; reportDirection: ReportDirection | null;
  level: number; notes: string | null; isActive: boolean;
};
export type AccountInput = {
  code: string; nameAr: string; nameEn: string | null;
  type: AccountType; parentId: number | null; isLeaf: boolean;
  costCenterId: number | null; reportDirection: ReportDirection | null;
  level: number; notes: string | null; isActive: boolean;
};

export type Supplier = {
  id: number; code: string | null; nameAr: string; nameEn: string | null;
  phone: string | null; vatNumber: string | null; balance: number; notes: string | null;
  currencyCode: string;
  email: string | null; crNumber: string | null;
  city: string | null; district: string | null; street: string | null;
  buildingNumber: string | null; postalCode: string | null; country: string | null;
  nationalAddressShort: string | null;
  includeInStatements: boolean; apAccountId: number | null;
  groupId: number | null;
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
  /** Profile parity with web (Phase W2). */
  email?: string | null; crNumber?: string | null;
  city?: string | null; district?: string | null; street?: string | null;
  buildingNumber?: string | null; postalCode?: string | null; country?: string | null;
  nationalAddressShort?: string | null;
  includeInStatements?: boolean;
  /** Editable payables control account; omit/0 keeps the existing one (defaults to 2100). */
  apAccountId?: number | null;
  /** Optional supplier-group classification (omit/0 clears it). */
  groupId?: number | null;
};

export type CashBox = { id: number; name: string; balance: number; accountId: number | null; currencyCode: string };
export type Bank = { id: number; name: string; accountNo: string | null; balance: number; accountId: number | null; currencyCode: string };

// ─── POS payment methods + GL account overrides ──────────────────────
// Dynamic register payment methods (نقداً / بطاقة / آجل / …). Each maps to a
// GL account; kind="credit" always debits receivables (1500) + the customer
// sub-ledger, ignoring accountId. Backs `post_pos_invoice_je` on the Rust side.
export type PosPaymentMethodKind = "cash" | "bank" | "credit" | "other";
export type PosPaymentMethod = {
  id: number; nameAr: string; kind: PosPaymentMethodKind;
  accountId: number | null; isActive: boolean; sortOrder: number;
};
export type PosPaymentMethodInput = {
  nameAr: string; kind: PosPaymentMethodKind;
  accountId?: number | null; isActive?: boolean; sortOrder?: number;
};

export async function listPosPaymentMethods(): Promise<PosPaymentMethod[]> {
  if (!hasTauri()) return [];
  return await invoke<PosPaymentMethod[]>("pos_payment_methods_list");
}
export async function createPosPaymentMethod(input: PosPaymentMethodInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("pos_payment_method_create", { input });
}
export async function updatePosPaymentMethod(id: number, input: PosPaymentMethodInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("pos_payment_method_update", { id, input });
}
export async function deletePosPaymentMethod(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("pos_payment_method_delete", { id });
}

// POS GL account overrides (app_settings KV). null = use the hardcoded fallback
// code shown in POS_ACCT_FALLBACK. Mirrors the Rust `pos_acct()` resolution.
export const POS_ACCT_KEYS = [
  "pos_acct_revenue", "pos_acct_vat", "pos_acct_cogs", "pos_acct_inventory", "pos_acct_cash",
] as const;
export type PosAcctKey = (typeof POS_ACCT_KEYS)[number];
export const POS_ACCT_LABELS: Record<PosAcctKey, string> = {
  pos_acct_revenue: "حساب الإيرادات (المبيعات)",
  pos_acct_vat: "حساب ضريبة القيمة المضافة",
  pos_acct_cogs: "حساب تكلفة البضاعة المباعة",
  pos_acct_inventory: "حساب المخزون",
  pos_acct_cash: "حساب الصندوق الافتراضي",
};
export const POS_ACCT_FALLBACK: Record<PosAcctKey, string> = {
  pos_acct_revenue: "4100", pos_acct_vat: "2200", pos_acct_cogs: "5100",
  pos_acct_inventory: "1300", pos_acct_cash: "1101",
};

export async function getPosAccountSettings(): Promise<Record<PosAcctKey, number | null>> {
  const out = {} as Record<PosAcctKey, number | null>;
  for (const k of POS_ACCT_KEYS) out[k] = null;
  if (!hasTauri()) return out;
  for (const k of POS_ACCT_KEYS) {
    try {
      const v = await invoke<string | null>("standalone_get_setting", { key: k });
      const n = v == null || v.trim() === "" ? NaN : Number(v);
      out[k] = Number.isInteger(n) && n > 0 ? n : null;
    } catch { /* leave null → fallback code applies */ }
  }
  return out;
}
export async function setPosAccountSetting(key: PosAcctKey, accountId: number | null): Promise<void> {
  if (!hasTauri()) notImpl();
  // Empty string clears the override (Rust then falls back to the hardcoded code).
  await invoke("standalone_set_setting", { key, value: accountId == null ? "" : String(accountId) });
}

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
  jeId: number | null; notes: string | null;
  supplierInvoiceNo: string | null; warehouseId: number | null;
  lcId: number | null;
  lines: PurchaseLine[];
};
export type PurchaseInput = {
  supplierId: number; invoiceDate: string; paymentMethod: PaymentMethod;
  cashBoxId: number | null; bankId: number | null; notes: string | null;
  supplierInvoiceNo?: string | null;
  warehouseId?: number | null;
  branchId?: number | null; costCenterId?: number | null;
  /** When set, the goods (subtotal) portion credits the LC settlement account
   *  instead of supplier-payable/cash/bank, and the LC's used_amount draws down. */
  lcId?: number | null;
  lines: PurchaseLine[];
};

export type PurchaseReturn = {
  id: number; returnNo: string; supplierId: number; supplierName: string | null;
  purchaseId: number | null; returnDate: string;
  subtotal: number; vatTotal: number; grandTotal: number;
  jeId: number | null; notes: string | null; reason: string | null; lines: PurchaseLine[];
};
export type PurchaseReturnInput = {
  supplierId: number; purchaseId: number | null; returnDate: string;
  notes: string | null; reason?: string | null; warehouseId?: number | null;
  branchId?: number | null; costCenterId?: number | null;
  lines: PurchaseLine[];
};

export type PurchaseOrderStatus = "draft" | "confirmed" | "converted" | "cancelled";
export type PurchaseOrder = {
  id: number; orderNo: string; supplierId: number; supplierName: string | null;
  orderDate: string; expectedDate: string | null;
  paymentMethod: PaymentMethod; status: PurchaseOrderStatus;
  convertedInvoiceId: number | null;
  subtotal: number; vatTotal: number; grandTotal: number;
  notes: string | null; supplierInvoiceNo: string | null;
  warehouseId: number | null; cashBoxId: number | null; bankId: number | null;
  branchId: number | null; costCenterId: number | null;
  lines: PurchaseLine[];
};
export type PurchaseOrderInput = {
  supplierId: number; orderDate: string; expectedDate?: string | null;
  paymentMethod?: PaymentMethod; notes?: string | null; supplierInvoiceNo?: string | null;
  warehouseId?: number | null; branchId?: number | null; costCenterId?: number | null;
  cashBoxId?: number | null; bankId?: number | null;
  lines: PurchaseLine[];
};

export type GoodsReceiptStatus = "draft" | "posted" | "converted";
export type GoodsReceipt = {
  id: number; receiptNo: string; supplierId: number; supplierName: string | null;
  receiptDate: string; supplierInvoiceNo: string | null;
  status: GoodsReceiptStatus; jeId: number | null; convertedInvoiceId: number | null;
  subtotal: number; vatTotal: number; grandTotal: number;
  notes: string | null; warehouseId: number | null;
  lines: PurchaseLine[];
};
export type GoodsReceiptInput = {
  supplierId: number; receiptDate: string; supplierInvoiceNo?: string | null;
  notes?: string | null; warehouseId?: number | null;
  branchId?: number | null; costCenterId?: number | null;
  lines: PurchaseLine[];
};
export type GoodsReceiptConvertInput = {
  invoiceDate: string; paymentMethod?: PaymentMethod;
  cashBoxId?: number | null; bankId?: number | null;
  supplierInvoiceNo?: string | null;
};

export type SalesLine = {
  id?: number; itemId: number; itemName?: string;
  qty: number; unitPrice: number; vatRate: number; lineTotal: number;
  // Line-level unit of measure. unitPrice & qty are per the SELECTED unit;
  // conversionFactor (= uom.baseQty) converts qty to BASE units for stock &
  // COGS only — it does NOT change the monetary line total.
  uomId?: number | null; uomName?: string | null; conversionFactor?: number;
  // Free / bonus units: no revenue & no VAT, but consume stock + add COGS on
  // (qty + freeQty) × factor. Per-line warehouse override (null → header/default).
  freeQty?: number; note?: string | null; warehouseId?: number | null;
};
export type SalesInvoice = {
  id: number; invoiceNo: string; customerId: number | null; customerName: string | null;
  invoiceDate: string; subtotal: number; vatTotal: number; grandTotal: number; cogsTotal: number;
  paymentMethod: PaymentMethod; cashBoxId: number | null; bankId: number | null;
  jeId: number | null; notes: string | null;
  // Salesperson attribution + commission snapshot, ZATCA doc type, frozen buyer.
  salesRepId?: number | null; salesRepName?: string | null; commissionPct?: number;
  branchId?: number | null; costCenterId?: number | null;
  invoiceType?: string | null;
  buyerName?: string | null; buyerVat?: string | null; buyerAddress?: string | null;
  lines: SalesLine[];
  // ZATCA bridge: cached TLV QR (base64, loaded only by getSalesInvoice) and the
  // sync status of the linked offline_invoices row (null when not bridged / non-SA).
  zatcaQrBase64?: string | null; zatcaStatus?: string | null;
};
export type SalesInvoiceInput = {
  customerId: number | null; invoiceDate: string; paymentMethod: PaymentMethod;
  cashBoxId: number | null; bankId: number | null; notes: string | null;
  warehouseId?: number | null;
  branchId?: number | null; costCenterId?: number | null;
  salesRepId?: number | null; commissionPct?: number | null;
  invoiceType?: string | null;
  buyerName?: string | null; buyerVat?: string | null; buyerAddress?: string | null;
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

// ── Quotations (عروض الأسعار) — non-financial; converts to a sales invoice ──
export type QuotationStatus = "draft" | "sent" | "accepted" | "rejected" | "converted";
export type Quotation = {
  id: number; docNo: string; customerId: number | null; customerName: string | null;
  quotationDate: string; validUntil: string | null;
  subtotal: number; vatTotal: number; grandTotal: number;
  notes: string | null; status: QuotationStatus; convertedInvoiceId: number | null;
  warehouseId?: number | null; branchId?: number | null; costCenterId?: number | null;
  salesRepId?: number | null; salesRepName?: string | null; commissionPct?: number;
  invoiceType?: string | null;
  buyerName?: string | null; buyerVat?: string | null; buyerAddress?: string | null;
  lines: SalesLine[];
};
export type QuotationInput = {
  customerId: number | null; quotationDate: string; validUntil: string | null;
  notes: string | null;
  warehouseId?: number | null; branchId?: number | null; costCenterId?: number | null;
  salesRepId?: number | null; commissionPct?: number | null;
  invoiceType?: string | null;
  buyerName?: string | null; buyerVat?: string | null; buyerAddress?: string | null;
  lines: SalesLine[];
};

// ── Sales Orders (أوامر البيع) — non-financial; carries payment method ──
export type SalesOrderStatus = "draft" | "confirmed" | "cancelled" | "converted";
export type SalesOrder = {
  id: number; docNo: string; customerId: number | null; customerName: string | null;
  orderDate: string; expectedDelivery: string | null;
  paymentMethod: PaymentMethod; cashBoxId: number | null; bankId: number | null;
  subtotal: number; vatTotal: number; grandTotal: number;
  notes: string | null; status: SalesOrderStatus; convertedInvoiceId: number | null;
  warehouseId?: number | null; branchId?: number | null; costCenterId?: number | null;
  salesRepId?: number | null; salesRepName?: string | null; commissionPct?: number;
  invoiceType?: string | null;
  buyerName?: string | null; buyerVat?: string | null; buyerAddress?: string | null;
  lines: SalesLine[];
};
export type SalesOrderInput = {
  customerId: number | null; orderDate: string; expectedDelivery: string | null;
  paymentMethod: PaymentMethod; cashBoxId: number | null; bankId: number | null;
  notes: string | null;
  warehouseId?: number | null; branchId?: number | null; costCenterId?: number | null;
  salesRepId?: number | null; commissionPct?: number | null;
  invoiceType?: string | null;
  buyerName?: string | null; buyerVat?: string | null; buyerAddress?: string | null;
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
export async function updatePurchase(id: number, input: PurchaseInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("purchase_update", { id, input });
}
export async function deletePurchase(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("purchase_delete", { id });
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

// ─── Purchase orders ─────────────────────────────────────────────────
export async function listPurchaseOrders(limit = 200): Promise<PurchaseOrder[]> {
  if (!hasTauri()) return [];
  return await invoke<PurchaseOrder[]>("purchase_orders_list", { limit });
}
export async function getPurchaseOrder(id: number): Promise<PurchaseOrder> {
  if (!hasTauri()) notImpl();
  return await invoke<PurchaseOrder>("purchase_order_get", { id });
}
export async function createPurchaseOrder(input: PurchaseOrderInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("purchase_order_create", { input });
}
export async function updatePurchaseOrder(id: number, input: PurchaseOrderInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("purchase_order_update", { id, input });
}
export async function deletePurchaseOrder(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("purchase_order_delete", { id });
}
export async function setPurchaseOrderStatus(id: number, status: PurchaseOrderStatus): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("purchase_order_set_status", { id, status });
}
export async function convertPurchaseOrder(id: number): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("purchase_order_convert", { id });
}

// ─── Goods receipts ──────────────────────────────────────────────────
export async function listGoodsReceipts(limit = 200): Promise<GoodsReceipt[]> {
  if (!hasTauri()) return [];
  return await invoke<GoodsReceipt[]>("goods_receipts_list", { limit });
}
export async function getGoodsReceipt(id: number): Promise<GoodsReceipt> {
  if (!hasTauri()) notImpl();
  return await invoke<GoodsReceipt>("goods_receipt_get", { id });
}
export async function createGoodsReceipt(input: GoodsReceiptInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("goods_receipt_create", { input });
}
export async function postGoodsReceipt(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("goods_receipt_post", { id });
}
export async function deleteGoodsReceipt(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("goods_receipt_delete", { id });
}
export async function convertGoodsReceiptToInvoice(id: number, input: GoodsReceiptConvertInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("goods_receipt_convert_to_invoice", { id, input });
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
/** Edit an existing (non-ZATCA-bridged) sales invoice: reverses the old GL +
 *  stock + balance impact and re-applies fresh impact, keeping the number. */
export async function updateSalesInvoice(id: number, input: SalesInvoiceInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("sales_invoice_update", { id, input });
}
/** Delete a (non-ZATCA-bridged, open-period) sales invoice, reversing all impact. */
export async function deleteSalesInvoice(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("sales_invoice_delete", { id });
}
/** Persist the ZATCA bridge link (QR + offline_invoices local_uuid) onto a sales invoice. */
export async function setSalesInvoiceZatca(
  id: number, qrBase64: string | null, offlineUuid: string | null,
): Promise<void> {
  if (!hasTauri()) return;
  await invoke("sales_invoice_set_zatca", { id, qrBase64, offlineUuid });
}

// ─── Quotations ──────────────────────────────────────────────────────
export async function listQuotations(limit = 200): Promise<Quotation[]> {
  if (!hasTauri()) return [];
  return await invoke<Quotation[]>("quotations_list", { limit });
}
export async function getQuotation(id: number): Promise<Quotation> {
  if (!hasTauri()) notImpl();
  return await invoke<Quotation>("quotation_get", { id });
}
export async function createQuotation(input: QuotationInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("quotation_create", { input });
}
/** Edit a non-converted quotation (non-financial: rewrites header + lines). */
export async function updateQuotation(id: number, input: QuotationInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("quotation_update", { id, input });
}
/** Delete a non-converted quotation (non-financial). */
export async function deleteQuotation(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("quotation_delete", { id });
}
export async function setQuotationStatus(id: number, status: QuotationStatus): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("quotation_set_status", { id, status });
}
export async function convertQuotationToInvoice(id: number): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("quotation_convert_to_invoice", { id });
}

// ─── Sales orders ────────────────────────────────────────────────────
export async function listSalesOrders(limit = 200): Promise<SalesOrder[]> {
  if (!hasTauri()) return [];
  return await invoke<SalesOrder[]>("sales_orders_list", { limit });
}
export async function getSalesOrder(id: number): Promise<SalesOrder> {
  if (!hasTauri()) notImpl();
  return await invoke<SalesOrder>("sales_order_get", { id });
}
export async function createSalesOrder(input: SalesOrderInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("sales_order_create", { input });
}
/** Edit a non-converted sales order (non-financial: rewrites header + lines). */
export async function updateSalesOrder(id: number, input: SalesOrderInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("sales_order_update", { id, input });
}
/** Delete a non-converted sales order (non-financial). */
export async function deleteSalesOrder(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("sales_order_delete", { id });
}
export async function setSalesOrderStatus(id: number, status: SalesOrderStatus): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("sales_order_set_status", { id, status });
}
export async function convertSalesOrderToInvoice(id: number): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("sales_order_convert_to_invoice", { id });
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
  | "journal_entry" | "purchase" | "purchase_return" | "sales_invoice" | "sales_return"
  | "quotation" | "sales_order";
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

// ─── Posting policy (التحكم العام: ترحيل تلقائي / يدوي) ─────────────────
// Master flag + per-doc-type overrides. A per-type value of `null` means the
// type follows the master flag; `true`/`false` force auto/manual for it.
// Manual (master = false) is the default: documents save as DRAFT and only hit
// the general ledger once posted from مركز الترحيل.
export type PostingSettings = {
  autoPostingEnabled: boolean;
  sale: boolean | null;
  purchase: boolean | null;
  saleReturn: boolean | null;
  purchaseReturn: boolean | null;
  voucher: boolean | null;
  treasuryTransfer: boolean | null;
};
export async function getPostingSettings(): Promise<PostingSettings> {
  if (!hasTauri()) {
    return {
      autoPostingEnabled: false,
      sale: null, purchase: null, saleReturn: null,
      purchaseReturn: null, voucher: null, treasuryTransfer: null,
    };
  }
  return await invoke<PostingSettings>("posting_settings_get");
}
export async function setPostingSettings(input: PostingSettings): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("posting_settings_set", { input });
}

// ─── Posting Center (مركز الترحيل) ─────────────────────────────────────
// Bulk post / unpost ANY draft / posted journal entries (incl. document
// auto-generated drafts). The list itself is fetched via listJournalEntries
// (which returns status / sourceType / entryType). Returns the count actioned.
export async function postingCenterPost(ids: number[]): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("posting_center_post", { ids });
}
export async function postingCenterUnpost(ids: number[]): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("posting_center_unpost", { ids });
}

// ─── Fiscal years + periods (الفترات المحاسبية) ────────────────────────
export type FiscalYear = {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  status: "open" | "closed" | "permanently_closed";
};
export type FiscalPeriod = {
  id: number;
  fiscalYearId: number;
  name: string;
  startDate: string;
  endDate: string;
  status: "open" | "closed" | "permanently_closed";
};
export type PeriodValidateResult = {
  ok: boolean;
  drafts: number;
  unbalanced: number;
  openRevenueAccounts: number;
  openExpenseAccounts: number;
  requiresPlClose: boolean;
  issues: string[];
};
export type ClosePlResult = {
  revenueEntryId: number | null;
  expenseEntryId: number | null;
  totalRevenue: number;
  totalExpense: number;
  netIncome: number;
};
export type TransferProfitResult = {
  entryId: number;
  isProfit: boolean;
  amount: number;
};
export type SoftCloseResult = { ok: boolean; forced: boolean; plClosed: boolean };

export async function listFiscalYears(): Promise<FiscalYear[]> {
  if (!hasTauri()) return [];
  return await invoke<FiscalYear[]>("fiscal_years_list");
}
export async function createFiscalYear(input: {
  name: string; startDate: string; endDate: string; generateMonthly: boolean;
}): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("fiscal_year_create", {
    name: input.name, startDate: input.startDate, endDate: input.endDate,
    generateMonthly: input.generateMonthly,
  });
}
export async function deleteFiscalYear(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("fiscal_year_delete", { id });
}
export async function setFiscalYearStatus(id: number, status: FiscalYear["status"]): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("fiscal_year_set_status", { id, status });
}
export async function listFiscalPeriods(yearId?: number): Promise<FiscalPeriod[]> {
  if (!hasTauri()) return [];
  return await invoke<FiscalPeriod[]>("fiscal_periods_list", { yearId: yearId ?? null });
}
export async function validateFiscalPeriod(id: number): Promise<PeriodValidateResult> {
  if (!hasTauri()) notImpl();
  return await invoke<PeriodValidateResult>("fiscal_period_validate", { id });
}
export async function closePeriodPl(id: number, plSummaryAccountId: number): Promise<ClosePlResult> {
  if (!hasTauri()) notImpl();
  return await invoke<ClosePlResult>("fiscal_period_close_pl", { id, plSummaryAccountId });
}
export async function transferPeriodProfit(
  id: number, plSummaryAccountId: number, retainedEarningsAccountId: number,
): Promise<TransferProfitResult> {
  if (!hasTauri()) notImpl();
  return await invoke<TransferProfitResult>("fiscal_period_transfer_profit", {
    id, plSummaryAccountId, retainedEarningsAccountId,
  });
}
export async function softClosePeriod(id: number, force: boolean): Promise<SoftCloseResult> {
  if (!hasTauri()) notImpl();
  return await invoke<SoftCloseResult>("fiscal_period_soft_close", { id, force });
}
export async function hardClosePeriod(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("fiscal_period_hard_close", { id });
}
export async function forceReopenPeriod(id: number, reason: string): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("fiscal_period_force_reopen", { id, reason });
}

// ═══════════════════════════════════════════════════════════════════════
// W4 — Supplier Groups, Supplier Settlement, Letters of Credit + Expenses
// ═══════════════════════════════════════════════════════════════════════

// ─── Supplier Groups ────────────────────────────────────────────────
export type SupplierGroup = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  discountPercent: number; notes: string | null; isActive: boolean;
};
export type SupplierGroupInput = {
  code: string; nameAr: string; nameEn?: string | null;
  discountPercent?: number; notes?: string | null; isActive?: boolean;
};

export async function listSupplierGroups(): Promise<SupplierGroup[]> {
  if (!hasTauri()) return [];
  return await invoke<SupplierGroup[]>("supplier_groups_list");
}
export async function getSupplierGroup(id: number): Promise<SupplierGroup> {
  if (!hasTauri()) notImpl();
  return await invoke<SupplierGroup>("supplier_group_get", { id });
}
export async function createSupplierGroup(input: SupplierGroupInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("supplier_group_create", { input });
}
export async function updateSupplierGroup(id: number, input: SupplierGroupInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("supplier_group_update", { id, input });
}
export async function deleteSupplierGroup(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("supplier_group_delete", { id });
}

// ─── Supplier Settlement ─────────────────────────────────────────────
export type SettlementStatus = "draft" | "posted";
export type SupplierSettlement = {
  id: number; docNo: string; settlementDate: string;
  supplierId: number; supplierName: string | null;
  paymentMethod: "cash" | "bank"; cashBoxId: number | null; bankId: number | null;
  amount: number; currencyCode: string; exchangeRate: number;
  status: SettlementStatus; jeId: number | null; notes: string | null;
  branchId: number | null; costCenterId: number | null;
};
export type SupplierSettlementInput = {
  settlementDate: string; supplierId: number;
  paymentMethod: "cash" | "bank"; cashBoxId?: number | null; bankId?: number | null;
  amount: number; notes?: string | null;
  branchId?: number | null; costCenterId?: number | null;
};

export async function listSupplierSettlements(limit?: number): Promise<SupplierSettlement[]> {
  if (!hasTauri()) return [];
  return await invoke<SupplierSettlement[]>("supplier_settlements_list", { limit });
}
export async function getSupplierSettlement(id: number): Promise<SupplierSettlement> {
  if (!hasTauri()) notImpl();
  return await invoke<SupplierSettlement>("supplier_settlement_get", { id });
}
export async function createSupplierSettlement(input: SupplierSettlementInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("supplier_settlement_create", { input });
}
export async function updateSupplierSettlement(id: number, input: SupplierSettlementInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("supplier_settlement_update", { id, input });
}
export async function postSupplierSettlement(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("supplier_settlement_post", { id });
}
export async function unpostSupplierSettlement(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("supplier_settlement_unpost", { id });
}
export async function deleteSupplierSettlement(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("supplier_settlement_delete", { id });
}

// ─── Letters of Credit + Expenses ────────────────────────────────────
export type LcStatus = "open" | "partial" | "closed";
export type LetterOfCredit = {
  id: number; lcNumber: string; lcDate: string;
  supplierId: number; supplierName: string | null; bankName: string | null;
  currencyCode: string; exchangeRate: number;
  totalAmount: number; usedAmount: number;
  settlementAccountId: number | null; status: LcStatus; notes: string | null;
  branchId: number | null; costCenterId: number | null;
};
export type LetterOfCreditInput = {
  lcNumber?: string | null; lcDate: string; supplierId: number;
  bankName?: string | null; currencyCode?: string | null; exchangeRate?: number;
  totalAmount?: number; settlementAccountId?: number | null; notes?: string | null;
  branchId?: number | null; costCenterId?: number | null;
};
export type LcFundingInput = {
  lcId: number; fundingDate: string; amount: number;
  paymentMethod: "cash" | "bank"; cashBoxId?: number | null; bankId?: number | null;
  notes?: string | null; branchId?: number | null; costCenterId?: number | null;
};
export type LcExpense = {
  id: number; lcId: number; expenseType: string; accountId: number | null;
  amount: number; currencyCode: string; exchangeRate: number; notes: string | null;
};
export type LcExpenseInput = {
  lcId: number; expenseType: string; accountId?: number | null;
  amount?: number; currencyCode?: string | null; exchangeRate?: number; notes?: string | null;
};

export async function listLettersOfCredit(limit?: number): Promise<LetterOfCredit[]> {
  if (!hasTauri()) return [];
  return await invoke<LetterOfCredit[]>("lc_list", { limit });
}
export async function getLetterOfCredit(id: number): Promise<LetterOfCredit> {
  if (!hasTauri()) notImpl();
  return await invoke<LetterOfCredit>("lc_get", { id });
}
export async function createLetterOfCredit(input: LetterOfCreditInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("lc_create", { input });
}
export async function updateLetterOfCredit(id: number, input: LetterOfCreditInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("lc_update", { id, input });
}
export async function deleteLetterOfCredit(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("lc_delete", { id });
}
export async function closeLetterOfCredit(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("lc_close", { id });
}
export async function reopenLetterOfCredit(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("lc_reopen", { id });
}
export async function recomputeLcUsage(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("lc_recompute_usage", { id });
}
export async function postLcFunding(input: LcFundingInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("lc_post_funding", { input });
}
export async function listLcExpenses(lcId: number): Promise<LcExpense[]> {
  if (!hasTauri()) return [];
  return await invoke<LcExpense[]>("lc_expenses_list", { lcId });
}
export async function createLcExpense(input: LcExpenseInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("lc_expense_create", { input });
}
export async function updateLcExpense(id: number, input: LcExpenseInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("lc_expense_update", { id, input });
}
export async function deleteLcExpense(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("lc_expense_delete", { id });
}
