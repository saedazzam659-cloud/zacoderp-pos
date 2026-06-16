import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

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

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Pool sizing — default 10 (pg default) is far too small for a multi-tenant
  // ERP under load: every request waits on a free client, causing site-wide
  // "hang"/slowness. Tunable via env without a code redeploy.
  max: toInt(process.env.PG_POOL_MAX, 20),
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
pool.on("error", (err) => {
  console.error("[pg pool] idle client error:", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
