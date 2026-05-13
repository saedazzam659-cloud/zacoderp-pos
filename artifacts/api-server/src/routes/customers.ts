import { Router } from "express";
import { db } from "@workspace/db";
import { customersTable, salesInvoicesTable, salesReturnsTable, receiptVouchersTable, branchesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { CreateCustomerBody, UpdateCustomerBody, ListCustomersQueryParams } from "@workspace/api-zod";
import { extractAuth, resolveCompanyId, branchScopeSpread, getAllowedBranchIds } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { ensureCustomerLedger } from "../lib/entityAccounts.js";

// Auto-create a sub-account under the "Accounts Receivable — Customers" parent.
// Delegates to the shared entity-account helper which reads the parent
// from the Account Mapping screen (entity_account_parents.customer_account_parent)
// and falls back to code-prefix / name-like lookup when the mapping isn't set.
async function ensureCustomerAccount(companyId: number, customerName: string): Promise<number | null> {
  return ensureCustomerLedger(companyId, customerName);
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
    // ─── Customer-isolation scope ─────────────────────────────
    // Restrict the aggregated balances to customers visible under the
    // caller's branch scope, so a branch user can't infer the AR exposure
    // of customers belonging to other branches via this endpoint.
    const visibleRows = await db.select({ id: customersTable.id }).from(customersTable)
      .where(and(
        eq(customersTable.companyId, companyId),
        ...branchScopeSpread(req, customersTable.branchId, bid),
      ));
    const allowedCustomerIds: Set<number> = new Set(visibleRows.map(r => r.id));

    // Display-only customers must NOT contribute to the balances aggregation
    // (matches the /aging + /customer-statement filters elsewhere).
    const displayOnlyRows = await db.select({ id: customersTable.id }).from(customersTable)
      .where(and(eq(customersTable.companyId, companyId), eq(customersTable.includeInStatements, false)));
    const displayOnlyIds = new Set(displayOnlyRows.map(r => r.id));

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
    const allowed = (id: number | null) =>
      id != null && !displayOnlyIds.has(id) && allowedCustomerIds.has(id);
    for (const r of invs)  if (allowed(r.customerId)) map[r.customerId!] = (map[r.customerId!] ?? 0) + Number(r.total);
    for (const r of rets)  if (allowed(r.customerId)) map[r.customerId!] = (map[r.customerId!] ?? 0) - Number(r.total);
    for (const r of recvs) if (allowed(r.customerId)) map[r.customerId!] = (map[r.customerId!] ?? 0) - Number(r.total);

    res.json(Object.entries(map).map(([id, balance]) => ({ customerId: Number(id), balance })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// NOTE: customer-isolation no longer relies on sales-rep linkage.
// The previous `scopeOwnCustomersOnly` flag (per-rep filter) was removed
// because moving a salesperson between branches would silently hide their
// historical customers. Visibility is now governed purely by the per-user
// branch scope (`viewAllBranches` + assigned branches).

router.get("/", async (req, res) => {
  const params = ListCustomersQueryParams.safeParse(req.query);
  const rawCompanyId = params.success && params.data.companyId ? params.data.companyId : undefined;
  const companyId = resolveCompanyId(req, rawCompanyId);

  if (!companyId) { res.json(await db.select().from(customersTable)); return; }
  const conds = [eq(customersTable.companyId, companyId)];
  // Branch-level isolation: a user with viewAllBranches=false only sees
  // customers tied to one of their assigned branches (or shared rows where
  // branchId IS NULL). Admin / superadmin / viewAll users are unaffected.
  conds.push(...branchScopeSpread(req, customersTable.branchId, req.query.branchId));
  const customers = await db.select().from(customersTable).where(and(...conds));
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

  // Sales-rep auto-attribution removed alongside the per-rep customer
  // isolation filter. The salesRepId is now whatever the caller chose
  // (or null) — branch isolation handles visibility.
  const effectiveSalesRepId: number | null =
    (data as any).salesRepId != null ? Number((data as any).salesRepId) : null;

  // Validate branchId belongs to the same company
  const rawBranchId = (req.body as any)?.branchId;
  if (rawBranchId) {
    const [b] = await db.select().from(branchesTable).where(and(eq(branchesTable.id, Number(rawBranchId)), eq(branchesTable.companyId, effectiveCompanyId)));
    if (!b) { res.status(400).json({ error: "الفرع المحدّد غير موجود في هذه الشركة" }); return; }
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

  const d: any = data;
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
    nationalAddressShort: d.nationalAddressShort ?? null,
    locationLat: d.locationLat ?? null,
    locationLng: d.locationLng ?? null,
    locationLink: d.locationLink ?? null,
    accountId,
    salesRepId: effectiveSalesRepId,
    branchId: (req.body as any)?.branchId ? Number((req.body as any).branchId) : null,
    // "Display-only" flag — accept from raw body since it is not part of the
    // generated CreateCustomerBody zod schema yet. Defaults to true (full
    // statement participation) when omitted.
    includeInStatements: (req.body as any)?.includeInStatements === false ? false : true,
    // Credit-limit pair — also raw-body pass-through for the same reason.
    // creditLimit is stored as numeric(15,2); we coerce to string and clamp
    // negatives to 0 to keep the column non-negative. Enforcement defaults
    // to false so existing customers stay in informational-only mode until
    // someone explicitly toggles it on.
    creditLimit: clampCreditLimit((req.body as any)?.creditLimit) ?? "0",
    enforceCreditLimit: (req.body as any)?.enforceCreditLimit === true,
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
  // Per-rep IDOR guard removed alongside the per-rep customer isolation
  // filter. Branch-level isolation handles cross-branch visibility on
  // the list endpoint; direct GET /:id is now allowed for any user with
  // module access within the same company.
  res.json(customer);
});

router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(customersTable).where(eq(customersTable.id, id));
  if (!existing) { res.status(404).json({ error: "Customer not found" }); return; }
  const companyId = resolveCompanyId(req, existing.companyId);
  if (companyId && existing.companyId !== companyId) { res.status(403).json({ error: "غير مصرح" }); return; }

  // Per-rep IDOR + salesRepId-tamper guards removed alongside the per-rep
  // customer isolation filter (see GET / for context).

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

  // Pass through `includeInStatements` from raw body — the generated
  // UpdateCustomerBody zod schema strips unknown keys, so we merge it
  // back in explicitly when the client sends it.
  const setData: any = { ...parsed.data };
  if (typeof (req.body as any)?.includeInStatements === "boolean") {
    setData.includeInStatements = (req.body as any).includeInStatements;
  }
  // Credit-limit pair — same raw-body pass-through pattern. Only assign
  // when the client actually sent the key so we don't silently overwrite
  // existing values during partial updates.
  if ((req.body as any)?.creditLimit !== undefined) {
    const v = clampCreditLimit((req.body as any).creditLimit);
    if (v != null) setData.creditLimit = v;
  }
  if (typeof (req.body as any)?.enforceCreditLimit === "boolean") {
    setData.enforceCreditLimit = (req.body as any).enforceCreditLimit;
  }
  if ((req.body as any)?.branchId !== undefined) {
    const bv = (req.body as any).branchId;
    if (bv === null || bv === "") {
      setData.branchId = null;
    } else {
      const [br] = await db.select().from(branchesTable).where(and(eq(branchesTable.id, Number(bv)), eq(branchesTable.companyId, existing.companyId)));
      if (!br) { res.status(400).json({ error: "الفرع المحدّد غير موجود في هذه الشركة" }); return; }
      setData.branchId = Number(bv);
    }
  }
  const [customer] = await db.update(customersTable).set(setData).where(eq(customersTable.id, id)).returning();
  res.json(customer);
});

// Coerce raw body input → numeric(15,2)-safe string. Returns null for
// invalid / non-numeric input so the caller can decide the fallback.
function clampCreditLimit(v: any): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, n).toFixed(2);
}

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
