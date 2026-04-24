import { Router } from "express";
import { db } from "@workspace/db";
import { customersTable, salesInvoicesTable, salesReturnsTable, receiptVouchersTable, accountsTable } from "@workspace/db";
import { and, eq, sql, like, or } from "drizzle-orm";
import { CreateCustomerBody, UpdateCustomerBody, ListCustomersQueryParams } from "@workspace/api-zod";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

// Auto-create a sub-account under the "Accounts Receivable — Customers" parent.
// Returns the new account id, or null if no suitable parent exists.
async function ensureCustomerAccount(companyId: number, customerName: string): Promise<number | null> {
  const candidates = await db.select().from(accountsTable)
    .where(and(
      eq(accountsTable.companyId, companyId),
      eq(accountsTable.accountType, "asset"),
      or(
        like(accountsTable.code, "1130%"),
        like(accountsTable.nameAr, "%عملاء%"),
        like(accountsTable.nameAr, "%مدين%"),
      ),
    ));
  const parent =
    candidates.find(a => a.code.startsWith("1130")) ??
    candidates.find(a => (a.nameAr || "").includes("عملاء")) ??
    candidates[0];
  if (!parent) return null;

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

  const [created] = await db.insert(accountsTable).values({
    companyId,
    parentId: parent.id,
    code: newCode,
    nameAr: customerName,
    accountType: "asset",
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
router.use(requireModulePermission("customers"));
router.use(moduleAudit("customers"));

// Customer balances: + posted credit sales invoices, − posted sales returns,
// − posted receipt vouchers (cash collected). Positive ⇒ مدين (owes us), Negative ⇒ دائن.
router.get("/balances", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
    if (!companyId) { res.json([]); return; }
    const bid = req.query.branchId ? Number(req.query.branchId) : undefined;

    const invs = await db
      .select({
        customerId: salesInvoicesTable.customerId,
        total: sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}), 0)`,
      })
      .from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.companyId, companyId),
        eq(salesInvoicesTable.status, "posted"),
        eq(salesInvoicesTable.paymentType, "credit"),
        ...branchScopeSpread(req, salesInvoicesTable.branchId, bid),
      ))
      .groupBy(salesInvoicesTable.customerId);

    const rets = await db
      .select({
        customerId: salesReturnsTable.customerId,
        total: sql<string>`COALESCE(SUM(${salesReturnsTable.totalAmount}), 0)`,
      })
      .from(salesReturnsTable)
      .where(and(
        eq(salesReturnsTable.companyId, companyId),
        eq(salesReturnsTable.status, "posted"),
        ...branchScopeSpread(req, salesReturnsTable.branchId, bid),
      ))
      .groupBy(salesReturnsTable.customerId);

    const recvs = await db
      .select({
        customerId: receiptVouchersTable.entityId,
        total: sql<string>`COALESCE(SUM(${receiptVouchersTable.amount}), 0)`,
      })
      .from(receiptVouchersTable)
      .where(and(
        eq(receiptVouchersTable.companyId, companyId),
        eq(receiptVouchersTable.status, "posted"),
        eq(receiptVouchersTable.entityType, "customer"),
        ...branchScopeSpread(req, receiptVouchersTable.branchId, bid),
      ))
      .groupBy(receiptVouchersTable.entityId);

    const map: Record<number, number> = {};
    for (const r of invs)  if (r.customerId) map[r.customerId] = (map[r.customerId] ?? 0) + Number(r.total);
    for (const r of rets)  if (r.customerId) map[r.customerId] = (map[r.customerId] ?? 0) - Number(r.total);
    for (const r of recvs) if (r.customerId) map[r.customerId] = (map[r.customerId] ?? 0) - Number(r.total);

    res.json(Object.entries(map).map(([id, balance]) => ({ customerId: Number(id), balance })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/", async (req, res) => {
  const params = ListCustomersQueryParams.safeParse(req.query);
  const rawCompanyId = params.success && params.data.companyId ? params.data.companyId : undefined;
  const companyId = resolveCompanyId(req, rawCompanyId);

  const customers = companyId
    ? await db.select().from(customersTable).where(eq(customersTable.companyId, companyId))
    : await db.select().from(customersTable);

  res.json(customers);
});

router.post("/", async (req, res) => {
  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  // Lock companyId to the authenticated user's company (non-superadmin)
  const effectiveCompanyId = resolveCompanyId(req, data.companyId) ?? data.companyId;

  const existing = await db.select().from(customersTable).where(eq(customersTable.companyId, effectiveCompanyId));
  if (data.vatNumber && existing.some(c => c.vatNumber?.trim() === data.vatNumber!.trim())) {
    res.status(409).json({ error: `الرقم الضريبي "${data.vatNumber}" مستخدم لعميل آخر` });
    return;
  }
  if (data.crNumber && existing.some(c => c.crNumber?.trim() === data.crNumber!.trim())) {
    res.status(409).json({ error: `رقم السجل التجاري "${data.crNumber}" مستخدم لعميل آخر` });
    return;
  }
  if (data.nameAr && existing.some(c => c.nameAr?.trim().toLowerCase() === data.nameAr.trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${data.nameAr}" مسجَّل بالفعل لعميل آخر` });
    return;
  }

  let accountId: number | null = (data as any).accountId ? Number((data as any).accountId) : null;
  if (!accountId) {
    try {
      accountId = await ensureCustomerAccount(effectiveCompanyId, String(data.nameAr).trim());
    } catch (err) {
      console.error("ensureCustomerAccount failed:", err);
      accountId = null;
    }
  }

  const [customer] = await db.insert(customersTable).values({
    companyId: effectiveCompanyId,
    nameAr: data.nameAr,
    nameEn: data.nameEn,
    vatNumber: data.vatNumber,
    crNumber: data.crNumber,
    email: data.email,
    phone: data.phone,
    city: data.city,
    district: data.district,
    street: data.street,
    buildingNumber: data.buildingNumber,
    postalCode: data.postalCode,
    country: data.country ?? "SA",
    accountId,
  }).returning();
  res.status(201).json(customer);
});

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, id));
  if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
  // Enforce company isolation
  const companyId = resolveCompanyId(req, customer.companyId);
  if (companyId && customer.companyId !== companyId) {
    res.status(403).json({ error: "غير مصرح" }); return;
  }
  res.json(customer);
});

router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(customersTable).where(eq(customersTable.id, id));
  if (!existing) { res.status(404).json({ error: "Customer not found" }); return; }
  const companyId = resolveCompanyId(req, existing.companyId);
  if (companyId && existing.companyId !== companyId) { res.status(403).json({ error: "غير مصرح" }); return; }

  const parsed = UpdateCustomerBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input", details: parsed.error.issues }); return; }
  const d = parsed.data as any;

  const others = await db.select().from(customersTable).where(eq(customersTable.companyId, existing.companyId));
  if (d.vatNumber && others.some(c => c.id !== id && c.vatNumber?.trim() === String(d.vatNumber).trim())) {
    res.status(409).json({ error: `الرقم الضريبي "${d.vatNumber}" مستخدم لعميل آخر` });
    return;
  }
  if (d.crNumber && others.some(c => c.id !== id && c.crNumber?.trim() === String(d.crNumber).trim())) {
    res.status(409).json({ error: `رقم السجل التجاري "${d.crNumber}" مستخدم لعميل آخر` });
    return;
  }
  if (d.nameAr && others.some(c => c.id !== id && c.nameAr?.trim().toLowerCase() === String(d.nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${d.nameAr}" مسجَّل بالفعل لعميل آخر` });
    return;
  }

  const [customer] = await db.update(customersTable).set(parsed.data).where(eq(customersTable.id, id)).returning();
  res.json(customer);
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(customersTable).where(eq(customersTable.id, id));
  if (!existing) { res.status(404).json({ error: "Customer not found" }); return; }
  const companyId = resolveCompanyId(req, existing.companyId);
  if (companyId && existing.companyId !== companyId) { res.status(403).json({ error: "غير مصرح" }); return; }
  await db.delete(customersTable).where(eq(customersTable.id, id));
  res.status(204).send();
});

export default router;
