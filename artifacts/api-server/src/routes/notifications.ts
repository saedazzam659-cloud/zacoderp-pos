import { Router } from "express";
import { db } from "@workspace/db";
import { notificationsTable, notificationReadsTable, notificationDismissalsTable } from "@workspace/db";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { extractAuth } from "../middleware/auth.js";

const router = Router();

router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

// A notification is visible to the current user when:
//   companyId matches AND (it's a broadcast OR addressed to this user).
function recipientWhere(req: any) {
  const u = req.authUser;
  // Superadmin can also read notifications addressed directly to their user_id
  // even when the notification's company_id doesn't match their (often null) one.
  if (u.role === "superadmin") {
    return or(
      and(
        eq(notificationsTable.companyId, u.companyId),
        or(isNull(notificationsTable.userId), eq(notificationsTable.userId, u.id)),
      ),
      eq(notificationsTable.userId, u.id),
    );
  }
  return and(
    eq(notificationsTable.companyId, u.companyId),
    or(isNull(notificationsTable.userId), eq(notificationsTable.userId, u.id)),
  );
}

// GET /api/notifications  ?unread=1
//   Returns notifications visible to the current user with a per-user is_read
//   flag computed from the notification_reads table (broadcast-safe).
router.get("/", async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const onlyUnread = req.query.unread === "1";

    // LEFT JOIN against notification_reads filtered by current user → is_read.
    // Filter out per-user dismissals so the row disappears for THIS user only.
    const rows = await db.execute(sql`
      SELECT n.id, n.company_id, n.user_id, n.title, n.body,
             n.severity, n.category, n.source_key,
             n.created_at, n.created_by_user_id,
             (nr.user_id IS NOT NULL)            AS is_read,
             nr.read_at                          AS read_at
      FROM notifications n
      LEFT JOIN notification_reads nr
        ON nr.notification_id = n.id AND nr.user_id = ${userId}
      LEFT JOIN notification_dismissals nd
        ON nd.notification_id = n.id AND nd.user_id = ${userId}
      WHERE nd.user_id IS NULL
        AND (
          (
            n.company_id = ${req.authUser!.companyId}
            AND (n.user_id IS NULL OR n.user_id = ${userId})
          )
          ${req.authUser!.role === "superadmin" ? sql`OR n.user_id = ${userId}` : sql``}
        )
        ${onlyUnread ? sql`AND nr.user_id IS NULL` : sql``}
      ORDER BY n.created_at DESC
      LIMIT 100
    `);
    // pg drivers sometimes return rows directly; normalize.
    const notifications = ((rows as any).rows ?? rows ?? []).map((r: any) => ({
      id: r.id, companyId: r.company_id, userId: r.user_id,
      title: r.title, body: r.body, severity: r.severity,
      category: r.category, sourceKey: r.source_key,
      createdAt: r.created_at, createdByUserId: r.created_by_user_id,
      isRead: r.is_read, readAt: r.read_at,
    }));
    res.json({ notifications });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// GET /api/notifications/unread-count
router.get("/unread-count", async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const result = await db.execute(sql`
      SELECT COUNT(*)::int AS c
      FROM notifications n
      LEFT JOIN notification_reads nr
        ON nr.notification_id = n.id AND nr.user_id = ${userId}
      LEFT JOIN notification_dismissals nd
        ON nd.notification_id = n.id AND nd.user_id = ${userId}
      WHERE nd.user_id IS NULL
        AND (
          (n.company_id = ${req.authUser!.companyId} AND (n.user_id IS NULL OR n.user_id = ${userId}))
          ${req.authUser!.role === "superadmin" ? sql`OR n.user_id = ${userId}` : sql``}
        )
        AND nr.user_id IS NULL
    `);
    const c = ((result as any).rows ?? result ?? [])[0]?.c ?? 0;
    res.json({ count: Number(c) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// POST /api/notifications/:id/read
router.post("/:id/read", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id غير صالح" }); return; }

    // Verify the user is a valid recipient before recording the read receipt.
    const [row] = await db.select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(and(eq(notificationsTable.id, id), recipientWhere(req)));
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }

    // Idempotent: ON CONFLICT DO NOTHING — second click is a no-op.
    await db.execute(sql`
      INSERT INTO notification_reads (notification_id, user_id, read_at)
      VALUES (${id}, ${req.authUser!.id}, NOW())
      ON CONFLICT (notification_id, user_id) DO NOTHING
    `);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// POST /api/notifications/read-all
//   Inserts a read-receipt for every visible-and-unread notification for this user.
router.post("/read-all", async (req, res) => {
  try {
    await db.execute(sql`
      INSERT INTO notification_reads (notification_id, user_id, read_at)
      SELECT n.id, ${req.authUser!.id}, NOW()
      FROM notifications n
      LEFT JOIN notification_reads nr
        ON nr.notification_id = n.id AND nr.user_id = ${req.authUser!.id}
      WHERE n.company_id = ${req.authUser!.companyId}
        AND (n.user_id IS NULL OR n.user_id = ${req.authUser!.id})
        AND nr.user_id IS NULL
      ON CONFLICT (notification_id, user_id) DO NOTHING
    `);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// DELETE /api/notifications/:id — per-user soft dismiss (hidden for caller only).
//   Idempotent: re-dismissing is a no-op. Caller must be a valid recipient.
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id غير صالح" }); return; }
    const [row] = await db.select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(and(eq(notificationsTable.id, id), recipientWhere(req)));
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    await db.execute(sql`
      INSERT INTO notification_dismissals (notification_id, user_id, dismissed_at)
      VALUES (${id}, ${req.authUser!.id}, NOW())
      ON CONFLICT (notification_id, user_id) DO NOTHING
    `);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// POST /api/notifications/:id/restore — undo a recent dismissal (used by Undo).
router.post("/:id/restore", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id غير صالح" }); return; }
    await db.execute(sql`
      DELETE FROM notification_dismissals
      WHERE notification_id = ${id} AND user_id = ${req.authUser!.id}
    `);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// DELETE /api/notifications/cleanup-read
//   Bulk-dismiss every notification this user has already read. One-click cleanup.
router.delete("/cleanup/read", async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const result: any = await db.execute(sql`
      INSERT INTO notification_dismissals (notification_id, user_id, dismissed_at)
      SELECT n.id, ${userId}, NOW()
      FROM notifications n
      INNER JOIN notification_reads nr
        ON nr.notification_id = n.id AND nr.user_id = ${userId}
      LEFT JOIN notification_dismissals nd
        ON nd.notification_id = n.id AND nd.user_id = ${userId}
      WHERE nd.user_id IS NULL
        AND (
          (n.company_id = ${req.authUser!.companyId} AND (n.user_id IS NULL OR n.user_id = ${userId}))
          ${req.authUser!.role === "superadmin" ? sql`OR n.user_id = ${userId}` : sql``}
        )
      ON CONFLICT (notification_id, user_id) DO NOTHING
      RETURNING notification_id
    `);
    const rows = (result as any).rows ?? result ?? [];
    res.json({ ok: true, dismissed: rows.length, ids: rows.map((r: any) => r.notification_id) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

export default router;
