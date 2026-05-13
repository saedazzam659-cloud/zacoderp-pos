import { Router } from "express";
import { db } from "@workspace/db";
import { customersTable, salesInvoicesTable, salesReturnsTable, receiptVouchersTable, salesRepsTable, usersTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { CreateCustomerBody, UpdateCustomerBody, ListCustomersQueryParams } from "@workspace/api-zod";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
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
    // Restrict the aggregated balances to customers in the caller's scope so
    // a salesperson can't infer their colleagues' AR exposure by inspecting
    // this endpoint. Admin/superadmin get the unfiltered company-wide map.
    const repScope = await customerScopeRepId(req, companyId);
    let allowedCustomerIds: Set<number> | null = null;
    if (repScope !== null) {
      const mine = await db.select({ id: customersTable.id }).from(customersTable)
        .where(and(eq(customersTable.companyId, companyId), eq(customersTable.salesRepId, repScope)));
      allowedCustomerIds = new Set(mine.map(r => r.id));
    }

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
      id != null && !displayOnlyIds.has(id) && (allowedCustomerIds === null || allowedCustomerIds.has(id));
    for (const r of invs)  if (allowed(r.customerId)) map[r.customerId!] = (map[r.customerId!] ?? 0) + Number(r.total);
    for (const r of rets)  if (allowed(r.customerId)) map[r.customerId!] = (map[r.customerId!] ?? 0) - Number(r.total);
    for (const r of recvs) if (allowed(r.customerId)) map[r.customerId!] = (map[r.customerId!] ?? 0) - Number(r.total);

    res.json(Object.entries(map).map(([id, balance]) => ({ customerId: Number(id), balance })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Customer-isolation scope ───────────────────────────────────────────────
// When a user has `scopeOwnCustomersOnly = true` AND is linked to a sales rep
// (sales_reps.user_id), they may only see customers whose `salesRepId` matches
// their rep id. Admin / superadmin always bypass the filter so back-office
// staff keep full visibility. Returns the rep id to scope to, or null when no
// scoping is required.
async function customerScopeRepId(req: any, companyId: number): Promise<number | null> {
  const u = req.authUser;
  if (!u || u.role === "admin" || u.role === "superadmin") return null;
  const [me] = await db.select({ scope: usersTable.scopeOwnCustomersOnly })
    .from(usersTable).where(eq(usersTable.id, u.id));
  if (!me?.scope) return null;
  const [rep] = await db.select({ id: salesRepsTable.id })
    .from(salesRepsTable)
    .where(and(eq(salesRepsTable.companyId, companyId), eq(salesRepsTable.userId, u.id)));
  return rep?.id ?? -1; // -1 = scope ON but no rep linked → see nothing
}

router.get("/", async (req, res) => {
  const params = ListCustomersQueryParams.safeParse(req.query);
  const rawCompanyId = params.success && params.data.companyId ? params.data.companyId : undefined;
  const companyId = resolveCompanyId(req, rawCompanyId);

  if (!companyId) { res.json(await db.select().from(customersTable)); return; }
  const repScope = await customerScopeRepId(req, companyId);
  const conds = [eq(customersTable.companyId, companyId)];
  if (repScope !== null) conds.push(eq(customersTable.salesRepId, repScope));
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

  // ─── Auto-attribute customer to the creator's rep ────────────────
  // When a scoped rep-user (`scopeOwnCustomersOnly = true` and linked to a
  // sales rep) creates a customer, force `salesRepId` to their own rep id.
  // Without this, the new customer would be inserted with salesRepId=null
  // and the list filter (eq salesRepId, repScope) would immediately hide
  // it from its own creator — exactly the bug just observed in the UI.
  // The same lock prevents a scoped rep from assigning a fresh customer
  // to a colleague (would otherwise be a quiet way to leak commissions).
  // Admin / superadmin keep full control over `salesRepId`.
  const repScope = await customerScopeRepId(req, effectiveCompanyId);
  let effectiveSalesRepId: number | null =
    (data as any).salesRepId != null ? Number((data as any).salesRepId) : null;
  if (repScope !== null) {
    // repScope === -1 means "scope ON but no rep linked" → block creation,
    // otherwise the row would be invisible to its own creator forever.
    if (repScope === -1) {
      res.status(403).json({ error: "حسابك مقيَّد على عملاء مندوبك لكنه غير مربوط بأي مندوب — اطلب من المسؤول ربطك أولاً." });
      return;
    }
    effectiveSalesRepId = repScope;
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
    // "Display-only" flag — accept from raw body since it is not part of the
    // generated CreateCustomerBody zod schema yet. Defaults to true (full
    // statement participation) when omitted.
    includeInStatements: (req.body as any)?.includeInStatements === false ? false : true,
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
  // ─── Per-rep customer-isolation guard ────────────────────────────
  // The list endpoint (GET /) silently filters; here we 403 because the
  // caller is asking for a *specific* id. Without this, a scoped user could
  // enumerate competing reps' customers by guessing ids (IDOR).
  if (companyId) {
    const repScope = await customerScopeRepId(req, companyId);
    if (repScope !== null && customer.salesRepId !== repScope) {
      res.status(403).json({ error: "هذا العميل خارج نطاق صلاحياتك" }); return;
    }
  }
  res.json(customer);
});

router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(customersTable).where(eq(customersTable.id, id));
  if (!existing) { res.status(404).json({ error: "Customer not found" }); return; }
  const companyId = resolveCompanyId(req, existing.companyId);
  if (companyId && existing.companyId !== companyId) { res.status(403).json({ error: "غير مصرح" }); return; }

  // ─── Per-rep IDOR guard on update ──────────────────────────────
  // Mirror the GET /:id check: a scoped rep must not be able to mutate a
  // colleague's customer by guessing the id, and must not be able to
  // re-assign salesRepId away from themselves (silent commission theft).
  if (companyId) {
    const repScopeForUpdate = await customerScopeRepId(req, companyId);
    if (repScopeForUpdate !== null && existing.salesRepId !== repScopeForUpdate) {
      res.status(403).json({ error: "هذا العميل خارج نطاق صلاحياتك" }); return;
    }
    if (repScopeForUpdate !== null && req.body && (req.body as any).salesRepId !== undefined && Number((req.body as any).salesRepId) !== repScopeForUpdate) {
      res.status(403).json({ error: "لا يمكنك تغيير مندوب هذا العميل" }); return;
    }
  }

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
  const [customer] = await db.update(customersTable).set(setData).where(eq(customersTable.id, id)).returning();
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
