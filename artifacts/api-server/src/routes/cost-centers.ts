import { Router } from "express";
import { db } from "@workspace/db";
import { costCentersTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("accounts"));
router.use(moduleAudit("accounts"));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Validate parent belongs to same company; detect cycles by walking up the chain.
async function validateParent(cid: number, selfId: number | null, parentId: number | null): Promise<string | null> {
  if (!parentId) return null;
  if (selfId && parentId === selfId) return "لا يمكن أن يكون المركز أباً لنفسه";
  let current: number | null = parentId;
  let hops = 0;
  while (current) {
    if (++hops > 50) return "هرم مراكز التكلفة عميق جداً";
    const [row] = await db.select({ id: costCentersTable.id, parentId: costCentersTable.parentId, companyId: costCentersTable.companyId })
      .from(costCentersTable).where(eq(costCentersTable.id, current));
    if (!row) return "المركز الأب غير موجود";
    if (row.companyId !== cid) return "المركز الأب يخص شركة أخرى";
    if (selfId && row.id === selfId) return "لا يمكن إنشاء حلقة في الهرم (المركز يصبح أباً لنفسه)";
    current = row.parentId;
  }
  return null;
}

// ─── LIST ─────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(costCentersTable)
      .where(eq(costCentersTable.companyId, cid))
      .orderBy(asc(costCentersTable.code));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET ONE ──────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [row] = await db.select().from(costCentersTable)
      .where(and(eq(costCentersTable.id, id), eq(costCentersTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "مركز التكلفة غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── CREATE ───────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { code, nameAr, nameEn, parentId, level, isPosting, isActive, notes } = req.body;
    if (!code || !nameAr) {
      res.status(400).json({ error: "كود مركز التكلفة والاسم مطلوبان" }); return;
    }
    // Uniqueness check (code per company)
    const [dup] = await db.select().from(costCentersTable)
      .where(and(eq(costCentersTable.companyId, cid), eq(costCentersTable.code, String(code).trim())));
    if (dup) { res.status(400).json({ error: "كود مركز التكلفة مستخدم بالفعل" }); return; }

    const pid = parentId ? Number(parentId) : null;
    const parentErr = await validateParent(cid, null, pid);
    if (parentErr) { res.status(400).json({ error: parentErr }); return; }

    const [row] = await db.insert(costCentersTable).values({
      companyId: cid,
      code: String(code).trim(),
      nameAr, nameEn: nameEn || null,
      parentId: pid,
      level: level ?? (pid ? 2 : 1),
      isPosting: isPosting ?? true,
      isActive:  isActive  ?? true,
      notes: notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const { code, nameAr, nameEn, parentId, level, isPosting, isActive, notes } = req.body;
    const pid = parentId ? Number(parentId) : null;
    const parentErr = await validateParent(cid, id, pid);
    if (parentErr) { res.status(400).json({ error: parentErr }); return; }

    // If code is changing, ensure uniqueness within company
    const trimmedCode = String(code).trim();
    const [existing] = await db.select().from(costCentersTable)
      .where(and(eq(costCentersTable.id, id), eq(costCentersTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "مركز التكلفة غير موجود" }); return; }
    if (existing.code !== trimmedCode) {
      const [dup] = await db.select().from(costCentersTable)
        .where(and(eq(costCentersTable.companyId, cid), eq(costCentersTable.code, trimmedCode)));
      if (dup) { res.status(400).json({ error: "كود مركز التكلفة مستخدم بالفعل" }); return; }
    }

    const [row] = await db.update(costCentersTable).set({
      code: trimmedCode,
      nameAr, nameEn: nameEn || null,
      parentId: pid,
      level: level ?? (pid ? 2 : 1),
      isPosting: isPosting ?? true,
      isActive:  isActive  ?? true,
      notes: notes || null,
      updatedAt: new Date(),
    }).where(and(eq(costCentersTable.id, id), eq(costCentersTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "مركز التكلفة غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE ───────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    // Block delete if any children exist
    const children = await db.select({ id: costCentersTable.id }).from(costCentersTable)
      .where(and(eq(costCentersTable.companyId, cid), eq(costCentersTable.parentId, id)));
    if (children.length > 0) {
      res.status(400).json({ error: "لا يمكن حذف مركز له مراكز فرعية" }); return;
    }
    await db.delete(costCentersTable).where(and(eq(costCentersTable.id, id), eq(costCentersTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
