import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKUP_EXCLUDED_TABLES, classifyTable, isSensitiveColumn, sanitizeRow,
  topologicalTableOrder, isFullCompanyBackupPayload, isExternalFileReference,
  catalogsMatch, missingRequiredFullCompanyTables, REQUIRED_FULL_COMPANY_TABLES,
  restoreCatalogsCompatible, restoreParameterValue, restoredUsername, restoredUsernames,
  archivedRestoreUsername,
  canDropMissingRestoreReferenceOwner, canSynthesizeMissingRestoreReference,
} from "../src/lib/fullCompanyBackup.js";
import {
  buildRestoreReferencePlan,
  resolveRestoreReferenceRule,
  restoreReferenceKey,
} from "../src/lib/companyRestoreReferences.js";

test("backup sensitive policy preserves business hashes and removes credentials", () => {
  assert.equal(isSensitiveColumn("invoice_hash"), false);
  assert.equal(isSensitiveColumn("pih"), false);
  assert.equal(isSensitiveColumn("password_hash"), true);
  assert.equal(isSensitiveColumn("access_token"), true);
  assert.equal(isSensitiveColumn("zatca_private_key"), true);
  assert.equal(isSensitiveColumn("license_key"), true);
  assert.equal(isSensitiveColumn("pos_session_id"), false);
  assert.equal(isSensitiveColumn("work_session_id"), false);
  assert.equal(isSensitiveColumn("idempotency_key"), false);
  assert.deepEqual(sanitizeRow({ invoice_hash: "evidence", password_hash: "nope" }),
    { invoice_hash: "evidence", password_hash: null });
  assert.deepEqual(sanitizeRow({ stream_url: "rtsp://admin:password@camera.local/live" }),
    { stream_url: null });
  assert.deepEqual(sanitizeRow({ attachment_url: "https://s3.example/a?X-Amz-Signature=secret" }),
    { attachment_url: null });
  assert.deepEqual(sanitizeRow({ file_url: "https://files.example/a?access_token=secret" }),
    { file_url: null });
  assert.deepEqual(sanitizeRow({ image_url: "https://files.example/a?api_key=secret" }),
    { image_url: null });
  assert.deepEqual(sanitizeRow({
    settings: {
      clientSecret: "nope",
      nested: { access_token: "nope", invoice_hash: "evidence" },
    },
  }), {
    settings: {
      clientSecret: null,
      nested: { access_token: null, invoice_hash: "evidence" },
    },
  });
  assert.deepEqual(sanitizeRow({ session_id: "auth-session", pos_session_id: 42 }, "users"),
    { session_id: null, pos_session_id: 42 });
  assert.deepEqual(sanitizeRow({ session_id: 42, pos_session_id: 42 }, "sales_invoices"),
    { session_id: 42, pos_session_id: 42 });
  assert.deepEqual(sanitizeRow({ settings: { session_id: "nested-auth-session" } }, "users"),
    { settings: { session_id: null } });
});

test("external file reference detection covers stored paths and URLs", () => {
  assert.equal(isExternalFileReference("object_path", "/objects/a.pdf"), true);
  assert.equal(isExternalFileReference("signature_object_path", "private/signature.png"), true);
  assert.equal(isExternalFileReference("attachment_url", "https://files.example/a.pdf"), true);
  assert.equal(isExternalFileReference("photo_url", "data:image/png;base64,AA"), false);
  assert.equal(isExternalFileReference("invoice_number", "INV-1"), false);
});

test("restore serializes json values before raw SQL binding", () => {
  assert.equal(restoreParameterValue("jsonb", [0, 1, 2]), "[0,1,2]");
  assert.equal(restoreParameterValue("json", { enabled: true }), '{"enabled":true}');
  assert.deepEqual(restoreParameterValue("ARRAY", ["sun", "mon"]), ["sun", "mon"]);
  assert.equal(restoreParameterValue("text", "plain"), "plain");
  assert.equal(restoreParameterValue("jsonb", null), null);
});

test("restore normalizes legacy boolean encodings", () => {
  assert.equal(restoreParameterValue("boolean", false), false);
  assert.equal(restoreParameterValue("boolean", "false"), false);
  assert.equal(restoreParameterValue("boolean", "0"), false);
  assert.equal(restoreParameterValue("boolean", "true"), true);
  assert.equal(restoreParameterValue("boolean", 1), true);
  assert.throws(() => restoreParameterValue("boolean", "not-a-boolean"));
});

test("restored users receive deterministic non-login identities", () => {
  assert.equal(restoredUsername("admin", 1, 23), "admin.restored.1.23");
  assert.ok(restoredUsername("x".repeat(200), 1, 23).length <= 120);
  assert.deepEqual(restoredUsernames("admin", 1, 23), ["admin", "admin.restored.1.23"]);
  assert.equal(archivedRestoreUsername(7, 99), "archived-user.restored.7.99");
  assert.equal(archivedRestoreUsername(7, 99), archivedRestoreUsername(7, 99));
});

test("only control/auth backup exclusions are excluded", () => {
  assert.equal(BACKUP_EXCLUDED_TABLES.has("auto_backups"), true);
  assert.equal(BACKUP_EXCLUDED_TABLES.has("sessions"), true);
  assert.equal(BACKUP_EXCLUDED_TABLES.has("pos_devices"), true);
  assert.equal(BACKUP_EXCLUDED_TABLES.has("extension_purchases"), true);
  assert.equal(BACKUP_EXCLUDED_TABLES.has("audit_log"), false);
  assert.equal(BACKUP_EXCLUDED_TABLES.has("pos_sessions"), false);
  assert.equal(classifyTable("users", true), "protected-user");
  assert.equal(classifyTable("invoice_lines", false), "dependent-child");
});

test("topology places dependencies first and remains deterministic for cycles", () => {
  const tables: any = {
    parent: { foreignKeys: [] },
    child: { foreignKeys: [{ referencedTable: "parent" }] },
    left: { foreignKeys: [{ referencedTable: "right" }] },
    right: { foreignKeys: [{ referencedTable: "left" }] },
  };
  const order = topologicalTableOrder(tables);
  assert.ok(order.indexOf("parent") < order.indexOf("child"));
  assert.deepEqual(order.slice(-2), ["left", "right"]);
});

test("v2 format uses full-company schema scope", () => {
  assert.equal(isFullCompanyBackupPayload({ meta: { schemaVersion: 2, scope: "full_company" }, manifest: { format: "full-company", tables: {} }, data: {} }), true);
  assert.equal(isFullCompanyBackupPayload({ meta: { schemaVersion: 2 }, manifest: { format: "full-company", tables: {} }, data: {} }), false);
});

test("canonical catalog validation rejects omitted tables and foreign keys", () => {
  const parent: any = {
    name: "parent", primaryKey: "id", primaryKeys: ["id"], columns: ["id", "company_id"],
    foreignKeys: [], classification: "tenant-root",
  };
  const child: any = {
    name: "child", primaryKey: "id", primaryKeys: ["id"], columns: ["id", "parent_id"],
    foreignKeys: [{ column: "parent_id", referencedTable: "parent", referencedColumn: "id", nullable: false }],
    classification: "dependent-child",
  };
  assert.equal(catalogsMatch({ parent, child }, { parent, child }), true);
  assert.equal(catalogsMatch({ parent }, { parent, child }), false);
  assert.equal(catalogsMatch({ parent, child: { ...child, foreignKeys: [] } }, { parent, child }), false);
});

test("restore compatibility permits only protected-user column drift", () => {
  const table = (name: string, classification: any = "tenant-root"): any => ({
    name, primaryKey: "id", primaryKeys: ["id"], columns: ["id", "company_id"],
    foreignKeys: [], classification,
  });
  const source = {
    accounts: table("accounts"),
    users: table("users", "protected-user"),
  };
  const newerUsers = {
    ...source.users,
    columns: [...source.users.columns, "demo_device_isolation", "is_demo_shadow"],
  };
  assert.equal(restoreCatalogsCompatible(source, { ...source, users: newerUsers }), true);
  assert.equal(restoreCatalogsCompatible(
    source,
    { ...source, accounts: { ...source.accounts, columns: [...source.accounts.columns, "new_business_field"] } },
  ), false);
  assert.equal(restoreCatalogsCompatible(
    source,
    { ...source, users: { ...newerUsers, primaryKey: "user_id", primaryKeys: ["user_id"] } },
  ), false);
});

test("full-company export refuses catalogs missing core business domains", () => {
  const table = (name: string): any => ({
    name, primaryKey: "id", primaryKeys: ["id"], columns: ["id", "company_id"],
    foreignKeys: [], classification: "tenant-root",
  });
  const complete = Object.fromEntries(REQUIRED_FULL_COMPANY_TABLES.map((name) => [name, table(name)]));
  assert.deepEqual(missingRequiredFullCompanyTables(complete), []);
  delete complete.journal_entries;
  delete complete.employees;
  assert.deepEqual(missingRequiredFullCompanyTables(complete), ["journal_entries", "employees"]);
});

test("logical restore registry maps accounting, branch arrays, and company settings", () => {
  const table = (name: string, columns: string[], foreignKeys: any[] = []): any => ({
    name,
    primaryKey: "id",
    primaryKeys: ["id"],
    columns: ["id", "company_id", ...columns],
    foreignKeys,
    classification: "tenant-root",
  });
  const tables = {
    accounts: table("accounts", ["code"]),
    branches: table("branches", ["code"]),
    customers: table("customers", ["account_id"]),
    cash_boxes: table("cash_boxes", ["branch_ids"]),
  };
  const payload: any = {
    meta: { schemaVersion: 2, scope: "full_company", companyId: 7 },
    manifest: { format: "full-company", tables, exclusions: [] },
    counts: { accounts: 1, branches: 2, customers: 1, cash_boxes: 1 },
    companySettings: { hr_salaries_expense_account_id: 101 },
    data: {
      accounts: [{ id: 101, company_id: 7, code: "5100" }],
      branches: [{ id: 11, company_id: 7, code: "A" }, { id: 12, company_id: 7, code: "B" }],
      customers: [{ id: 21, company_id: 7, account_id: 101 }],
      cash_boxes: [{ id: 31, company_id: 7, branch_ids: [11, 12] }],
    },
  };
  const plan = buildRestoreReferencePlan(payload, tables);
  assert.equal(plan.issues.length, 0);
  assert.equal(plan.references.length, 3);
  assert.equal(plan.checked, 3);
  assert.equal(resolveRestoreReferenceRule("companies", "pos_card_bank_account_id", {} as any)?.referencedTable, "bank_accounts");
  assert.equal(restoreReferenceKey("101"), restoreReferenceKey(101));
});

test("logical restore registry marks missing source-owned references for live-column validation", () => {
  const tables: any = {
    accounts: {
      name: "accounts", primaryKey: "id", primaryKeys: ["id"],
      columns: ["id", "company_id"], foreignKeys: [], classification: "tenant-root",
    },
    customers: {
      name: "customers", primaryKey: "id", primaryKeys: ["id"],
      columns: ["id", "company_id", "account_id"], foreignKeys: [], classification: "tenant-root",
    },
  };
  const payload: any = {
    meta: { schemaVersion: 2, scope: "full_company", companyId: 7 },
    manifest: { format: "full-company", tables, exclusions: [] },
    counts: { accounts: 0, customers: 1 },
    companySettings: null,
    data: { accounts: [], customers: [{ id: 21, company_id: 7, account_id: 999 }] },
  };
  const plan = buildRestoreReferencePlan(payload, tables);
  assert.equal(plan.references.length, 1);
  assert.equal(plan.references[0]?.sourceMissing, true);
  assert.equal(plan.references[0]?.table, "customers");
  assert.equal(plan.references[0]?.column, "account_id");
  assert.equal(plan.issues.length, 0);
});

test("missing required historical users are eligible for archived-user synthesis", () => {
  const tables: any = {
    users: {
      name: "users", primaryKey: "id", primaryKeys: ["id"],
      columns: ["id", "company_id", "username"], foreignKeys: [], classification: "protected-user",
    },
    work_sessions: {
      name: "work_sessions", primaryKey: "id", primaryKeys: ["id"],
      columns: ["id", "company_id", "user_id"], foreignKeys: [], classification: "tenant-root",
    },
  };
  const payload: any = {
    meta: { schemaVersion: 2, scope: "full_company", companyId: 7 },
    manifest: { format: "full-company", tables, exclusions: [] },
    counts: { users: 0, work_sessions: 1 },
    companySettings: null,
    data: {
      users: [],
      work_sessions: [{ id: 1, company_id: 7, user_id: 999 }],
    },
  };
  const plan = buildRestoreReferencePlan(payload, tables);
  assert.equal(plan.issues.length, 0);
  assert.equal(plan.references.length, 1);
  assert.equal(plan.references[0]?.sourceMissing, true);
  assert.equal(plan.references[0]?.rule.referencedTable, "users");
  assert.equal(canSynthesizeMissingRestoreReference(plan.references[0]!), true);
});

test("orphan JE-number reservations are dropped instead of retaining unsafe source ids", () => {
  const orphanReservation = {
    table: "je_number_reservations",
    column: "source_id",
    rowId: 91,
    sourceValue: 404,
    sourceMissing: true,
    rule: { domain: "document", referencedTable: "purchase_invoices", shape: "scalar" },
  } as const;
  assert.equal(canDropMissingRestoreReferenceOwner(orphanReservation), true);
  assert.equal(canDropMissingRestoreReferenceOwner({ ...orphanReservation, sourceMissing: false }), false);
  assert.equal(canDropMissingRestoreReferenceOwner({
    ...orphanReservation,
    table: "settlement_links",
  }), false);
});

test("logical restore registry leaves physical foreign keys to the catalog engine", () => {
  const tables: any = {
    accounts: {
      name: "accounts", primaryKey: "id", primaryKeys: ["id"],
      columns: ["id", "company_id"], foreignKeys: [], classification: "tenant-root",
    },
    journal_entry_lines: {
      name: "journal_entry_lines", primaryKey: "id", primaryKeys: ["id"],
      columns: ["id", "account_id"],
      foreignKeys: [{ column: "account_id", referencedTable: "accounts", referencedColumn: "id", nullable: false }],
      classification: "dependent-child",
    },
  };
  const payload: any = {
    meta: { schemaVersion: 2, scope: "full_company", companyId: 7 },
    manifest: { format: "full-company", tables, exclusions: [] },
    counts: { accounts: 1, journal_entry_lines: 1 },
    companySettings: null,
    data: { accounts: [{ id: 101, company_id: 7 }], journal_entry_lines: [{ id: 1, account_id: 101 }] },
  };
  const plan = buildRestoreReferencePlan(payload, tables);
  assert.equal(plan.references.length, 0);
  assert.equal(plan.physicalForeignKeysSkipped, 1);
});

test("legacy audit rows do not fail when their deleted user is absent", () => {
  const tables: any = {
    users: {
      name: "users", primaryKey: "id", primaryKeys: ["id"],
      columns: ["id", "company_id"], foreignKeys: [], classification: "protected-user",
    },
    audit_log: {
      name: "audit_log", primaryKey: "id", primaryKeys: ["id"],
      columns: ["id", "company_id", "user_id"], foreignKeys: [], classification: "tenant-root",
    },
  };
  const payload: any = {
    meta: { schemaVersion: 2, scope: "full_company", companyId: 7 },
    manifest: { format: "full-company", tables, exclusions: [] },
    counts: { users: 0, audit_log: 1 },
    companySettings: null,
    data: { users: [], audit_log: [{ id: 1, company_id: 7, user_id: 999 }] },
  };
  const plan = buildRestoreReferencePlan(payload, tables);
  assert.equal(plan.issues.length, 0);
  assert.equal(plan.references.length, 0);
});

test("logical restore registry rejects unknown numeric id columns instead of preserving source ids", () => {
  const tables: any = {
    surveillance_devices: {
      name: "surveillance_devices", primaryKey: "id", primaryKeys: ["id"],
      columns: ["id", "company_id", "unknown_device_group_id"],
      foreignKeys: [], classification: "tenant-root",
    },
  };
  const payload: any = {
    meta: { schemaVersion: 2, scope: "full_company", companyId: 7 },
    manifest: { format: "full-company", tables, exclusions: [] },
    counts: { surveillance_devices: 1 },
    companySettings: null,
    data: { surveillance_devices: [{ id: 1, company_id: 7, unknown_device_group_id: 999 }] },
  };
  const plan = buildRestoreReferencePlan(payload, tables);
  assert.equal(plan.references.length, 0);
  assert.equal(plan.issues[0]?.code, "unsupported_reference");
});

test("legacy soft references used by backups are remapped by their discriminator", () => {
  assert.equal(
    resolveRestoreReferenceRule("account_notes", "party_id", { party_type: "customer", party_id: 4 })?.referencedTable,
    "customers",
  );
  assert.equal(
    resolveRestoreReferenceRule("payment_vouchers", "entity_id", { entity_type: "supplier", entity_id: 7 })?.referencedTable,
    "suppliers",
  );
  assert.equal(
    resolveRestoreReferenceRule("receipt_vouchers", "entity_id", { entity_type: "other", entity_id: 7 }),
    null,
  );
  assert.equal(
    resolveRestoreReferenceRule("attendance_audit", "entity_id", { entity: "movement", entity_id: 8 })?.referencedTable,
    "attendance_movements",
  );
  assert.equal(
    resolveRestoreReferenceRule("employee_history", "ref_id", { ref_table: "employee_terminations", ref_id: 9 })?.referencedTable,
    "employee_terminations",
  );
  assert.equal(
    resolveRestoreReferenceRule(
      "employee_custody_settlements",
      "journal_id",
      { journal_id: 10 },
    )?.referencedTable,
    "journal_entries",
  );
  assert.equal(
    resolveRestoreReferenceRule(
      "purchase_invoice_lines",
      "deferred_adjustment_id",
      { deferred_adjustment_id: 11 },
    )?.referencedTable,
    "accounting_adjustments",
  );
});

test("all legacy audit actor columns remap to restored users across document tables", () => {
  const actorColumns = [
    "created_by_id",
    "updated_by_id",
    "posted_by_id",
    "approved_by_id",
    "rejected_by_id",
    "cancelled_by_id",
    "closed_by_id",
    "locked_by_id",
    "unlocked_by_id",
    "deleted_by_id",
    "restored_by_id",
    "verified_by_id",
  ];
  for (const table of ["purchase_invoices", "sales_invoices", "goods_receipts", "goods_deliveries"]) {
    for (const column of actorColumns) {
      assert.equal(
        resolveRestoreReferenceRule(table, column, { [column]: 42 })?.referencedTable,
        "users",
        `${table}.${column}`,
      );
    }
  }
  for (const column of ["created_by", "updated_by", "posted_by", "approved_by", "deleted_by"]) {
    assert.equal(
      resolveRestoreReferenceRule("any_tenant_table", column, { [column]: 42 })?.referencedTable,
      "users",
      column,
    );
  }
});

test("full-company restore covers known non-FK business reference families", () => {
  const exactCases: Array<[string, string, string]> = [
    ["account_notes", "project_id", "contracting_projects"],
    ["attendance_movements", "exit_permission_id", "exit_permissions"],
    ["chat_messages", "reply_to_id", "chat_messages"],
    ["chat_participants", "last_read_message_id", "chat_messages"],
    ["crm_leads", "campaign_id", "crm_campaigns"],
    ["exit_permissions", "approver_id", "users"],
    ["face_recognition_logs", "attendance_id", "employee_attendance"],
    ["field_visits", "asset_id", "fixed_assets"],
    ["field_visits", "project_id", "contracting_projects"],
    ["field_visits", "ticket_id", "field_service_tickets"],
    ["inbox_messages", "notification_id", "notifications"],
    ["payment_vouchers", "session_id", "pos_sessions"],
    ["sales_invoices", "session_id", "pos_sessions"],
    ["pos_orders", "billed_invoice_id", "sales_invoices"],
    ["pos_orders", "table_id", "pos_tables"],
    ["pos_orders", "waiter_id", "users"],
    ["pos_tables", "current_order_id", "pos_orders"],
    ["sequence_logs", "sequence_id", "sequences"],
    ["settlement_links", "sales_invoice_id", "sales_invoices"],
    ["settlement_links", "purchase_invoice_id", "purchase_invoices"],
    ["suppliers", "group_id", "supplier_groups"],
    ["training_attendance", "session_id", "training_sessions"],
    ["trial_balances", "source_trial_balance_id", "trial_balances"],
    ["user_invoice_field_policies", "profile_id", "invoice_field_policy_profiles"],
    ["user_visits", "zone_id", "tracking_zones"],
    ["voice_command_log", "work_session_id", "work_sessions"],
  ];
  for (const [table, column, referencedTable] of exactCases) {
    assert.equal(
      resolveRestoreReferenceRule(table, column, { [column]: 1 })?.referencedTable,
      referencedTable,
      `${table}.${column}`,
    );
  }
  assert.equal(
    resolveRestoreReferenceRule("deleted_records", "record_id", { record_id: 7 }),
    null,
  );
});

test("polymorphic business references use their discriminator and reject unknown types", () => {
  const cases: Array<[string, string, Record<string, unknown>, string]> = [
    ["crm_activities", "related_id", { related_id: 1, related_type: "lead" }, "crm_leads"],
    ["settlement_links", "source_id", { source_id: 1, source_type: "je" }, "journal_entries"],
    ["stock_ledger", "ref_id", { ref_id: 1, ref_type: "sales_invoice" }, "sales_invoices"],
    ["stock_ledger", "ref_id", { ref_id: 1, ref_type: "transfer" }, "stock_transfers"],
    ["stock_ledger", "ref_id", { ref_id: 1, ref_type: "count" }, "stock_counts"],
    ["je_number_reservations", "source_id", { source_id: 1, source_type: "goods_receipt" }, "goods_receipts"],
    ["security_events", "ref_id", { ref_id: 1, linked_module: "purchase_invoice" }, "purchase_invoices"],
  ];
  for (const [table, column, row, referencedTable] of cases) {
    assert.equal(
      resolveRestoreReferenceRule(table, column, row)?.referencedTable,
      referencedTable,
      `${table}.${column}`,
    );
  }
  assert.equal(
    resolveRestoreReferenceRule("stock_ledger", "ref_id", { ref_id: 1, ref_type: "unknown" }),
    "unsupported-reference",
  );
  assert.equal(
    resolveRestoreReferenceRule("stock_ledger", "ref_id", { ref_id: 0, ref_type: "opening_balance" }),
    null,
  );
});
