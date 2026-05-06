import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { seedDefaultAccountingMappings } from "../lib/accountingMappings.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("accounts"));
router.use(moduleAudit("accounts"));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCompanyId(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

// ─── BULK IMPORT ──────────────────────────────────────────────────────────────
router.post("/bulk-import", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { accounts, mode = "append" } = req.body as { accounts: any[]; mode?: "append" | "replace" };
    if (!Array.isArray(accounts) || accounts.length === 0) {
      res.status(400).json({ error: "لا توجد حسابات للاستيراد" }); return;
    }

    if (accounts.length > 5000) {
      res.status(400).json({ error: "الحد الأقصى 5000 حساب في المرة الواحدة" }); return;
    }

    // Insert parents before children — sort by code length then code value
    const sorted = [...accounts].sort((a, b) => {
      const la = String(a.code ?? "").length, lb = String(b.code ?? "").length;
      if (la !== lb) return la - lb;
      return String(a.code ?? "").localeCompare(String(b.code ?? ""));
    });

    const validTypes      = new Set(["asset", "liability", "equity", "revenue", "expense"]);
    const validDirections = new Set(["", "balance_sheet", "income_statement"]);

    const performImport = async (tx: any) => {
      if (mode === "replace") {
        await tx.delete(accountsTable).where(eq(accountsTable.companyId, cid));
      }
      const existing = mode === "replace"
        ? []
        : await tx.select().from(accountsTable).where(eq(accountsTable.companyId, cid));
      const codeToId: Record<string, number> = {};
      for (const a of existing) codeToId[a.code] = a.id;

      let inserted = 0, updated = 0, skipped = 0;
      const errors: string[] = [];

      for (const a of sorted) {
        try {
          const code   = String(a.code ?? "").trim();
          const nameAr = String(a.nameAr ?? "").trim();
          const accountType = String(a.accountType ?? "").trim();
          if (!code || !nameAr || !accountType) { skipped++; errors.push(`سطر بدون كود/اسم/نوع: ${code || "—"}`); continue; }
          if (!validTypes.has(accountType)) { skipped++; errors.push(`${code}: نوع حساب غير صحيح (${accountType})`); continue; }

          const parentCode = a.parentCode ? String(a.parentCode).trim() : null;
          const parentId   = parentCode ? (codeToId[parentCode] ?? null) : null;
          if (parentCode && !parentId) errors.push(`${code}: لم يُعثر على الحساب الأب (${parentCode})`);

          const reportDirection = String(a.reportDirection ?? "").trim();
          if (!validDirections.has(reportDirection)) {
            errors.push(`${code}: قيمة توجيه الحساب غير صحيحة (${reportDirection}) — يجب أن تكون balance_sheet أو income_statement`);
          }
          const finalDirection = validDirections.has(reportDirection) && reportDirection !== "" ? reportDirection : null;

          if (codeToId[code]) {
            await tx.update(accountsTable).set({
              nameAr, nameEn: a.nameEn || null,
              accountType: accountType as any,
              parentId, level: a.level ?? (parentCode ? 2 : 1),
              reportDirection: finalDirection,
              isPosting: typeof a.isPosting === "boolean" ? a.isPosting : true,
              isActive:  typeof a.isActive  === "boolean" ? a.isActive  : true,
              notes: a.notes || null, updatedAt: new Date(),
            }).where(and(eq(accountsTable.companyId, cid), eq(accountsTable.code, code)));
            updated++;
          } else {
            const [row] = await tx.insert(accountsTable).values({
              companyId: cid, code, nameAr, nameEn: a.nameEn || null,
              accountType: accountType as any,
              parentId, level: a.level ?? (parentCode ? 2 : 1),
              reportDirection: finalDirection,
              isPosting: typeof a.isPosting === "boolean" ? a.isPosting : true,
              isActive:  typeof a.isActive  === "boolean" ? a.isActive  : true,
              notes: a.notes || null,
            }).returning();
            codeToId[code] = row.id;
            inserted++;
          }
        } catch (err: any) {
          errors.push(`${a.code || "—"}: ${err.message}`);
          skipped++;
        }
      }
      return { inserted, updated, skipped, errors };
    };

    // Wrap in a transaction for replace mode (atomic delete + insert).
    const result = mode === "replace"
      ? await db.transaction(async (tx) => performImport(tx))
      : await performImport(db);

    // Auto-seed the canonical accounting-mapping template right after the
    // COA lands.  The seed helper is purely additive (overwrite=false) so
    // re-imports never clobber tweaks the user already made.  If the helper
    // fails for any reason we log and carry on — a missing default mapping
    // never justifies failing a successful 1000-account import.
    let mappingsAutoSeeded = 0;
    try {
      const r = await seedDefaultAccountingMappings(cid);
      mappingsAutoSeeded = r.inserted + r.updated;
    } catch (e: any) {
      console.error(`[accounts.bulk-import] default-mappings seed failed for company ${cid}:`, e?.message);
    }

    res.json({
      ...result,
      total: accounts.length,
      errors: result.errors.slice(0, 25),
      mappingsAutoSeeded,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

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
    const { code, nameAr, nameEn, accountType, parentId, level, isPosting, isActive, notes, costCenterId } = req.body;
    if (!code || !nameAr || !accountType) {
      res.status(400).json({ error: "كود الحساب واسمه ونوعه مطلوبة" }); return;
    }
    const [row] = await db.insert(accountsTable).values({
      companyId: cid, code, nameAr, nameEn: nameEn || null,
      accountType, parentId: parentId || null,
      reportDirection: req.body.reportDirection || null,
      level: level ?? 1, isPosting: isPosting ?? true, isActive: isActive ?? true,
      costCenterId: costCenterId ? Number(costCenterId) : null,
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
    const { code, nameAr, nameEn, accountType, parentId, level, isPosting, isActive, notes, costCenterId } = req.body;
    const [row] = await db.update(accountsTable).set({
      code, nameAr, nameEn: nameEn || null, accountType,
      parentId: parentId || null, level: level ?? 1,
      reportDirection: req.body.reportDirection || null,
      isPosting: isPosting ?? true, isActive: isActive ?? true,
      costCenterId: costCenterId ? Number(costCenterId) : null,
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
