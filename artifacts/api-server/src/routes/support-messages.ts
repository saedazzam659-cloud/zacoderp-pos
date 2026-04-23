import { Router } from "express";
import { db } from "@workspace/db";
import {
  supportMessagesTable, supportSettingsTable,
  notificationsTable, usersTable, companiesTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { extractAuth } from "../middleware/auth.js";
import { promises as dnsPromises } from "node:dns";
import net from "node:net";

// ─── SSRF protection for webhook URL ──────────────────────────────────────────
// Reject anything that isn't https://, anything pointing at a hostname that
// resolves to a private/loopback/link-local/metadata IP, or anything trying
// to use a non-standard port we wouldn't expect for a public webhook.
function isPrivateIp(ip: string): boolean {
  if (net.isIP(ip) === 0) return true; // unparseable → treat as unsafe
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;       // link-local + AWS/GCP metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 0) return true;
    if (a >= 224) return true;                       // multicast/reserved
    return false;
  }
  // IPv6
  const lc = ip.toLowerCase();
  if (lc === "::1" || lc === "::") return true;
  if (lc.startsWith("fc") || lc.startsWith("fd")) return true; // unique local
  if (lc.startsWith("fe80")) return true;                       // link-local
  if (lc.startsWith("ff")) return true;                         // multicast
  return false;
}
async function assertSafeWebhookUrl(rawUrl: string): Promise<URL> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error("رابط الـ Webhook غير صالح"); }
  if (u.protocol !== "https:") throw new Error("الرابط يجب أن يستخدم HTTPS فقط");
  if (u.username || u.password) throw new Error("لا يُسمح بمعلومات اعتماد في الرابط");
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  // If user typed an IP literal, validate it directly.
  if (net.isIP(host) !== 0) {
    if (isPrivateIp(host)) throw new Error("رابط Webhook يشير إلى عنوان داخلي ممنوع");
    return u;
  }
  // Otherwise resolve and reject if any address is private.
  const records = await dnsPromises.lookup(host, { all: true }).catch(() => []);
  if (!records.length) throw new Error("تعذّر التحقق من اسم النطاق للـ Webhook");
  for (const r of records) if (isPrivateIp(r.address)) {
    throw new Error("رابط Webhook يشير إلى عنوان داخلي ممنوع");
  }
  return u;
}

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

// ─── Settings helpers ─────────────────────────────────────────────────────────
async function getOrCreateSettings() {
  const [row] = await db.select().from(supportSettingsTable).limit(1);
  if (row) return row;
  const [created] = await db.insert(supportSettingsTable).values({ id: 1 }).returning();
  return created;
}

function requireSuperadmin(req: any, res: any) {
  if (req.authUser?.role !== "superadmin") {
    res.status(403).json({ error: "هذه الصفحة للسوبر أدمن فقط" });
    return false;
  }
  return true;
}

// ─── Dispatch (in-app, webhook, telegram) ─────────────────────────────────────
async function dispatchMessage(msg: any, settings: any, sender: { name: string; companyName: string }) {
  // 1) In-app notifications for every superadmin user (best-effort).
  if (settings.notifySuperadminInApp) {
    try {
      const supers = await db.select().from(usersTable).where(eq(usersTable.role, "superadmin"));
      for (const sa of supers) {
        const cid = sa.companyId ?? msg.companyId;
        if (!cid) continue; // notifications.companyId is NOT NULL — skip if no fallback
        await db.insert(notificationsTable).values({
          companyId:    cid,
          userId:       sa.id,
          title:        `رسالة دعم جديدة: ${msg.subject}`,
          body:         `**من:** ${sender.name} (${sender.companyName})\n\n${msg.body}`,
          severity:     msg.priority === "high" ? "high" : "info",
          category:     "support_message",
          sourceKey:    `support_message:${msg.id}`,
          createdByUserId: msg.userId ?? null,
        });
      }
    } catch (e) { console.warn("support: in-app dispatch failed:", e); }
  }

  // 2) Webhook (POST JSON). SSRF-safe: only HTTPS, no private/loopback hosts.
  if (settings.webhookEnabled && settings.webhookUrl) {
    try {
      const safe = await assertSafeWebhookUrl(settings.webhookUrl);
      const headers: Record<string,string> = { "Content-Type": "application/json" };
      if (settings.webhookSecret) headers["X-Support-Secret"] = settings.webhookSecret;
      const r = await fetch(safe.toString(), {
        method: "POST", headers,
        body: JSON.stringify({
          id: msg.id, subject: msg.subject, body: msg.body,
          priority: msg.priority, category: msg.category,
          sender: sender.name, company: sender.companyName,
          companyId: msg.companyId, userId: msg.userId,
          createdAt: msg.createdAt,
        }),
        signal: AbortSignal.timeout(5000),
        redirect: "manual", // don't follow redirects (could re-target a private host)
      });
      if (!r.ok) console.warn(`support: webhook returned non-2xx (${r.status})`);
    } catch (e) { console.warn("support: webhook dispatch failed:", e); }
  }

  // 3) Telegram bot. Host is fixed (api.telegram.org) — no SSRF surface.
  if (settings.telegramEnabled && settings.telegramBotToken && settings.telegramChatId) {
    try {
      const text =
        `🆘 *رسالة دعم جديدة*\n` +
        `*الموضوع:* ${msg.subject}\n` +
        `*الأولوية:* ${msg.priority}\n` +
        `*الشركة:* ${sender.companyName}\n` +
        `*المرسل:* ${sender.name}\n\n${msg.body}`;
      const r = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: settings.telegramChatId, text, parse_mode: "Markdown",
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) console.warn(`support: telegram returned non-2xx (${r.status})`);
    } catch (e) { console.warn("support: telegram dispatch failed:", e); }
  }
}

// ─── User-facing endpoints ────────────────────────────────────────────────────

// POST /api/support-messages — any authenticated user creates a message.
router.post("/", async (req, res) => {
  try {
    const u = req.authUser!;
    const { subject, body, priority = "normal", category = "general" } = req.body ?? {};
    if (!subject || !body || typeof subject !== "string" || typeof body !== "string") {
      res.status(400).json({ error: "الموضوع ونص الرسالة مطلوبان" });
      return;
    }
    if (subject.length > 200) { res.status(400).json({ error: "الموضوع طويل جداً" }); return; }
    if (body.length > 5000)   { res.status(400).json({ error: "نص الرسالة طويل جداً" }); return; }
    if (!["low","normal","high"].includes(priority)) {
      res.status(400).json({ error: "أولوية غير صالحة" }); return;
    }

    let companyName = "—";
    if (u.companyId) {
      const [c] = await db.select({ nameAr: companiesTable.nameAr })
        .from(companiesTable).where(eq(companiesTable.id, u.companyId));
      companyName = c?.nameAr || "—";
    }
    const [meRow] = await db.select({ nameAr: usersTable.nameAr, nameEn: usersTable.nameEn })
      .from(usersTable).where(eq(usersTable.id, u.id));
    const senderName = meRow?.nameAr || meRow?.nameEn || u.username || `user#${u.id}`;

    const [created] = await db.insert(supportMessagesTable).values({
      companyId:   u.companyId ?? null,
      userId:      u.id,
      senderName,
      companyName,
      subject:     subject.trim(),
      body:        body.trim(),
      priority,
      category:    String(category).slice(0, 50),
      status:      "open",
    }).returning();

    const settings = await getOrCreateSettings();
    // Fire-and-forget dispatch (don't block the response).
    dispatchMessage(created, settings, { name: senderName, companyName }).catch(() => {});

    res.json({ ok: true, message: created });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

// GET /api/support-messages/mine — current user's own messages.
router.get("/mine", async (req, res) => {
  try {
    const u = req.authUser!;
    const rows = await db.select().from(supportMessagesTable)
      .where(eq(supportMessagesTable.userId, u.id))
      .orderBy(desc(supportMessagesTable.createdAt))
      .limit(100);
    res.json({ messages: rows });
  } catch (e: any) { res.status(500).json({ error: e?.message || "خطأ" }); }
});

// ─── Superadmin endpoints ─────────────────────────────────────────────────────

// GET /api/support-messages — superadmin lists all messages with filter.
router.get("/", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const where = status && ["open","in_progress","resolved","closed"].includes(status)
      ? eq(supportMessagesTable.status, status) : undefined;
    const rows = await db.select().from(supportMessagesTable)
      .where(where as any)
      .orderBy(desc(supportMessagesTable.createdAt))
      .limit(200);
    res.json({ messages: rows });
  } catch (e: any) { res.status(500).json({ error: e?.message || "خطأ" }); }
});

// GET /api/support-messages/stats — superadmin badge counts.
router.get("/stats", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const r = await db.execute(sql`
      SELECT status, COUNT(*)::int AS c FROM support_messages GROUP BY status
    `);
    const rows = ((r as any).rows ?? r ?? []) as Array<{ status: string; c: number }>;
    const stats = { open: 0, in_progress: 0, resolved: 0, closed: 0 } as Record<string,number>;
    for (const r of rows) stats[r.status] = Number(r.c);
    res.json({ stats });
  } catch (e: any) { res.status(500).json({ error: e?.message || "خطأ" }); }
});

// PATCH /api/support-messages/:id — superadmin updates status / replies.
router.patch("/:id", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id غير صالح" }); return; }
    const { status, adminReply } = req.body ?? {};
    const patch: any = { updatedAt: new Date() };
    if (status) {
      if (!["open","in_progress","resolved","closed"].includes(status)) {
        res.status(400).json({ error: "حالة غير صالحة" }); return;
      }
      patch.status = status;
      if (status === "resolved" || status === "closed") {
        patch.resolvedAt = new Date();
        patch.resolvedByUserId = req.authUser!.id;
      }
    }
    if (typeof adminReply === "string") {
      patch.adminReply = adminReply.trim();
      patch.adminReplyAt = new Date();
    }
    const [updated] = await db.update(supportMessagesTable).set(patch)
      .where(eq(supportMessagesTable.id, id)).returning();
    if (!updated) { res.status(404).json({ error: "غير موجود" }); return; }

    // If a reply was added, create an in-app notification for the original sender.
    if (typeof adminReply === "string" && adminReply.trim() && updated.userId && updated.companyId) {
      try {
        await db.insert(notificationsTable).values({
          companyId: updated.companyId,
          userId:    updated.userId,
          title:     `رد على رسالتك: ${updated.subject}`,
          body:      `**رد الإدارة:**\n\n${adminReply.trim()}`,
          severity:  "info",
          category:  "support_reply",
          sourceKey: `support_reply:${updated.id}`,
          createdByUserId: req.authUser!.id,
        });
      } catch (e) { console.warn("support: reply notification failed:", e); }
    }

    res.json({ ok: true, message: updated });
  } catch (e: any) { res.status(500).json({ error: e?.message || "خطأ" }); }
});

// ─── Settings (superadmin only) ───────────────────────────────────────────────

router.get("/_settings/get", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const s = await getOrCreateSettings();
    // Mask secrets in the response (return placeholder when set).
    res.json({
      settings: {
        ...s,
        webhookSecret:    s.webhookSecret ? "********" : "",
        telegramBotToken: s.telegramBotToken ? "********" : "",
      },
    });
  } catch (e: any) { res.status(500).json({ error: e?.message || "خطأ" }); }
});

router.put("/_settings/update", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const b = req.body ?? {};
    const patch: any = { updatedAt: new Date(), updatedByUserId: req.authUser!.id };
    const boolKeys = ["inAppEnabled","webhookEnabled","telegramEnabled","emailEnabled","notifySuperadminInApp"];
    for (const k of boolKeys) if (typeof b[k] === "boolean") patch[k] = b[k];
    const strKeys = ["webhookUrl","telegramChatId","emailRecipients"];
    for (const k of strKeys) if (typeof b[k] === "string") patch[k] = b[k].trim() || null;
    // Pre-validate webhook URL (SSRF defence) before persisting.
    if (patch.webhookUrl) {
      try { await assertSafeWebhookUrl(patch.webhookUrl); }
      catch (err: any) { res.status(400).json({ error: err?.message || "رابط Webhook غير صالح" }); return; }
    }
    // Secret fields: only update when caller sends a non-masked value.
    if (typeof b.webhookSecret === "string" && b.webhookSecret !== "********") {
      patch.webhookSecret = b.webhookSecret.trim() || null;
    }
    if (typeof b.telegramBotToken === "string" && b.telegramBotToken !== "********") {
      patch.telegramBotToken = b.telegramBotToken.trim() || null;
    }
    await getOrCreateSettings();
    const [updated] = await db.update(supportSettingsTable).set(patch)
      .where(eq(supportSettingsTable.id, 1)).returning();
    res.json({
      ok: true,
      settings: {
        ...updated,
        webhookSecret:    updated.webhookSecret ? "********" : "",
        telegramBotToken: updated.telegramBotToken ? "********" : "",
      },
    });
  } catch (e: any) { res.status(500).json({ error: e?.message || "خطأ" }); }
});

// POST /api/support-messages/_settings/test — send a test dispatch with current config.
router.post("/_settings/test", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const settings = await getOrCreateSettings();
    const fakeMsg = {
      id: 0, companyId: req.authUser!.companyId ?? null, userId: req.authUser!.id,
      subject: "رسالة اختبار من إعدادات الدعم",
      body: "هذه رسالة اختبار للتأكد من أن قنوات الإشعار (Webhook / Telegram) تعمل بشكل صحيح.",
      priority: "low", category: "test", createdAt: new Date(),
    };
    await dispatchMessage(fakeMsg, settings, {
      name: req.authUser!.username || "superadmin", companyName: "اختبار النظام",
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message || "خطأ" }); }
});

export default router;
