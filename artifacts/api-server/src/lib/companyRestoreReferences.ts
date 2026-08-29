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
  | "region"
  | "customer_group"
  | "supplier_group"
  | "sales_rep"
  | "brand"
  | "camera"
  | "department"
  | "production_line"
  | "work_center"
  | "fiscal_year"
  | "pos_session"
  | "pos_terminal"
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
    | "unsupported_reference"
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

const EXACT_REFERENCE_TABLES: Record<string, { domain: RestoreReferenceDomain; table: string }> = {
  "asset_custodies.asset_id": { domain: "document", table: "fixed_assets" },
  "delivery_receipt_documents.invoice_id": { domain: "document", table: "sales_invoices" },
  "delivery_receipt_documents.party_id": { domain: "customer", table: "customers" },
  "employee_attendance.camera_in_id": { domain: "camera", table: "attendance_cameras" },
  "employee_attendance.camera_out_id": { domain: "camera", table: "attendance_cameras" },
  "employee_contracts.renewed_from_id": { domain: "document", table: "employee_contracts" },
  "employee_contracts.shift_id": { domain: "document", table: "employee_shifts" },
  "employee_violations.payroll_run_id": { domain: "document", table: "payroll_runs" },
  "fixed_assets.source_document_id": { domain: "document", table: "purchase_invoices" },
  "fixed_assets.source_line_id": { domain: "document", table: "purchase_invoice_lines" },
  "goods_deliveries.created_by_id": { domain: "user", table: "users" },
  "goods_deliveries.posted_by_id": { domain: "user", table: "users" },
  "goods_receipts.created_by_id": { domain: "user", table: "users" },
  "goods_receipts.posted_by_id": { domain: "user", table: "users" },
  "journal_entries.sales_invoice_id": { domain: "document", table: "sales_invoices" },
  "journal_entries.purchase_invoice_id": { domain: "document", table: "purchase_invoices" },
  "maintenance_orders.field_ticket_id": { domain: "document", table: "field_service_tickets" },
  "payment_voucher_lines.deferred_adjustment_id": { domain: "document", table: "accounting_adjustments" },
  "payment_voucher_lines.op_ref_id": { domain: "document", table: "accounting_adjustments" },
  "payroll_runs.posted_journal_id": { domain: "journal_entry", table: "journal_entries" },
  "payroll_runs.payment_journal_id": { domain: "journal_entry", table: "journal_entries" },
  "production_downtime_events.production_order_id": { domain: "document", table: "production_orders" },
  "purchase_invoices.source_grn_id": { domain: "document", table: "goods_receipts" },
  "sales_invoices.source_gdn_id": { domain: "document", table: "goods_deliveries" },
  "stock_adjustments.correction_of_id": { domain: "document", table: "stock_adjustments" },
  "surveillance_devices.parent_device_id": { domain: "document", table: "surveillance_devices" },
};

const IGNORED_IDENTIFIER_COLUMNS = new Set([
  "companies.home_domain_id",
  "companies.demo_parent_company_id",
  "companies.zatca_compliance_request_id",
  "companies.zatca_transfer_id",
  "users.session_id",
  "users.current_session_id",
]);

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
  const extended: Array<[RegExp, RestoreReferenceDomain, string]> = [
    [/(?:^|_)region_id$/, "region", "regions"],
    [/(?:^|_)customer_group_id$/, "customer_group", "customer_groups"],
    [/(?:^|_)supplier_group_id$/, "supplier_group", "supplier_groups"],
    [/(?:^|_)sales_rep_id$/, "sales_rep", "sales_reps"],
    [/(?:^|_)brand_id$/, "brand", "brands"],
    [/(?:^|_)camera_id$/, "camera", "attendance_cameras"],
    [/(?:^|_)department_id$/, "department", "hr_departments"],
    [/(?:^|_)production_line_id$/, "production_line", "production_lines"],
    [/(?:^|_)work_center_id$/, "work_center", "work_centers"],
    [/(?:^|_)fiscal_year_id$/, "fiscal_year", "fiscal_years"],
    [/(?:^|_)pos_session_id$/, "pos_session", "pos_sessions"],
    [/(?:^|_)pos_terminal_id$/, "pos_terminal", "pos_terminals"],
  ];
  for (const [pattern, domain, referencedTable] of extended) {
    if (pattern.test(column)) return { domain, referencedTable, shape: "scalar" };
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
): RestoreReferenceRule | "unsupported-document" | "unsupported-reference" | null {
  if (column === "id" || column === "company_id") return null;
  const exactKey = `${table}.${column}`;
  if (IGNORED_IDENTIFIER_COLUMNS.has(exactKey)) return null;
  const exact = EXACT_REFERENCE_TABLES[exactKey];
  if (exact) return { domain: exact.domain, referencedTable: exact.table, shape: "scalar" };
  if (column === "parent_id") {
    return { domain: "document", referencedTable: table, shape: "scalar" };
  }
  if (table === "approval_log" && column === "document_id") {
    const documentType = String(row.document_type ?? "").trim().toLowerCase();
    const referencedTable = DOCUMENT_TABLES[documentType];
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-document";
  }
  const known = arrayRule(column) ?? scalarRule(column);
  if (known) return known;
  const value = row[column];
  const numericScalar = typeof value === "number" && Number.isFinite(value);
  const numericArray = Array.isArray(value)
    && value.some((entry) => typeof entry === "number" && Number.isFinite(entry));
  if ((numericScalar && /(?:^|_)id$/.test(column)) || (numericArray && /_ids$/.test(column))) {
    return "unsupported-reference";
  }
  return null;
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
      if (rule === "unsupported-reference") {
        issues.push({
          severity: "error",
          code: "unsupported_reference",
          table: tableName,
          column,
          rowId,
          sourceValue,
          message: `المرجع المنطقي ${tableName}.${column} غير مسجل للاستعادة الآمنة`,
        });
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