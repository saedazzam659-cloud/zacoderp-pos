import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

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
const LEGACY_IGNORED_RESTORE_TABLES = new Set(["pos_devices"]);
const UNSAFE_COMPANY_SETTING = /(?:^|_)(?:id|company_id|code|status|domain|identity|subscription|plan|billing|backup|otp|token|secret|key|credential|agent|security)(?:_|$)|^(?:created_at|updated_at)$/i;

export type ForeignKey = {
  column: string; referencedTable: string; referencedColumn: string; nullable: boolean;
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
  return /(?:^|_)(?:attachment|file|image|photo|logo|signature|document|object|storage)(?:_|.*_)(?:path|url|key)$/i.test(column);
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
  return `${fk.column}\0${fk.referencedTable}\0${fk.referencedColumn}\0${fk.nullable ? "1" : "0"}`;
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
  const options = table.foreignKeys.filter((fk) => tables[fk.referencedTable]).map((fk, index) => {
    const parent = `owner_${name}_${index}`;
    const parentTable = tables[fk.referencedTable];
    return sql`EXISTS (SELECT 1 FROM ${sql.raw(ident(parentTable.name))} AS ${sql.raw(ident(parent))}
      WHERE ${sql.raw(`${ident(parent)}.${ident(fk.referencedColumn)}`)} =
        ${sql.raw(`${ident(alias)}.${ident(fk.column)}`)}
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
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS referenced_table,
      ccu.column_name AS referenced_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
      AND tc.table_schema=kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name
      AND ccu.table_schema=tc.table_schema
    WHERE tc.table_schema='public' AND tc.constraint_type='FOREIGN KEY'
      AND (SELECT count(*) FROM information_schema.key_column_usage one_col
           WHERE one_col.constraint_name=tc.constraint_name AND one_col.table_schema=tc.table_schema)=1`));
  const compositeFkRows = rows(await tx.execute(sql`
    SELECT tc.table_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
      AND tc.table_schema=kcu.table_schema
    WHERE tc.table_schema='public' AND tc.constraint_type='FOREIGN KEY'
    GROUP BY tc.table_name, tc.constraint_name HAVING count(*) > 1`));
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
  const selectedComposite = compositeFkRows
    .map((record) => String(cell(record, "table_name")))
    .filter((name) => selected.has(name));
  if (selectedComposite.length) {
    throw new Error(`Composite foreign keys are not supported by full-company backup: ${[...new Set(selectedComposite)].join(", ")}`);
  }
  for (const f of fkRows) {
    const child = String(cell(f, "table_name")); const parent = String(cell(f, "referenced_table"));
    if (selected.has(child) && selected.has(parent)) selected.get(child)!.foreignKeys.push({
      column: String(cell(f, "column_name")), referencedTable: parent,
      referencedColumn: String(cell(f, "referenced_column")),
      nullable: nullable.get(`${child}.${String(cell(f, "column_name"))}`) === true,
    });
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
        for (const fk of table.foreignKeys) {
          const parents = data[fk.referencedTable] ?? [];
          const ids = parents.map((r) => r[fk.referencedColumn]).filter((v) => v != null);
          if (!ids.length) continue;
          const found = rows(await tx.execute(sql`SELECT * FROM ${sql.raw(ident(table.name))}
            WHERE ${sql.raw(ident(fk.column))} IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`))
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

export async function restoreFullCompanyBackup(companyId: number, payload: FullCompanyPayload): Promise<Record<string, { received: number; inserted: number; updated: number }>> {
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
  return db.transaction(async (tx) => {
    const report: Record<string, { received: number; inserted: number; updated: number }> = {};
    const actual = await catalog(tx);
    if (!restoreCatalogsCompatible(manifestTables, actual)) {
      throw new Error(
        "تعذر استعادة النسخة لأن إصدار جداول بيانات الشركة يختلف بين الخادم المصدر والهدف. حدّث الخادمين إلى الإصدار نفسه ثم أعد المحاولة.",
      );
    }
    const tables = { ...manifestTables };
    for (const name of PROTECTED_RESTORE_TABLES) {
      if (actual[name] && manifestTables[name]) tables[name] = actual[name];
    }
    const columnMeta = new Map<string, {
      dataType: string; nullable: boolean; hasDefault: boolean;
    }>();
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
    const maps = new Map<string, Map<unknown, unknown>>(); const deferred: Array<{ table: BackupTable; pk: unknown; fk: ForeignKey; source: unknown }> = [];
    for (const name of topologicalTableOrder(tables)) {
      const table = tables[name]; const records = Array.isArray(payload.data[name]) ? payload.data[name] : [];
      report[name] = { received: records.length, inserted: 0, updated: 0 }; maps.set(name, new Map());
      for (const sourceRecord of records) {
        let source = sourceRecord;
        if (PROTECTED_RESTORE_TABLES.has(name)) {
          if (!table.primaryKey) throw new Error("Users table must have a scalar primary key");
          const username = source.username;
          if (typeof username !== "string" || !username.trim()) throw new Error("Backup user has no username");
          const found = rows(await tx.execute(sql`SELECT "id" FROM "users" WHERE "company_id" = ${companyId} AND "username" = ${username}`))[0];
          if (found) { maps.get(name)!.set(source[table.primaryKey], found.id); continue; }
          // Restored users are intentionally disabled. Always give a newly
          // inserted user a restore-only identity so old agent schemas that
          // still enforce global username/email uniqueness cannot collide.
          source = {
            ...source,
            username: restoredUsername(username, companyId, source[table.primaryKey]),
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
        for (const fk of table.foreignKeys) if (values[fk.column] != null) {
          const mapped = maps.get(fk.referencedTable)?.get(values[fk.column]);
          if (mapped !== undefined) values[fk.column] = mapped;
          else if (fk.nullable) { deferred.push({ table, pk: source[table.primaryKey ?? "id"], fk, source: values[fk.column] }); values[fk.column] = null; }
          else throw new Error(`Unresolved required FK ${name}.${fk.column}`);
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
          ownMap.set(source[table.primaryKey], newId);
          // Most relationships target the PK, but catalog metadata also permits
          // a single-column FK to a unique business column.
          for (const consumer of Object.values(tables)) {
            for (const fk of consumer.foreignKeys.filter((candidate) => candidate.referencedTable === name)) {
              if (source[fk.referencedColumn] != null) ownMap.set(source[fk.referencedColumn], newId);
            }
          }
        }
        if (didUpdate) report[name].updated++;
        else report[name].inserted++;
      }
    }
    for (const item of deferred) {
      const mappedFk = maps.get(item.fk.referencedTable)?.get(item.source);
      const mappedPk = maps.get(item.table.name)?.get(item.pk);
      if (mappedFk === undefined || mappedPk === undefined) throw new Error(`Unresolved cyclic FK ${item.table.name}.${item.fk.column}`);
      await tx.execute(sql`UPDATE ${sql.raw(ident(item.table.name))} SET ${sql.raw(ident(item.fk.column))} = ${mappedFk}
        WHERE ${sql.raw(ident(item.table.primaryKey ?? "id"))} = ${mappedPk}`);
      report[item.table.name].updated++;
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
      const safe = Object.fromEntries(Object.entries(payload.companySettings).filter(([key]) =>
        IDENT.test(key) && liveCompanyColumns.has(key) && !isSensitiveColumn(key) && !UNSAFE_COMPANY_SETTING.test(key)));
      const columns = Object.keys(safe);
      if (columns.length) await tx.execute(sql`UPDATE "companies" SET ${sql.join(columns.map((column) =>
        sql`${sql.raw(ident(column))} = ${sql.param(
          restoreParameterValue(columnMeta.get(`companies.${column}`)?.dataType, safe[column]),
        )}`), sql`, `)} WHERE "id" = ${companyId}`);
    }
    return report;
  });
}