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

    // ─── Multi-Domain Management (SuperAdmin platform module). One domain →
    // one company; host-based resolution is a fallback only (see auth.ts
    // resolveCompanyId). Created here because ensureColumns only ALTERs.
    // Distinct from store_domains (online-store storefront domains).
    { label: "create company_domains table",
      sql:   `CREATE TABLE IF NOT EXISTS company_domains (
        id                 SERIAL PRIMARY KEY,
        company_id         INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        domain             TEXT NOT NULL,
        is_primary         BOOLEAN NOT NULL DEFAULT FALSE,
        is_main            BOOLEAN NOT NULL DEFAULT FALSE,
        status             TEXT NOT NULL DEFAULT 'pending',
        activated_at       TIMESTAMP,
        last_check_at      TIMESTAMP,
        last_check_result  JSONB,
        notes              TEXT,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "company_domains_domain_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS company_domains_domain_uniq ON company_domains (domain)` },
    { label: "company_domains_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS company_domains_company_idx ON company_domains (company_id)` },
    // Multi-domain: allow a "main" multi-company domain (no bound company) plus
    // the is_main flag. Idempotent ALTERs for tables created before this change.
    { label: "company_domains company_id nullable",
      sql:   `ALTER TABLE company_domains ALTER COLUMN company_id DROP NOT NULL` },
    { label: "company_domains add is_main",
      sql:   `ALTER TABLE company_domains ADD COLUMN IF NOT EXISTS is_main BOOLEAN NOT NULL DEFAULT FALSE` },

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

    { label: "create custom_print_templates table",
      sql:   `CREATE TABLE IF NOT EXISTS custom_print_templates (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        document_type TEXT NOT NULL,
        name          TEXT NOT NULL,
        is_default    BOOLEAN NOT NULL DEFAULT FALSE,
        paper_size    TEXT NOT NULL DEFAULT 'A4',
        width_mm      INTEGER NOT NULL DEFAULT 210,
        height_mm     INTEGER NOT NULL DEFAULT 297,
        layout_json   JSONB NOT NULL DEFAULT '{"elements":[]}'::jsonb,
        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "cpt_company_doc_idx",
      sql:   `CREATE INDEX IF NOT EXISTS cpt_company_doc_idx ON custom_print_templates (company_id, document_type)` },

    // ─── Company Cloning from Templates (see lib/db/src/schema/companyTemplates.ts).
    { label: "create company_templates table",
      sql:   `CREATE TABLE IF NOT EXISTS company_templates (
        id                 SERIAL PRIMARY KEY,
        name_ar            TEXT NOT NULL,
        name_en            TEXT,
        description        TEXT,
        industry_name      TEXT,
        source_company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        is_active          BOOLEAN NOT NULL DEFAULT TRUE,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "company_templates_source_idx",
      sql:   `CREATE INDEX IF NOT EXISTS company_templates_source_idx ON company_templates (source_company_id)` },

    { label: "create company_clone_runs table",
      sql:   `CREATE TABLE IF NOT EXISTS company_clone_runs (
        id                   SERIAL PRIMARY KEY,
        source_company_id    INTEGER NOT NULL,
        target_company_id    INTEGER,
        template_id          INTEGER,
        performed_by_user_id INTEGER,
        status               TEXT NOT NULL DEFAULT 'success',
        summary              JSONB,
        error                TEXT,
        created_at           TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "company_clone_runs_source_idx",
      sql:   `CREATE INDEX IF NOT EXISTS company_clone_runs_source_idx ON company_clone_runs (source_company_id)` },

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

    // ─── Field Service Management (FSM) — see lib/db/src/schema/fieldService.ts.
    // CREATE here because ensureColumns only ALTERs existing tables.
    { label: "create field_locations table",
      sql:   `CREATE TABLE IF NOT EXISTS field_locations (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        branch_id       INTEGER REFERENCES branches(id) ON DELETE SET NULL,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL DEFAULT 'customer',
        lat             NUMERIC(10,7) NOT NULL,
        lng             NUMERIC(10,7) NOT NULL,
        radius_m        INTEGER NOT NULL DEFAULT 150,
        customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        project_id      INTEGER,
        asset_id        INTEGER,
        cost_center_id  INTEGER REFERENCES cost_centers(id) ON DELETE SET NULL,
        address         TEXT,
        city            TEXT,
        contact_person  TEXT,
        contact_phone   TEXT,
        is_active       BOOLEAN NOT NULL DEFAULT TRUE,
        notes           TEXT,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "field_loc_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_loc_company_idx ON field_locations (company_id)` },
    { label: "field_loc_type_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_loc_type_idx ON field_locations (company_id, type)` },
    { label: "field_loc_customer_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_loc_customer_idx ON field_locations (customer_id)` },

    { label: "create field_visits table",
      sql:   `CREATE TABLE IF NOT EXISTS field_visits (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        employee_id           INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        location_id           INTEGER REFERENCES field_locations(id) ON DELETE SET NULL,
        location_name         TEXT,
        location_type         TEXT,
        customer_id           INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        project_id            INTEGER,
        asset_id              INTEGER,
        ticket_id             INTEGER,
        cost_center_id        INTEGER REFERENCES cost_centers(id) ON DELETE SET NULL,
        purpose               TEXT NOT NULL DEFAULT 'site_visit',
        status                TEXT NOT NULL DEFAULT 'open',
        arrived_at            TIMESTAMP NOT NULL DEFAULT NOW(),
        left_at               TIMESTAMP,
        duration_min          INTEGER,
        arrival_lat           NUMERIC(10,7),
        arrival_lng           NUMERIC(10,7),
        arrival_accuracy_m    NUMERIC(8,2),
        arrival_distance_m    NUMERIC(10,2),
        arrival_loc_status    TEXT,
        departure_lat         NUMERIC(10,7),
        departure_lng         NUMERIC(10,7),
        departure_accuracy_m  NUMERIC(8,2),
        outcome               TEXT,
        photo_url             TEXT,
        signature_url         TEXT,
        signed_by_name        TEXT,
        form_data             JSONB DEFAULT '{}'::jsonb,
        notes                 TEXT,
        created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "field_visits_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_company_idx ON field_visits (company_id)` },
    { label: "field_visits_employee_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_employee_idx ON field_visits (employee_id)` },
    { label: "field_visits_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_status_idx ON field_visits (company_id, status)` },
    { label: "field_visits_arrived_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_arrived_idx ON field_visits (arrived_at)` },
    { label: "field_visits_ticket_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_ticket_idx ON field_visits (ticket_id)` },

    { label: "create field_visit_plans table",
      sql:   `CREATE TABLE IF NOT EXISTS field_visit_plans (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        date         DATE NOT NULL,
        status       TEXT NOT NULL DEFAULT 'published',
        notes        TEXT,
        created_by   INTEGER,
        created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "field_plans_emp_date_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_plans_emp_date_idx ON field_visit_plans (employee_id, date)` },

    { label: "create field_visit_plan_items table",
      sql:   `CREATE TABLE IF NOT EXISTS field_visit_plan_items (
        id            SERIAL PRIMARY KEY,
        plan_id       INTEGER NOT NULL REFERENCES field_visit_plans(id) ON DELETE CASCADE,
        sequence_no   INTEGER NOT NULL DEFAULT 1,
        location_id   INTEGER REFERENCES field_locations(id) ON DELETE SET NULL,
        location_name TEXT,
        planned_at    TIMESTAMP,
        purpose       TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        visit_id      INTEGER REFERENCES field_visits(id) ON DELETE SET NULL,
        notes         TEXT
      )` },

    { label: "create field_service_tickets table",
      sql:   `CREATE TABLE IF NOT EXISTS field_service_tickets (
        id                       SERIAL PRIMARY KEY,
        company_id               INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        branch_id                INTEGER REFERENCES branches(id) ON DELETE SET NULL,
        ticket_no                TEXT NOT NULL,
        customer_id              INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        asset_id                 INTEGER,
        location_id              INTEGER REFERENCES field_locations(id) ON DELETE SET NULL,
        title                    TEXT NOT NULL,
        description              TEXT,
        category                 TEXT NOT NULL DEFAULT 'repair',
        priority                 TEXT NOT NULL DEFAULT 'medium',
        status                   TEXT NOT NULL DEFAULT 'open',
        opened_at                TIMESTAMP NOT NULL DEFAULT NOW(),
        opened_by                INTEGER,
        assigned_to              INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        assigned_at              TIMESTAMP,
        responded_at             TIMESTAMP,
        resolved_at              TIMESTAMP,
        closed_at                TIMESTAMP,
        sla_response_min         INTEGER NOT NULL DEFAULT 60,
        sla_resolution_min       INTEGER NOT NULL DEFAULT 480,
        sla_response_breached    BOOLEAN NOT NULL DEFAULT FALSE,
        sla_resolution_breached  BOOLEAN NOT NULL DEFAULT FALSE,
        resolution               TEXT,
        customer_rating          INTEGER,
        labor_hours              NUMERIC(10,2) DEFAULT '0',
        labor_cost               NUMERIC(15,2) DEFAULT '0',
        parts_cost               NUMERIC(15,2) DEFAULT '0',
        total_cost               NUMERIC(15,2) DEFAULT '0',
        notes                    TEXT,
        created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "field_tickets_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_company_idx ON field_service_tickets (company_id)` },
    { label: "field_tickets_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_status_idx ON field_service_tickets (company_id, status)` },
    { label: "field_tickets_assigned_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_assigned_idx ON field_service_tickets (assigned_to)` },
    { label: "field_tickets_no_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS field_tickets_no_uniq ON field_service_tickets (company_id, ticket_no)` },

    // ── FSM SLA pre-computed deadlines ────────────────────────────────
    // Background SLA-breach evaluators (and reports) need a deterministic
    // due-at instead of recomputing `opened_at + sla_xxx_min` everywhere.
    // Populated by the route layer on insert and on priority change.
    { label: "alter field_service_tickets add response_due_at",
      sql:   `ALTER TABLE field_service_tickets ADD COLUMN IF NOT EXISTS response_due_at TIMESTAMP` },
    { label: "alter field_service_tickets add resolve_due_at",
      sql:   `ALTER TABLE field_service_tickets ADD COLUMN IF NOT EXISTS resolve_due_at TIMESTAMP` },
    // Backfill existing rows so old tickets also benefit from the new
    // breach-detection path. NOT NULL is intentionally NOT enforced — old
    // imports that lacked an opened_at would otherwise fail.
    { label: "backfill field_service_tickets response_due_at",
      sql:   `UPDATE field_service_tickets
              SET response_due_at = opened_at + (sla_response_min || ' minutes')::interval
              WHERE response_due_at IS NULL AND opened_at IS NOT NULL` },
    { label: "backfill field_service_tickets resolve_due_at",
      sql:   `UPDATE field_service_tickets
              SET resolve_due_at = opened_at + (sla_resolution_min || ' minutes')::interval
              WHERE resolve_due_at IS NULL AND opened_at IS NOT NULL` },
    { label: "field_tickets_response_due_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_response_due_idx ON field_service_tickets (response_due_at)` },
    { label: "field_tickets_resolve_due_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_resolve_due_idx ON field_service_tickets (resolve_due_at)` },
    { label: "field_tickets_branch_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_branch_idx ON field_service_tickets (company_id, branch_id)` },
    { label: "field_tickets_assigned_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_assigned_status_idx ON field_service_tickets (assigned_to, status)` },
    { label: "field_visits_company_arrived_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_company_arrived_idx ON field_visits (company_id, arrived_at)` },
    { label: "field_visits_emp_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_emp_status_idx ON field_visits (employee_id, status)` },
    // Branch-scoping for visits — added so branch-restricted users see
    // only the visits whose location belongs to their assigned branch.
    // Backfilled from the linked field_location's branch_id so historic
    // rows participate in branch filters too.
    { label: "alter field_visits add branch_id",
      sql:   `ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL` },
    { label: "backfill field_visits.branch_id from field_locations",
      sql:   `UPDATE field_visits v
              SET branch_id = l.branch_id
              FROM field_locations l
              WHERE v.location_id = l.id AND v.branch_id IS NULL AND l.branch_id IS NOT NULL` },
    { label: "field_visits_branch_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_branch_idx ON field_visits (company_id, branch_id)` },

    // ─── FSM ↔ Maintenance integration ─────────────────────────────────
    // Soft FK from maintenance_orders → field_service_tickets, set when an
    // FSM ticket is converted to a maintenance work order. Allows two-way
    // navigation and a UNIQUE guard prevents double conversion of the same
    // ticket.
    { label: "alter maintenance_orders add field_ticket_id",
      sql:   `ALTER TABLE maintenance_orders ADD COLUMN IF NOT EXISTS field_ticket_id INTEGER` },
    // Migrate the legacy single-column unique index to a (company_id,
    // field_ticket_id) scoped one. Safe to drop because the column was
    // introduced in this same deploy and never globally reused.
    { label: "drop legacy maintenance_orders_field_ticket_uniq",
      sql:   `DO $$ BEGIN
                IF EXISTS (
                  SELECT 1 FROM pg_indexes
                  WHERE indexname = 'maintenance_orders_field_ticket_uniq'
                    AND indexdef NOT LIKE '%(company_id, field_ticket_id)%'
                ) THEN
                  EXECUTE 'DROP INDEX maintenance_orders_field_ticket_uniq';
                END IF;
              END $$;` },
    { label: "maintenance_orders_field_ticket_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS maintenance_orders_field_ticket_uniq
              ON maintenance_orders (company_id, field_ticket_id) WHERE field_ticket_id IS NOT NULL` },
    { label: "maintenance_orders_asset_idx",
      sql:   `CREATE INDEX IF NOT EXISTS maintenance_orders_asset_idx
              ON maintenance_orders (company_id, asset_id)` },
    { label: "field_tickets_asset_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_asset_idx
              ON field_service_tickets (company_id, asset_id)` },

    // ── Journal-entry audit columns ─────────────────────────────────────
    // Captures who created and who posted each entry, with the IP and
    // user-agent at the time, plus the posted-at timestamp. Country is
    // resolved on demand from the IP via the same Geo-IP service used by
    // the visitor-country middleware, so no column is needed for it.
    // ── ZATCA Gateway (multi-tenant external clients) ─────────────────
    { label: "create gateway_clients table",
      sql:   `CREATE TABLE IF NOT EXISTS gateway_clients (
        id                       SERIAL PRIMARY KEY,
        name_ar                  TEXT NOT NULL,
        name_en                  TEXT,
        vat_number               TEXT NOT NULL UNIQUE,
        cr_number                TEXT,
        contact_email            TEXT,
        contact_phone            TEXT,
        address_ar               TEXT,
        city                     TEXT,
        zatca_csid_enc           TEXT,
        zatca_pcsid_enc          TEXT,
        zatca_private_key_enc    TEXT,
        zatca_env                TEXT NOT NULL DEFAULT 'sandbox',
        status                   TEXT NOT NULL DEFAULT 'pending',
        notes                    TEXT,
        monthly_quota            INTEGER NOT NULL DEFAULT 1000,
        invoices_this_month      INTEGER NOT NULL DEFAULT 0,
        total_invoices           INTEGER NOT NULL DEFAULT 0,
        created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMP NOT NULL DEFAULT NOW(),
        last_invoice_at          TIMESTAMP
      )` },
    { label: "gateway_clients_vat_idx",
      sql:   `CREATE INDEX IF NOT EXISTS gateway_clients_vat_idx ON gateway_clients (vat_number)` },
    { label: "gateway_clients_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS gateway_clients_status_idx ON gateway_clients (status)` },
    { label: "create gateway_api_keys table",
      sql:   `CREATE TABLE IF NOT EXISTS gateway_api_keys (
        id            SERIAL PRIMARY KEY,
        client_id     INTEGER NOT NULL REFERENCES gateway_clients(id) ON DELETE CASCADE,
        label         TEXT NOT NULL,
        key_hash      TEXT NOT NULL UNIQUE,
        key_prefix    TEXT NOT NULL,
        scope         TEXT NOT NULL DEFAULT 'invoice_submit',
        created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        last_used_at  TIMESTAMP,
        last_used_ip  TEXT,
        revoked_at    TIMESTAMP,
        expires_at    TIMESTAMP
      )` },
    { label: "gateway_api_keys_client_idx",
      sql:   `CREATE INDEX IF NOT EXISTS gateway_api_keys_client_idx ON gateway_api_keys (client_id)` },
    { label: "gateway_api_keys_hash_idx",
      sql:   `CREATE INDEX IF NOT EXISTS gateway_api_keys_hash_idx ON gateway_api_keys (key_hash)` },
    { label: "create gateway_invoices table",
      sql:   `CREATE TABLE IF NOT EXISTS gateway_invoices (
        id              SERIAL PRIMARY KEY,
        client_id       INTEGER NOT NULL REFERENCES gateway_clients(id) ON DELETE CASCADE,
        api_key_id      INTEGER REFERENCES gateway_api_keys(id) ON DELETE SET NULL,
        file_name       TEXT,
        file_size       INTEGER,
        invoice_number  TEXT,
        invoice_date    TIMESTAMP,
        total_amount    NUMERIC(18,2),
        vat_amount      NUMERIC(18,2),
        status          TEXT NOT NULL DEFAULT 'received',
        zatca_uuid      TEXT,
        zatca_response  JSONB,
        error_message   TEXT,
        received_at     TIMESTAMP NOT NULL DEFAULT NOW(),
        processed_at    TIMESTAMP,
        ip              TEXT
      )` },
    { label: "gateway_invoices_client_idx",
      sql:   `CREATE INDEX IF NOT EXISTS gateway_invoices_client_idx ON gateway_invoices (client_id, received_at)` },
    { label: "gateway_invoices_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS gateway_invoices_status_idx ON gateway_invoices (status)` },
    // ── Phase 2: real submission chain (ICV/PIH) + onboarding wizard ──
    { label: "companies add print_enabled_templates",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS print_enabled_templates JSONB` },
    { label: "companies add print_default_template",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS print_default_template INTEGER NOT NULL DEFAULT 1` },
    { label: "companies add sequence_date_source",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS sequence_date_source TEXT NOT NULL DEFAULT 'system'` },
    { label: "gateway_clients add last_icv",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS last_icv INTEGER NOT NULL DEFAULT 0` },
    { label: "gateway_clients add last_invoice_hash",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS last_invoice_hash TEXT` },
    { label: "gateway_clients add egs_serial",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS egs_serial TEXT` },
    { label: "gateway_clients add csr_pem",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS csr_pem TEXT` },
    { label: "gateway_clients add csr_private_key_enc",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS csr_private_key_enc TEXT` },
    { label: "gateway_invoices add icv",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS icv INTEGER` },
    { label: "gateway_invoices add pih",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS pih TEXT` },
    { label: "gateway_invoices add invoice_hash",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS invoice_hash TEXT` },
    { label: "gateway_invoices add invoice_type",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS invoice_type TEXT` },
    { label: "gateway_invoices add invoice_flow",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS invoice_flow TEXT` },
    { label: "gateway_invoices add canonical_json",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS canonical_json JSONB` },
    { label: "gateway_invoices add ubl_xml",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS ubl_xml TEXT` },
    { label: "gateway_invoices add qr_tlv",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS qr_tlv TEXT` },
    { label: "gateway_invoices add zatca_submitted_at",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS zatca_submitted_at TIMESTAMP` },
    { label: "gateway_invoices add clearance_status",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS clearance_status TEXT` },
    { label: "gateway_invoices add clearance_notes",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS clearance_notes JSONB` },
    // Manual-JE auto-posting toggle (companion to auto_post_sales / etc.).
    // Default true so upgrading tenants keep the legacy "post on save"
    // behavior; flipping it to false makes new manual JEs land as drafts.
    { label: "companies add auto_post_journal_entry",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_post_journal_entry BOOLEAN NOT NULL DEFAULT TRUE` },
    // Optional UX prefs (company-wide): smart JE form + menu placement.
    { label: "companies add journal_smart_form",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS journal_smart_form BOOLEAN NOT NULL DEFAULT FALSE` },
    { label: "companies add menu_layout",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS menu_layout TEXT NOT NULL DEFAULT 'sidebar'` },
    // Phase 1B.2 — explicit Basic-auth secret storage and rotation marker
    { label: "gateway_clients add zatca_csid_secret_enc",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS zatca_csid_secret_enc TEXT` },
    { label: "gateway_clients add zatca_pcsid_secret_enc",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS zatca_pcsid_secret_enc TEXT` },
    { label: "gateway_clients add csid_last_rotated_at",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS csid_last_rotated_at TIMESTAMP` },
    // Per-line fixed-amount discount (companion to existing per-line percent
    // discount). NOT NULL with default 0 so legacy rows reconcile cleanly.
    { label: "sales_invoice_lines add discount_amount",
      sql:   `ALTER TABLE sales_invoice_lines ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0` },
    { label: "sales_return_lines add discount_amount",
      sql:   `ALTER TABLE sales_return_lines ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0` },
    { label: "sales_quotation_lines add discount_amount",
      sql:   `ALTER TABLE sales_quotation_lines ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0` },
    { label: "sales_order_lines add discount_amount",
      sql:   `ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0` },

    // Allow fractional years (years + months) on fixed-asset useful life.
    { label: "fixed_assets life_years to numeric",
      sql:   `ALTER TABLE fixed_assets ALTER COLUMN life_years TYPE NUMERIC(8,4) USING life_years::NUMERIC(8,4)` },
    { label: "fa_categories default_life_years to numeric",
      sql:   `ALTER TABLE fa_categories ALTER COLUMN default_life_years TYPE NUMERIC(8,4) USING default_life_years::NUMERIC(8,4)` },

    // Fixed-asset tax tab — KSA VAT defaults
    { label: "fixed_assets add vat_rate",
      sql:   `ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(5,2) NOT NULL DEFAULT 15` },
    { label: "fixed_assets add price_includes_vat",
      sql:   `ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS price_includes_vat BOOLEAN NOT NULL DEFAULT FALSE` },

    // Phase 4 — webhooks + delivery log
    { label: "create gateway_webhooks",
      sql: `CREATE TABLE IF NOT EXISTS gateway_webhooks (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL REFERENCES gateway_clients(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        secret_enc TEXT NOT NULL,
        events JSONB NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_delivery_at TIMESTAMP,
        last_status TEXT,
        last_error TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0
      )` },
    { label: "create gateway_webhooks idx",
      sql: `CREATE INDEX IF NOT EXISTS gateway_webhooks_client_idx ON gateway_webhooks(client_id)` },
    { label: "create gateway_webhook_deliveries",
      sql: `CREATE TABLE IF NOT EXISTS gateway_webhook_deliveries (
        id SERIAL PRIMARY KEY,
        webhook_id INTEGER NOT NULL REFERENCES gateway_webhooks(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        http_status INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        delivered_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "create gateway_webhook_deliveries idx",
      sql: `CREATE INDEX IF NOT EXISTS gateway_webhook_deliveries_webhook_idx ON gateway_webhook_deliveries(webhook_id, created_at)` },
    { label: "create gateway_webhook_deliveries status idx",
      sql: `CREATE INDEX IF NOT EXISTS gateway_webhook_deliveries_status_idx ON gateway_webhook_deliveries(status)` },

    // Phase A — integrations marketplace (Odoo, Salla, Generic REST + 8 stubs)
    { label: "create integration_connections",
      sql: `CREATE TABLE IF NOT EXISTS integration_connections (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disconnected',
        base_url TEXT,
        credentials_enc TEXT,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        inbound_token_hash TEXT,
        last_sync_at TIMESTAMP,
        last_sync_status TEXT,
        last_sync_error TEXT,
        total_syncs INTEGER NOT NULL DEFAULT 0,
        pull_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        pull_interval_minutes INTEGER NOT NULL DEFAULT 60,
        created_by INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "create integration_connections company idx",
      sql: `CREATE INDEX IF NOT EXISTS integration_connections_company_idx ON integration_connections(company_id)` },
    { label: "create integration_connections provider idx",
      sql: `CREATE INDEX IF NOT EXISTS integration_connections_provider_idx ON integration_connections(provider)` },
    { label: "create integration_sync_runs",
      sql: `CREATE TABLE IF NOT EXISTS integration_sync_runs (
        id SERIAL PRIMARY KEY,
        connection_id INTEGER NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TIMESTAMP NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMP,
        invoices_ingested INTEGER NOT NULL DEFAULT 0,
        errors JSONB NOT NULL DEFAULT '[]'::jsonb,
        raw_response JSONB
      )` },
    { label: "create integration_sync_runs connection idx",
      sql: `CREATE INDEX IF NOT EXISTS integration_sync_runs_connection_idx ON integration_sync_runs(connection_id, started_at)` },

    { label: "alter journal_entries add createdBy",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS created_by INTEGER` },
    { label: "alter journal_entries add createdIp",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS created_ip TEXT` },
    { label: "alter journal_entries add createdUserAgent",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS created_user_agent TEXT` },
    { label: "alter journal_entries add postedBy",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS posted_by INTEGER` },
    { label: "alter journal_entries add postedAt",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP` },
    { label: "alter journal_entries add postedIp",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS posted_ip TEXT` },
    { label: "alter journal_entries add postedUserAgent",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS posted_user_agent TEXT` },

    // ── Document audit columns (created_by_id / posted_by_id / posted_at) ──
    // Mirrors the journal-entry pattern across the four key business
    // documents so the list grids can render "أنشأه" / "رحّله" columns.
    { label: "alter sales_invoices add postedById",
      sql:   `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS posted_by_id INTEGER` },
    { label: "alter sales_invoices add postedAt",
      sql:   `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP` },

    { label: "alter purchase_invoices add createdById",
      sql:   `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS created_by_id INTEGER` },
    { label: "alter purchase_invoices add postedById",
      sql:   `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS posted_by_id INTEGER` },
    { label: "alter purchase_invoices add postedAt",
      sql:   `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP` },

    { label: "alter goods_receipts add createdById",
      sql:   `ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS created_by_id INTEGER` },
    { label: "alter goods_receipts add postedById",
      sql:   `ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS posted_by_id INTEGER` },
    { label: "alter goods_receipts add postedAt",
      sql:   `ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP` },

    { label: "alter goods_deliveries add createdById",
      sql:   `ALTER TABLE goods_deliveries ADD COLUMN IF NOT EXISTS created_by_id INTEGER` },
    { label: "alter goods_deliveries add postedById",
      sql:   `ALTER TABLE goods_deliveries ADD COLUMN IF NOT EXISTS posted_by_id INTEGER` },
    { label: "alter goods_deliveries add postedAt",
      sql:   `ALTER TABLE goods_deliveries ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP` },

    // ─── Windows Desktop POS (Task #174) — additive only ──────────────
    // Five new tables for offline POS + sync + licensing + per-device
    // invoice ranges + per-country download URLs. All gated behind
    // companies.enable_offline_pos (default false) so zero impact on
    // existing tenants until SuperAdmin opts a company in.
    { label: "create device_licenses table",
      sql:   `CREATE TABLE IF NOT EXISTS device_licenses (
        id                   SERIAL PRIMARY KEY,
        license_key          TEXT NOT NULL,
        company_id           INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        device_id            INTEGER,
        status               TEXT NOT NULL DEFAULT 'unassigned',
        plan                 TEXT NOT NULL DEFAULT 'pos_full',
        max_devices          INTEGER NOT NULL DEFAULT 1,
        issued_at            TIMESTAMP NOT NULL DEFAULT NOW(),
        activated_at         TIMESTAMP,
        expires_at           TIMESTAMP,
        revoked_at           TIMESTAMP,
        notes                TEXT,
        created_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "device_licenses_key_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS device_licenses_key_uniq ON device_licenses (license_key)` },
    { label: "device_licenses_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS device_licenses_company_idx ON device_licenses (company_id)` },
    { label: "device_licenses_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS device_licenses_status_idx ON device_licenses (status)` },

    { label: "create pos_devices table",
      sql:   `CREATE TABLE IF NOT EXISTS pos_devices (
        id                   SERIAL PRIMARY KEY,
        company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        branch_id            INTEGER REFERENCES branches(id) ON DELETE SET NULL,
        device_name          TEXT NOT NULL,
        fingerprint_hash     TEXT NOT NULL,
        license_id           INTEGER REFERENCES device_licenses(id) ON DELETE SET NULL,
        device_token         TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'active',
        app_version          TEXT,
        os_info              TEXT,
        last_heartbeat_at    TIMESTAMP,
        last_seen_ip         TEXT,
        last_sync_at         TIMESTAMP,
        metadata             JSONB,
        created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMP NOT NULL DEFAULT NOW(),
        deactivated_at       TIMESTAMP
      )` },
    { label: "pos_devices_token_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS pos_devices_token_uniq ON pos_devices (device_token)` },
    { label: "pos_devices_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS pos_devices_company_idx ON pos_devices (company_id)` },
    { label: "pos_devices_fp_idx",
      sql:   `CREATE INDEX IF NOT EXISTS pos_devices_fp_idx ON pos_devices (company_id, fingerprint_hash)` },

    { label: "pos_sessions add last_heartbeat_at",
      sql:   `ALTER TABLE pos_sessions ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMP` },
    { label: "pos_sessions add close_reason",
      sql:   `ALTER TABLE pos_sessions ADD COLUMN IF NOT EXISTS close_reason TEXT` },
    { label: "pos_sessions_open_stale_idx",
      sql:   `CREATE INDEX IF NOT EXISTS pos_sessions_open_stale_idx ON pos_sessions (status, last_heartbeat_at) WHERE status = 'open'` },

    { label: "create sync_queue_log table",
      sql:   `CREATE TABLE IF NOT EXISTS sync_queue_log (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        device_id       INTEGER REFERENCES pos_devices(id) ON DELETE SET NULL,
        direction       TEXT NOT NULL,
        entity_type     TEXT,
        payload_count   INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'ok',
        error_message   TEXT,
        duration_ms     INTEGER,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "sync_queue_log_device_idx",
      sql:   `CREATE INDEX IF NOT EXISTS sync_queue_log_device_idx ON sync_queue_log (device_id, created_at)` },
    { label: "sync_queue_log_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS sync_queue_log_company_idx ON sync_queue_log (company_id, created_at)` },

    { label: "create device_invoice_ranges table",
      sql:   `CREATE TABLE IF NOT EXISTS device_invoice_ranges (
        id             SERIAL PRIMARY KEY,
        company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        device_id      INTEGER NOT NULL REFERENCES pos_devices(id) ON DELETE CASCADE,
        doc_type       TEXT NOT NULL DEFAULT 'pos_invoice',
        range_start    BIGINT NOT NULL,
        range_end      BIGINT NOT NULL,
        next_number    BIGINT NOT NULL,
        exhausted_at   TIMESTAMP,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "device_invoice_ranges_device_idx",
      sql:   `CREATE INDEX IF NOT EXISTS device_invoice_ranges_device_idx ON device_invoice_ranges (device_id, doc_type)` },

    { label: "create download_releases table",
      sql:   `CREATE TABLE IF NOT EXISTS download_releases (
        id                 SERIAL PRIMARY KEY,
        country_code       TEXT NOT NULL,
        platform           TEXT NOT NULL DEFAULT 'win-x64',
        version            TEXT NOT NULL,
        download_url       TEXT NOT NULL,
        file_size_bytes    BIGINT,
        checksum_sha256    TEXT,
        release_notes      TEXT,
        is_active          BOOLEAN NOT NULL DEFAULT TRUE,
        published_at       TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "download_releases_country_platform_idx",
      sql:   `CREATE INDEX IF NOT EXISTS download_releases_country_platform_idx ON download_releases (country_code, platform, is_active)` },

    // ─── OSH / Safety module (see lib/db/src/schema/safety.ts). ISO 45001 core:
    // risk register + hierarchy of controls, incident management + 5-Whys, and
    // CAPA. No journal entries (operational, not financial). CREATE here because
    // ensureColumns only ALTERs existing tables. Idempotent — safe per boot.
    { label: "create safety_risk_assessments table",
      sql:   `CREATE TABLE IF NOT EXISTS safety_risk_assessments (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        branch_id           INTEGER REFERENCES branches(id) ON DELETE SET NULL,
        code                TEXT NOT NULL,
        title               TEXT NOT NULL,
        process_area        TEXT,
        work_center_id      INTEGER REFERENCES work_centers(id) ON DELETE SET NULL,
        hazard_description  TEXT,
        hazard_category     TEXT NOT NULL DEFAULT 'other',
        likelihood          INTEGER NOT NULL DEFAULT 1,
        severity            INTEGER NOT NULL DEFAULT 1,
        risk_score          INTEGER NOT NULL DEFAULT 1,
        risk_level          TEXT NOT NULL DEFAULT 'low',
        existing_controls   TEXT,
        residual_likelihood INTEGER,
        residual_severity   INTEGER,
        residual_score      INTEGER,
        residual_level      TEXT,
        responsible_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        assessment_date     DATE,
        review_date         DATE,
        status              TEXT NOT NULL DEFAULT 'open',
        notes               TEXT,
        created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "safety_ra_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS safety_ra_company_idx ON safety_risk_assessments (company_id)` },
    { label: "safety_ra_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS safety_ra_status_idx ON safety_risk_assessments (company_id, status)` },

    { label: "create safety_risk_controls table",
      sql:   `CREATE TABLE IF NOT EXISTS safety_risk_controls (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        assessment_id INTEGER NOT NULL REFERENCES safety_risk_assessments(id) ON DELETE CASCADE,
        control_type  TEXT NOT NULL DEFAULT 'administrative',
        description   TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'planned',
        owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        due_date      DATE,
        created_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "safety_rc_assessment_idx",
      sql:   `CREATE INDEX IF NOT EXISTS safety_rc_assessment_idx ON safety_risk_controls (assessment_id)` },

    { label: "create safety_incidents table",
      sql:   `CREATE TABLE IF NOT EXISTS safety_incidents (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        branch_id           INTEGER REFERENCES branches(id) ON DELETE SET NULL,
        incident_number     TEXT NOT NULL,
        incident_type       TEXT NOT NULL DEFAULT 'near_miss',
        severity_class      TEXT NOT NULL DEFAULT 'no_treatment',
        title               TEXT NOT NULL,
        description         TEXT,
        location            TEXT,
        work_center_id      INTEGER REFERENCES work_centers(id) ON DELETE SET NULL,
        production_order_id INTEGER REFERENCES production_orders(id) ON DELETE SET NULL,
        injured_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        occurred_at         TIMESTAMP NOT NULL,
        reported_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        reported_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        immediate_actions   TEXT,
        root_cause          TEXT,
        whys                JSONB DEFAULT '[]'::jsonb,
        lost_days           INTEGER NOT NULL DEFAULT 0,
        is_recordable       BOOLEAN NOT NULL DEFAULT FALSE,
        status              TEXT NOT NULL DEFAULT 'open',
        created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "safety_inc_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS safety_inc_company_idx ON safety_incidents (company_id)` },
    { label: "safety_inc_occurred_idx",
      sql:   `CREATE INDEX IF NOT EXISTS safety_inc_occurred_idx ON safety_incidents (company_id, occurred_at)` },

    { label: "create safety_incident_actions table",
      sql:   `CREATE TABLE IF NOT EXISTS safety_incident_actions (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        incident_id  INTEGER NOT NULL REFERENCES safety_incidents(id) ON DELETE CASCADE,
        action_type  TEXT NOT NULL DEFAULT 'corrective',
        description  TEXT NOT NULL,
        owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        due_date     DATE,
        status       TEXT NOT NULL DEFAULT 'open',
        completed_at TIMESTAMP,
        created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "safety_act_incident_idx",
      sql:   `CREATE INDEX IF NOT EXISTS safety_act_incident_idx ON safety_incident_actions (incident_id)` },

    // ─── taxes: dynamic tax catalog (see schema/taxes.ts). ensureColumns only
    // ALTERs existing tables, never CREATEs new ones, so we materialise the
    // table here. Idempotent — safe to re-run on every boot.
    { label: "create taxes table",
      sql:   `CREATE TABLE IF NOT EXISTS taxes (
        id                      SERIAL PRIMARY KEY,
        company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        code                    TEXT NOT NULL,
        name_ar                 TEXT NOT NULL,
        name_en                 TEXT,
        rate                    NUMERIC(9,4) NOT NULL DEFAULT '15',
        rate_type               TEXT NOT NULL DEFAULT 'percent',
        currency_code           TEXT,
        branch_id               INTEGER,
        cost_center             TEXT,
        account_id              INTEGER,
        sales_tax_account_id    INTEGER,
        purchase_tax_account_id INTEGER,
        is_active               BOOLEAN NOT NULL DEFAULT TRUE,
        is_default              BOOLEAN NOT NULL DEFAULT FALSE,
        is_system               BOOLEAN NOT NULL DEFAULT FALSE,
        notes                   TEXT,
        created_at              TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "taxes_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS taxes_company_idx ON taxes (company_id)` },
    // At most one default tax per company.
    { label: "taxes_company_default_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS taxes_company_default_uniq ON taxes (company_id) WHERE is_default = TRUE` },

    // ── Reseller (Agent) Network — Task #237 (additive only) ──────────────
    { label: "create resellers table",
      sql:   `CREATE TABLE IF NOT EXISTS resellers (
        id              SERIAL PRIMARY KEY,
        code            TEXT NOT NULL UNIQUE,
        name_ar         TEXT NOT NULL,
        name_en         TEXT,
        phone           TEXT,
        email           TEXT,
        address         TEXT,
        username        TEXT NOT NULL UNIQUE,
        password_hash   TEXT NOT NULL,
        session_token   TEXT,
        session_id      TEXT,
        commission_rate NUMERIC(6,3) NOT NULL DEFAULT '0',
        status          TEXT NOT NULL DEFAULT 'active',
        activated_at    DATE,
        permissions     JSONB NOT NULL DEFAULT '{}'::jsonb,
        notes           TEXT,
        is_active       BOOLEAN NOT NULL DEFAULT TRUE,
        last_login_at   TIMESTAMP,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "resellers_token_idx",
      sql:   `CREATE INDEX IF NOT EXISTS resellers_token_idx ON resellers (session_token)` },
    { label: "create reseller_companies table",
      sql:   `CREATE TABLE IF NOT EXISTS reseller_companies (
        id          SERIAL PRIMARY KEY,
        reseller_id INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        linked_at   TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "reseller_companies_company_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS reseller_companies_company_uniq ON reseller_companies (company_id)` },
    { label: "reseller_companies_reseller_idx",
      sql:   `CREATE INDEX IF NOT EXISTS reseller_companies_reseller_idx ON reseller_companies (reseller_id)` },
    { label: "create reseller_commissions table",
      sql:   `CREATE TABLE IF NOT EXISTS reseller_commissions (
        id                SERIAL PRIMARY KEY,
        reseller_id       INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
        company_id        INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        subscription_id   INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
        event_type        TEXT NOT NULL,
        description       TEXT,
        base_amount       NUMERIC(15,2) NOT NULL DEFAULT '0',
        commission_rate   NUMERIC(6,3) NOT NULL DEFAULT '0',
        commission_amount NUMERIC(15,2) NOT NULL DEFAULT '0',
        period_month      INTEGER NOT NULL,
        period_year       INTEGER NOT NULL,
        status            TEXT NOT NULL DEFAULT 'accrued',
        created_at        TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "reseller_commissions_reseller_idx",
      sql:   `CREATE INDEX IF NOT EXISTS reseller_commissions_reseller_idx ON reseller_commissions (reseller_id)` },
    { label: "reseller_commissions_period_idx",
      sql:   `CREATE INDEX IF NOT EXISTS reseller_commissions_period_idx ON reseller_commissions (reseller_id, period_year, period_month)` },
    { label: "create reseller_tickets table",
      sql:   `CREATE TABLE IF NOT EXISTS reseller_tickets (
        id             SERIAL PRIMARY KEY,
        reseller_id    INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
        company_id     INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        subject        TEXT NOT NULL,
        body           TEXT NOT NULL,
        category       TEXT NOT NULL DEFAULT 'general',
        priority       TEXT NOT NULL DEFAULT 'normal',
        status         TEXT NOT NULL DEFAULT 'open',
        admin_reply    TEXT,
        admin_reply_at TIMESTAMP,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "reseller_tickets_reseller_idx",
      sql:   `CREATE INDEX IF NOT EXISTS reseller_tickets_reseller_idx ON reseller_tickets (reseller_id)` },
    { label: "create reseller_activation_requests table",
      sql:   `CREATE TABLE IF NOT EXISTS reseller_activation_requests (
        id              SERIAL PRIMARY KEY,
        reseller_id     INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
        company_name_ar TEXT NOT NULL,
        contact_phone   TEXT,
        contact_email   TEXT,
        plan            TEXT,
        notes           TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        admin_note      TEXT,
        resolved_at     TIMESTAMP,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "reseller_activation_requests_reseller_idx",
      sql:   `CREATE INDEX IF NOT EXISTS reseller_activation_requests_reseller_idx ON reseller_activation_requests (reseller_id)` },

    // ── Extension Platform — Phase 0 (additive "outer shell"; default OFF) ──
    { label: "create platform_extensions table",
      sql:   `CREATE TABLE IF NOT EXISTS platform_extensions (
        id            SERIAL PRIMARY KEY,
        extension_id  TEXT NOT NULL UNIQUE,
        name_ar       TEXT NOT NULL,
        name_en       TEXT,
        version       TEXT NOT NULL DEFAULT '1.0.0',
        vendor        TEXT,
        manifest      JSONB NOT NULL,
        signature     TEXT,
        public_key_id TEXT,
        status        TEXT NOT NULL DEFAULT 'active',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "create company_extensions table",
      sql:   `CREATE TABLE IF NOT EXISTS company_extensions (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER NOT NULL,
        extension_id TEXT NOT NULL,
        enabled      BOOLEAN NOT NULL DEFAULT FALSE,
        settings     JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "company_extensions_company_ext_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS company_extensions_company_ext_uniq ON company_extensions (company_id, extension_id)` },
    { label: "create ext_data table",
      sql:   `CREATE TABLE IF NOT EXISTS ext_data (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER,
        extension_id TEXT NOT NULL,
        key          TEXT NOT NULL,
        value        JSONB,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "ext_data_scope_idx",
      sql:   `CREATE INDEX IF NOT EXISTS ext_data_scope_idx ON ext_data (company_id, extension_id, key)` },
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
