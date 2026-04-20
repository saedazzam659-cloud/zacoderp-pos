import { Router } from "express";
import { db } from "@workspace/db";
import { paymentVouchersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

router.get("/", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  const rows = cid
    ? await db.select().from(paymentVouchersTable)
        .where(eq(paymentVouchersTable.companyId, cid))
        .orderBy(desc(paymentVouchersTable.createdAt))
    : await db.select().from(paymentVouchersTable).orderBy(desc(paymentVouchersTable.createdAt));
  res.json(rows);
});

router.get("/:id", async (req, res) => {
  const [row] = await db.select().from(paymentVouchersTable)
    .where(eq(paymentVouchersTable.id, parseInt(req.params.id)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.post("/", async (req, res) => {
  const d = req.body;
  const cid = resolveCompanyId(req, d.companyId ? parseInt(d.companyId) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  const existing = await db.select({ id: paymentVouchersTable.id })
    .from(paymentVouchersTable).where(eq(paymentVouchersTable.companyId, cid));
  const code = d.code || `PV-${String(existing.length + 1).padStart(4, "0")}`;

  const [row] = await db.insert(paymentVouchersTable).values({
    companyId:     cid,
    branchId:      d.branchId      ? parseInt(d.branchId)      : null,
    code,
    date:          d.date          || new Date().toISOString().slice(0, 10),
    paymentType:   d.paymentType   || "cash",
    cashBoxId:     d.cashBoxId     ? parseInt(d.cashBoxId)     : null,
    bankAccountId: d.bankAccountId ? parseInt(d.bankAccountId) : null,
    entityType:    d.entityType    || "supplier",
    entityId:      d.entityId      ? parseInt(d.entityId)      : null,
    entityName:    d.entityName    ?? null,
    accountId:     d.accountId     ? parseInt(d.accountId)     : null,
    amount:        d.amount        || "0",
    currencyId:    d.currencyId    ? parseInt(d.currencyId)    : null,
    exchangeRate:  d.exchangeRate  || "1",
    refType:       d.refType       ?? null,
    refNumber:     d.refNumber     ?? null,
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
    status:        "draft",
  }).returning();
  res.status(201).json(row);
});

router.put("/:id", async (req, res) => {
  const d = req.body;
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(paymentVouchersTable).where(eq(paymentVouchersTable.id, id));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن تعديل سند مرحّل" }); return; }

  const [row] = await db.update(paymentVouchersTable).set({
    branchId:      d.branchId      ? parseInt(d.branchId)      : null,
    date:          d.date,
    paymentType:   d.paymentType,
    cashBoxId:     d.cashBoxId     ? parseInt(d.cashBoxId)     : null,
    bankAccountId: d.bankAccountId ? parseInt(d.bankAccountId) : null,
    entityType:    d.entityType,
    entityId:      d.entityId      ? parseInt(d.entityId)      : null,
    entityName:    d.entityName    ?? null,
    accountId:     d.accountId     ? parseInt(d.accountId)     : null,
    amount:        d.amount,
    currencyId:    d.currencyId    ? parseInt(d.currencyId)    : null,
    exchangeRate:  d.exchangeRate  || "1",
    refType:       d.refType       ?? null,
    refNumber:     d.refNumber     ?? null,
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
  }).where(eq(paymentVouchersTable.id, id)).returning();
  res.json(row);
});

router.post("/:id/post", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(paymentVouchersTable).where(eq(paymentVouchersTable.id, id));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "مرحّل مسبقاً" }); return; }
  if (!existing.amount || parseFloat(existing.amount) <= 0) {
    res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر" }); return;
  }
  const [row] = await db.update(paymentVouchersTable)
    .set({ status: "posted" })
    .where(eq(paymentVouchersTable.id, id)).returning();
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  const [existing] = await db.select().from(paymentVouchersTable)
    .where(eq(paymentVouchersTable.id, parseInt(req.params.id)));
  if (existing?.status === "posted") { res.status(400).json({ error: "لا يمكن حذف سند مرحّل" }); return; }
  await db.delete(paymentVouchersTable).where(eq(paymentVouchersTable.id, parseInt(req.params.id)));
  res.status(204).send();
});

export default router;
