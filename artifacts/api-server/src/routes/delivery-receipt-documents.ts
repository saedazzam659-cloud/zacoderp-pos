// Goods Receipt / Delivery Documents (مستندات الاستلام والتسليم)
// ───────────────────────────────────────────────────────────────
// A PURE electronic archive linked to purchase invoices (receipt) or sales
// invoices (delivery). ZERO accounting/inventory impact — no journal entry, no
// stock movement, no invoice-status change. It records the physical hand-over:
// recipient data, an e-signature (stored in object storage), line quantities,
// plus file attachments (which reuse the existing document_archives system).
//
// The whole surface is gated by the single `delivery_receipt_docs` company
// module toggle + per-user create/edit/delete permission via
// requireModulePermission (mounted in routes/index.ts style below).

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, desc, sql, gte, lte, count } from "drizzle-orm";
import { Readable } from "node:stream";
import { db } from "@workspace/db";
import {
  deliveryReceiptDocumentsTable,
  deliveryReceiptDocumentLinesTable,
  deliveryReceiptDocumentAuditTable,
  documentArchivesTable,
} from "@workspace/db";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
import { requireModulePermission, moduleAudit } from "../middleware/permissions.js";
import { sendEmail } from "../lib/email.js";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage.js";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

// Allow ?token= so the signature image URL works in <img>/print popups where no
// Authorization header can be attached. Must run BEFORE extractAuth.
router.use((req, _res, next) => {
  const t = typeof req.query.token === "string" ? req.query.token : null;
  if (t && !req.headers.authorization) req.headers.authorization = `Bearer ${t}`;
  next();
});
router.use(extractAuth);
router.use(requireModulePermission("delivery_receipt_docs"));
router.use(moduleAudit("delivery_receipt_docs"));

function guard(req: Request, res: Response): number | null {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return null; }
  const cid = resolveCompanyId(req);
  if (cid == null) { res.status(400).json({ error: "لم يتم تحديد الشركة" }); return null; }
  return cid;
}

function actorName(req: Request): string | null {
  const u = req.authUser as any;
  return u?.nameAr ?? u?.username ?? null;
}

const KIND = z.enum(["receipt", "delivery"]);

const LineBody = z.object({
  itemId:     z.number().int().positive().optional().nullable(),
  itemName:   z.string().min(1).max(512),
  unit:       z.string().max(64).optional().nullable(),
  orderedQty: z.coerce.number().finite().optional().default(0),
  actualQty:  z.coerce.number().finite().optional().default(0),
  notes:      z.string().max(1024).optional().nullable(),
});

const DocBody = z.object({
  kind:          KIND,
  docNumber:     z.string().max(64).optional().nullable(),
  docDate:       z.string().datetime({ offset: true }).optional().nullable(),
  branchId:      z.number().int().positive().optional().nullable(),
  warehouseId:   z.number().int().positive().optional().nullable(),
  invoiceId:     z.number().int().positive().optional().nullable(),
  invoiceType:   z.enum(["purchase", "sales"]).optional().nullable(),
  invoiceNumber: z.string().max(128).optional().nullable(),
  partyId:       z.number().int().positive().optional().nullable(),
  partyType:     z.enum(["customer", "supplier"]).optional().nullable(),
  partyName:     z.string().max(512).optional().nullable(),
  employeeId:    z.number().int().positive().optional().nullable(),
  employeeName:  z.string().max(512).optional().nullable(),
  status:        z.string().max(32).optional().default("full"),
  notes:         z.string().max(4000).optional().nullable(),
  recipientName:     z.string().max(256).optional().nullable(),
  recipientJob:      z.string().max(256).optional().nullable(),
  recipientIdNumber: z.string().max(64).optional().nullable(),
  recipientPhone:    z.string().max(64).optional().nullable(),
  signatureType:       z.enum(["draw", "image"]).optional().nullable(),
  signatureObjectPath: z.string().max(1024).optional().nullable(),
  lines: z.array(LineBody).optional().default([]),
});

// Next document number: <prefix><zero-padded max+1> per company + kind.
// Editable by the client (body.docNumber wins); the UNIQUE index guards dups.
async function nextDocNumber(cid: number, kind: string): Promise<string> {
  const prefix = kind === "receipt" ? "REC-" : "DEL-";
  const rows = await db
    .select({ docNumber: deliveryReceiptDocumentsTable.docNumber })
    .from(deliveryReceiptDocumentsTable)
    .where(and(
      eq(deliveryReceiptDocumentsTable.companyId, cid),
      eq(deliveryReceiptDocumentsTable.kind, kind),
    ));
  let max = 0;
  for (const r of rows) {
    const m = /(\d+)\s*$/.exec(r.docNumber ?? "");
    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  }
  return `${prefix}${String(max + 1).padStart(5, "0")}`;
}

async function writeAudit(
  cid: number, documentId: number, action: string, req: Request, details?: unknown,
) {
  try {
    await db.insert(deliveryReceiptDocumentAuditTable).values({
      companyId: cid,
      documentId,
      action,
      userId: req.authUser?.id ?? null,
      userName: actorName(req),
      details: (details ?? null) as any,
    });
  } catch { /* audit is best-effort — never block the main op */ }
}

async function attachmentCount(cid: number, docId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(documentArchivesTable)
    .where(and(
      eq(documentArchivesTable.companyId, cid),
      eq(documentArchivesTable.docKey, `drdoc:${docId}`),
    ));
  return Number(row?.n ?? 0);
}

// GET / — list with filters (kind, invoice, party, employee, status, date range,
// free-text q). Branch-scoped for restricted users.
router.get("/", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const conds = [eq(deliveryReceiptDocumentsTable.companyId, cid)];

  const kind = typeof req.query.kind === "string" ? req.query.kind : "";
  if (kind === "receipt" || kind === "delivery") conds.push(eq(deliveryReceiptDocumentsTable.kind, kind));

  const invoiceId = Number(req.query.invoiceId);
  if (Number.isInteger(invoiceId) && invoiceId > 0) conds.push(eq(deliveryReceiptDocumentsTable.invoiceId, invoiceId));
  const invoiceType = typeof req.query.invoiceType === "string" ? req.query.invoiceType : "";
  if (invoiceType === "purchase" || invoiceType === "sales") conds.push(eq(deliveryReceiptDocumentsTable.invoiceType, invoiceType));

  const partyId = Number(req.query.partyId);
  if (Number.isInteger(partyId) && partyId > 0) conds.push(eq(deliveryReceiptDocumentsTable.partyId, partyId));
  const employeeId = Number(req.query.employeeId);
  if (Number.isInteger(employeeId) && employeeId > 0) conds.push(eq(deliveryReceiptDocumentsTable.employeeId, employeeId));

  const status = typeof req.query.status === "string" ? req.query.status : "";
  if (status) conds.push(eq(deliveryReceiptDocumentsTable.status, status));

  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if (from) conds.push(gte(deliveryReceiptDocumentsTable.docDate, new Date(from)));
  if (to) conds.push(lte(deliveryReceiptDocumentsTable.docDate, new Date(`${to.slice(0, 10)}T23:59:59.999Z`)));

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q) {
    const like = `%${q}%`;
    conds.push(sql`(${deliveryReceiptDocumentsTable.docNumber} ILIKE ${like}
      OR ${deliveryReceiptDocumentsTable.partyName} ILIKE ${like}
      OR ${deliveryReceiptDocumentsTable.invoiceNumber} ILIKE ${like}
      OR ${deliveryReceiptDocumentsTable.recipientName} ILIKE ${like})`);
  }

  conds.push(...branchScopeSpread(req, deliveryReceiptDocumentsTable.branchId, req.query.branchId));

  const rows = await db
    .select()
    .from(deliveryReceiptDocumentsTable)
    .where(and(...conds))
    .orderBy(desc(deliveryReceiptDocumentsTable.docDate), desc(deliveryReceiptDocumentsTable.id))
    .limit(1000);
  res.json(rows);
});

// GET /reports/summary — counts grouped by status + missing-signature/incomplete
// flags, for the reports screen. MUST be registered before /:id.
router.get("/reports/summary", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const conds = [eq(deliveryReceiptDocumentsTable.companyId, cid)];
  const kind = typeof req.query.kind === "string" ? req.query.kind : "";
  if (kind === "receipt" || kind === "delivery") conds.push(eq(deliveryReceiptDocumentsTable.kind, kind));
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if (from) conds.push(gte(deliveryReceiptDocumentsTable.docDate, new Date(from)));
  if (to) conds.push(lte(deliveryReceiptDocumentsTable.docDate, new Date(`${to.slice(0, 10)}T23:59:59.999Z`)));
  conds.push(...branchScopeSpread(req, deliveryReceiptDocumentsTable.branchId, req.query.branchId));

  const rows = await db
    .select({
      kind: deliveryReceiptDocumentsTable.kind,
      status: deliveryReceiptDocumentsTable.status,
      isApproved: deliveryReceiptDocumentsTable.isApproved,
      hasSignature: sql<number>`CASE WHEN ${deliveryReceiptDocumentsTable.signatureObjectPath} IS NOT NULL THEN 1 ELSE 0 END`,
      n: count(),
    })
    .from(deliveryReceiptDocumentsTable)
    .where(and(...conds))
    .groupBy(
      deliveryReceiptDocumentsTable.kind,
      deliveryReceiptDocumentsTable.status,
      deliveryReceiptDocumentsTable.isApproved,
      sql`CASE WHEN ${deliveryReceiptDocumentsTable.signatureObjectPath} IS NOT NULL THEN 1 ELSE 0 END`,
    );
  res.json(rows);
});

// GET /:id — one document with its lines, attachment count, and audit trail.
router.get("/:id", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [doc] = await db
    .select()
    .from(deliveryReceiptDocumentsTable)
    .where(and(eq(deliveryReceiptDocumentsTable.id, id), eq(deliveryReceiptDocumentsTable.companyId, cid)));
  if (!doc) { res.status(404).json({ error: "غير موجود" }); return; }
  const lines = await db
    .select()
    .from(deliveryReceiptDocumentLinesTable)
    .where(eq(deliveryReceiptDocumentLinesTable.documentId, id))
    .orderBy(deliveryReceiptDocumentLinesTable.sortOrder, deliveryReceiptDocumentLinesTable.id);
  const audit = await db
    .select()
    .from(deliveryReceiptDocumentAuditTable)
    .where(eq(deliveryReceiptDocumentAuditTable.documentId, id))
    .orderBy(desc(deliveryReceiptDocumentAuditTable.at))
    .limit(200);
  res.json({ ...doc, lines, audit, attachmentCount: await attachmentCount(cid, id) });
});

// POST / — create a new receipt/delivery document (no GL, no stock).
router.post("/", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const parsed = DocBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "بيانات غير صحيحة", details: parsed.error.flatten() }); return; }
  const b = parsed.data;
  if (b.signatureObjectPath && !b.signatureObjectPath.startsWith("/objects/")) {
    res.status(400).json({ error: "مسار التوقيع غير صالح" }); return;
  }

  // Try up to 3 times in case of a concurrent same-number insert.
  for (let attempt = 0; attempt < 3; attempt++) {
    const docNumber = (b.docNumber && b.docNumber.trim()) || (await nextDocNumber(cid, b.kind));
    try {
      const created = await db.transaction(async (tx) => {
        const [doc] = await tx.insert(deliveryReceiptDocumentsTable).values({
          companyId: cid,
          branchId: b.branchId ?? null,
          warehouseId: b.warehouseId ?? null,
          kind: b.kind,
          docNumber,
          docDate: b.docDate ? new Date(b.docDate) : new Date(),
          invoiceId: b.invoiceId ?? null,
          invoiceType: b.invoiceType ?? null,
          invoiceNumber: b.invoiceNumber ?? null,
          partyId: b.partyId ?? null,
          partyType: b.partyType ?? null,
          partyName: b.partyName ?? null,
          employeeId: b.employeeId ?? null,
          employeeName: b.employeeName ?? null,
          status: b.status ?? "full",
          notes: b.notes ?? null,
          recipientName: b.recipientName ?? null,
          recipientJob: b.recipientJob ?? null,
          recipientIdNumber: b.recipientIdNumber ?? null,
          recipientPhone: b.recipientPhone ?? null,
          signatureType: b.signatureType ?? null,
          signatureObjectPath: b.signatureObjectPath ?? null,
          createdBy: req.authUser?.id ?? null,
          createdByName: actorName(req),
          updatedBy: req.authUser?.id ?? null,
          updatedByName: actorName(req),
        }).returning();
        if (b.lines.length) {
          await tx.insert(deliveryReceiptDocumentLinesTable).values(
            b.lines.map((l, i) => ({
              companyId: cid,
              documentId: doc.id,
              itemId: l.itemId ?? null,
              itemName: l.itemName,
              unit: l.unit ?? null,
              orderedQty: String(l.orderedQty ?? 0),
              actualQty: String(l.actualQty ?? 0),
              notes: l.notes ?? null,
              sortOrder: i,
            })),
          );
        }
        return doc;
      });
      await writeAudit(cid, created.id, "create", req, { docNumber });
      res.status(201).json(created);
      return;
    } catch (e: any) {
      // 23505 = unique_violation on drdoc_number_uniq → recompute + retry
      if (e?.code === "23505" && !b.docNumber && attempt < 2) continue;
      if (e?.code === "23505") { res.status(409).json({ error: "رقم المستند مستخدم مسبقاً" }); return; }
      req.log?.error({ err: e }, "create delivery/receipt document failed");
      res.status(500).json({ error: "تعذّر حفظ المستند" });
      return;
    }
  }
  res.status(500).json({ error: "تعذّر إنشاء رقم مستند فريد" });
});

// PUT /:id — update (blocked once approved).
router.put("/:id", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const parsed = DocBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "بيانات غير صحيحة" }); return; }
  const b = parsed.data;
  if (b.signatureObjectPath && !b.signatureObjectPath.startsWith("/objects/")) {
    res.status(400).json({ error: "مسار التوقيع غير صالح" }); return;
  }
  const [existing] = await db
    .select()
    .from(deliveryReceiptDocumentsTable)
    .where(and(eq(deliveryReceiptDocumentsTable.id, id), eq(deliveryReceiptDocumentsTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.isApproved) { res.status(409).json({ error: "المستند معتمد ولا يمكن تعديله" }); return; }

  try {
    await db.transaction(async (tx) => {
      await tx.update(deliveryReceiptDocumentsTable).set({
        branchId: b.branchId ?? existing.branchId,
        warehouseId: b.warehouseId ?? existing.warehouseId,
        docDate: b.docDate ? new Date(b.docDate) : existing.docDate,
        partyId: b.partyId ?? existing.partyId,
        partyType: b.partyType ?? existing.partyType,
        partyName: b.partyName ?? existing.partyName,
        employeeId: b.employeeId ?? existing.employeeId,
        employeeName: b.employeeName ?? existing.employeeName,
        status: b.status ?? existing.status,
        notes: b.notes ?? existing.notes,
        recipientName: b.recipientName ?? existing.recipientName,
        recipientJob: b.recipientJob ?? existing.recipientJob,
        recipientIdNumber: b.recipientIdNumber ?? existing.recipientIdNumber,
        recipientPhone: b.recipientPhone ?? existing.recipientPhone,
        signatureType: b.signatureType ?? existing.signatureType,
        signatureObjectPath: b.signatureObjectPath ?? existing.signatureObjectPath,
        updatedBy: req.authUser?.id ?? null,
        updatedByName: actorName(req),
        updatedAt: new Date(),
      }).where(eq(deliveryReceiptDocumentsTable.id, id));
      // Replace lines when provided.
      if (b.lines) {
        await tx.delete(deliveryReceiptDocumentLinesTable).where(eq(deliveryReceiptDocumentLinesTable.documentId, id));
        if (b.lines.length) {
          await tx.insert(deliveryReceiptDocumentLinesTable).values(
            b.lines.map((l, i) => ({
              companyId: cid,
              documentId: id,
              itemId: l.itemId ?? null,
              itemName: l.itemName,
              unit: l.unit ?? null,
              orderedQty: String(l.orderedQty ?? 0),
              actualQty: String(l.actualQty ?? 0),
              notes: l.notes ?? null,
              sortOrder: i,
            })),
          );
        }
      }
    });
    await writeAudit(cid, id, "update", req);
    res.json({ ok: true });
  } catch (e: any) {
    req.log?.error({ err: e }, "update delivery/receipt document failed");
    res.status(500).json({ error: "تعذّر تحديث المستند" });
  }
});

// POST /:id/approve — lock the document.
router.post("/:id/approve", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const updated = await db.update(deliveryReceiptDocumentsTable).set({
    isApproved: true,
    approvedBy: req.authUser?.id ?? null,
    approvedByName: actorName(req),
    approvedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(deliveryReceiptDocumentsTable.id, id),
    eq(deliveryReceiptDocumentsTable.companyId, cid),
    eq(deliveryReceiptDocumentsTable.isApproved, false),
  )).returning({ id: deliveryReceiptDocumentsTable.id });
  if (updated.length === 0) { res.status(409).json({ error: "غير موجود أو معتمد مسبقاً" }); return; }
  await writeAudit(cid, id, "approve", req);
  res.json({ ok: true });
});

// POST /:id/log — record a share/print action in the audit trail.
router.post("/:id/log", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const action = typeof req.body?.action === "string" ? req.body.action : "";
  if (!["send_whatsapp", "print", "send_email"].includes(action)) { res.status(400).json({ error: "إجراء غير صالح" }); return; }
  await writeAudit(cid, id, action, req, req.body?.details ?? null);
  res.json({ ok: true });
});

// POST /:id/email — email the document PDF. Client renders the PDF and sends it
// as RAW base64 (never a data: URI — the prod edge WAF rejects those bodies).
const EmailBody = z.object({
  to: z.string().email(),
  subject: z.string().max(256).optional(),
  message: z.string().max(4000).optional(),
  pdfBase64: z.string().min(1),
  filename: z.string().max(256).optional(),
});
router.post("/:id/email", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const parsed = EmailBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "بيانات البريد غير صحيحة" }); return; }
  const [doc] = await db
    .select()
    .from(deliveryReceiptDocumentsTable)
    .where(and(eq(deliveryReceiptDocumentsTable.id, id), eq(deliveryReceiptDocumentsTable.companyId, cid)));
  if (!doc) { res.status(404).json({ error: "غير موجود" }); return; }

  let buf: Buffer;
  try { buf = Buffer.from(parsed.data.pdfBase64, "base64"); }
  catch { res.status(400).json({ error: "ملف PDF غير صالح" }); return; }
  if (buf.length === 0 || buf.length > 15 * 1024 * 1024) { res.status(400).json({ error: "حجم الملف غير صالح" }); return; }

  const label = doc.kind === "receipt" ? "سند استلام" : "سند تسليم";
  const filename = parsed.data.filename || `${label}-${doc.docNumber}.pdf`;
  const subject = parsed.data.subject || `${label} رقم ${doc.docNumber}`;
  const body = (parsed.data.message || `مرفق ${label} رقم ${doc.docNumber}.`).replace(/\n/g, "<br/>");
  const r = await sendEmail({
    to: parsed.data.to,
    subject,
    html: `<div dir="rtl">${body}</div>`,
    text: parsed.data.message || `مرفق ${label} رقم ${doc.docNumber}.`,
    attachments: [{ filename, content: buf, contentType: "application/pdf" }],
  });
  if (!r.ok) { res.status(502).json({ error: "تعذّر إرسال البريد", reason: r.reason }); return; }
  await writeAudit(cid, id, "send_email", req, { to: parsed.data.to });
  res.json({ ok: true });
});

// GET /:id/signature — stream the stored signature PNG (tenant-scoped). Used by
// the print popup + PDF pipeline where no Authorization header can be attached
// (pass ?token=<bearer>). Returns 404 when the doc has no signature.
router.get("/:id/signature", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [doc] = await db
    .select({ path: deliveryReceiptDocumentsTable.signatureObjectPath })
    .from(deliveryReceiptDocumentsTable)
    .where(and(eq(deliveryReceiptDocumentsTable.id, id), eq(deliveryReceiptDocumentsTable.companyId, cid)));
  if (!doc) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!doc.path || !doc.path.startsWith("/objects/")) { res.status(404).json({ error: "لا يوجد توقيع" }); return; }
  try {
    const objectFile = await objectStorage.getObjectEntityFile(doc.path);
    const response = await objectStorage.downloadObject(objectFile);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) Readable.fromWeb(response.body as any).pipe(res);
    else res.end();
  } catch (error) {
    if (error instanceof ObjectNotFoundError) { res.status(404).json({ error: "الملف غير موجود" }); return; }
    req.log?.error({ err: error }, "signature download failed");
    res.status(500).json({ error: "تعذّر تنزيل التوقيع" });
  }
});

// DELETE /:id — remove the document + its lines/audit (cascade).
router.delete("/:id", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const deleted = await db
    .delete(deliveryReceiptDocumentsTable)
    .where(and(eq(deliveryReceiptDocumentsTable.id, id), eq(deliveryReceiptDocumentsTable.companyId, cid)))
    .returning({ id: deliveryReceiptDocumentsTable.id });
  if (deleted.length === 0) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json({ ok: true });
});

export default router;
