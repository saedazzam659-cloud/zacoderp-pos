import { db } from "@workspace/db";
import * as schema from "@workspace/db";
import { sql, is } from "drizzle-orm";
import { PgTable, PgEnumColumn } from "drizzle-orm/pg-core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { PgEnum } from "drizzle-orm/pg-core";
import { logger } from "./logger";

let healPromise: Promise<void> | null = null;

interface ExistingColumn {
  table_name: string;
  column_name: string;
}

interface ExistingTable {
  table_name: string;
}

interface ExistingEnum {
  typname: string;
}

/**
 * Quote a Postgres identifier safely (table / column / type names).
 */
function qid(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a Postgres string literal safely.
 */
function qstr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Walk every export of `@workspace/db` and collect Drizzle entities we know
 * how to reconcile: pgTables (for column-level checks) and pgEnums (so we
 * can ensure missing enum types and labels exist).
 */
function collectSchemaEntities(): {
  tables: { name: string; columns: ReturnType<typeof getTableConfig>["columns"] }[];
  enums: { name: string; values: readonly string[] }[];
} {
  const tables: { name: string; columns: ReturnType<typeof getTableConfig>["columns"] }[] = [];
  const enums: { name: string; values: readonly string[] }[] = [];

  for (const exported of Object.values(schema as Record<string, unknown>)) {
    if (!exported) continue;
    // Tables are objects.
    if (typeof exported === "object" && is(exported as object, PgTable)) {
      const cfg = getTableConfig(exported as PgTable);
      tables.push({ name: cfg.name, columns: cfg.columns });
      continue;
    }
    // pgEnum() returns a callable function with metadata attached
    // (enumName + enumValues) — see drizzle-orm/pg-core/columns/enum. We
    // therefore have to inspect functions too, not just objects.
    if (typeof exported === "object" || typeof exported === "function") {
      const maybeEnum = exported as { enumName?: unknown; enumValues?: unknown };
      if (
        typeof maybeEnum.enumName === "string" &&
        Array.isArray(maybeEnum.enumValues) &&
        (maybeEnum.enumValues as unknown[]).every((v) => typeof v === "string")
      ) {
        enums.push({ name: maybeEnum.enumName, values: maybeEnum.enumValues as string[] });
      }
    }
  }

  return { tables, enums };
}

async function ensureEnums(enums: { name: string; values: readonly string[] }[]): Promise<string[]> {
  if (enums.length === 0) return [];
  const applied: string[] = [];

  // Pull existing enum types + their labels in one round-trip.
  const existingTypes = (await db.execute<ExistingEnum>(sql`
    SELECT typname FROM pg_type WHERE typtype = 'e'
  `)).rows as ExistingEnum[];
  const existingTypeSet = new Set(existingTypes.map((r) => r.typname));

  const existingLabels = (await db.execute<{ typname: string; enumlabel: string }>(sql`
    SELECT t.typname, e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
  `)).rows as { typname: string; enumlabel: string }[];
  const labelsByType = new Map<string, Set<string>>();
  for (const row of existingLabels) {
    if (!labelsByType.has(row.typname)) labelsByType.set(row.typname, new Set());
    labelsByType.get(row.typname)!.add(row.enumlabel);
  }

  for (const e of enums) {
    if (!existingTypeSet.has(e.name)) {
      const valuesSql = e.values.map(qstr).join(", ");
      const stmt = `CREATE TYPE ${qid(e.name)} AS ENUM (${valuesSql})`;
      await db.execute(sql.raw(stmt));
      applied.push(stmt);
      continue;
    }
    // Type exists — ensure every label is present (additive only).
    const have = labelsByType.get(e.name) ?? new Set<string>();
    for (const v of e.values) {
      if (!have.has(v)) {
        const stmt = `ALTER TYPE ${qid(e.name)} ADD VALUE IF NOT EXISTS ${qstr(v)}`;
        await db.execute(sql.raw(stmt));
        applied.push(stmt);
      }
    }
  }

  return applied;
}

async function ensureColumns(
  tables: { name: string; columns: ReturnType<typeof getTableConfig>["columns"] }[],
): Promise<{ applied: string[]; missingTables: string[] }> {
  const applied: string[] = [];
  const missingTables: string[] = [];

  // Snapshot which tables / columns currently exist in the public schema.
  const tableRows = (await db.execute<ExistingTable>(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `)).rows as ExistingTable[];
  const existingTables = new Set(tableRows.map((r) => r.table_name));

  const colRows = (await db.execute<ExistingColumn>(sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
  `)).rows as ExistingColumn[];
  const existingColsByTable = new Map<string, Set<string>>();
  for (const row of colRows) {
    if (!existingColsByTable.has(row.table_name)) existingColsByTable.set(row.table_name, new Set());
    existingColsByTable.get(row.table_name)!.add(row.column_name);
  }

  for (const t of tables) {
    if (!existingTables.has(t.name)) {
      // Creating brand-new tables safely is non-trivial (constraints, FKs,
      // defaults, etc). Skip and surface a warning so an operator can run
      // the proper migration once. The vast majority of production drift
      // is "I added a column" — that path *is* handled.
      missingTables.push(t.name);
      continue;
    }
    const haveCols = existingColsByTable.get(t.name) ?? new Set<string>();
    for (const col of t.columns) {
      if (haveCols.has(col.name)) continue;

      // Column type comes from drizzle's column.getSQLType() (e.g. "text",
      // "integer", "timestamp", "jsonb", "user_role"). For enum columns the
      // type *is* the enum type name and we already ensured it exists.
      const sqlType = col.getSQLType();

      // Build DEFAULT clause. drizzle stores `default` raw value or SQL.
      let defaultClause = "";
      if (col.default !== undefined && col.default !== null) {
        const def = col.default as unknown;
        if (typeof def === "string") defaultClause = ` DEFAULT ${qstr(def)}`;
        else if (typeof def === "number" || typeof def === "boolean") defaultClause = ` DEFAULT ${String(def)}`;
        else if (typeof def === "object" && def !== null && "queryChunks" in (def as object)) {
          // SQL object — render via drizzle (defaultNow(), sql\`...\`).
          // We can't easily inline; fall back to no default and let the app
          // handle it on insert.
          defaultClause = "";
        }
      } else if (col.defaultFn) {
        // Runtime-only default — handled by drizzle on insert.
        defaultClause = "";
      } else if ((col as unknown as { hasDefault?: boolean }).hasDefault) {
        defaultClause = "";
      }

      // Special-case the most common defaults that we know are SQL-generated.
      if (!defaultClause && (sqlType === "timestamp" || sqlType.startsWith("timestamp"))) {
        if ((col as unknown as { defaultNow?: boolean }).defaultNow) {
          defaultClause = " DEFAULT now()";
        }
      }

      // NOT NULL only when we can satisfy it for existing rows: either the
      // table is empty, or we have a default. Otherwise add the column as
      // nullable so the deploy doesn't crash mid-migration on legacy rows.
      let notNullClause = "";
      if (col.notNull && defaultClause) notNullClause = " NOT NULL";

      // ENUM types may need to be referenced by quoted name; getSQLType()
      // already returns the bare name. For pg_enum columns prefer the
      // explicit enum name from the column.
      let typeForSql = sqlType;
      if (col instanceof Object && (col as unknown as { enumValues?: unknown }).enumValues) {
        const enumName = (col as unknown as { enumName?: string; enum?: { enumName?: string } }).enumName
          ?? (col as unknown as { enum?: { enumName?: string } }).enum?.enumName;
        if (enumName) typeForSql = qid(enumName);
      } else if ((col as unknown) instanceof PgEnumColumn) {
        const e = (col as PgEnumColumn).enum as unknown as { enumName?: string };
        if (e?.enumName) typeForSql = qid(e.enumName);
      }

      const stmt = `ALTER TABLE ${qid(t.name)} ADD COLUMN IF NOT EXISTS ${qid(col.name)} ${typeForSql}${defaultClause}${notNullClause}`;
      try {
        await db.execute(sql.raw(stmt));
        applied.push(stmt);
      } catch (err) {
        logger.warn({ err, stmt }, "ensureSchema: failed to add column (continuing)");
      }
    }
  }

  return { applied, missingTables };
}

async function runHeal(): Promise<void> {
  const { tables, enums } = collectSchemaEntities();
  logger.info({ tableCount: tables.length, enumCount: enums.length }, "ensureSchema: starting schema reconciliation");

  let appliedEnumStmts: string[] = [];
  try {
    appliedEnumStmts = await ensureEnums(enums);
  } catch (err) {
    logger.error({ err }, "ensureSchema: enum reconciliation failed (continuing to columns)");
  }

  let appliedColStmts: string[] = [];
  let missingTables: string[] = [];
  try {
    const r = await ensureColumns(tables);
    appliedColStmts = r.applied;
    missingTables = r.missingTables;
  } catch (err) {
    logger.error({ err }, "ensureSchema: column reconciliation failed");
    throw err;
  }

  if (missingTables.length) {
    logger.warn(
      { missingTables },
      "ensureSchema: schema declares tables that don't exist in DB — run `pnpm db:push` or write a migration",
    );
  }
  logger.info(
    {
      enums: appliedEnumStmts.length,
      columns: appliedColStmts.length,
      sample: [...appliedEnumStmts, ...appliedColStmts].slice(0, 10),
    },
    "ensureSchema: reconciliation complete",
  );
}

/**
 * Idempotent self-healing migration that runs once on startup.
 *
 * Strategy (additive-only, safe for production):
 *   1. Walk the compiled-in `@workspace/db` schema and collect every pgTable
 *      and pgEnum.
 *   2. CREATE TYPE for any enum that's missing in the live DB; ALTER TYPE
 *      ADD VALUE IF NOT EXISTS for any enum label that was extended.
 *   3. ALTER TABLE ADD COLUMN IF NOT EXISTS for every column declared in the
 *      schema but missing in the DB. NOT NULL is only emitted when we have
 *      a usable DEFAULT, so legacy rows never block the migration.
 *   4. Tables that exist in code but not in the DB are surfaced as a warning
 *      — creating them safely requires a real migration tool because of
 *      foreign keys and constraints. (Adding columns is the >99% case for
 *      drift, and that *is* handled here.)
 *
 * The HTTP server awaits this before binding to `PORT`, so no request can
 * race the migration. Safe to call repeatedly.
 */
export function ensureSchemaUpToDate(): Promise<void> {
  if (!healPromise) healPromise = runHeal();
  return healPromise;
}
