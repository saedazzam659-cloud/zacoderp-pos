// Windows Desktop POS — sync engine endpoints.
// Authenticated via X-Device-Token (deviceAuth). Push/pull/heartbeat are
// the three primitives the desktop app uses to stay in step with the
// cloud.  This is a SKELETON implementation — payload validation +
// invoice-replay logic will be fleshed out in Step 6 (SQLite + sync
// engine) of Task #174.

import { Router } from "express";
import { db } from "@workspace/db";
import {
  posDevicesTable, syncQueueLogTable, customersTable, itemsTable,
  posSessionsTable, salesInvoicesTable,
} from "@workspace/db";
import { eq, and, gt, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { deviceAuth, type DeviceAuthedRequest } from "../lib/posDesktopGuards.js";

const router = Router();
router.use(deviceAuth);

async function log(req: DeviceAuthedRequest, direction: string, entityType: string | null, count: number, status: string, err?: string, durationMs?: number) {
  try {
    await db.insert(syncQueueLogTable).values({
      companyId: req.device!.companyId,
      deviceId: req.device!.id,
      direction,
      entityType,
      payloadCount: count,
      status,
      errorMessage: err ?? null,
      durationMs: durationMs ?? null,
    });
  } catch { /* swallow — logging is best-effort */ }
}

// ─── POST /api/sync/heartbeat ────────────────────────────────────────
// Lightweight ping sent every 30s from the desktop app. Updates
// lastHeartbeatAt + lastSeenIp + appVersion. Used by SuperAdmin to see
// which devices are currently online.
const heartbeatSchema = z.object({
  appVersion: z.string().max(50).optional(),
  battery: z.number().int().min(0).max(100).optional(),
  osInfo: z.string().max(500).optional(),
  // The currently-open POS session on this device, if any. When supplied we
  // bump pos_sessions.last_heartbeat_at so the server-side auto-close
  // janitor can tell apart "cashier still active" from "session abandoned".
  // The session is matched by id AND company so a forged id from another
  // tenant can never be touched.
  posSessionId: z.number().int().positive().optional(),
});
router.post("/heartbeat", async (req: DeviceAuthedRequest, res) => {
  const parsed = heartbeatSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "bad payload" }); return; }
  const did = req.device!.id;
  const cid = req.device!.companyId;
  const now = new Date();
  await db.update(posDevicesTable).set({
    lastHeartbeatAt: now,
    lastSeenIp: req.ip ?? null,
    appVersion: parsed.data.appVersion ?? undefined,
    osInfo: parsed.data.osInfo ?? undefined,
    updatedAt: now,
  }).where(eq(posDevicesTable.id, did));
  if (parsed.data.posSessionId) {
    await db.update(posSessionsTable).set({ lastHeartbeatAt: now })
      .where(and(
        eq(posSessionsTable.id, parsed.data.posSessionId),
        eq(posSessionsTable.companyId, cid),
        eq(posSessionsTable.status, "open"),
      ));
  }
  await log(req, "heartbeat", null, 0, "ok");
  res.json({ ok: true, serverTime: now.toISOString() });
});

// ─── POST /api/sync/close-pos-session ────────────────────────────────
// Desktop-token authed counterpart to /api/pos-sessions/:id/close — used
// by the desktop when the original logout-time call failed (no network)
// and now needs to be retried from the offline queue. We require the
// device's own token rather than a cashier JWT because by the time the
// retry fires the cashier has long since logged out and their token has
// been wiped. The session is matched by id AND company so cross-tenant
// closes are impossible. Idempotent: if the session is already closed
// (e.g. the auto-close janitor got there first) we return the existing
// row with status "ok" so the desktop can safely drop the queued op.
const closeSessionSchema = z.object({
  posSessionId: z.number().int().positive(),
  closingCash: z.number().optional(),
  notes: z.string().max(1000).optional(),
  // The wall-clock time on the desktop when the cashier hit "logout".
  // Used as the authoritative closedAt so the shift reports reflect when
  // the cashier actually stopped working, not when the network came back.
  closedAt: z.string().datetime().optional(),
});
router.post("/close-pos-session", async (req: DeviceAuthedRequest, res) => {
  const parsed = closeSessionSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const cid = req.device!.companyId;
  const [s] = await db.select().from(posSessionsTable)
    .where(and(eq(posSessionsTable.id, parsed.data.posSessionId), eq(posSessionsTable.companyId, cid)));
  if (!s) { res.status(404).json({ error: "session not found" }); return; }
  if (s.status !== "open") {
    res.json({ ok: true, alreadyClosed: true, session: s });
    return;
  }
  const [{ totalCash } = { totalCash: "0" }] = await db.select({
    totalCash: sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}), 0)`,
  }).from(salesInvoicesTable).where(and(
    eq(salesInvoicesTable.posSessionId, s.id),
    eq(salesInvoicesTable.companyId, s.companyId),
    eq(salesInvoicesTable.status, "posted"),
    eq(salesInvoicesTable.paymentType, "cash"),
  ));
  const expected = Number(s.openingCash || 0) + Number(totalCash || 0);
  const closing = parsed.data.closingCash != null ? Number(parsed.data.closingCash) : expected;
  const closedAt = parsed.data.closedAt ? new Date(parsed.data.closedAt) : new Date();
  const [row] = await db.update(posSessionsTable).set({
    status: "closed",
    closingCash: String(closing.toFixed(2)),
    expectedCash: String(expected.toFixed(2)),
    difference: String((closing - expected).toFixed(2)),
    closedAt,
    closedNotes: parsed.data.notes ?? null,
    closeReason: "cashier_logout_deferred",
  }).where(eq(posSessionsTable.id, s.id)).returning();
  await log(req, "close-pos-session", "pos_session", 1, "ok");
  res.json({ ok: true, session: row });
});

// ─── POST /api/sync/pull ─────────────────────────────────────────────
// The desktop app asks "give me everything that changed since <since>"
// for a set of entity types. Returns lightweight payloads the local
// SQLite mirror can upsert. SKELETON: returns customers + items only
// for now. Other entity types (price lists, taxes, payment methods,
// branch users) will be added in Step 6.
const pullSchema = z.object({
  since: z.string().datetime().optional(),
  entities: z.array(z.enum(["customers", "items", "settings"])).default(["customers", "items"]),
});
router.post("/pull", async (req: DeviceAuthedRequest, res) => {
  const t0 = Date.now();
  const parsed = pullSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const cid = req.device!.companyId;
  const sinceDate = parsed.data.since ? new Date(parsed.data.since) : new Date(0);
  const out: Record<string, unknown[]> = {};
  let total = 0;

  if (parsed.data.entities.includes("customers")) {
    // customers schema currently exposes only createdAt; full delta sync
    // via updatedAt lands in Step 6 of Task #174 when an updated_at
    // column is added to customers. For now we ship all customers on
    // the first pull and rely on the client to dedup.
    const rows = await db.select({
      id: customersTable.id,
      nameAr: customersTable.nameAr,
      nameEn: customersTable.nameEn,
      phone: customersTable.phone,
      vatNumber: customersTable.vatNumber,
      createdAt: customersTable.createdAt,
    }).from(customersTable)
      .where(and(eq(customersTable.companyId, cid), gt(customersTable.createdAt, sinceDate)))
      .limit(5000);
    out.customers = rows; total += rows.length;
  }
  if (parsed.data.entities.includes("items")) {
    const rows = await db.select({
      id: itemsTable.id,
      code: itemsTable.code,
      nameAr: itemsTable.nameAr,
      nameEn: itemsTable.nameEn,
      barcode: itemsTable.barcode,
      salePrice: itemsTable.salePrice,
      vatRate: itemsTable.vatRate,
      updatedAt: itemsTable.updatedAt,
    }).from(itemsTable)
      .where(and(eq(itemsTable.companyId, cid), gt(itemsTable.updatedAt, sinceDate)))
      .limit(5000);
    out.items = rows; total += rows.length;
  }
  if (parsed.data.entities.includes("settings")) {
    out.settings = [{
      enableOfflinePos: true,
      serverTime: new Date().toISOString(),
    }];
  }

  await db.update(posDevicesTable).set({ lastSyncAt: new Date(), updatedAt: new Date() }).where(eq(posDevicesTable.id, req.device!.id));
  await log(req, "pull", parsed.data.entities.join(","), total, "ok", undefined, Date.now() - t0);
  res.json({ ok: true, serverTime: new Date().toISOString(), entities: out });
});

// ─── POST /api/sync/push ─────────────────────────────────────────────
// The desktop app uploads its locally-queued operations (offline-created
// invoices, payments, customer adds). SKELETON: validates shape, logs
// the receipt, ALWAYS returns 200 with a per-item ack. The real
// invoice-creation pipeline lands in Step 6 once SQLCipher + sync engine
// are wired up. We DO NOT call the existing /api/invoices code path
// here — that would risk side effects without the full validation
// chain the desktop sync engine requires (idempotency keys, conflict
// resolution, ZATCA-already-signed flag, etc.).
const pushSchema = z.object({
  items: z.array(z.object({
    clientId: z.string().min(1),           // local SQLite row id (uuid)
    entityType: z.string().min(1),
    operation: z.enum(["create", "update", "delete"]),
    payload: z.record(z.string(), z.unknown()),
    // Accept any RFC3339 timestamp — chrono's to_rfc3339() in the Rust
    // pusher emits "+00:00" offsets, not the "Z" suffix that zod's default
    // .datetime() requires. {offset:true} lets both forms pass validation.
    occurredAt: z.string().datetime({ offset: true }).optional(),
  })).max(500),
});
router.post("/push", async (req: DeviceAuthedRequest, res) => {
  const t0 = Date.now();
  const parsed = pushSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const acks = parsed.data.items.map((it) => ({
    clientId: it.clientId,
    status: "queued" as const,
    note: "Skeleton sync: real invoice replay lands in Step 6 of Task #174.",
  }));
  await log(req, "push", "mixed", parsed.data.items.length, "ok", undefined, Date.now() - t0);
  res.json({ ok: true, acks, serverTime: new Date().toISOString() });
});

// ─── GET /api/sync/status ────────────────────────────────────────────
// Convenience endpoint the desktop UI can call to render a "last
// synced" indicator. No state-changing side effects.
router.get("/status", async (req: DeviceAuthedRequest, res) => {
  const [dev] = await db.select({
    id: posDevicesTable.id,
    lastSyncAt: posDevicesTable.lastSyncAt,
    lastHeartbeatAt: posDevicesTable.lastHeartbeatAt,
    status: posDevicesTable.status,
  }).from(posDevicesTable).where(eq(posDevicesTable.id, req.device!.id));
  res.json({ ...dev, serverTime: new Date().toISOString() });
});

export default router;
