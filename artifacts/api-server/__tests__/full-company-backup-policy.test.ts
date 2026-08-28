import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKUP_EXCLUDED_TABLES, classifyTable, isSensitiveColumn, sanitizeRow,
  topologicalTableOrder, isFullCompanyBackupPayload, isExternalFileReference,
  catalogsMatch, missingRequiredFullCompanyTables, REQUIRED_FULL_COMPANY_TABLES,
  restoreCatalogsCompatible, restoreParameterValue, restoredUsername,
} from "../src/lib/fullCompanyBackup.js";

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
});

test("only control/auth backup exclusions are excluded", () => {
  assert.equal(BACKUP_EXCLUDED_TABLES.has("auto_backups"), true);
  assert.equal(BACKUP_EXCLUDED_TABLES.has("sessions"), true);
  assert.equal(BACKUP_EXCLUDED_TABLES.has("pos_devices"), true);
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