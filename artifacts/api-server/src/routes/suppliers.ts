import { Router } from "express";
import { db } from "@workspace/db";
import { suppliersTable, purchaseInvoicesTable, purchaseReturnsTable, supplierSettlementsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

router.get("/", async (req, res) => {
  const rawCompanyId = req.query.companyId ? parseInt(req.query.companyId as string) : undefined;
  const companyId = resolveCompanyId(req, rawCompanyId);
  const query = companyId
    ? db.select().from(suppliersTable).where(eq(suppliersTable.companyId, companyId))
    : db.select().from(suppliersTable);
  const suppliers = await query;
  res.json(suppliers);
});

/* GET /api/suppliers/balances?companyId=X
   Returns [{ supplierId, invoicesTotal, returnsTotal, settlementsTotal, balance }] */
router.get("/balances", async (req, res) => {
  const rawCompanyId = req.query.companyId ? parseInt(req.query.companyId as string) : undefined;
  const companyId = resolveCompanyId(req, rawCompanyId);
  if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  const [invRows, retRows, setRows] = await Promise.all([
    db
      .select({
        supplierId: purchaseInvoicesTable.supplierId,
        total: sql<string>`coalesce(sum(${purchaseInvoicesTable.totalAmount}),0)`,
      })
      .from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.companyId, companyId), eq(purchaseInvoicesTable.status, "posted")))
      .groupBy(purchaseInvoicesTable.supplierId),

    db
      .select({
        supplierId: purchaseReturnsTable.supplierId,
        total: sql<string>`coalesce(sum(${purchaseReturnsTable.totalAmount}),0)`,
      })
      .from(purchaseReturnsTable)
      .where(and(eq(purchaseReturnsTable.companyId, companyId), eq(purchaseReturnsTable.status, "posted")))
      .groupBy(purchaseReturnsTable.supplierId),

    db
      .select({
        supplierId: supplierSettlementsTable.supplierId,
        total: sql<string>`coalesce(sum(${supplierSettlementsTable.amount}),0)`,
      })
      .from(supplierSettlementsTable)
      .where(eq(supplierSettlementsTable.companyId, companyId))
      .groupBy(supplierSettlementsTable.supplierId),
  ]);

  const invMap  = Object.fromEntries(invRows.map(r => [r.supplierId, parseFloat(r.total)]));
  const retMap  = Object.fromEntries(retRows.map(r => [r.supplierId, parseFloat(r.total)]));
  const setMap  = Object.fromEntries(setRows.map(r => [r.supplierId, parseFloat(r.total)]));

  const suppliers = await db.select({ id: suppliersTable.id })
    .from(suppliersTable).where(eq(suppliersTable.companyId, companyId));

  const result = suppliers.map(s => {
    const inv = invMap[s.id]  ?? 0;
    const ret = retMap[s.id]  ?? 0;
    const set = setMap[s.id]  ?? 0;
    const balance = inv - ret - set;
    return { supplierId: s.id, invoicesTotal: inv, returnsTotal: ret, settlementsTotal: set, balance };
  });

  res.json(result);
});

router.post("/", async (req, res) => {
  const data = req.body;
  if (!data.nameAr) { res.status(400).json({ error: "اسم المورد مطلوب" }); return; }
  const companyId = resolveCompanyId(req, data.companyId ? parseInt(data.companyId) : undefined);
  if (!companyId) { res.status(400).json({ error: "معرّف الشركة مطلوب" }); return; }
  const [supplier] = await db.insert(suppliersTable).values({
    companyId,
    nameAr: data.nameAr,
    nameEn: data.nameEn ?? null,
    vatNumber: data.vatNumber ?? null,
    crNumber: data.crNumber ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    city: data.city ?? null,
    district: data.district ?? null,
    street: data.street ?? null,
    buildingNumber: data.buildingNumber ?? null,
    postalCode: data.postalCode ?? null,
    country: data.country ?? "SA",
  }).returning();
  res.status(201).json(supplier);
});

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [supplier] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
  if (!supplier) { res.status(404).json({ error: "المورد غير موجود" }); return; }
  const companyId = resolveCompanyId(req, supplier.companyId);
  if (companyId && supplier.companyId !== companyId) { res.status(403).json({ error: "غير مصرح" }); return; }
  res.json(supplier);
});

router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
  if (!existing) { res.status(404).json({ error: "المورد غير موجود" }); return; }
  const companyId = resolveCompanyId(req, existing.companyId);
  if (companyId && existing.companyId !== companyId) { res.status(403).json({ error: "غير مصرح" }); return; }
  const data = req.body;
  const [supplier] = await db.update(suppliersTable).set({
    nameAr: data.nameAr,
    nameEn: data.nameEn ?? null,
    vatNumber: data.vatNumber ?? null,
    crNumber: data.crNumber ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    city: data.city ?? null,
    district: data.district ?? null,
    street: data.street ?? null,
    buildingNumber: data.buildingNumber ?? null,
    postalCode: data.postalCode ?? null,
    country: data.country ?? "SA",
  }).where(eq(suppliersTable.id, id)).returning();
  if (!supplier) { res.status(404).json({ error: "المورد غير موجود" }); return; }
  res.json(supplier);
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
  if (!existing) { res.status(404).json({ error: "المورد غير موجود" }); return; }
  const companyId = resolveCompanyId(req, existing.companyId);
  if (companyId && existing.companyId !== companyId) { res.status(403).json({ error: "غير مصرح" }); return; }
  await db.delete(suppliersTable).where(eq(suppliersTable.id, id));
  res.status(204).send();
});

export default router;
