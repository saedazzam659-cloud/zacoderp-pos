import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { gatewayClientsTable, gatewayApiKeysTable, gatewayInvoicesTable } from "@workspace/db";
import { eq, and, desc, sql, isNull } from "drizzle-orm";
import { randomBytes, createHash } from "crypto";
import { writeAudit } from "../middleware/permissions.js";

const router = Router();

async function requireSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (u.role !== "superadmin") { res.status(403).json({ error: "هذه الصفحة لمدير المنصة فقط" }); return; }
  next();
}

router.use(requireSuperAdmin);

// ─── List clients (with stats) ─────────────────────────────────────────
router.get("/", async (_req, res) => {
  const rows = await db
    .select({
      id: gatewayClientsTable.id,
      nameAr: gatewayClientsTable.nameAr,
      nameEn: gatewayClientsTable.nameEn,
      vatNumber: gatewayClientsTable.vatNumber,
      crNumber: gatewayClientsTable.crNumber,
      contactEmail: gatewayClientsTable.contactEmail,
      contactPhone: gatewayClientsTable.contactPhone,
      city: gatewayClientsTable.city,
      zatcaEnv: gatewayClientsTable.zatcaEnv,
      status: gatewayClientsTable.status,
      monthlyQuota: gatewayClientsTable.monthlyQuota,
      invoicesThisMonth: gatewayClientsTable.invoicesThisMonth,
      totalInvoices: gatewayClientsTable.totalInvoices,
      lastInvoiceAt: gatewayClientsTable.lastInvoiceAt,
      createdAt: gatewayClientsTable.createdAt,
      hasCredentials: sql<boolean>`(${gatewayClientsTable.zatcaCsidEnc} IS NOT NULL AND ${gatewayClientsTable.zatcaPrivateKeyEnc} IS NOT NULL)`,
      activeKeys: sql<number>`(SELECT COUNT(*)::int FROM ${gatewayApiKeysTable} k WHERE k.client_id = ${gatewayClientsTable.id} AND k.revoked_at IS NULL)`,
    })
    .from(gatewayClientsTable)
    .orderBy(desc(gatewayClientsTable.createdAt));
  res.json({ clients: rows });
});

// ─── Get single client ─────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const [row] = await db.select().from(gatewayClientsTable).where(eq(gatewayClientsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "العميل غير موجود" }); return; }
  // Never leak encrypted credentials in responses
  const { zatcaCsidEnc, zatcaPcsidEnc, zatcaPrivateKeyEnc, ...safe } = row;
  res.json({
    client: {
      ...safe,
      hasCsid: !!zatcaCsidEnc,
      hasPcsid: !!zatcaPcsidEnc,
      hasPrivateKey: !!zatcaPrivateKeyEnc,
    },
  });
});

// ─── Create client ─────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const { nameAr, nameEn, vatNumber, crNumber, contactEmail, contactPhone, addressAr, city, zatcaEnv, monthlyQuota, notes } = req.body ?? {};
  if (!nameAr || typeof nameAr !== "string") { res.status(400).json({ error: "اسم الشركة بالعربية مطلوب" }); return; }
  if (!vatNumber || typeof vatNumber !== "string" || !/^\d{15}$/.test(vatNumber)) {
    res.status(400).json({ error: "الرقم الضريبي يجب أن يكون 15 رقماً" });
    return;
  }

  // Uniqueness check (friendly error vs. raw 23505)
  const existing = await db.select({ id: gatewayClientsTable.id }).from(gatewayClientsTable)
    .where(eq(gatewayClientsTable.vatNumber, vatNumber)).limit(1);
  if (existing.length > 0) { res.status(409).json({ error: "يوجد عميل مسجل بنفس الرقم الضريبي" }); return; }

  const [created] = await db.insert(gatewayClientsTable).values({
    nameAr,
    nameEn: nameEn ?? null,
    vatNumber,
    crNumber: crNumber ?? null,
    contactEmail: contactEmail ?? null,
    contactPhone: contactPhone ?? null,
    addressAr: addressAr ?? null,
    city: city ?? null,
    zatcaEnv: zatcaEnv === "production" ? "production" : "sandbox",
    monthlyQuota: Number.isFinite(Number(monthlyQuota)) ? Number(monthlyQuota) : 1000,
    notes: notes ?? null,
    status: "pending",
  }).returning();

  void writeAudit({
    userId: req.authUser!.id, username: req.authUser!.username, role: req.authUser!.role, companyId: null,
    module: "gateway_clients", action: "create",
    method: req.method, path: req.originalUrl, statusCode: 201,
    metadata: { clientId: created.id, vatNumber },
  });

  res.status(201).json({ client: created });
});

// ─── Update client ─────────────────────────────────────────────────────
router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const allowed = ["nameAr","nameEn","crNumber","contactEmail","contactPhone","addressAr","city","zatcaEnv","status","monthlyQuota","notes"] as const;
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in (req.body ?? {})) patch[k] = (req.body as Record<string, unknown>)[k];
  if (Object.keys(patch).length === 0) { res.status(400).json({ error: "لا يوجد تغييرات" }); return; }
  patch["updatedAt"] = new Date();

  const [updated] = await db.update(gatewayClientsTable).set(patch).where(eq(gatewayClientsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "العميل غير موجود" }); return; }

  void writeAudit({
    userId: req.authUser!.id, username: req.authUser!.username, role: req.authUser!.role, companyId: null,
    module: "gateway_clients", action: "edit",
    method: req.method, path: req.originalUrl, statusCode: 200,
    metadata: { clientId: id, fields: Object.keys(patch) },
  });

  res.json({ ok: true });
});

// ─── Set ZATCA credentials (encrypted at rest using SESSION_SECRET) ───
// NOTE: For an MVP we wrap with AES-256-GCM keyed off SESSION_SECRET.
// In production, swap to a managed KMS (AWS KMS, GCP KMS, HashiCorp Vault).
import { createCipheriv, createDecipheriv, scryptSync } from "crypto";
function getKek(): Buffer {
  const secret = process.env.SESSION_SECRET || "dev-secret-change-me";
  return scryptSync(secret, "gateway-kek-v1", 32);
}
function encryptValue(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKek(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}
export function decryptValue(blob: string): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid ciphertext");
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const enc = Buffer.from(parts[3], "base64");
  const decipher = createDecipheriv("aes-256-gcm", getKek(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

router.post("/:id/credentials", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const { csid, pcsid, privateKey } = req.body ?? {};
  if (!csid && !pcsid && !privateKey) { res.status(400).json({ error: "أدخل أحد الحقول على الأقل" }); return; }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof csid === "string" && csid.trim()) patch["zatcaCsidEnc"] = encryptValue(csid.trim());
  if (typeof pcsid === "string" && pcsid.trim()) patch["zatcaPcsidEnc"] = encryptValue(pcsid.trim());
  if (typeof privateKey === "string" && privateKey.trim()) patch["zatcaPrivateKeyEnc"] = encryptValue(privateKey.trim());

  const [updated] = await db.update(gatewayClientsTable).set(patch).where(eq(gatewayClientsTable.id, id)).returning({ id: gatewayClientsTable.id });
  if (!updated) { res.status(404).json({ error: "العميل غير موجود" }); return; }

  void writeAudit({
    userId: req.authUser!.id, username: req.authUser!.username, role: req.authUser!.role, companyId: null,
    module: "gateway_clients", action: "edit",
    method: req.method, path: req.originalUrl, statusCode: 200,
    metadata: { clientId: id, credentialsUpdated: Object.keys(patch).filter(k => k !== "updatedAt") },
  });

  res.json({ ok: true });
});

// ─── Delete client ─────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const [deleted] = await db.delete(gatewayClientsTable).where(eq(gatewayClientsTable.id, id)).returning({ id: gatewayClientsTable.id });
  if (!deleted) { res.status(404).json({ error: "العميل غير موجود" }); return; }
  void writeAudit({
    userId: req.authUser!.id, username: req.authUser!.username, role: req.authUser!.role, companyId: null,
    module: "gateway_clients", action: "delete",
    method: req.method, path: req.originalUrl, statusCode: 200,
    metadata: { clientId: id },
  });
  res.json({ ok: true });
});

// ─── List API keys for a client ────────────────────────────────────────
router.get("/:id/api-keys", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const rows = await db.select({
    id: gatewayApiKeysTable.id,
    label: gatewayApiKeysTable.label,
    keyPrefix: gatewayApiKeysTable.keyPrefix,
    scope: gatewayApiKeysTable.scope,
    createdAt: gatewayApiKeysTable.createdAt,
    lastUsedAt: gatewayApiKeysTable.lastUsedAt,
    lastUsedIp: gatewayApiKeysTable.lastUsedIp,
    revokedAt: gatewayApiKeysTable.revokedAt,
    expiresAt: gatewayApiKeysTable.expiresAt,
  }).from(gatewayApiKeysTable)
    .where(eq(gatewayApiKeysTable.clientId, id))
    .orderBy(desc(gatewayApiKeysTable.createdAt));
  res.json({ keys: rows });
});

// ─── Generate a new API key (returned ONCE in plaintext) ──────────────
router.post("/:id/api-keys", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const { label, scope, expiresAt } = req.body ?? {};
  if (!label || typeof label !== "string") { res.status(400).json({ error: "تسمية المفتاح مطلوبة" }); return; }

  // Verify client exists
  const [client] = await db.select({ id: gatewayClientsTable.id }).from(gatewayClientsTable).where(eq(gatewayClientsTable.id, id)).limit(1);
  if (!client) { res.status(404).json({ error: "العميل غير موجود" }); return; }

  const raw = randomBytes(32).toString("base64url");
  const token = `zgw_${raw}`;
  const keyHash = createHash("sha256").update(token).digest("hex");
  const keyPrefix = token.slice(0, 12); // safe to display

  const [created] = await db.insert(gatewayApiKeysTable).values({
    clientId: id,
    label,
    keyHash,
    keyPrefix,
    scope: typeof scope === "string" ? scope : "invoice_submit",
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  }).returning({
    id: gatewayApiKeysTable.id,
    label: gatewayApiKeysTable.label,
    keyPrefix: gatewayApiKeysTable.keyPrefix,
    scope: gatewayApiKeysTable.scope,
    createdAt: gatewayApiKeysTable.createdAt,
  });

  void writeAudit({
    userId: req.authUser!.id, username: req.authUser!.username, role: req.authUser!.role, companyId: null,
    module: "gateway_clients", action: "create",
    method: req.method, path: req.originalUrl, statusCode: 201,
    metadata: { clientId: id, apiKeyId: created.id, label },
  });

  // Token returned exactly once — UI must instruct user to copy it.
  res.status(201).json({ key: created, token });
});

// ─── Revoke API key ────────────────────────────────────────────────────
router.delete("/:id/api-keys/:keyId", async (req, res) => {
  const clientId = Number(req.params.id);
  const keyId = Number(req.params.keyId);
  if (!Number.isFinite(clientId) || !Number.isFinite(keyId)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const [updated] = await db.update(gatewayApiKeysTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(gatewayApiKeysTable.id, keyId), eq(gatewayApiKeysTable.clientId, clientId), isNull(gatewayApiKeysTable.revokedAt)))
    .returning({ id: gatewayApiKeysTable.id });
  if (!updated) { res.status(404).json({ error: "المفتاح غير موجود أو ملغى مسبقاً" }); return; }
  void writeAudit({
    userId: req.authUser!.id, username: req.authUser!.username, role: req.authUser!.role, companyId: null,
    module: "gateway_clients", action: "delete",
    method: req.method, path: req.originalUrl, statusCode: 200,
    metadata: { clientId, apiKeyId: keyId },
  });
  res.json({ ok: true });
});

// ─── List uploaded invoices for a client ──────────────────────────────
router.get("/:id/invoices", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await db.select().from(gatewayInvoicesTable)
    .where(eq(gatewayInvoicesTable.clientId, id))
    .orderBy(desc(gatewayInvoicesTable.receivedAt))
    .limit(limit);
  res.json({ invoices: rows });
});

// ─── Aggregate stats for the SuperAdmin dashboard card ────────────────
router.get("/stats/overview", async (_req, res) => {
  const [stats] = await db.select({
    totalClients: sql<number>`COUNT(*)::int`,
    activeClients: sql<number>`COUNT(*) FILTER (WHERE ${gatewayClientsTable.status} = 'active')::int`,
    pendingClients: sql<number>`COUNT(*) FILTER (WHERE ${gatewayClientsTable.status} = 'pending')::int`,
    suspendedClients: sql<number>`COUNT(*) FILTER (WHERE ${gatewayClientsTable.status} = 'suspended')::int`,
    productionClients: sql<number>`COUNT(*) FILTER (WHERE ${gatewayClientsTable.zatcaEnv} = 'production')::int`,
  }).from(gatewayClientsTable);

  const [inv] = await db.select({
    totalInvoices: sql<number>`COUNT(*)::int`,
    cleared: sql<number>`COUNT(*) FILTER (WHERE ${gatewayInvoicesTable.status} = 'cleared')::int`,
    rejected: sql<number>`COUNT(*) FILTER (WHERE ${gatewayInvoicesTable.status} = 'rejected')::int`,
    received: sql<number>`COUNT(*) FILTER (WHERE ${gatewayInvoicesTable.status} = 'received')::int`,
  }).from(gatewayInvoicesTable);

  res.json({ ...stats, ...inv });
});

export default router;
