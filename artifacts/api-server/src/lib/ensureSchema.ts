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

/**
 * Reconcile the per-tenant identity model: usernames must be unique
 * PER company (not globally), the SuperAdmin keyspace (company_id IS NULL)
 * stays globally unique, and every company carries a public `code`
 * (e.g. ZTC-42) that the user types at login.
 *
 * Drizzle's pgTable doesn't yet have first-class partial-index support
 * we can rely on across schema-push, so we materialise the constraints
 * here as raw SQL. All statements are idempotent and additive — safe
 * to re-run on every boot.
 */
async function ensureTenantIdentityIndexes(): Promise<string[]> {
  const applied: string[] = [];
  const stmts: { label: string; sql: string }[] = [
    // Drop the legacy global-unique on users.username if it survived.
    { label: "drop legacy users_username_unique", sql: `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_unique` },
    { label: "drop legacy users_username_key",    sql: `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key` },
    // Tenant users: (company_id, username) is unique per company.
    { label: "users_company_username_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS users_company_username_uniq ON users (company_id, username) WHERE company_id IS NOT NULL` },
    // SuperAdmins (company_id IS NULL): username stays globally unique.
    { label: "users_username_superadmin_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS users_username_superadmin_uniq ON users (username) WHERE company_id IS NULL` },
    // companies.code is unique whenever populated.
    { label: "companies_code_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS companies_code_uniq ON companies (code) WHERE code IS NOT NULL` },
    // ─── Sales-rep ↔ user 1:1 link (per company). Partial unique so reps without
    // a login (external/freelancer) are allowed (user_id NULL). Same user can
    // never be linked to two reps in the same company.
    { label: "sales_reps_user_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS sales_reps_user_uniq ON sales_reps (company_id, user_id) WHERE user_id IS NOT NULL` },
    { label: "sales_reps_user_idx",
      sql:   `CREATE INDEX IF NOT EXISTS sales_reps_user_idx ON sales_reps (user_id) WHERE user_id IS NOT NULL` },
    // Backfill: any legacy company without a code gets ZTC-{id}.
    { label: "backfill companies.code",
      sql:   `UPDATE companies SET code = 'ZTC-' || id WHERE code IS NULL` },
    // ─── approval_log: append-only audit trail for the document approval
    // workflow (see lib/db/src/schema/approvalLog.ts). Drizzle's ensureColumns
    // only ALTERs existing tables, never CREATEs new ones, so we materialise
    // the table here. Idempotent — safe to re-run on every boot.
    { label: "create approval_log table",
      sql:   `CREATE TABLE IF NOT EXISTS approval_log (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        document_type TEXT    NOT NULL,
        document_id   INTEGER NOT NULL,
        user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action        TEXT    NOT NULL,
        level         INTEGER NOT NULL DEFAULT 0,
        amount        NUMERIC(18,2) NOT NULL DEFAULT '0',
        from_status   TEXT,
        to_status     TEXT,
        comment       TEXT,
        created_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "approval_log_doc_idx",
      sql:   `CREATE INDEX IF NOT EXISTS approval_log_doc_idx ON approval_log (company_id, document_type, document_id)` },
    { label: "approval_log_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS approval_log_company_idx ON approval_log (company_id, created_at)` },
    // ─── pos_terminal_users: optional per-terminal user allow-list (see
    // schema/pos.ts). Same rationale as approval_log — created here because
    // ensureColumns only ALTERs.
    { label: "create pos_terminal_users table",
      sql:   `CREATE TABLE IF NOT EXISTS pos_terminal_users (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        pos_terminal_id INTEGER NOT NULL REFERENCES pos_terminals(id) ON DELETE CASCADE,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "pos_terminal_users_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS pos_terminal_users_uniq ON pos_terminal_users (pos_terminal_id, user_id)` },
    { label: "pos_terminal_users_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS pos_terminal_users_company_idx ON pos_terminal_users (company_id)` },

    // ─── Online Store module (see lib/db/src/schema/onlineStore.ts).
    // Multi-tenant e-commerce storefront tables — same rationale as above
    // (CREATE here, ensureColumns only ALTERs).
    { label: "create stores table",
      sql:   `CREATE TABLE IF NOT EXISTS stores (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        slug          TEXT NOT NULL,
        currency      TEXT NOT NULL DEFAULT 'SAR',
        language      TEXT NOT NULL DEFAULT 'ar',
        theme         TEXT NOT NULL DEFAULT 'modern',
        logo_url      TEXT,
        description   TEXT,
        contact_email TEXT,
        contact_phone TEXT,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        metadata      JSONB,
        created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "stores_slug_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS stores_slug_uniq ON stores (slug)` },
    { label: "stores_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS stores_company_idx ON stores (company_id)` },

    { label: "create store_domains table",
      sql:   `CREATE TABLE IF NOT EXISTS store_domains (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        store_id    INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
        domain      TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT 'custom',
        status      TEXT NOT NULL DEFAULT 'pending',
        is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
        verified_at TIMESTAMP,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "store_domains_domain_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS store_domains_domain_uniq ON store_domains (domain)` },

    { label: "create store_products table",
      sql:   `CREATE TABLE IF NOT EXISTS store_products (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        store_id        INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
        product_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        price           NUMERIC(15,2) NOT NULL DEFAULT '0',
        compare_price   NUMERIC(15,2),
        is_visible      BOOLEAN NOT NULL DEFAULT TRUE,
        image_url       TEXT,
        gallery_urls    JSONB,
        description_ar  TEXT,
        description_en  TEXT,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        metadata        JSONB,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "store_products_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS store_products_uniq ON store_products (store_id, product_id)` },

    { label: "create store_orders table",
      sql:   `CREATE TABLE IF NOT EXISTS store_orders (
        id               SERIAL PRIMARY KEY,
        company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        store_id         INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
        code             TEXT NOT NULL,
        customer_name    TEXT NOT NULL,
        customer_phone   TEXT,
        customer_email   TEXT,
        shipping_address TEXT,
        shipping_city    TEXT,
        shipping_method  TEXT,
        shipping_cost    NUMERIC(15,2) NOT NULL DEFAULT '0',
        subtotal         NUMERIC(15,2) NOT NULL DEFAULT '0',
        vat              NUMERIC(15,2) NOT NULL DEFAULT '0',
        total            NUMERIC(15,2) NOT NULL DEFAULT '0',
        payment_method   TEXT NOT NULL DEFAULT 'cod',
        payment_status   TEXT NOT NULL DEFAULT 'unpaid',
        status           TEXT NOT NULL DEFAULT 'new',
        invoice_id       INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
        notes            TEXT,
        tracking_number  TEXT,
        created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
        confirmed_at     TIMESTAMP,
        shipped_at       TIMESTAMP,
        delivered_at     TIMESTAMP,
        cancelled_at     TIMESTAMP
      )` },
    { label: "store_orders_company_code_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS store_orders_company_code_uniq ON store_orders (company_id, code)` },
    { label: "store_orders_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS store_orders_status_idx ON store_orders (company_id, status, created_at DESC)` },

    { label: "create store_order_items table",
      sql:   `CREATE TABLE IF NOT EXISTS store_order_items (
        id               SERIAL PRIMARY KEY,
        order_id         INTEGER NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
        store_product_id INTEGER REFERENCES store_products(id) ON DELETE SET NULL,
        product_id       INTEGER REFERENCES items(id)       ON DELETE SET NULL,
        product_name     TEXT NOT NULL,
        qty              NUMERIC(15,3) NOT NULL,
        unit_price       NUMERIC(15,2) NOT NULL,
        line_total       NUMERIC(15,2) NOT NULL
      )` },
    { label: "store_order_items_order_idx",
      sql:   `CREATE INDEX IF NOT EXISTS store_order_items_order_idx ON store_order_items (order_id)` },

    { label: "create store_payment_settings table",
      sql:   `CREATE TABLE IF NOT EXISTS store_payment_settings (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        store_id     INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
        gateway      TEXT NOT NULL,
        is_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
        environment  TEXT NOT NULL DEFAULT 'test',
        display_name TEXT,
        config_json  JSONB,
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "store_payment_settings_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS store_payment_settings_uniq ON store_payment_settings (store_id, gateway)` },

    // ─── Internal Chat module (see lib/db/src/schema/chat.ts).
    { label: "create chat_conversations table",
      sql:   `CREATE TABLE IF NOT EXISTS chat_conversations (
        id                 SERIAL PRIMARY KEY,
        company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        kind               TEXT NOT NULL DEFAULT 'direct',
        title              TEXT,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        last_message_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "chat_conv_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS chat_conv_company_idx ON chat_conversations (company_id, last_message_at DESC)` },

    { label: "create chat_participants table",
      sql:   `CREATE TABLE IF NOT EXISTS chat_participants (
        id                    SERIAL PRIMARY KEY,
        conversation_id       INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role                  TEXT NOT NULL DEFAULT 'member',
        joined_at             TIMESTAMP NOT NULL DEFAULT NOW(),
        last_read_message_id  INTEGER,
        last_read_at          TIMESTAMP
      )` },
    { label: "chat_participants_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS chat_participants_uniq ON chat_participants (conversation_id, user_id)` },
    { label: "chat_participants_user_idx",
      sql:   `CREATE INDEX IF NOT EXISTS chat_participants_user_idx ON chat_participants (user_id)` },

    { label: "create chat_messages table",
      sql:   `CREATE TABLE IF NOT EXISTS chat_messages (
        id                SERIAL PRIMARY KEY,
        conversation_id   INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        sender_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        kind              TEXT NOT NULL DEFAULT 'text',
        body              TEXT NOT NULL DEFAULT '',
        attachment_url    TEXT,
        attachment_name   TEXT,
        attachment_mime   TEXT,
        attachment_size   INTEGER,
        reply_to_id       INTEGER,
        created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        edited_at         TIMESTAMP,
        deleted_at        TIMESTAMP
      )` },
    { label: "chat_messages_conv_idx",
      sql:   `CREATE INDEX IF NOT EXISTS chat_messages_conv_idx ON chat_messages (conversation_id, created_at)` },
    { label: "chat_messages_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS chat_messages_company_idx ON chat_messages (company_id, created_at)` },

    // Drop the legacy single-policy-per-company table (was created earlier in
    // this same task, never used in production) — it's been replaced by the
    // profiles + user-assignments model below.
    { label: "drop legacy invoice_field_policies",
      sql:   `DROP TABLE IF EXISTS invoice_field_policies` },

    { label: "create invoice_field_policy_profiles table",
      sql:   `CREATE TABLE IF NOT EXISTS invoice_field_policy_profiles (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        bundle      JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_default  BOOLEAN NOT NULL DEFAULT FALSE,
        color       TEXT,
        updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "invoice_field_policy_profiles_company_name_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS invoice_field_policy_profiles_company_name_uniq ON invoice_field_policy_profiles (company_id, name)` },

    { label: "create user_invoice_field_policies table",
      sql:   `CREATE TABLE IF NOT EXISTS user_invoice_field_policies (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        profile_id  INTEGER NOT NULL REFERENCES invoice_field_policy_profiles(id) ON DELETE CASCADE,
        assigned_at TIMESTAMP NOT NULL DEFAULT NOW(),
        assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      )` },
    { label: "user_invoice_field_policies_profile_idx",
      sql:   `CREATE INDEX IF NOT EXISTS user_invoice_field_policies_profile_idx ON user_invoice_field_policies (profile_id)` },
  ];
  for (const { label, sql: stmt } of stmts) {
    try {
      await db.execute(sql.raw(stmt));
      applied.push(label);
    } catch (err) {
      logger.warn({ err, label, stmt }, "ensureSchema: tenant-identity step failed (continuing)");
    }
  }
  return applied;
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

  // Tenant identity indexes depend on the columns above (companies.code in
  // particular), so they must run AFTER ensureColumns.
  let appliedIdentitySteps: string[] = [];
  try {
    appliedIdentitySteps = await ensureTenantIdentityIndexes();
  } catch (err) {
    logger.error({ err }, "ensureSchema: tenant identity reconciliation failed (continuing)");
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
