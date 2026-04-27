import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

// Recycle-bin / undo log for the SuperAdmin "Company Data Doctor" tool.
//
// Whenever an admin deletes a row through the data-doctor (orphan cleanup,
// duplicate removal, or full-company wipe) we first INSERT a snapshot here
// and only then DELETE from the source table — both inside a transaction.
//
// Restore = re-INSERT the payload back into the source table and stamp
// restoredAt + restoredBy. We intentionally do NOT add foreign keys to
// `users` or `companies` so this audit table survives even after the
// referenced records themselves are removed.
export const deletedRecordsTable = pgTable("deleted_records", {
  id:                serial("id").primaryKey(),

  // Logical identity of the deleted row.
  tableName:         text("table_name").notNull(),         // e.g. "customers", "invoices"
  companyId:         integer("company_id"),                // tenant scope (nullable for cross-tenant rows)
  recordId:          integer("record_id").notNull(),       // original PK in `tableName`

  // Full row snapshot at the moment of deletion. Used to restore.
  payload:           jsonb("payload").notNull(),

  // Audit fields.
  deletedAt:         timestamp("deleted_at", { withTimezone: true }).defaultNow().notNull(),
  deletedBy:         integer("deleted_by"),                // snapshot — no FK on purpose
  deletedByUsername: text("deleted_by_username"),          // snapshot for display after user removal
  reason:            text("reason"),                       // free-text reason supplied by the admin
  source:            text("source"),                       // "orphan_cleanup" | "duplicate" | "wipe_company" | "manual"

  // Restore tracking. NULL = still in recycle bin; non-NULL = already restored.
  restoredAt:        timestamp("restored_at", { withTimezone: true }),
  restoredBy:        integer("restored_by"),
}, (t) => ({
  byCompanyTime: index("deleted_records_company_time_idx").on(t.companyId, t.deletedAt),
  byTableTime:   index("deleted_records_table_time_idx").on(t.tableName, t.deletedAt),
  byRestored:    index("deleted_records_restored_idx").on(t.restoredAt),
}));

export type DeletedRecordRow    = typeof deletedRecordsTable.$inferSelect;
export type DeletedRecordInsert = typeof deletedRecordsTable.$inferInsert;
