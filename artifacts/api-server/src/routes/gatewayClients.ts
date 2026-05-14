import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { gatewayClientsTable, gatewayApiKeysTable, gatewayInvoicesTable } from "@workspace/db";
import { eq, and, desc, sql, isNull } from "drizzle-orm";
import { randomBytes, createHash } from "crypto";
import { writeAudit } from "../middleware/permissions.js";
import { extractAuth } from "../middleware/auth.js";

const router = Router();

// extractAuth populates req.authUser from the Bearer token (legacy
// users.sessionToken OR SuperAdmin multi-session token). Without it,
// req.authUser would always be undefined and every endpoint here would
// 401 — matching the pattern used by zatca.ts, hr-settings.ts, etc.
router.use(extractAuth);

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
const VALID_ENV = new Set(["production", "sandbox"]);
const VALID_STATUS = new Set(["pending", "active", "suspended"]);
const VALID_SCOPE = new Set(["invoice_submit", "invoice_read", "full"]);

router.post("/", async (req, res) => {
  const { nameAr, nameEn, vatNumber, crNumber, contactEmail, contactPhone, addressAr, city, zatcaEnv, monthlyQuota, notes } = req.body ?? {};
  if (!nameAr || typeof nameAr !== "string") { res.status(400).json({ error: "اسم الشركة بالعربية مطلوب" }); return; }
  if (!vatNumber || typeof vatNumber !== "string" || !/^\d{15}$/.test(vatNumber)) {
    res.status(400).json({ error: "الرقم الضريبي يجب أن يكون 15 رقماً" });
    return;
  }
  if (zatcaEnv != null && !VALID_ENV.has(String(zatcaEnv))) { res.status(400).json({ error: "بيئة زاتكا غير صالحة" }); return; }
  const quotaNum = Number(monthlyQuota);
  if (monthlyQuota != null && (!Number.isFinite(quotaNum) || quotaNum < 0 || quotaNum > 1_000_000)) {
    res.status(400).json({ error: "الحصة الشهرية يجب أن تكون رقماً موجباً" });
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
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];
  if (Object.keys(patch).length === 0) { res.status(400).json({ error: "لا يوجد تغييرات" }); return; }
  // Validate enums + numeric bounds
  if ("zatcaEnv" in patch && !VALID_ENV.has(String(patch["zatcaEnv"]))) { res.status(400).json({ error: "بيئة زاتكا غير صالحة" }); return; }
  if ("status" in patch && !VALID_STATUS.has(String(patch["status"]))) { res.status(400).json({ error: "الحالة غير صالحة" }); return; }
  if ("monthlyQuota" in patch) {
    const q = Number(patch["monthlyQuota"]);
    if (!Number.isFinite(q) || q < 0 || q > 1_000_000) { res.status(400).json({ error: "الحصة الشهرية غير صالحة" }); return; }
    patch["monthlyQuota"] = q;
  }
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
  // FAIL FAST — never silently fall back to a hardcoded secret. Encrypted
  // ZATCA private keys are sensitive enough that operating without a
  // configured SESSION_SECRET is a deployment error, not a soft warning.
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET must be set (≥16 chars) to encrypt gateway credentials");
  }
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
  if (!label || typeof label !== "string" || label.length > 100) { res.status(400).json({ error: "تسمية المفتاح مطلوبة (≤100 حرف)" }); return; }
  if (scope != null && !VALID_SCOPE.has(String(scope))) { res.status(400).json({ error: "نطاق المفتاح غير صالح" }); return; }
  let expiresAtDate: Date | null = null;
  if (expiresAt) {
    expiresAtDate = new Date(expiresAt);
    if (Number.isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() < Date.now()) {
      res.status(400).json({ error: "تاريخ الانتهاء غير صالح أو في الماضي" });
      return;
    }
  }

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
    expiresAt: expiresAtDate,
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
