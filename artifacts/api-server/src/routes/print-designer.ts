// Custom print template designer — CRUD for per-company WYSIWYG layouts.
//
//   GET    /api/print-designer/templates?documentType=sales_invoice
//   GET    /api/print-designer/templates/:id
//   POST   /api/print-designer/templates           — create
//   PATCH  /api/print-designer/templates/:id       — update (rename / layout)
//   DELETE /api/print-designer/templates/:id
//   POST   /api/print-designer/templates/:id/set-default
//
// Layout JSON is opaque on the server side: validated as a shape only
// (`{ elements: [...] }`), with element schema enforced by the frontend.

import { Router } from "express";
import { db, customPrintTemplatesTable, DOCUMENT_TYPES } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function getCid(req: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query?.companyId);
  return cid ?? null;
}

const documentTypeSchema = z.enum(DOCUMENT_TYPES);

const elementSchema = z.object({
  id:       z.string(),
  type:     z.enum(["text", "image", "rect", "line", "table", "field"]),
  x:        z.number(),
  y:        z.number(),
  width:    z.number(),
  height:   z.number(),
  rotation: z.number().optional().default(0),
  zIndex:   z.number().optional().default(0),
  // Visual styling — all optional, frontend applies defaults.
  fontFamily:  z.string().optional(),
  fontSize:    z.number().optional(),
  fontWeight:  z.string().optional(),
  fontStyle:   z.string().optional(),
  textAlign:   z.enum(["start", "end", "center", "justify"]).optional(),
  color:       z.string().optional(),
  background:  z.string().optional(),
  borderColor: z.string().optional(),
  borderWidth: z.number().optional(),
  borderStyle: z.string().optional(),
  padding:     z.number().optional(),
  opacity:     z.number().optional(),
  // type-specific payload.
  text:       z.string().optional(),
  src:        z.string().optional(),
  fieldKey:   z.string().optional(),
  tableSpec:  z.object({
    columns: z.array(z.object({
      key:   z.string(),
      label: z.string(),
      width: z.number().optional(),
      align: z.enum(["start", "end", "center"]).optional(),
    })),
    headerBg:   z.string().optional(),
    headerColor:z.string().optional(),
    rowBg:      z.string().optional(),
    altRowBg:   z.string().optional(),
    borderColor:z.string().optional(),
    borderWidth:z.number().optional(),
  }).optional(),
}).passthrough();

const layoutSchema = z.object({
  elements: z.array(elementSchema),
  pageBackground: z.string().optional(),
  margins: z.object({
    top: z.number(), right: z.number(), bottom: z.number(), left: z.number(),
  }).optional(),
}).passthrough();

const createSchema = z.object({
  documentType: documentTypeSchema,
  name:         z.string().min(1).max(120),
  paperSize:    z.string().optional(),
  widthMm:      z.number().int().positive().optional(),
  heightMm:     z.number().int().positive().optional(),
  layoutJson:   layoutSchema.optional(),
  isDefault:    z.boolean().optional(),
});

const updateSchema = z.object({
  name:       z.string().min(1).max(120).optional(),
  paperSize:  z.string().optional(),
  widthMm:    z.number().int().positive().optional(),
  heightMm:   z.number().int().positive().optional(),
  layoutJson: layoutSchema.optional(),
  isDefault:  z.boolean().optional(),
});

// GET /templates --------------------------------------------------------------
router.get("/templates", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const docTypeRaw = req.query.documentType as string | undefined;
    const where = docTypeRaw
      ? and(
          eq(customPrintTemplatesTable.companyId, cid),
          eq(customPrintTemplatesTable.documentType, docTypeRaw),
        )
      : eq(customPrintTemplatesTable.companyId, cid);
    const rows = await db.select().from(customPrintTemplatesTable).where(where);
    res.json(rows);
  } catch (e: any) {
    req.log.error({ err: e }, "print-designer list failed");
    res.status(500).json({ error: e.message });
  }
});

// GET /templates/:id ----------------------------------------------------------
router.get("/templates/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [row] = await db.select().from(customPrintTemplatesTable)
      .where(and(eq(customPrintTemplatesTable.id, id), eq(customPrintTemplatesTable.companyId, cid)))
      .limit(1);
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json(row);
  } catch (e: any) {
    req.log.error({ err: e }, "print-designer get failed");
    res.status(500).json({ error: e.message });
  }
});

// POST /templates -------------------------------------------------------------
router.post("/templates", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error.flatten() }); return; }
    const body = parsed.data;
    const userId = (req as any).authUser?.id ?? null;

    const [row] = await db.insert(customPrintTemplatesTable).values({
      companyId:    cid,
      documentType: body.documentType,
      name:         body.name,
      paperSize:    body.paperSize ?? "A4",
      widthMm:      body.widthMm ?? 210,
      heightMm:     body.heightMm ?? 297,
      layoutJson:   body.layoutJson ?? { elements: [] },
      isDefault:    body.isDefault ?? false,
      createdBy:    userId,
    }).returning();

    if (body.isDefault) {
      await db.update(customPrintTemplatesTable)
        .set({ isDefault: false })
        .where(and(
          eq(customPrintTemplatesTable.companyId, cid),
          eq(customPrintTemplatesTable.documentType, body.documentType),
        ));
      await db.update(customPrintTemplatesTable)
        .set({ isDefault: true })
        .where(eq(customPrintTemplatesTable.id, row.id));
    }
    res.status(201).json(row);
  } catch (e: any) {
    req.log.error({ err: e }, "print-designer create failed");
    res.status(500).json({ error: e.message });
  }
});

// PATCH /templates/:id --------------------------------------------------------
router.patch("/templates/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error.flatten() }); return; }
    const [existing] = await db.select().from(customPrintTemplatesTable)
      .where(and(eq(customPrintTemplatesTable.id, id), eq(customPrintTemplatesTable.companyId, cid)))
      .limit(1);
    if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }

    const patch: Record<string, any> = { updatedAt: new Date() };
    if (parsed.data.name       !== undefined) patch.name       = parsed.data.name;
    if (parsed.data.paperSize  !== undefined) patch.paperSize  = parsed.data.paperSize;
    if (parsed.data.widthMm    !== undefined) patch.widthMm    = parsed.data.widthMm;
    if (parsed.data.heightMm   !== undefined) patch.heightMm   = parsed.data.heightMm;
    if (parsed.data.layoutJson !== undefined) patch.layoutJson = parsed.data.layoutJson;

    const [row] = await db.update(customPrintTemplatesTable)
      .set(patch)
      .where(eq(customPrintTemplatesTable.id, id))
      .returning();

    if (parsed.data.isDefault === true) {
      await db.update(customPrintTemplatesTable)
        .set({ isDefault: false })
        .where(and(
          eq(customPrintTemplatesTable.companyId, cid),
          eq(customPrintTemplatesTable.documentType, existing.documentType),
        ));
      await db.update(customPrintTemplatesTable)
        .set({ isDefault: true })
        .where(eq(customPrintTemplatesTable.id, id));
    }
    res.json(row);
  } catch (e: any) {
    req.log.error({ err: e }, "print-designer update failed");
    res.status(500).json({ error: e.message });
  }
});

// POST /templates/:id/set-default --------------------------------------------
router.post("/templates/:id/set-default", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [existing] = await db.select().from(customPrintTemplatesTable)
      .where(and(eq(customPrintTemplatesTable.id, id), eq(customPrintTemplatesTable.companyId, cid)))
      .limit(1);
    if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
    await db.update(customPrintTemplatesTable)
      .set({ isDefault: false })
      .where(and(
        eq(customPrintTemplatesTable.companyId, cid),
        eq(customPrintTemplatesTable.documentType, existing.documentType),
      ));
    const [row] = await db.update(customPrintTemplatesTable)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(customPrintTemplatesTable.id, id))
      .returning();
    res.json(row);
  } catch (e: any) {
    req.log.error({ err: e }, "print-designer set-default failed");
    res.status(500).json({ error: e.message });
  }
});

// DELETE /templates/:id -------------------------------------------------------
router.delete("/templates/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [existing] = await db.select().from(customPrintTemplatesTable)
      .where(and(eq(customPrintTemplatesTable.id, id), eq(customPrintTemplatesTable.companyId, cid)))
      .limit(1);
    if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
    await db.delete(customPrintTemplatesTable).where(eq(customPrintTemplatesTable.id, id));
    res.json({ ok: true });
  } catch (e: any) {
    req.log.error({ err: e }, "print-designer delete failed");
    res.status(500).json({ error: e.message });
  }
});

export default router;
