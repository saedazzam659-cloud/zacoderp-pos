const EXTERNAL_AGENT_FORBIDDEN_ACCELERATION_COLUMNS = [
  "invoice_acceleration_mode",
  "invoice_trial_remaining",
  "invoice_acceleration_last_error",
  "invoice_acceleration_reason",
  "invoice_acceleration_updated_at",
  "invoice_acceleration_generation",
  "invoice_acceleration_baseline",
] as const;

/**
 * Convert a central schema-only pg_dump into an external-agent-safe schema.
 *
 * The telemetry table must already be excluded by pg_dump. Seeing it here is
 * treated as a configuration failure rather than trying to remove a multi-line
 * CREATE TABLE block with fragile text surgery.
 */
export function sanitizeSchemaDumpForExternalAgent(dumpSql: string): string {
  if (/\bagent_invoice_samples\b/i.test(dumpSql)) {
    throw new Error("رفض تهيئة قاعدة الوكيل: تسرّب جدول قياسات مركزي إلى مخطط الوكيل");
  }
  const cleaned = dumpSql
    .split("\n")
    .filter(line => !line.startsWith("\\"))
    .filter(line => !EXTERNAL_AGENT_FORBIDDEN_ACCELERATION_COLUMNS.some(column =>
      new RegExp(`\\b${column}\\b`, "i").test(line),
    ))
    .join("\n");
  for (const column of EXTERNAL_AGENT_FORBIDDEN_ACCELERATION_COLUMNS) {
    if (new RegExp(`\\b${column}\\b`, "i").test(cleaned)) {
      throw new Error(`رفض تهيئة قاعدة الوكيل: بقي عمود تحكم مركزي ${column}`);
    }
  }
  return cleaned;
}