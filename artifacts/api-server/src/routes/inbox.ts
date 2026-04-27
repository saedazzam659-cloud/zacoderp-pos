import { Router } from "express";
import { db } from "@workspace/db";
import { inboxMessagesTable, notificationsTable } from "@workspace/db";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { extractAuth } from "../middleware/auth.js";
import { objectStorageClient } from "../lib/objectStorage.js";

const router = Router();

router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

// A message is visible to the current user when:
//   companyId matches AND (recipientUserId NULL → broadcast OR matches user.id).
function recipientWhere(req: any) {
  const u = req.authUser;
  return and(
    eq(inboxMessagesTable.companyId, u.companyId),
    or(isNull(inboxMessagesTable.recipientUserId), eq(inboxMessagesTable.recipientUserId, u.id)),
  );
}

// GET /api/inbox?unreadOnly=1&limit=50
router.get("/", async (req, res) => {
  try {
    const u = req.authUser!;
    const onlyUnread = req.query.unreadOnly === "1" || req.query.unread === "1";
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 100;
    const conds: any[] = [recipientWhere(req)];
    if (onlyUnread) conds.push(isNull(inboxMessagesTable.readAt));

    const rows = await db.select({
      id: inboxMessagesTable.id,
      kind: inboxMessagesTable.kind,
      subject: inboxMessagesTable.subject,
      attachmentFilename: inboxMessagesTable.attachmentFilename,
      attachmentMime: inboxMessagesTable.attachmentMime,
      hasAttachment: sql<boolean>`(${inboxMessagesTable.attachmentUrl} IS NOT NULL)`,
      createdAt: inboxMessagesTable.createdAt,
      readAt: inboxMessagesTable.readAt,
      recipientUserId: inboxMessagesTable.recipientUserId,
    })
      .from(inboxMessagesTable)
      .where(and(...conds))
      .orderBy(desc(inboxMessagesTable.createdAt))
      .limit(limit);

    res.json({ messages: rows.map(r => ({ ...r, isRead: r.readAt !== null })) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// GET /api/inbox/unread-count
router.get("/unread-count", async (req, res) => {
  try {
    const result: any = await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM inbox_messages
      WHERE company_id = ${req.authUser!.companyId}
        AND (recipient_user_id IS NULL OR recipient_user_id = ${req.authUser!.id})
        AND read_at IS NULL
    `);
    const c = (result.rows ?? result ?? [])[0]?.c ?? 0;
    res.json({ count: Number(c) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// GET /api/inbox/:id  → full body
router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id غير صالح" }); return; }
    const [row] = await db.select().from(inboxMessagesTable)
      .where(and(eq(inboxMessagesTable.id, id), recipientWhere(req)));
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json({ message: { ...row, isRead: row.readAt !== null } });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// POST /api/inbox/:id/read
router.post("/:id/read", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id غير صالح" }); return; }
    const [row] = await db.select({ id: inboxMessagesTable.id, notificationId: inboxMessagesTable.notificationId })
      .from(inboxMessagesTable)
      .where(and(eq(inboxMessagesTable.id, id), recipientWhere(req)));
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    await db.execute(sql`
      UPDATE inbox_messages SET read_at = NOW()
      WHERE id = ${id} AND read_at IS NULL
    `);
    // Also mark the cross-linked bell notification read so the badge
    // decrements when the user opens the report from /inbox.
    if (row.notificationId) {
      await db.execute(sql`
        UPDATE notifications SET is_read = TRUE, read_at = NOW()
        WHERE id = ${row.notificationId} AND is_read = FALSE
      `).catch(() => { /* ignore — column-shape variance across envs */ });
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// POST /api/inbox/read-all
router.post("/read-all", async (req, res) => {
  try {
    const u = req.authUser!;
    // Collect notif ids tied to inbox rows we're about to mark read.
    const linkedNotifs: any = await db.execute(sql`
      SELECT notification_id FROM inbox_messages
      WHERE company_id = ${u.companyId}
        AND (recipient_user_id IS NULL OR recipient_user_id = ${u.id})
        AND read_at IS NULL
        AND notification_id IS NOT NULL
    `);
    const notifIds: number[] = (linkedNotifs.rows ?? linkedNotifs ?? [])
      .map((r: any) => r.notification_id).filter((n: any) => Number.isInteger(n));

    await db.execute(sql`
      UPDATE inbox_messages SET read_at = NOW()
      WHERE company_id = ${u.companyId}
        AND (recipient_user_id IS NULL OR recipient_user_id = ${u.id})
        AND read_at IS NULL
    `);
    if (notifIds.length) {
      await db.execute(sql`
        UPDATE notifications SET is_read = TRUE, read_at = NOW()
        WHERE id = ANY(${notifIds}) AND is_read = FALSE
      `).catch(() => { /* tolerate column variance */ });
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// GET /api/inbox/:id/attachment — ACL-checked stream of the CSV.
// Bypasses the generic /api/storage/objects route so attachments are
// strictly scoped to the recipient company/user.
router.get("/:id/attachment", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id غير صالح" }); return; }
    const [row] = await db.select({
      attachmentUrl: inboxMessagesTable.attachmentUrl,
      attachmentFilename: inboxMessagesTable.attachmentFilename,
      attachmentMime: inboxMessagesTable.attachmentMime,
    }).from(inboxMessagesTable)
      .where(and(eq(inboxMessagesTable.id, id), recipientWhere(req)));
    if (!row || !row.attachmentUrl) { res.status(404).json({ error: "لا يوجد مرفق" }); return; }

    // Whitelist the path shape so a poisoned attachment_url cannot
    // escape into other buckets / paths.
    if (!/^\/objects\/inbox\/[a-f0-9-]{36}$/i.test(row.attachmentUrl)) {
      res.status(400).json({ error: "مسار المرفق غير صالح" });
      return;
    }
    const dir = process.env.PRIVATE_OBJECT_DIR;
    if (!dir) { res.status(500).json({ error: "تخزين الملفات غير مهيأ" }); return; }
    const objectId = row.attachmentUrl.split("/").pop()!;
    const fullPath = `${dir.replace(/\/+$/, "")}/inbox/${objectId}`;
    const m = fullPath.match(/^\/([^/]+)\/(.+)$/);
    if (!m) { res.status(500).json({ error: "خطأ في المسار" }); return; }
    const [, bucket, name] = m;

    const file = objectStorageClient.bucket(bucket).file(name);
    const [exists] = await file.exists();
    if (!exists) { res.status(404).json({ error: "الملف غير موجود" }); return; }
    res.setHeader("Content-Type", row.attachmentMime || "application/octet-stream");
    res.setHeader("Cache-Control", "private, no-store");
    if (row.attachmentFilename) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(row.attachmentFilename)}"`,
      );
    }
    file.createReadStream()
      .on("error", (err: any) => {
        if (!res.headersSent) res.status(500).json({ error: err?.message || "خطأ تحميل" });
      })
      .pipe(res);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// DELETE /api/inbox/:id
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id غير صالح" }); return; }
    const [row] = await db.select({ id: inboxMessagesTable.id })
      .from(inboxMessagesTable)
      .where(and(eq(inboxMessagesTable.id, id), recipientWhere(req)));
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    await db.delete(inboxMessagesTable).where(eq(inboxMessagesTable.id, id));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

export default router;
