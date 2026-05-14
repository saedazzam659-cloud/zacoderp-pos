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

  // CSR-wizard alignment: if the user pasted a CSID without an explicit
  // private key, promote the CSR-generated key (csr_private_key_enc) to
  // be the active signing key so production submit-batch passes the
  // hasFullCreds check.
  if (patch["zatcaCsidEnc"] && !patch["zatcaPrivateKeyEnc"]) {
    const [existing] = await db.select({
      hasZatcaPK: sql<boolean>`${gatewayClientsTable.zatcaPrivateKeyEnc} IS NOT NULL`,
      csrPK: gatewayClientsTable.csrPrivateKeyEnc,
    }).from(gatewayClientsTable).where(eq(gatewayClientsTable.id, id)).limit(1);
    if (existing && !existing.hasZatcaPK && existing.csrPK) {
      patch["zatcaPrivateKeyEnc"] = existing.csrPK;
    }
  }

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

// ─── Generate CSR + private key for ZATCA onboarding (Option B) ──────
// Wizard step 1: produce a CSR the SuperAdmin downloads and uploads to
// ZATCA's Fatoora portal (or to ZATCA's compliance API in a later phase).
// We persist the public CSR so it can be re-downloaded any time, plus the
// matching private key encrypted at rest. Once ZATCA returns the CSID,
// the existing /credentials endpoint stores it next to the same key.
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

router.post("/:id/generate-csr", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const [client] = await db.select().from(gatewayClientsTable).where(eq(gatewayClientsTable.id, id)).limit(1);
  if (!client) { res.status(404).json({ error: "العميل غير موجود" }); return; }
  const { commonName, organizationName, organizationalUnit, countryCode, invoiceType, locationAddress, businessCategory, egsSerial: egsIn } = req.body ?? {};
  const cn = (typeof commonName === "string" && commonName.trim()) || `${client.nameEn || client.nameAr}-EGS`;
  const org = (typeof organizationName === "string" && organizationName.trim()) || (client.nameEn || client.nameAr);
  const ou = (typeof organizationalUnit === "string" && organizationalUnit.trim()) || "Main Branch";
  const cc = (typeof countryCode === "string" && countryCode.length === 2) ? countryCode.toUpperCase() : "SA";
  const invType = (typeof invoiceType === "string" && /^[01]{4}$/.test(invoiceType)) ? invoiceType : "1100"; // standard+simplified
  const loc = (typeof locationAddress === "string" && locationAddress.trim()) || (client.addressAr || client.city || "Saudi Arabia");
  const cat = (typeof businessCategory === "string" && businessCategory.trim()) || "General";
  const serial = (typeof egsIn === "string" && egsIn.trim()) || `1-Solution|2-${id}|3-${randomBytes(6).toString("hex").toUpperCase()}`;

  const dir = mkdtempSync(join(tmpdir(), "zgw-csr-"));
  try {
    const cnf = join(dir, "csr.cnf");
    const keyFile = join(dir, "key.pem");
    const csrFile = join(dir, "req.pem");
    // ZATCA requires custom OIDs in the CSR (see Fatoora taxpayer portal docs).
    // The OID 1.3.6.1.4.1.311.20.2 = Microsoft template name (used by ZATCA
    // to flag the CSR profile: ZATCA-Code-Signing). The subjectAltName carries
    // EGS serial (DIR), invoice type (DIR), business category (DIR).
    writeFileSync(cnf, `
[ req ]
default_bits        = 2048
prompt              = no
default_md          = sha256
distinguished_name  = dn
req_extensions      = v3_req

[ dn ]
CN = ${cn}
O  = ${org}
OU = ${ou}
C  = ${cc}

[ v3_req ]
basicConstraints     = CA:FALSE
keyUsage             = digitalSignature, nonRepudiation, keyEncipherment
1.3.6.1.4.1.311.20.2 = ASN1:UTF8String:ZATCA-Code-Signing
subjectAltName       = dirName:alt_names

[ alt_names ]
SN = ${serial}
UID = ${client.vatNumber}
title = ${invType}
registeredAddress = ${loc}
businessCategory = ${cat}
`.trim() + "\n");

    execFileSync("openssl", ["genrsa", "-out", keyFile, "2048"], { stdio: "ignore" });
    execFileSync("openssl", ["req", "-new", "-key", keyFile, "-out", csrFile, "-config", cnf], { stdio: "ignore" });
    const csrPem = readFileSync(csrFile, "utf8").trim();
    const keyPem = readFileSync(keyFile, "utf8").trim();

    await db.update(gatewayClientsTable).set({
      csrPem,
      csrPrivateKeyEnc: encryptValue(keyPem),
      egsSerial: serial,
      updatedAt: new Date(),
    }).where(eq(gatewayClientsTable.id, id));

    void writeAudit({
      userId: req.authUser!.id, username: req.authUser!.username, role: req.authUser!.role, companyId: null,
      module: "gateway_clients", action: "create",
      method: req.method, path: req.originalUrl, statusCode: 200,
      metadata: { clientId: id, action: "generate_csr", egsSerial: serial },
    });

    res.json({ csrPem, egsSerial: serial });
  } catch (err) {
    req.log?.error({ err }, "CSR generation failed");
    res.status(500).json({ error: "فشل توليد طلب الشهادة (CSR)", detail: String((err as Error).message ?? err) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

router.get("/:id/csr", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const [c] = await db.select({ csrPem: gatewayClientsTable.csrPem, egsSerial: gatewayClientsTable.egsSerial })
    .from(gatewayClientsTable).where(eq(gatewayClientsTable.id, id)).limit(1);
  if (!c?.csrPem) { res.status(404).json({ error: "لم يتم توليد CSR لهذا العميل بعد" }); return; }
  res.json({ csrPem: c.csrPem, egsSerial: c.egsSerial });
});

// ─── Submit a validated invoice batch from the scan-preview UI ────────
// Each row is normalized into a canonical JSON payload, the ICV/PIH chain
// is advanced, and the result is persisted to gateway_invoices. For the
// first phase we DO NOT yet POST the signed UBL to ZATCA's HTTP endpoint
// — that requires per-tenant UBL building + xades signing which lives in
// the existing zatca.ts pipeline and will be wired in Phase 1B. Status is
// set to 'queued_for_zatca' (production env) or 'sandbox_cleared'
// (sandbox env) so the UI can show progress honestly.
import { createHash as createHashSubmit } from "crypto";
router.post("/:id/submit-batch", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const rows = req.body?.rows;
  const fileName = typeof req.body?.fileName === "string" ? req.body.fileName : null;
  if (!Array.isArray(rows) || rows.length === 0) { res.status(400).json({ error: "لا توجد فواتير للإرسال" }); return; }
  if (rows.length > 5000) { res.status(400).json({ error: "الحد الأقصى 5000 فاتورة في الدفعة الواحدة" }); return; }

  // Atomic transaction: SELECT ... FOR UPDATE locks the client row so
  // concurrent submit-batch calls for the same tenant cannot race on
  // ICV/PIH chain progression or quota counters.
  type ErrOut = { kind: "err"; status: number; body: { error: string } };
  type OkOut = { kind: "ok"; submitted: number; rejected: number; env: string; results: Array<{ invoiceNumber: string; status: string; uuid?: string; icv?: number; error?: string }>; chain: { lastIcv: number; lastPih: string }; totalAmt: number; totalVat: number };

  const txResult: ErrOut | OkOut = await db.transaction(async (tx) => {
    const lockRes = await tx.execute(
      sql`SELECT * FROM ${gatewayClientsTable} WHERE ${gatewayClientsTable.id} = ${id} FOR UPDATE`
    );
    const lockedRows = ((lockRes as unknown as { rows?: unknown[] }).rows ?? (lockRes as unknown as unknown[])) as Array<typeof gatewayClientsTable.$inferSelect>;
    const client = lockedRows[0];

    if (!client) return { kind: "err", status: 404, body: { error: "العميل غير موجود" } } as ErrOut;
    if (client.status !== "active") return { kind: "err", status: 403, body: { error: "العميل غير مُفعَّل — يرجى تفعيله أولاً" } } as ErrOut;

    const hasFullCreds = !!(client.zatcaCsidEnc && client.zatcaPrivateKeyEnc);
    if (client.zatcaEnv === "production" && !hasFullCreds) {
      return { kind: "err", status: 400, body: { error: "ينقص CSID أو المفتاح الخاص — لا يمكن الإرسال للإنتاج بدونها" } } as ErrOut;
    }

    const remaining = client.monthlyQuota - client.invoicesThisMonth;
    if (remaining < rows.length) {
      return { kind: "err", status: 429, body: { error: `الحصة الشهرية المتبقية (${remaining}) أقل من عدد الفواتير (${rows.length})` } } as ErrOut;
    }

    let icv = client.lastIcv;
    let pih = client.lastInvoiceHash || "0".repeat(64);
    const results: Array<{ invoiceNumber: string; status: string; uuid?: string; icv?: number; error?: string }> = [];
    const insertRows: Array<typeof gatewayInvoicesTable.$inferInsert> = [];
    let totalAmt = 0; let totalVat = 0;

    for (const r of rows) {
    try {
      icv += 1;
      const invoiceNumber = String(r.invoiceNumber || "").trim();
      if (!invoiceNumber) throw new Error("رقم الفاتورة مفقود");
      const total = Number(r.totalInclVat) || 0;
      const vat = Number(r.vatAmount) || 0;
      const flow = (r.buyerVat && /^\d{15}$/.test(String(r.buyerVat))) ? "standard" : "simplified";
      const invType = String(r.invoiceType || "388");

      const canonical = {
        seller: { name: r.sellerName, vat: r.sellerVat },
        buyer:  { name: r.buyerName, vat: r.buyerVat || null },
        invoice: {
          number: invoiceNumber, type: invType, flow,
          issueDate: r.issueDate, issueTime: r.issueTime || "00:00:00",
          currency: r.currency || "SAR",
          icv, pih,
        },
        line: {
          item: r.itemName, qty: Number(r.quantity) || 0,
          unitPrice: Number(r.unitPrice) || 0,
          vatRate: Number(r.vatRate) || 0, vatCategory: r.vatCategory || "S",
          totalExclVat: Number(r.totalExclVat) || 0,
          vatAmount: vat, totalInclVat: total,
        },
        egs: { serial: client.egsSerial || null, vat: client.vatNumber },
      };
      // Hash the canonical payload (this becomes PIH for next invoice)
      const invoiceHash = createHashSubmit("sha256")
        .update(JSON.stringify(canonical))
        .digest("hex");

      // UUID v4-ish from hash
      const uuid = [
        invoiceHash.slice(0, 8), invoiceHash.slice(8, 12), "4" + invoiceHash.slice(13, 16),
        ((parseInt(invoiceHash[16], 16) & 0x3) | 0x8).toString(16) + invoiceHash.slice(17, 20),
        invoiceHash.slice(20, 32),
      ].join("-");

      const status = client.zatcaEnv === "sandbox" ? "sandbox_cleared" : "queued_for_zatca";

      insertRows.push({
        clientId: id,
        fileName,
        invoiceNumber,
        invoiceDate: r.issueDate ? new Date(r.issueDate) : null,
        totalAmount: String(total),
        vatAmount: String(vat),
        status,
        zatcaUuid: uuid,
        zatcaResponse: status === "sandbox_cleared"
          ? { mode: "sandbox", note: "ZATCA HTTP not called in Phase 1; chain + canonical payload validated" }
          : { mode: "production", note: "Queued — awaiting Phase 1B (real UBL build + ZATCA POST)" },
        icv, pih, invoiceHash,
        invoiceType: invType, invoiceFlow: flow,
        canonicalJson: canonical,
        ip: req.ip ?? null,
        processedAt: new Date(),
      });

      results.push({ invoiceNumber, status, uuid, icv });
      pih = invoiceHash;
      totalAmt += total; totalVat += vat;
      } catch (e) {
        results.push({ invoiceNumber: String(r.invoiceNumber || ""), status: "rejected", error: (e as Error).message });
        icv -= 1; // do not consume ICV on validation failure
      }
    }

    if (insertRows.length > 0) {
      await tx.insert(gatewayInvoicesTable).values(insertRows);
      await tx.update(gatewayClientsTable).set({
        lastIcv: icv,
        lastInvoiceHash: pih,
        invoicesThisMonth: client.invoicesThisMonth + insertRows.length,
        totalInvoices: client.totalInvoices + insertRows.length,
        lastInvoiceAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(gatewayClientsTable.id, id));
    }

    return {
      kind: "ok",
      submitted: insertRows.length,
      rejected: results.length - insertRows.length,
      env: client.zatcaEnv,
      results,
      chain: { lastIcv: icv, lastPih: pih },
      totalAmt, totalVat,
    } as OkOut;
  });

  if (txResult.kind === "err") { res.status(txResult.status).json(txResult.body); return; }

  void writeAudit({
    userId: req.authUser!.id, username: req.authUser!.username, role: req.authUser!.role, companyId: null,
    module: "gateway_clients", action: "create",
    method: req.method, path: req.originalUrl, statusCode: 200,
    metadata: { clientId: id, submitted: txResult.submitted, rejected: txResult.rejected, totalAmt: txResult.totalAmt, totalVat: txResult.totalVat, env: txResult.env },
  });

  res.json({
    submitted: txResult.submitted,
    rejected: txResult.rejected,
    env: txResult.env,
    results: txResult.results,
    chain: txResult.chain,
  });
});

// ─── Download canonical JSON for a single invoice ─────────────────────
router.get("/:id/invoices/:invId/canonical", async (req, res) => {
  const clientId = Number(req.params.id);
  const invId = Number(req.params.invId);
  if (!Number.isFinite(clientId) || !Number.isFinite(invId)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const [row] = await db.select().from(gatewayInvoicesTable)
    .where(and(eq(gatewayInvoicesTable.id, invId), eq(gatewayInvoicesTable.clientId, clientId)))
    .limit(1);
  if (!row) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
  res.json(row);
});

// ─── List clients available for invoice submission (used by scan UI) ─
// Lightweight endpoint: only id, name, env, hasCredentials, quota left.
router.get("/picker/list", async (_req, res) => {
  const rows = await db.select({
    id: gatewayClientsTable.id,
    nameAr: gatewayClientsTable.nameAr,
    nameEn: gatewayClientsTable.nameEn,
    vatNumber: gatewayClientsTable.vatNumber,
    zatcaEnv: gatewayClientsTable.zatcaEnv,
    status: gatewayClientsTable.status,
    monthlyQuota: gatewayClientsTable.monthlyQuota,
    invoicesThisMonth: gatewayClientsTable.invoicesThisMonth,
    lastIcv: gatewayClientsTable.lastIcv,
    hasCredentials: sql<boolean>`(${gatewayClientsTable.zatcaCsidEnc} IS NOT NULL AND ${gatewayClientsTable.zatcaPrivateKeyEnc} IS NOT NULL)`,
  })
    .from(gatewayClientsTable)
    .where(eq(gatewayClientsTable.status, "active"))
    .orderBy(gatewayClientsTable.nameAr);
  res.json({ clients: rows });
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
