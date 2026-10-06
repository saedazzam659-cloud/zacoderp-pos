import { Router } from "express";
import {
  customersTable,
  crmWhatsAppCampaignRecipientsTable,
  crmWhatsAppCampaignsTable,
  crmWhatsAppContactsTable,
  db,
} from "@workspace/db";
import {
  ConvertWhatsAppContactBody,
  CreateWhatsAppCampaignBody,
  CreateWhatsAppContactBody,
  ImportWhatsAppContactsBody,
  UpdateWhatsAppCampaignRecipientBody,
  UpdateWhatsAppContactBody,
} from "@workspace/api-zod";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ensureCustomerLedger } from "../lib/entityAccounts.js";
import { normalizeCrmWhatsAppPhone } from "../lib/crmWhatsAppPhone.js";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("crm"));
router.use(moduleAudit("crm"));
router.use((req, res, next) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

type RouteError = Error & { status?: number };

function routeError(req: any, res: any, error: unknown) {
  const e = error as RouteError;
  const status = Number(e?.status) || 500;
  if (status >= 500) req.log?.error({ err: error }, "CRM WhatsApp request failed");
  res.status(status).json({
    error: status >= 500 ? "تعذّر تنفيذ الطلب" : (e?.message || "طلب غير صالح"),
  });
}

function reject(status: number, message: string): never {
  const error = new Error(message) as RouteError;
  error.status = status;
  throw error;
}

function companyIdFrom(req: any): number | null {
  const requested = req.query.companyId
    ? Number(req.query.companyId)
    : Number(req.body?.companyId);
  return resolveCompanyId(req, Number.isFinite(requested) && requested > 0 ? requested : undefined) ?? null;
}

function cleanContact(row: { name?: unknown; phone?: unknown; notes?: unknown }) {
  const name = String(row.name ?? "").trim();
  const phone = normalizeCrmWhatsAppPhone(row.phone);
  const notesText = row.notes == null ? null : String(row.notes).trim();
  if (!name || name.length > 160) return null;
  if (!phone) return null;
  if (notesText && notesText.length > 2000) return null;
  return { name, phone: phone.phone, normalizedPhone: phone.normalizedPhone, notes: notesText || null };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as any)?.code === "23505";
}

async function getActiveContact(id: number, companyId: number, executor: any = db) {
  const [contact] = await executor.select().from(crmWhatsAppContactsTable).where(and(
    eq(crmWhatsAppContactsTable.id, id),
    eq(crmWhatsAppContactsTable.companyId, companyId),
    isNull(crmWhatsAppContactsTable.deletedAt),
  ));
  return contact;
}

async function getCampaign(id: number, companyId: number, executor: any = db) {
  const [campaign] = await executor.select().from(crmWhatsAppCampaignsTable).where(and(
    eq(crmWhatsAppCampaignsTable.id, id),
    eq(crmWhatsAppCampaignsTable.companyId, companyId),
  ));
  return campaign;
}

router.get("/contacts", async (req, res) => {
  try {
    const companyId = companyIdFrom(req);
    if (!companyId) { res.status(401).json({ error: "غير مصرح" }); return; }
    const rows = await db.select().from(crmWhatsAppContactsTable).where(and(
      eq(crmWhatsAppContactsTable.companyId, companyId),
      isNull(crmWhatsAppContactsTable.deletedAt),
    )).orderBy(desc(crmWhatsAppContactsTable.id));
    res.json(rows);
  } catch (error) { routeError(req, res, error); }
});

router.post("/contacts", async (req, res) => {
  const parsed = CreateWhatsAppContactBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "بيانات الرقم غير صالحة", details: parsed.error.issues }); return; }
  try {
    const companyId = resolveCompanyId(req, parsed.data.companyId);
    if (!companyId) { res.status(401).json({ error: "غير مصرح" }); return; }
    const value = cleanContact(parsed.data);
    if (!value) { res.status(400).json({ error: "أدخل اسماً ورقم هاتف صالحاً يتضمن مفتاح الدولة" }); return; }

    const [existing] = await db.select().from(crmWhatsAppContactsTable).where(and(
      eq(crmWhatsAppContactsTable.companyId, companyId),
      eq(crmWhatsAppContactsTable.normalizedPhone, value.normalizedPhone),
    ));
    if (existing && !existing.deletedAt) reject(409, "هذا الرقم موجود بالفعل");
    if (existing) {
      const [restored] = await db.update(crmWhatsAppContactsTable).set({
        name: value.name,
        phone: value.phone,
        notes: value.notes,
        deletedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(crmWhatsAppContactsTable.id, existing.id),
        eq(crmWhatsAppContactsTable.companyId, companyId),
      )).returning();
      res.status(201).json(restored);
      return;
    }

    const [contact] = await db.insert(crmWhatsAppContactsTable).values({
      companyId,
      name: value.name,
      phone: value.phone,
      normalizedPhone: value.normalizedPhone,
      notes: value.notes,
    }).returning();
    res.status(201).json(contact);
  } catch (error) {
    if (isUniqueViolation(error)) { res.status(409).json({ error: "هذا الرقم موجود بالفعل" }); return; }
    routeError(req, res, error);
  }
});

router.post("/contacts/import", async (req, res) => {
  const parsed = ImportWhatsAppContactsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "ملف الاستيراد أو بياناته غير صالحة", details: parsed.error.issues }); return; }
  try {
    const companyId = resolveCompanyId(req, parsed.data.companyId);
    if (!companyId) { res.status(401).json({ error: "غير مصرح" }); return; }
    let invalid = 0;
    let duplicates = 0;
    const unique = new Map<string, NonNullable<ReturnType<typeof cleanContact>>>();
    for (const row of parsed.data.contacts) {
      const value = cleanContact(row);
      if (!value) { invalid++; continue; }
      if (unique.has(value.normalizedPhone)) { duplicates++; continue; }
      unique.set(value.normalizedPhone, value);
    }
    const candidates = [...unique.values()];
    if (candidates.length === 0) {
      res.json({ created: 0, duplicates, revived: 0, invalid });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const existing = await tx.select().from(crmWhatsAppContactsTable).where(and(
        eq(crmWhatsAppContactsTable.companyId, companyId),
        inArray(crmWhatsAppContactsTable.normalizedPhone, candidates.map((row) => row.normalizedPhone)),
      ));
      const existingByPhone = new Map(existing.map((row) => [row.normalizedPhone, row]));
      const toInsert = [];
      let revived = 0;
      for (const value of candidates) {
        const prior = existingByPhone.get(value.normalizedPhone);
        if (!prior) { toInsert.push(value); continue; }
        if (!prior.deletedAt) { duplicates++; continue; }
        await tx.update(crmWhatsAppContactsTable).set({
          name: value.name,
          phone: value.phone,
          notes: value.notes,
          deletedAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(crmWhatsAppContactsTable.id, prior.id),
          eq(crmWhatsAppContactsTable.companyId, companyId),
        ));
        revived++;
      }
      let created = 0;
      if (toInsert.length > 0) {
        const inserted = await tx.insert(crmWhatsAppContactsTable).values(toInsert.map((value) => ({
          companyId,
          name: value.name,
          phone: value.phone,
          normalizedPhone: value.normalizedPhone,
          notes: value.notes,
        }))).onConflictDoNothing().returning({ id: crmWhatsAppContactsTable.id });
        created = inserted.length;
        duplicates += toInsert.length - inserted.length;
      }
      return { created, revived };
    });
    res.json({ ...result, duplicates, invalid });
  } catch (error) { routeError(req, res, error); }
});

router.put("/contacts/:contactId", async (req, res) => {
  const parsedParams = Number(req.params.contactId);
  const parsed = UpdateWhatsAppContactBody.safeParse(req.body);
  if (!Number.isInteger(parsedParams) || parsedParams < 1 || !parsed.success) {
    res.status(400).json({ error: "بيانات التعديل غير صالحة", ...(parsed.success ? {} : { details: parsed.error.issues }) });
    return;
  }
  try {
    const companyId = resolveCompanyId(req, parsed.data.companyId);
    if (!companyId) { res.status(401).json({ error: "غير مصرح" }); return; }
    const current = await getActiveContact(parsedParams, companyId);
    if (!current) { res.status(404).json({ error: "الرقم غير موجود" }); return; }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) {
      const name = parsed.data.name.trim();
      if (!name) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
      patch.name = name;
    }
    if (parsed.data.phone !== undefined) {
      const phone = normalizeCrmWhatsAppPhone(parsed.data.phone);
      if (!phone) { res.status(400).json({ error: "رقم الهاتف غير صالح؛ أدخل مفتاح الدولة" }); return; }
      const [duplicate] = await db.select({ id: crmWhatsAppContactsTable.id }).from(crmWhatsAppContactsTable).where(and(
        eq(crmWhatsAppContactsTable.companyId, companyId),
        eq(crmWhatsAppContactsTable.normalizedPhone, phone.normalizedPhone),
      ));
      if (duplicate && duplicate.id !== current.id) { res.status(409).json({ error: "هذا الرقم مسجل في دفتر الأرقام" }); return; }
      patch.phone = phone.phone;
      patch.normalizedPhone = phone.normalizedPhone;
    }
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes?.trim() || null;
    const [contact] = await db.update(crmWhatsAppContactsTable).set(patch).where(and(
      eq(crmWhatsAppContactsTable.id, parsedParams),
      eq(crmWhatsAppContactsTable.companyId, companyId),
      isNull(crmWhatsAppContactsTable.deletedAt),
    )).returning();
    res.json(contact);
  } catch (error) {
    if (isUniqueViolation(error)) { res.status(409).json({ error: "هذا الرقم مسجل في دفتر الأرقام" }); return; }
    routeError(req, res, error);
  }
});

router.delete("/contacts/:contactId", async (req, res) => {
  try {
    const companyId = companyIdFrom(req);
    const id = Number(req.params.contactId);
    if (!companyId) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "رقم غير صالح" }); return; }
    const [contact] = await db.update(crmWhatsAppContactsTable).set({
      deletedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(crmWhatsAppContactsTable.id, id),
      eq(crmWhatsAppContactsTable.companyId, companyId),
      isNull(crmWhatsAppContactsTable.deletedAt),
    )).returning({ id: crmWhatsAppContactsTable.id });
    if (!contact) { res.status(404).json({ error: "الرقم غير موجود" }); return; }
    res.json({ ok: true });
  } catch (error) { routeError(req, res, error); }
});

router.post("/contacts/:contactId/convert", async (req, res) => {
  const id = Number(req.params.contactId);
  const parsed = ConvertWhatsAppContactBody.safeParse(req.body);
  if (!Number.isInteger(id) || id < 1 || !parsed.success) {
    res.status(400).json({ error: "طلب التحويل غير صالح", ...(parsed.success ? {} : { details: parsed.error.issues }) });
    return;
  }
  try {
    const companyId = resolveCompanyId(req, parsed.data.companyId);
    if (!companyId) { res.status(401).json({ error: "غير مصرح" }); return; }
    const result = await db.transaction(async (tx) => {
      const contact = await getActiveContact(id, companyId, tx);
      if (!contact) reject(404, "الرقم غير موجود");
      if (contact.customerId) return { contact, customerId: contact.customerId, created: false };

      const [matchingCustomer] = await tx.select({ id: customersTable.id }).from(customersTable).where(and(
        eq(customersTable.companyId, companyId),
        sql`regexp_replace(regexp_replace(COALESCE(${customersTable.phone}, ''), '[^0-9]', '', 'g'), '^00', '') = ${contact.normalizedPhone}`,
      )).limit(1);
      let customerId = matchingCustomer?.id;
      let created = false;
      if (!customerId) {
        const [sameName] = await tx.select({ id: customersTable.id }).from(customersTable).where(and(
          eq(customersTable.companyId, companyId),
          sql`lower(trim(${customersTable.nameAr})) = lower(trim(${contact.name}))`,
        )).limit(1);
        if (sameName) reject(409, "يوجد عميل بهذا الاسم؛ غيّر اسم الرقم ثم أعد التحويل");
        const accountId = await ensureCustomerLedger(companyId, contact.name, false, undefined, tx);
        const [customer] = await tx.insert(customersTable).values({
          companyId,
          nameAr: contact.name,
          partyClassification: "customer",
          phone: contact.phone,
          accountId,
        }).returning({ id: customersTable.id });
        customerId = customer.id;
        created = true;
      }
      const [updatedContact] = await tx.update(crmWhatsAppContactsTable).set({
        customerId,
        updatedAt: new Date(),
      }).where(and(
        eq(crmWhatsAppContactsTable.id, id),
        eq(crmWhatsAppContactsTable.companyId, companyId),
      )).returning();
      return { contact: updatedContact, customerId, created };
    });
    res.json(result);
  } catch (error) { routeError(req, res, error); }
});

router.get("/campaigns", async (req, res) => {
  try {
    const companyId = companyIdFrom(req);
    if (!companyId) { res.status(401).json({ error: "غير مصرح" }); return; }
    const campaigns = await db.select().from(crmWhatsAppCampaignsTable)
      .where(eq(crmWhatsAppCampaignsTable.companyId, companyId))
      .orderBy(desc(crmWhatsAppCampaignsTable.id));
    if (campaigns.length === 0) { res.json([]); return; }
    const recipients = await db.select({
      campaignId: crmWhatsAppCampaignRecipientsTable.campaignId,
      status: crmWhatsAppCampaignRecipientsTable.status,
    }).from(crmWhatsAppCampaignRecipientsTable).where(and(
      eq(crmWhatsAppCampaignRecipientsTable.companyId, companyId),
      inArray(crmWhatsAppCampaignRecipientsTable.campaignId, campaigns.map((campaign) => campaign.id)),
    ));
    const counts = new Map<number, { sent: number; total: number }>();
    for (const recipient of recipients) {
      const count = counts.get(recipient.campaignId) ?? { sent: 0, total: 0 };
      count.total++;
      if (recipient.status === "sent") count.sent++;
      counts.set(recipient.campaignId, count);
    }
    res.json(campaigns.map((campaign) => {
      const count = counts.get(campaign.id) ?? { sent: 0, total: 0 };
      return {
        ...campaign,
        totalRecipients: count.total,
        sentCount: count.sent,
        notSentCount: count.total - count.sent,
      };
    }));
  } catch (error) { routeError(req, res, error); }
});

router.post("/campaigns", async (req, res) => {
  const parsed = CreateWhatsAppCampaignBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "بيانات الحملة غير صالحة", details: parsed.error.issues }); return; }
  try {
    const companyId = resolveCompanyId(req, parsed.data.companyId);
    if (!companyId) { res.status(401).json({ error: "غير مصرح" }); return; }
    const name = parsed.data.name.trim();
    const message = parsed.data.message.trim();
    const contactIds = [...new Set(parsed.data.contactIds)];
    if (!name || !message || contactIds.length !== parsed.data.contactIds.length) {
      res.status(400).json({ error: "اسم الحملة والرسالة وأرقاماً فريدة مطلوبة" });
      return;
    }
    const contacts = await db.select().from(crmWhatsAppContactsTable).where(and(
      eq(crmWhatsAppContactsTable.companyId, companyId),
      isNull(crmWhatsAppContactsTable.deletedAt),
      inArray(crmWhatsAppContactsTable.id, contactIds),
    ));
    if (contacts.length !== contactIds.length) { res.status(400).json({ error: "بعض الأرقام المحددة غير موجودة أو محذوفة" }); return; }

    const campaign = await db.transaction(async (tx) => {
      const [created] = await tx.insert(crmWhatsAppCampaignsTable).values({
        companyId,
        name,
        message,
      }).returning();
      await tx.insert(crmWhatsAppCampaignRecipientsTable).values(contacts.map((contact) => ({
        companyId,
        campaignId: created.id,
        contactId: contact.id,
        name: contact.name,
        phone: contact.phone,
        normalizedPhone: contact.normalizedPhone,
      })));
      return created;
    });
    res.status(201).json({
      ...campaign,
      totalRecipients: contacts.length,
      sentCount: 0,
      notSentCount: contacts.length,
    });
  } catch (error) { routeError(req, res, error); }
});

router.get("/campaigns/:campaignId", async (req, res) => {
  try {
    const companyId = companyIdFrom(req);
    const id = Number(req.params.campaignId);
    if (!companyId) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "رقم الحملة غير صالح" }); return; }
    const campaign = await getCampaign(id, companyId);
    if (!campaign) { res.status(404).json({ error: "الحملة غير موجودة" }); return; }
    const recipients = await db.select().from(crmWhatsAppCampaignRecipientsTable).where(and(
      eq(crmWhatsAppCampaignRecipientsTable.companyId, companyId),
      eq(crmWhatsAppCampaignRecipientsTable.campaignId, id),
    )).orderBy(asc(crmWhatsAppCampaignRecipientsTable.id));
    res.json({
      ...campaign,
      recipients: recipients.map(({ normalizedPhone: _normalized, ...recipient }) => recipient),
    });
  } catch (error) { routeError(req, res, error); }
});

router.delete("/campaigns/:campaignId", async (req, res) => {
  try {
    const companyId = companyIdFrom(req);
    const id = Number(req.params.campaignId);
    if (!companyId) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "رقم الحملة غير صالح" }); return; }
    const [deleted] = await db.delete(crmWhatsAppCampaignsTable).where(and(
      eq(crmWhatsAppCampaignsTable.id, id),
      eq(crmWhatsAppCampaignsTable.companyId, companyId),
    )).returning({ id: crmWhatsAppCampaignsTable.id });
    if (!deleted) { res.status(404).json({ error: "الحملة غير موجودة" }); return; }
    res.json({ ok: true });
  } catch (error) { routeError(req, res, error); }
});

router.patch("/campaigns/:campaignId/recipients/:recipientId", async (req, res) => {
  const parsed = UpdateWhatsAppCampaignRecipientBody.safeParse(req.body);
  const campaignId = Number(req.params.campaignId);
  const recipientId = Number(req.params.recipientId);
  if (!parsed.success || !Number.isInteger(campaignId) || campaignId < 1 || !Number.isInteger(recipientId) || recipientId < 1) {
    res.status(400).json({ error: "حالة الإرسال غير صالحة", ...(parsed.success ? {} : { details: parsed.error.issues }) });
    return;
  }
  try {
    const companyId = resolveCompanyId(req, parsed.data.companyId);
    if (!companyId) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!await getCampaign(campaignId, companyId)) { res.status(404).json({ error: "الحملة غير موجودة" }); return; }
    const [recipient] = await db.update(crmWhatsAppCampaignRecipientsTable).set({
      status: parsed.data.status,
      sentAt: parsed.data.status === "sent" ? new Date() : null,
    }).where(and(
      eq(crmWhatsAppCampaignRecipientsTable.id, recipientId),
      eq(crmWhatsAppCampaignRecipientsTable.companyId, companyId),
      eq(crmWhatsAppCampaignRecipientsTable.campaignId, campaignId),
    )).returning();
    if (!recipient) { res.status(404).json({ error: "الرقم غير موجود في هذه الحملة" }); return; }
    const { normalizedPhone: _normalized, ...response } = recipient;
    res.json(response);
  } catch (error) { routeError(req, res, error); }
});

export default router;
