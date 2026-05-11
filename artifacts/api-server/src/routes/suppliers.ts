import { Router } from "express";
import { db } from "@workspace/db";
import { suppliersTable, purchaseInvoicesTable, purchaseReturnsTable, supplierSettlementsTable,
  journalEntriesTable, journalEntryLinesTable } from "@workspace/db";
import { eq, and, sql, inArray, notInArray, isNotNull } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { ensureSupplierLedger } from "../lib/entityAccounts.js";

// Auto-create a sub-account under the "Accounts Payable — Suppliers" parent.
// Delegates to the shared entity-account helper which reads the parent
// from the Account Mapping screen (entity_account_parents.supplier_account_parent)
// and falls back to code-prefix / name-like lookup when the mapping isn't set.
async function ensureSupplierAccount(companyId: number, supplierName: string): Promise<number | null> {
  return ensureSupplierLedger(companyId, supplierName);
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

  // Suppliers with their AP account ids (for direct-JE aggregation below).
  const supplierRows = await db.select({ id: suppliersTable.id, accountId: suppliersTable.accountId })
    .from(suppliersTable).where(eq(suppliersTable.companyId, companyId));
  const accIdToSupplier = new Map<number, number>();
  for (const s of supplierRows) if (s.accountId != null) accIdToSupplier.set(s.accountId, s.id);
  const supplierAccIds: number[] = Array.from(accIdToSupplier.keys());

  const [invRows, lcInvRows, retRows, setRows, jeRows] = await Promise.all([
    // Regular (non-LC) posted invoices — these accrue against supplier balance.
    db
      .select({
        supplierId: purchaseInvoicesTable.supplierId,
        total: sql<string>`coalesce(sum(${purchaseInvoicesTable.totalAmount}),0)`,
      })
      .from(purchaseInvoicesTable)
      .where(and(
        eq(purchaseInvoicesTable.companyId, companyId),
        eq(purchaseInvoicesTable.status, "posted"),
        sql`${purchaseInvoicesTable.lcId} IS NULL`,
      ))
      .groupBy(purchaseInvoicesTable.supplierId),

    // LC-linked posted invoices — supplier was already paid through the
    // Letter of Credit (margin / bank transfer), so they MUST NOT inflate
    // the supplier's balance. We surface the total separately for the UI
    // (informational column) but it does NOT enter the `balance` formula.
    db
      .select({
        supplierId: purchaseInvoicesTable.supplierId,
        total: sql<string>`coalesce(sum(${purchaseInvoicesTable.totalAmount}),0)`,
      })
      .from(purchaseInvoicesTable)
      .where(and(
        eq(purchaseInvoicesTable.companyId, companyId),
        eq(purchaseInvoicesTable.status, "posted"),
        sql`${purchaseInvoicesTable.lcId} IS NOT NULL`,
      ))
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

    // Direct JE postings to supplier AP accounts that are NOT already aggregated
    // via purchase_invoices / purchase_returns / payment_vouchers. This captures:
    //   • Fixed-asset credit acquisitions (entryType = 'fa_acquisition')
    //   • Manual / opening-balance JEs (entryType = 'general' / 'trial_balance_adjustment')
    //   • Any future direct-to-AP posting source.
    // Net = credit - debit (credit increases payable, debit decreases it).
    supplierAccIds.length === 0
      ? Promise.resolve([] as { accountId: number; net: string }[])
      : db
          .select({
            accountId: journalEntryLinesTable.accountId,
            net: sql<string>`coalesce(sum(${journalEntryLinesTable.credit} - ${journalEntryLinesTable.debit}),0)`,
          })
          .from(journalEntryLinesTable)
          .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
          .where(and(
            eq(journalEntriesTable.companyId, companyId),
            eq(journalEntriesTable.status, "posted"),
            inArray(journalEntryLinesTable.accountId, supplierAccIds),
            notInArray(journalEntriesTable.entryType, [
              "purchase_invoice", "purchase_return", "payment",
              "contracting_outgoing_bill", "contracting_incoming_bill",
            ]),
          ))
          .groupBy(journalEntryLinesTable.accountId),
  ]);

  const invMap   = Object.fromEntries(invRows.map(r   => [r.supplierId, parseFloat(r.total)]));
  const lcInvMap = Object.fromEntries(lcInvRows.map(r => [r.supplierId, parseFloat(r.total)]));
  const retMap   = Object.fromEntries(retRows.map(r   => [r.supplierId, parseFloat(r.total)]));
  const setMap   = Object.fromEntries(setRows.map(r   => [r.supplierId, parseFloat(r.total)]));
  // Map JE-net (credit-debit) on supplier accountId back to supplierId.
  const jeMap: Record<number, number> = {};
  for (const r of jeRows) {
    if (r.accountId == null) continue;
    const sid = accIdToSupplier.get(r.accountId);
    if (sid) jeMap[sid] = (jeMap[sid] ?? 0) + parseFloat(r.net);
  }

  const result = supplierRows.map(s => {
    const inv   = invMap[s.id]   ?? 0;     // non-LC posted invoices
    const lcInv = lcInvMap[s.id] ?? 0;     // LC-linked posted invoices (already paid via LC)
    const ret   = retMap[s.id]   ?? 0;
    const set   = setMap[s.id]   ?? 0;
    const je    = jeMap[s.id]    ?? 0;     // direct JE postings (e.g. fixed-asset credit acquisition, manual)
    // LC-linked invoices are excluded from the balance: the supplier was
    // already paid through the Letter of Credit, so its dues are zeroed
    // by the invoice amount on the suppliers screen.
    const balance = inv - ret - set + je;
    return {
      supplierId:        s.id,
      invoicesTotal:     inv,
      lcInvoicesTotal:   lcInv,
      returnsTotal:      ret,
      settlementsTotal:  set,
      otherJeTotal:      je,
      balance,
    };
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
