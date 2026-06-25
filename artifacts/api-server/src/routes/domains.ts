// SuperAdmin — Multi-Domain Management. List / create / update / delete the
// company ↔ domain mappings that power host-based company resolution
// (see middleware/domainResolver.ts + auth.ts resolveCompanyId), plus a
// read-only "فحص النطاق" check (DNS / SSL / reachability).
//
// Direct fetch + Bearer convention (mirrors admin-download-codes.ts), guarded
// by an explicit superadmin role check — the companies router does NOT enforce
// role by itself.

import { Router } from "express";
import { db } from "@workspace/db";
import { companyDomainsTable, companiesTable } from "@workspace/db";
import { eq, and, desc, ne } from "drizzle-orm";
import { z } from "zod/v4";
import { extractAuth } from "../middleware/auth.js";
import { clearDomainCache, normalizeHost } from "../middleware/domainResolver.js";
import dns from "node:dns";
import tls from "node:tls";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if ((req as any).authUser?.role !== "superadmin") {
    res.status(403).json({ error: "هذه الصفحة للمشرف العام فقط" }); return;
  }
  next();
});

// GET /api/admin/domains — list with the bound company's name + code.
router.get("/", async (_req, res) => {
  const rows = await db.select({
    id: companyDomainsTable.id,
    domain: companyDomainsTable.domain,
    companyId: companyDomainsTable.companyId,
    companyName: companiesTable.nameAr,
    companyCode: companiesTable.code,
    isPrimary: companyDomainsTable.isPrimary,
    isMain: companyDomainsTable.isMain,
    status: companyDomainsTable.status,
    activatedAt: companyDomainsTable.activatedAt,
    lastCheckAt: companyDomainsTable.lastCheckAt,
    lastCheckResult: companyDomainsTable.lastCheckResult,
    notes: companyDomainsTable.notes,
    createdAt: companyDomainsTable.createdAt,
  })
    .from(companyDomainsTable)
    .leftJoin(companiesTable, eq(companiesTable.id, companyDomainsTable.companyId))
    .orderBy(desc(companyDomainsTable.id)).limit(1000);
  res.json(rows);
});

const STATUS = ["pending", "active", "disabled"] as const;

const createSchema = z.object({
  domain: z.string().min(3).max(255),
  companyId: z.number().int().positive().optional(),
  isMain: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
  status: z.enum(STATUS).optional(),
  notes: z.string().max(1000).optional(),
});

// If this domain is marked primary, demote any other primary for the company.
async function demoteOtherPrimaries(companyId: number, exceptId?: number): Promise<void> {
  const cond = exceptId
    ? and(eq(companyDomainsTable.companyId, companyId), ne(companyDomainsTable.id, exceptId))
    : eq(companyDomainsTable.companyId, companyId);
  await db.update(companyDomainsTable).set({ isPrimary: false, updatedAt: new Date() }).where(cond);
}

// At most one shared "main" multi-company domain — demote any other main when a
// new one is set.
async function demoteOtherMains(exceptId?: number): Promise<void> {
  const cond = exceptId
    ? and(eq(companyDomainsTable.isMain, true), ne(companyDomainsTable.id, exceptId))
    : eq(companyDomainsTable.isMain, true);
  await db.update(companyDomainsTable).set({ isMain: false, updatedAt: new Date() }).where(cond);
}

// POST /api/admin/domains — map a new domain to a company.
router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const userId = (req as any).authUser?.id ?? null;
  const domain = normalizeHost(parsed.data.domain);
  if (!domain) { res.status(400).json({ error: "نطاق غير صالح" }); return; }

  const isMain = parsed.data.isMain ?? false;
  // A "main" domain is the shared multi-company domain — it has NO bound company
  // (keeps the default multi-company behavior). A regular mapping REQUIRES a
  // company. These two are mutually exclusive.
  const companyId = isMain ? null : (parsed.data.companyId ?? null);
  if (!isMain && companyId == null) {
    res.status(400).json({ error: "اختر الشركة أو علّم النطاق كنطاق رئيسي" }); return;
  }

  if (companyId != null) {
    // Company must exist (and not be soft-deleted).
    const [co] = await db.select({ id: companiesTable.id })
      .from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!co) { res.status(400).json({ error: "الشركة غير موجودة" }); return; }
  }

  const [dupe] = await db.select({ id: companyDomainsTable.id })
    .from(companyDomainsTable).where(eq(companyDomainsTable.domain, domain));
  if (dupe) { res.status(409).json({ error: "هذا النطاق مُسجّل بالفعل" }); return; }

  const status = parsed.data.status ?? "pending";
  const isPrimary = isMain ? false : (parsed.data.isPrimary ?? false);
  if (isMain) await demoteOtherMains();
  if (isPrimary && companyId != null) await demoteOtherPrimaries(companyId);

  const [created] = await db.insert(companyDomainsTable).values({
    domain,
    companyId,
    isMain,
    isPrimary,
    status,
    activatedAt: status === "active" ? new Date() : null,
    notes: parsed.data.notes ?? null,
    createdByUserId: userId,
  }).returning();
  clearDomainCache();
  res.status(201).json(created);
});

const patchSchema = z.object({
  domain: z.string().min(3).max(255).optional(),
  companyId: z.number().int().positive().nullable().optional(),
  isMain: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
  status: z.enum(STATUS).optional(),
  notes: z.string().max(1000).optional(),
});

// PATCH /api/admin/domains/:id — edit mapping / status / primary flag.
router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "invalid id" }); return; }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const b = parsed.data;

  const [existing] = await db.select().from(companyDomainsTable).where(eq(companyDomainsTable.id, id));
  if (!existing) { res.status(404).json({ error: "not found" }); return; }

  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (b.domain !== undefined) {
    const domain = normalizeHost(b.domain);
    if (!domain) { res.status(400).json({ error: "نطاق غير صالح" }); return; }
    if (domain !== existing.domain) {
      const [dupe] = await db.select({ id: companyDomainsTable.id })
        .from(companyDomainsTable).where(eq(companyDomainsTable.domain, domain));
      if (dupe) { res.status(409).json({ error: "هذا النطاق مُسجّل بالفعل" }); return; }
    }
    patch.domain = domain;
  }

  // The effective "main" flag after this patch (defaults to the current value).
  const willBeMain = b.isMain !== undefined ? b.isMain : existing.isMain;

  let targetCompanyId: number | null = existing.companyId;
  if (b.companyId !== undefined && b.companyId !== existing.companyId) {
    if (b.companyId != null) {
      const [co] = await db.select({ id: companiesTable.id })
        .from(companiesTable).where(eq(companiesTable.id, b.companyId));
      if (!co) { res.status(400).json({ error: "الشركة غير موجودة" }); return; }
    }
    patch.companyId = b.companyId;
    targetCompanyId = b.companyId;
  }

  if (b.isMain !== undefined) {
    patch.isMain = b.isMain;
    if (b.isMain) {
      // A main domain has no bound company and cannot also be a per-company primary.
      patch.companyId = null;
      targetCompanyId = null;
      patch.isPrimary = false;
      await demoteOtherMains(id);
    }
  }

  // A non-main domain MUST keep a bound company.
  if (!willBeMain && targetCompanyId == null) {
    res.status(400).json({ error: "اختر الشركة أو علّم النطاق كنطاق رئيسي" }); return;
  }

  if (b.notes !== undefined) patch.notes = b.notes;

  if (b.status !== undefined) {
    patch.status = b.status;
    // Stamp activation the first time it goes active; keep it once set.
    if (b.status === "active" && !existing.activatedAt) patch.activatedAt = new Date();
  }

  if (b.isPrimary !== undefined && !willBeMain) {
    patch.isPrimary = b.isPrimary;
    if (b.isPrimary && targetCompanyId != null) await demoteOtherPrimaries(targetCompanyId, id);
  }

  const [updated] = await db.update(companyDomainsTable).set(patch)
    .where(eq(companyDomainsTable.id, id)).returning();
  clearDomainCache();
  res.json(updated);
});

// DELETE /api/admin/domains/:id — remove the mapping.
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "invalid id" }); return; }
  await db.delete(companyDomainsTable).where(eq(companyDomainsTable.id, id));
  clearDomainCache();
  res.json({ ok: true });
});

// ─── Read-only domain check (DNS / SSL / reachability). Best-effort: every
// probe is wrapped so the endpoint always returns 200 with a result object,
// never throws. Results are persisted on the row for the UI's "last check".

interface DnsResult { ok: boolean; addresses?: string[]; error?: string }
interface SslResult { ok: boolean; validFrom?: string; validTo?: string; daysRemaining?: number; issuer?: string; error?: string }

function checkDns(host: string): Promise<DnsResult> {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) { resolve({ ok: false, error: err.code || err.message }); return; }
      const list = Array.isArray(addrs) ? addrs.map((a) => a.address) : [];
      resolve({ ok: list.length > 0, addresses: list });
    });
  });
}

function checkSsl(host: string, timeoutMs = 6000): Promise<SslResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: SslResult) => { if (!settled) { settled = true; try { socket.destroy(); } catch { /* noop */ } resolve(r); } };
    const socket = tls.connect(
      { host, port: 443, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          if (!cert || Object.keys(cert).length === 0) { done({ ok: false, error: "no certificate" }); return; }
          const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
          const daysRemaining = validTo ? Math.round((validTo.getTime() - Date.now()) / 86_400_000) : undefined;
          const rawIssuer = cert.issuer && (cert.issuer.O || cert.issuer.CN);
          const issuer = Array.isArray(rawIssuer) ? rawIssuer[0] : (rawIssuer || undefined);
          done({
            ok: socket.authorized || !!cert.valid_to,
            validFrom: cert.valid_from,
            validTo: cert.valid_to,
            daysRemaining,
            issuer,
          });
        } catch (e: any) {
          done({ ok: false, error: e?.message || "ssl error" });
        }
      },
    );
    socket.on("error", (e: any) => done({ ok: false, error: e?.code || e?.message || "ssl error" }));
    socket.on("timeout", () => done({ ok: false, error: "timeout" }));
  });
}

// POST /api/admin/domains/:id/check — run live probes + persist results.
router.post("/:id/check", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "invalid id" }); return; }
  const [row] = await db.select().from(companyDomainsTable).where(eq(companyDomainsTable.id, id));
  if (!row) { res.status(404).json({ error: "not found" }); return; }

  const host = normalizeHost(row.domain) || row.domain;
  const [dnsRes, sslRes] = await Promise.all([checkDns(host), checkSsl(host)]);
  // Reachability = DNS resolves AND the TLS handshake produced a certificate.
  const reachable = dnsRes.ok && sslRes.ok;
  const result = { checkedAt: new Date().toISOString(), dns: dnsRes, ssl: sslRes, reachable };

  await db.update(companyDomainsTable)
    .set({ lastCheckAt: new Date(), lastCheckResult: result, updatedAt: new Date() })
    .where(eq(companyDomainsTable.id, id));
  res.json(result);
});

export default router;
