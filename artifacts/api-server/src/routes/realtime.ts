import { Router, type IRouter } from "express";
import { resolveBearerToken } from "../middleware/auth.js";
import { sessionEvents, type SessionEvent } from "../lib/sessionEvents.js";

const router: IRouter = Router();

// GET /api/realtime/session-events — Server-Sent Events stream that pushes
// "refresh me" pings to the client whenever the SuperAdmin (or any other
// privileged actor) mutates something that changes what the user can see
// (subscription limits, company status, permissions, etc.).
//
// EventSource cannot send custom headers, so we accept the bearer token
// either via the standard Authorization header (when reachable) OR via a
// `?token=…` query parameter — the client uses the latter.
//
// The stream is filtered server-side: a regular user only receives events
// scoped to their own companyId; a SuperAdmin receives every event so the
// admin dashboards can auto-refresh too.
router.get("/session-events", async (req, res) => {
  const headerAuth = req.headers.authorization;
  const headerTok = headerAuth?.startsWith("Bearer ") ? headerAuth.slice(7) : null;
  const queryTok = typeof req.query?.token === "string" ? req.query.token : null;
  const token = headerTok ?? queryTok;
  if (!token) {
    res.status(401).json({ error: "missing token" });
    return;
  }

  const resolved = await resolveBearerToken(token);
  if (!resolved) {
    res.status(401).json({ error: "invalid token" });
    return;
  }

  const userCompanyId = resolved.user.companyId;
  const userId = resolved.user.id;
  const isSuperAdmin = resolved.user.role === "superadmin";

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  res.write(`event: hello\ndata: {"ok":true}\n\n`);

  const onEvent = (evt: SessionEvent) => {
    // Per-user targeted events: only the addressed user receives them
    // (superadmins included only when explicitly addressed).
    if (evt.userId != null) {
      if (evt.userId !== userId) return;
    } else {
      if (!isSuperAdmin && evt.companyId !== userCompanyId) return;
    }
    try {
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
    } catch {
      // socket already gone — cleanup will run via close handler
    }
  };

  sessionEvents.on("event", onEvent);

  // Heartbeat every 25s so reverse proxies don't cut idle SSE connections.
  const heartbeat = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch { /* ignore */ }
  }, 25_000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    sessionEvents.off("event", onEvent);
    try { res.end(); } catch { /* ignore */ }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("error", cleanup);
});

export default router;
