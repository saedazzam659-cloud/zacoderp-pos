import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, trainingSessionsTable, trainingAttendanceTable } from "@workspace/db";
import { logger } from "./logger.js";
import { resolveBearerToken } from "../middleware/auth.js";
import { livekitConfigured, livekitWsUrl, mintToken } from "./livekit.js";

// ─────────────────────────────────────────────────────────────────────────────
// مركز إشارات البث الموزّع (P2P Relay Tree) — /api/training-room/p2p/ws
//
// السيرفر لا يمرّر أي فيديو إطلاقًا: فقط التعارف (WebRTC signaling) وإدارة
// شجرة إعادة الإرسال. المدرب هو الجذر ("__root__")، وكل مشاهد يستقبل البث
// من أبيه ويعيد إرساله لأبنائه.
//
// الأدوار:
//   ?role=broadcaster&session=<id>&auth=<bearer>  — المدرب (نفس شركة الجلسة،
//        trainer نفسه أو admin؛ superadmin يمر دائمًا)
//   ?role=viewer&token=<publicToken>&name=<الاسم>  — مشاهد الرابط العام
//        (يتطلب allowPublic و status=live)
// ─────────────────────────────────────────────────────────────────────────────

const ROOT_FANOUT = 6;      // أقصى أبناء مباشرين للمدرب
const VIEWER_FANOUT = 4;    // أقصى أبناء لكل مشاهد
const MAX_VIEWERS = 1500;

type ViewerNode = {
  peerId: string;
  name: string;
  ws: WebSocket;
  parentId: string | null;   // "__root__" أو peerId لمشاهد آخر، null = بلا أب
  children: Set<string>;
  canRelay: boolean;         // المشاهد أعلن أنه لا يستطيع إعادة الإرسال؟
};

type Room = {
  sessionId: number;
  companyId: number;
  roomName: string;
  broadcaster: WebSocket | null;
  viewers: Map<string, ViewerNode>;
};

const rooms = new Map<number, Room>();

function send(ws: WebSocket, msg: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }
}

function broadcastAll(room: Room, msg: Record<string, unknown>, exceptPeerId?: string) {
  if (room.broadcaster) send(room.broadcaster, msg);
  for (const [pid, v] of room.viewers) {
    if (pid !== exceptPeerId) send(v.ws, msg);
  }
}

function pushViewerCount(room: Room) {
  broadcastAll(room, { type: "viewer-count", n: room.viewers.size });
}

/** BFS من الجذر: أول عقدة لديها سعة (المدرب أولًا ثم الأقرب له). */
function findParent(room: Room, exclude?: Set<string>): string | null {
  if (!room.broadcaster) return null;
  const rootChildren = [...room.viewers.values()].filter(v => v.parentId === "__root__");
  if (rootChildren.length < ROOT_FANOUT) return "__root__";
  const queue = rootChildren.map(v => v.peerId);
  while (queue.length) {
    const pid = queue.shift()!;
    if (exclude?.has(pid)) continue;
    const node = room.viewers.get(pid);
    if (!node) continue;
    if (node.canRelay && node.children.size < VIEWER_FANOUT) return pid;
    queue.push(...node.children);
  }
  return null;
}

/** يعلّق مشاهدًا على أب (أو يخبره أن لا مكان). */
function attach(room: Room, viewer: ViewerNode, exclude?: Set<string>) {
  const parentId = findParent(room, exclude);
  if (!parentId) {
    viewer.parentId = null;
    send(viewer.ws, { type: "no-parent" });
    return;
  }
  viewer.parentId = parentId;
  if (parentId === "__root__") {
    if (room.broadcaster) send(room.broadcaster, { type: "add-child", childId: viewer.peerId });
  } else {
    const p = room.viewers.get(parentId);
    if (p) { p.children.add(viewer.peerId); send(p.ws, { type: "add-child", childId: viewer.peerId }); }
  }
  send(viewer.ws, { type: "parent-assigned", parentId });
}

/** يجمع peerIds لكامل الشجرة الفرعية لعقدة (بما فيها هي). */
function subtreeIds(room: Room, rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    const n = room.viewers.get(id);
    if (!n) continue;
    for (const c of n.children) { if (!out.has(c)) { out.add(c); queue.push(c); } }
  }
  return out;
}

/** فصل مشاهد: أخطر الأب، وأعد تعليق أبنائه (مع استبعاد شجرته الفرعية). */
function detachViewer(room: Room, viewer: ViewerNode) {
  // أخطر الأب أن الطفل رحل
  if (viewer.parentId === "__root__") {
    if (room.broadcaster) send(room.broadcaster, { type: "child-gone", childId: viewer.peerId });
  } else if (viewer.parentId) {
    const p = room.viewers.get(viewer.parentId);
    if (p) { p.children.delete(viewer.peerId); send(p.ws, { type: "child-gone", childId: viewer.peerId }); }
  }
  const excluded = subtreeIds(room, viewer.peerId);
  room.viewers.delete(viewer.peerId);
  // أعد تعليق الأبناء المباشرين (أشجارهم الفرعية تتبعهم تلقائيًا)
  for (const childId of viewer.children) {
    const child = room.viewers.get(childId);
    if (!child) continue;
    child.parentId = null;
    attach(room, child, excluded);
  }
}

/** إعادة بناء الشجرة بالكامل (عند دخول/عودة المدرب). */
function rebuildTree(room: Room) {
  for (const v of room.viewers.values()) { v.parentId = null; v.children.clear(); }
  for (const v of room.viewers.values()) attach(room, v);
}

async function recordAttendance(room: Room, viewer: ViewerNode) {
  try {
    await db.insert(trainingAttendanceTable).values({
      sessionId: room.sessionId,
      companyId: room.companyId,
      userId: null,
      displayName: viewer.name,
      identity: `p2p:${viewer.peerId}`,
      isPublic: true,
    });
  } catch (err) {
    logger.warn({ err }, "trainingP2P: attendance insert failed");
  }
}

export function attachTrainingP2PHub(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/api/training-room/p2p/ws") return;
      wss.handleUpgrade(req, socket, head, (ws) => { wss.emit("connection", ws, req); });
    } catch (err) {
      logger.warn({ err }, "trainingP2P: upgrade handling failed");
      try { socket.destroy(); } catch { /* ignore */ }
    }
  });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://x"); } catch { ws.close(1008, "bad url"); return; }
    const role = url.searchParams.get("role");

    try {
      if (role === "broadcaster") await onBroadcaster(ws, url, req.headers.cookie);
      else if (role === "viewer") await onViewer(ws, url);
      else ws.close(1008, "bad role");
    } catch (err) {
      logger.warn({ err }, "trainingP2P: connection handling failed");
      send(ws, { type: "error", message: "خطأ داخلي" });
      try { ws.close(1011, "internal"); } catch { /* ignore */ }
    }
  });

  logger.info("trainingP2P: hub attached at /api/training-room/p2p/ws");
}

// ─── المدرب ─────────────────────────────────────────────────────────────────
async function onBroadcaster(ws: WebSocket, url: URL, rawCookieHeader?: string) {
  const sessionId = Number(url.searchParams.get("session"));
  const bearer = (url.searchParams.get("auth") ?? "").trim();
  if (!Number.isInteger(sessionId) || sessionId <= 0 || !bearer) {
    send(ws, { type: "error", message: "بيانات ناقصة" }); ws.close(1008, "missing params"); return;
  }

  const resolved = await resolveBearerToken(bearer, rawCookieHeader).catch(() => null);
  if (!resolved) { send(ws, { type: "error", message: "تسجيل الدخول مطلوب" }); ws.close(4401, "auth"); return; }
  const u = resolved.user;

  const [session] = await db.select().from(trainingSessionsTable)
    .where(eq(trainingSessionsTable.id, sessionId)).limit(1);
  if (!session) { send(ws, { type: "error", message: "الجلسة غير موجودة" }); ws.close(4404, "not found"); return; }

  const sameCompany = u.companyId != null && u.companyId === session.companyId;
  const allowed = u.role === "superadmin"
    || (sameCompany && (u.id === session.trainerUserId || u.role === "admin"));
  if (!allowed) {
    logger.warn({ sessionId, userId: u.id, role: u.role }, "trainingP2P: broadcaster rejected (forbidden)");
    send(ws, { type: "error", message: "غير مصرح" }); ws.close(4403, "forbidden"); return;
  }
  logger.info({ sessionId, userId: u.id }, "trainingP2P: broadcaster connected");

  let room = rooms.get(sessionId);
  if (!room) {
    room = { sessionId, companyId: session.companyId, roomName: session.roomName, broadcaster: null, viewers: new Map() };
    rooms.set(sessionId, room);
  }
  // مدرب جديد يحل محل القديم (تحديث صفحة مثلًا)
  if (room.broadcaster && room.broadcaster !== ws) {
    try { room.broadcaster.close(4000, "replaced"); } catch { /* ignore */ }
  }
  room.broadcaster = ws;
  send(ws, { type: "viewer-count", n: room.viewers.size });
  rebuildTree(room);

  ws.on("message", (raw) => {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const r = rooms.get(sessionId);
    if (!r || r.broadcaster !== ws) return;

    switch (msg?.type) {
      case "ping": { send(ws, { type: "pong" }); break; }
      case "signal": {
        const target = r.viewers.get(String(msg.to));
        if (target) send(target.ws, { type: "signal", from: "__root__", data: msg.data });
        break;
      }
      case "chat": {
        const text = String(msg.text ?? "").slice(0, 2000).trim();
        if (!text) return;
        broadcastAll(r, { type: "chat", name: "المدرب", text, fromTrainer: true });
        break;
      }
      case "grant": {
        const target = r.viewers.get(String(msg.peerId));
        if (!target) return;
        if (!livekitConfigured()) { send(ws, { type: "error", message: "LiveKit غير مضبوط — لا يمكن منح المايك" }); return; }
        const identity = `pub-${crypto.randomBytes(6).toString("hex")}`;
        void mintToken({
          room: r.roomName, identity, name: target.name,
          role: "subscriber", micOnly: true,
          metadata: { public: true, granted: true },
        }).then((token) => {
          send(target.ws, { type: "granted", token, wsUrl: livekitWsUrl(), identity });
        }).catch((err) => {
          logger.warn({ err }, "trainingP2P: grant mint failed");
          send(ws, { type: "error", message: "تعذّر إصدار تصريح المايك" });
        });
        break;
      }
    }
  });

  ws.on("close", () => {
    const r = rooms.get(sessionId);
    if (!r || r.broadcaster !== ws) return;
    logger.info({ sessionId }, "trainingP2P: broadcaster disconnected");
    r.broadcaster = null;
    for (const v of r.viewers.values()) {
      v.parentId = null; v.children.clear();
      send(v.ws, { type: "broadcaster-gone" });
    }
    if (r.viewers.size === 0) rooms.delete(sessionId);
  });
}

// ─── المشاهد (رابط عام) ─────────────────────────────────────────────────────
async function onViewer(ws: WebSocket, url: URL) {
  const publicToken = (url.searchParams.get("token") ?? "").trim();
  const name = (url.searchParams.get("name") ?? "").trim().slice(0, 60) || "مشاهد";
  if (!publicToken) { send(ws, { type: "error", message: "رابط غير صالح" }); ws.close(1008, "missing token"); return; }

  const [session] = await db.select().from(trainingSessionsTable)
    .where(eq(trainingSessionsTable.publicToken, publicToken)).limit(1);
  if (!session || !session.allowPublic) {
    send(ws, { type: "error", message: "الجلسة غير موجودة أو الرابط العام غير مفعّل" });
    ws.close(4404, "not found"); return;
  }
  if (session.status !== "live") {
    send(ws, { type: "error", message: "الجلسة غير مباشرة الآن" });
    ws.close(4409, "not live"); return;
  }

  let room = rooms.get(session.id);
  if (!room) {
    room = { sessionId: session.id, companyId: session.companyId, roomName: session.roomName, broadcaster: null, viewers: new Map() };
    rooms.set(session.id, room);
  }
  if (room.viewers.size >= MAX_VIEWERS) {
    send(ws, { type: "error", message: "اكتمل عدد المشاهدين" });
    ws.close(4429, "full"); return;
  }

  const viewer: ViewerNode = {
    peerId: crypto.randomBytes(8).toString("hex"),
    name, ws, parentId: null, children: new Set(), canRelay: true,
  };
  room.viewers.set(viewer.peerId, viewer);
  send(ws, { type: "welcome", peerId: viewer.peerId, broadcasterOnline: !!room.broadcaster });
  if (room.broadcaster) attach(room, viewer);
  pushViewerCount(room);
  void recordAttendance(room, viewer);

  ws.on("message", (raw) => {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const r = rooms.get(session.id);
    const me = r?.viewers.get(viewer.peerId);
    if (!r || !me) return;

    switch (msg?.type) {
      case "ping": { send(ws, { type: "pong" }); break; }
      case "signal": {
        const to = String(msg.to ?? "");
        // مسموح فقط: الأب أو أحد الأبناء (يمنع التجسس على أي peer آخر)
        if (to === "__root__" || to === me.parentId) {
          if (me.parentId === "__root__") {
            if (r.broadcaster) send(r.broadcaster, { type: "signal", from: me.peerId, data: msg.data });
          } else if (me.parentId) {
            const p = r.viewers.get(me.parentId);
            if (p) send(p.ws, { type: "signal", from: me.peerId, data: msg.data });
          }
        } else if (me.children.has(to)) {
          const c = r.viewers.get(to);
          if (c) send(c.ws, { type: "signal", from: me.peerId, data: msg.data });
        }
        break;
      }
      case "chat": {
        const text = String(msg.text ?? "").slice(0, 2000).trim();
        if (!text) return;
        broadcastAll(r, { type: "chat", name: me.name, text, fromTrainer: false }, me.peerId);
        break;
      }
      case "hand": {
        if (r.broadcaster) send(r.broadcaster, { type: "hand", peerId: me.peerId, name: me.name, up: msg.up === true });
        break;
      }
      case "relay-capacity": {
        if (msg.canRelay === false) {
          me.canRelay = false;
          // انزع أبناءه وأعد تعليقهم في مكان آخر
          const kids = [...me.children];
          me.children.clear();
          const excluded = new Set<string>([me.peerId]);
          for (const kidId of kids) {
            send(me.ws, { type: "child-gone", childId: kidId });
            const kid = r.viewers.get(kidId);
            if (kid) { kid.parentId = null; attach(r, kid, excluded); }
          }
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    const r = rooms.get(session.id);
    const me = r?.viewers.get(viewer.peerId);
    if (!r || !me) return;
    // أخطر المدرب أن اليد نزلت (لو كانت مرفوعة — غير مكلف)
    if (r.broadcaster) send(r.broadcaster, { type: "hand", peerId: me.peerId, name: me.name, up: false });
    detachViewer(r, me);
    pushViewerCount(r);
    if (!r.broadcaster && r.viewers.size === 0) rooms.delete(session.id);
  });
}
