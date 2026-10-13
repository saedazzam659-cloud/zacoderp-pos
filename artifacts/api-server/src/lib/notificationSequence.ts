import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { nextSequenceNumber } from "./sequences.js";

/**
 * When a company binds the notification transaction type to a sequence,
 * number every unnumbered notification in creation order. The same advisory
 * lock is held by the whole backfill so concurrent reads cannot interleave
 * older and newer notifications.
 */
export async function ensureNotificationSequenceNumbers(companyId: number): Promise<void> {
  if (!Number.isInteger(companyId) || companyId <= 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext('notification-sequence'), ${companyId})
    `);
    const configured = await tx.execute<{ configured: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM sequences
        WHERE company_id = ${companyId}
          AND is_active = TRUE
          AND transaction_types ? 'notification'
      ) AS configured
    `);
    if (!configured.rows?.[0]?.configured) return;

    const pending = await tx.execute<{ id: number; created_at: Date | string }>(sql`
      SELECT id, created_at
      FROM notifications
      WHERE company_id = ${companyId}
        AND sequence_number IS NULL
      ORDER BY created_at ASC, id ASC
      FOR UPDATE
    `);

    for (const row of pending.rows ?? []) {
      const sequenceNumber = await nextSequenceNumber(
        companyId,
        "notification",
        {
          refTable: "notifications",
          refId: row.id,
          docDate: row.created_at,
        },
        tx,
      );
      // A period-scoped sequence may not cover every historical notification.
      // Stop at the first gap so later notifications cannot precede older ones.
      if (sequenceNumber == null) return;
      await tx.execute(sql`
        UPDATE notifications
        SET sequence_number = ${sequenceNumber}
        WHERE id = ${row.id}
          AND company_id = ${companyId}
          AND sequence_number IS NULL
      `);
    }
  });
}
