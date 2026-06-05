// Windows Desktop POS — sync engine endpoints.
// Authenticated via X-Device-Token (deviceAuth). Push/pull/heartbeat are
// the three primitives the desktop app uses to stay in step with the
// cloud.
//
// /push (Step 6 of Task #174 — IMPLEMENTED):
//   Replays offline-saved invoices into the cloud — inserts sales_invoices
//   + sales_invoice_lines (status=posted), builds the full POS journal
//   entry (DR cashbox / DR COGS / CR revenue / CR VAT / CR inventory),
//   and decrements stock_balance + stock_ledger. Idempotent via
//   sales_invoices.notes "[offline:<clientId>]" tag. Reuses the same
//   helpers the web /api/sales-invoices/:id/post route uses
//   (createJournalEntry, upsertBalance, addStockLedgerEntry,
//   loadMappings) so the books match byte-for-byte.

import { Router } from "express";
import { db } from "@workspace/db";
import {
  posDevicesTable, syncQueueLogTable, customersTable, itemsTable,
  posSessionsTable, salesInvoicesTable, salesInvoiceLinesTable,
  warehousesTable, cashBoxesTable, stockBalanceTable, companiesTable,
} from "@workspace/db";
import { eq, and, gt, desc, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { deviceAuth, type DeviceAuthedRequest } from "../lib/posDesktopGuards.js";
import { loadMappings } from "../lib/accountingMappings.js";
import { upsertBalance, getBalance, addStockLedgerEntry } from "../lib/stockHelpers.js";
import { createJournalEntry } from "./sales.js";
import { nextSequenceNumber } from "../lib/sequences.js";

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
    // Windows desktop-app module visibility — SuperAdmin-controlled per company
    // (companies.windows_module_permissions JSON). Pushed here so the device
    // hides/shows modules without a reinstall. NULL/unparseable → empty object
    // (the desktop treats a missing key as "enabled" for backward compat).
    const [company] = await db.select({
      windowsModulePermissions: companiesTable.windowsModulePermissions,
    }).from(companiesTable).where(eq(companiesTable.id, cid)).limit(1);
    let windowsModules: Record<string, boolean> = {};
    if (company?.windowsModulePermissions) {
      try {
        const parsedWm = JSON.parse(company.windowsModulePermissions);
        if (parsedWm && typeof parsedWm === "object") windowsModules = parsedWm;
      } catch { /* keep empty → all enabled */ }
    }
    out.settings = [{
      enableOfflinePos: true,
      serverTime: new Date().toISOString(),
      windowsModules,
    }];
  }

  await db.update(posDevicesTable).set({ lastSyncAt: new Date(), updatedAt: new Date() }).where(eq(posDevicesTable.id, req.device!.id));
  await log(req, "pull", parsed.data.entities.join(","), total, "ok", undefined, Date.now() - t0);
  res.json({ ok: true, serverTime: new Date().toISOString(), entities: out });
});

// ─── POST /api/sync/push ─────────────────────────────────────────────
// The desktop app uploads its locally-queued operations (offline-created
// invoices). Each item carries a stable clientId (the local SQLite
// row's uuid) which we tag into sales_invoices.notes as `[offline:<id>]`
// so a re-push of the same item returns the original invoice instead
// of creating duplicates. For `entityType=invoice` + `operation=create`,
// the Rust pusher wraps the saved OfflineInvoicePayload under
// `payload.data` and adds `payload.invoiceNo` (local sequence) plus
// `payload.qrBase64`/`payload.signedXml`. We replay it as a POSTED POS
// sales invoice + balanced JE + stock decrement using the same helpers
// the canonical /api/sales-invoices/:id/post route uses.
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

type AckStatus = "ok" | "duplicate" | "skipped" | "error";
interface PushAck {
  clientId: string;
  status: AckStatus;
  invoiceId?: number;
  docNumber?: string | null;
  journalEntryId?: number;
  note?: string;
  error?: string;
}

// Pull the OfflineInvoicePayload shape out of the Rust pusher envelope.
// Tolerates two historic shapes: (1) `{ data: <payload> }` from the current
// Rust pusher, (2) `<payload>` flat for any future direct sender.
function unwrapInvoicePayload(raw: Record<string, unknown>): Record<string, unknown> {
  const data = raw.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  return raw;
}

// Resolve which open POS session this offline invoice belongs to.
// Preferred path: the desktop pusher includes `posSessionId` in the payload
// envelope OR inside `payload.data` (added in v0.3.9+). Fallback path for
// older clients: pick the only open session for the company. When more than
// one session is open we use the most-recently-opened one — safe in
// single-cashier-per-device deployments which is the supported topology.
async function resolvePosSession(
  cid: number,
  envelope: Record<string, unknown>,
  data: Record<string, unknown>,
): Promise<{ id: number; userId: number; branchId: number | null; cashBoxId: number | null } | null> {
  const explicit = Number(envelope.posSessionId ?? data.posSessionId);
  if (Number.isInteger(explicit) && explicit > 0) {
    const [s] = await db.select({
      id: posSessionsTable.id, userId: posSessionsTable.userId,
      branchId: posSessionsTable.branchId, cashBoxId: posSessionsTable.cashBoxId,
    }).from(posSessionsTable).where(and(
      eq(posSessionsTable.id, explicit), eq(posSessionsTable.companyId, cid),
    ));
    if (s) return s;
  }
  const open = await db.select({
    id: posSessionsTable.id, userId: posSessionsTable.userId,
    branchId: posSessionsTable.branchId, cashBoxId: posSessionsTable.cashBoxId,
  }).from(posSessionsTable)
    .where(and(eq(posSessionsTable.companyId, cid), eq(posSessionsTable.status, "open")))
    .orderBy(desc(posSessionsTable.openedAt)).limit(1);
  return open[0] ?? null;
}

async function getCashBoxAccount(cid: number, cashBoxId: number): Promise<number | null> {
  const [cb] = await db.select({ accountId: cashBoxesTable.accountId })
    .from(cashBoxesTable)
    .where(and(eq(cashBoxesTable.id, cashBoxId), eq(cashBoxesTable.companyId, cid)));
  return cb?.accountId ?? null;
}

// Pick the warehouse the desktop POS implicitly used for stock decrement.
// The offline payload does NOT carry a warehouseId per line, so we pick
// the company default (uniqueIndex enforces one default per company).
// Branch-scoped default would be nicer but requires desktop-side context.
async function resolveDefaultWarehouse(cid: number): Promise<{ id: number; nameAr: string; accountId: number | null } | null> {
  const rows = await db.select({
    id: warehousesTable.id, nameAr: warehousesTable.nameAr,
    accountId: warehousesTable.accountId, isDefault: warehousesTable.isDefault,
    isActive: warehousesTable.isActive,
  }).from(warehousesTable)
    .where(and(eq(warehousesTable.companyId, cid), eq(warehousesTable.isActive, true)));
  if (!rows.length) return null;
  const def = rows.find(w => w.isDefault) ?? rows[0];
  return { id: def.id, nameAr: def.nameAr, accountId: def.accountId ?? null };
}

async function replayInvoice(
  cid: number,
  clientId: string,
  envelope: Record<string, unknown>,
): Promise<PushAck> {
  // 1) Idempotency: same clientId tag → return the original row.
  const dup = await db.select({ id: salesInvoicesTable.id, docNumber: salesInvoicesTable.docNumber, journalEntryId: salesInvoicesTable.journalEntryId })
    .from(salesInvoicesTable)
    .where(and(
      eq(salesInvoicesTable.companyId, cid),
      sql`${salesInvoicesTable.notes} LIKE ${`%[offline:${clientId}]%`}`,
    )).limit(1);
  if (dup.length) {
    return {
      clientId, status: "duplicate",
      invoiceId: dup[0].id, docNumber: dup[0].docNumber,
      journalEntryId: dup[0].journalEntryId ?? undefined,
      note: "already synced",
    };
  }

  const data = unwrapInvoicePayload(envelope);

  // 2) Refund items deferred — handled in a follow-up push iteration so
  //    we can build sales_returns + reverse JE + stock restore properly.
  if (data.kind === "return") {
    return { clientId, status: "skipped", note: "refunds replay lands in a follow-up step (sales_return + reverse JE)" };
  }

  // 3) Validate the offline payload basics.
  const lines = Array.isArray(data.lines) ? data.lines as Array<Record<string, unknown>> : [];
  if (!lines.length) throw new Error("الفاتورة لا تحتوي على أي بنود");
  const subtotal = Number(data.subtotal ?? 0);
  const vatAmt   = Number(data.vat ?? 0);
  const grandTotal = Number(data.grandTotal ?? 0);
  if (!Number.isFinite(grandTotal) || grandTotal < 0) throw new Error("إجمالي الفاتورة غير صالح");

  // 4) Resolve POS session → branch + cashbox + cashier.
  const sess = await resolvePosSession(cid, envelope, data);
  if (!sess) throw new Error("لا توجد جلسة نقاط بيع مفتوحة لاستقبال الفاتورة (أرفق posSessionId أو افتح جلسة في الخزنة)");
  if (!sess.cashBoxId) throw new Error("جلسة نقاط البيع لا تحتوي على خزنة مرتبطة");

  // 5) Resolve default warehouse for the stock movement.
  const wh = await resolveDefaultWarehouse(cid);
  if (!wh) throw new Error("لا يوجد مخزن مفعّل في الشركة لتسجيل حركة المخزون");

  // 6) Load accounting mappings (POS-specific → fallback to sales_invoice).
  const mapSi  = await loadMappings(cid, "sales_invoice");
  const mapPos = await loadMappings(cid, "pos_invoice");
  const pick = (role: string): number | null => mapPos("pos_invoice", role) ?? mapSi("sales_invoice", role);
  const salesAccId = pick("revenue");
  const cogsAccId  = pick("cogs");
  const taxAccId   = pick("vat_output");
  const invAccId   = wh.accountId ?? pick("inventory");
  const cashAccId  = await getCashBoxAccount(cid, sess.cashBoxId);

  if (!cashAccId) throw new Error("الخزنة المرتبطة بالجلسة لا تحتوي على حساب محاسبي");
  if (!salesAccId) throw new Error("لم يتم ربط حساب إيراد فواتير نقاط البيع — اضبطه من ربط القيود المحاسبية (pos_invoice → revenue)");
  if (!cogsAccId)  throw new Error("لم يتم ربط حساب تكلفة البضاعة المباعة (pos_invoice → cogs)");
  if (!invAccId)   throw new Error(`المخزن «${wh.nameAr}» غير مرتبط بحساب محاسبي`);
  if (vatAmt > 0 && !taxAccId) throw new Error("لم يتم ربط حساب ضريبة المخرجات (pos_invoice → vat_output)");

  // 7) Invoice date — desktop captures local-wallclock at checkout time.
  const tsStr = typeof data.timestamp === "string" ? data.timestamp : new Date().toISOString();
  const invoiceDate = tsStr.slice(0, 10);

  // 8) Allocate the cloud invoice number atomically (server-side sequence
  //    wins; the desktop's local "OFF-YYMMDD-####" stays as a backup).
  let docNumber: string | null = null;
  try {
    docNumber = await nextSequenceNumber(cid, "sales_invoice", {
      refTable: "sales_invoices", branchId: sess.branchId ?? null, docDate: invoiceDate,
    });
  } catch (e: any) {
    throw new Error(e?.message || "تعذر توليد رقم الفاتورة");
  }
  if (!docNumber) {
    docNumber = typeof envelope.invoiceNo === "string"
      ? envelope.invoiceNo
      : (typeof data.invoiceNo === "string" ? data.invoiceNo : null);
  }

  // 9) Walk lines → compute per-item COGS from the warehouse's WAC.
  type StockOp = { itemId: number; qty: number; avgCost: number; name: string };
  const stockOps: StockOp[] = [];
  let totalCogs = 0;
  for (const l of lines) {
    const itemId = Number(l.itemId);
    const qty    = Number(l.qty);
    if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
    const [bal] = await db.select({ avgCost: stockBalanceTable.avgCost })
      .from(stockBalanceTable)
      .where(and(
        eq(stockBalanceTable.companyId, cid),
        eq(stockBalanceTable.itemId, itemId),
        eq(stockBalanceTable.warehouseId, wh.id),
      ));
    const avgCost = Number(bal?.avgCost ?? 0);
    totalCogs += qty * avgCost;
    stockOps.push({ itemId, qty, avgCost, name: String(l.nameAr ?? `صنف ${itemId}`) });
  }

  if (grandTotal === 0 && totalCogs === 0) {
    throw new Error("لا يمكن ترحيل فاتورة بإجمالي صفر بدون تكلفة مخزنية");
  }

  // 10) Insert the cloud sales_invoice as POSTED. The note tag is what
  //     makes the next push idempotent.
  const paymentMethod = data.paymentMethod === "card" ? "card" : "cash";
  const noteParts: string[] = [];
  if (data.customerName) noteParts.push(`العميل: ${data.customerName}`);
  if (data.vatNumber)    noteParts.push(`الرقم الضريبي: ${data.vatNumber}`);
  if (paymentMethod === "card") noteParts.push("(بطاقة)");
  noteParts.push(`[offline:${clientId}]`);

  const [inv] = await db.insert(salesInvoicesTable).values({
    companyId: cid,
    branchId: sess.branchId ?? null,
    docNumber,
    invoiceDate,
    customerId: null, // walk-in (POS desktop carts have no linked customer)
    paymentType: "cash", // both cash & card route through the session's cashbox
    cashBoxId: sess.cashBoxId,
    bankAccountId: null,
    currencyCode: "SAR",
    subtotal:       String(subtotal.toFixed(2)),
    vatAmount:      String(vatAmt.toFixed(2)),
    discountAmount: "0.00",
    totalAmount:    String(grandTotal.toFixed(2)),
    priceIncludesVat: false,
    status: "posted",
    notes: noteParts.join(" "),
    cogsAccountId:      cogsAccId,
    inventoryAccountId: invAccId,
    salesAccountId:     salesAccId,
    taxAccountId:       taxAccId,
    posSessionId: sess.id,
    createdById:  sess.userId,
    postedById:   sess.userId,
    postedAt: new Date(),
  }).returning();

  // 11) Insert invoice lines (pin every line to the resolved warehouse so
  //     reports + per-warehouse stock queries see them).
  await db.insert(salesInvoiceLinesTable).values(lines.map((l) => {
    const itemId = Number(l.itemId);
    const qty    = Number(l.qty);
    const price  = Number(l.unitPrice);
    return {
      invoiceId: inv.id,
      companyId: cid,
      itemId: Number.isInteger(itemId) && itemId > 0 ? itemId : null,
      itemName: String(l.nameAr ?? "صنف"),
      warehouseId: wh.id,
      qty:      String(Number.isFinite(qty)   ? qty   : 0),
      unitPrice: String(Number.isFinite(price) ? price : 0),
      discount: "0",
      vatRate:  String(Number(l.vatRate ?? 15)),
      lineTotal: String(((Number.isFinite(qty) ? qty : 0) * (Number.isFinite(price) ? price : 0)).toFixed(2)),
    };
  }));

  // 12) Build + post the JE. Mirrors the non-GDN branch of the canonical
  //     /api/sales-invoices/:id/post handler for a single-warehouse POS sale.
  const jeLines = [
    { accountId: cashAccId, debit:  grandTotal, description: paymentMethod === "card" ? "تحصيل بطاقة (نقاط بيع)" : "تحصيل نقدي (نقاط بيع)" },
    { accountId: salesAccId, credit: subtotal,   description: "إيراد المبيعات (نقاط بيع — أوفلاين)" },
    ...(vatAmt > 0   ? [{ accountId: taxAccId!, credit: vatAmt,    description: "ضريبة القيمة المضافة (مخرجات)" }] : []),
    ...(totalCogs > 0 ? [
      { accountId: cogsAccId, debit:  totalCogs, description: "تكلفة البضاعة المباعة" },
      { accountId: invAccId,  credit: totalCogs, description: `إنقاص المخزون — ${wh.nameAr}` },
    ] : []),
  ];

  const journalId = await createJournalEntry({
    companyId: cid,
    branchId: sess.branchId ?? null,
    date: invoiceDate,
    docNumber,
    entryType: "sales_invoice",
    description: `قيد فاتورة نقاط بيع رقم ${docNumber || inv.id} (أوفلاين — جهاز ${envelope.invoiceNo ?? clientId.slice(0, 8)})`,
    lines: jeLines,
  });

  await db.update(salesInvoicesTable).set({ journalEntryId: journalId })
    .where(eq(salesInvoicesTable.id, inv.id));

  // 13) Stock decrement + ledger (only after JE succeeded so a failed JE
  //     leaves stock untouched — same ordering as sales.ts /post).
  for (const op of stockOps) {
    await upsertBalance(cid, op.itemId, wh.id, -op.qty, op.avgCost);
    const newBal = await getBalance(cid, op.itemId, wh.id);
    await addStockLedgerEntry({
      companyId: cid,
      itemId: op.itemId,
      warehouseId: wh.id,
      txDate: invoiceDate,
      txType: "sale",
      qty:        String(-op.qty),
      costPrice:  String(op.avgCost.toFixed(4)),
      totalCost:  String((-op.qty * op.avgCost).toFixed(2)),
      balanceQty: String(newBal),
      refId:   inv.id,
      refType: "sales_invoice",
      notes:   op.name,
    });
  }

  return {
    clientId, status: "ok",
    invoiceId: inv.id,
    docNumber,
    journalEntryId: journalId,
  };
}

router.post("/push", async (req: DeviceAuthedRequest, res) => {
  const t0 = Date.now();
  const parsed = pushSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const cid = req.device!.companyId;

  const acks: PushAck[] = [];
  let okCount = 0, errCount = 0, dupCount = 0, skipCount = 0;

  for (const it of parsed.data.items) {
    try {
      if (it.entityType === "invoice" && it.operation === "create") {
        const ack = await replayInvoice(cid, it.clientId, it.payload as Record<string, unknown>);
        acks.push(ack);
        if      (ack.status === "ok")        okCount++;
        else if (ack.status === "duplicate") dupCount++;
        else if (ack.status === "skipped")   skipCount++;
        else                                 errCount++;
      } else {
        // Future entity types (customer adds, parked-cart sync, etc.) land
        // here. For now they're acked as skipped so the desktop won't
        // re-queue them forever.
        acks.push({
          clientId: it.clientId, status: "skipped",
          note: `entityType=${it.entityType} operation=${it.operation} not yet replayed in cloud`,
        });
        skipCount++;
      }
    } catch (err: any) {
      req.log?.warn({ err, clientId: it.clientId }, "pos-desktop /push item failed");
      acks.push({ clientId: it.clientId, status: "error", error: err?.message ?? String(err) });
      errCount++;
    }
  }

  const status = errCount === 0 ? "ok" : (okCount > 0 ? "partial" : "error");
  await log(req, "push", "invoice",
    parsed.data.items.length, status,
    errCount > 0 ? `${errCount} item(s) failed` : undefined,
    Date.now() - t0,
  );
  res.json({
    ok: errCount === 0, acks,
    summary: { total: parsed.data.items.length, ok: okCount, duplicate: dupCount, skipped: skipCount, error: errCount },
    serverTime: new Date().toISOString(),
  });
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
