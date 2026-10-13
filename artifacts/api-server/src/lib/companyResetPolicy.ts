const OPTIONAL_SCHEMA_TABLES = new Set(["integration_invoice_queue"]);

export function canSkipMissingResetTable(table: string, hasCompanyIdColumn: boolean): boolean {
  return !hasCompanyIdColumn && OPTIONAL_SCHEMA_TABLES.has(table);
}
