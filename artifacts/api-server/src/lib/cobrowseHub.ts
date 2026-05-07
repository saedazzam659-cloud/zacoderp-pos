import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import { db, cobrowseSessionsTable, auditLogTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import { logger } from "./logger.js";
import { resolveBearerToken } from "../middleware/auth.js";

// Best-effort audit writer for cobrowse WS-level events. Never throws.
async function auditWs(opts: {
  userId: number | null; username: string | null; companyId: number | null;
  action: string; sessionId: number; ip: string | null;
  meta?: Record<string, unknown>;
}) {
  try {
    await db.insert(auditLogTable).values({
      userId: opts.userId, username: opts.username, role: null,
      companyId: opts.companyId,
      module: "support_cobrowse",
      action: opts.action,
      method: "WS",
      path: "/api/cobrowse/ws",
      entityType: "cobrowse_session",
      entityId: String(opts.sessionId),
      statusCode: 200,
      ip: opts.ip,
      userAgent: null,
      metadata: opts.meta ?? null,
    });
  } catch { /* never break the relay on audit failure */ }
}

// ─────────────────────────────────────────────────────────────────────────
// Co-browse signaling + relay hub
//
// Each cobrowse session has at most TWO live WebSocket peers:
//   - role="agent"    — the support agent (initiator)
//   - role="customer" — the end-user being assisted
//
// The customer streams rrweb DOM events to the agent (view-only). When the
// agent requests control the customer is shown a consent prompt; on accept
// the agent may emit input events (click/keydown/scroll/input) that the
// customer-side widget replays inside its own DOM.
//
// The hub is an in-memory map by sessionId. This is correct for our single
// node deployment (autoscale 1 max instance for the api). If we later move
// to multi-instance, swap the Map for a Redis pub/sub.
// ─────────────────────────────────────────────────────────────────────────

type Role = "agent" | "customer";

interface PeerEntry {
  ws: WebSocket;
  role: Role;
  userId: number | null;
  ip: string | null;
}
interface RoomEntry {
  sessionId: number;
  inviteToken: string;
  peers: Map<Role, PeerEntry>;
}

const rooms = new Map<number, RoomEntry>();

function send(ws: WebSocket, msg: Record<string, unknown>) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }
}

function broadcastOther(room: RoomEntry, fromRole: Role, payload: Record<string, unknown>) {
  for (const [role, peer] of room.peers) {
    if (role === fromRole) continue;
    send(peer.ws, payload);
  }
}

function clientIp(req: IncomingMessage): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? null;
}

async function endSessionInDb(sessionId: number, reason: string) {
  try {
    await db.update(cobrowseSessionsTable)
      .set({ state: "ended", endedAt: new Date(), endReason: reason })
      .where(eq(cobrowseSessionsTable.id, sessionId));
  } catch (err) {
    logger.warn({ err, sessionId }, "cobrowse: failed to mark session ended");
  }
}

export function attachCobrowseHub(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    try {
      // Only handle our path; let other handlers (or 404) deal with the rest.
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/api/cobrowse/ws") return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } catch (err) {
      logger.warn({ err }, "cobrowse: upgrade handling failed");
      try { socket.destroy(); } catch { /* ignore */ }
    }
  });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://x"); } catch { ws.close(1008, "bad url"); return; }

    const token = url.searchParams.get("token") ?? "";
    const role = url.searchParams.get("role") as Role | null;
    if (!token || (role !== "agent" && role !== "customer")) {
      ws.close(1008, "missing token/role"); return;
    }

    const [session] = await db.select().from(cobrowseSessionsTable)
      .where(eq(cobrowseSessionsTable.inviteToken, token)).limit(1);

    if (!session || session.state === "ended") {
      send(ws, { type: "error", message: "session not found or ended" });
      ws.close(1008, "session invalid"); return;
    }

    // SECURITY: the customer-side WS only requires the invite token (the
    // customer is the end-user being assisted; we cannot rely on them being
    // logged in). The agent-side WS additionally requires a Bearer access
    // token that resolves to the same user that created the session — this
    // closes the gap "anyone with the invite link can spy as the agent".
    let agentUserId: number | null = null;
    let agentUsername: string | null = null;
    let agentCompanyId: number | null = null;
    if (role === "agent") {
      const bearer = (url.searchParams.get("auth") ?? "").trim();
      const resolved = bearer ? await resolveBearerToken(bearer).catch(() => null) : null;
      if (!resolved) {
        send(ws, { type: "error", message: "agent auth required" });
        ws.close(4401, "agent auth required"); return;
      }
      // Ownership check: only the original agent (or any superadmin) may
      // attach as the agent peer for this session.
      const u = resolved.user;
      if (u.role !== "superadmin" && u.id !== session.agentUserId) {
        send(ws, { type: "error", message: "forbidden" });
        ws.close(4403, "forbidden"); return;
      }
      agentUserId = u.id; agentUsername = u.username; agentCompanyId = u.companyId ?? null;
    }

    let room = rooms.get(session.id);
    if (!room) {
      room = { sessionId: session.id, inviteToken: token, peers: new Map() };
      rooms.set(session.id, room);
    }

    // Disconnect any previous peer of the same role (last-writer-wins).
    const existing = room.peers.get(role);
    if (existing) {
      try { existing.ws.close(1000, "replaced"); } catch { /* ignore */ }
    }
    const ip = clientIp(req);
    room.peers.set(role, { ws, role, userId: agentUserId, ip });

    // Update DB on first customer join.
    if (role === "customer") {
      try {
        await db.update(cobrowseSessionsTable)
          .set({ state: "active", joinedAt: session.joinedAt ?? new Date(), ipCustomer: ip })
          .where(eq(cobrowseSessionsTable.id, session.id));
      } catch (err) {
        logger.warn({ err, sessionId: session.id }, "cobrowse: failed to mark active");
      }
    } else if (role === "agent") {
      try {
        await db.update(cobrowseSessionsTable)
          .set({ ipAgent: ip })
          .where(eq(cobrowseSessionsTable.id, session.id));
      } catch { /* ignore */ }
    }

    send(ws, { type: "hello", role, sessionId: session.id });
    // Notify the OTHER peer (if any) that we joined, so it can start
    // streaming / show the green dot.
    broadcastOther(room, role, { type: "peer_joined", role });

    ws.on("message", async (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const type = String(msg?.type ?? "");
      if (!type) return;

      // Server-handled control state changes (touch DB + write audit so we
      // have non-repudiation for every control transition, not just the
      // create/end pair captured at the REST layer).
      if (type === "control_request" && role === "agent") {
        await db.update(cobrowseSessionsTable)
          .set({ controlState: "requested" })
          .where(eq(cobrowseSessionsTable.id, session.id)).catch(() => {});
        await auditWs({ userId: agentUserId, username: agentUsername, companyId: agentCompanyId,
          action: "control_request", sessionId: session.id, ip });
        broadcastOther(room!, role, { type: "control_request" });
        return;
      }
      if (type === "control_grant" && role === "customer") {
        await db.update(cobrowseSessionsTable)
          .set({ controlState: "granted", controlGrantedAt: new Date() })
          .where(eq(cobrowseSessionsTable.id, session.id)).catch(() => {});
        await auditWs({ userId: null, username: "customer", companyId: null,
          action: "control_grant", sessionId: session.id, ip });
        broadcastOther(room!, role, { type: "control_grant" });
        return;
      }
      if (type === "control_revoke") {
        await db.update(cobrowseSessionsTable)
          .set({ controlState: "none", controlEndedAt: new Date() })
          .where(eq(cobrowseSessionsTable.id, session.id)).catch(() => {});
        await auditWs({
          userId: role === "agent" ? agentUserId : null,
          username: role === "agent" ? agentUsername : "customer",
          companyId: agentCompanyId,
          action: "control_revoke", sessionId: session.id, ip,
          meta: { by: role },
        });
        broadcastOther(room!, role, { type: "control_revoke" });
        return;
      }

      // Reject control input from agent unless control is granted.
      // (We re-read room state in DB to keep it authoritative — an
      // attacker controlling the agent socket could still fake events
      // otherwise.)
      if (type === "control_event" && role === "agent") {
        const [s] = await db.select({ controlState: cobrowseSessionsTable.controlState })
          .from(cobrowseSessionsTable).where(eq(cobrowseSessionsTable.id, session.id)).limit(1);
        if (!s || s.controlState !== "granted") return;
      }

      // Default: relay to the other peer. This covers rrweb_event,
      // control_event (mouse/keyboard), cursor_pos, ping/pong, etc.
      broadcastOther(room!, role, { ...msg, _from: role });
    });

    const cleanup = async () => {
      const r = rooms.get(session.id);
      if (!r) return;
      const cur = r.peers.get(role);
      if (cur && cur.ws === ws) r.peers.delete(role);
      // Tell the other peer we left.
      broadcastOther(r, role, { type: "peer_left", role });
      if (r.peers.size === 0) {
        rooms.delete(session.id);
        await endSessionInDb(session.id, role === "customer" ? "customer_disconnect" : "agent_disconnect");
      }
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  logger.info("cobrowse: signaling hub attached at /api/cobrowse/ws");
}

// Generate a URL-safe random invite token.
export function newInviteToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}
