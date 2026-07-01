import { Router } from "express";
import { db } from "@workspace/db";
import { customersTable, customerGroupsTable, salesInvoicesTable, salesReturnsTable, receiptVouchersTable, branchesTable } from "@workspace/db";
import { and, asc, eq, sql, gte, lte } from "drizzle-orm";
import { CreateCustomerBody, UpdateCustomerBody, ListCustomersQueryParams } from "@workspace/api-zod";
import { extractAuth, resolveCompanyId, branchScopeSpread, getAllowedBranchIds } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { ensureCustomerLedger, type CustomerCategory } from "../lib/entityAccounts.js";
import { importPartyOpeningBalances } from "../lib/openingBalanceImport.js";
import { importPartyMasterData } from "../lib/partyMasterImport.js";

// Auto-create a sub-account under the "Accounts Receivable — Customers" parent.
// Delegates to the shared entity-account helper which reads the parent
// from the Account Mapping screen (entity_account_parents.customer_account_parent)
// and falls back to code-prefix / name-like lookup when the mapping isn't set.
async function ensureCustomerAccount(companyId: number, customerName: string, category?: CustomerCategory): Promise<number | null> {
  return ensureCustomerLedger(companyId, customerName, false, category);
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
    // Optional date window (movements within [from, to]). Date columns are
    // ISO-text so lexicographic gte/lte is correct.
    const from = req.query.from ? String(req.query.from) : undefined;
    const to   = req.query.to   ? String(req.query.to)   : undefined;
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
        ...(from ? [gte(salesInvoicesTable.invoiceDate, from)] : []),
        ...(to   ? [lte(salesInvoicesTable.invoiceDate, to)]   : []),
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
        ...(from ? [gte(salesReturnsTable.returnDate, from)] : []),
        ...(to   ? [lte(salesReturnsTable.returnDate, to)]   : []),
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
        ...(from ? [gte(receiptVouchersTable.date, from)] : []),
        ...(to   ? [lte(receiptVouchersTable.date, to)]   : []),
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

// ═══════════════════════════════════════════════
// CUSTOMER GROUPS  (registered before "/:id" so the literal is not swallowed)
// ═══════════════════════════════════════════════
router.get("/customer-groups", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
    const rows = cid
      ? await db.select().from(customerGroupsTable)
          .where(eq(customerGroupsTable.companyId, cid))
          .orderBy(asc(customerGroupsTable.code))
      : [];
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/customer-groups", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const { code, nameAr, nameEn, notes, isActive } = req.body;
    if (!code || !nameAr) { res.status(400).json({ error: "الكود والاسم مطلوبان" }); return; }
    const [row] = await db.insert(customerGroupsTable).values({
      companyId: cid, code, nameAr, nameEn: nameEn || null,
      notes: notes || null, isActive: isActive ?? true,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/customer-groups/:id", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const { code, nameAr, nameEn, notes, isActive } = req.body;
    const [row] = await db.update(customerGroupsTable).set({
      code, nameAr, nameEn: nameEn || null, notes: notes || null, isActive,
    }).where(and(eq(customerGroupsTable.id, id), eq(customerGroupsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "المجموعة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/customer-groups/:id", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    await db.delete(customerGroupsTable).where(and(eq(customerGroupsTable.id, id), eq(customerGroupsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
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

  // `allowDuplicates` opt-in — mirrors the bulk master-data import and the
  // edit form's "save anyway" confirmation. Bypasses the vat/cr/name guard.
  const allowDuplicates = (req.body as any)?.allowDuplicates === true;
  const existing = await db.select().from(customersTable).where(eq(customersTable.companyId, effectiveCompanyId));
  if (!allowDuplicates && data.vatNumber && existing.some(c => c.vatNumber?.trim() === data.vatNumber!.trim())) {
    res.status(409).json({ error: `الرقم الضريبي "${data.vatNumber}" مستخدم لعميل آخر`, code: "duplicate_customer" });
    return;
  }
  if (!allowDuplicates && data.crNumber && existing.some(c => c.crNumber?.trim() === data.crNumber!.trim())) {
    res.status(409).json({ error: `رقم السجل التجاري "${data.crNumber}" مستخدم لعميل آخر`, code: "duplicate_customer" });
    return;
  }
  if (!allowDuplicates && data.nameAr && existing.some(c => c.nameAr?.trim().toLowerCase() === data.nameAr.trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${data.nameAr}" مسجَّل بالفعل لعميل آخر`, code: "duplicate_customer" });
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

  // Validate customerGroupId belongs to the same company
  const rawGroupId = (req.body as any)?.customerGroupId;
  if (rawGroupId) {
    const gid = Number(rawGroupId);
    if (!Number.isInteger(gid) || gid <= 0) { res.status(400).json({ error: "مجموعة العملاء غير صحيحة" }); return; }
    const [g] = await db.select().from(customerGroupsTable).where(and(eq(customerGroupsTable.id, gid), eq(customerGroupsTable.companyId, effectiveCompanyId)));
    if (!g) { res.status(400).json({ error: "مجموعة العملاء المحدّدة غير موجودة في هذه الشركة" }); return; }
  }

  // Optional `accountCategory` (محلي/تصدير) picks WHICH parent the auto-created
  // AR sub-account nests under. Read from the RAW body since the generated
  // CreateCustomerBody zod schema strips unknown fields.
  const rawCategory = (req.body as any)?.accountCategory;
  const customerCategory: CustomerCategory | undefined =
    rawCategory === "export" ? "export"
    : rawCategory === "local" ? "local"
    : undefined;
  let accountId: number | null = (data as any).accountId ? Number((data as any).accountId) : null;
  if (!accountId) {
    try {
      accountId = await ensureCustomerAccount(effectiveCompanyId, String(data.nameAr).trim(), customerCategory);
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
    customerGroupId: (req.body as any)?.customerGroupId ? Number((req.body as any).customerGroupId) : null,
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
    // Payment terms (days). NULL or 0 = no enforcement; > 0 means new credit
    // invoices are refused when any prior credit invoice from this customer is
    // unpaid past the term.
    paymentTermsDays: (() => {
      const v = (req.body as any)?.paymentTermsDays;
      if (v === undefined || v === null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    })(),
  }).returning();
  res.status(201).json(customer);
});

// Bulk-import opening balances for customers → one draft "opening" JE.
// Registered BEFORE "/:id" (Express 5 / path-to-regexp 8: literal segments
// must precede the param route or ":id" swallows "import").
router.post("/import/opening-balances", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, (req as any).authUser?.companyId ?? undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const body = req.body || {};
    const data = Array.isArray(body.rows) ? body.rows : Array.isArray(body.balances) ? body.balances : [];
    const result = await importPartyOpeningBalances({ req, cid, party: "customer", rows: data, date: body.date });
    res.json(result);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? "فشل استيراد الأرصدة الافتتاحية" });
  }
});

// Bulk-import customer MASTER DATA (names, tax/CR, address, contact, terms).
// Upsert only — carries NO opening balance. Registered BEFORE "/:id"
// (Express 5 / path-to-regexp 8: literal segments must precede the param route).
router.post("/import", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, (req as any).authUser?.companyId ?? undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const body = req.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : Array.isArray(body.customers) ? body.customers : [];
    if (!rows.length) { res.status(400).json({ error: "لا توجد بيانات" }); return; }
    const allowDuplicates = body?.allowDuplicates === true;
    const result = await importPartyMasterData({ req, cid, party: "customer", rows, allowDuplicates });
    res.json(result);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? "فشل استيراد بيانات العملاء" });
  }
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

  // `allowDuplicates` lets the caller bypass the vat/cr/name uniqueness
  // guard — same opt-in used by the bulk master-data import. Surfaced in
  // the edit form as a "save anyway" confirmation when a 409 is hit.
  const allowDuplicates = (req.body as any)?.allowDuplicates === true;
  const others = await db.select().from(customersTable).where(eq(customersTable.companyId, existing.companyId));
  // Only enforce uniqueness when the value actually CHANGED from what is
  // already stored — otherwise a customer that already shares a vat/cr/name
  // with another row (pre-existing duplicate, e.g. from a bulk import) could
  // never have its OTHER fields (phone, address…) edited and saved. Editing
  // an unchanged identifier never introduces a NEW conflict.
  const vatChanged  = d.vatNumber !== undefined && String(d.vatNumber).trim() !== (existing.vatNumber ?? "").trim();
  const crChanged   = d.crNumber  !== undefined && String(d.crNumber).trim()  !== (existing.crNumber ?? "").trim();
  const nameChanged = d.nameAr    !== undefined && String(d.nameAr).trim().toLowerCase() !== (existing.nameAr ?? "").trim().toLowerCase();
  if (!allowDuplicates && vatChanged && d.vatNumber && others.some(c => c.id !== id && c.vatNumber?.trim() === String(d.vatNumber).trim())) {
    res.status(409).json({ error: `الرقم الضريبي "${d.vatNumber}" مستخدم لعميل آخر`, code: "duplicate_customer" });
    return;
  }
  if (!allowDuplicates && crChanged && d.crNumber && others.some(c => c.id !== id && c.crNumber?.trim() === String(d.crNumber).trim())) {
    res.status(409).json({ error: `رقم السجل التجاري "${d.crNumber}" مستخدم لعميل آخر`, code: "duplicate_customer" });
    return;
  }
  if (!allowDuplicates && nameChanged && d.nameAr && others.some(c => c.id !== id && c.nameAr?.trim().toLowerCase() === String(d.nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${d.nameAr}" مسجَّل بالفعل لعميل آخر`, code: "duplicate_customer" });
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
  if ((req.body as any)?.paymentTermsDays !== undefined) {
    const v = (req.body as any).paymentTermsDays;
    if (v === null || v === "") {
      setData.paymentTermsDays = null;
    } else {
      const n = Number(v);
      setData.paymentTermsDays = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    }
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
  if ((req.body as any)?.customerGroupId !== undefined) {
    const gv = (req.body as any).customerGroupId;
    if (gv === null || gv === "") {
      setData.customerGroupId = null;
    } else {
      const gid = Number(gv);
      if (!Number.isInteger(gid) || gid <= 0) { res.status(400).json({ error: "مجموعة العملاء غير صحيحة" }); return; }
      const [g] = await db.select().from(customerGroupsTable).where(and(eq(customerGroupsTable.id, gid), eq(customerGroupsTable.companyId, existing.companyId)));
      if (!g) { res.status(400).json({ error: "مجموعة العملاء المحدّدة غير موجودة في هذه الشركة" }); return; }
      setData.customerGroupId = gid;
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

// ════════════════════════════════════════════════════════════════════════
// Fetch National Address from Saudi Post (SPL) API.
// Uses the customer's stored vatNumber or crNumber to look up the official
// registered address and writes the resolved fields back to the row.
// Requires SPL_API_KEY env (subscribe at https://api.address.gov.sa).
// ════════════════════════════════════════════════════════════════════════
router.put("/:id/fetch-national-address", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [existing] = await db.select().from(customersTable).where(eq(customersTable.id, id));
    if (!existing) { res.status(404).json({ error: "العميل غير موجود" }); return; }
    const companyId = resolveCompanyId(req, existing.companyId);
    if (companyId && existing.companyId !== companyId) { res.status(403).json({ error: "غير مصرح" }); return; }

    const apiKey = process.env.SPL_API_KEY;
    if (!apiKey) {
      res.status(503).json({
        error: "خدمة العنوان الوطني غير مفعّلة",
        details: "يجب إضافة مفتاح SPL_API_KEY من إعدادات البيئة. اشترك في https://api.address.gov.sa للحصول على المفتاح.",
      });
      return;
    }

    const cr = (existing.crNumber ?? "").trim();
    const vat = (existing.vatNumber ?? "").trim();
    if (!cr && !vat) {
      res.status(400).json({ error: "يجب إدخال رقم السجل التجاري أو الرقم الضريبي للعميل أولاً" });
      return;
    }

    // Prefer CR over VAT (CR-based lookup is the SPL primary endpoint).
    const baseUrl = "https://apina.address.gov.sa/NationalAddress/v3.1/Address";
    const url = cr
      ? `${baseUrl}/address-by-cr?crNumber=${encodeURIComponent(cr)}&language=A&format=JSON`
      : `${baseUrl}/address-by-vat?vatNumber=${encodeURIComponent(vat)}&language=A&format=JSON`;

    const sr = await fetch(url, { headers: { "api_key": apiKey, "Accept": "application/json" } });
    if (!sr.ok) {
      const text = await sr.text().catch(() => "");
      req.log.warn({ status: sr.status, body: text.slice(0, 200) }, "SPL API request failed");
      res.status(502).json({ error: `خدمة العنوان الوطني ردّت بخطأ ${sr.status}`, details: text.slice(0, 200) });
      return;
    }
    const payload: any = await sr.json().catch(() => ({}));
    const addr = Array.isArray(payload?.Addresses) && payload.Addresses.length ? payload.Addresses[0] : null;
    if (!addr) {
      res.status(404).json({ error: "لم يتم العثور على عنوان وطني مسجَّل لهذا العميل" });
      return;
    }

    const setData: Partial<typeof existing> = {
      city:                 addr.CityName ?? existing.city,
      district:             addr.DistrictName ?? existing.district,
      street:               addr.Street ?? existing.street,
      buildingNumber:       String(addr.BuildingNumber ?? "").trim() || existing.buildingNumber,
      postalCode:           String(addr.PostCode ?? "").trim() || existing.postalCode,
      nationalAddressShort: (addr.ShortAddress ?? existing.nationalAddressShort)?.toString().toUpperCase().replace(/[^A-Z0-9]/g, "") || existing.nationalAddressShort,
    };

    const [updated] = await db.update(customersTable).set(setData).where(eq(customersTable.id, id)).returning();
    res.json({
      ok: true,
      source: cr ? "CR" : "VAT",
      fetched: {
        city: addr.CityName ?? null,
        district: addr.DistrictName ?? null,
        street: addr.Street ?? null,
        buildingNumber: addr.BuildingNumber ?? null,
        postalCode: addr.PostCode ?? null,
        additionalNumber: addr.AdditionalNumber ?? null,
        shortAddress: addr.ShortAddress ?? null,
        regionName: addr.RegionName ?? null,
      },
      customer: updated,
    });
  } catch (e: any) {
    req.log.error({ err: e }, "fetch-national-address failed");
    res.status(500).json({ error: e?.message || "خطأ غير متوقع" });
  }
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
