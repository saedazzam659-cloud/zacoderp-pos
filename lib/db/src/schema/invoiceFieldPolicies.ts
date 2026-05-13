import { pgTable, serial, integer, text, jsonb, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";

// ── Invoice Field Policy ─────────────────────────────────────────────────
//
// A "policy profile" is a named bundle of per-field rules covering the
// three invoice screens (sales / purchase / POS). The admin authors many
// profiles per company (e.g. "كاشير", "محاسب مبتدئ", "مدير فرع") and
// assigns each user to exactly one profile via `user_invoice_field_policies`.
//
// Effective policy for a given user = profile.bundle (admins bypass).
// If a user has no assignment, the profile flagged `is_default = true`
// applies; if no default exists, the user is treated as fully editable.
//
// `bundle` shape:
//   { sales: { fieldKey: { mode, dateConstraint? }, ... },
//     purchase: { ... },
//     pos: { ... } }
//   mode: "editable" | "readonly" | "hidden" | "required"
//   dateConstraint: "none" | "today_only"   (only for date fields)

export const invoiceFieldPolicyProfilesTable = pgTable(
  "invoice_field_policy_profiles",
  {
    id:         serial("id").primaryKey(),
    companyId:  integer("company_id").notNull(),
    name:       text("name").notNull(),
    bundle:     jsonb("bundle").notNull().default({}),
    isDefault:  boolean("is_default").notNull().default(false),
    color:      text("color"),                          // hex tint shown in cards / pills
    updatedAt:  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    updatedBy:  integer("updated_by"),
    createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqCompanyName: uniqueIndex("invoice_field_policy_profiles_company_name_idx")
      .on(t.companyId, t.name),
  }),
);

export const userInvoiceFieldPoliciesTable = pgTable(
  "user_invoice_field_policies",
  {
    userId:     integer("user_id").primaryKey(),
    profileId:  integer("profile_id").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
    assignedBy: integer("assigned_by"),
  },
);

export type InvoiceFieldPolicyProfileRow = typeof invoiceFieldPolicyProfilesTable.$inferSelect;
export type NewInvoiceFieldPolicyProfileRow = typeof invoiceFieldPolicyProfilesTable.$inferInsert;
export type UserInvoiceFieldPolicyRow = typeof userInvoiceFieldPoliciesTable.$inferSelect;

// ── Shared types & catalogue (used by both server and client) ────────────

export type FieldMode = "editable" | "readonly" | "hidden" | "required";
export type DateConstraint = "none" | "today_only";

export interface FieldRule {
  mode: FieldMode;
  /** Only meaningful when this rule belongs to a date field. */
  dateConstraint?: DateConstraint;
}

/** A complete policy for one scope: { fieldName: rule } */
export type PolicyMap = Record<string, FieldRule>;

export type PolicyScope = "sales" | "purchase" | "pos";

/** A complete bundle covering all scopes — the shape stored in `bundle`. */
export type PolicyBundle = Record<PolicyScope, PolicyMap>;

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

export function defaultBundle(): PolicyBundle {
  return {
    sales:    defaultPolicy("sales"),
    purchase: defaultPolicy("purchase"),
    pos:      defaultPolicy("pos"),
  };
}
