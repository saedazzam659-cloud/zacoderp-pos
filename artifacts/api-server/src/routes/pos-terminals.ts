import { Router } from "express";
import { db } from "@workspace/db";
import {
  posTerminalsTable,
  posSessionsTable,
  branchesTable,
  cashBoxesTable,
} from "@workspace/db";
import { and, eq, asc, ne, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

// Hard auth gate: every endpoint here requires a real authenticated user.
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرّح" }); return; }
  next();
});

// Read endpoints: any authenticated user in the company may list terminals
// (the cashier login picker calls this). Mutating endpoints additionally
// require admin or superadmin (enforced by `requireAdmin`).
function requireAdmin(req: any, res: any, next: any) {
  const role = req.authUser?.role;
  if (role !== "admin" && role !== "superadmin") {
    res.status(403).json({ error: "تتطلب هذه العملية صلاحية مدير" });
    return;
  }
  next();
}

function getCid(req: any, res: any): number | null {
  // Honor query `companyId` for superadmin (multi-tenant admin), otherwise
  // fall back to the caller's own company.
  const queryCid = req.query.companyId ? Number(req.query.companyId) : undefined;
  const bodyCid  = req.body?.companyId ? Number(req.body.companyId)  : undefined;
  const cid = resolveCompanyId(req, queryCid ?? bodyCid ?? req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Validate that branchId/cashBoxId (if provided) belong to the same company.
// Prevents cross-tenant linkage corruption.
async function validateOwnership(cid: number, branchId?: number | null, cashBoxId?: number | null): Promise<string | null> {
  if (branchId) {
    const [b] = await db.select({ id: branchesTable.id })
      .from(branchesTable)
      .where(and(eq(branchesTable.id, branchId), eq(branchesTable.companyId, cid)))
      .limit(1);
    if (!b) return "الفرع غير موجود في هذه الشركة";
  }
  if (cashBoxId) {
    const [c] = await db.select({ id: cashBoxesTable.id })
      .from(cashBoxesTable)
      .where(and(eq(cashBoxesTable.id, cashBoxId), eq(cashBoxesTable.companyId, cid)))
      .limit(1);
    if (!c) return "الصندوق النقدي غير موجود في هذه الشركة";
  }
  return null;
}

async function nextCode(cid: number): Promise<string> {
  const rows = await db.select({ code: posTerminalsTable.code })
    .from(posTerminalsTable)
    .where(eq(posTerminalsTable.companyId, cid));
  let max = 0;
  const re = /^T-(\d+)$/i;
  for (const r of rows) {
    const m = re.exec(r.code ?? "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `T-${String(max + 1).padStart(3, "0")}`;
}

// ─── GET /pos-terminals ─────────────────────────────────────────────────────
// List terminals (optionally filter by branch / activeOnly).
router.get("/", async (req, res) => {
  const cid = getCid(req, res); if (!cid) return;
  const branchId  = req.query.branchId  ? Number(req.query.branchId)  : null;
  const activeOnly = req.query.activeOnly === "1" || req.query.activeOnly === "true";

  const conds = [eq(posTerminalsTable.companyId, cid)];
  if (branchId) conds.push(eq(posTerminalsTable.branchId, branchId));
  if (activeOnly) conds.push(eq(posTerminalsTable.isActive, true));

  const rows = await db
    .select({
      id:          posTerminalsTable.id,
      code:        posTerminalsTable.code,
      nameAr:      posTerminalsTable.nameAr,
      nameEn:      posTerminalsTable.nameEn,
      branchId:    posTerminalsTable.branchId,
      branchName:  branchesTable.nameAr,
      machineCode: posTerminalsTable.machineCode,
      cashBoxId:   posTerminalsTable.cashBoxId,
      cashBoxName: cashBoxesTable.nameAr,
      isActive:    posTerminalsTable.isActive,
      notes:       posTerminalsTable.notes,
    })
    .from(posTerminalsTable)
    .leftJoin(branchesTable,  eq(branchesTable.id,  posTerminalsTable.branchId))
    .leftJoin(cashBoxesTable, eq(cashBoxesTable.id, posTerminalsTable.cashBoxId))
    .where(and(...conds))
    .orderBy(asc(posTerminalsTable.code));

  // Annotate "in-use" (currently occupied by an open session).
  const openSessions = await db
    .select({ posTerminalId: posSessionsTable.posTerminalId, userId: posSessionsTable.userId })
    .from(posSessionsTable)
    .where(and(eq(posSessionsTable.companyId, cid), eq(posSessionsTable.status, "open")));
  const busy = new Map<number, number>();
  for (const s of openSessions) if (s.posTerminalId) busy.set(s.posTerminalId, s.userId);

  res.json(rows.map(r => ({ ...r, busyUserId: busy.get(r.id) ?? null })));
});

// ─── POST /pos-terminals ────────────────────────────────────────────────────
router.post("/", requireAdmin, async (req, res) => {
  const cid = getCid(req, res); if (!cid) return;
  const { code, nameAr, nameEn, branchId, machineCode, cashBoxId, isActive, notes } = req.body ?? {};
  if (!nameAr || !branchId) {
    res.status(400).json({ error: "الاسم والفرع مطلوبان" }); return;
  }
  const ownErr = await validateOwnership(cid, Number(branchId), cashBoxId ? Number(cashBoxId) : null);
  if (ownErr) { res.status(400).json({ error: ownErr }); return; }
  const finalCode = (code && String(code).trim()) || (await nextCode(cid));
  try {
    const [row] = await db.insert(posTerminalsTable).values({
      companyId:   cid,
      code:        finalCode,
      nameAr:      String(nameAr).trim(),
      nameEn:      nameEn ? String(nameEn).trim() : null,
      branchId:    Number(branchId),
      machineCode: machineCode ? String(machineCode).trim() : null,
      cashBoxId:   cashBoxId ? Number(cashBoxId) : null,
      isActive:    isActive !== false,
      notes:       notes ? String(notes) : null,
    }).returning();
    res.json(row);
  } catch (e: any) {
    if (String(e?.message ?? "").includes("pos_terminals_company_code_uniq")) {
      res.status(409).json({ error: "الكود مستخدم بالفعل" }); return;
    }
    res.status(500).json({ error: e?.message ?? "فشل الحفظ" });
  }
});

// ─── PATCH /pos-terminals/:id ───────────────────────────────────────────────
router.patch("/:id", requireAdmin, async (req, res) => {
  const cid = getCid(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { code, nameAr, nameEn, branchId, machineCode, cashBoxId, isActive, notes } = req.body ?? {};

  if (branchId !== undefined || cashBoxId !== undefined) {
    const ownErr = await validateOwnership(
      cid,
      branchId  !== undefined ? (branchId  ? Number(branchId)  : null) : null,
      cashBoxId !== undefined ? (cashBoxId ? Number(cashBoxId) : null) : null,
    );
    if (ownErr) { res.status(400).json({ error: ownErr }); return; }
  }

  const patch: Record<string, any> = { updatedAt: new Date() };
  if (code        !== undefined) patch.code        = String(code).trim();
  if (nameAr      !== undefined) patch.nameAr      = String(nameAr).trim();
  if (nameEn      !== undefined) patch.nameEn      = nameEn ? String(nameEn).trim() : null;
  if (branchId    !== undefined) patch.branchId    = Number(branchId);
  if (machineCode !== undefined) patch.machineCode = machineCode ? String(machineCode).trim() : null;
  if (cashBoxId   !== undefined) patch.cashBoxId   = cashBoxId ? Number(cashBoxId) : null;
  if (isActive    !== undefined) patch.isActive    = !!isActive;
  if (notes       !== undefined) patch.notes       = notes ? String(notes) : null;

  try {
    const [row] = await db.update(posTerminalsTable)
      .set(patch)
      .where(and(eq(posTerminalsTable.id, id), eq(posTerminalsTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json(row);
  } catch (e: any) {
    if (String(e?.message ?? "").includes("pos_terminals_company_code_uniq")) {
      res.status(409).json({ error: "الكود مستخدم بالفعل" }); return;
    }
    res.status(500).json({ error: e?.message ?? "فشل التحديث" });
  }
});

// ─── DELETE /pos-terminals/:id ──────────────────────────────────────────────
// Refuses to delete a terminal that has any sessions (open or historical).
router.delete("/:id", requireAdmin, async (req, res) => {
  const cid = getCid(req, res); if (!cid) return;
  const id = Number(req.params.id);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(posSessionsTable)
    .where(and(eq(posSessionsTable.companyId, cid), eq(posSessionsTable.posTerminalId, id)));
  if (Number(count) > 0) {
    res.status(409).json({ error: "لا يمكن حذف محطة مرتبطة بجلسات سابقة. يمكنك تعطيلها بدلاً من ذلك." });
    return;
  }
  await db.delete(posTerminalsTable)
    .where(and(eq(posTerminalsTable.id, id), eq(posTerminalsTable.companyId, cid)));
  res.json({ ok: true });
});

// ─── POST /pos-terminals/:id/unpair ─────────────────────────────────────────
// Clear the machineCode binding so a different physical device can claim it.
router.post("/:id/unpair", requireAdmin, async (req, res) => {
  const cid = getCid(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [row] = await db.update(posTerminalsTable)
    .set({ machineCode: null, updatedAt: new Date() })
    .where(and(eq(posTerminalsTable.id, id), eq(posTerminalsTable.companyId, cid)))
    .returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

export default router;
