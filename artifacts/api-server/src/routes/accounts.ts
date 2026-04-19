import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCompanyId(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

// ─── LIST ─────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const rows = cid
      ? await db.select().from(accountsTable).where(eq(accountsTable.companyId, cid)).orderBy(asc(accountsTable.code))
      : await db.select().from(accountsTable).orderBy(asc(accountsTable.code));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET ONE ──────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const id  = Number(req.params.id);
    const [row] = cid
      ? await db.select().from(accountsTable).where(and(eq(accountsTable.id, id), eq(accountsTable.companyId, cid)))
      : await db.select().from(accountsTable).where(eq(accountsTable.id, id));
    if (!row) { res.status(404).json({ error: "الحساب غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── CREATE ───────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { code, nameAr, nameEn, accountType, parentId, level, isPosting, isActive, notes } = req.body;
    if (!code || !nameAr || !accountType) {
      res.status(400).json({ error: "كود الحساب واسمه ونوعه مطلوبة" }); return;
    }
    const [row] = await db.insert(accountsTable).values({
      companyId: cid, code, nameAr, nameEn: nameEn || null,
      accountType, parentId: parentId || null,
      reportDirection: req.body.reportDirection || null,
      level: level ?? 1, isPosting: isPosting ?? true, isActive: isActive ?? true,
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
    const { code, nameAr, nameEn, accountType, parentId, level, isPosting, isActive, notes } = req.body;
    const [row] = await db.update(accountsTable).set({
      code, nameAr, nameEn: nameEn || null, accountType,
      parentId: parentId || null, level: level ?? 1,
      reportDirection: req.body.reportDirection || null,
      isPosting: isPosting ?? true, isActive: isActive ?? true,
      notes: notes || null, updatedAt: new Date(),
    }).where(and(eq(accountsTable.id, id), eq(accountsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الحساب غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE ───────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    await db.delete(accountsTable).where(and(eq(accountsTable.id, id), eq(accountsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
