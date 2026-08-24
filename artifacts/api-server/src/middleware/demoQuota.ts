import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { finalizeDemoAction, getProfile, reserveDemoAction, resolveDemoIdentity } from "../lib/demoAnalytics.js";
import { logger } from "../lib/logger.js";

const EXEMPT_PREFIXES = ["/auth", "/demo-analytics", "/admin", "/sync", "/realtime", "/health", "/agent-updates", "/integrations/inbound"];
const READ_LIKE_POST = [/\/search(?:\/|$)/, /\/filter(?:\/|$)/, /\/preview(?:\/|$)/, /\/poll(?:\/|$)/, /\/calculate(?:\/|$)/];
/** Server-owned route classifier: never trusts an action label from the client. */
export function isDemoQuotaWrite(req: Pick<Request, "path" | "originalUrl" | "method">) {
  const path = req.path || req.originalUrl.split("?")[0];
  if (EXEMPT_PREFIXES.some(x => path === x || path.startsWith(`${x}/`))) return false;
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return false;
  return !READ_LIKE_POST.some(re => re.test(path));
}
export async function demoQuotaMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!isDemoQuotaWrite(req)) return next();
  try {
    const identity = await resolveDemoIdentity(req);
    if (!identity) return next();
    const profile = await getProfile(identity);
    // Phone collection is an actual server gate, not merely a frontend modal.
    if (!profile?.phone) return res.status(428).json({ code: "DEMO_PHONE_REQUIRED", error: "Demo phone registration is required" });
    const supplied = req.headers["idempotency-key"];
    const key = typeof supplied === "string" && supplied.length <= 160 && supplied.length > 0
      ? supplied : `${req.method}:${req.path}:${crypto.randomUUID()}`;
    const reservation = await reserveDemoAction(profile.id, req.path, key);
    if (!reservation.ok) return res.status(reservation.status).json({ code: reservation.code, subscriptionMessage: reservation.policy.subscriptionMessage ?? null });
    let done = false;
    res.once("finish", () => {
      if (done) return; done = true;
      // 2xx/3xx are intentional success; all client/server errors refund.
      void finalizeDemoAction(reservation.reservationId, res.statusCode >= 200 && res.statusCode < 400, req.path)
        .catch(err => logger.error({ err, reservationId: reservation.reservationId }, "demo quota finalization failed"));
    });
    return next();
  } catch (err) { return next(err); }
}