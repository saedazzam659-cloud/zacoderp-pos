// Shared presentation maps for the sequence-numbering feature: which Arabic
// screen a logged ref_table belongs to, an optional deep-link to open that
// document, and the module → transaction-type groupings that drive the
// monitoring screen's "module" filter. Kept frontend-only (pure labels); the
// backend whitelist (REF_TABLE_WHITELIST in routes/sequences.ts) is the
// security boundary, this file is for display.

// Physical ref_table (as stored in sequence_logs) → Arabic document label.
export const REF_TABLE_LABELS: Record<string, string> = {
  sales_invoices:     "فاتورة مبيعات",
  sales_returns:      "مرتجع مبيعات",
  sales_orders:       "أمر بيع",
  sales_quotations:   "عرض سعر",
  purchase_invoices:  "فاتورة مشتريات",
  purchase_orders:    "أمر شراء",
  purchase_returns:   "مرتجع مشتريات",
  journal_entries:    "قيد يومية",
  payment_vouchers:   "سند صرف",
  receipt_vouchers:   "سند قبض",
  goods_deliveries:   "إذن تسليم بضاعة",
  goods_receipts:     "إذن استلام بضاعة",
  stock_transfers:    "تحويل مخزني",
  stock_adjustments:  "تسوية مخزنية",
  stock_counts:       "جرد مخزني",
  sister_transfers:   "تحويل شركة شقيقة",
  sister_returns:     "مرتجع شركة شقيقة",
  sister_settlements: "تسوية شركة شقيقة",
  account_notes:      "إشعار حساب",
  employees:          "موظف",
  employee_contracts: "عقد موظف",
  production_orders:  "أمر إنتاج",
};

export function refTableLabel(refTable: string | null | undefined): string {
  if (!refTable) return "—";
  return REF_TABLE_LABELS[refTable] ?? refTable;
}

// Optional deep-link to open the underlying document (best-effort; only the
// screens with a stable per-id route are mapped). Returns null when there is
// no canonical detail route — the monitor then shows the label without a link.
const REF_TABLE_ROUTE: Record<string, (id: string) => string> = {
  sales_invoices:    (id) => `/sales/invoices/${id}`,
  sales_returns:     (id) => `/sales/returns/${id}`,
  sales_orders:      (id) => `/sales/orders/${id}`,
  sales_quotations:  (id) => `/sales/quotations/${id}`,
  purchase_invoices: (id) => `/purchases/invoices/${id}`,
  purchase_orders:   (id) => `/purchases/orders/${id}`,
  purchase_returns:  (id) => `/purchases/returns/${id}`,
  journal_entries:   (id) => `/accounting/journal-entries/${id}`,
  payment_vouchers:  (id) => `/accounting/payment-vouchers/${id}`,
  receipt_vouchers:  (id) => `/accounting/receipt-vouchers/${id}`,
  production_orders: (id) => `/production/orders/${id}`,
};

export function refDocPath(
  refTable: string | null | undefined,
  refId: string | null | undefined,
): string | null {
  if (!refTable || !refId) return null;
  const fn = REF_TABLE_ROUTE[refTable];
  return fn ? fn(refId) : null;
}

// Module groupings for the monitor's "module" dropdown. Each module expands to
// the set of transaction types it owns (including the per-payment-method and
// foreign sub-types) so a single pick filters everything under that module.
export type SequenceModule = {
  key: string;
  label: string;
  txTypes: string[];
};

export const SEQUENCE_MODULES: SequenceModule[] = [
  {
    key: "sales",
    label: "المبيعات",
    txTypes: [
      "sales_quotation", "sales_order",
      "sales_invoice", "sales_invoice_cash", "sales_invoice_credit", "sales_invoice_bank", "sales_invoice_foreign",
      "sales_return", "sales_return_cash", "sales_return_credit", "sales_return_bank", "sales_return_foreign",
      "pos_receipt",
    ],
  },
  {
    key: "purchases",
    label: "المشتريات",
    txTypes: [
      "purchase_order",
      "purchase_invoice", "purchase_invoice_cash", "purchase_invoice_credit", "purchase_invoice_bank",
      "purchase_return", "purchase_return_cash", "purchase_return_credit", "purchase_return_bank",
      "goods_receipt",
    ],
  },
  {
    key: "inventory",
    label: "المخزون",
    txTypes: ["goods_delivery", "stock_transfer", "stock_adjustment", "stock_count", "offer"],
  },
  {
    key: "accounting",
    label: "المحاسبة والخزينة",
    txTypes: [
      "journal_entry",
      "receipt_voucher", "receipt_voucher_cash", "receipt_voucher_bank",
      "payment_voucher", "payment_voucher_cash", "payment_voucher_bank",
      "cost_center", "fixed_asset", "cash_transfer",
    ],
  },
  {
    key: "manufacturing",
    label: "التصنيع",
    txTypes: ["production_order"],
  },
  {
    key: "contracting",
    label: "المقاولات",
    txTypes: ["contracting_project", "contracting_bill"],
  },
  {
    key: "hr",
    label: "الموارد البشرية",
    txTypes: ["employee", "hr_contract"],
  },
  {
    key: "other",
    label: "أخرى",
    txTypes: ["maintenance_order", "crm_lead", "hotel_booking", "installment_contract"],
  },
];

export function txTypesForModule(moduleKey: string): string[] {
  return SEQUENCE_MODULES.find((m) => m.key === moduleKey)?.txTypes ?? [];
}
