import { Router } from "express";
import { db } from "@workspace/db";
import { cashTransfersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { nextSequenceOrFallback } from "../lib/sequences.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("cash_boxes"));
router.use(moduleAudit("cash_boxes"));

router.get("/", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  const rows = cid
    ? await db.select().from(cashTransfersTable)
        .where(eq(cashTransfersTable.companyId, cid))
        .orderBy(desc(cashTransfersTable.createdAt))
    : await db.select().from(cashTransfersTable).orderBy(desc(cashTransfersTable.createdAt));
  res.json(rows);
});

router.get("/:id", async (req, res) => {
  const [row] = await db.select().from(cashTransfersTable)
    .where(eq(cashTransfersTable.id, parseInt(req.params.id)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.post("/", async (req, res) => {
  const d = req.body;
  const cid = resolveCompanyId(req, d.companyId ? parseInt(d.companyId) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  const code = d.code || await nextSequenceOrFallback(
    cid,
    "cash_transfer",
    { userId: (req as any).authUser?.id ?? null, refTable: "cash_transfers" },
    async () => {
      const existing = await db.select({ id: cashTransfersTable.id })
        .from(cashTransfersTable).where(eq(cashTransfersTable.companyId, cid));
      return `TR-${String(existing.length + 1).padStart(4, "0")}`;
    },
  );

  const [row] = await db.insert(cashTransfersTable).values({
    companyId:     cid,
    code,
    date:          d.date          || new Date().toISOString().slice(0, 10),
    transferType:  d.transferType  || "cash_to_bank",
    fromCashBoxId: d.fromCashBoxId ? parseInt(d.fromCashBoxId) : null,
    fromBankId:    d.fromBankId    ? parseInt(d.fromBankId)    : null,
    toCashBoxId:   d.toCashBoxId   ? parseInt(d.toCashBoxId)   : null,
    toBankId:      d.toBankId      ? parseInt(d.toBankId)      : null,
    amount:        d.amount        || "0",
    currencyId:    d.currencyId    ? parseInt(d.currencyId)    : null,
    exchangeRate:  d.exchangeRate  || "1",
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
    status:        "draft",
  }).returning();
  res.status(201).json(row);
});

router.put("/:id", async (req, res) => {
  const d = req.body;
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(cashTransfersTable).where(eq(cashTransfersTable.id, id));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن تعديل تحويل مرحّل" }); return; }

  const [row] = await db.update(cashTransfersTable).set({
    date:          d.date,
    transferType:  d.transferType,
    fromCashBoxId: d.fromCashBoxId ? parseInt(d.fromCashBoxId) : null,
    fromBankId:    d.fromBankId    ? parseInt(d.fromBankId)    : null,
    toCashBoxId:   d.toCashBoxId   ? parseInt(d.toCashBoxId)   : null,
    toBankId:      d.toBankId      ? parseInt(d.toBankId)      : null,
    amount:        d.amount,
    currencyId:    d.currencyId    ? parseInt(d.currencyId)    : null,
    exchangeRate:  d.exchangeRate  || "1",
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
  }).where(eq(cashTransfersTable.id, id)).returning();
  res.json(row);
});

router.post("/:id/post", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(cashTransfersTable).where(eq(cashTransfersTable.id, id));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "مرحّل مسبقاً" }); return; }
  if (!existing.amount || parseFloat(existing.amount) <= 0) {
    res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر" }); return;
  }
  const [row] = await db.update(cashTransfersTable)
    .set({ status: "posted" })
    .where(eq(cashTransfersTable.id, id)).returning();
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  const [existing] = await db.select().from(cashTransfersTable)
    .where(eq(cashTransfersTable.id, parseInt(req.params.id)));
  if (existing?.status === "posted") { res.status(400).json({ error: "لا يمكن حذف تحويل مرحّل" }); return; }
  await db.delete(cashTransfersTable).where(eq(cashTransfersTable.id, parseInt(req.params.id)));
  res.status(204).send();
});

export default router;
