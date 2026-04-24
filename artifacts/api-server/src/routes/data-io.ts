/**
 * Generic AI-powered Import / Export center.
 *
 * - GET  /api/data-io/entities          → catalog of supported entities + field schema
 * - POST /api/data-io/export            → bulk export (JSON or Excel) of selected entities
 * - POST /api/data-io/import/analyze    → AI-suggested column mapping (with fuzzy fallback)
 * - POST /api/data-io/import/process    → apply mapping, normalize values, detect issues
 * - POST /api/data-io/import/commit     → transactional upsert + per-row outcome log
 *
 * Reuses the upsert-by-business-key model already used by routes/backup.ts.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import {
  branchesTable,
  warehousesTable, warehouseGroupsTable,
  itemsTable, itemGroupsTable, unitsTable,
  customersTable, suppliersTable, supplierGroupsTable,
  accountsTable,
  cashBoxesTable, bankAccountsTable,
  currenciesTable,
  journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import * as XLSX from "xlsx";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { ensureLeafAccounts } from "../lib/leafAccount.js";

// Auto-generated journal-entry types that must NEVER be created or modified
// directly via the import center — they are owned by their source documents
// (invoices, vouchers, transfers, etc.). Mirrors the list in routes/journalEntries.ts.
const LOCKED_JE_TYPES = new Set([
  "purchase_invoice", "purchase_return",
  "sales_invoice", "sales_return",
  "receipt_voucher", "payment_voucher",
  "stock_transfer", "stock_adjustment",
  "supplier_settlement", "customer_settlement",
  "payroll_run", "employee_loan", "eos_payment",
]);

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  const role = (req.authUser as any).role;
  if (role && !["superadmin", "admin", "owner"].includes(role)) {
    res.status(403).json({ error: "هذه العملية تتطلب صلاحيات مدير" });
    return;
  }
  next();
});

const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const OPENAI_KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

// ─────────────────────────────────────────────────────────────────────────────
// Entity catalog
// ─────────────────────────────────────────────────────────────────────────────

type FieldType = "string" | "number" | "boolean" | "date" | "fk";

interface FieldDef {
  name: string;          // target column name in our DB
  labelAr: string;
  labelEn: string;
  type: FieldType;
  required?: boolean;
  aliases?: string[];    // alternative header names — used both for AI hint and fuzzy fallback
  fkRef?: string;        // for type=fk: target entity key
  fkLookupBy?: string;   // for type=fk: source value matched to this column on the target table (e.g. "code")
  enum?: string[];
  default?: any;
}

interface EntityDef {
  key: string;
  labelAr: string;
  labelEn: string;
  table: any;
  hasCompanyId: boolean;
  businessKeys: string[]; // priority order; first non-empty value used as upsert key
  fields: FieldDef[];
  /** When true, the entity is hidden from the public /entities listing
   * (used only as an FK lookup target — e.g. `currencies` for cashBoxes/bankAccounts). */
  internal?: boolean;
  /**
   * Composite parent+children entity (e.g. journal entries with their lines).
   * - `linesTable`: drizzle table for the child rows
   * - `lineFkCol`: column on `linesTable` that points back to `table.id` (FK)
   * - `headerFieldNames`: subset of `fields[]` that belong on the header row
   * - `lineFieldNames`: subset of `fields[]` that belong on each line row
   * - `groupKey`: field used to group import rows into one parent doc (and to upsert by)
   * - `validateBalanced`: if true, sum(debit)===sum(credit) per group is enforced
   */
  composite?: {
    linesTable: any;
    lineFkCol: string;
    headerFieldNames: string[];
    lineFieldNames: string[];
    groupKey: string;
    validateBalanced?: boolean;
  };
}

const ENTITIES: Record<string, EntityDef> = {
  accounts: {
    key: "accounts",
    labelAr: "شجرة الحسابات",
    labelEn: "Chart of Accounts",
    table: accountsTable,
    hasCompanyId: true,
    businessKeys: ["code"],
    fields: [
      { name: "code",            labelAr: "كود الحساب", labelEn: "Account Code", type: "string", required: true,
        aliases: ["account code", "الكود", "رقم الحساب", "code", "كود"] },
      { name: "nameAr",          labelAr: "الاسم بالعربي", labelEn: "Name (Arabic)", type: "string", required: true,
        aliases: ["اسم", "الاسم", "name", "name ar", "arabic name", "اسم الحساب"] },
      { name: "nameEn",          labelAr: "الاسم بالإنجليزي", labelEn: "Name (English)", type: "string",
        aliases: ["english name", "name en"] },
      { name: "accountType",     labelAr: "نوع الحساب", labelEn: "Type", type: "string", required: true,
        enum: ["asset", "liability", "equity", "revenue", "expense"],
        aliases: ["type", "نوع", "category"] },
      { name: "parentCode",      labelAr: "كود الحساب الأب", labelEn: "Parent Code", type: "fk",
        fkRef: "accounts", fkLookupBy: "code",
        aliases: ["parent", "parent code", "الأب", "حساب الأب"] },
      { name: "reportDirection", labelAr: "توجيه التقرير", labelEn: "Report Direction", type: "string",
        enum: ["balance_sheet", "income_statement"],
        aliases: ["direction", "report"] },
      { name: "level",           labelAr: "المستوى", labelEn: "Level", type: "number", default: 1,
        aliases: ["level", "depth", "مستوى"] },
      { name: "isPosting",       labelAr: "حساب قيد", labelEn: "Posting", type: "boolean", default: true,
        aliases: ["posting", "is posting", "قيد"] },
      { name: "isActive",        labelAr: "نشط", labelEn: "Active", type: "boolean", default: true,
        aliases: ["active", "نشط", "status"] },
      { name: "notes",           labelAr: "ملاحظات", labelEn: "Notes", type: "string",
        aliases: ["notes", "ملاحظة", "وصف"] },
    ],
  },
  customers: {
    key: "customers",
    labelAr: "العملاء",
    labelEn: "Customers",
    table: customersTable,
    hasCompanyId: true,
    businessKeys: ["vatNumber", "nameAr"],
    fields: [
      { name: "nameAr",         labelAr: "الاسم بالعربي", labelEn: "Name (Arabic)", type: "string", required: true,
        aliases: ["اسم العميل", "اسم", "name", "customer name", "client"] },
      { name: "nameEn",         labelAr: "الاسم بالإنجليزي", labelEn: "Name (English)", type: "string",
        aliases: ["english name"] },
      { name: "vatNumber",      labelAr: "الرقم الضريبي", labelEn: "VAT Number", type: "string",
        aliases: ["vat", "tax number", "رقم ضريبي", "vatin", "tin"] },
      { name: "crNumber",       labelAr: "السجل التجاري", labelEn: "CR Number", type: "string",
        aliases: ["cr", "commercial registration", "سجل تجاري"] },
      { name: "email",          labelAr: "البريد الإلكتروني", labelEn: "Email", type: "string",
        aliases: ["email", "بريد", "e-mail"] },
      { name: "phone",          labelAr: "الهاتف", labelEn: "Phone", type: "string",
        aliases: ["phone", "mobile", "tel", "هاتف", "جوال"] },
      { name: "city",           labelAr: "المدينة", labelEn: "City", type: "string", aliases: ["city", "مدينة"] },
      { name: "district",       labelAr: "الحي", labelEn: "District", type: "string", aliases: ["district", "حي", "neighborhood"] },
      { name: "street",         labelAr: "الشارع", labelEn: "Street", type: "string", aliases: ["street", "شارع", "address"] },
      { name: "buildingNumber", labelAr: "رقم المبنى", labelEn: "Building No.", type: "string", aliases: ["building", "مبنى"] },
      { name: "postalCode",     labelAr: "الرمز البريدي", labelEn: "Postal Code", type: "string", aliases: ["postal", "zip", "بريدي"] },
      { name: "country",        labelAr: "الدولة", labelEn: "Country", type: "string", default: "SA", aliases: ["country", "دولة"] },
    ],
  },
  suppliers: {
    key: "suppliers",
    labelAr: "الموردون",
    labelEn: "Suppliers",
    table: suppliersTable,
    hasCompanyId: true,
    businessKeys: ["code", "vatNumber", "nameAr"],
    fields: [
      { name: "code",      labelAr: "كود المورد", labelEn: "Code", type: "string",
        aliases: ["code", "supplier code", "كود"] },
      { name: "nameAr",    labelAr: "الاسم بالعربي", labelEn: "Name (Arabic)", type: "string", required: true,
        aliases: ["اسم", "اسم المورد", "name", "supplier name"] },
      { name: "nameEn",    labelAr: "الاسم بالإنجليزي", labelEn: "Name (English)", type: "string", aliases: ["english name"] },
      { name: "vatNumber", labelAr: "الرقم الضريبي", labelEn: "VAT Number", type: "string", aliases: ["vat", "tax", "رقم ضريبي"] },
      { name: "crNumber",  labelAr: "السجل التجاري", labelEn: "CR Number", type: "string", aliases: ["cr", "سجل تجاري"] },
      { name: "email",     labelAr: "البريد الإلكتروني", labelEn: "Email", type: "string", aliases: ["email", "بريد"] },
      { name: "phone",     labelAr: "الهاتف", labelEn: "Phone", type: "string", aliases: ["phone", "هاتف", "جوال"] },
      { name: "city",      labelAr: "المدينة", labelEn: "City", type: "string", aliases: ["city", "مدينة"] },
      { name: "country",   labelAr: "الدولة", labelEn: "Country", type: "string", default: "SA", aliases: ["country", "دولة"] },
      // suppliers.currency_code is a plain text column on the suppliers table (not an FK).
      { name: "currencyCode", labelAr: "العملة", labelEn: "Currency", type: "string", default: "SAR", aliases: ["currency", "عملة", "ccy"] },
      { name: "openingBalance", labelAr: "الرصيد الافتتاحي", labelEn: "Opening Balance", type: "number", aliases: ["opening", "balance", "رصيد افتتاحي"] },
      { name: "creditLimit",    labelAr: "حد الائتمان", labelEn: "Credit Limit", type: "number", aliases: ["credit limit", "حد ائتمان"] },
    ],
  },
  items: {
    key: "items",
    labelAr: "الأصناف",
    labelEn: "Items",
    table: itemsTable,
    hasCompanyId: true,
    businessKeys: ["code", "barcode"],
    fields: [
      { name: "code",       labelAr: "كود الصنف", labelEn: "Item Code", type: "string", required: true,
        aliases: ["code", "sku", "item code", "كود", "رمز"] },
      { name: "nameAr",     labelAr: "الاسم بالعربي", labelEn: "Name (Arabic)", type: "string", required: true,
        aliases: ["اسم", "اسم الصنف", "name", "item name", "description"] },
      { name: "nameEn",     labelAr: "الاسم بالإنجليزي", labelEn: "Name (English)", type: "string", aliases: ["english name"] },
      { name: "barcode",    labelAr: "الباركود", labelEn: "Barcode", type: "string", aliases: ["barcode", "باركود", "ean", "upc"] },
      { name: "itemType",   labelAr: "نوع الصنف", labelEn: "Item Type", type: "string", default: "stock",
        enum: ["stock", "service"],
        aliases: ["type", "نوع", "kind"] },
      { name: "costPrice",  labelAr: "سعر التكلفة", labelEn: "Cost Price", type: "number", default: 0,
        aliases: ["cost", "purchase price", "سعر التكلفة", "سعر الشراء"] },
      { name: "salePrice",  labelAr: "سعر البيع", labelEn: "Sale Price", type: "number", default: 0,
        aliases: ["price", "sale price", "selling price", "سعر البيع"] },
      { name: "vatRate",    labelAr: "نسبة الضريبة", labelEn: "VAT %", type: "number", default: 15,
        aliases: ["vat", "tax", "نسبة", "ضريبة"] },
      { name: "reorderLevel", labelAr: "حد الطلب", labelEn: "Reorder Level", type: "number", aliases: ["min", "reorder", "حد الطلب"] },
      { name: "description",  labelAr: "الوصف", labelEn: "Description", type: "string", aliases: ["description", "وصف", "notes", "ملاحظة"] },
    ],
  },
  warehouses: {
    key: "warehouses",
    labelAr: "المخازن",
    labelEn: "Warehouses",
    table: warehousesTable,
    hasCompanyId: true,
    businessKeys: ["code"],
    fields: [
      { name: "code",   labelAr: "كود المخزن", labelEn: "Code", type: "string", required: true, aliases: ["code", "كود"] },
      { name: "nameAr", labelAr: "الاسم بالعربي", labelEn: "Name (Arabic)", type: "string", required: true,
        aliases: ["اسم", "name", "اسم المخزن"] },
      { name: "nameEn", labelAr: "الاسم بالإنجليزي", labelEn: "Name (English)", type: "string", aliases: ["english name"] },
      { name: "city",   labelAr: "المدينة", labelEn: "City", type: "string", aliases: ["city", "مدينة"] },
      { name: "region", labelAr: "المنطقة", labelEn: "Region", type: "string", aliases: ["region", "منطقة"] },
      { name: "isActive", labelAr: "نشط", labelEn: "Active", type: "boolean", default: true, aliases: ["active", "نشط"] },
      { name: "allowNegative", labelAr: "يسمح بالسالب", labelEn: "Allow Negative", type: "boolean", default: false,
        aliases: ["allow negative", "negative"] },
    ],
  },
  branches: {
    key: "branches",
    labelAr: "الفروع",
    labelEn: "Branches",
    table: branchesTable,
    hasCompanyId: true,
    businessKeys: ["code", "nameAr"],
    fields: [
      { name: "code",   labelAr: "كود الفرع", labelEn: "Code", type: "string", required: true, aliases: ["code", "كود"] },
      { name: "nameAr", labelAr: "الاسم بالعربي", labelEn: "Name (Arabic)", type: "string", required: true,
        aliases: ["اسم", "name", "اسم الفرع"] },
      { name: "nameEn", labelAr: "الاسم بالإنجليزي", labelEn: "Name (English)", type: "string", aliases: ["english name"] },
      { name: "city",    labelAr: "المدينة", labelEn: "City", type: "string", aliases: ["city", "مدينة"] },
      { name: "address", labelAr: "العنوان", labelEn: "Address", type: "string", aliases: ["address", "عنوان"] },
      { name: "phone",   labelAr: "الهاتف", labelEn: "Phone", type: "string", aliases: ["phone", "هاتف"] },
      { name: "email",   labelAr: "البريد", labelEn: "Email", type: "string", aliases: ["email", "بريد"] },
      { name: "isMain",  labelAr: "فرع رئيسي", labelEn: "Main Branch", type: "boolean", default: false, aliases: ["main", "رئيسي"] },
    ],
  },
  cashBoxes: {
    key: "cashBoxes",
    labelAr: "الخزن النقدية",
    labelEn: "Cash Boxes",
    table: cashBoxesTable,
    hasCompanyId: true,
    businessKeys: ["code"],
    fields: [
      { name: "code",   labelAr: "كود الخزينة", labelEn: "Code", type: "string", required: true, aliases: ["code", "كود"] },
      { name: "nameAr", labelAr: "الاسم بالعربي", labelEn: "Name (Arabic)", type: "string", required: true, aliases: ["اسم", "name"] },
      { name: "nameEn", labelAr: "الاسم بالإنجليزي", labelEn: "Name (English)", type: "string", aliases: ["english name"] },
      // Virtual FK: user supplies currency code, we resolve to currencyId via the currencies catalog.
      { name: "currencyCode", labelAr: "العملة", labelEn: "Currency", type: "fk", default: "SAR",
        fkRef: "currencies", fkLookupBy: "code", aliases: ["currency", "عملة", "ccy"] },
    ],
  },
  bankAccounts: {
    key: "bankAccounts",
    labelAr: "الحسابات البنكية",
    labelEn: "Bank Accounts",
    table: bankAccountsTable,
    hasCompanyId: true,
    businessKeys: ["code", "accountNumber"],
    fields: [
      { name: "code",          labelAr: "الكود", labelEn: "Code", type: "string", required: true, aliases: ["code", "كود"] },
      { name: "nameAr",        labelAr: "اسم البنك", labelEn: "Bank Name", type: "string", required: true, aliases: ["bank", "name", "اسم البنك"] },
      { name: "nameEn",        labelAr: "الاسم بالإنجليزي", labelEn: "Name (English)", type: "string", aliases: ["english name"] },
      { name: "accountNumber", labelAr: "رقم الحساب", labelEn: "Account Number", type: "string", aliases: ["account number", "رقم الحساب", "iban"] },
      { name: "currencyCode",  labelAr: "العملة", labelEn: "Currency", type: "fk", default: "SAR",
        fkRef: "currencies", fkLookupBy: "code", aliases: ["currency", "عملة", "ccy"] },
    ],
  },
  // ─── Composite entity: each import row = one journal entry LINE.
  // Lines that share the same `docNumber` are grouped into a single header.
  // Header fields (entryDate, description, currency, …) are taken from the FIRST row
  // of each group; subsequent rows in the same group only contribute lines.
  journalEntries: {
    key: "journalEntries",
    labelAr: "القيود المحاسبية",
    labelEn: "Journal Entries",
    table: journalEntriesTable,
    hasCompanyId: true,
    businessKeys: ["docNumber"],
    composite: {
      linesTable: journalEntryLinesTable,
      lineFkCol: "entryId",
      headerFieldNames: ["docNumber", "entryDate", "description", "currency", "exchangeRate", "entryType", "branchCode", "status"],
      lineFieldNames: ["accountCode", "debit", "credit", "lineDescription", "costCenter"],
      groupKey: "docNumber",
      validateBalanced: true,
    },
    fields: [
      // ── Header columns (repeated on every line of the same docNumber) ──
      { name: "docNumber",   labelAr: "رقم القيد", labelEn: "Doc Number", type: "string", required: true,
        aliases: ["doc number", "رقم المستند", "doc no", "document number", "رقم"] },
      { name: "entryDate",   labelAr: "تاريخ القيد", labelEn: "Entry Date", type: "date", required: true,
        aliases: ["date", "تاريخ", "entry date", "التاريخ"] },
      { name: "description", labelAr: "البيان", labelEn: "Description", type: "string",
        aliases: ["البيان", "وصف", "description", "memo", "الوصف"] },
      { name: "currency",    labelAr: "العملة", labelEn: "Currency", type: "string", default: "SAR",
        aliases: ["currency", "العملة", "ccy"] },
      { name: "exchangeRate", labelAr: "سعر الصرف", labelEn: "Exchange Rate", type: "number", default: 1,
        aliases: ["exchange rate", "سعر الصرف", "rate"] },
      { name: "entryType",   labelAr: "نوع القيد", labelEn: "Entry Type", type: "string", default: "general",
        aliases: ["type", "نوع", "entry type"] },
      { name: "branchCode",  labelAr: "كود الفرع", labelEn: "Branch Code", type: "fk",
        fkRef: "branches", fkLookupBy: "code", aliases: ["branch", "الفرع", "كود الفرع", "branch code"] },
      { name: "status",      labelAr: "الحالة", labelEn: "Status", type: "string", default: "draft",
        aliases: ["status", "الحالة"] },
      // ── Line columns (one per row) ──
      { name: "accountCode",     labelAr: "كود الحساب", labelEn: "Account Code", type: "fk", required: true,
        fkRef: "accounts", fkLookupBy: "code", aliases: ["account", "الحساب", "كود الحساب", "account code"] },
      { name: "debit",           labelAr: "مدين", labelEn: "Debit", type: "number", default: 0,
        aliases: ["debit", "مدين", "دائن=0"] },
      { name: "credit",          labelAr: "دائن", labelEn: "Credit", type: "number", default: 0,
        aliases: ["credit", "دائن"] },
      { name: "lineDescription", labelAr: "بيان السطر", labelEn: "Line Description", type: "string",
        aliases: ["line description", "بيان السطر", "تفاصيل السطر", "line memo"] },
      { name: "costCenter",      labelAr: "مركز التكلفة", labelEn: "Cost Center", type: "string",
        aliases: ["cost center", "مركز التكلفة", "cc"] },
    ],
  },
  // currencies is *not* user-exportable / importable from the Settings UI on its own,
  // but it IS referenced as an FK target by cashBoxes and bankAccounts.
  // We expose the catalog row so the FK resolver can find currenciesTable.
  currencies: {
    key: "currencies",
    labelAr: "العملات",
    labelEn: "Currencies",
    table: currenciesTable,
    hasCompanyId: true,
    businessKeys: ["code"],
    internal: true, // hidden from /entities listing
    fields: [
      { name: "code",   labelAr: "الرمز", labelEn: "Code",   type: "string", required: true },
      { name: "nameAr", labelAr: "الاسم بالعربي", labelEn: "Name (Arabic)", type: "string", required: true },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Value normalizers
// ─────────────────────────────────────────────────────────────────────────────

function trimStr(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function parseNumber(v: any): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // strip currency symbols, thousands separators, Arabic digits
  let s = String(v).trim();
  if (!s) return null;
  // arabic-indic digits → ascii
  s = s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  // remove anything that isn't a digit, dot, minus, comma
  s = s.replace(/[^\d.,\-]/g, "");
  // if both . and , present: assume , thousands and . decimal → strip ,
  if (s.indexOf(".") !== -1 && s.indexOf(",") !== -1) s = s.replace(/,/g, "");
  // else if only , → treat as decimal separator
  else if (s.indexOf(",") !== -1 && s.indexOf(".") === -1) s = s.replace(/,/g, ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseBoolean(v: any): boolean | null {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["true", "yes", "y", "1", "نعم", "صح", "active", "نشط"].includes(s)) return true;
  if (["false", "no", "n", "0", "لا", "خطأ", "inactive", "غير نشط"].includes(s)) return false;
  return null;
}

function parseDate(v: any): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    // Excel serial date
    if (v > 25569 && v < 60000) {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return d.toISOString().slice(0, 10);
    }
  }
  const s = String(v).trim();
  if (!s) return null;
  // try ISO first
  let d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // try DD/MM/YYYY or DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) {
    let [, day, mon, year] = m;
    if (year.length === 2) year = (Number(year) > 50 ? "19" : "20") + year;
    d = new Date(`${year}-${mon.padStart(2, "0")}-${day.padStart(2, "0")}`);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function normalizeValue(field: FieldDef, raw: any): { value: any; ok: boolean; before: any; after: any } {
  const before = raw;
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    if (field.default !== undefined) return { value: field.default, ok: true, before, after: field.default };
    return { value: null, ok: true, before, after: null };
  }
  switch (field.type) {
    case "number": {
      const n = parseNumber(raw);
      return { value: n, ok: n !== null, before, after: n };
    }
    case "boolean": {
      const b = parseBoolean(raw);
      const v = b ?? field.default ?? null;
      return { value: v, ok: b !== null || field.default !== undefined, before, after: v };
    }
    case "date": {
      const d = parseDate(raw);
      return { value: d, ok: d !== null, before, after: d };
    }
    case "string":
    case "fk":
    default: {
      let s = trimStr(raw);
      if (s && field.enum) {
        const lower = s.toLowerCase();
        const match = field.enum.find((e) => e.toLowerCase() === lower);
        if (match) {
          s = match;
        } else {
          // Value present but not in enum → reject (DB would reject anyway, fail fast in process).
          return { value: null, ok: false, before, after: null };
        }
      }
      return { value: s, ok: s !== null, before, after: s };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Header → field fuzzy matcher (deterministic fallback when AI is unavailable)
// ─────────────────────────────────────────────────────────────────────────────

function norm(s: string): string {
  return String(s ?? "").toLowerCase().trim()
    .replace(/[\s_\-\.]+/g, "")
    .replace(/[\u064B-\u065F]/g, ""); // strip Arabic diacritics
}

function fuzzyMatch(header: string, field: FieldDef): number {
  const h = norm(header);
  if (!h) return 0;
  const candidates: string[] = [
    field.name, field.labelAr, field.labelEn,
    ...(field.aliases ?? []),
  ].map(norm).filter(Boolean);
  let best = 0;
  for (const c of candidates) {
    if (c === h) return 1;
    if (c.length > 2 && (h.includes(c) || c.includes(h))) {
      const score = Math.min(c.length, h.length) / Math.max(c.length, h.length);
      if (score > best) best = score;
    }
  }
  return best;
}

function fallbackMapping(headers: string[], entity: EntityDef): Record<string, { field: string | null; confidence: number }> {
  const used = new Set<string>();
  const out: Record<string, { field: string | null; confidence: number }> = {};
  // first pass: greedy best-match per header
  const ranked = headers.map((h) => {
    const scored = entity.fields
      .map((f) => ({ field: f.name, score: fuzzyMatch(h, f) }))
      .sort((a, b) => b.score - a.score);
    return { header: h, scored };
  });
  for (const { header, scored } of ranked) {
    const top = scored.find((s) => s.score >= 0.55 && !used.has(s.field));
    if (top) {
      out[header] = { field: top.field, confidence: top.score };
      used.add(top.field);
    } else {
      out[header] = { field: null, confidence: 0 };
    }
  }
  return out;
}

async function aiMapping(
  headers: string[],
  sample: any[],
  entity: EntityDef,
): Promise<Record<string, { field: string | null; confidence: number }> | null> {
  if (!OPENAI_BASE || !OPENAI_KEY) return null;
  const fieldList = entity.fields.map((f) => ({
    name: f.name,
    labelAr: f.labelAr,
    labelEn: f.labelEn,
    type: f.type,
    required: !!f.required,
    aliases: f.aliases ?? [],
    enum: f.enum,
  }));
  const userPrompt = `لديك ملف بيانات يحتوي على رؤوس أعمدة (headers) وعينة من الصفوف. المطلوب: ربط كل رأس عمود بأقرب حقل من حقول الجدول الهدف "${entity.labelAr}" (${entity.labelEn}).

حقول الجدول الهدف:
${JSON.stringify(fieldList, null, 2)}

رؤوس الأعمدة في الملف:
${JSON.stringify(headers)}

عينة من أول الصفوف (لمساعدتك على التخمين):
${JSON.stringify(sample.slice(0, 5))}

أعد JSON فقط بهذا الشكل بالضبط (بدون أي شرح):
{
  "mapping": {
    "<header source>": { "field": "<targetFieldName أو null>", "confidence": 0.0..1.0 }
  }
}

ملاحظات:
- استخدم null إذا كان العمود لا يطابق أي حقل أو يبدو غير ذي صلة (مثل: المسلسل، رقم الصف، إجمالي).
- لا تستخدم نفس الحقل الهدف لأكثر من رأس عمود.
- استخدم الأسماء العربية والإنجليزية والأسماء البديلة (aliases) للمساعدة في التطابق.`;

  try {
    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 4096,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "أنت مساعد لربط أعمدة ملفات البيانات بحقول قاعدة بيانات. ترد بـ JSON فقط." },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content);
    const m = parsed?.mapping ?? {};
    const out: Record<string, { field: string | null; confidence: number }> = {};
    const validFieldNames = new Set(entity.fields.map((f) => f.name));
    const used = new Set<string>();
    for (const h of headers) {
      const v = m[h];
      let field: string | null = null;
      let confidence = 0;
      if (v && typeof v === "object") {
        if (v.field && validFieldNames.has(v.field) && !used.has(v.field)) {
          field = v.field;
          confidence = Math.max(0, Math.min(1, Number(v.confidence ?? 0.7)));
          used.add(field);
        }
      }
      out[h] = { field, confidence };
    }
    return out;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /entities — catalog for client UI
// ─────────────────────────────────────────────────────────────────────────────

router.get("/entities", (_req, res) => {
  const out = Object.values(ENTITIES)
    .filter((e) => !e.internal)
    .map((e) => ({
      key: e.key,
      labelAr: e.labelAr,
      labelEn: e.labelEn,
      businessKeys: e.businessKeys,
      fields: e.fields.map((f) => ({
        name: f.name, labelAr: f.labelAr, labelEn: f.labelEn,
        type: f.type, required: !!f.required, enum: f.enum,
      })),
      ...(e.composite ? {
        composite: {
          groupKey: e.composite.groupKey,
          headerFieldNames: e.composite.headerFieldNames,
          lineFieldNames:   e.composite.lineFieldNames,
          validateBalanced: !!e.composite.validateBalanced,
        },
      } : {}),
    }));
  res.json(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /export — export selected entities as JSON or Excel
// ─────────────────────────────────────────────────────────────────────────────

// DoS guards: cap the export to keep memory + response time bounded.
// (Tenants with very large tables should use a future async/streaming export.)
const EXPORT_MAX_ENTITIES = 12;
const EXPORT_MAX_ROWS_PER_ENTITY = 50_000;

router.post("/export", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.body?.companyId ? Number(req.body.companyId) : undefined);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const types = Array.isArray(req.body?.types) ? (req.body.types as string[]) : Object.keys(ENTITIES);
    const format = (req.body?.format as string) === "xlsx" ? "xlsx" : "json";

    if (types.length > EXPORT_MAX_ENTITIES) {
      res.status(413).json({
        error: `لا يمكن تصدير أكثر من ${EXPORT_MAX_ENTITIES} نوع في مرة واحدة`,
        limit: EXPORT_MAX_ENTITIES,
      });
      return;
    }

    const data: Record<string, any[]> = {};
    const truncated: Record<string, number> = {};
    for (const t of types) {
      const ent = ENTITIES[t];
      if (!ent) continue;
      // Read one extra row so we can detect (and report) truncation cleanly.
      const limit = EXPORT_MAX_ROWS_PER_ENTITY + 1;

      if (ent.composite) {
        // Composite entity: emit one row per LINE with header columns repeated.
        // We also resolve FK ids back to their source codes (branchId→branchCode, accountId→accountCode)
        // so the exported file is round-trippable through /import/commit.
        const headers = ent.hasCompanyId
          ? await db.select().from(ent.table).where(eq(ent.table.companyId, cid)).limit(limit)
          : await db.select().from(ent.table).limit(limit);
        const headerIds = headers.map((h) => (h as any).id as number);
        const lines = headerIds.length
          ? await db.select().from(ent.composite.linesTable).where(inArray((ent.composite.linesTable as any)[ent.composite.lineFkCol], headerIds))
          : [];

        // Build FK code lookups so we can flatten *Id back into *Code on export.
        const codeLookups: Record<string, Map<number, string>> = {};
        for (const f of ent.fields) {
          if (f.type !== "fk" || !f.fkRef || !f.fkLookupBy) continue;
          const refEnt = ENTITIES[f.fkRef];
          if (!refEnt) continue;
          const refRows = refEnt.hasCompanyId
            ? await db.select().from(refEnt.table).where(eq(refEnt.table.companyId, cid))
            : await db.select().from(refEnt.table);
          const m = new Map<number, string>();
          for (const r of refRows) {
            const code = (r as any)[f.fkLookupBy];
            if (code != null) m.set((r as any).id, String(code));
          }
          codeLookups[f.name] = m;
        }

        const headersById = new Map<number, any>();
        for (const h of headers) headersById.set((h as any).id, h);

        const flat: any[] = [];
        for (const ln of lines) {
          const headerId = (ln as any)[ent.composite.lineFkCol];
          const h = headersById.get(headerId);
          if (!h) continue;
          const row: any = { id: (ln as any).id, __headerId: headerId };
          // Header fields
          for (const fname of ent.composite.headerFieldNames) {
            const f = ent.fields.find((ff) => ff.name === fname);
            if (!f) continue;
            if (f.type === "fk") {
              const idCol = f.name.replace(/Code$/, "Id");
              const id = (h as any)[idCol];
              const code = id != null ? codeLookups[f.name]?.get(Number(id)) : null;
              row[fname] = code ?? "";
            } else {
              row[fname] = (h as any)[fname];
            }
          }
          // Line fields
          for (const fname of ent.composite.lineFieldNames) {
            const f = ent.fields.find((ff) => ff.name === fname);
            if (!f) continue;
            // line description is stored as `description` on the lines table (per schema), so map it.
            const lineCol = fname === "lineDescription" ? "description" : fname;
            if (f.type === "fk") {
              const idCol = f.name.replace(/Code$/, "Id");
              const id = (ln as any)[idCol];
              const code = id != null ? codeLookups[f.name]?.get(Number(id)) : null;
              row[fname] = code ?? "";
            } else {
              row[fname] = (ln as any)[lineCol];
            }
          }
          flat.push(row);
        }

        if (flat.length > EXPORT_MAX_ROWS_PER_ENTITY) {
          truncated[t] = EXPORT_MAX_ROWS_PER_ENTITY;
          data[t] = flat.slice(0, EXPORT_MAX_ROWS_PER_ENTITY);
        } else {
          data[t] = flat;
        }
        continue;
      }

      const rows = ent.hasCompanyId
        ? await db.select().from(ent.table).where(eq(ent.table.companyId, cid)).limit(limit)
        : await db.select().from(ent.table).limit(limit);
      if (rows.length > EXPORT_MAX_ROWS_PER_ENTITY) {
        truncated[t] = EXPORT_MAX_ROWS_PER_ENTITY;
        data[t] = rows.slice(0, EXPORT_MAX_ROWS_PER_ENTITY);
      } else {
        data[t] = rows;
      }
    }

    const meta = {
      schemaVersion: 1,
      companyId: cid,
      exportedAt: new Date().toISOString(),
      exportedBy: (req.authUser as any)?.username ?? null,
      types,
      counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
      ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
    };

    if (format === "json") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="data-export-${cid}-${Date.now()}.json"`);
      res.send(JSON.stringify({ meta, data }, null, 2));
      return;
    }

    // Excel: one sheet per entity, plus a meta sheet
    const wb = XLSX.utils.book_new();
    const metaRows = [
      ["Field", "Value"],
      ["companyId", cid],
      ["exportedAt", meta.exportedAt],
      ["exportedBy", meta.exportedBy ?? ""],
      [],
      ["Entity", "Rows"],
      ...Object.entries(meta.counts).map(([k, v]) => [k, v]),
    ];
    const metaWs = XLSX.utils.aoa_to_sheet(metaRows);
    XLSX.utils.book_append_sheet(wb, metaWs, "_meta");

    for (const t of types) {
      const ent = ENTITIES[t];
      if (!ent) continue;
      const rows = data[t] ?? [];
      // header row from entity.fields plus id (so a JSON re-import preserves links if needed)
      const fieldNames = ["id", ...ent.fields.map((f) => f.name)];
      const aoa: any[][] = [
        ent.fields.map((f) => f.labelAr).reduce<any[]>((acc, _l, i) => {
          acc[i + 1] = ent.fields[i].labelAr;
          return acc;
        }, ["id"]),
      ];
      for (const r of rows) {
        aoa.push(fieldNames.map((fn) => {
          const v = (r as any)[fn];
          if (v === null || v === undefined) return "";
          if (typeof v === "boolean") return v ? "نعم" : "لا";
          return v;
        }));
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // Sheet name limit is 31 chars in Excel
      XLSX.utils.book_append_sheet(wb, ws, t.slice(0, 31));
    }

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="data-export-${cid}-${Date.now()}.xlsx"`);
    res.send(buf);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /import/analyze — AI-suggested mapping
// body: { entity, headers: string[], sampleRows: any[][] | object[] }
// ─────────────────────────────────────────────────────────────────────────────

router.post("/import/analyze", async (req, res) => {
  try {
    const entityKey = String(req.body?.entity ?? "");
    const ent = ENTITIES[entityKey];
    if (!ent) { res.status(400).json({ error: "نوع البيانات غير معروف" }); return; }
    const headers = Array.isArray(req.body?.headers) ? req.body.headers.map((h: any) => String(h)) : [];
    if (headers.length === 0) { res.status(400).json({ error: "لم يتم اكتشاف أي رؤوس أعمدة" }); return; }
    const sampleRows = Array.isArray(req.body?.sampleRows) ? req.body.sampleRows : [];

    let mapping = await aiMapping(headers, sampleRows, ent);
    let source: "ai" | "fallback" = "ai";
    if (!mapping) {
      mapping = fallbackMapping(headers, ent);
      source = "fallback";
    }

    // suggest required fields that are still unmapped
    const mappedTargets = new Set(Object.values(mapping).map((m) => m.field).filter(Boolean) as string[]);
    const missingRequired = ent.fields
      .filter((f) => f.required && !mappedTargets.has(f.name))
      .map((f) => ({ field: f.name, labelAr: f.labelAr }));

    res.json({
      entity: ent.key,
      source,
      mapping,
      missingRequired,
      stats: {
        totalHeaders: headers.length,
        mapped: mappedTargets.size,
        unmapped: headers.length - Object.values(mapping).filter((m) => m.field).length,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ في التحليل" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /import/process — apply mapping, normalize, detect issues
// body: { entity, mapping: { sourceHeader: targetField | null }, rows: object[] }
//   each row is keyed by source header (the client builds this from the parsed file)
// ─────────────────────────────────────────────────────────────────────────────

interface RowIssue {
  rowIndex: number;
  field: string | null;
  type: "missing_required" | "invalid_format" | "fk_unresolved" | "fk_resolved" | "duplicate" | "value_normalized";
  severity: "error" | "warning" | "info";
  before: any;
  after: any;
  action: string;
  confidence: number;
  message: string;
}

router.post("/import/process", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.body?.companyId ? Number(req.body.companyId) : undefined);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const entityKey = String(req.body?.entity ?? "");
    const ent = ENTITIES[entityKey];
    if (!ent) { res.status(400).json({ error: "نوع البيانات غير معروف" }); return; }
    const mapping = (req.body?.mapping ?? {}) as Record<string, string | null>;
    const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    // Pre-load FK lookup maps once
    const fkMaps: Record<string, Map<string, number>> = {};
    for (const f of ent.fields) {
      if (f.type === "fk" && f.fkRef && f.fkLookupBy) {
        const refEnt = ENTITIES[f.fkRef];
        if (!refEnt) continue;
        const rows = refEnt.hasCompanyId
          ? await db.select().from(refEnt.table).where(eq(refEnt.table.companyId, cid))
          : await db.select().from(refEnt.table);
        const m = new Map<string, number>();
        for (const r of rows) {
          const v = (r as any)[f.fkLookupBy];
          if (v != null && String(v).trim() !== "") m.set(String(v).trim(), (r as any).id);
        }
        fkMaps[f.name] = m;
      }
    }

    // Pre-load existing rows for duplicate detection (by business key)
    const existingByKey = new Map<string, number>();
    if (ent.businessKeys.length > 0) {
      const existing = ent.hasCompanyId
        ? await db.select().from(ent.table).where(eq(ent.table.companyId, cid))
        : await db.select().from(ent.table);
      for (const r of existing) {
        for (const k of ent.businessKeys) {
          const v = (r as any)[k];
          if (v != null && String(v).trim() !== "") {
            existingByKey.set(`${k}:${String(v).trim()}`, (r as any).id);
            break;
          }
        }
      }
    }

    // also detect duplicates within the file itself
    const seenInFile = new Map<string, number>();
    const processed: any[] = [];
    const issues: RowIssue[] = [];

    rawRows.forEach((srcRow: any, idx: number) => {
      const targetRow: any = {};
      // build target row from mapping
      for (const [src, tgt] of Object.entries(mapping)) {
        if (!tgt) continue;
        const field = ent.fields.find((f) => f.name === tgt);
        if (!field) continue;
        const raw = srcRow?.[src];
        const norm = normalizeValue(field, raw);
        if (!norm.ok && raw != null && String(raw).trim() !== "") {
          issues.push({
            rowIndex: idx, field: tgt, type: "invalid_format", severity: "warning",
            before: norm.before, after: null, action: "تجاهل القيمة وإفراغ الحقل",
            confidence: 0.8, message: `قيمة غير صالحة لحقل ${field.labelAr}`,
          });
        } else if (norm.before !== norm.after && norm.before != null && String(norm.before).trim() !== "") {
          // normalization changed the value
          issues.push({
            rowIndex: idx, field: tgt, type: "value_normalized", severity: "info",
            before: norm.before, after: norm.after, action: "تم توحيد التنسيق",
            confidence: 0.95, message: `تم تحويل ${field.labelAr} إلى التنسيق القياسي`,
          });
        }
        targetRow[tgt] = norm.value;
      }

      // apply defaults for unmapped fields with defaults
      for (const f of ent.fields) {
        if (!(f.name in targetRow) && f.default !== undefined) {
          targetRow[f.name] = f.default;
        }
      }

      // FK resolution: parentCode → parentId, etc.
      for (const f of ent.fields) {
        if (f.type === "fk" && f.fkRef && f.fkLookupBy) {
          const lookupVal = targetRow[f.name];
          if (lookupVal == null || String(lookupVal).trim() === "") continue;
          const map = fkMaps[f.name];
          const id = map?.get(String(lookupVal).trim());
          // Convention: store resolved id in `${baseName}Id` if exists, else replace inline.
          const idCol = f.name.replace(/Code$/, "Id");
          if (id != null) {
            targetRow[idCol] = id;
            issues.push({
              rowIndex: idx, field: f.name, type: "fk_resolved", severity: "info",
              before: lookupVal, after: id, action: `تم الربط بسجل موجود (${f.fkRef})`,
              confidence: 1.0, message: `تم العثور على ${f.labelAr} = ${lookupVal}`,
            });
          } else {
            issues.push({
              rowIndex: idx, field: f.name, type: "fk_unresolved", severity: "warning",
              before: lookupVal, after: null, action: "سيتم تجاهل الحقل (يحتاج إنشاء يدوي لاحقًا)",
              confidence: 0.6, message: `لم يتم العثور على ${f.labelAr} = ${lookupVal}`,
            });
          }
        }
      }

      // Required field validation
      for (const f of ent.fields) {
        if (!f.required) continue;
        const v = targetRow[f.name];
        if (v == null || (typeof v === "string" && v.trim() === "")) {
          issues.push({
            rowIndex: idx, field: f.name, type: "missing_required", severity: "error",
            before: null, after: null, action: "سيتم رفض هذا السجل عند التنفيذ",
            confidence: 1.0, message: `حقل ${f.labelAr} مطلوب وغير موجود`,
          });
        }
      }

      // Duplicate detection (vs existing DB + within file)
      let bizKey: string | null = null;
      for (const k of ent.businessKeys) {
        const v = targetRow[k];
        if (v != null && String(v).trim() !== "") { bizKey = `${k}:${String(v).trim()}`; break; }
      }
      if (bizKey) {
        if (existingByKey.has(bizKey)) {
          targetRow.__existingId = existingByKey.get(bizKey);
          issues.push({
            rowIndex: idx, field: null, type: "duplicate", severity: "info",
            before: bizKey, after: existingByKey.get(bizKey), action: "سيتم التحديث (upsert)",
            confidence: 1.0, message: "السجل موجود بالفعل وسيتم تحديثه",
          });
        }
        if (seenInFile.has(bizKey)) {
          issues.push({
            rowIndex: idx, field: null, type: "duplicate", severity: "warning",
            before: bizKey, after: seenInFile.get(bizKey), action: "تكرار داخل الملف — سيُحفظ الأخير",
            confidence: 1.0, message: "هذا السجل مكرر في الملف نفسه",
          });
        }
        seenInFile.set(bizKey, idx);
      }
      targetRow.__rowIndex = idx;
      targetRow.__bizKey = bizKey;
      processed.push(targetRow);
    });

    res.json({
      entity: ent.key,
      processed,
      issues,
      stats: {
        total:    processed.length,
        errors:   issues.filter((i) => i.severity === "error").length,
        warnings: issues.filter((i) => i.severity === "warning").length,
        info:     issues.filter((i) => i.severity === "info").length,
        duplicates: issues.filter((i) => i.type === "duplicate").length,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ في المعالجة" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Composite-entity commit: groups rows by `groupKey` (e.g. docNumber), inserts one
// header row per group + N line rows per group transactionally. On conflict (existing
// header with same business key for this company), replaces the lines and updates the
// header. Validates that sum(debit) === sum(credit) per group when validateBalanced.
async function commitComposite(args: {
  ent: EntityDef;
  rows: any[];
  cid: number;
  skipErrors: boolean;
  log: Array<{ rowIndex: number; status: "inserted" | "updated" | "skipped" | "error"; id?: number; reason?: string }>;
  counters: { inserted: number; updated: number; skipped: number; errors: number };
}): Promise<{ log: typeof args.log; counters: typeof args.counters }> {
  const { ent, rows, cid, skipErrors, log, counters } = args;
  const comp = ent.composite!;
  const groupKey = comp.groupKey;

  // Group rows by groupKey (preserving original __rowIndex on each row).
  type Group = { key: string; rows: any[] };
  const groupsMap = new Map<string, Group>();
  const orphan: any[] = []; // rows missing the groupKey
  for (const r of rows) {
    const v = r[groupKey];
    if (v == null || String(v).trim() === "") { orphan.push(r); continue; }
    const k = String(v).trim();
    let g = groupsMap.get(k);
    if (!g) { g = { key: k, rows: [] }; groupsMap.set(k, g); }
    g.rows.push(r);
  }
  // Skip orphan rows up front (they fail validation in /process anyway).
  for (const r of orphan) {
    counters.skipped++;
    log.push({ rowIndex: r.__rowIndex ?? -1, status: "skipped", reason: `حقل ${groupKey} مطلوب ولم يتم تعبئته` });
  }

  // Pre-load existing headers (by businessKey) so we know which groups upsert vs insert.
  const existingByKey = new Map<string, number>();
  if (ent.businessKeys.length > 0) {
    const existing = await db.select().from(ent.table).where(eq(ent.table.companyId, cid));
    for (const ex of existing) {
      for (const k of ent.businessKeys) {
        const v = (ex as any)[k];
        if (v != null && String(v).trim() !== "") {
          existingByKey.set(`${k}:${String(v).trim()}`, (ex as any).id);
          break;
        }
      }
    }
  }

  // Pre-load FK valid-id sets for the tenant (parity with non-composite path: prevents
  // cross-tenant id smuggling via client-supplied *Id columns).
  const fkValidIds: Record<string, Set<number>> = {};
  for (const f of ent.fields) {
    if (f.type !== "fk" || !f.fkRef) continue;
    const refEnt = ENTITIES[f.fkRef];
    if (!refEnt) continue;
    const idRows = refEnt.hasCompanyId
      ? await db.select({ id: refEnt.table.id }).from(refEnt.table).where(eq(refEnt.table.companyId, cid))
      : await db.select({ id: refEnt.table.id }).from(refEnt.table);
    fkValidIds[f.name.replace(/Code$/, "Id")] = new Set(idRows.map((r) => (r as any).id as number));
  }

  // The lines table column for "description" doesn't match the catalog's `lineDescription` field name,
  // so we map it explicitly when building the insert payload.
  const LINE_FIELD_TO_COL: Record<string, string> = { lineDescription: "description" };

  // Domain-specific guard: for journal entries, refuse to create or modify entries
  // whose entryType is locked (auto-generated by source documents). Pre-load existing
  // entryTypes in one query so we can check both insert (head.entryType) and update
  // (existing entry's entryType) paths in O(1) per group.
  const isJournalEntries = ent.key === "journalEntries";
  const existingEntryTypes = new Map<number, string | null>();
  if (isJournalEntries) {
    const existing = await db.select({ id: ent.table.id, entryType: (ent.table as any).entryType })
      .from(ent.table)
      .where(eq(ent.table.companyId, cid));
    for (const r of existing) existingEntryTypes.set((r as any).id, (r as any).entryType ?? null);
  }

  // Outer transaction wraps the whole batch. Each group runs inside its own
  // SAVEPOINT (Drizzle's nested `.transaction(...)` call) so a failure in one
  // group cannot leave partial mutations behind in `skipErrors=true` mode.
  await db.transaction(async (outerTx) => {
    for (const g of groupsMap.values()) {
      const rowIndices = g.rows.map((r) => r.__rowIndex ?? -1);
      try {
        await outerTx.transaction(async (tx) => {
          // ── 1. Build header from the FIRST row of the group.
          const head = g.rows[0];
          const headerPayload: any = { companyId: cid };
          for (const fname of comp.headerFieldNames) {
            const f = ent.fields.find((ff) => ff.name === fname);
            if (!f) continue;
            if (f.type === "fk") {
              const idCol = f.name.replace(/Code$/, "Id");
              const v = head[idCol];
              if (v == null) continue;
              const validSet = fkValidIds[idCol];
              if (validSet && !validSet.has(Number(v))) continue; // strip cross-tenant ids
              headerPayload[idCol] = v;
            } else {
              const v = head[fname];
              if (v == null) continue;
              headerPayload[fname] = v;
            }
          }
          // Required header fields check.
          for (const fname of comp.headerFieldNames) {
            const f = ent.fields.find((ff) => ff.name === fname);
            if (!f?.required) continue;
            const v = headerPayload[fname];
            if (v == null || (typeof v === "string" && v.trim() === "")) {
              throw new Error(`حقل مطلوب ناقص في رأس القيد: ${f.labelAr}`);
            }
          }

          // Domain guard: block creating new entries with a locked entryType.
          if (isJournalEntries && headerPayload.entryType && LOCKED_JE_TYPES.has(String(headerPayload.entryType))) {
            throw new Error(
              `لا يمكن إنشاء أو تعديل قيد من نوع "${headerPayload.entryType}" عبر مركز الاستيراد — هذه القيود تُولَّد تلقائياً من المستندات المصدر.`
            );
          }

          // ── 2. Build lines.
          const linesPayload: any[] = [];
          let totalDebit = 0, totalCredit = 0;
          for (const r of g.rows) {
            const line: any = {};
            for (const fname of comp.lineFieldNames) {
              const f = ent.fields.find((ff) => ff.name === fname);
              if (!f) continue;
              const col = LINE_FIELD_TO_COL[fname] ?? fname;
              if (f.type === "fk") {
                const idCol = f.name.replace(/Code$/, "Id");
                const v = r[idCol];
                if (v == null) continue;
                const validSet = fkValidIds[idCol];
                if (validSet && !validSet.has(Number(v))) continue;
                line[idCol] = v;
              } else {
                const v = r[fname];
                if (v == null) continue;
                line[col] = v;
              }
            }
            // Required line field check (e.g. accountCode → accountId must resolve)
            for (const fname of comp.lineFieldNames) {
              const f = ent.fields.find((ff) => ff.name === fname);
              if (!f?.required) continue;
              if (f.type === "fk") {
                const idCol = f.name.replace(/Code$/, "Id");
                if (line[idCol] == null) {
                  throw new Error(`حقل مطلوب ناقص في السطر: ${f.labelAr}`);
                }
              } else {
                const col = LINE_FIELD_TO_COL[fname] ?? fname;
                const v = line[col];
                if (v == null || (typeof v === "string" && v.trim() === "")) {
                  throw new Error(`حقل مطلوب ناقص في السطر: ${f.labelAr}`);
                }
              }
            }
            totalDebit  += Number(line.debit  ?? 0);
            totalCredit += Number(line.credit ?? 0);
            linesPayload.push(line);
          }

          if (linesPayload.length === 0) {
            throw new Error(`لا توجد سطور للقيد ${g.key}`);
          }
          if (comp.validateBalanced) {
            if (Math.abs(totalDebit - totalCredit) > 0.01) {
              throw new Error(`القيد ${g.key} غير متوازن: مدين=${totalDebit.toFixed(2)} ≠ دائن=${totalCredit.toFixed(2)}`);
            }
          }

          // Domain guard: ensure every account on a line is a leaf, postable,
          // tenant-owned account (parity with routes/journalEntries.ts CREATE/UPDATE).
          if (isJournalEntries) {
            const accountIds = linesPayload.map((l) => l.accountId).filter((v) => v != null);
            if (accountIds.length > 0) {
              await ensureLeafAccounts(cid, accountIds);
            }
          }

          // ── 3. Upsert header (by groupKey) and (re)insert lines.
          const existingId = existingByKey.get(`${groupKey}:${g.key}`);
          let headerId: number;
          if (existingId != null) {
            // Domain guard: locked existing entry can never be updated.
            if (isJournalEntries) {
              const t = existingEntryTypes.get(existingId);
              if (t && LOCKED_JE_TYPES.has(t)) {
                throw new Error(
                  `القيد ${g.key} مولّد تلقائياً من مستند مصدر (${t}) ولا يمكن تعديله عبر الاستيراد.`
                );
              }
            }
            const upd = await tx.update(ent.table)
              .set(headerPayload)
              .where(and(eq(ent.table.id, existingId), eq(ent.table.companyId, cid)))
              .returning({ id: ent.table.id });
            if (upd.length === 0) throw new Error("القيد غير موجود ضمن نطاق الشركة");
            headerId = (upd[0] as any).id;
            // wipe old lines so they don't accumulate
            await tx.delete(comp.linesTable).where(eq((comp.linesTable as any)[comp.lineFkCol], headerId));
            for (const idx of rowIndices) {
              counters.updated++;
              log.push({ rowIndex: idx, status: "updated", id: headerId });
            }
          } else {
            const ins = await tx.insert(ent.table).values(headerPayload).returning({ id: ent.table.id });
            headerId = (ins[0] as any).id;
            existingByKey.set(`${groupKey}:${g.key}`, headerId);
            if (isJournalEntries) existingEntryTypes.set(headerId, headerPayload.entryType ?? null);
            for (const idx of rowIndices) {
              counters.inserted++;
              log.push({ rowIndex: idx, status: "inserted", id: headerId });
            }
          }

          // attach FK back-pointer + sortOrder, then bulk insert
          const linesWithFk = linesPayload.map((l, i) => ({ ...l, [comp.lineFkCol]: headerId, sortOrder: i }));
          await tx.insert(comp.linesTable).values(linesWithFk);
        });
      } catch (e: any) {
        const msg = e?.message?.slice(0, 200) ?? "خطأ غير معروف";
        if (skipErrors) {
          // The savepoint rolls back automatically when the inner tx throws,
          // so there is no partial state for this group. We just log + continue.
          // Roll back any speculative bookkeeping we did before the throw:
          if (existingByKey.get(`${groupKey}:${g.key}`) === undefined) {
            // nothing to undo (insert path didn't get to set the map)
          }
          for (const idx of rowIndices) {
            counters.skipped++;
            log.push({ rowIndex: idx, status: "skipped", reason: msg });
          }
        } else {
          for (const idx of rowIndices) {
            counters.errors++;
            log.push({ rowIndex: idx, status: "error", reason: msg });
          }
          const tagged: any = new Error(msg);
          tagged.__strictTxFailure = true;
          tagged.__counters = counters;
          tagged.__log = log;
          throw tagged;
        }
      }
    }
  });

  return { log, counters };
}

// POST /import/commit — transactional upsert
// body: { entity, rows: <processed rows from /process>, options: { skipErrors, useSystemNumbering } }
// ─────────────────────────────────────────────────────────────────────────────

router.post("/import/commit", async (req, res) => {
  // Hoisted so the outer `catch` can include them in the strict-mode 422 payload.
  const log: Array<{ rowIndex: number; status: "inserted" | "updated" | "skipped" | "error"; id?: number; reason?: string }> = [];
  let inserted = 0, updated = 0, skipped = 0, errors = 0;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

  try {
    const cid = resolveCompanyId(req, req.body?.companyId ? Number(req.body.companyId) : undefined);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const entityKey = String(req.body?.entity ?? "");
    const ent = ENTITIES[entityKey];
    if (!ent) { res.status(400).json({ error: "نوع البيانات غير معروف" }); return; }
    const skipErrors = req.body?.options?.skipErrors !== false; // default true

    // ── Composite entities have a totally different commit shape (group rows by
    // groupKey, then insert header + lines transactionally). Branch out early.
    if (ent.composite) {
      await commitComposite({ ent, rows, cid, skipErrors, log, counters: { inserted: 0, updated: 0, skipped: 0, errors: 0 } })
        .then((result) => {
          res.json({
            entity: ent.key,
            summary: { ...result.counters, total: rows.length },
            log: result.log,
            committedAt: new Date().toISOString(),
          });
        })
        .catch((e: any) => {
          if (e?.__strictTxFailure) {
            res.status(422).json({
              entity: ent.key,
              summary: { inserted: 0, updated: 0, skipped: 0, errors: e.__counters?.errors ?? 1, total: rows.length },
              log: e.__log ?? log,
              aborted: true,
              reason: "strict_mode_tx_failed",
              error: e?.message?.slice(0, 200) ?? "فشل التنفيذ ضمن الوضع الصارم",
            });
          } else {
            res.status(500).json({ error: e?.message ?? "فشل التنفيذ" });
          }
        });
      return;
    }

    // Validate required fields server-side too. In strict mode (skipErrors=false),
    // any missing required field aborts the entire commit *before* opening a transaction.
    const validRows: Array<{ row: any; idx: number }> = [];
    for (const r of rows) {
      const idx = r.__rowIndex ?? -1;
      const missing = ent.fields.find((f) => f.required && (r[f.name] == null || (typeof r[f.name] === "string" && r[f.name].trim() === "")));
      if (missing) {
        if (skipErrors) {
          skipped++;
          log.push({ rowIndex: idx, status: "skipped", reason: `حقل مطلوب ناقص: ${missing.labelAr}` });
          continue;
        } else {
          // Strict mode: abort the whole commit, return 422 with the row log so the user can fix and retry.
          errors++;
          log.push({ rowIndex: idx, status: "error", reason: `حقل مطلوب ناقص: ${missing.labelAr}` });
          res.status(422).json({
            entity: ent.key,
            summary: { inserted: 0, updated: 0, skipped: 0, errors, total: rows.length },
            log,
            aborted: true,
            reason: "strict_mode_validation_failed",
          });
          return;
        }
      }
      validRows.push({ row: r, idx });
    }

    // SECURITY: re-resolve "is this a duplicate?" server-side by business key + companyId
    // (never trust the client-supplied __existingId — it could point to another tenant).
    const existingByKey = new Map<string, number>();
    if (ent.businessKeys.length > 0) {
      const existing = ent.hasCompanyId
        ? await db.select().from(ent.table).where(eq(ent.table.companyId, cid))
        : await db.select().from(ent.table);
      for (const ex of existing) {
        for (const k of ent.businessKeys) {
          const v = (ex as any)[k];
          if (v != null && String(v).trim() !== "") {
            existingByKey.set(`${k}:${String(v).trim()}`, (ex as any).id);
            break;
          }
        }
      }
    }

    // Strip helper keys + non-schema keys before insert
    const allowedCols = new Set(ent.fields.map((f) => f.name));
    // also include FK id columns derived from fk fields (e.g. parentId from parentCode)
    const fkIdCols: Record<string, string> = {}; // idCol → fkCodeFieldName
    for (const f of ent.fields) {
      if (f.type === "fk") {
        const idCol = f.name.replace(/Code$/, "Id");
        allowedCols.add(idCol);
        fkIdCols[idCol] = f.name;
      }
    }

    // SECURITY: pre-load the tenant-scoped FK valid-id sets so we can validate
    // any client-supplied *Id values and reject cross-tenant id smuggling
    // (e.g., a forged payload with parentId or currencyId pointing at another company's row).
    const fkValidIds: Record<string, Set<number>> = {};
    for (const f of ent.fields) {
      if (f.type !== "fk" || !f.fkRef) continue;
      const refEnt = ENTITIES[f.fkRef];
      if (!refEnt) continue;
      const rows = refEnt.hasCompanyId
        ? await db.select({ id: refEnt.table.id }).from(refEnt.table).where(eq(refEnt.table.companyId, cid))
        : await db.select({ id: refEnt.table.id }).from(refEnt.table);
      fkValidIds[f.name.replace(/Code$/, "Id")] = new Set(rows.map((r) => (r as any).id as number));
    }

    function cleanRow(r: any): { row: any; warnings: string[] } {
      const out: any = {};
      const warnings: string[] = [];
      for (const k of Object.keys(r)) {
        if (k.startsWith("__")) continue;
        if (!allowedCols.has(k)) continue;

        // Virtual fk-code fields are NEVER persisted — they're translated to *Id columns instead.
        const f = ent.fields.find((ff) => ff.name === k);
        if (f?.type === "fk") continue;

        // For FK id columns (e.g., parentId, currencyId), enforce that the value is
        // among the tenant's valid ids. Strip + warn on any cross-tenant/foreign id.
        if (k in fkIdCols) {
          const v = r[k];
          if (v == null) continue;
          const validSet = fkValidIds[k];
          if (validSet && !validSet.has(Number(v))) {
            warnings.push(`تم تجاهل قيمة ${k}=${v} (لا تعود لشركتك)`);
            continue;
          }
        }
        out[k] = r[k];
      }
      // Server-controlled fields — clients cannot override these.
      if (ent.hasCompanyId) out.companyId = cid;
      return { row: out, warnings };
    }

    await db.transaction(async (tx) => {
      // Process in chunks of 200 to avoid huge single statements
      const CHUNK = 200;
      for (let i = 0; i < validRows.length; i += CHUNK) {
        const slice = validRows.slice(i, i + CHUNK);
        for (const { row, idx } of slice) {
          try {
            const { row: cleaned, warnings } = cleanRow(row);
            // SECURITY: re-derive existingId from server-side businessKey lookup,
            // *not* from row.__existingId (which the client could spoof to point at
            // another tenant's row).
            let serverExistingId: number | null = null;
            for (const k of ent.businessKeys) {
              const v = cleaned[k];
              if (v != null && String(v).trim() !== "") {
                const id = existingByKey.get(`${k}:${String(v).trim()}`);
                if (id != null) { serverExistingId = id; break; }
              }
            }

            const reasonSuffix = warnings.length > 0 ? ` | ${warnings.join("؛ ")}` : "";

            if (serverExistingId != null) {
              // Update is *additionally* guarded by companyId so we can never cross-update.
              const whereClause = ent.hasCompanyId
                ? and(eq(ent.table.id, serverExistingId), eq(ent.table.companyId, cid))
                : eq(ent.table.id, serverExistingId);
              const upd = await tx.update(ent.table).set(cleaned).where(whereClause).returning({ id: ent.table.id });
              if (upd.length === 0) {
                // Row vanished or belongs to another tenant — treat as skip rather than silently inserting.
                skipped++;
                log.push({ rowIndex: idx, status: "skipped", reason: "السجل غير موجود ضمن نطاق الشركة" });
              } else {
                updated++;
                log.push({ rowIndex: idx, status: "updated", id: serverExistingId, ...(warnings.length ? { reason: `تم التحديث${reasonSuffix}` } : {}) });
              }
            } else {
              const out = await tx.insert(ent.table).values(cleaned).returning({ id: ent.table.id });
              const newId = (out[0] as any)?.id;
              inserted++;
              log.push({ rowIndex: idx, status: "inserted", id: newId, ...(warnings.length ? { reason: `تم الإدراج${reasonSuffix}` } : {}) });
              // keep the in-memory map current so duplicates within the same batch
              // upsert correctly instead of inserting twice.
              for (const k of ent.businessKeys) {
                const v = cleaned[k];
                if (v != null && String(v).trim() !== "" && newId != null) {
                  existingByKey.set(`${k}:${String(v).trim()}`, newId);
                  break;
                }
              }
            }
          } catch (e: any) {
            if (skipErrors) {
              skipped++;
              log.push({ rowIndex: idx, status: "skipped", reason: e?.message?.slice(0, 200) ?? "خطأ غير معروف" });
            } else {
              errors++;
              log.push({ rowIndex: idx, status: "error", reason: e?.message?.slice(0, 200) ?? "خطأ غير معروف" });
              // Tag the error so the outer catch can return a structured 422
              // (strict-mode tx-time DB failure) instead of an opaque 500.
              const tagged: any = new Error(e?.message ?? "tx_failed");
              tagged.__strictTxFailure = true;
              throw tagged;
            }
          }
        }
      }
    });

    res.json({
      entity: ent.key,
      summary: { inserted, updated, skipped, errors, total: rows.length },
      log,
      committedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e?.__strictTxFailure) {
      return res.status(422).json({
        entity: req.body?.entity,
        summary: { inserted: 0, updated: 0, skipped: 0, errors, total: rows?.length ?? 0 },
        log,
        aborted: true,
        reason: "strict_mode_tx_failed",
        error: e?.message?.slice(0, 200) ?? "فشل التنفيذ ضمن الوضع الصارم",
      });
    }
    res.status(500).json({ error: e?.message ?? "فشل التنفيذ" });
  }
});

export default router;
