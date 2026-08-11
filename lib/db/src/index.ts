import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Re-exported so downstream packages (api-server) can open SHORT-LIVED pools
// against EXTERNAL databases (agent instances) without depending on "pg"
// directly — pg is a dependency of this package only.
export const PgPool = Pool;
export type PgPoolType = InstanceType<typeof Pool>;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const toInt = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

// statement_timeout is opt-in: a blanket cap would kill legitimate long jobs
// (historical migrations, bulk imports, large reports). Set PG_STATEMENT_TIMEOUT_MS
// only if you want a hard ceiling. 0 / unset = no statement timeout.
const statementTimeout = Number(process.env.PG_STATEMENT_TIMEOUT_MS);

const poolMax = toInt(process.env.PG_POOL_MAX, 20);

const centralPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Pool sizing — default 10 (pg default) is far too small for a multi-tenant
  // ERP under load: every request waits on a free client, causing site-wide
  // "hang"/slowness. Tunable via env without a code redeploy.
  max: poolMax,
  // Fail fast instead of hanging forever when the pool is saturated, so a
  // slow/stuck request can't make the whole UI appear frozen.
  connectionTimeoutMillis: toInt(process.env.PG_CONNECTION_TIMEOUT_MS, 10_000),
  // Release idle clients so we don't pin connections we aren't using.
  idleTimeoutMillis: toInt(process.env.PG_IDLE_TIMEOUT_MS, 30_000),
  keepAlive: true,
  ...(Number.isFinite(statementTimeout) && statementTimeout > 0
    ? { statement_timeout: statementTimeout }
    : {}),
});

// Never let an idle-client error crash the process; log and let pg recycle it.
centralPool.on("error", (err) => {
  console.error("[pg pool] idle client error:", err.message);
});

// Lightweight saturation monitor: silent under normal load, warns ONLY when
// clients are actually queued waiting for a connection (waitingCount > 0) —
// the early-warning signal of pool exhaustion. .unref() so it never keeps the
// process alive or blocks shutdown, and zero log noise when healthy. Disable
// with PG_POOL_LOG=0; tune cadence with PG_POOL_LOG_INTERVAL_MS.
if (process.env.PG_POOL_LOG !== "0" && process.env.PG_POOL_LOG !== "false") {
  const monitor = setInterval(() => {
    if (centralPool.waitingCount > 0) {
      console.warn(
        `[pg pool] saturated: waiting=${centralPool.waitingCount} total=${centralPool.totalCount} idle=${centralPool.idleCount} max=${poolMax}`,
      );
    }
  }, toInt(process.env.PG_POOL_LOG_INTERVAL_MS, 30_000));
  monitor.unref();
}

// ─── External datasource routing (agent instances) ─────────────────────────
// Requests served for a reseller/agent domain must read/write the AGENT's
// external PostgreSQL instead of the central DB, without touching the
// hundreds of modules that `import { db } from "@workspace/db"` at module
// scope. We do this with AsyncLocalStorage: the exported `db` and `pool` are
// thin proxies that resolve to the active request's datasource (set via
// `runWithExternalDb`) or fall back to the central instances.
// ALS propagates through await/promises, so one middleware wrap covers the
// whole request handler chain — including transactions and ensureSchema DDL.
import { AsyncLocalStorage } from "node:async_hooks";

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;
export type ExternalDbContext = { db: DrizzleDb; pool: InstanceType<typeof Pool> };

const dbAls = new AsyncLocalStorage<ExternalDbContext>();

/** Create a drizzle instance + pool over an EXTERNAL PostgreSQL URL (agent DB). */
export function createExternalDb(connectionString: string, opts?: { max?: number }): ExternalDbContext {
  const p = new Pool({
    connectionString,
    max: opts?.max ?? 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    ssl: connectionString.includes("sslmode=disable") ? undefined : { rejectUnauthorized: false },
  });
  p.on("error", (err) => console.error("[pg external pool] idle client error:", err.message));
  return { db: drizzle(p, { schema }), pool: p };
}

/** Run `fn` with all `db`/`pool` usage routed to the given external datasource. */
export function runWithExternalDb<T>(ctx: ExternalDbContext, fn: () => T): T {
  return dbAls.run(ctx, fn);
}

/** The external context active for the current async chain, if any. */
export function getActiveExternalDb(): ExternalDbContext | undefined {
  return dbAls.getStore();
}

function alsProxy<T extends object>(central: T, pick: (s: ExternalDbContext) => T): T {
  return new Proxy(central, {
    get(target, prop) {
      const s = dbAls.getStore();
      const actual: any = s ? pick(s) : target;
      const v = actual[prop];
      return typeof v === "function" ? v.bind(actual) : v;
    },
  });
}

const _centralDb = drizzle(centralPool, { schema });

export const pool = alsProxy(centralPool, (s) => s.pool);
export const db = alsProxy(_centralDb, (s) => s.db);

// Control-plane accessors: ALWAYS the central database, regardless of any
// active external-DB request context. Registry lookups (agent_instances,
// security events, host→agent resolution, license checks) MUST use these —
// an agent's cloned DB has an empty registry, so letting those reads follow
// the ALS proxy would silently disable suspend/register-block enforcement.
export const centralDb = _centralDb;
export { centralPool };

export * from "./schema";
