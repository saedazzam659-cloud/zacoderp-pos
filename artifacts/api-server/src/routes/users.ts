import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, userBranchesTable, branchesTable } from "@workspace/db";
import { eq, and, asc, ne, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

function guard(req: any, res: any): number | null {
  // For superadmin, prefer the explicit ?companyId=N query (or body) so they
  // can manage users across companies — needed by the Security Center
  // permissions matrix click-through. resolveCompanyId already enforces that
  // non-superadmin callers are pinned to their own company regardless of any
  // companyId they pass in the request.
  const queryCid = req.query?.companyId != null ? Number(req.query.companyId) : undefined;
  const bodyCid  = req.body?.companyId  != null ? Number(req.body.companyId)  : undefined;
  const candidate = (Number.isFinite(queryCid) ? queryCid : undefined)
    ?? (Number.isFinite(bodyCid) ? bodyCid : undefined)
    ?? req.authUser?.companyId
    ?? undefined;
  const cid = resolveCompanyId(req, candidate);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return null; }
  return cid;
}

// Only admin (and superadmin) of a company can manage users
function requireAdmin(req: any, res: any): boolean {
  const role = req.authUser?.role;
  if (role !== "admin" && role !== "superadmin") {
    res.status(403).json({ error: "صلاحيات غير كافية" });
    return false;
  }
  return true;
}

// ─── List users (with branch ids) ────────────────────────────────
router.get("/", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select({
      id: usersTable.id,
      username: usersTable.username,
      email: usersTable.email,
      role: usersTable.role,
      code: usersTable.code,
      nameAr: usersTable.nameAr,
      nameEn: usersTable.nameEn,
      permissions: usersTable.permissions,
      viewAllBranches: usersTable.viewAllBranches,
      isActive: usersTable.isActive,
      lastLoginAt: usersTable.lastLoginAt,
      createdAt: usersTable.createdAt,
    }).from(usersTable)
      .where(eq(usersTable.companyId, cid))
      .orderBy(asc(usersTable.id));

    // Attach branchIds in one query (tenant-scoped via company filter on users)
    const ids = rows.map(r => r.id);
    const branchLinks = ids.length
      ? await db.select().from(userBranchesTable).where(inArray(userBranchesTable.userId, ids))
      : [];
    const byUser = new Map<number, number[]>();
    branchLinks.forEach(l => {
      if (!byUser.has(l.userId)) byUser.set(l.userId, []);
      byUser.get(l.userId)!.push(l.branchId);
    });

    res.json(rows.map(r => ({ ...r, branchIds: byUser.get(r.id) ?? [] })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Get single user ─────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [u] = await db.select().from(usersTable)
      .where(and(eq(usersTable.id, id), eq(usersTable.companyId, cid)));
    if (!u) { res.status(404).json({ error: "غير موجود" }); return; }
    const links = await db.select().from(userBranchesTable).where(eq(userBranchesTable.userId, id));
    const { passwordHash: _ph, sessionToken: _st, sessionId: _si, ...safe } = u as any;
    res.json({ ...safe, branchIds: links.map(l => l.branchId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Create user ─────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const {
      username, password, email, role, code, nameAr, nameEn,
      isActive, branchIds, permissions, viewAllBranches,
    } = req.body ?? {};
    if (!username || !password) { res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" }); return; }
    if (String(password).length < 6) { res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" }); return; }

    // Username uniqueness (global — username column is unique)
    const [exists] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username));
    if (exists) { res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل" }); return; }

    const passwordHash = await bcrypt.hash(String(password), 12);

    // Validate branchIds belong to this company
    let validBranchIds: number[] = [];
    if (Array.isArray(branchIds) && branchIds.length) {
      const ok = await db.select({ id: branchesTable.id }).from(branchesTable)
        .where(and(eq(branchesTable.companyId, cid), inArray(branchesTable.id, branchIds.map(Number))));
      validBranchIds = ok.map(b => b.id);
    }

    const newRole = role && ["admin", "user"].includes(role) ? role : "user";

    const [created] = await db.insert(usersTable).values({
      username,
      email: email || null,
      passwordHash,
      companyId: cid,
      role: newRole,
      code: code || null,
      nameAr: nameAr || null,
      nameEn: nameEn || null,
      permissions: permissions ?? null,
      // Default true if not provided (matches the column default).
      viewAllBranches: typeof viewAllBranches === "boolean" ? viewAllBranches : true,
      isActive: isActive !== false,
    }).returning();

    if (validBranchIds.length) {
      await db.insert(userBranchesTable).values(
        validBranchIds.map(bid => ({ userId: created.id, branchId: bid }))
      );
    }

    const { passwordHash: _ph, sessionToken: _st, sessionId: _si, ...safe } = created as any;
    res.status(201).json({ ...safe, branchIds: validBranchIds });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Update user ─────────────────────────────────────────────────
router.patch("/:id", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [existing] = await db.select().from(usersTable)
      .where(and(eq(usersTable.id, id), eq(usersTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }

    const {
      password, email, role, code, nameAr, nameEn,
      isActive, branchIds, permissions, viewAllBranches,
    } = req.body ?? {};

    const update: any = { updatedAt: new Date() };
    if (email !== undefined) update.email = email || null;
    if (role && ["admin", "user"].includes(role) && existing.role !== "superadmin") update.role = role;
    if (code !== undefined) update.code = code || null;
    if (nameAr !== undefined) update.nameAr = nameAr || null;
    if (nameEn !== undefined) update.nameEn = nameEn || null;
    if (typeof isActive === "boolean") update.isActive = isActive;
    if (typeof viewAllBranches === "boolean") update.viewAllBranches = viewAllBranches;
    if (permissions !== undefined) update.permissions = permissions;
    if (password) {
      if (String(password).length < 6) { res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" }); return; }
      update.passwordHash = await bcrypt.hash(String(password), 12);
    }

    await db.update(usersTable).set(update).where(eq(usersTable.id, id));

    if (Array.isArray(branchIds)) {
      // Validate scope
      const valid = branchIds.length
        ? (await db.select({ id: branchesTable.id }).from(branchesTable)
            .where(and(eq(branchesTable.companyId, cid), inArray(branchesTable.id, branchIds.map(Number))))
          ).map(b => b.id)
        : [];
      await db.delete(userBranchesTable).where(eq(userBranchesTable.userId, id));
      if (valid.length) {
        await db.insert(userBranchesTable).values(valid.map(bid => ({ userId: id, branchId: bid })));
      }
    }

    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Delete user ─────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // Don't allow deleting yourself
    if (req.authUser?.id === id) {
      res.status(400).json({ error: "لا يمكنك حذف حسابك الحالي" });
      return;
    }
    const [existing] = await db.select({ id: usersTable.id, role: usersTable.role })
      .from(usersTable)
      .where(and(eq(usersTable.id, id), eq(usersTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
    if (existing.role === "superadmin") {
      res.status(403).json({ error: "لا يمكن حذف مستخدم النظام الرئيسي" });
      return;
    }
    await db.delete(usersTable).where(and(eq(usersTable.id, id), eq(usersTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
