import { Router } from "express";
import { db } from "@workspace/db";
import { regionsTable, branchesTable, userBranchesTable } from "@workspace/db";
import { eq, and, asc, sql, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId, getAllowedBranchIds } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("branches"));
router.use(moduleAudit("branches"));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCompanyId(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

// Auto-generate next available code (e.g. R-0001 / BR-0001) scoped to company.
async function nextCode(prefix: string, table: any, cid: number): Promise<string> {
  const re = new RegExp(`^${prefix}-(\\d+)$`, "i");
  const rows = await db.select({ code: table.code })
    .from(table).where(eq(table.companyId, cid));
  let max = 0;
  for (const r of rows) {
    const m = re.exec(r.code ?? "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
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
    const { nameAr, nameEn, notes } = req.body;
    if (!nameAr) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
    const existing = await db.select().from(regionsTable).where(eq(regionsTable.companyId, cid));
    const code = (req.body.code && String(req.body.code).trim()) ? String(req.body.code).trim() : await nextCode("R", regionsTable, cid);
    if (existing.some(r => r.code?.trim().toLowerCase() === code.toLowerCase())) {
      res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لمنطقة أخرى` }); return;
    }
    if (existing.some(r => r.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
      res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لمنطقة أخرى` }); return;
    }
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
    const others = await db.select().from(regionsTable).where(eq(regionsTable.companyId, cid));
    if (code && others.some(r => r.id !== id && r.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
      res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لمنطقة أخرى` }); return;
    }
    if (nameAr && others.some(r => r.id !== id && r.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
      res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لمنطقة أخرى` }); return;
    }
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
// Branch-level isolation: a non-admin user with viewAllBranches=false only
// ever sees branches they're explicitly linked to via user_branches. admins
// and viewAll users see every branch of the company.
router.get("/branches", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const regionId = req.query.regionId ? Number(req.query.regionId) : undefined;
    // POS / per-cashier callers pass ?onlyUserBranches=1 so we strictly filter
    // by user_branches even for admins (admins can be cashiers too, and a
    // cashier should only see the branches they're explicitly linked to).
    const onlyUserBranches = req.query.onlyUserBranches === "1" || req.query.onlyUserBranches === "true";
    let allowed = getAllowedBranchIds(req);
    if (onlyUserBranches && req.authUser) {
      const links = await db
        .select({ branchId: userBranchesTable.branchId })
        .from(userBranchesTable)
        .where(eq(userBranchesTable.userId, req.authUser.id));
      allowed = links.map(l => l.branchId);
    }

    // Restricted user with zero linked branches → return empty list immediately.
    if (allowed !== null && allowed.length === 0) {
      res.json([]); return;
    }

    const conds: any[] = [];
    if (cid)        conds.push(eq(branchesTable.companyId, cid));
    if (regionId)   conds.push(eq(branchesTable.regionId, regionId));
    if (allowed)    conds.push(inArray(branchesTable.id, allowed));

    const rows = conds.length
      ? await db.select().from(branchesTable).where(and(...conds)).orderBy(asc(branchesTable.code))
      : await db.select().from(branchesTable).orderBy(asc(branchesTable.code));

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
    const { nameAr, nameEn, regionId, city, address, phone, email, isMain, status, notes } = req.body;
    if (!nameAr) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
    const existing = await db.select().from(branchesTable).where(eq(branchesTable.companyId, cid));
    const code = (req.body.code && String(req.body.code).trim()) ? String(req.body.code).trim() : await nextCode("BR", branchesTable, cid);
    if (existing.some(b => b.code?.trim().toLowerCase() === code.toLowerCase())) {
      res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لفرع آخر` }); return;
    }
    if (existing.some(b => b.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
      res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لفرع آخر` }); return;
    }
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
    const others = await db.select().from(branchesTable).where(eq(branchesTable.companyId, cid));
    if (code && others.some(b => b.id !== id && b.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
      res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لفرع آخر` }); return;
    }
    if (nameAr && others.some(b => b.id !== id && b.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
      res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لفرع آخر` }); return;
    }
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
