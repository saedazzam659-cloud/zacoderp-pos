import type { BackupTable, FullCompanyPayload } from "./fullCompanyBackup.js";

export type RestoreReferenceShape = "scalar" | "array";
export type RestoreReferenceDomain =
  | "account"
  | "branch"
  | "period"
  | "cost_center"
  | "customer"
  | "supplier"
  | "employee"
  | "item"
  | "warehouse"
  | "cash_box"
  | "bank_account"
  | "user"
  | "unit"
  | "tax"
  | "journal_entry"
  | "document";

export type RestoreReferenceRule = {
  domain: RestoreReferenceDomain;
  referencedTable: string;
  shape: RestoreReferenceShape;
  allowZero?: boolean;
};

export type RestoreReferenceIssue = {
  severity: "error" | "warning";
  code:
    | "missing_reference_table"
    | "missing_reference_row"
    | "ambiguous_reference_row"
    | "unsupported_document_type"
    | "missing_primary_key";
  table: string;
  column: string;
  rowId: unknown;
  sourceValue: unknown;
  referencedTable?: string;
  message: string;
};

export type PlannedRestoreReference = {
  table: string;
  column: string;
  rowId: unknown;
  sourceValue: unknown;
  rule: RestoreReferenceRule;
};

export type RestoreReferencePlan = {
  references: PlannedRestoreReference[];
  issues: RestoreReferenceIssue[];
  checked: number;
  physicalForeignKeysSkipped: number;
};

const DOCUMENT_TABLES: Record<string, string> = {
  sales_invoice: "sales_invoices",
  sales_invoices: "sales_invoices",
  purchase_invoice: "purchase_invoices",
  purchase_invoices: "purchase_invoices",
  sales_return: "sales_returns",
  sales_returns: "sales_returns",
  purchase_return: "purchase_returns",
  purchase_returns: "purchase_returns",
  sales_order: "sales_orders",
  sales_orders: "sales_orders",
  purchase_order: "purchase_orders",
  purchase_orders: "purchase_orders",
  sales_quotation: "sales_quotations",
  sales_quotations: "sales_quotations",
  journal_entry: "journal_entries",
  journal_entries: "journal_entries",
  payment_voucher: "payment_vouchers",
  payment_vouchers: "payment_vouchers",
  receipt_voucher: "receipt_vouchers",
  receipt_vouchers: "receipt_vouchers",
  inventory_adjustment: "inventory_adjustments",
  inventory_adjustments: "inventory_adjustments",
};

function key(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return `n:${value}`;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return `n:${Number(trimmed)}`;
    return `s:${trimmed}`;
  }
  return `j:${JSON.stringify(value)}`;
}

function scalarRule(column: string): RestoreReferenceRule | null {
  if (column === "company_id" || column === "document_id") return null;
  if (/(?:^|_)bank_account_id$/.test(column)) {
    return { domain: "bank_account", referencedTable: "bank_accounts", shape: "scalar" };
  }
  if (/(?:^|_)(?:cash_box|cashbox)_id$/.test(column)) {
    return { domain: "cash_box", referencedTable: "cash_boxes", shape: "scalar" };
  }
  if (/(?:^|_)cost_center_id$/.test(column)) {
    return { domain: "cost_center", referencedTable: "cost_centers", shape: "scalar" };
  }
  if (/(?:^|_)(?:fiscal_)?period_id$/.test(column)) {
    return { domain: "period", referencedTable: "fiscal_periods", shape: "scalar" };
  }
  if (/(?:^|_)branch_id$/.test(column)) {
    return { domain: "branch", referencedTable: "branches", shape: "scalar", allowZero: true };
  }
  if (/(?:^|_)warehouse_id$/.test(column)) {
    return { domain: "warehouse", referencedTable: "warehouses", shape: "scalar" };
  }
  if (/(?:^|_)item_id$/.test(column)) {
    return { domain: "item", referencedTable: "items", shape: "scalar" };
  }
  if (/(?:^|_)customer_id$/.test(column)) {
    return { domain: "customer", referencedTable: "customers", shape: "scalar" };
  }
  if (/(?:^|_)supplier_id$/.test(column)) {
    return { domain: "supplier", referencedTable: "suppliers", shape: "scalar" };
  }
  if (/(?:^|_)employee_id$/.test(column)) {
    return { domain: "employee", referencedTable: "employees", shape: "scalar" };
  }
  if (/(?:^|_)user_id$/.test(column)) {
    return { domain: "user", referencedTable: "users", shape: "scalar" };
  }
  if (/(?:^|_)unit_id$/.test(column)) {
    return { domain: "unit", referencedTable: "units", shape: "scalar" };
  }
  if (/(?:^|_)tax_id$/.test(column)) {
    return { domain: "tax", referencedTable: "taxes", shape: "scalar" };
  }
  if (/(?:^|_)journal_entry_id$/.test(column)) {
    return { domain: "journal_entry", referencedTable: "journal_entries", shape: "scalar" };
  }
  if (/(?:^|_)account_id$/.test(column)) {
    return { domain: "account", referencedTable: "accounts", shape: "scalar" };
  }
  return null;
}

function arrayRule(column: string): RestoreReferenceRule | null {
  if (column === "branch_ids") {
    return { domain: "branch", referencedTable: "branches", shape: "array", allowZero: true };
  }
  if (column === "fiscal_period_ids") {
    return { domain: "period", referencedTable: "fiscal_periods", shape: "array" };
  }
  if (column === "target_user_ids" || column === "user_ids") {
    return { domain: "user", referencedTable: "users", shape: "array" };
  }
  return null;
}

export function resolveRestoreReferenceRule(
  table: string,
  column: string,
  row: Record<string, unknown>,
): RestoreReferenceRule | "unsupported-document" | null {
  if (table === "approval_log" && column === "document_id") {
    const documentType = String(row.document_type ?? "").trim().toLowerCase();
    const referencedTable = DOCUMENT_TABLES[documentType];
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-document";
  }
  return arrayRule(column) ?? scalarRule(column);
}

function sourceIndexes(
  payload: FullCompanyPayload,
  tables: Record<string, BackupTable>,
): Map<string, Map<string, number>> {
  const indexes = new Map<string, Map<string, number>>();
  for (const [tableName, table] of Object.entries(tables)) {
    if (!table.primaryKey) continue;
    const index = new Map<string, number>();
    for (const row of payload.data[tableName] ?? []) {
      const sourceId = row[table.primaryKey];
      if (sourceId == null) continue;
      const normalized = key(sourceId);
      index.set(normalized, (index.get(normalized) ?? 0) + 1);
    }
    indexes.set(tableName, index);
  }
  return indexes;
}

function isPhysicalForeignKey(table: BackupTable | undefined, column: string): boolean {
  return !!table?.foreignKeys.some((foreignKey) => foreignKey.column === column);
}

/**
 * Builds the complete soft-reference plan before the target tenant is touched.
 * A non-null logical reference is always strict: missing or ambiguous source
 * rows abort restore instead of being silently nulled or trusted by number.
 */
export function buildRestoreReferencePlan(
  payload: FullCompanyPayload,
  tables: Record<string, BackupTable>,
): RestoreReferencePlan {
  const references: PlannedRestoreReference[] = [];
  const issues: RestoreReferenceIssue[] = [];
  const indexes = sourceIndexes(payload, tables);
  let checked = 0;
  let physicalForeignKeysSkipped = 0;

  const inspect = (
    tableName: string,
    table: BackupTable | undefined,
    row: Record<string, unknown>,
    rowId: unknown,
  ) => {
    for (const [column, sourceValue] of Object.entries(row)) {
      if (sourceValue == null) continue;
      const rule = resolveRestoreReferenceRule(tableName, column, row);
      if (!rule) continue;
      if (isPhysicalForeignKey(table, column)) {
        physicalForeignKeysSkipped++;
        continue;
      }
      if (rule === "unsupported-document") {
        issues.push({
          severity: "error",
          code: "unsupported_document_type",
          table: tableName,
          column,
          rowId,
          sourceValue,
          message: `نوع المستند ${String(row.document_type ?? "") || "غير المحدد"} غير مسجل لإعادة ربط ${tableName}.${column}`,
        });
        continue;
      }
      checked++;
      const referenced = tables[rule.referencedTable];
      if (!referenced) {
        issues.push({
          severity: "error",
          code: "missing_reference_table",
          table: tableName,
          column,
          rowId,
          sourceValue,
          referencedTable: rule.referencedTable,
          message: `الجدول المرجعي ${rule.referencedTable} غير موجود في النسخة`,
        });
        continue;
      }
      if (!referenced.primaryKey) {
        issues.push({
          severity: "error",
          code: "missing_primary_key",
          table: tableName,
          column,
          rowId,
          sourceValue,
          referencedTable: rule.referencedTable,
          message: `لا يمكن إعادة ربط ${tableName}.${column} لأن ${rule.referencedTable} بلا مفتاح أساسي مفرد`,
        });
        continue;
      }
      const values = rule.shape === "array" ? sourceValue : [sourceValue];
      if (!Array.isArray(values)) {
        issues.push({
          severity: "error",
          code: "missing_reference_row",
          table: tableName,
          column,
          rowId,
          sourceValue,
          referencedTable: rule.referencedTable,
          message: `القيمة ${tableName}.${column} ليست مصفوفة معرفات صالحة`,
        });
        continue;
      }
      let valid = true;
      for (const value of values) {
        if (value == null || (rule.allowZero && Number(value) === 0)) continue;
        const count = indexes.get(rule.referencedTable)?.get(key(value)) ?? 0;
        if (count === 0) {
          valid = false;
          issues.push({
            severity: "error",
            code: "missing_reference_row",
            table: tableName,
            column,
            rowId,
            sourceValue: value,
            referencedTable: rule.referencedTable,
            message: `المرجع ${String(value)} في ${tableName}.${column} لا يطابق صفًا داخل ${rule.referencedTable}`,
          });
        } else if (count > 1) {
          valid = false;
          issues.push({
            severity: "error",
            code: "ambiguous_reference_row",
            table: tableName,
            column,
            rowId,
            sourceValue: value,
            referencedTable: rule.referencedTable,
            message: `المرجع ${String(value)} في ${tableName}.${column} ملتبس داخل ${rule.referencedTable}`,
          });
        }
      }
      if (valid) references.push({ table: tableName, column, rowId, sourceValue, rule });
    }
  };

  for (const [tableName, table] of Object.entries(tables)) {
    for (const row of payload.data[tableName] ?? []) {
      if (!table.primaryKey) {
        const hasLogicalReference = Object.entries(row).some(([column, value]) =>
          value != null
          && !isPhysicalForeignKey(table, column)
          && resolveRestoreReferenceRule(tableName, column, row) != null);
        if (hasLogicalReference) {
          issues.push({
            severity: "error",
            code: "missing_primary_key",
            table: tableName,
            column: "*",
            rowId: null,
            sourceValue: null,
            message: `لا يمكن إعادة ربط مراجع ${tableName} لأن الجدول بلا مفتاح أساسي مفرد`,
          });
          continue;
        }
      }
      inspect(tableName, table, row, table.primaryKey ? row[table.primaryKey] : null);
    }
  }
  if (payload.companySettings) inspect("companies", undefined, payload.companySettings, payload.meta.companyId);

  return { references, issues, checked, physicalForeignKeysSkipped };
}

export function restoreReferenceKey(value: unknown): string {
  return key(value);
}