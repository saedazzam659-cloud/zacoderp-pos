import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { canSkipMissingResetTable } from "./companyResetPolicy.js";
import { SEQUENCE_PROTECTION_LOCK_NAMESPACE } from "./sequenceProtection.js";
import { ensureCompanyPurgeSchema } from "./companyPurgeSchema.js";

/**
 * Only tenant-scoped operational tables belong here. Master/setup records are
 * intentionally excluded. Keep child tables before their document headers.
 */
const RESET_TABLES = [
  "sales_invoice_lines", "sales_return_lines", "sales_quotation_lines", "sales_order_lines",
  "purchase_invoice_lines", "purchase_return_lines", "purchase_order_lines",
  "goods_receipt_lines", "goods_delivery_lines",
  "settlement_links", "je_number_reservations", "invoice_create_idempotency",
  "journal_number_claims",
  "lc_expenses", "contracting_bill_lines", "contracting_bill_deductions",
  "contracting_bill_penalties", "contracting_bill_additions", "contracting_bill_attachments",
  "contracting_bill_workflow_events", "contracting_material_movement_allocations",
  "mudad_salary_batch_lines", "payroll_allocation_snapshots", "employee_custody_settlements",
  "school_exam_results", "school_daily_assessments", "school_result_approvals",
  "school_grade_audit_events", "school_student_attendance_events",
  "school_biometric_consent_events", "school_student_face_templates",
  "hotel_payments", "hotel_housekeeping",
  "hospital_insurance_claims", "safety_incident_actions",
  "crm_whatsapp_campaign_recipients",
  "sales_invoices", "sales_returns", "sales_quotations", "sales_orders", "customer_settlements",
  "purchase_invoices", "purchase_returns", "purchase_orders", "supplier_settlements",
  "receipt_vouchers", "payment_vouchers", "cash_transfers",
  "goods_receipts", "goods_deliveries", "stock_transfers", "stock_adjustments",
  "stock_counts", "stock_ledger", "stock_balance", "item_branch_stock",
  "journal_entries", "accounting_adjustment_runs", "accounting_adjustments",
  "invoices", "document_expenses", "account_notes", "trial_balances",
  "letters_of_credit", "contracting_progress_bills", "contracting_fiscal_invoices",
  "contracting_accounting_settlements", "contracting_material_movements",
  "contracting_accounting_audit", "contracting_cost_allocations",
  "contracting_events", "contracting_risks", "contracting_tenders", "contracting_guarantees",
  "employee_attendance", "attendance_movements", "attendance_day_locks",
  "attendance_payroll_transfers", "attendance_audit", "face_recognition_logs",
  "employee_loans", "employee_custodies", "asset_custodies", "employee_violations",
  "employee_travels", "employee_leaves", "employee_salary_adjustments",
  "employee_transfers", "employee_evaluations", "employee_terminations", "payroll_runs",
  "mudad_salary_batches", "exit_permissions", "employee_project_assignments",
  "production_orders", "production_events", "production_cost_allocations",
  "production_stage_resource_costs", "production_pending_utility_claims",
  "production_driver_reconciliations", "production_waste_records", "production_overhead_closures",
  "production_commercial_accruals", "production_quality_checks", "production_forecasts",
  "production_downtime_events", "pos_orders", "pos_suspicious_ops",
  "hotel_bookings", "hospital_appointments", "hospital_invoices",
  "sales_rep_visits", "maintenance_orders", "field_visits", "field_service_tickets",
  "school_attendance", "school_fee_charges", "crm_leads", "crm_opportunities",
  "crm_activities", "crm_whatsapp_contacts", "crm_whatsapp_campaigns",
  "sister_transfers", "sister_returns", "sister_settlements",
  "installment_payments", "installments", "installment_contracts",
  "safety_risk_assessments", "safety_risk_controls", "safety_incidents",
  "tax_integration_submissions", "contracting_tax_submissions",
  "integration_invoice_queue", "sequence_logs", "school_enrollments", "school_exams",
  "school_transport_assignments", "pos_sessions", "training_sessions", "training_attendance",
  "trainee_requests", "approval_log", "deleted_records", "employee_contracts",
  "crm_campaigns", "delivery_receipt_document_audit", "delivery_receipt_document_lines",
  "delivery_receipt_documents", "fa_depreciation_runs", "fa_disposals", "fa_maintenance",
  "fa_transfers", "employee_history", "maintenance_runs", "notifications", "offers",
  "sales_line_production_cost_attributions", "store_orders", "sync_queue_log",
  "voice_command_log", "work_sessions", "ext_data", "ext_records",
  "contracting_bill_create_idempotency", "contracting_contract_create_idempotency",
] as const;

const CASCADE_CHILDREN = [
  ["journal_entry_lines", "journal_entries", "entry_id"],
  ["receipt_voucher_lines", "receipt_vouchers", "voucher_id"],
  ["payment_voucher_lines", "payment_vouchers", "voucher_id"],
  ["stock_transfer_items", "stock_transfers", "transfer_id"],
  ["stock_adjustment_items", "stock_adjustments", "adjustment_id"],
  ["stock_count_items", "stock_counts", "count_id"],
] as const;

// Tenant-scoped master data, configuration, credentials, platform evidence,
// and immutable identities that must survive a reset. Every company_id table
// in the active schema must be in exactly one policy set.
const PRESERVED_TABLES = [
  "accounting_mappings", "accounts", "ai_feature_settings", "ai_usage_log",
  "attendance_ai_settings", "attendance_cameras", "attendance_shifts", "audit_log",
  "auto_backups", "bank_accounts", "bom_templates", "branches", "brands", "cash_boxes",
  "chat_conversations", "chat_messages", "company_domains", "company_extensions",
  "contracting_contract_boq_lines", "contracting_contractors", "contracting_owner_bill_tax_mappings",
  "contracting_owner_contracts", "contracting_projects", "contracting_resources",
  "contracting_settings", "contracting_sub_contracts", "contracting_work_item_resources",
  "contracting_work_items", "cost_centers", "crm_pipeline_stages", "currencies",
  "custom_print_templates", "customer_groups", "customers", "dev_workspaces",
  "device_invoice_ranges", "device_licenses", "document_archives", "download_access_codes",
  "employee_certificates", "employee_dependents", "employee_documents", "employee_emergency_contacts",
  "employee_face_enrollments", "employee_medical_insurance_policies", "employee_qualifications",
  "employees", "exchange_rates", "extension_purchases", "fa_asset_groups", "fa_categories",
  "field_locations", "field_visit_plans", "fiscal_periods", "fiscal_years", "fixed_assets",
  "hospital_doctors", "hospital_patients", "hospitals", "hotel_guests", "hotel_rooms", "hotels",
  "hr_departments", "hr_positions", "inbox_messages", "installment_settings",
  "integration_connections", "internal_control_cases", "internal_control_history",
  "internal_control_rules", "invoice_field_policy_profiles", "item_bom_steps", "item_brands",
  "item_bundle_components", "item_currency_prices", "item_documents", "item_groups",
  "item_subgroups", "item_suppliers", "item_unit_prices", "item_usage_controls", "items",
  "kiosk_tokens", "maintenance_assets", "maintenance_technicians", "manufacturing_settings",
  "packaging_specifications", "partner_commissions", "partner_companies", "pos_devices",
  "pos_item_subgroups", "pos_menu_categories", "pos_menu_items", "pos_tables",
  "pos_terminal_users", "pos_terminals", "production_downtime_reasons",
  "production_quality_check_templates", "production_resources", "production_routings",
  "production_shift_holidays", "production_shifts", "production_wizard_templates", "regions",
  "reseller_commissions", "reseller_companies", "reseller_tickets", "sales_reps",
  "school_academic_periods", "school_academic_years", "school_campuses", "school_classes",
  "school_grade_subject_policies", "school_grades", "school_guardian_portal_accounts",
  "school_guardian_portal_links", "school_student_biometric_consents", "school_student_guardians",
  "school_students", "school_subject_offerings", "school_subjects", "school_transport_routes",
  "school_transport_stops", "school_transport_vehicles", "security_actions", "security_event_media",
  "security_events", "security_notification_rules", "sequences", "sessions", "sister_companies",
  "store_domains", "store_payment_settings", "store_products", "stores", "subscriptions",
  "supplier_bulk_account_code_guards", "supplier_groups", "suppliers", "support_messages", "surveillance_devices",
  "tax_integration_audit", "tax_integration_setups", "taxes", "tracking_zones", "units",
  "user_visits", "users", "voice_assistant_settings", "warehouse_groups", "warehouses",
  "work_centers", "work_session_settings",
] as const;

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const ALL_POLICIED_TABLES = new Set<string>([...RESET_TABLES, ...PRESERVED_TABLES]);
// ensureSchema reports this newer queue table as not yet installed on existing DBs.
// Absence means there are no rows to purge; all other missing reset tables fail closed.
export type CompanyResetPreview = {
  tables: Array<{ table: string; rows: number }>;
  totalRows: number;
};

export async function previewCompanyReset(companyId: number): Promise<CompanyResetPreview> {
  await assertPolicyCoverage(db);
  const tables: CompanyResetPreview["tables"] = [];
  for (const [table, parent, foreignKey] of CASCADE_CHILDREN) {
    const result: any = await db.execute(sql.raw(
      `SELECT count(*)::int AS count FROM public.${quoteIdentifier(table)} child JOIN public.${quoteIdentifier(parent)} parent ON parent.id = child.${quoteIdentifier(foreignKey)} WHERE parent.company_id = ${companyId}`,
    ));
    const rows = Number(result.rows?.[0]?.count ?? 0);
    if (rows > 0) tables.push({ table, rows });
  }
  for (const table of RESET_TABLES) {
    const exists = await assertTenantTableExists(table, db);
    if (!exists) continue;
    const result: any = await db.execute(sql.raw(
      `SELECT count(*)::int AS count FROM public.${quoteIdentifier(table)} WHERE company_id = ${companyId}`,
    ));
    const rows = Number(result.rows?.[0]?.count ?? 0);
    if (rows > 0) tables.push({ table, rows });
  }
  return { tables, totalRows: tables.reduce((sum, item) => sum + item.rows, 0) };
}

async function assertTenantTableExists(table: string, executor: any): Promise<boolean> {
  const result: any = await executor.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'company_id'
    LIMIT 1
  `);
  if (result.rows?.length) return true;
  if (canSkipMissingResetTable(table, false)) return false;
  throw new Error(`RESET_SCHEMA_UNSUPPORTED:${table}`);
}

async function assertPolicyCoverage(executor: any): Promise<void> {
  const result: any = await executor.execute(sql`
    SELECT DISTINCT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'company_id'
  `);
  const unmapped = (result.rows ?? [])
    .map((row: any) => String(row.table_name))
    .filter((table: string) => !ALL_POLICIED_TABLES.has(table));
  if (unmapped.length) throw new Error(`RESET_POLICY_UNMAPPED:${unmapped.sort().join(",")}`);
}

export async function resetCompanyOperationalData(
  companyId: number,
  confirmationName: string,
  expectedFingerprint: string,
): Promise<CompanyResetPreview> {
  await ensureCompanyPurgeSchema();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(741923, ${companyId})`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEQUENCE_PROTECTION_LOCK_NAMESPACE}, ${companyId})`);
    await assertPolicyCoverage(tx);
    const companyResult: any = await tx.execute(sql`
      SELECT name_ar, is_internal_demo_workspace, demo_parent_company_id,
             (
               NULLIF(zatca_csid, '') IS NOT NULL OR NULLIF(zatca_pcsid, '') IS NOT NULL OR
               NULLIF(zatca_csid_token, '') IS NOT NULL OR NULLIF(zatca_pcsid_token, '') IS NOT NULL OR
               NULLIF(zatca_private_key, '') IS NOT NULL OR NULLIF(zatca_csr, '') IS NOT NULL OR
               NULLIF(zatca_csid_secret, '') IS NOT NULL OR NULLIF(zatca_pcsid_secret, '') IS NOT NULL OR
               NULLIF(zatca_compliance_request_id, '') IS NOT NULL OR NULLIF(serial_number, '') IS NOT NULL OR
               NULLIF(device_serial1, '') IS NOT NULL OR NULLIF(device_serial2, '') IS NOT NULL OR
               NULLIF(device_serial3, '') IS NOT NULL OR NULLIF(zatca_transfer_id, '') IS NOT NULL OR
               zatca_chain_seed_icv IS NOT NULL OR NULLIF(zatca_chain_seed_pih, '') IS NOT NULL OR
               zatca_transfer_state <> 'active' OR EXISTS (
                 SELECT 1 FROM public.device_invoice_ranges d WHERE d.company_id = ${companyId}
               )
             ) AS has_zatca
      FROM public.companies
      WHERE id = ${companyId} AND deleted_at IS NULL
      FOR UPDATE
    `);
    const company = companyResult.rows?.[0];
    if (!company) throw new Error("RESET_COMPANY_NOT_FOUND");
    if (confirmationName !== company.name_ar) throw new Error("RESET_NAME_MISMATCH");
    if (company.is_internal_demo_workspace || company.demo_parent_company_id != null) {
      throw new Error("RESET_DEMO_COMPANY");
    }
    if (company.has_zatca) {
      throw new Error("RESET_ZATCA_REGISTERED");
    }

    // Fail closed if a listed table is absent or no longer tenant-scoped.
    for (const [table, parent, foreignKey] of CASCADE_CHILDREN) {
      const check: any = await tx.execute(sql`
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = ${table} AND c.column_name = ${foreignKey}
        LIMIT 1
      `);
      if (!check.rows?.length) throw new Error(`RESET_SCHEMA_UNSUPPORTED:${table}`);
      const parentCheck: any = await tx.execute(sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${parent} AND column_name = 'company_id'
        LIMIT 1
      `);
      if (!parentCheck.rows?.length) throw new Error(`RESET_SCHEMA_UNSUPPORTED:${parent}`);
    }
    for (const table of RESET_TABLES) {
      await assertTenantTableExists(table, tx);
    }

    const preview = await previewCompanyResetInTransaction(tx, companyId);
    const fingerprint = JSON.stringify([...preview.tables].sort((a, b) => a.table.localeCompare(b.table)));
    if (!expectedFingerprint || expectedFingerprint !== fingerprint) throw new Error("RESET_PREVIEW_STALE");
    // This transaction-local marker permits the explicitly confirmed reset to
    // delete protected numbered records for this company only. The guard keeps
    // rejecting protected deletes from every other transaction/company.
    await tx.execute(sql`SELECT set_config('zacode.company_reset_company_id', ${String(companyId)}, TRUE)`);
    for (const [table, parent, foreignKey] of CASCADE_CHILDREN) {
      await tx.execute(sql.raw(
        `DELETE FROM public.${quoteIdentifier(table)} child USING public.${quoteIdentifier(parent)} parent WHERE parent.id = child.${quoteIdentifier(foreignKey)} AND parent.company_id = ${companyId}`,
      ));
    }
    for (const table of RESET_TABLES) {
      if (!await assertTenantTableExists(table, tx)) continue;
      await tx.execute(sql.raw(
        `DELETE FROM public.${quoteIdentifier(table)} WHERE company_id = ${companyId}`,
      ));
    }

    // Keep sequence definitions/prefixes/settings; reset only generated state.
    await tx.execute(sql`
      DELETE FROM public.sequence_counters c
      USING public.sequences s
      WHERE c.sequence_id = s.id AND s.company_id = ${companyId}
    `);
    await tx.execute(sql`DELETE FROM public.je_number_reservations WHERE company_id = ${companyId}`);
    await tx.execute(sql`UPDATE public.sequences SET current_number = start_number, updated_at = NOW() WHERE company_id = ${companyId}`);
    await tx.execute(sql`UPDATE public.companies SET invoice_counter = 0, updated_at = NOW() WHERE id = ${companyId}`);

    return preview;
  });
}

async function previewCompanyResetInTransaction(tx: any, companyId: number): Promise<CompanyResetPreview> {
  const tables: CompanyResetPreview["tables"] = [];
  for (const [table, parent, foreignKey] of CASCADE_CHILDREN) {
    const result: any = await tx.execute(sql.raw(
      `SELECT count(*)::int AS count FROM public.${quoteIdentifier(table)} child JOIN public.${quoteIdentifier(parent)} parent ON parent.id = child.${quoteIdentifier(foreignKey)} WHERE parent.company_id = ${companyId}`,
    ));
    const rows = Number(result.rows?.[0]?.count ?? 0);
    if (rows > 0) tables.push({ table, rows });
  }
  for (const table of RESET_TABLES) {
    if (!await assertTenantTableExists(table, tx)) continue;
    const result: any = await tx.execute(sql.raw(
      `SELECT count(*)::int AS count FROM public.${quoteIdentifier(table)} WHERE company_id = ${companyId}`,
    ));
    const rows = Number(result.rows?.[0]?.count ?? 0);
    if (rows > 0) tables.push({ table, rows });
  }
  return { tables, totalRows: tables.reduce((sum, item) => sum + item.rows, 0) };
}
