import { Router } from "express";
import { db } from "@workspace/db";
import { regionsTable, branchesTable } from "@workspace/db";
import { eq, and, asc, sql } from "drizzle-orm";
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

// ═══════════════════════════════════════════════════
//  REGIONS
// ═══════════════════════════════════════════════════

// LIST regions (with branch count)
router.get("/regions", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const rows = cid
      ? await db.select().from(regionsTable).where(eq(regionsTable.companyId, cid)).orderBy(asc(regionsTable.code))
      : await db.select().from(regionsTable).orderBy(asc(regionsTable.code));

    // attach branch count per region
    const ids = rows.map((r: any) => r.id);
    const branchCounts: Record<number, number> = {};
    if (ids.length > 0) {
      const allBranches = await db.select().from(branchesTable)
        .where(cid ? eq(branchesTable.companyId, cid) : sql`true`);
      for (const b of allBranches) {
        if (b.regionId) branchCounts[b.regionId] = (branchCounts[b.regionId] ?? 0) + 1;
      }
    }
    const result = rows.map((r: any) => ({ ...r, branchCount: branchCounts[r.id] ?? 0 }));
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// CREATE region
router.post("/regions", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { code, nameAr, nameEn, notes } = req.body;
    if (!code || !nameAr) { res.status(400).json({ error: "الكود والاسم مطلوبان" }); return; }
    const [row] = await db.insert(regionsTable).values({
      companyId: cid, code, nameAr, nameEn: nameEn || null, notes: notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// UPDATE region
router.put("/regions/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const { code, nameAr, nameEn, notes } = req.body;
    const [row] = await db.update(regionsTable).set({
      code, nameAr, nameEn: nameEn || null, notes: notes || null, updatedAt: new Date(),
    }).where(and(eq(regionsTable.id, id), eq(regionsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "المنطقة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE region
router.delete("/regions/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const branches = await db.select().from(branchesTable)
      .where(and(eq(branchesTable.regionId, id), eq(branchesTable.companyId, cid)));
    if (branches.length > 0) {
      res.status(400).json({ error: "لا يمكن حذف المنطقة لأن بها فروعاً، احذف الفروع أولاً" }); return;
    }
    await db.delete(regionsTable).where(and(eq(regionsTable.id, id), eq(regionsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════
//  BRANCHES
// ═══════════════════════════════════════════════════

// LIST branches (optionally filtered by regionId)
router.get("/branches", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const regionId = req.query.regionId ? Number(req.query.regionId) : undefined;

    let rows: any[];
    if (cid && regionId) {
      rows = await db.select().from(branchesTable)
        .where(and(eq(branchesTable.companyId, cid), eq(branchesTable.regionId, regionId)))
        .orderBy(asc(branchesTable.code));
    } else if (cid) {
      rows = await db.select().from(branchesTable)
        .where(eq(branchesTable.companyId, cid))
        .orderBy(asc(branchesTable.code));
    } else {
      rows = await db.select().from(branchesTable).orderBy(asc(branchesTable.code));
    }

    // attach region name
    const regionIds = [...new Set(rows.map((r: any) => r.regionId).filter(Boolean))];
    const regionMap: Record<number, any> = {};
    if (regionIds.length > 0) {
      const regions = await db.select().from(regionsTable);
      for (const rg of regions) regionMap[rg.id] = rg;
    }
    const result = rows.map((r: any) => ({ ...r, region: r.regionId ? regionMap[r.regionId] ?? null : null }));
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// CREATE branch
router.post("/branches", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { code, nameAr, nameEn, regionId, city, address, phone, email, isMain, status, notes } = req.body;
    if (!code || !nameAr) { res.status(400).json({ error: "الكود والاسم مطلوبان" }); return; }
    // if isMain, unset other main branches
    if (isMain) {
      await db.update(branchesTable).set({ isMain: false })
        .where(eq(branchesTable.companyId, cid));
    }
    const [row] = await db.insert(branchesTable).values({
      companyId: cid, code, nameAr, nameEn: nameEn || null,
      regionId:  regionId || null,
      city:      city || null, address: address || null,
      phone:     phone || null, email: email || null,
      isMain:    isMain ?? false,
      status:    status ?? "active",
      notes:     notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// UPDATE branch
router.put("/branches/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const { code, nameAr, nameEn, regionId, city, address, phone, email, isMain, status, notes } = req.body;
    if (isMain) {
      await db.update(branchesTable).set({ isMain: false })
        .where(and(eq(branchesTable.companyId, cid)));
    }
    const [row] = await db.update(branchesTable).set({
      code, nameAr, nameEn: nameEn || null,
      regionId: regionId || null,
      city: city || null, address: address || null,
      phone: phone || null, email: email || null,
      isMain: isMain ?? false, status: status ?? "active",
      notes: notes || null, updatedAt: new Date(),
    }).where(and(eq(branchesTable.id, id), eq(branchesTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الفرع غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE branch
router.delete("/branches/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    await db.delete(branchesTable).where(and(eq(branchesTable.id, id), eq(branchesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
