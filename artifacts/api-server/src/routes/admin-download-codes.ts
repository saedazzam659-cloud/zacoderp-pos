// SuperAdmin — issue / manage activation codes for the protected install
// wizard (/install). A code, COMBINED with a valid user login, unlocks the
// POS Desktop MSI download. Direct fetch + Bearer convention (NOT generated
// client), mirroring admin-offline-licenses.ts.

import { Router } from "express";
import { db } from "@workspace/db";
import { downloadAccessCodesTable, companiesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { z } from "zod/v4";
import { extractAuth } from "../middleware/auth.js";
import { generateLicenseKey } from "../lib/posDesktopGuards.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if ((req as any).authUser?.role !== "superadmin") {
    res.status(403).json({ error: "superadmin only" }); return;
  }
  next();
});

// GET /api/admin/download-codes — list with the bound company's name.
router.get("/", async (_req, res) => {
  const rows = await db.select({
    id: downloadAccessCodesTable.id,
    code: downloadAccessCodesTable.code,
    label: downloadAccessCodesTable.label,
    companyId: downloadAccessCodesTable.companyId,
    companyName: companiesTable.nameAr,
    maxUses: downloadAccessCodesTable.maxUses,
    usedCount: downloadAccessCodesTable.usedCount,
    expiresAt: downloadAccessCodesTable.expiresAt,
    isActive: downloadAccessCodesTable.isActive,
    notes: downloadAccessCodesTable.notes,
    createdAt: downloadAccessCodesTable.createdAt,
  })
    .from(downloadAccessCodesTable)
    .leftJoin(companiesTable, eq(companiesTable.id, downloadAccessCodesTable.companyId))
    .orderBy(desc(downloadAccessCodesTable.id)).limit(500);
  res.json(rows);
});

const createSchema = z.object({
  label: z.string().max(200).optional(),
  code: z.string().min(4).max(100).optional(),
  companyId: z.number().int().positive().nullable().optional(),
  maxUses: z.number().int().min(1).max(100000).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().max(1000).optional(),
});

// POST /api/admin/download-codes — create (auto-generates code when omitted).
router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const userId = (req as any).authUser?.id ?? null;
  const code = (parsed.data.code?.trim().toUpperCase()) || generateLicenseKey();

  const [dupe] = await db.select({ id: downloadAccessCodesTable.id })
    .from(downloadAccessCodesTable).where(eq(downloadAccessCodesTable.code, code));
  if (dupe) { res.status(409).json({ error: "هذا الكود مستخدم بالفعل، اختر كوداً آخر" }); return; }

  const [created] = await db.insert(downloadAccessCodesTable).values({
    code,
    label: parsed.data.label ?? null,
    companyId: parsed.data.companyId ?? null,
    maxUses: parsed.data.maxUses ?? null,
    expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    notes: parsed.data.notes ?? null,
    createdByUserId: userId,
  }).returning();
  res.status(201).json(created);
});

const patchSchema = z.object({
  label: z.string().max(200).optional(),
  companyId: z.number().int().positive().nullable().optional(),
  maxUses: z.number().int().min(1).max(100000).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});

// PATCH /api/admin/download-codes/:id — edit / revoke (isActive=false).
router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "invalid id" }); return; }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const b = parsed.data;
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (b.label !== undefined) patch.label = b.label;
  if (b.companyId !== undefined) patch.companyId = b.companyId;
  if (b.maxUses !== undefined) patch.maxUses = b.maxUses;
  if (b.expiresAt !== undefined) patch.expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
  if (b.isActive !== undefined) patch.isActive = b.isActive;
  if (b.notes !== undefined) patch.notes = b.notes;
  const [updated] = await db.update(downloadAccessCodesTable).set(patch)
    .where(eq(downloadAccessCodesTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "not found" }); return; }
  res.json(updated);
});

// DELETE /api/admin/download-codes/:id — permanently remove.
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "invalid id" }); return; }
  await db.delete(downloadAccessCodesTable).where(eq(downloadAccessCodesTable.id, id));
  res.json({ ok: true });
});

export default router;
