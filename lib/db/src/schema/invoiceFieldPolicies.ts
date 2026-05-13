import { pgTable, serial, integer, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Per-company "field policy" for invoice screens.
//
// One row per (companyId, scope). `scope` is one of:
//   - "sales"     → SalesDocumentForm (sales invoices)
//   - "purchase"  → PurchaseInvoiceForm
//   - "pos"       → POS Operations sale screen
//
// `policy` is a JSON blob mapping field name → { mode, ...constraints }.
//   mode: "editable" | "readonly" | "hidden" | "required"
//   For the date field we also store dateConstraint: "none" | "today_only"
//
// The intent is admin-only authoring + read-by-everyone consumption: a
// non-admin user opening an invoice screen fetches the policy and the
// frontend hides / locks / marks-required fields accordingly. Admins always
// see every field (the policy is bypassed for `admin`/`superadmin` roles).
//
// Stored as JSONB (not separate columns) because the field set evolves with
// the product — adding a new policy-controlled field stays purely a code
// change, no migration needed.
export const invoiceFieldPoliciesTable = pgTable(
  "invoice_field_policies",
  {
    id:        serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    scope:     text("scope").notNull(), // "sales" | "purchase" | "pos"
    policy:    jsonb("policy").notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    updatedBy: integer("updated_by"),
  },
  (t) => ({
    uniqCompanyScope: uniqueIndex("invoice_field_policies_company_scope_idx")
      .on(t.companyId, t.scope),
  }),
);

export type InvoiceFieldPolicyRow = typeof invoiceFieldPoliciesTable.$inferSelect;
export type NewInvoiceFieldPolicyRow = typeof invoiceFieldPoliciesTable.$inferInsert;

// ── Shared types & catalogue (used by both server and client) ────────────

export type FieldMode = "editable" | "readonly" | "hidden" | "required";
export type DateConstraint = "none" | "today_only";

export interface FieldRule {
  mode: FieldMode;
  /** Only meaningful when this rule belongs to a date field. */
  dateConstraint?: DateConstraint;
}

/** A complete policy: { fieldName: rule } */
export type PolicyMap = Record<string, FieldRule>;

export type PolicyScope = "sales" | "purchase" | "pos";

/**
 * Catalogue of fields the admin can govern, per scope. Any field not listed
 * here is always editable (the policy doesn't reach into it).
 *
 * `key` must match the field key the frontend passes to <PolicyField name=…>.
 */
export interface FieldDef {
  key: string;
  labelAr: string;
  labelEn: string;
  /** True for the date field — exposes `dateConstraint` UI in the admin page. */
  isDate?: boolean;
}

export const FIELD_CATALOGUE: Record<PolicyScope, FieldDef[]> = {
  sales: [
    { key: "date",            labelAr: "تاريخ الفاتورة",       labelEn: "Invoice date", isDate: true },
    { key: "validUntil",      labelAr: "صالحة حتى",            labelEn: "Valid until" },
    { key: "customer",        labelAr: "العميل",               labelEn: "Customer" },
    { key: "salesperson",     labelAr: "مندوب المبيعات",       labelEn: "Salesperson" },
    { key: "branch",          labelAr: "الفرع",                labelEn: "Branch" },
    { key: "costCenter",      labelAr: "مركز التكلفة",         labelEn: "Cost center" },
    { key: "warehouse",       labelAr: "المستودع",             labelEn: "Warehouse" },
    { key: "currency",        labelAr: "العملة",               labelEn: "Currency" },
    { key: "exchangeRate",    labelAr: "سعر الصرف",            labelEn: "Exchange rate" },
    { key: "paymentMethod",   labelAr: "طريقة الدفع",          labelEn: "Payment method" },
    { key: "dueDate",         labelAr: "تاريخ الاستحقاق",      labelEn: "Due date" },
    { key: "discount",        labelAr: "الخصم",                labelEn: "Discount" },
    { key: "taxRate",         labelAr: "نسبة الضريبة",         labelEn: "Tax rate" },
    { key: "notes",           labelAr: "ملاحظات",              labelEn: "Notes" },
    { key: "attachments",     labelAr: "المرفقات",             labelEn: "Attachments" },
    { key: "docNumber",       labelAr: "رقم الفاتورة",         labelEn: "Invoice number" },
  ],
  purchase: [
    { key: "date",                  labelAr: "تاريخ الفاتورة",       labelEn: "Invoice date", isDate: true },
    { key: "supplier",              labelAr: "المورد",               labelEn: "Supplier" },
    { key: "supplierInvoiceNumber", labelAr: "رقم فاتورة المورد",    labelEn: "Supplier invoice #" },
    { key: "branch",                labelAr: "الفرع",                labelEn: "Branch" },
    { key: "warehouse",             labelAr: "المستودع",             labelEn: "Warehouse" },
    { key: "costCenter",            labelAr: "مركز التكلفة",         labelEn: "Cost center" },
    { key: "currency",              labelAr: "العملة",               labelEn: "Currency" },
    { key: "exchangeRate",          labelAr: "سعر الصرف",            labelEn: "Exchange rate" },
    { key: "paymentMethod",         labelAr: "طريقة الدفع",          labelEn: "Payment method" },
    { key: "dueDate",               labelAr: "تاريخ الاستحقاق",      labelEn: "Due date" },
    { key: "discount",              labelAr: "الخصم",                labelEn: "Discount" },
    { key: "taxRate",               labelAr: "نسبة الضريبة",         labelEn: "Tax rate" },
    { key: "notes",                 labelAr: "ملاحظات",              labelEn: "Notes" },
    { key: "attachments",           labelAr: "المرفقات",             labelEn: "Attachments" },
  ],
  pos: [
    { key: "date",          labelAr: "تاريخ الفاتورة",  labelEn: "Sale date", isDate: true },
    { key: "customer",      labelAr: "العميل",          labelEn: "Customer" },
    { key: "paymentMethod", labelAr: "طريقة الدفع",     labelEn: "Payment method" },
    { key: "discount",      labelAr: "الخصم",           labelEn: "Discount" },
    { key: "notes",         labelAr: "ملاحظات",         labelEn: "Notes" },
  ],
};

export const POLICY_SCOPES: PolicyScope[] = ["sales", "purchase", "pos"];

export function defaultPolicy(scope: PolicyScope): PolicyMap {
  const out: PolicyMap = {};
  for (const f of FIELD_CATALOGUE[scope]) {
    out[f.key] = { mode: "editable", ...(f.isDate ? { dateConstraint: "none" as const } : {}) };
  }
  return out;
}
