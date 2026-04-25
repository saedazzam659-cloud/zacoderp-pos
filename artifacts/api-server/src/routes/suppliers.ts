import { Router } from "express";
import { db } from "@workspace/db";
import { suppliersTable, purchaseInvoicesTable, purchaseReturnsTable, supplierSettlementsTable, accountsTable } from "@workspace/db";
import { eq, and, sql, like, or } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

// Auto-create a sub-account under the "Accounts Payable — Suppliers" parent.
// Returns the new account id, or null if no suitable parent exists.
async function ensureSupplierAccount(companyId: number, supplierName: string): Promise<number | null> {
  // 1) Find parent: prefer code starting with '2110', else any liability account whose name contains "موردين"/"suppli"/"payab".
  const candidates = await db.select().from(accountsTable)
    .where(and(
      eq(accountsTable.companyId, companyId),
      eq(accountsTable.accountType, "liability"),
      or(
        like(accountsTable.code, "2110%"),
        like(accountsTable.nameAr, "%موردين%"),
        like(accountsTable.nameAr, "%دائن%"),
      ),
    ));
  const parent =
    candidates.find(a => a.code.startsWith("2110")) ??
    candidates.find(a => (a.nameAr || "").includes("موردين")) ??
    candidates[0];
  if (!parent) return null;

  // 2) Next sequential code under this parent: "<parentCode>-NNN"
  const siblings = await db.select({ code: accountsTable.code }).from(accountsTable)
    .where(and(eq(accountsTable.companyId, companyId), eq(accountsTable.parentId, parent.id)));
  const prefix = `${parent.code}-`;
  let maxSeq = 0;
  for (const s of siblings) {
    if (s.code.startsWith(prefix)) {
      const n = parseInt(s.code.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  const newCode = `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;

  // 3) Create sub-account (posting) and flip parent to non-posting if needed.
  const [created] = await db.insert(accountsTable).values({
    companyId,
    parentId: parent.id,
    code: newCode,
    nameAr: supplierName,
    accountType: "liability",
    reportDirection: parent.reportDirection ?? null,
    level: (parent.level ?? 1) + 1,
    isPosting: true,
    isActive: true,
  }).returning();

  if (parent.isPosting) {
    await db.update(accountsTable).set({ isPosting: false }).where(eq(accountsTable.id, parent.id));
  }
  return created?.id ?? null;
}

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("suppliers"));
router.use(moduleAudit("suppliers"));

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

  const existing = await db.select().from(suppliersTable).where(eq(suppliersTable.companyId, companyId));
  if (existing.some(s => s.nameAr?.trim().toLowerCase() === String(data.nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${data.nameAr}" مسجَّل بالفعل لمورد آخر` });
    return;
  }
  if (data.vatNumber && existing.some(s => s.vatNumber?.trim() === String(data.vatNumber).trim())) {
    res.status(409).json({ error: `الرقم الضريبي "${data.vatNumber}" مستخدم لمورد آخر` });
    return;
  }
  if (data.crNumber && existing.some(s => s.crNumber?.trim() === String(data.crNumber).trim())) {
    res.status(409).json({ error: `رقم السجل التجاري "${data.crNumber}" مستخدم لمورد آخر` });
    return;
  }
  if (data.accountId && existing.some(s => s.accountId === Number(data.accountId))) {
    res.status(409).json({ error: "هذا الحساب مرتبط بمورد آخر — اختر حساباً آخر" });
    return;
  }

  // Auto-create a sub-account under the suppliers parent if none was provided.
  let accountId: number | null = data.accountId ? Number(data.accountId) : null;
  if (!accountId) {
    try {
      accountId = await ensureSupplierAccount(companyId, String(data.nameAr).trim());
    } catch (err) {
      console.error("ensureSupplierAccount failed:", err);
      accountId = null;
    }
  }

  const [supplier] = await db.insert(suppliersTable).values({
    companyId,
    code: data.code ?? null,
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
    nationalAddressShort: data.nationalAddressShort ?? null,
    locationLat: data.locationLat ?? null,
    locationLng: data.locationLng ?? null,
    locationLink: data.locationLink ?? null,
    accountId,
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

  const others = await db.select().from(suppliersTable).where(eq(suppliersTable.companyId, existing.companyId));
  if (data.nameAr && others.some(s => s.id !== id && s.nameAr?.trim().toLowerCase() === String(data.nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${data.nameAr}" مسجَّل بالفعل لمورد آخر` });
    return;
  }
  if (data.vatNumber && others.some(s => s.id !== id && s.vatNumber?.trim() === String(data.vatNumber).trim())) {
    res.status(409).json({ error: `الرقم الضريبي "${data.vatNumber}" مستخدم لمورد آخر` });
    return;
  }
  if (data.crNumber && others.some(s => s.id !== id && s.crNumber?.trim() === String(data.crNumber).trim())) {
    res.status(409).json({ error: `رقم السجل التجاري "${data.crNumber}" مستخدم لمورد آخر` });
    return;
  }
  if (data.accountId && others.some(s => s.id !== id && s.accountId === Number(data.accountId))) {
    res.status(409).json({ error: "هذا الحساب مرتبط بمورد آخر — اختر حساباً آخر" });
    return;
  }

  const [supplier] = await db.update(suppliersTable).set({
    code: data.code ?? null,
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
    accountId: data.accountId ? Number(data.accountId) : null,
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
