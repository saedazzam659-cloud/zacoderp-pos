import { Router } from "express";
import { Readable } from "stream";
import { db } from "@workspace/db";
import {
  platformPartnersTable, partnerCompaniesTable, partnerCommissionsTable, partnerDocumentsTable,
  companiesTable, subscriptionsTable,
} from "@workspace/db";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import {
  requirePartner, requirePartnerPermission, partnerCompanyIds,
} from "../middleware/partner.js";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage.js";

// ─────────────────────────────────────────────────────────────────────────
// Developer / Partner self-service portal API (additive only).
//
// Mounted at /api/partner, BEFORE the path-less zatcaRouter so a partner bearer
// token (absent from usersTable) is never 401-ed by the global tenant-auth
// catch-all. Every authenticated endpoint is scoped to the calling partner's
// own record + linked companies — strict per-partner data isolation. Mirrors
// `routes/reseller.ts`.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();
const objectStorage = new ObjectStorageService();

function generateToken(): string {
  return randomUUID() + "-" + randomUUID();
}

// ─── Partner login (username + password) ─────────────────────────────────
router.post("/login", async (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!username || !password) { res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" }); return; }
  const [partner] = await db.select().from(platformPartnersTable).where(eq(platformPartnersTable.username, username));
  // Login requires provisioned credentials AND an active+approved account.
  if (!partner || !partner.isActive || !partner.passwordHash) {
    res.status(401).json({ error: "بيانات الدخول غير صحيحة" }); return;
  }
  const ok = await bcrypt.compare(password, partner.passwordHash);
  if (!ok) { res.status(401).json({ error: "بيانات الدخول غير صحيحة" }); return; }
  if (partner.status !== "approved") { res.status(403).json({ error: "حسابك قيد المراجعة أو موقوف — يرجى التواصل مع الإدارة" }); return; }

  const token = generateToken();
  const sessionId = randomUUID();
  await db.update(platformPartnersTable)
    .set({ sessionToken: token, sessionId, lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(platformPartnersTable.id, partner.id));

  res.json({
    token,
    user: {
      id: partner.id,
      username: partner.username,
      role: "partner",
      companyId: null,
      partnerId: partner.id,
      kind: partner.kind,
      nameAr: partner.nameAr,
      nameEn: partner.nameEn,
      code: partner.partnerCode,
      sessionId,
      permissions: partner.permissions ?? {},
    },
  });
});

// ─── Logout ──────────────────────────────────────────────────────────────
router.post("/logout", requirePartner, async (req, res) => {
  await db.update(platformPartnersTable).set({ sessionToken: null, sessionId: null }).where(eq(platformPartnersTable.id, req.partner!.id));
  res.json({ ok: true });
});

// All endpoints below require an authenticated partner.
router.use(requirePartner);

// ─── Profile ─────────────────────────────────────────────────────────────
router.get("/profile", async (req, res) => {
  const p = req.partner!;
  res.json({
    id: p.id, code: p.partnerCode, kind: p.kind,
    nameAr: p.nameAr, nameEn: p.nameEn,
    contactName: p.contactName, phone: p.phone, email: p.email,
    address: p.address, website: p.website,
    commissionRate: p.commissionRate, status: p.status,
    permissions: p.permissions ?? {},
  });
});

// ─── Dashboard summary ───────────────────────────────────────────────────
router.get("/dashboard", async (req, res) => {
  const p = req.partner!;
  const ids = await partnerCompanyIds(p.id);
  const now = new Date();
  const [commTotals] = await db
    .select({
      total: sql<string>`coalesce(sum(${partnerCommissionsTable.commissionAmount}),0)`,
      thisMonth: sql<string>`coalesce(sum(case when ${partnerCommissionsTable.periodYear} = ${now.getFullYear()} and ${partnerCommissionsTable.periodMonth} = ${now.getMonth() + 1} then ${partnerCommissionsTable.commissionAmount} else 0 end),0)`,
    })
    .from(partnerCommissionsTable)
    .where(eq(partnerCommissionsTable.partnerId, p.id));

  let activeClients = 0;
  if (ids.length) {
    const statusRows = await db
      .select({ status: companiesTable.status, n: sql<number>`count(*)::int` })
      .from(companiesTable)
      .where(inArray(companiesTable.id, ids))
      .groupBy(companiesTable.status);
    for (const s of statusRows) if (s.status === "active") activeClients = s.n;
  }
  const [pendingDocs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(partnerDocumentsTable)
    .where(and(eq(partnerDocumentsTable.partnerId, p.id), eq(partnerDocumentsTable.status, "pending")));

  res.json({
    clientCount: ids.length,
    activeClients,
    commissionTotal: commTotals?.total ?? "0",
    commissionThisMonth: commTotals?.thisMonth ?? "0",
    pendingDocs: pendingDocs?.n ?? 0,
    commissionRate: p.commissionRate,
  });
});

// ─── Linked companies (read-only) ────────────────────────────────────────
router.get("/companies", async (req, res) => {
  const ids = await partnerCompanyIds(req.partner!.id);
  if (!ids.length) { res.json({ companies: [] }); return; }
  const companies = await db
    .select({
      id: companiesTable.id, code: companiesTable.code,
      nameAr: companiesTable.nameAr, nameEn: companiesTable.nameEn,
      phone: companiesTable.phone, city: companiesTable.city,
      status: companiesTable.status, createdAt: companiesTable.createdAt,
    })
    .from(companiesTable)
    .where(inArray(companiesTable.id, ids))
    .orderBy(desc(companiesTable.id));
  // Latest subscription per company.
  const subs = await db
    .select()
    .from(subscriptionsTable)
    .where(inArray(subscriptionsTable.companyId, ids))
    .orderBy(desc(subscriptionsTable.endDate), desc(subscriptionsTable.id));
  const subMap = new Map<number, typeof subs[number]>();
  for (const s of subs) if (!subMap.has(s.companyId)) subMap.set(s.companyId, s);
  // The per-company role tag (served / built_by …) from the link row.
  const links = await db
    .select({ companyId: partnerCompaniesTable.companyId, role: partnerCompaniesTable.role })
    .from(partnerCompaniesTable)
    .where(eq(partnerCompaniesTable.partnerId, req.partner!.id));
  const roleMap = new Map(links.map((l) => [l.companyId, l.role]));
  res.json({
    companies: companies.map((c) => ({
      ...c,
      role: roleMap.get(c.id) ?? "served",
      subscription: subMap.get(c.id) ?? null,
    })),
  });
});

// ─── Commissions (requires view_reports) ─────────────────────────────────
router.get("/commissions", requirePartnerPermission("view_reports"), async (req, res) => {
  const rows = await db
    .select({
      id: partnerCommissionsTable.id,
      companyId: partnerCommissionsTable.companyId,
      companyName: companiesTable.nameAr,
      extensionId: partnerCommissionsTable.extensionId,
      eventType: partnerCommissionsTable.eventType,
      description: partnerCommissionsTable.description,
      baseAmount: partnerCommissionsTable.baseAmount,
      commissionRate: partnerCommissionsTable.commissionRate,
      commissionAmount: partnerCommissionsTable.commissionAmount,
      periodMonth: partnerCommissionsTable.periodMonth,
      periodYear: partnerCommissionsTable.periodYear,
      status: partnerCommissionsTable.status,
      createdAt: partnerCommissionsTable.createdAt,
    })
    .from(partnerCommissionsTable)
    .leftJoin(companiesTable, eq(companiesTable.id, partnerCommissionsTable.companyId))
    .where(eq(partnerCommissionsTable.partnerId, req.partner!.id))
    .orderBy(desc(partnerCommissionsTable.createdAt));
  res.json({ commissions: rows });
});

// ─── Commission summary (monthly / annual roll-up) ───────────────────────
router.get("/commissions/summary", requirePartnerPermission("view_reports"), async (req, res) => {
  const monthly = await db
    .select({
      periodYear: partnerCommissionsTable.periodYear,
      periodMonth: partnerCommissionsTable.periodMonth,
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${partnerCommissionsTable.commissionAmount}),0)`,
      base: sql<string>`coalesce(sum(${partnerCommissionsTable.baseAmount}),0)`,
    })
    .from(partnerCommissionsTable)
    .where(eq(partnerCommissionsTable.partnerId, req.partner!.id))
    .groupBy(partnerCommissionsTable.periodYear, partnerCommissionsTable.periodMonth)
    .orderBy(desc(partnerCommissionsTable.periodYear), desc(partnerCommissionsTable.periodMonth));
  const annual = await db
    .select({
      periodYear: partnerCommissionsTable.periodYear,
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${partnerCommissionsTable.commissionAmount}),0)`,
    })
    .from(partnerCommissionsTable)
    .where(eq(partnerCommissionsTable.partnerId, req.partner!.id))
    .groupBy(partnerCommissionsTable.periodYear)
    .orderBy(desc(partnerCommissionsTable.periodYear));
  res.json({ monthly, annual });
});

// ─── Documents: list (own only) ──────────────────────────────────────────
router.get("/documents", async (req, res) => {
  const rows = await db.select().from(partnerDocumentsTable)
    .where(eq(partnerDocumentsTable.partnerId, req.partner!.id))
    .orderBy(desc(partnerDocumentsTable.createdAt));
  res.json({ documents: rows });
});

// ─── Documents: request a presigned upload URL for self-upload ───────────
// The client PUTs the file directly to the returned URL, then calls
// POST /documents with the returned objectPath. The stored path is private —
// served back only through the scoped download route below.
router.post("/documents/upload-url", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const contentType = String(req.body?.contentType ?? "").trim();
  if (!name || !contentType) { res.status(400).json({ error: "اسم الملف ونوعه مطلوبان" }); return; }
  try {
    const uploadURL = await objectStorage.getObjectEntityUploadURL();
    const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);
    res.json({ uploadURL, objectPath });
  } catch (err) {
    req.log.error({ err }, "partner documents: failed to issue upload URL");
    res.status(500).json({ error: "تعذّر إنشاء رابط الرفع" });
  }
});

// ─── Documents: record an uploaded document (self-upload) ─────────────────
router.post("/documents", async (req, res) => {
  const docType = String(req.body?.docType ?? "").trim();
  const objectPath = String(req.body?.objectPath ?? req.body?.fileUrl ?? "").trim();
  if (!docType) { res.status(400).json({ error: "نوع المستند مطلوب" }); return; }
  if (!objectPath) { res.status(400).json({ error: "يجب رفع الملف أولاً" }); return; }
  // Only accept paths the issuer minted for us (private object entities).
  if (!objectPath.startsWith("/objects/")) { res.status(400).json({ error: "مسار الملف غير صالح" }); return; }
  const [created] = await db.insert(partnerDocumentsTable).values({
    partnerId: req.partner!.id,
    docType,
    title: req.body?.title ? String(req.body.title).trim() : null,
    fileUrl: objectPath,
    status: "pending",
  }).returning();
  res.status(201).json({ ok: true, document: created });
});

// ─── Documents: stream own file (row-ownership ACL) ──────────────────────
// Private files are NEVER served via the raw /storage/objects route to a
// partner token; ownership is enforced here per-row.
router.get("/documents/:id/download", async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [doc] = await db.select().from(partnerDocumentsTable)
    .where(and(eq(partnerDocumentsTable.id, id), eq(partnerDocumentsTable.partnerId, req.partner!.id)));
  if (!doc || !doc.fileUrl) { res.status(404).json({ error: "المستند غير موجود" }); return; }
  try {
    const objectFile = await objectStorage.getObjectEntityFile(doc.fileUrl);
    const response = await objectStorage.downloadObject(objectFile);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "المستند غير موجود" }); return; }
    req.log.error({ err, docId: id }, "partner documents: download failed");
    res.status(500).json({ error: "تعذّر تنزيل الملف" });
  }
});

export default router;
