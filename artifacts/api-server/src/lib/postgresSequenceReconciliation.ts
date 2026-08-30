import { sql } from "drizzle-orm";

type SqlExecutor = {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
};

type OwnedSequence = {
  table_schema: string;
  table_name: string;
  column_name: string;
  sequence_schema: string;
  sequence_name: string;
  sequence_cache: string | number;
};

export type SequenceReconciliationResult = {
  inspected: number;
  advanced: number;
};

function resultRows(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? result as Record<string, unknown>[]
    : ((result as { rows?: Record<string, unknown>[] } | null)?.rows ?? []);
}

/** Quote an identifier obtained from PostgreSQL's catalog. */
export function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Bring owned SERIAL and IDENTITY sequences up to the greatest value currently
 * stored in their columns.
 *
 * Empty tables are deliberately untouched. Likewise, a sequence which is
 * already ahead is never restarted, so reconciliation cannot consume or lower
 * an allocation made by another writer. Before inspecting either state, each
 * table and its owned sequence are locked until repair is complete; callers
 * must provide a transaction so both lock lifetimes cover the read and restart.
 * Catalog-derived identifiers are quoted before use and
 * the optional allow-list limits restore callers to the live tables which they
 * actually restored.
 */
export async function reconcilePostgresSequences(
  executor: SqlExecutor,
  options: { tables?: Iterable<string> } = {},
): Promise<SequenceReconciliationResult> {
  const allowedTables = options.tables ? new Set(options.tables) : null;
  if (allowedTables?.size === 0) return { inspected: 0, advanced: 0 };

  const owned = resultRows(await executor.execute(sql`
    SELECT
      table_ns.nspname AS table_schema,
      table_class.relname AS table_name,
      attribute.attname AS column_name,
      sequence_ns.nspname AS sequence_schema,
      sequence_class.relname AS sequence_name,
      sequence_info.seqcache AS sequence_cache
    FROM pg_catalog.pg_class table_class
    JOIN pg_catalog.pg_namespace table_ns
      ON table_ns.oid = table_class.relnamespace
    JOIN pg_catalog.pg_attribute attribute
      ON attribute.attrelid = table_class.oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    JOIN pg_catalog.pg_depend dependency
      ON dependency.refobjid = table_class.oid
      AND dependency.refobjsubid = attribute.attnum
      AND dependency.deptype IN ('a', 'i')
    JOIN pg_catalog.pg_class sequence_class
      ON sequence_class.oid = dependency.objid
      AND sequence_class.relkind = 'S'
    JOIN pg_catalog.pg_namespace sequence_ns
      ON sequence_ns.oid = sequence_class.relnamespace
    JOIN pg_catalog.pg_sequence sequence_info
      ON sequence_info.seqrelid = sequence_class.oid
    WHERE table_ns.nspname = 'public'
      AND table_class.relkind IN ('r', 'p')
    ORDER BY table_class.relname, attribute.attnum
  `)) as unknown as OwnedSequence[];

  let inspected = 0;
  let advanced = 0;
  for (const item of owned) {
    if (allowedTables && !allowedTables.has(item.table_name)) continue;
    inspected++;

    const table = `${quotePostgresIdentifier(item.table_schema)}.${quotePostgresIdentifier(item.table_name)}`;
    const column = quotePostgresIdentifier(item.column_name);
    const sequence = `${quotePostgresIdentifier(item.sequence_schema)}.${quotePostgresIdentifier(item.sequence_name)}`;
    // Block table writers first, then take the sequence relation's own
    // AccessExclusiveLock through a no-op ALTER. Unlike setval(), ALTER
    // SEQUENCE coordinates with nextval(), so no allocation can slip between
    // the state read and the repair while this transaction remains open.
    await executor.execute(sql.raw(`LOCK TABLE ${table} IN EXCLUSIVE MODE`));
    const sequenceCache = BigInt(String(item.sequence_cache));
    await executor.execute(sql.raw(`ALTER SEQUENCE ${sequence} CACHE ${sequenceCache.toString()}`));
    const state = resultRows(await executor.execute(sql.raw(`
      SELECT
        (SELECT max(${column})::bigint FROM ${table}) AS table_max,
        last_value::bigint AS last_value,
        is_called
      FROM ${sequence}
    `)))[0];
    const tableMax = state?.table_max == null ? null : BigInt(String(state.table_max));
    const lastValue = state?.last_value == null ? null : BigInt(String(state.last_value));
    const isCalled = state?.is_called === true || state?.is_called === "true";
    if (
      tableMax != null
      && lastValue != null
      && (tableMax > lastValue || (tableMax === lastValue && !isCalled))
    ) {
      await executor.execute(sql.raw(
        `ALTER SEQUENCE ${sequence} RESTART WITH ${(tableMax + 1n).toString()}`,
      ));
      advanced++;
    }
  }
  return { inspected, advanced };
}
