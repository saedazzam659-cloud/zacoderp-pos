import { db } from "@workspace/db";
import { inboxMessagesTable, notificationsTable, usersTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { objectStorageClient } from "./objectStorage.js";

// ----- helpers ----------------------------------------------------------------

function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  if (parts.length < 3) throw new Error("Invalid object path: " + path);
  const bucketName = parts[1];
  const objectName = parts.slice(2).join("/");
  return { bucketName, objectName };
}

/**
 * Upload a buffer to private object storage and return the
 * internal `/objects/<id>` path used by /api/storage/objects/*.
 */
export async function uploadInboxAttachment(opts: {
  buffer: Buffer;
  contentType: string;
  filename: string;
}): Promise<string> {
  const dir = process.env.PRIVATE_OBJECT_DIR;
  if (!dir) throw new Error("PRIVATE_OBJECT_DIR not set");
  const objectId = randomUUID();
  const fullPath = `${dir.replace(/\/+$/, "")}/inbox/${objectId}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  await file.save(opts.buffer, {
    contentType: opts.contentType,
    metadata: { contentType: opts.contentType, metadata: { originalName: opts.filename } },
    resumable: false,
  });
  // Public-facing entity path: /objects/inbox/<id>
  return `/objects/inbox/${objectId}`;
}

// ----- main delivery API ------------------------------------------------------

export interface DeliverReportInput {
  companyId: number;
  /** NULL → broadcast to all users in the company. */
  recipientUserIds: number[] | null;
  subject: string;
  /** HTML body for inbox preview. Plain text is fine too. */
  body: string;
  attachment?: {
    filename: string;
    mime: string;
    buffer: Buffer;
  };
  createdByUserId?: number;
  /** Notification category — defaults to "report". */
  category?: string;
  /** Notification severity — info | low | medium | high. */
  severity?: "info" | "low" | "medium" | "high";
}

export interface DeliverReportResult {
  inboxMessageIds: number[];
  notificationIds: number[];
  attachmentUrl: string | null;
}

/**
 * Drop a report into one or more users' in-app inboxes AND fire the
 * notification bell so they see it immediately. Used by manual delivery
 * actions and by the AI report endpoint.
 */
export async function deliverReport(input: DeliverReportInput): Promise<DeliverReportResult> {
  const {
    companyId, recipientUserIds, subject, body,
    attachment, createdByUserId,
  } = input;
  const category = input.category || "report";
  const severity = input.severity || "info";

  // 1) Upload attachment once (shared across recipients).
  let attachmentUrl: string | null = null;
  if (attachment) {
    attachmentUrl = await uploadInboxAttachment({
      buffer: attachment.buffer,
      contentType: attachment.mime,
      filename: attachment.filename,
    });
  }

  // 2) Resolve recipient list (NULL = broadcast → still create one row per
  //    user so that read state and the per-user counters work cleanly).
  let recipients: (number | null)[];
  if (recipientUserIds === null) {
    // Broadcast: insert ONE row with recipient_user_id = NULL so it's visible
    // to every user in the company (matches the inbox-recipientWhere clause).
    recipients = [null];
  } else if (recipientUserIds.length === 0) {
    // No recipients — clean up the orphan attachment we just uploaded.
    if (attachmentUrl) await deleteAttachmentSafely(attachmentUrl);
    return { inboxMessageIds: [], notificationIds: [], attachmentUrl: null };
  } else {
    recipients = recipientUserIds;
  }

  const inboxIds: number[] = [];
  const notifIds: number[] = [];

  try {
    // Wrap fanout inserts in a transaction so partial failures don't
    // leave half-delivered (inbox row without notification, or vice-versa).
    await db.transaction(async (tx) => {
      for (const userId of recipients) {
        const [inserted] = await tx.insert(inboxMessagesTable).values({
          companyId,
          recipientUserId: userId ?? null,
          kind: "report",
          subject,
          body,
          attachmentUrl: attachmentUrl,
          attachmentFilename: attachment?.filename ?? null,
          attachmentMime: attachment?.mime ?? null,
          createdByUserId: createdByUserId ?? null,
        }).returning({ id: inboxMessagesTable.id });
        inboxIds.push(inserted.id);

        // Create a matching notification so the bell wakes up.
        const [notif] = await tx.insert(notificationsTable).values({
          companyId,
          userId: userId ?? null,
          title: subject,
          // Short body: a one-liner. Full body lives in the inbox row.
          body: attachment
            ? `📎 ${attachment.filename} — افتح صندوق الوارد للتفاصيل والتحميل.`
            : "افتح صندوق الوارد لقراءة التقرير.",
          severity,
          category,
          sourceKey: `inbox:${inserted.id}`,
          createdByUserId: createdByUserId ?? null,
        }).returning({ id: notificationsTable.id });
        notifIds.push(notif.id);

        // Cross-link
        await tx.update(inboxMessagesTable)
          .set({ notificationId: notif.id })
          .where(eq(inboxMessagesTable.id, inserted.id));
      }
    });
  } catch (err) {
    // Transaction rolled back → no DB rows reference the uploaded blob.
    if (attachmentUrl) await deleteAttachmentSafely(attachmentUrl);
    throw err;
  }

  return { inboxMessageIds: inboxIds, notificationIds: notifIds, attachmentUrl };
}

async function deleteAttachmentSafely(entityPath: string): Promise<void> {
  try {
    if (!/^\/objects\/inbox\/[a-f0-9-]{36}$/i.test(entityPath)) return;
    const dir = process.env.PRIVATE_OBJECT_DIR;
    if (!dir) return;
    const objectId = entityPath.split("/").pop()!;
    const fullPath = `${dir.replace(/\/+$/, "")}/inbox/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    await objectStorageClient.bucket(bucketName).file(objectName).delete({ ignoreNotFound: true } as any);
  } catch { /* best-effort GC */ }
}

/**
 * Resolve "all admins of a company" for cases where we want to deliver
 * AI/digest reports to every admin (default audience).
 */
export async function getCompanyAdminUserIds(companyId: number): Promise<number[]> {
  const rows = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.companyId, companyId), eq(usersTable.role, "admin")));
  return rows.map(r => r.id);
}
