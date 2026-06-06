// ─────────────────────────────────────────────────────────────────────────
// Internal Chat module — REST endpoints. Real-time delivery is handled by
// React Query polling on the client (3s on the active conversation, 10s on
// the conversation list); a dedicated Socket.io upgrade can land later
// without changing this contract.
//
// Multi-tenant invariants:
//   - Every conversation carries companyId; participants must belong to the
//     same company. Cross-tenant access is rejected.
//   - The current user must be a participant of any conversation they read
//     from or write to.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  chatConversationsTable, chatParticipantsTable, chatMessagesTable,
  usersTable,
} from "@workspace/db";
import { and, eq, desc, asc, inArray, sql, gt, isNull, or, ne } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { emitToUser } from "../lib/sessionEvents.js";

const router = Router();
router.use(extractAuth);
// Internal chat is gated as a single access unit: any user the company admin
// has granted `chat` (view) to may fully participate — read, send, and use the
// AI tools. The per-message DELETE handler still enforces ownership (only the
// sender or an admin can erase a message). We intentionally do NOT use
// requireModulePermission here: it would demand chat.create/edit/delete for
// mutations, but the `chat` permission module only exposes `view`, so regular
// users could never send a message (403 "صلاحيات غير كافية للوصول إلى chat").
router.use(requirePermission("chat", "view"));

function getCid(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.query.companyId ?? req.body?.companyId ?? req.authUser?.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

async function isParticipant(conversationId: number, userId: number): Promise<boolean> {
  const [row] = await db.select({ id: chatParticipantsTable.id })
    .from(chatParticipantsTable)
    .where(and(
      eq(chatParticipantsTable.conversationId, conversationId),
      eq(chatParticipantsTable.userId, userId),
    ))
    .limit(1);
  return !!row;
}

async function loadConversationForUser(conversationId: number, cid: number, userId: number) {
  const [conv] = await db.select().from(chatConversationsTable)
    .where(and(
      eq(chatConversationsTable.id, conversationId),
      eq(chatConversationsTable.companyId, cid),
    ))
    .limit(1);
  if (!conv) return null;
  if (!(await isParticipant(conversationId, userId))) return null;
  return conv;
}

// ─── GET /chat/users ──────────────────────────────────────────────────────
// Pickable directory of company colleagues for starting / inviting to chats.
router.get("/users", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const rows = await db.select({
      id: usersTable.id, username: usersTable.username,
      nameAr: usersTable.nameAr, nameEn: usersTable.nameEn,
      role: usersTable.role,
    }).from(usersTable)
      .where(and(
        eq(usersTable.companyId, cid),
        eq(usersTable.isActive, true),
        ne(usersTable.id, userId),
      ))
      .orderBy(asc(usersTable.username))
      .limit(500);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /chat/conversations ──────────────────────────────────────────────
// List all conversations the current user participates in, with last
// message snippet, unread count, and counter-party info for direct chats.
router.get("/conversations", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const result: any = await db.execute(sql`
      WITH my_convs AS (
        SELECT c.*, p.last_read_message_id
          FROM chat_conversations c
          JOIN chat_participants p ON p.conversation_id = c.id
         WHERE c.company_id = ${cid} AND p.user_id = ${userId}
      ), last_msg AS (
        SELECT DISTINCT ON (m.conversation_id)
               m.conversation_id, m.id, m.body, m.kind, m.created_at, m.sender_user_id
          FROM chat_messages m
         WHERE m.conversation_id IN (SELECT id FROM my_convs)
           AND m.deleted_at IS NULL
         ORDER BY m.conversation_id, m.created_at DESC, m.id DESC
      ), unread AS (
        SELECT m.conversation_id, COUNT(*)::int AS c
          FROM chat_messages m
          JOIN my_convs mc ON mc.id = m.conversation_id
         WHERE m.deleted_at IS NULL
           AND m.sender_user_id <> ${userId}
           AND (mc.last_read_message_id IS NULL OR m.id > mc.last_read_message_id)
         GROUP BY m.conversation_id
      )
      SELECT mc.id, mc.kind, mc.title, mc.created_by_user_id AS "createdByUserId",
             mc.created_at AS "createdAt", mc.last_message_at AS "lastMessageAt",
             lm.body  AS "lastMessageBody",
             lm.kind  AS "lastMessageKind",
             lm.created_at AS "lastMessageCreatedAt",
             lm.sender_user_id AS "lastMessageSenderUserId",
             COALESCE(u.c, 0) AS "unreadCount"
        FROM my_convs mc
        LEFT JOIN last_msg lm ON lm.conversation_id = mc.id
        LEFT JOIN unread   u  ON u.conversation_id  = mc.id
       ORDER BY mc.last_message_at DESC
       LIMIT 200
    `);
    const convs = (result.rows ?? []) as any[];

    // Enrich with participants (id + name) so the UI can render avatars
    // and resolve the counter-party of direct chats client-side.
    const ids = convs.map(c => c.id);
    const participants = ids.length ? await db.select({
      conversationId: chatParticipantsTable.conversationId,
      userId: chatParticipantsTable.userId,
      role: chatParticipantsTable.role,
      username: usersTable.username,
      nameAr: usersTable.nameAr,
      nameEn: usersTable.nameEn,
    }).from(chatParticipantsTable)
      .leftJoin(usersTable, eq(usersTable.id, chatParticipantsTable.userId))
      .where(inArray(chatParticipantsTable.conversationId, ids)) : [];
    const byConv = new Map<number, any[]>();
    for (const p of participants) {
      const list = byConv.get(p.conversationId) ?? [];
      list.push(p);
      byConv.set(p.conversationId, list);
    }
    res.json(convs.map(c => ({
      ...c,
      unreadCount: Number(c.unreadCount || 0),
      participants: byConv.get(c.id) ?? [],
    })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /chat/conversations ─────────────────────────────────────────────
// Create a direct (1:1) or group conversation. For direct chats we
// transparently return the existing conversation if one already exists
// between the same two users, so the UI never creates duplicates.
const CreateBody = z.object({
  kind: z.enum(["direct", "group"]),
  title: z.string().max(120).optional().nullable(),
  participantUserIds: z.array(z.number().int().positive()).min(1),
});
router.post("/conversations", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "بيانات غير صحيحة" }); return; }
    const { kind, title } = parsed.data;
    // Always include the creator. Dedupe & strip self for safety.
    const others = Array.from(new Set(parsed.data.participantUserIds.filter(id => id !== userId)));
    if (others.length === 0) { res.status(400).json({ error: "يجب اختيار مستخدم واحد على الأقل" }); return; }

    // Validate every other user belongs to the same company.
    const valid = await db.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.companyId, cid), inArray(usersTable.id, others)));
    if (valid.length !== others.length) {
      res.status(400).json({ error: "أحد المستخدمين غير موجود أو من شركة أخرى" }); return;
    }

    if (kind === "direct") {
      if (others.length !== 1) { res.status(400).json({ error: "المحادثة الفردية تتطلب مستخدماً واحداً" }); return; }
      // Find existing direct chat between these two users in this company.
      const existing: any = await db.execute(sql`
        SELECT c.id FROM chat_conversations c
          JOIN chat_participants p1 ON p1.conversation_id = c.id AND p1.user_id = ${userId}
          JOIN chat_participants p2 ON p2.conversation_id = c.id AND p2.user_id = ${others[0]}
         WHERE c.company_id = ${cid} AND c.kind = 'direct'
         LIMIT 1
      `);
      const hit = existing.rows?.[0];
      if (hit) { res.json({ id: hit.id, existed: true }); return; }
    }

    const [conv] = await db.insert(chatConversationsTable).values({
      companyId: cid, kind, title: title ?? null, createdByUserId: userId,
    }).returning();
    const allUserIds = Array.from(new Set([userId, ...others]));
    await db.insert(chatParticipantsTable).values(
      allUserIds.map(uid => ({
        conversationId: conv.id, userId: uid,
        role: uid === userId ? "owner" : "member",
      }))
    );
    res.json({ id: conv.id, existed: false });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /chat/conversations/:id/messages ─────────────────────────────────
// Paginated history. Supports ?since=<id> for incremental real-time poll
// (returns only newer rows) and ?before=<id> for scroll-back pagination.
router.get("/conversations/:id/messages", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const convId = Number(req.params.id);
    if (!Number.isFinite(convId)) { res.status(400).json({ error: "معرّف غير صحيح" }); return; }
    const conv = await loadConversationForUser(convId, cid, userId);
    if (!conv) { res.status(404).json({ error: "غير موجود" }); return; }

    const since = req.query.since ? Number(req.query.since) : null;
    const before = req.query.before ? Number(req.query.before) : null;
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const conds = [eq(chatMessagesTable.conversationId, convId)];
    if (since)  conds.push(gt(chatMessagesTable.id, since));
    if (before) conds.push(sql`${chatMessagesTable.id} < ${before}`);

    const rows = await db.select().from(chatMessagesTable)
      .where(and(...conds))
      .orderBy(since ? asc(chatMessagesTable.id) : desc(chatMessagesTable.id))
      .limit(limit);

    // Sender enrichment.
    const senderIds = Array.from(new Set(rows.map(r => r.senderUserId).filter(Boolean) as number[]));
    const senders = senderIds.length ? await db.select({
      id: usersTable.id, username: usersTable.username,
      nameAr: usersTable.nameAr, nameEn: usersTable.nameEn,
    }).from(usersTable).where(inArray(usersTable.id, senderIds)) : [];
    const byId = new Map(senders.map(s => [s.id, s]));

    const enriched = rows.map(r => ({
      ...r,
      // Soft-deleted messages render as a tombstone on the client.
      body: r.deletedAt ? "" : r.body,
      sender: r.senderUserId ? byId.get(r.senderUserId) ?? null : null,
    }));

    // Always return chronological order regardless of query direction.
    enriched.sort((a, b) => a.id - b.id);
    res.json(enriched);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /chat/conversations/:id/messages ────────────────────────────────
const SendBody = z.object({
  body: z.string().max(8000).default(""),
  kind: z.enum(["text", "image", "file"]).default("text"),
  attachmentUrl:  z.string().max(2000).optional().nullable(),
  attachmentName: z.string().max(300).optional().nullable(),
  attachmentMime: z.string().max(120).optional().nullable(),
  attachmentSize: z.number().int().nonnegative().optional().nullable(),
  replyToId:      z.number().int().positive().optional().nullable(),
});
router.post("/conversations/:id/messages", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const convId = Number(req.params.id);
    const conv = await loadConversationForUser(convId, cid, userId);
    if (!conv) { res.status(404).json({ error: "غير موجود" }); return; }
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "بيانات غير صحيحة" }); return; }
    const p = parsed.data;
    if (!p.body.trim() && !p.attachmentUrl) {
      res.status(400).json({ error: "الرسالة فارغة" }); return;
    }
    const [msg] = await db.insert(chatMessagesTable).values({
      conversationId: convId, companyId: cid, senderUserId: userId,
      kind: p.kind, body: p.body,
      attachmentUrl: p.attachmentUrl ?? null,
      attachmentName: p.attachmentName ?? null,
      attachmentMime: p.attachmentMime ?? null,
      attachmentSize: p.attachmentSize ?? null,
      replyToId: p.replyToId ?? null,
    }).returning();
    // Bump conversation activity + auto-mark the sender's own read marker.
    await db.update(chatConversationsTable)
      .set({ lastMessageAt: new Date() })
      .where(eq(chatConversationsTable.id, convId));
    await db.update(chatParticipantsTable)
      .set({ lastReadMessageId: msg.id, lastReadAt: new Date() })
      .where(and(
        eq(chatParticipantsTable.conversationId, convId),
        eq(chatParticipantsTable.userId, userId),
      ));
    res.json({ ...msg, sender: { id: userId, username: req.authUser!.username, nameAr: null, nameEn: null } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /chat/conversations/:id/read ────────────────────────────────────
// Mark all messages up to (and including) the given messageId as read.
router.post("/conversations/:id/read", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const convId = Number(req.params.id);
    const conv = await loadConversationForUser(convId, cid, userId);
    if (!conv) { res.status(404).json({ error: "غير موجود" }); return; }
    const messageId = Number(req.body?.messageId);
    if (!Number.isFinite(messageId)) { res.status(400).json({ error: "معرّف الرسالة مطلوب" }); return; }
    // Integrity: the messageId must actually belong to this conversation,
    // otherwise a malicious client could pass an arbitrarily large id and
    // permanently zero out their unread count for future messages.
    const [belongs] = await db.select({ id: chatMessagesTable.id })
      .from(chatMessagesTable)
      .where(and(
        eq(chatMessagesTable.id, messageId),
        eq(chatMessagesTable.conversationId, convId),
      ))
      .limit(1);
    if (!belongs) { res.status(400).json({ error: "الرسالة لا تنتمي لهذه المحادثة" }); return; }
    await db.update(chatParticipantsTable)
      .set({ lastReadMessageId: messageId, lastReadAt: new Date() })
      .where(and(
        eq(chatParticipantsTable.conversationId, convId),
        eq(chatParticipantsTable.userId, userId),
      ));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /chat/messages/:id ────────────────────────────────────────────
// Soft-delete: only the sender (or an admin) can erase their own message.
router.delete("/messages/:id", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    const [msg] = await db.select().from(chatMessagesTable)
      .where(and(eq(chatMessagesTable.id, id), eq(chatMessagesTable.companyId, cid)))
      .limit(1);
    if (!msg) { res.status(404).json({ error: "غير موجود" }); return; }
    // Even within the same tenant, the requester must be a participant of
    // the conversation. Otherwise a company admin could quietly purge any
    // private 1:1 message they were never party to.
    if (!(await isParticipant(msg.conversationId, userId))) {
      res.status(404).json({ error: "غير موجود" }); return;
    }
    if (msg.senderUserId !== userId && req.authUser!.role !== "admin") {
      res.status(403).json({ error: "لا يمكنك حذف رسالة الآخرين" }); return;
    }
    await db.update(chatMessagesTable)
      .set({ deletedAt: new Date(), body: "" })
      .where(eq(chatMessagesTable.id, id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /chat/unread-count ───────────────────────────────────────────────
// Total unread messages across all conversations — for the navbar badge.
router.get("/unread-count", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const r: any = await db.execute(sql`
      SELECT COALESCE(SUM(CASE
        WHEN m.id IS NOT NULL THEN 1 ELSE 0
      END), 0)::int AS c
      FROM chat_participants p
      JOIN chat_conversations c ON c.id = p.conversation_id
      LEFT JOIN chat_messages m ON m.conversation_id = c.id
        AND m.deleted_at IS NULL
        AND m.sender_user_id <> ${userId}
        AND (p.last_read_message_id IS NULL OR m.id > p.last_read_message_id)
      WHERE c.company_id = ${cid} AND p.user_id = ${userId}
    `);
    res.json({ count: Number(r.rows?.[0]?.c || 0) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// Chat calls (WebRTC) — signaling relay. The media itself flows peer-to-peer
// between browsers; the server only ferries the small offer/answer/ICE blobs
// to the targeted participant(s) via the existing SSE stream (emitToUser).
// Every endpoint re-checks that the caller is a participant of the
// conversation, and signal/end re-check the *target* is too, so a tenant can
// never inject signaling into a conversation they aren't part of.
// ─────────────────────────────────────────────────────────────────────────

async function otherParticipantIds(convId: number, exceptUserId: number): Promise<number[]> {
  const rows = await db.select({ userId: chatParticipantsTable.userId })
    .from(chatParticipantsTable)
    .where(eq(chatParticipantsTable.conversationId, convId));
  return rows.map(r => r.userId).filter(id => id !== exceptUserId);
}

const CallInviteBody = z.object({
  callId: z.string().min(1).max(64),
  media: z.enum(["audio", "video"]),
});

const CallSignalBody = z.object({
  callId: z.string().min(1).max(64),
  // Point-to-point when set; broadcast to every other participant when omitted
  // (used by the mesh "join" announcement so all peers discover each other).
  toUserId: z.number().int().positive().optional(),
  signal: z.object({
    kind: z.enum(["offer", "answer", "ice", "accept", "reject", "join"]),
    sdp: z.string().optional(),
    candidate: z.unknown().optional(),
    name: z.string().max(128).optional(),
  }),
});

const CallEndBody = z.object({
  callId: z.string().min(1).max(64),
  reason: z.string().max(64).optional(),
});

// ─── POST /chat/conversations/:id/call/invite ─────────────────────────────
// Ring every OTHER participant of the conversation.
router.post("/conversations/:id/call/invite", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const convId = Number(req.params.id);
    const conv = await loadConversationForUser(convId, cid, userId);
    if (!conv) { res.status(404).json({ error: "غير موجود" }); return; }
    const parsed = CallInviteBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "بيانات غير صحيحة" }); return; }
    const [me] = await db.select({
      nameAr: usersTable.nameAr, nameEn: usersTable.nameEn, username: usersTable.username,
    }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const fromName = me?.nameAr || me?.nameEn || me?.username || "—";
    const others = await otherParticipantIds(convId, userId);
    for (const uid of others) {
      emitToUser(uid, cid, "call_invite", {
        callId: parsed.data.callId, conversationId: convId,
        fromUserId: userId, fromName, media: parsed.data.media,
      });
    }
    res.json({ ok: true, notified: others.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /chat/conversations/:id/call/signal ─────────────────────────────
// Relay one signaling blob (offer/answer/ICE/accept/reject) to one peer.
router.post("/conversations/:id/call/signal", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const convId = Number(req.params.id);
    const conv = await loadConversationForUser(convId, cid, userId);
    if (!conv) { res.status(404).json({ error: "غير موجود" }); return; }
    const parsed = CallSignalBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "بيانات غير صحيحة" }); return; }
    if (parsed.data.toUserId != null) {
      // Point-to-point relay (offer/answer/ICE/accept/reject/join-ack).
      if (!(await isParticipant(convId, parsed.data.toUserId))) {
        res.status(404).json({ error: "الطرف غير موجود في المحادثة" }); return;
      }
      emitToUser(parsed.data.toUserId, cid, "call_signal", {
        callId: parsed.data.callId, conversationId: convId,
        fromUserId: userId, signal: parsed.data.signal,
      });
    } else {
      // Broadcast (mesh "join" announcement) to every other participant.
      const others = await otherParticipantIds(convId, userId);
      for (const uid of others) {
        emitToUser(uid, cid, "call_signal", {
          callId: parsed.data.callId, conversationId: convId,
          fromUserId: userId, signal: parsed.data.signal,
        });
      }
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /chat/conversations/:id/call/end ────────────────────────────────
// Tell every other participant the caller hung up / rejected.
router.post("/conversations/:id/call/end", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const convId = Number(req.params.id);
    const conv = await loadConversationForUser(convId, cid, userId);
    if (!conv) { res.status(404).json({ error: "غير موجود" }); return; }
    const parsed = CallEndBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "بيانات غير صحيحة" }); return; }
    const others = await otherParticipantIds(convId, userId);
    for (const uid of others) {
      emitToUser(uid, cid, "call_end", {
        callId: parsed.data.callId, conversationId: convId,
        fromUserId: userId, reason: parsed.data.reason ?? null,
      });
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
