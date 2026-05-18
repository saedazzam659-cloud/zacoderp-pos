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

export type PolicyScope = "sales" | "purchase" | "pos" | "customers" | "journal_entry" | "sales_audit";

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
    { key: "unitPrice",       labelAr: "سعر البيع",            labelEn: "Unit price" },
    { key: "freeQty",         labelAr: "كمية مجانية",          labelEn: "Free qty" },
    { key: "discount",        labelAr: "الخصم",                labelEn: "Discount" },
    { key: "taxRate",         labelAr: "نسبة الضريبة",         labelEn: "Tax rate" },
    { key: "notes",           labelAr: "ملاحظات",              labelEn: "Notes" },
    { key: "attachments",     labelAr: "المرفقات",             labelEn: "Attachments" },
    { key: "docNumber",       labelAr: "رقم الفاتورة",         labelEn: "Invoice number" },
    { key: "priceIncludesVat", labelAr: "السعر شامل الضريبة",  labelEn: "Price includes VAT" },
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
  // ── شاشة العميل ──
  // Governs which fields appear / are required on the Customer create+edit
  // screen (CustomerNew.tsx). Includes the new credit-limit pair.
  customers: [
    { key: "nameAr",               labelAr: "اسم العميل (عربي)",     labelEn: "Customer name (AR)" },
    { key: "nameEn",               labelAr: "اسم العميل (إنجليزي)",  labelEn: "Customer name (EN)" },
    { key: "customerType",         labelAr: "نوع العميل (B2B/B2C)",  labelEn: "Customer type" },
    { key: "vatNumber",            labelAr: "الرقم الضريبي",         labelEn: "VAT number" },
    { key: "crNumber",             labelAr: "السجل التجاري",         labelEn: "CR number" },
    { key: "email",                labelAr: "البريد الإلكتروني",     labelEn: "Email" },
    { key: "phone",                labelAr: "الجوال",                labelEn: "Phone" },
    { key: "city",                 labelAr: "المدينة",               labelEn: "City" },
    { key: "district",             labelAr: "الحي",                  labelEn: "District" },
    { key: "street",               labelAr: "الشارع",                labelEn: "Street" },
    { key: "buildingNumber",       labelAr: "رقم المبنى",            labelEn: "Building #" },
    { key: "postalCode",           labelAr: "الرمز البريدي",         labelEn: "Postal code" },
    { key: "nationalAddressShort", labelAr: "العنوان الوطني المختصر", labelEn: "Short national address" },
    { key: "salesRepId",           labelAr: "مندوب المبيعات",        labelEn: "Sales rep" },
    { key: "branchId",             labelAr: "الفرع",                 labelEn: "Branch" },
    { key: "accountId",            labelAr: "حساب الأستاذ",          labelEn: "Ledger account" },
    { key: "creditLimit",          labelAr: "الحد الائتماني للسحب",  labelEn: "Credit limit" },
    { key: "enforceCreditLimit",   labelAr: "منع التجاوز عند الوصول للحد", labelEn: "Block when limit reached" },
    { key: "includeInStatements",  labelAr: "إدراج في كشوفات الحسابات", labelEn: "Include in statements" },
    { key: "location",             labelAr: "الموقع الجغرافي",       labelEn: "Geo location" },
  ],
  // ── شاشة قيد اليومية ──
  // Governs the header fields on JournalEntryForm.tsx (/accounting/journals/new
  // and /accounting/journals/:id). Line-level fields (account, debit, credit,
  // line costCenter) intentionally stay outside this catalogue — they are the
  // accounting substance of the entry, not metadata that should be hidden per
  // role. Use the central RBAC permissions to gate the *whole* JE screen if a
  // user must not access JEs at all.
  journal_entry: [
    { key: "docNumber",     labelAr: "رقم المستند",       labelEn: "Document number" },
    { key: "date",          labelAr: "تاريخ القيد",       labelEn: "Entry date", isDate: true },
    { key: "currency",      labelAr: "العملة",            labelEn: "Currency" },
    { key: "exchangeRate",  labelAr: "سعر الصرف",         labelEn: "Exchange rate" },
    { key: "entryType",     labelAr: "نوع القيد",         labelEn: "Entry type" },
    { key: "branch",        labelAr: "الفرع",             labelEn: "Branch" },
    { key: "description",   labelAr: "البيان العام",      labelEn: "General description" },
    { key: "partyPicker",   labelAr: "عميل / مورد",       labelEn: "Customer / Supplier picker" },
    { key: "attachments",   labelAr: "أرشفة مستند",       labelEn: "Document archive" },
  ],
  // ── شاشة الجرد الخارجي للمبيعات (/sales/invoices → SalesAuditGrid) ──
  // Governs visibility of every toolbar button + filter on the Sales Audit
  // Grid. These are UI controls (not data fields), so only the `hidden` mode
  // is operationally meaningful — `readonly`/`required` are accepted by the
  // schema for uniformity but produce no effect on a button. SuperAdmin uses
  // this scope to hand junior auditors a stripped-down screen (e.g. hide
  // export buttons, AI audit, color pickers).
  sales_audit: [
    { key: "back_link",         labelAr: "زر رجوع",                 labelEn: "Back button" },
    { key: "new_invoice",       labelAr: "زر فاتورة جديدة",         labelEn: "New invoice button" },
    { key: "header_color",      labelAr: "لون الرأس",               labelEn: "Header color picker" },
    { key: "footer_color",      labelAr: "لون القدم",               labelEn: "Footer color picker" },
    { key: "column_sort",       labelAr: "ترتيب الأعمدة",           labelEn: "Column sort" },
    { key: "refresh",           labelAr: "زر تحديث",                labelEn: "Refresh button" },
    { key: "export_csv",        labelAr: "تصدير CSV",               labelEn: "Export CSV" },
    { key: "export_excel",      labelAr: "تصدير Excel",             labelEn: "Export Excel" },
    { key: "export_pdf",        labelAr: "تصدير PDF",               labelEn: "Export PDF" },
    { key: "print",             labelAr: "زر الطباعة",              labelEn: "Print button" },
    { key: "ai_audit",          labelAr: "تدقيق بالذكاء الاصطناعي", labelEn: "AI audit" },
    { key: "search",            labelAr: "حقل البحث",               labelEn: "Search input" },
    { key: "branch_filter",     labelAr: "فلتر الفرع",              labelEn: "Branch filter" },
    { key: "status_filter",     labelAr: "فلتر الحالة",             labelEn: "Status filter pills" },
    { key: "date_range",        labelAr: "فلتر التاريخ (من/إلى)",   labelEn: "Date range filter" },
    { key: "clear_col_filters", labelAr: "مسح فلاتر الأعمدة",       labelEn: "Clear column filters" },
    { key: "bulk_post",         labelAr: "ترحيل (جماعي)",            labelEn: "Bulk post" },
    { key: "bulk_edit",         labelAr: "تعديل (من شريط التحديد)",  labelEn: "Edit (bulk bar)" },
    { key: "bulk_duplicate",    labelAr: "نسخة مماثلة",              labelEn: "Duplicate" },
    { key: "bulk_unpost",       labelAr: "فك الترحيل (جماعي)",       labelEn: "Bulk unpost" },
    { key: "bulk_return",       labelAr: "ارتجاع",                   labelEn: "Return invoice" },
    { key: "bulk_delete",       labelAr: "حذف (جماعي)",              labelEn: "Bulk delete" },
    { key: "clear_selection",   labelAr: "إلغاء التحديد",            labelEn: "Clear selection" },
  ],
};

export const POLICY_SCOPES: PolicyScope[] = ["sales", "purchase", "pos", "customers", "journal_entry", "sales_audit"];

export function defaultPolicy(scope: PolicyScope): PolicyMap {
  const out: PolicyMap = {};
  for (const f of FIELD_CATALOGUE[scope]) {
    out[f.key] = { mode: "editable", ...(f.isDate ? { dateConstraint: "none" as const } : {}) };
  }
  return out;
}

export function defaultBundle(): PolicyBundle {
  return {
    sales:         defaultPolicy("sales"),
    purchase:      defaultPolicy("purchase"),
    pos:           defaultPolicy("pos"),
    customers:     defaultPolicy("customers"),
    journal_entry: defaultPolicy("journal_entry"),
    sales_audit:   defaultPolicy("sales_audit"),
  };
}
