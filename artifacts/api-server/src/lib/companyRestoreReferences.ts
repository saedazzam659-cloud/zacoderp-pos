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
  sourceMissing?: boolean;
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
  stock_adjustment: "stock_adjustments",
  stock_adjustments: "stock_adjustments",
  adjustment: "stock_adjustments",
  stock_count: "stock_counts",
  stock_counts: "stock_counts",
  count: "stock_counts",
  stock_transfer: "stock_transfers",
  stock_transfers: "stock_transfers",
  transfer: "stock_transfers",
  goods_receipt: "goods_receipts",
  goods_receipts: "goods_receipts",
  goods_delivery: "goods_deliveries",
  goods_deliveries: "goods_deliveries",
  production_order: "production_orders",
  production_order_cancel: "production_orders",
  production_orders: "production_orders",
  sister_transfer: "sister_transfers",
  sister_transfers: "sister_transfers",
  sister_return: "sister_returns",
  sister_returns: "sister_returns",
  account_note: "account_notes",
  account_notes: "account_notes",
};

const EXACT_REFERENCE_TABLES: Record<string, { domain: RestoreReferenceDomain; table: string }> = {
  "asset_custodies.asset_id": { domain: "document", table: "fixed_assets" },
  "accounting_adjustments.parent_adjustment_id": { domain: "document", table: "accounting_adjustments" },
  "attendance_movements.exit_permission_id": { domain: "document", table: "exit_permissions" },
  "chat_messages.reply_to_id": { domain: "document", table: "chat_messages" },
  "chat_participants.last_read_message_id": { domain: "document", table: "chat_messages" },
  "crm_leads.campaign_id": { domain: "document", table: "crm_campaigns" },
  "delivery_receipt_documents.invoice_id": { domain: "document", table: "sales_invoices" },
  "delivery_receipt_documents.party_id": { domain: "customer", table: "customers" },
  "employee_attendance.camera_in_id": { domain: "camera", table: "attendance_cameras" },
  "employee_attendance.camera_out_id": { domain: "camera", table: "attendance_cameras" },
  "employee_contracts.renewed_from_id": { domain: "document", table: "employee_contracts" },
  "employee_contracts.shift_id": { domain: "document", table: "employee_shifts" },
  "employee_violations.payroll_run_id": { domain: "document", table: "payroll_runs" },
  "exit_permissions.approver_id": { domain: "user", table: "users" },
  "face_recognition_logs.attendance_id": { domain: "document", table: "employee_attendance" },
  "fixed_assets.source_document_id": { domain: "document", table: "purchase_invoices" },
  "fixed_assets.source_line_id": { domain: "document", table: "purchase_invoice_lines" },
  "field_locations.asset_id": { domain: "document", table: "fixed_assets" },
  "field_service_tickets.asset_id": { domain: "document", table: "fixed_assets" },
  "field_visits.asset_id": { domain: "document", table: "fixed_assets" },
  "field_visits.ticket_id": { domain: "document", table: "field_service_tickets" },
  "inbox_messages.notification_id": { domain: "document", table: "notifications" },
  "journal_entries.sales_invoice_id": { domain: "document", table: "sales_invoices" },
  "journal_entries.purchase_invoice_id": { domain: "document", table: "purchase_invoices" },
  "maintenance_orders.field_ticket_id": { domain: "document", table: "field_service_tickets" },
  "payment_voucher_lines.deferred_adjustment_id": { domain: "document", table: "accounting_adjustments" },
  "payment_voucher_lines.op_ref_id": { domain: "document", table: "accounting_adjustments" },
  "purchase_invoice_lines.deferred_adjustment_id": { domain: "document", table: "accounting_adjustments" },
  "payroll_runs.posted_journal_id": { domain: "journal_entry", table: "journal_entries" },
  "payroll_runs.payment_journal_id": { domain: "journal_entry", table: "journal_entries" },
  "production_downtime_events.production_order_id": { domain: "document", table: "production_orders" },
  "pos_orders.billed_invoice_id": { domain: "document", table: "sales_invoices" },
  "pos_orders.table_id": { domain: "document", table: "pos_tables" },
  "pos_orders.waiter_id": { domain: "user", table: "users" },
  "pos_tables.current_order_id": { domain: "document", table: "pos_orders" },
  "payment_vouchers.session_id": { domain: "pos_session", table: "pos_sessions" },
  "purchase_invoices.source_grn_id": { domain: "document", table: "goods_receipts" },
  "receipt_vouchers.session_id": { domain: "pos_session", table: "pos_sessions" },
  "sales_invoices.session_id": { domain: "pos_session", table: "pos_sessions" },
  "sales_invoices.source_gdn_id": { domain: "document", table: "goods_deliveries" },
  "sales_returns.session_id": { domain: "pos_session", table: "pos_sessions" },
  "sequence_counters.sequence_id": { domain: "document", table: "sequences" },
  "sequence_logs.sequence_id": { domain: "document", table: "sequences" },
  "settlement_links.purchase_invoice_id": { domain: "document", table: "purchase_invoices" },
  "settlement_links.sales_invoice_id": { domain: "document", table: "sales_invoices" },
  "stock_adjustments.correction_of_id": { domain: "document", table: "stock_adjustments" },
  "suppliers.group_id": { domain: "supplier_group", table: "supplier_groups" },
  "surveillance_devices.parent_device_id": { domain: "document", table: "surveillance_devices" },
  "training_attendance.session_id": { domain: "document", table: "training_sessions" },
  "trial_balances.source_trial_balance_id": { domain: "document", table: "trial_balances" },
  "user_invoice_field_policies.profile_id": { domain: "document", table: "invoice_field_policy_profiles" },
  "user_visits.zone_id": { domain: "document", table: "tracking_zones" },
  "voice_command_log.work_session_id": { domain: "document", table: "work_sessions" },
};

const ATTENDANCE_AUDIT_ENTITY_TABLES: Record<string, string> = {
  shift: "attendance_shifts",
  movement: "attendance_movements",
  permission: "exit_permissions",
  attendance: "employee_attendance",
  day_lock: "attendance_day_locks",
  payroll_transfer: "attendance_payroll_transfers",
};

const EMPLOYEE_HISTORY_REFERENCE_TABLES: Record<string, string> = {
  evaluations: "employee_evaluations",
  employee_evaluations: "employee_evaluations",
  employee_salary_adjustments: "employee_salary_adjustments",
  employee_transfers: "employee_transfers",
  employee_terminations: "employee_terminations",
};

const IGNORED_IDENTIFIER_COLUMNS = new Set([
  "companies.home_domain_id",
  "companies.demo_parent_company_id",
  "companies.zatca_compliance_request_id",
  "companies.zatca_transfer_id",
  "users.session_id",
  "users.current_session_id",
  // Tombstone row IDs point to records which were intentionally deleted. They
  // are audit evidence, not live references that can be remapped.
  "deleted_records.record_id",
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
  // Legacy document tables commonly store the acting user without a physical
  // foreign key. Cover every audit-actor column instead of registering
  // created_by_id / posted_by_id one table at a time.
  if (/_by_id$/.test(column)) {
    return { domain: "user", referencedTable: "users", shape: "scalar" };
  }
  if (/_by$/.test(column)) {
    return { domain: "user", referencedTable: "users", shape: "scalar" };
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
  if (/(?:^|_)(?:journal_entry|journal)_id$/.test(column)) {
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
    [/(?:^|_)project_id$/, "document", "contracting_projects"],
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
  if (table === "accounting_adjustments" && column === "source_id") {
    const sourceTables: Record<string, string> = {
      purchase_invoice: "purchase_invoices",
      payment_voucher: "payment_vouchers",
    };
    const referencedTable = sourceTables[String(row.source_type ?? "")];
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-reference";
  }
  if (table === "crm_activities" && column === "related_id") {
    const referencedTable = {
      customer: "customers",
      lead: "crm_leads",
      opportunity: "crm_opportunities",
    }[String(row.related_type ?? "").trim().toLowerCase()];
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-reference";
  }
  if (table === "settlement_links" && column === "source_id") {
    const referencedTable = {
      je: "journal_entries",
      receipt_voucher: "receipt_vouchers",
      payment_voucher: "payment_vouchers",
    }[String(row.source_type ?? "").trim().toLowerCase()];
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-reference";
  }
  if (table === "stock_ledger" && column === "ref_id") {
    const refType = String(row.ref_type ?? "").trim().toLowerCase();
    if (refType === "opening_balance" && Number(row.ref_id) === 0) return null;
    const referencedTable = DOCUMENT_TABLES[refType];
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-reference";
  }
  if (table === "je_number_reservations" && column === "source_id") {
    const referencedTable = DOCUMENT_TABLES[
      String(row.source_type ?? "").trim().toLowerCase()
    ];
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-reference";
  }
  if (table === "security_actions" && column === "target_ref_id") {
    const targetModule = String(row.target_module ?? "").trim().toLowerCase();
    if (!targetModule || targetModule === "none") return null;
    const referencedTable = DOCUMENT_TABLES[targetModule];
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-reference";
  }
  if (table === "security_events" && column === "ref_id") {
    const linkedModule = String(row.linked_module ?? "").trim().toLowerCase();
    if (!linkedModule || linkedModule === "none") return null;
    const referencedTable = DOCUMENT_TABLES[linkedModule];
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-reference";
  }
  if (table === "account_notes" && column === "party_id") {
    const referencedTable = {
      customer: "customers",
      supplier: "suppliers",
    }[String(row.party_type ?? "").trim().toLowerCase()];
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-reference";
  }
  if ((table === "receipt_vouchers" || table === "payment_vouchers") && column === "entity_id") {
    const entityType = String(row.entity_type ?? "").trim().toLowerCase();
    const referencedTable = {
      customer: "customers",
      supplier: "suppliers",
    }[entityType];
    // "other" is a free-text counterparty, not a reference to another table.
    if (entityType === "other") return null;
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-reference";
  }
  if (table === "attendance_audit" && column === "entity_id") {
    const referencedTable = ATTENDANCE_AUDIT_ENTITY_TABLES[
      String(row.entity ?? "").trim().toLowerCase()
    ];
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-reference";
  }
  if (table === "employee_history" && column === "ref_id") {
    const referencedTable = EMPLOYEE_HISTORY_REFERENCE_TABLES[
      String(row.ref_table ?? "").trim().toLowerCase()
    ];
    return referencedTable
      ? { domain: "document", referencedTable, shape: "scalar" }
      : "unsupported-reference";
  }
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
      if (
        tableName === "audit_log"
        && column === "user_id"
        && typeof rule !== "string"
        && rule.referencedTable === "users"
        && (indexes.get("users")?.get(key(sourceValue)) ?? 0) === 0
      ) {
        // Historical audit rows can outlive deleted users. Legacy backup
        // catalogs may omit this physical FK, causing the generic logical-ID
        // detector to see it instead. Restore handles it as NULL (or drops
        // only the audit row on a truly NOT NULL target).
        continue;
      }
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
      let sourceMissing = false;
      for (const value of values) {
        if (value == null || (rule.allowZero && Number(value) === 0)) continue;
        const count = indexes.get(rule.referencedTable)?.get(key(value)) ?? 0;
        if (count === 0) {
          sourceMissing = true;
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
      if (valid) references.push({
        table: tableName,
        column,
        rowId,
        sourceValue,
        rule,
        sourceMissing,
      });
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