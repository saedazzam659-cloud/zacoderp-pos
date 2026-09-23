import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  buildRestoreReferencePlan,
  resolveRestoreReferenceRule,
  restoreReferenceKey,
  type PlannedRestoreReference,
  type RestoreReferenceIssue,
  type RestoreReferencePlan,
  type RestoreReferenceRule,
} from "./companyRestoreReferences.js";
import { reconcilePostgresSequences } from "./postgresSequenceReconciliation.js";

/**
 * Tables deliberately outside a tenant backup.  They are central control-plane
 * state, authentication/session material, secrets, or backups themselves.
 * `companies` is exported separately as a restricted settings record.
 */
export const BACKUP_EXCLUDED_TABLES = new Set([
  "companies", "plans", "subscriptions", "auto_backups", "system_settings",
  "sessions", "user_sessions", "refresh_tokens", "password_reset_tokens",
  "otp_codes", "kiosk_tokens", "api_keys", "integration_connections",
  "gateway_clients", "super_admin_security", "gateway_api_keys", "sa_sessions",
  "session_users", "cobrowse_sessions", "demo_analytics_sessions",
  "dev_studio_sessions", "plan_configs",
  "ai_feature_settings",
  "device_licenses", "device_invoice_ranges", "download_access_codes",
  "pos_devices",
  "sync_queue_log", "company_clone_runs", "company_templates",
   // Operational request-replay state is intentionally local to an API
   // deployment. It is not business data and excluding it preserves the v2
   // exact-catalog contract for backups made before this table existed.
   "invoice_create_idempotency", "contracting_contract_create_idempotency", "contracting_bill_create_idempotency",
  // Marketplace purchase/entitlement state belongs to the central extension
  // control plane. Partner/listing IDs are not portable between servers.
  "extension_purchases",
  // Central-only ZATCA registration transport/control-plane state.  Invoice
  // hashes are intentionally not excluded: they are business chain evidence.
  "zatca_registration_transfers",
]);

/**
 * A schema-v2 export must never call itself "full_company" unless these core
 * business domains are present in the live catalog. Empty tables are valid;
 * omitted tables are not.
 */
export const REQUIRED_FULL_COMPANY_TABLES = [
  "accounts",
  "journal_entries",
  "sales_invoices",
  "purchase_invoices",
  "employees",
  "cash_boxes",
  "bank_accounts",
] as const;

const IDENT = /^[a-z_][a-z0-9_]*$/;
// Deliberately not a generic hash/salt rule: invoice_hash, PIH and hash-chain
// values are business/audit evidence. Password hashes and actual credentials
// are matched by their credential-bearing names instead.
const SENSITIVE = /(?:^password(?:_|$)|password_hash|login_password_hash|password_enc|session_token|current_session_id|(?:^|_)(?:token|otp)(?:_|$)|(?:^|_)(?:secret|credential|private_key|encryption_key|api_key|license_key)(?:_|$)|credentials_enc|csr_private_key_enc|zatca_(?:csid|pcsid|private_key)|^(?:x_amz|x_goog)_(?:signature|credential|security_token))/i;
const PROTECTED_RESTORE_TABLES = new Set(["users"]);
// Older schema-v2 files included POS device identities. They must not be
// restored onto another server, but the rest of such a backup remains valid.
const LEGACY_IGNORED_RESTORE_TABLES = new Set(["pos_devices", "extension_purchases"]);
const UNSAFE_COMPANY_SETTING = /(?:^|_)(?:id|company_id|code|status|domain|identity|subscription|plan|billing|backup|otp|token|secret|key|credential|agent|security)(?:_|$)|^zatca_(?:transfer|chain_seed)|^(?:created_at|updated_at)$/i;

export type ForeignKey = {
  column: string; referencedTable: string; referencedColumn: string; nullable: boolean;
  /**
   * Present on backups produced after composite-FK support.  `group` is a
   * catalog-stable description of the ordered tuple (never the constraint
   * name, which may differ between servers).  Missing fields mean a legacy
   * single-column FK.
   */
  group?: string; position?: number; size?: number;
};
export type BackupTable = {
  name: string; primaryKey: string | null; primaryKeys: string[]; columns: string[]; foreignKeys: ForeignKey[];
  classification: "tenant-root" | "dependent-child" | "protected-user";
};
export type FullCompanyPayload = {
  meta: {
    schemaVersion: 2;
    scope: "full_company";
    companyId: number;
    exportedAt: string;
    exportedBy: string | null;
    appName: string;
    files: { mode: "references_only"; referenced: number; warning: string | null };
  };
  counts: Record<string, number>;
  manifest: { format: "full-company"; tables: Record<string, BackupTable>; exclusions: string[] };
  companySettings: Record<string, unknown> | null;
  data: Record<string, Record<string, unknown>[]>;
};
export type RestoreTableReport = { received: number; inserted: number; updated: number };
export type FullCompanyIntegrityIssue = RestoreReferenceIssue | {
  severity: "error" | "warning";
  code: "catalog_mismatch" | "count_mismatch" | "unexpected_column" | "missing_physical_reference";
  table: string;
  column: string;
  rowId: unknown;
  sourceValue: unknown;
  referencedTable?: string;
  message: string;
};
export type FullCompanyIntegrityReport = {
  ok: boolean;
  phase: "preflight" | "completed";
  sourceCompanyId: number;
  targetCompanyId: number;
  checkedAt: string;
  summary: {
    tables: number;
    rows: number;
    physicalReferences: number;
    logicalReferences: number;
    physicalForeignKeysSkipped: number;
    remapped: number;
    audited: number;
  };
  issues: FullCompanyIntegrityIssue[];
};
export type FullCompanyRestoreResult = {
  report: Record<string, RestoreTableReport>;
  integrity: FullCompanyIntegrityReport;
};
export type FullCompanyRestoreOptions = {
  beforeCommit?: () => Promise<void>;
};

type RestoreColumnMeta = { dataType: string; nullable: boolean; hasDefault: boolean };
type RestoreAnalysis = {
  actual: Record<string, BackupTable>;
  tables: Record<string, BackupTable>;
  columnMeta: Map<string, RestoreColumnMeta>;
  referencePlan: RestoreReferencePlan;
  integrity: FullCompanyIntegrityReport;
};

export class FullCompanyIntegrityError extends Error {
  integrity: FullCompanyIntegrityReport;

  constructor(integrity: FullCompanyIntegrityReport) {
    super(integrity.issues[0]?.message || "فشل فحص سلامة النسخة الاحتياطية");
    this.name = "FullCompanyIntegrityError";
    this.integrity = integrity;
  }
}

function isExcludedTable(name: string): boolean {
  return BACKUP_EXCLUDED_TABLES.has(name)
    || /^(?:agent_|integration_|gateway_|dev_studio_|demo_analytics_|external_database|partner_|reseller_)/.test(name);
}

function ident(value: string): string {
  if (!IDENT.test(value)) throw new Error(`Unsafe database identifier: ${value}`);
  return `"${value}"`;
}
function rows(result: unknown): Record<string, any>[] {
  return Array.isArray(result) ? result as Record<string, any>[] : ((result as any)?.rows ?? []);
}
function cell(row: Record<string, any>, snake: string): any {
  return row[snake] ?? row[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
}
function normalizedKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();
}
export function restoredUsername(username: string, companyId: number, sourceId: unknown): string {
  const suffix = `.restored.${companyId}.${String(sourceId).replace(/[^a-zA-Z0-9]/g, "") || "user"}`;
  return `${username.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`;
}
export function restoredUsernames(username: string, companyId: number, sourceId: unknown): [string, string] {
  return [username, restoredUsername(username, companyId, sourceId)];
}
export function archivedRestoreUsername(companyId: number, sourceId: unknown): string {
  const id = String(sourceId).replace(/[^a-zA-Z0-9-]/g, "") || "unknown";
  const suffix = `.restored.${companyId}.${id}`;
  return `archived-user${suffix}`.slice(0, 120);
}
export function canSynthesizeMissingRestoreReference(
  reference: PlannedRestoreReference,
): boolean {
  return reference.sourceMissing === true && reference.rule.referencedTable === "users";
}

/**
 * A JE-number reservation is useful only while its source document still
 * exists and may be reposted. Historical orphan reservations can remain after
 * a source document is deleted; carrying their raw source IDs to another
 * server would risk matching an unrelated future row, so drop only that
 * orphan owner row during restore.
 */
export function canDropMissingRestoreReferenceOwner(
  reference: PlannedRestoreReference,
): boolean {
  return reference.sourceMissing === true
    && reference.table === "je_number_reservations"
    && reference.column === "source_id";
}
export function isSensitiveColumn(column: string): boolean { return SENSITIVE.test(normalizedKey(column)); }
export function restoreParameterValue(dataType: string | undefined, value: unknown): unknown {
  if ((dataType === "json" || dataType === "jsonb") && value !== null && value !== undefined) {
    return JSON.stringify(value);
  }
  if (dataType === "boolean" && value !== null && value !== undefined) {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true" || value === "t") return true;
    if (value === 0 || value === "0" || value === "false" || value === "f") return false;
    throw new Error("Invalid boolean value in backup");
  }
  return value;
}
function sanitizeValue(column: string, value: unknown, tableName?: string, nested = false): unknown {
  if (normalizedKey(column) === "session_id" && (nested || tableName === "users")) return null;
  if (isSensitiveColumn(column)) return null;
  const key = normalizedKey(column);
  if (typeof value === "string" && (key === "url" || key.endsWith("_url"))) {
    try {
      const parsed = new URL(value);
      const secretQuery = [...parsed.searchParams.keys()].some((key) =>
        /(?:^|_)(?:token|secret|signature|sig|key|credential|password)(?:_|$)/i.test(normalizedKey(key)));
      if (parsed.username || parsed.password || secretQuery) return null;
    } catch {
      // Non-URL display values are preserved.
    }
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(column, entry, tableName, true));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([nestedKey, nestedValue]) => [nestedKey, sanitizeValue(nestedKey, nestedValue, tableName, true)]));
  }
  return value;
}
export function sanitizeRow(row: Record<string, unknown>, tableName?: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, sanitizeValue(key, value, tableName)],
  ));
}
export function isExternalFileReference(column: string, value: unknown): boolean {
  if (typeof value !== "string" || !value.trim() || value.startsWith("data:")) return false;
  const explicitPointer = /(?:^|_)(?:attachment|file|image|photo|logo|signature|document|object|storage)(?:_|.*_)(?:path|url|key)$/i.test(column);
  if (explicitPointer) return true;
  const bareAssetColumn = /(?:^|_)(?:logo|signature|image|photo)(?:_|$)/i.test(column);
  const storedPointer = /^(?:\/?objects\/|\/?private\/|\/storage\/|https?:\/\/)/i.test(value.trim());
  return bareAssetColumn && storedPointer;
}

/** Keep historical ZATCA business documents while forcing a fresh target EGS
 * identity. This is applied before both direct and portable transfers. */
export function resetTransferredZatcaIdentity(payload: FullCompanyPayload): FullCompanyPayload {
  const clone = JSON.parse(JSON.stringify(payload)) as FullCompanyPayload;
  if (!clone.companySettings) return clone;
  const reset = [
    "serial_number",
    "device_serial1",
    "device_serial2",
    "device_serial3",
    "zatca_csid",
    "zatca_pcsid",
    "zatca_private_key",
    "zatca_csr",
    "zatca_csid_token",
    "zatca_csid_secret",
    "zatca_pcsid_token",
    "zatca_pcsid_secret",
    "zatca_compliance_request_id",
    "zatca_transfer_id",
    "zatca_transfer_target_binding",
    "zatca_transfer_locked_at",
    "zatca_transfer_completed_at",
    "zatca_chain_seed_icv",
    "zatca_chain_seed_pih",
  ];
  for (const key of reset) if (key in clone.companySettings) clone.companySettings[key] = null;
  clone.companySettings.auto_send_zatca_after_post = false;
  clone.companySettings.zatca_transfer_state = "active";
  return clone;
}
export function isFullCompanyBackupPayload(value: unknown): value is FullCompanyPayload {
  const payload = value as Partial<FullCompanyPayload> | null;
  return !!payload && payload.meta?.schemaVersion === 2 && payload.meta.scope === "full_company"
    && payload.manifest?.format === "full-company" && !!payload.manifest.tables && !!payload.data;
}
export function classifyTable(name: string, hasCompanyId: boolean): BackupTable["classification"] {
  if (name === "users") return "protected-user";
  return hasCompanyId ? "tenant-root" : "dependent-child";
}
export function topologicalTableOrder(tables: Record<string, BackupTable>): string[] {
  const pending = new Set(Object.keys(tables));
  const done = new Set<string>(); const ordered: string[] = [];
  while (pending.size) {
    const ready = [...pending].filter((name) => tables[name].foreignKeys
      .every((fk) => !pending.has(fk.referencedTable) || fk.referencedTable === name));
    // Remaining tables have a cycle. Insert their nullable edges as NULL first.
    const batch = (ready.length ? ready : [...pending]).sort();
    for (const name of batch) { pending.delete(name); done.add(name); ordered.push(name); }
  }
  return ordered;
}
function fkSignature(fk: ForeignKey): string {
  const tuple = (fk.size ?? 1) > 1 ? `\0${fk.group ?? ""}\0${fk.position ?? 0}\0${fk.size}` : "";
  return `${fk.column}\0${fk.referencedTable}\0${fk.referencedColumn}\0${fk.nullable ? "1" : "0"}${tuple}`;
}
export type ForeignKeyGroup = { key: string; foreignKeys: ForeignKey[]; referencedTable: string };
export function foreignKeyGroups(table: BackupTable): ForeignKeyGroup[] {
  const grouped = new Map<string, ForeignKey[]>();
  for (const fk of table.foreignKeys) {
    const key = (fk.size ?? 1) > 1 && fk.group ? fk.group : `legacy:${fk.column}:${fk.referencedTable}:${fk.referencedColumn}`;
    const current = grouped.get(key) ?? [];
    current.push(fk);
    grouped.set(key, current);
  }
  return [...grouped].map(([key, foreignKeys]) => ({
    key,
    foreignKeys: foreignKeys.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    referencedTable: foreignKeys[0].referencedTable,
  }));
}
function tupleKey(values: unknown[]): string {
  return values.map(restoreReferenceKey).join("\0");
}
export function sourceForeignKeyTupleIndexes(
  payload: FullCompanyPayload,
  tables: Record<string, BackupTable>,
): Map<string, Map<string, number>> {
  const indexes = new Map<string, Map<string, number>>();
  for (const table of Object.values(tables)) {
    for (const group of foreignKeyGroups(table)) {
      if (indexes.has(group.key)) continue;
      const index = new Map<string, number>();
      for (const parent of payload.data[group.referencedTable] ?? []) {
        const tuple = group.foreignKeys.map((foreignKey) => parent[foreignKey.referencedColumn]);
        if (tuple.some((value) => value == null)) continue;
        const key = tupleKey(tuple);
        index.set(key, (index.get(key) ?? 0) + 1);
      }
      indexes.set(group.key, index);
    }
  }
  return indexes;
}
export function compositeTargetTuple(
  group: ForeignKeyGroup,
  parent: BackupTable,
  source: Record<string, unknown>,
  targetValues: Record<string, unknown>,
  newId: unknown,
): { sourceKey: string; targetTuple: unknown[] } {
  const sourceTuple = group.foreignKeys.map((foreignKey) => source[foreignKey.referencedColumn]);
  if (sourceTuple.some((value) => value == null)) {
    throw new Error(`Cannot map null composite FK target ${parent.name}`);
  }
  const targetTuple = group.foreignKeys.map((foreignKey) => {
    if (foreignKey.referencedColumn === parent.primaryKey) return newId;
    if (foreignKey.referencedColumn in targetValues) return targetValues[foreignKey.referencedColumn];
    throw new Error(`Cannot map composite FK target ${parent.name}.${foreignKey.referencedColumn}`);
  });
  return { sourceKey: tupleKey(sourceTuple), targetTuple };
}
export function catalogsMatch(
  manifest: Record<string, BackupTable>,
  liveCatalog: Record<string, BackupTable>,
): boolean {
  const manifestNames = Object.keys(manifest).sort();
  const liveNames = Object.keys(liveCatalog).sort();
  if (manifestNames.join("\0") !== liveNames.join("\0")) return false;
  return manifestNames.every((name) => {
    const table = manifest[name];
    const live = liveCatalog[name];
    return !!table && !!live
      && table.classification === live.classification
      && table.primaryKey === live.primaryKey
      && Array.isArray(table.primaryKeys)
      && table.primaryKeys.join("\0") === live.primaryKeys.join("\0")
      && Array.isArray(table.columns)
      && table.columns.join("\0") === live.columns.join("\0")
      && Array.isArray(table.foreignKeys)
      && table.foreignKeys.map(fkSignature).sort().join("\n")
        === live.foreignKeys.map(fkSignature).sort().join("\n");
  });
}

/**
 * Business tables must keep an exact catalog match. The users table is the
 * sole compatibility boundary: it is protected (never deleted), imported
 * users are disabled, and agent/cloud releases may add profile or permission
 * columns at different times. Column drift there is therefore reconciled to
 * the live table without weakening the full-company catalog invariant.
 */
export function restoreCatalogsCompatible(
  manifest: Record<string, BackupTable>,
  liveCatalog: Record<string, BackupTable>,
): boolean {
  const sourceUsers = manifest.users;
  const liveUsers = liveCatalog.users;
  if (!sourceUsers || !liveUsers) return catalogsMatch(manifest, liveCatalog);
  return catalogsMatch({
    ...manifest,
    users: { ...sourceUsers, columns: [...liveUsers.columns] },
  }, liveCatalog);
}

export function missingRequiredFullCompanyTables(
  tables: Record<string, BackupTable>,
): string[] {
  return REQUIRED_FULL_COMPANY_TABLES.filter((name) => !tables[name]);
}
function tenantPredicate(
  name: string, tables: Record<string, BackupTable>, companyId: number, alias = "target",
  seen = new Set<string>(),
): ReturnType<typeof sql> {
  const table = tables[name];
  if (table.classification !== "dependent-child") {
    return sql`${sql.raw(`${ident(alias)}.${ident("company_id")}`)} = ${companyId}`;
  }
  if (seen.has(name)) throw new Error(`Cannot establish tenant ownership for cyclic table ${name}`);
  const nextSeen = new Set(seen).add(name);
  const options = foreignKeyGroups(table).filter((group) => tables[group.referencedTable]).map((group, index) => {
    const parent = `owner_${name}_${index}`;
    const parentTable = tables[group.referencedTable];
    const tupleMatch = sql.join(group.foreignKeys.map((fk) => sql`
      ${sql.raw(`${ident(parent)}.${ident(fk.referencedColumn)}`)} =
        ${sql.raw(`${ident(alias)}.${ident(fk.column)}`)}`), sql` AND `);
    return sql`EXISTS (SELECT 1 FROM ${sql.raw(ident(parentTable.name))} AS ${sql.raw(ident(parent))}
      WHERE ${tupleMatch}
      AND ${tenantPredicate(parentTable.name, tables, companyId, parent, nextSeen)})`;
  });
  if (!options.length) throw new Error(`Cannot establish tenant ownership for ${name}`);
  return sql`(${sql.join(options, sql` OR `)})`;
}

async function catalog(tx: any): Promise<Record<string, BackupTable>> {
  const tableResult = rows(await tx.execute(sql`
    SELECT c.table_name
    FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'company_id'
      AND t.table_type = 'BASE TABLE' ORDER BY c.table_name`));
  const selected = new Map<string, BackupTable>();
  for (const record of tableResult) {
    const name = String(cell(record, "table_name"));
    if (!isExcludedTable(name)) selected.set(name, {
      name, primaryKey: null, primaryKeys: [], columns: [], foreignKeys: [], classification: classifyTable(name, true),
    });
  }
  const columnRows = rows(await tx.execute(sql`
    SELECT table_name, column_name, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' ORDER BY ordinal_position`));
  const pkRows = rows(await tx.execute(sql`
    SELECT kcu.table_name, kcu.column_name FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
      AND tc.table_schema=kcu.table_schema
    WHERE tc.table_schema='public' AND tc.constraint_type='PRIMARY KEY'`));
  const nullable = new Map<string, boolean>();
  for (const c of columnRows) {
    const table = String(cell(c, "table_name")); const column = String(cell(c, "column_name"));
    nullable.set(`${table}.${column}`, String(cell(c, "is_nullable")) === "YES");
    selected.get(table)?.columns.push(column);
  }
  for (const p of pkRows) {
    const table = String(cell(p, "table_name")); const column = String(cell(p, "column_name"));
    const target = selected.get(table);
    if (target) target.primaryKeys.push(column);
  }
  const fkRows = rows(await tx.execute(sql`
    SELECT child.relname AS table_name, con.conname AS constraint_name,
      child_col.attname AS column_name, parent.relname AS referenced_table,
      parent_col.attname AS referenced_column, child_key.ordinality AS position,
      cardinality(con.conkey) AS key_count
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY child_key(attnum, ordinality) ON true
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY parent_key(attnum, ordinality)
      ON parent_key.ordinality = child_key.ordinality
    JOIN pg_attribute child_col ON child_col.attrelid = child.oid AND child_col.attnum = child_key.attnum
    JOIN pg_attribute parent_col ON parent_col.attrelid = parent.oid AND parent_col.attnum = parent_key.attnum
    WHERE con.contype = 'f' AND child_ns.nspname = 'public'
    ORDER BY child.relname, con.conname, child_key.ordinality`));
  // Grow from company-owned roots to children without company_id.
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of fkRows) {
      const child = String(cell(f, "table_name")); const parent = String(cell(f, "referenced_table"));
      if (!selected.has(child) && selected.has(parent) && !isExcludedTable(child)) {
        const cols = columnRows.filter((c) => String(cell(c, "table_name")) === child).map((c) => String(cell(c, "column_name")));
        if (!cols.includes("company_id")) {
          selected.set(child, { name: child, primaryKey: null, primaryKeys: [], columns: cols, foreignKeys: [],
            classification: classifyTable(child, false) });
          const p = pkRows.find((x) => String(cell(x, "table_name")) === child);
          for (const key of pkRows.filter((x) => String(cell(x, "table_name")) === child)) {
            selected.get(child)!.primaryKeys.push(String(cell(key, "column_name")));
          }
          changed = true;
        }
      }
    }
  }
  const constraintRows = new Map<string, Record<string, any>[]>();
  for (const f of fkRows) {
    const key = `${String(cell(f, "table_name"))}\0${String(cell(f, "constraint_name"))}`;
    const current = constraintRows.get(key) ?? [];
    current.push(f);
    constraintRows.set(key, current);
  }
  for (const entries of constraintRows.values()) {
    const ordered = entries.sort((a, b) => Number(cell(a, "position")) - Number(cell(b, "position")));
    const tupleGroup = ordered.length > 1
      ? `${ordered.map((f) => String(cell(f, "column_name"))).join(",")}->${String(cell(ordered[0], "referenced_table"))}(${ordered.map((f) => String(cell(f, "referenced_column"))).join(",")})`
      : undefined;
    for (const f of ordered) {
    const child = String(cell(f, "table_name")); const parent = String(cell(f, "referenced_table"));
    if (selected.has(child) && selected.has(parent)) selected.get(child)!.foreignKeys.push({
      column: String(cell(f, "column_name")), referencedTable: parent,
      referencedColumn: String(cell(f, "referenced_column")),
      nullable: nullable.get(`${child}.${String(cell(f, "column_name"))}`) === true,
      ...(tupleGroup ? {
        group: tupleGroup,
        position: Number(cell(f, "position")) - 1,
        size: ordered.length,
      } : {}),
    });
    }
  }
  for (const table of selected.values()) table.primaryKey = table.primaryKeys.length === 1 ? table.primaryKeys[0] : null;
  return Object.fromEntries(selected);
}

export async function buildFullCompanyBackup(companyId: number, exportedBy: string | null = null): Promise<{ payload: FullCompanyPayload; counts: Record<string, number> }> {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error("Invalid company id");
  return db.transaction(async (tx) => {
    const tables = await catalog(tx); const data: FullCompanyPayload["data"] = {};
    const missingRequired = missingRequiredFullCompanyTables(tables);
    if (missingRequired.length) {
      throw new Error(
        `تعذر إنشاء نسخة كاملة: كتالوج قاعدة البيانات لا يحتوي الجداول الأساسية التالية: ${missingRequired.join(", ")}`,
      );
    }
    for (const table of Object.values(tables)) data[table.name] = [];
    // Roots first, then repeatedly fetch children whose parent IDs were included.
    for (const table of Object.values(tables).filter((t) => t.classification !== "dependent-child")) {
      data[table.name] = rows(await tx.execute(sql`SELECT * FROM ${sql.raw(ident(table.name))}
        WHERE ${sql.raw(ident("company_id"))} = ${companyId}`)).map((row) => sanitizeRow(row, table.name));
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const table of Object.values(tables).filter((t) => t.classification === "dependent-child")) {
        for (const group of foreignKeyGroups(table)) {
          const parents = data[group.referencedTable] ?? [];
          const parentTuples = parents.map((parent) => group.foreignKeys.map((fk) => parent[fk.referencedColumn]))
            .filter((tuple) => tuple.every((value) => value != null));
          if (!parentTuples.length) continue;
          const tuplePredicates = parentTuples.map((tuple) => sql`(${sql.join(
            group.foreignKeys.map((fk, index) => sql`${sql.raw(ident(fk.column))} = ${tuple[index]}`),
            sql` AND `,
          )})`);
          const found = rows(await tx.execute(sql`SELECT * FROM ${sql.raw(ident(table.name))}
            WHERE ${sql.join(tuplePredicates, sql` OR `)}`))
            .map((row) => sanitizeRow(row, table.name));
          const pk = table.primaryKey;
          const known = new Set(data[table.name].map((row) => pk ? row[pk] : JSON.stringify(row)));
          const additions = found.filter((row) => !known.has(pk ? row[pk] : JSON.stringify(row)));
          if (additions.length) { data[table.name].push(...additions); changed = true; }
        }
      }
    }
    const setting = rows(await tx.execute(sql`SELECT * FROM "companies" WHERE "id" = ${companyId}`))[0];
    const companySettings = setting ? sanitizeRow(setting, "companies") : null;
    if (companySettings) { delete companySettings.id; delete companySettings.created_at; delete companySettings.updated_at; }
    const referencedFiles = Object.values(data).reduce((total, tableRows) =>
      total + tableRows.reduce((rowTotal, row) =>
        rowTotal + Object.entries(row).filter(([column, value]) => isExternalFileReference(column, value)).length, 0), 0)
      + (companySettings
        ? Object.entries(companySettings).filter(([column, value]) => isExternalFileReference(column, value)).length
        : 0);
    const counts = Object.fromEntries(Object.entries(data).map(([name, values]) => [name, values.length]));
    return { counts, payload: { meta: {
      schemaVersion: 2,
      scope: "full_company",
      companyId,
      exportedAt: new Date().toISOString(),
      exportedBy,
      appName: "ZATCA Invoicing",
      files: {
        mode: "references_only",
        referenced: referencedFiles,
        warning: referencedFiles
          ? "تحتوي النسخة على مراجع ملفات فقط؛ يجب نقل ملفات التخزين المرتبطة بصورة مستقلة."
          : null,
      },
    },
      counts, manifest: { format: "full-company", tables, exclusions: [...BACKUP_EXCLUDED_TABLES].sort() }, companySettings, data } };
  });
}

function validateRestoreManifest(payload: FullCompanyPayload): Record<string, BackupTable> {
  if (!isFullCompanyBackupPayload(payload)) throw new Error("Invalid schemaVersion 2 backup");
  const manifestTables = Object.fromEntries(Object.entries(payload.manifest.tables)
    .filter(([name]) => !LEGACY_IGNORED_RESTORE_TABLES.has(name)));
  for (const [name, table] of Object.entries(payload.manifest.tables)) {
    if (LEGACY_IGNORED_RESTORE_TABLES.has(name)) continue;
    if (!IDENT.test(name) || isExcludedTable(name) || !table.columns.every((column) => IDENT.test(column))) throw new Error("Unsafe backup manifest");
    if (!Object.keys(payload.data).includes(name)) throw new Error(`Missing backup data for ${name}`);
  }
  for (const name of Object.keys(payload.data)) {
    if (!LEGACY_IGNORED_RESTORE_TABLES.has(name) && !manifestTables[name]) {
      throw new Error(`Backup data has no manifest entry: ${name}`);
    }
  }
  return manifestTables;
}

function sourceReferenceIndexes(
  payload: FullCompanyPayload,
  tables: Record<string, BackupTable>,
): Map<string, Map<string, Map<string, number>>> {
  const indexes = new Map<string, Map<string, Map<string, number>>>();
  for (const [tableName, table] of Object.entries(tables)) {
    const referencedColumns = new Set<string>();
    if (table.primaryKey) referencedColumns.add(table.primaryKey);
    for (const candidate of Object.values(tables)) {
      for (const foreignKey of candidate.foreignKeys) {
        if (foreignKey.referencedTable === tableName) referencedColumns.add(foreignKey.referencedColumn);
      }
    }
    const tableIndexes = new Map<string, Map<string, number>>();
    for (const column of referencedColumns) tableIndexes.set(column, new Map());
    for (const row of payload.data[tableName] ?? []) {
      for (const column of referencedColumns) {
        const value = row[column];
        if (value == null) continue;
        const normalized = restoreReferenceKey(value);
        const index = tableIndexes.get(column)!;
        index.set(normalized, (index.get(normalized) ?? 0) + 1);
      }
    }
    indexes.set(tableName, tableIndexes);
  }
  return indexes;
}

async function analyzeRestore(
  tx: any,
  companyId: number,
  payload: FullCompanyPayload,
  manifestTables: Record<string, BackupTable>,
): Promise<RestoreAnalysis> {
  const actual = await catalog(tx);
  const issues: FullCompanyIntegrityIssue[] = [];
  const compatible = restoreCatalogsCompatible(manifestTables, actual);
  if (!compatible) {
    issues.push({
      severity: "error",
      code: "catalog_mismatch",
      table: "*",
      column: "*",
      rowId: null,
      sourceValue: null,
      message: "تعذر استعادة النسخة لأن إصدار جداول بيانات الشركة يختلف بين الخادم المصدر والهدف. حدّث الخادمين إلى الإصدار نفسه ثم أعد المحاولة.",
    });
  }
  const tables = { ...manifestTables };
  for (const name of PROTECTED_RESTORE_TABLES) {
    if (actual[name] && manifestTables[name]) tables[name] = actual[name];
  }
  const columnMeta = new Map<string, RestoreColumnMeta>();
  for (const record of rows(await tx.execute(sql`
    SELECT "table_name", "column_name", "data_type", "is_nullable", "column_default"
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `))) {
    columnMeta.set(
      `${String(cell(record, "table_name"))}.${String(cell(record, "column_name"))}`,
      {
        dataType: String(cell(record, "data_type")),
        nullable: String(cell(record, "is_nullable")) === "YES",
        hasDefault: cell(record, "column_default") != null,
      },
    );
  }
  for (const [name, table] of Object.entries(tables)) {
    const live = actual[name];
    if (!live || !Array.isArray(payload.data[name])) continue;
    if (payload.counts?.[name] !== payload.data[name].length) {
      issues.push({
        severity: "error",
        code: "count_mismatch",
        table: name,
        column: "*",
        rowId: null,
        sourceValue: payload.counts?.[name],
        message: `عدد سجلات ${name} لا يطابق بيان النسخة`,
      });
    }
    for (const record of payload.data[name]) {
      for (const key of Object.keys(record)) {
        if (!manifestTables[name].columns.includes(key)) {
          issues.push({
            severity: "error",
            code: "unexpected_column",
            table: name,
            column: key,
            rowId: table.primaryKey ? record[table.primaryKey] : null,
            sourceValue: record[key],
            message: `العمود ${name}.${key} غير مسجل في بيان النسخة`,
          });
        }
      }
    }
  }
  const sourceTupleIndexes = sourceForeignKeyTupleIndexes(payload, tables);
  let physicalReferences = 0;
  for (const [name, table] of Object.entries(tables)) {
    for (const record of payload.data[name] ?? []) {
      for (const group of foreignKeyGroups(table)) {
        const sourceTuple = group.foreignKeys.map((foreignKey) => record[foreignKey.column]);
        // PostgreSQL does not check a MATCH SIMPLE FK when any component is
        // NULL. Preserve that exact behavior rather than resolving a partial
        // tuple against an unrelated parent.
        if (sourceTuple.some((value) => value == null)) continue;
        physicalReferences++;
        const count = sourceTupleIndexes.get(group.key)?.get(tupleKey(sourceTuple)) ?? 0;
        if (count !== 1) {
          const foreignKey = group.foreignKeys[0];
          // Audit history may legitimately reference users deleted before the
          // backup was created. Older agents also reported this FK as NOT NULL
          // even when the current restore target allows NULL, so do not make
          // compatibility depend on the source manifest's nullability flag.
          if (
            count === 0
            && (foreignKey.referencedTable === "users"
              || (name === "audit_log" && foreignKey.column === "user_id"))
          ) {
            continue;
          }
          if (
            count === 0
            && group.foreignKeys.some((candidate) =>
              columnMeta.get(`${name}.${candidate.column}`)?.nullable === true)
          ) {
            continue;
          }
          issues.push({
            severity: "error",
            code: "missing_physical_reference",
            table: name,
            column: group.foreignKeys.map((candidate) => candidate.column).join(","),
            rowId: table.primaryKey ? record[table.primaryKey] : null,
            sourceValue: sourceTuple,
            referencedTable: foreignKey.referencedTable,
            message: count > 1
              ? `المرجع الفعلي ${name}.(${group.foreignKeys.map((candidate) => candidate.column).join(",")}) ملتبس داخل ${foreignKey.referencedTable}`
              : `المرجع الفعلي ${name}.(${group.foreignKeys.map((candidate) => candidate.column).join(",")}) لا يطابق صفًا داخل ${foreignKey.referencedTable}`,
          });
        }
      }
    }
  }
  const referencePlan = compatible
    ? buildRestoreReferencePlan(payload, tables)
    : { references: [], issues: [], checked: 0, physicalForeignKeysSkipped: 0 };
  issues.push(...referencePlan.issues);
  for (const [name, table] of Object.entries(tables)) {
    for (const group of foreignKeyGroups(table).filter((candidate) => candidate.foreignKeys.length > 1)) {
      const parent = tables[group.referencedTable];
      const unsupportedColumn = group.foreignKeys.find((foreignKey) =>
        foreignKey.referencedColumn !== parent?.primaryKey
        && (
          isSensitiveColumn(foreignKey.referencedColumn)
          || (PROTECTED_RESTORE_TABLES.has(group.referencedTable)
            && foreignKey.referencedColumn !== "company_id")
        ));
      if (parent?.primaryKey && !unsupportedColumn) continue;
      issues.push({
        severity: "error",
        code: "missing_physical_reference",
        table: name,
        column: group.foreignKeys.map((foreignKey) => foreignKey.column).join(","),
        rowId: null,
        sourceValue: null,
        referencedTable: group.referencedTable,
        message: unsupportedColumn
          ? `لا يمكن استعادة العلاقة المركبة في ${name} لأن العمود ${group.referencedTable}.${unsupportedColumn.referencedColumn} لا يمكن إعادة ربطه بأمان`
          : `لا يمكن استعادة العلاقة المركبة في ${name} لأن ${group.referencedTable} بلا مفتاح أساسي مفرد لإعادة الربط الآمن`,
      });
    }
  }
  for (const reference of referencePlan.references) {
    if (canDropMissingRestoreReferenceOwner(reference)) {
      issues.push({
        severity: "warning",
        code: "missing_reference_row",
        table: reference.table,
        column: reference.column,
        rowId: reference.rowId,
        sourceValue: reference.sourceValue,
        referencedTable: reference.rule.referencedTable,
        message: "سيتم تجاهل حجز رقم قيد قديم لأن المستند المصدر لم يعد موجودًا في النسخة",
      });
      continue;
    }
    if (
      reference.sourceMissing
      && !canSynthesizeMissingRestoreReference(reference)
      && columnMeta.get(`${reference.table}.${reference.column}`)?.nullable !== true
    ) {
      issues.push({
        severity: "error",
        code: "missing_reference_row",
        table: reference.table,
        column: reference.column,
        rowId: reference.rowId,
        sourceValue: reference.sourceValue,
        referencedTable: reference.rule.referencedTable,
        message: `تعذر إعادة ربط ${reference.table}.${reference.column} لأنه مطلوب وغير موجود في النسخة`,
      });
    }
  }
  const postedJournalIds = new Set(
    (payload.data.journal_entries ?? [])
      .filter((entry) => String(entry.status ?? "").toLowerCase() === "posted")
      .map((entry) => restoreReferenceKey(entry.id)),
  );
  const sourceJournalBalances = new Map<string, number>();
  for (const line of payload.data.journal_entry_lines ?? []) {
    const entryKey = restoreReferenceKey(line.entry_id);
    if (!postedJournalIds.has(entryKey)) continue;
    const balance = sourceJournalBalances.get(entryKey) ?? 0;
    sourceJournalBalances.set(entryKey, balance + Number(line.debit ?? 0) - Number(line.credit ?? 0));
  }
  for (const [entryKey, balance] of sourceJournalBalances) {
    if (Math.abs(balance) < 0.005) continue;
    issues.push({
      severity: "error",
      code: "unbalanced_journal_entry",
      table: "journal_entries",
      column: "id",
      rowId: entryKey,
      sourceValue: balance,
      message: `القيد المرحل ${entryKey} غير متوازن داخل النسخة (${balance.toFixed(2)})`,
    });
  }
  const integrity: FullCompanyIntegrityReport = {
    ok: !issues.some((issue) => issue.severity === "error"),
    phase: "preflight",
    sourceCompanyId: payload.meta.companyId,
    targetCompanyId: companyId,
    checkedAt: new Date().toISOString(),
    summary: {
      tables: Object.keys(tables).length,
      rows: Object.values(payload.data).reduce((total, tableRows) => total + tableRows.length, 0),
      physicalReferences,
      logicalReferences: referencePlan.checked,
      physicalForeignKeysSkipped: referencePlan.physicalForeignKeysSkipped,
      remapped: 0,
      audited: 0,
    },
    issues: issues.slice(0, 1_000),
  };
  return { actual, tables, columnMeta, referencePlan, integrity };
}

export async function preflightFullCompanyBackup(
  companyId: number,
  payload: FullCompanyPayload,
): Promise<FullCompanyIntegrityReport> {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error("Invalid company id");
  const manifestTables = validateRestoreManifest(payload);
  return db.transaction(async (tx) =>
    (await analyzeRestore(tx, companyId, payload, manifestTables)).integrity);
}

function rememberMappedValue(map: Map<unknown, unknown>, source: unknown, target: unknown): void {
  map.set(source, target);
  map.set(restoreReferenceKey(source), target);
}

function mappedValue(map: Map<unknown, unknown> | undefined, source: unknown): unknown {
  if (!map) return undefined;
  return map.get(source) ?? map.get(restoreReferenceKey(source));
}

function remapLogicalValue(
  rule: RestoreReferenceRule,
  sourceValue: unknown,
  maps: Map<string, Map<unknown, unknown>>,
): { value: unknown; targetIds: unknown[]; remapped: number } {
  const values = rule.shape === "array" ? sourceValue : [sourceValue];
  if (!Array.isArray(values)) throw new Error(`Invalid ${rule.referencedTable} reference array`);
  const targetIds: unknown[] = [];
  let remapped = 0;
  const mapped = values.map((value) => {
    if (value == null || (rule.allowZero && Number(value) === 0)) return value;
    const target = mappedValue(maps.get(rule.referencedTable), value);
    if (target === undefined) throw new Error(`Unresolved logical reference to ${rule.referencedTable}`);
    targetIds.push(target);
    remapped++;
    return target;
  });
  return { value: rule.shape === "array" ? mapped : mapped[0], targetIds, remapped };
}

export async function restoreFullCompanyBackup(
  companyId: number,
  payload: FullCompanyPayload,
  options: FullCompanyRestoreOptions = {},
): Promise<FullCompanyRestoreResult> {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error("Invalid company id");
  const manifestTables = validateRestoreManifest(payload);
  return db.transaction(async (tx) => {
    const analysis = await analyzeRestore(tx, companyId, payload, manifestTables);
    if (!analysis.integrity.ok) throw new FullCompanyIntegrityError(analysis.integrity);
    const { actual, tables, columnMeta, referencePlan } = analysis;
    const report: Record<string, RestoreTableReport> = {};
    for (const [name, table] of Object.entries(tables)) {
      const live = actual[name];
      if (!live) throw new Error(`Backup table is not available: ${name}`);
      if (!Array.isArray(payload.data[name])) throw new Error(`Backup data for ${name} must be an array`);
      if (payload.counts?.[name] !== payload.data[name].length) throw new Error(`Backup count mismatch for ${name}`);
      for (const record of payload.data[name]) for (const key of Object.keys(record)) {
        if (!manifestTables[name].columns.includes(key)) throw new Error(`Unexpected column ${name}.${key}`);
      }
    }
    const sourceUsernames = (payload.data.users ?? [])
      .map((record) => record.username)
      .filter((username): username is string => typeof username === "string" && username.trim().length > 0);
    const sourceUsernameFilter = sourceUsernames.length
      ? sql`AND u."username" NOT IN (${sql.join(sourceUsernames.map((username) => sql`${username}`), sql`,`)})`
      : sql.empty();
    const preservedBranchGrants = actual.user_branches && actual.branches && actual.users
      ? rows(await tx.execute(sql`
          SELECT u."id" AS "user_id", b."code" AS "branch_code"
          FROM "user_branches" ub
          JOIN "users" u ON u."id" = ub."user_id"
          JOIN "branches" b ON b."id" = ub."branch_id"
          WHERE u."company_id" = ${companyId} ${sourceUsernameFilter}`))
      : [];
    // Child first delete with savepoints/retries, while never deleting user/control state.
    let pending = Object.keys(tables).filter((n) => !PROTECTED_RESTORE_TABLES.has(n));
    for (let pass = 0; pending.length && pass < 8; pass++) {
      const next: string[] = []; let progress = false;
      for (const name of pending) {
        const savepoint = `backup_delete_${pass}_${name}`;
        try {
          await tx.execute(sql.raw(`SAVEPOINT ${ident(savepoint)}`));
          await tx.execute(sql`DELETE FROM ${sql.raw(ident(name))} AS ${sql.raw(ident("target"))}
            WHERE ${tenantPredicate(name, tables, companyId)}`);
          await tx.execute(sql.raw(`RELEASE SAVEPOINT ${ident(savepoint)}`)); progress = true;
        } catch (error) {
          await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${ident(savepoint)}`));
          await tx.execute(sql.raw(`RELEASE SAVEPOINT ${ident(savepoint)}`)); next.push(name);
        }
      }
      if (!progress) throw new Error(`Cannot replace tenant data; foreign-key delete blocked: ${next.join(", ")}`);
      pending = next;
    }
    if (pending.length) throw new Error(`Cannot replace tenant data: ${pending.join(", ")}`);
    const maps = new Map<string, Map<unknown, unknown>>();
    for (const name of Object.keys(tables)) maps.set(name, new Map());
    const restoreSourceIndexes = sourceReferenceIndexes(payload, tables);
    const restoreSourceTupleIndexes = sourceForeignKeyTupleIndexes(payload, tables);
    const deferred: Array<{ table: BackupTable; pk: unknown; group: ForeignKeyGroup; sourceTuple: unknown[] }> = [];
    const compositeTupleMaps = new Map<string, Map<string, unknown[]>>();
    const logicalDeferred: PlannedRestoreReference[] = [];
    const logicalByRow = new Map<string, PlannedRestoreReference[]>();
    for (const reference of referencePlan.references.filter((item) => item.table !== "companies")) {
      const rowKey = `${reference.table}\0${restoreReferenceKey(reference.rowId)}`;
      const current = logicalByRow.get(rowKey) ?? [];
      current.push(reference);
      logicalByRow.set(rowKey, current);
    }
    // Historical business/audit rows can legitimately outlive the user who
    // created them. Preserve those rows and their attribution by mapping every
    // absent source user to a deterministic, disabled archive identity instead
    // of rejecting the backup, nulling a required column, or assigning the
    // action to an unrelated live user that happens to share the old numeric ID.
    const usersTable = tables.users;
    const liveUsersTable = actual.users;
    if (usersTable?.primaryKey && liveUsersTable?.primaryKey) {
      const sourceUserIds = new Set(
        (payload.data.users ?? [])
          .map((row) => row[usersTable.primaryKey!])
          .filter((value) => value != null)
          .map(restoreReferenceKey),
      );
      const missingUserIds = new Map<string, unknown>();
      const rememberMissingUser = (value: unknown) => {
        if (value == null || sourceUserIds.has(restoreReferenceKey(value))) return;
        missingUserIds.set(restoreReferenceKey(value), value);
      };
      for (const reference of referencePlan.references) {
        if (!canSynthesizeMissingRestoreReference(reference)) continue;
        const values = reference.rule.shape === "array" ? reference.sourceValue : [reference.sourceValue];
        if (Array.isArray(values)) for (const value of values) rememberMissingUser(value);
      }
      for (const [tableName, table] of Object.entries(tables)) {
        for (const foreignKey of table.foreignKeys.filter((fk) => fk.referencedTable === "users")) {
          for (const row of payload.data[tableName] ?? []) rememberMissingUser(row[foreignKey.column]);
        }
      }
      for (const sourceUserId of missingUserIds.values()) {
        const username = archivedRestoreUsername(companyId, sourceUserId);
        let archived = rows(await tx.execute(sql`
          SELECT "id" FROM "users"
          WHERE "company_id" = ${companyId} AND "username" = ${username}
          LIMIT 1
        `))[0];
        if (!archived) {
          const archiveValues: Record<string, unknown> = {
            username,
            password_hash: "!backup-import-disabled!",
            company_id: companyId,
            role: "user",
            email: null,
            name_ar: "مستخدم أرشيفي محذوف",
            name_en: "Archived deleted user",
            is_active: false,
            active: false,
          };
          const archiveColumns = Object.keys(archiveValues)
            .filter((column) => liveUsersTable.columns.includes(column));
          const inserted = rows(await tx.execute(sql`
            INSERT INTO "users" (${sql.raw(archiveColumns.map(ident).join(","))})
            VALUES (${sql.join(archiveColumns.map((column) => sql.param(archiveValues[column])), sql`,`)})
            ON CONFLICT DO NOTHING
            RETURNING "id"
          `));
          archived = inserted[0] ?? rows(await tx.execute(sql`
            SELECT "id" FROM "users"
            WHERE "company_id" = ${companyId} AND "username" = ${username}
            LIMIT 1
          `))[0];
        }
        if (!archived?.id) throw new Error(`Cannot create archived restore user for ${String(sourceUserId)}`);
        rememberMappedValue(maps.get("users")!, sourceUserId, archived.id);
      }
    }
    const rememberCompositeTargetTuples = (
      name: string,
      table: BackupTable,
      source: Record<string, unknown>,
      targetValues: Record<string, unknown>,
      newId: unknown,
    ) => {
      for (const consumer of Object.values(tables)) {
        for (const group of foreignKeyGroups(consumer).filter((candidate) =>
          candidate.foreignKeys.length > 1 && candidate.referencedTable === name)) {
          const sourceTuple = group.foreignKeys.map((fk) => source[fk.referencedColumn]);
          if (sourceTuple.some((value) => value == null)) continue;
          const mappedTuple = compositeTargetTuple(group, table, source, targetValues, newId);
          const tupleMap = compositeTupleMaps.get(group.key) ?? new Map<string, unknown[]>();
          tupleMap.set(mappedTuple.sourceKey, mappedTuple.targetTuple);
          compositeTupleMaps.set(group.key, tupleMap);
        }
      }
    };
    for (const name of topologicalTableOrder(tables)) {
      const table = tables[name]; const records = Array.isArray(payload.data[name]) ? payload.data[name] : [];
      report[name] = { received: records.length, inserted: 0, updated: 0 };
      for (const sourceRecord of records) {
        let source = sourceRecord;
        const orphanedAuditUser = (
          name === "audit_log"
          && source.user_id != null
          && mappedValue(maps.get("users"), source.user_id) === undefined
        );
        if (orphanedAuditUser && columnMeta.get("audit_log.user_id")?.nullable === true) {
          source = { ...source, user_id: null };
        } else if (orphanedAuditUser) {
          // On legacy targets where audit_log.user_id is truly NOT NULL, keep
          // the business restore compatible by dropping only the orphaned
          // historical audit row rather than rejecting the whole backup.
          continue;
        }
        if (PROTECTED_RESTORE_TABLES.has(name)) {
          if (!table.primaryKey) throw new Error("Users table must have a scalar primary key");
          const username = source.username;
          if (typeof username !== "string" || !username.trim()) throw new Error("Backup user has no username");
          const [liveUsername, restoreUsername] = restoredUsernames(
            username,
            companyId,
            source[table.primaryKey],
          );
          // Users are deliberately preserved so the operator cannot lock
          // themselves out. A repeated restore must therefore reuse either
          // the live account or the deterministic disabled restore account
          // created by an earlier import instead of inserting it again.
          const found = rows(await tx.execute(sql`
            SELECT "id" FROM "users"
            WHERE "company_id" = ${companyId}
              AND "username" IN (${liveUsername}, ${restoreUsername})
            ORDER BY CASE WHEN "username" = ${liveUsername} THEN 0 ELSE 1 END
            LIMIT 1
          `))[0];
          if (found) {
            rememberMappedValue(maps.get(name)!, source[table.primaryKey], found.id);
            rememberCompositeTargetTuples(
              name,
              table,
              source,
              { company_id: companyId },
              found.id,
            );
            continue;
          }
          // Restored users are intentionally disabled. Always give a newly
          // inserted user a restore-only identity so old agent schemas that
          // still enforce global username/email uniqueness cannot collide.
          source = {
            ...source,
            username: restoreUsername,
            email: null,
            is_trainee: false,
            session_token: null,
            session_id: null,
            session_channel: null,
            current_session_id: null,
          };
        }
        const values: Record<string, unknown> = {};
        for (const col of table.columns) {
          if (col !== table.primaryKey && !isSensitiveColumn(col) && col in source) {
            const meta = columnMeta.get(`${name}.${col}`);
            // Older agents sometimes added new user flags as nullable columns,
            // while current servers enforce NOT NULL with a default. Omitting
            // an explicit legacy NULL lets PostgreSQL apply the safe live
            // default. Other business rows retain exact value semantics.
            if (name === "users" && source[col] == null && meta && !meta.nullable && meta.hasDefault) {
              continue;
            }
            values[col] = restoreParameterValue(meta?.dataType, source[col]);
          }
        }
        if (table.classification !== "dependent-child" && table.columns.includes("company_id")) {
          values.company_id = companyId;
        }
        if (name === "users") {
          values.password_hash = "!backup-import-disabled!";
          if (table.columns.includes("is_active")) values.is_active = false;
          if (table.columns.includes("active")) values.active = false;
        }
        if (table.primaryKey) {
          const rowKey = `${name}\0${restoreReferenceKey(source[table.primaryKey])}`;
          const rowReferences = logicalByRow.get(rowKey) ?? [];
          if (rowReferences.some(canDropMissingRestoreReferenceOwner)) {
            continue;
          }
          for (const reference of rowReferences) {
            if (!(reference.column in values)) continue;
            if (reference.sourceMissing) {
              if (reference.rule.referencedTable === "users") {
                const remapped = remapLogicalValue(reference.rule, reference.sourceValue, maps);
                values[reference.column] = restoreParameterValue(
                  columnMeta.get(`${name}.${reference.column}`)?.dataType,
                  remapped.value,
                );
              } else if (columnMeta.get(`${name}.${reference.column}`)?.nullable === true) {
                values[reference.column] = null;
              }
              continue;
            }
            logicalDeferred.push(reference);
            if (columnMeta.get(`${name}.${reference.column}`)?.nullable) {
              values[reference.column] = null;
            }
          }
        }
        for (const group of foreignKeyGroups(table).filter((candidate) => candidate.foreignKeys.length > 1)) {
          const sourceTuple = group.foreignKeys.map((fk) => source[fk.column]);
          if (sourceTuple.some((value) => value == null)) continue;
          const mappedTuple = compositeTupleMaps.get(group.key)?.get(tupleKey(sourceTuple));
          if (mappedTuple) {
            group.foreignKeys.forEach((fk, index) => {
              values[fk.column] = mappedTuple[index];
            });
            continue;
          }
          const parentCount = restoreSourceTupleIndexes.get(group.key)?.get(tupleKey(sourceTuple)) ?? 0;
          const nullableParts = group.foreignKeys.filter((fk) =>
            columnMeta.get(`${name}.${fk.column}`)?.nullable === true);
          if (parentCount === 0 && nullableParts.length) {
            for (const fk of nullableParts) values[fk.column] = null;
          } else if (nullableParts.length) {
            deferred.push({ table, pk: source[table.primaryKey ?? "id"], group, sourceTuple });
            // MATCH SIMPLE is safely deferred by nulling one nullable tuple
            // component; tenant/project scope columns remain correctly mapped
            // by their own relationships.
            values[nullableParts[0].column] = null;
          } else {
            throw new Error(`Unresolved required composite FK ${name}.(${group.foreignKeys.map((fk) => fk.column).join(",")})`);
          }
        }
        for (const fk of table.foreignKeys.filter((candidate) => (candidate.size ?? 1) === 1)) if (values[fk.column] != null) {
          // Always resolve from the source row. A column may also participate
          // in a composite FK which has already written its target tuple into
          // `values`; feeding that target ID back into a source-ID map can
          // silently bind to an unrelated row when numeric IDs overlap.
          const sourceFkValue = source[fk.column];
          const mapped = mappedValue(maps.get(fk.referencedTable), sourceFkValue);
          if (mapped !== undefined) values[fk.column] = mapped;
          else if (
            name === "audit_log"
            && fk.column === "user_id"
            && columnMeta.get("audit_log.user_id")?.nullable === true
          ) values[fk.column] = null;
          else {
            const sourceCount = restoreSourceIndexes
              .get(fk.referencedTable)
              ?.get(fk.referencedColumn)
              ?.get(restoreReferenceKey(sourceFkValue)) ?? 0;
            if (
              sourceCount === 0
              && columnMeta.get(`${name}.${fk.column}`)?.nullable === true
            ) {
              values[fk.column] = null;
            } else if (fk.nullable) {
              deferred.push({
                table,
                pk: source[table.primaryKey ?? "id"],
                group: { key: `legacy:${fk.column}:${fk.referencedTable}:${fk.referencedColumn}`, foreignKeys: [fk], referencedTable: fk.referencedTable },
                sourceTuple: [sourceFkValue],
              });
              values[fk.column] = null;
            } else {
              throw new Error(`Unresolved required FK ${name}.${fk.column}`);
            }
          }
        }
        const columns = Object.keys(values); if (!columns.length) throw new Error(`No restorable columns for ${name}`);
        const returning = table.primaryKey ? sql` RETURNING ${sql.raw(ident(table.primaryKey))}` : sql.empty();
        const productionShiftBusinessKey = name === "production_shifts"
          && columns.includes("company_id")
          && columns.includes("code");
        const updateColumns = columns.filter((column) => column !== "company_id" && column !== "code");
        let didUpdate = false;
        let inserted: Record<string, unknown>[];
        if (productionShiftBusinessKey) {
          const existing = rows(await tx.execute(sql`
            SELECT ${sql.raw(ident(table.primaryKey ?? "id"))}
            FROM "production_shifts"
            WHERE "company_id" = ${values.company_id} AND "code" = ${values.code}
            LIMIT 1
          `))[0];
          if (existing && updateColumns.length) {
            inserted = rows(await tx.execute(sql`
              UPDATE "production_shifts"
              SET ${sql.join(
                updateColumns.map((column) =>
                  sql`${sql.raw(ident(column))} = ${sql.param(values[column])}`),
                sql`,`,
              )}
              WHERE ${sql.raw(ident(table.primaryKey ?? "id"))} = ${existing[table.primaryKey ?? "id"]}
              ${returning}
            `));
            didUpdate = true;
          } else {
            inserted = rows(await tx.execute(sql`INSERT INTO ${sql.raw(ident(name))}
              (${sql.raw(columns.map(ident).join(","))}) VALUES (${sql.join(columns.map((column) => sql.param(values[column])), sql`,`)})
              ${returning}`));
          }
        } else {
          inserted = rows(await tx.execute(sql`INSERT INTO ${sql.raw(ident(name))}
            (${sql.raw(columns.map(ident).join(","))}) VALUES (${sql.join(columns.map((column) => sql.param(values[column])), sql`,`)})
            ${returning}`));
        }
        const newId = table.primaryKey ? inserted[0]?.[table.primaryKey] : undefined;
        if (table.primaryKey && newId == null) throw new Error(`Insert did not return primary key for ${name}`);
        if (table.primaryKey) {
          const ownMap = maps.get(name)!;
          rememberMappedValue(ownMap, source[table.primaryKey], newId);
          // Most relationships target the PK, but catalog metadata also permits
          // a single-column FK to a unique business column.
          for (const consumer of Object.values(tables)) {
            for (const fk of consumer.foreignKeys.filter((candidate) =>
              candidate.referencedTable === name && (candidate.size ?? 1) === 1)) {
              if (source[fk.referencedColumn] != null) {
                rememberMappedValue(ownMap, source[fk.referencedColumn], newId);
              }
            }
          }
        }
        rememberCompositeTargetTuples(name, table, source, values, newId);
        if (didUpdate) report[name].updated++;
        else report[name].inserted++;
      }
    }
    for (const item of deferred) {
      const mappedPk = mappedValue(maps.get(item.table.name), item.pk);
      const mappedTuple = item.group.foreignKeys.length === 1
        ? [mappedValue(maps.get(item.group.referencedTable), item.sourceTuple[0])]
        : compositeTupleMaps.get(item.group.key)?.get(tupleKey(item.sourceTuple));
      if (!mappedTuple || mappedTuple.some((value) => value === undefined) || mappedPk === undefined) {
        throw new Error(`Unresolved cyclic FK ${item.table.name}.(${item.group.foreignKeys.map((fk) => fk.column).join(",")})`);
      }
      await tx.execute(sql`UPDATE ${sql.raw(ident(item.table.name))} SET ${sql.join(
          item.group.foreignKeys.map((fk, index) =>
            sql`${sql.raw(ident(fk.column))} = ${mappedTuple[index]}`),
          sql`,`,
        )}
        WHERE ${sql.raw(ident(item.table.primaryKey ?? "id"))} = ${mappedPk}`);
      report[item.table.name].updated++;
    }
    const ownershipAuditIds = new Map<string, Map<string, unknown>>();
    let remappedReferences = 0;
    let auditedReferences = 0;
    const rememberAuditTarget = (tableName: string, targetId: unknown) => {
      const current = ownershipAuditIds.get(tableName) ?? new Map<string, unknown>();
      current.set(restoreReferenceKey(targetId), targetId);
      ownershipAuditIds.set(tableName, current);
    };
    for (const [tableName, idMap] of maps) {
      if (!actual[tableName]?.columns.includes("company_id")) continue;
      for (const targetId of idMap.values()) rememberAuditTarget(tableName, targetId);
    }
    for (const reference of logicalDeferred) {
      const table = tables[reference.table];
      const mappedPk = mappedValue(maps.get(reference.table), reference.rowId);
      if (!table?.primaryKey || mappedPk === undefined) {
        throw new Error(`Unresolved logical-reference owner ${reference.table}.${reference.column}`);
      }
      const remapped = remapLogicalValue(reference.rule, reference.sourceValue, maps);
      const restoredValue = restoreParameterValue(
        columnMeta.get(`${reference.table}.${reference.column}`)?.dataType,
        remapped.value,
      );
      const updated = rows(await tx.execute(sql`
        UPDATE ${sql.raw(ident(reference.table))}
        SET ${sql.raw(ident(reference.column))} = ${sql.param(restoredValue)}
        WHERE ${sql.raw(ident(table.primaryKey))} = ${mappedPk}
        RETURNING ${sql.raw(ident(reference.column))}
      `))[0];
      if (!updated) throw new Error(`Logical-reference owner disappeared: ${reference.table}.${reference.column}`);
      const persisted = cell(updated, reference.column);
      if (JSON.stringify(persisted) !== JSON.stringify(remapped.value)) {
        throw new Error(`Logical-reference audit mismatch: ${reference.table}.${reference.column}`);
      }
      for (const targetId of remapped.targetIds) rememberAuditTarget(reference.rule.referencedTable, targetId);
      remappedReferences += remapped.remapped;
      auditedReferences += remapped.remapped;
      report[reference.table].updated++;
    }
    if (report.user_branches) {
      for (const grant of preservedBranchGrants) {
        const branchCode = cell(grant, "branch_code");
        const userId = cell(grant, "user_id");
        const inserted = rows(await tx.execute(sql`
          INSERT INTO "user_branches" ("user_id", "branch_id")
          SELECT ${userId}, b."id" FROM "branches" b
          WHERE b."company_id" = ${companyId} AND b."code" = ${branchCode}
          ON CONFLICT DO NOTHING RETURNING "user_id"`));
        if (inserted.length) report.user_branches.updated++;
      }
    }
    if (payload.companySettings) {
      const liveCompanyColumns = new Set(rows(await tx.execute(sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'companies'`)).map((row) => String(cell(row, "column_name"))));
      const safe = Object.fromEntries(Object.entries(payload.companySettings).filter(([key]) => {
        const rule = resolveRestoreReferenceRule("companies", key, payload.companySettings!);
        const registeredReference = !!rule && typeof rule !== "string";
        return IDENT.test(key) && liveCompanyColumns.has(key) && !isSensitiveColumn(key)
          && (!UNSAFE_COMPANY_SETTING.test(key) || registeredReference);
      }));
      for (const [column, sourceValue] of Object.entries(safe)) {
        if (sourceValue == null) continue;
        const rule = resolveRestoreReferenceRule("companies", column, payload.companySettings);
        if (!rule || typeof rule === "string") continue;
        const remapped = remapLogicalValue(rule, sourceValue, maps);
        safe[column] = remapped.value;
        for (const targetId of remapped.targetIds) rememberAuditTarget(rule.referencedTable, targetId);
        remappedReferences += remapped.remapped;
        auditedReferences += remapped.remapped;
      }
      const columns = Object.keys(safe);
      if (columns.length) await tx.execute(sql`UPDATE "companies" SET ${sql.join(columns.map((column) =>
        sql`${sql.raw(ident(column))} = ${sql.param(
          restoreParameterValue(columnMeta.get(`companies.${column}`)?.dataType, safe[column]),
        )}`), sql`, `)} WHERE "id" = ${companyId}`);
    }
    await reconcilePostgresSequences(tx, { tables: Object.keys(tables) });
    for (const [referencedTable, targetMap] of ownershipAuditIds) {
      if (!targetMap.size) continue;
      const table = actual[referencedTable];
      if (!table?.primaryKey) throw new Error(`Cannot audit ownership for ${referencedTable}`);
      const targetIds = [...targetMap.values()];
      const companyFilter = table.columns.includes("company_id")
        ? sql` AND ${sql.raw(ident("company_id"))} = ${companyId}`
        : sql.empty();
      const found = Number(cell(rows(await tx.execute(sql`
        SELECT count(*)::int AS "count"
        FROM ${sql.raw(ident(referencedTable))}
        WHERE ${sql.raw(ident(table.primaryKey))} IN (${sql.join(targetIds.map((id) => sql`${id}`), sql`,`)})
        ${companyFilter}
      `))[0] ?? {}, "count") ?? 0);
      if (found !== targetMap.size) {
        const integrity: FullCompanyIntegrityReport = {
          ...analysis.integrity,
          ok: false,
          phase: "completed",
          issues: [{
            severity: "error",
            code: "missing_reference_row",
            table: referencedTable,
            column: table.primaryKey,
            rowId: null,
            sourceValue: targetIds,
            referencedTable,
            message: `فشل تدقيق ملكية المراجع المعاد ربطها في ${referencedTable}`,
          }],
          summary: {
            ...analysis.integrity.summary,
            remapped: remappedReferences,
            audited: auditedReferences,
          },
        };
        throw new FullCompanyIntegrityError(integrity);
      }
      auditedReferences += targetMap.size;
    }
    if (actual.journal_entries && actual.journal_entry_lines) {
      const unbalanced = rows(await tx.execute(sql`
        SELECT je."id", COALESCE(SUM(jel."debit" - jel."credit"), 0)::numeric AS "balance"
        FROM "journal_entries" je
        LEFT JOIN "journal_entry_lines" jel ON jel."entry_id" = je."id"
        WHERE je."company_id" = ${companyId} AND je."status" = 'posted'
        GROUP BY je."id"
        HAVING ABS(COALESCE(SUM(jel."debit" - jel."credit"), 0)) >= 0.005
        LIMIT 20
      `));
      if (unbalanced.length) {
        const integrity: FullCompanyIntegrityReport = {
          ...analysis.integrity,
          ok: false,
          phase: "completed",
          issues: unbalanced.map((entry) => ({
            severity: "error" as const,
            code: "unbalanced_journal_entry",
            table: "journal_entries",
            column: "id",
            rowId: cell(entry, "id"),
            sourceValue: cell(entry, "balance"),
            message: `فشل تدقيق توازن القيد ${String(cell(entry, "id"))}`,
          })),
          summary: {
            ...analysis.integrity.summary,
            remapped: remappedReferences,
            audited: auditedReferences,
          },
        };
        throw new FullCompanyIntegrityError(integrity);
      }
    }
    if (options.beforeCommit) await options.beforeCommit();
    return {
      report,
      integrity: {
        ...analysis.integrity,
        ok: true,
        phase: "completed",
        checkedAt: new Date().toISOString(),
        summary: {
          ...analysis.integrity.summary,
          remapped: remappedReferences,
          audited: auditedReferences,
        },
      },
    };
  });
}
