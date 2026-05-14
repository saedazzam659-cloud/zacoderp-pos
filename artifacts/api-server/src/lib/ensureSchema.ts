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
    // Phase 1B.2 — explicit Basic-auth secret storage and rotation marker
    { label: "gateway_clients add zatca_csid_secret_enc",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS zatca_csid_secret_enc TEXT` },
    { label: "gateway_clients add zatca_pcsid_secret_enc",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS zatca_pcsid_secret_enc TEXT` },
    { label: "gateway_clients add csid_last_rotated_at",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS csid_last_rotated_at TIMESTAMP` },

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
