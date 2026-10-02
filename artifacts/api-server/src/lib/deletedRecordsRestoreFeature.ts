import { centralDb, systemSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const DELETED_RECORDS_RESTORE_KEY = "superadmin_deleted_records_restore";

/** The feature toggle is platform-wide and defaults to off when no row exists. */
export async function isDeletedRecordsRestoreEnabled(): Promise<boolean> {
  const [row] = await centralDb.select({ value: systemSettingsTable.value })
    .from(systemSettingsTable)
    .where(eq(systemSettingsTable.key, DELETED_RECORDS_RESTORE_KEY))
    .limit(1);
  return row?.value === "on";
}