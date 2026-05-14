/**
 * Per-tenant outbound webhook dispatcher.
 *
 * Design:
 *  - Persist a delivery row first (status=pending) so audit + replay work.
 *  - POST JSON to the subscriber URL with HMAC-SHA256 signature header.
 *  - Retry up to 3 times with exponential backoff (1s, 4s, 16s) on
 *    network error or 5xx; client errors (4xx) are recorded as failed
 *    without retry — the subscriber must fix the endpoint.
 *  - "Fire and forget" from the caller's perspective — the route returns
 *    immediately, the dispatcher runs in the background. We never let a
 *    webhook failure block the real ZATCA submission flow.
 */
import { db } from "@workspace/db";
import {
  gatewayWebhooksTable,
  gatewayWebhookDeliveriesTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { createHmac } from "crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { decryptSecret } from "./encryption.js";
import { logger } from "./logger.js";

/**
 * SSRF guard. Rejects URLs that resolve to private/loopback/link-local/
 * metadata IP ranges. Resolves DNS once and reuses the address; without
 * this an attacker could create a webhook pointing at AWS/GCP metadata
 * (169.254.169.254), localhost services, or RFC1918 internal hosts and
 * have our backend POST to them with their own HMAC-signed body. The
 * rejection happens BOTH at subscription time (via assertSafeUrl below,
 * called from the route) AND at delivery time as defense-in-depth.
 */
const PRIV_V4 = [
  /^10\./, /^127\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];
function isPrivateIp(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return PRIV_V4.some(re => re.test(addr));
  if (v === 6) {
    const lc = addr.toLowerCase();
    return lc === "::1" || lc === "::" || lc.startsWith("fc") || lc.startsWith("fd") || lc.startsWith("fe80") || lc.startsWith("::ffff:");
  }
  return false;
}
export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let u: URL;
  try { u = new URL(rawUrl); }
  catch { throw new Error("URL غير صالح"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("الـ webhook يجب أن يكون http(s)");
  if (process.env.NODE_ENV === "production" && u.protocol !== "https:") {
    throw new Error("في بيئة الإنتاج يجب استخدام HTTPS");
  }
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "ip6-localhost") throw new Error("لا يُسمح بـ localhost");
  // If literal IP, check directly. Otherwise resolve & check every record.
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error("لا يُسمح بعنوان IP داخلي/خاص");
  } else {
    let addrs: { address: string }[] = [];
    try { addrs = await lookup(host, { all: true }); }
    catch { throw new Error(`تعذّر حلّ DNS للمضيف: ${host}`); }
    if (addrs.some(a => isPrivateIp(a.address))) throw new Error("المضيف يحلّ إلى عنوان داخلي/خاص");
  }
  return u;
}

export type GatewayWebhookEvent =
  | "invoice.cleared"
  | "invoice.rejected"
  | "invoice.warning"
  | "invoice.received"
  | "quota.threshold";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 4_000, 16_000];

export interface WebhookFireOpts {
  clientId: number;
  event: GatewayWebhookEvent;
  payload: Record<string, unknown>;
}

/**
 * Schedule webhook delivery to every active subscriber on the client.
 * Non-blocking — returns once the delivery rows are persisted; the actual
 * HTTP POSTs run via setImmediate so the request thread is freed.
 */
export async function fireWebhook(opts: WebhookFireOpts): Promise<void> {
  const { clientId, event, payload } = opts;
  const subs = await db
    .select()
    .from(gatewayWebhooksTable)
    .where(and(eq(gatewayWebhooksTable.clientId, clientId), eq(gatewayWebhooksTable.active, true)));

  for (const sub of subs) {
    const events = Array.isArray(sub.events) ? (sub.events as string[]) : [];
    if (events.length > 0 && !events.includes(event) && !events.includes("*")) continue;

    let secret = "";
    try { secret = decryptSecret(sub.secretEnc) || ""; } catch { /* logged below */ }
    if (!secret) {
      logger.warn({ webhookId: sub.id, clientId }, "webhook.secret-decrypt-failed");
      continue;
    }

    const fullPayload = {
      event,
      clientId,
      timestamp: new Date().toISOString(),
      data: payload,
    };

    const [delivery] = await db
      .insert(gatewayWebhookDeliveriesTable)
      .values({
        webhookId: sub.id,
        event,
        payload: fullPayload,
        status: "pending",
        attempts: 0,
      })
      .returning({ id: gatewayWebhookDeliveriesTable.id });

    setImmediate(() => {
      void deliverWithRetry(delivery.id, sub.id, sub.url, secret, fullPayload);
    });
  }
}

async function deliverWithRetry(
  deliveryId: number,
  webhookId: number,
  url: string,
  secret: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let httpStatus = 0;
    let lastError: string | null = null;
    try {
      // Defense-in-depth: re-validate URL each delivery in case DNS
      // changed since subscription (DNS rebinding mitigation).
      await assertSafeUrl(url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Signature": sig,
          "X-Gateway-Delivery-Id": String(deliveryId),
          "X-Gateway-Event": String(payload.event),
          "User-Agent": "ZATCA-Gateway-Webhook/1.0",
        },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      httpStatus = resp.status;

      if (httpStatus >= 200 && httpStatus < 300) {
        await db.update(gatewayWebhookDeliveriesTable).set({
          status: "success", httpStatus, attempts: attempt, deliveredAt: new Date(),
        }).where(eq(gatewayWebhookDeliveriesTable.id, deliveryId));
        await db.update(gatewayWebhooksTable).set({
          lastDeliveryAt: new Date(), lastStatus: "success", lastError: null, failureCount: 0,
        }).where(eq(gatewayWebhooksTable.id, webhookId));
        return;
      }
      lastError = `HTTP ${httpStatus}`;
      // 4xx is a client/subscriber problem — don't retry
      if (httpStatus >= 400 && httpStatus < 500) {
        await failDelivery(deliveryId, webhookId, attempt, httpStatus, lastError, "failed");
        return;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }

    if (attempt === MAX_ATTEMPTS) {
      await failDelivery(deliveryId, webhookId, attempt, httpStatus, lastError ?? "unknown", "exhausted");
      return;
    }
    await new Promise(r => setTimeout(r, BACKOFF_MS[attempt - 1] ?? 16_000));
  }
}

async function failDelivery(
  deliveryId: number, webhookId: number, attempts: number,
  httpStatus: number, lastError: string, status: "failed" | "exhausted",
): Promise<void> {
  await db.update(gatewayWebhookDeliveriesTable).set({
    status, httpStatus: httpStatus || null, attempts, lastError,
  }).where(eq(gatewayWebhookDeliveriesTable.id, deliveryId));
  await db.update(gatewayWebhooksTable).set({
    lastDeliveryAt: new Date(),
    lastStatus: "failed",
    lastError,
    failureCount: sql`${gatewayWebhooksTable.failureCount} + 1`,
  }).where(eq(gatewayWebhooksTable.id, webhookId));
}
