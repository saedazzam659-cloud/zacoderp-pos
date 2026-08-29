import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getSchemaReconciliationState } from "../lib/ensureSchema.js";

const router: IRouter = Router();

const REQUIRED_AGENT_UPDATE_COLUMNS = {
  journal_entry_lines: [
    "supplier_name",
    "supplier_tax_number",
    "supplier_vat_number",
    "supplier_invoice_number",
    "supplier_invoice_date",
  ],
  payment_voucher_lines: [
    "supplier_name",
    "supplier_tax_number",
    "supplier_vat_number",
    "supplier_invoice_number",
    "supplier_invoice_date",
  ],
} as const;

async function installedAgentVersion(): Promise<string> {
  const appDir = process.env.ZACOD_APP_DIR || "/opt/zacod/app";
  return (await fs.readFile(path.join(appDir, "VERSION"), "utf8")).trim().slice(0, 80);
}

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * Strong post-update check used by the full-agent installer.
 *
 * A plain 200 from /healthz only proves that some process opened the port. This
 * endpoint additionally proves that the newly requested release is serving,
 * boot-time schema reconciliation completed, and the compatibility columns
 * needed by invoice posting exist in the agent's live database.
 */
router.get("/healthz/agent-update", async (req, res) => {
  const expectedVersion = typeof req.query.version === "string" ? req.query.version.trim() : "";
  if (!/^[A-Za-z0-9._-]{8,80}$/.test(expectedVersion)) {
    res.status(400).json({ status: "error", error: "invalid_version" });
    return;
  }

  try {
    const actualVersion = await installedAgentVersion();
    if (actualVersion !== expectedVersion) {
      res.status(503).json({ status: "error", error: "version_mismatch", actualVersion });
      return;
    }

    const schemaState = getSchemaReconciliationState();
    if (schemaState.state !== "ready") {
      res.status(503).json({
        status: "error",
        error: schemaState.state === "failed" ? "schema_failed" : "schema_pending",
      });
      return;
    }

    const tableNames = Object.keys(REQUIRED_AGENT_UPDATE_COLUMNS);
    const result = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [tableNames],
    );
    const present = new Set(result.rows.map(row => `${row.table_name}.${row.column_name}`));
    const missing = Object.entries(REQUIRED_AGENT_UPDATE_COLUMNS).flatMap(([tableName, columns]) =>
      columns
        .filter(columnName => !present.has(`${tableName}.${columnName}`))
        .map(columnName => `${tableName}.${columnName}`),
    );
    if (missing.length) {
      res.status(503).json({ status: "error", error: "schema_columns_missing", missing });
      return;
    }

    res.json({ status: "ok", version: actualVersion, schema: "ready" });
  } catch {
    res.status(503).json({ status: "error", error: "update_readiness_failed" });
  }
});

export default router;
