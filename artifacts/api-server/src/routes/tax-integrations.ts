import { Router } from "express";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  db, companiesTable, taxIntegrationSetupsTable, taxIntegrationAuditTable,
} from "@workspace/db";
import { extractAuth } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

const PROVIDERS = {
  EG: { provider: "egypt_eta", module: "egypt_tax", keys: ["taxpayerId", "clientId", "clientSecret", "signingCertificate", "signingPrivateKey"] },
  JO: { provider: "jordan_national", module: "jordan_tax", keys: ["taxNumber", "userNumber", "secretKey"] },
} as const;
const MAX_FIELD = 256 * 1024;

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for tax credential storage");
  return createHash("sha256").update(secret, "utf8").digest();
}

function encryptCredentials(value: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(part => part.toString("base64url")).join(".");
}

function companyContext(req: any, company: any, res: any): typeof PROVIDERS[keyof typeof PROVIDERS] | null {
  const country = company?.country as keyof typeof PROVIDERS;
  const cfg = PROVIDERS[country];
  if (!req.authUser?.companyId || req.authUser.companyId !== company.id || !cfg) {
    res.status(403).json({ error: "هذه الوحدة غير متاحة لدولة الشركة" });
    return null;
  }
  if (req.authUser.role !== "superadmin") {
    let permissions: Record<string, unknown> = {};
    try { permissions = JSON.parse(company.menuPermissions ?? "{}"); } catch { permissions = {}; }
    if (permissions[cfg.module] !== true) {
      res.status(403).json({ error: "وحدة التكامل الضريبي غير مفعلة لهذه الشركة" });
      return null;
    }
  }
  return cfg;
}

async function context(req: any, res: any) {
  if (!req.authUser) {
    res.status(401).json({ error: "غير مصرح" }); return null;
  }
  if (req.authUser.role !== "admin") {
    res.status(403).json({ error: "هذه الإعدادات متاحة لمدير الشركة فقط" }); return null;
  }
  const companyId = Number(req.authUser?.companyId);
  if (!Number.isInteger(companyId) || companyId < 1) {
    res.status(401).json({ error: "غير مصرح" }); return null;
  }
  const [company] = await db.select({
    id: companiesTable.id, country: companiesTable.country, menuPermissions: companiesTable.menuPermissions,
  }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  if (!company) { res.status(403).json({ error: "الشركة غير موجودة" }); return null; }
  const cfg = companyContext(req, company, res);
  return cfg ? { company, cfg } : null;
}

router.get("/setup", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  const [row] = await db.select({
    environment: taxIntegrationSetupsTable.environment,
    status: taxIntegrationSetupsTable.status,
    updatedAt: taxIntegrationSetupsTable.updatedAt,
  }).from(taxIntegrationSetupsTable).where(and(
    eq(taxIntegrationSetupsTable.companyId, c.company.id),
    eq(taxIntegrationSetupsTable.provider, c.cfg.provider),
  )).limit(1);
  res.json({
    country: c.company.country, provider: c.cfg.provider,
    environment: row?.environment ?? null,
    hasCredentials: !!row,
    setupStatus: row?.status ?? "not_configured",
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  });
});

router.put("/setup", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  const user = req.authUser;
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  const { environment, credentials } = req.body ?? {};
  if (environment !== "sandbox" && environment !== "production") {
    res.status(400).json({ error: "بيئة التكامل غير صحيحة" }); return;
  }
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    res.status(400).json({ error: "بيانات الاعتماد غير صحيحة" }); return;
  }
  const keys = Object.keys(credentials);
  if (keys.length !== c.cfg.keys.length || c.cfg.keys.some(key => !keys.includes(key))) {
    res.status(400).json({ error: "بيانات الاعتماد المطلوبة غير مكتملة" }); return;
  }
  const clean: Record<string, string> = {};
  for (const key of c.cfg.keys) {
    const value = credentials[key];
    if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_FIELD) {
      res.status(400).json({ error: "إحدى بيانات الاعتماد غير صالحة" }); return;
    }
    clean[key] = value;
  }
  const now = new Date();
  const encrypted = encryptCredentials(clean);
  await db.insert(taxIntegrationSetupsTable).values({
    companyId: c.company.id, country: c.company.country, provider: c.cfg.provider,
    environment, credentialsEnc: encrypted, status: "configured_unverified",
    updatedBy: user.id, updatedAt: now,
  }).onConflictDoUpdate({
    target: [taxIntegrationSetupsTable.companyId, taxIntegrationSetupsTable.provider],
    set: { country: c.company.country, environment, credentialsEnc: encrypted, status: "configured_unverified", updatedBy: user.id, updatedAt: now },
  });
  await db.insert(taxIntegrationAuditTable).values({
    companyId: c.company.id, userId: user.id, provider: c.cfg.provider,
    action: "credentials_replaced", environment, metadata: { fieldCount: keys.length },
  });
  res.json({ country: c.company.country, provider: c.cfg.provider, environment, hasCredentials: true, setupStatus: "configured_unverified", updatedAt: now.toISOString() });
});

router.get("/logs", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  const rows = await db.select({
    id: taxIntegrationAuditTable.id, provider: taxIntegrationAuditTable.provider,
    action: taxIntegrationAuditTable.action, environment: taxIntegrationAuditTable.environment,
    metadata: taxIntegrationAuditTable.metadata, createdAt: taxIntegrationAuditTable.createdAt,
  }).from(taxIntegrationAuditTable).where(and(
    eq(taxIntegrationAuditTable.companyId, c.company.id),
    eq(taxIntegrationAuditTable.provider, c.cfg.provider),
  ))
    .orderBy(desc(taxIntegrationAuditTable.createdAt)).limit(100);
  res.json(rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })));
});

export default router;