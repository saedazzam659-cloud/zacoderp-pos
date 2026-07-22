import { Router } from "express";
import { db } from "@workspace/db";
import { branchesTable } from "@workspace/db";
import { suppliersTable, purchaseInvoicesTable, purchaseReturnsTable, supplierSettlementsTable,
  journalEntriesTable, journalEntryLinesTable, accountsTable } from "@workspace/db";
import { eq, and, sql, inArray, notInArray, isNotNull } from "drizzle-orm";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import {
  ensureSupplierLedger, ensureSupplierLedgerUnderParent,
  peekSupplierNextAccount, peekSupplierNextAccountUnderParent,
  type SupplierCategory,
} from "../lib/entityAccounts.js";
import { importPartyOpeningBalances } from "../lib/openingBalanceImport.js";
import { importPartyMasterData } from "../lib/partyMasterImport.js";

// Auto-create a sub-account under the "Accounts Payable — Suppliers" parent.
// Delegates to the shared entity-account helper which reads the parent
// from the Account Mapping screen (entity_account_parents.supplier_account_parent)
// and falls back to code-prefix / name-like lookup when the mapping isn't set.
async function ensureSupplierAccount(companyId: number, supplierName: string, category?: SupplierCategory): Promise<number | null> {
  return ensureSupplierLedger(companyId, supplierName, category);
}

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("suppliers"));
router.use(moduleAudit("suppliers"));

router.get("/", async (req, res) => {
  const rawCompanyId = req.query.companyId ? parseInt(req.query.companyId as string) : undefined;
  const companyId = resolveCompanyId(req, rawCompanyId);
  if (!companyId) { res.json(await db.select().from(suppliersTable)); return; }
  // Branch-level isolation — same rule as customers.
  const conds = [
    eq(suppliersTable.companyId, companyId),
    ...branchScopeSpread(req, suppliersTable.branchId, req.query.branchId),
  ];
  const suppliers = await db.select().from(suppliersTable).where(and(...conds));
  res.json(suppliers);
});

/* GET /api/suppliers/balances?companyId=X
   Returns [{ supplierId, invoicesTotal, returnsTotal, settlementsTotal, balance }] */
router.get("/balances", async (req, res) => {
  const rawCompanyId = req.query.companyId ? parseInt(req.query.companyId as string) : undefined;
  const companyId = resolveCompanyId(req, rawCompanyId);
  if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  // Suppliers with their AP account ids (for direct-JE aggregation below).
  // ALL suppliers are included — even "display-only" (includeInStatements=false)
  // ones. The الرصيد column in the suppliers list must always reflect the real
  // ledger position; the display-only flag only filters statement/aging REPORTS,
  // hiding a live balance behind "—" here misled users into thinking their
  // journal entries were lost.
  const supplierRows = await db.select({ id: suppliersTable.id, accountId: suppliersTable.accountId })
    .from(suppliersTable).where(
      eq(suppliersTable.companyId, companyId),
    );
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
        // Cash/bank invoices are paid on the spot (the JE credits the cash box
        // or bank, and the AP pass-through legs net to zero) — they must NOT
        // inflate the supplier's payable balance. Only CREDIT invoices accrue.
        sql`coalesce(${purchaseInvoicesTable.paymentType}, 'credit') NOT IN ('cash','bank')`,
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
    // via purchase_invoices / purchase_returns / supplier_settlements. This captures:
    //   • Fixed-asset credit acquisitions (entryType = 'fa_acquisition')
    //   • Manual / opening-balance JEs (entryType = 'general' / 'trial_balance_adjustment')
    //   • Payment vouchers (entryType = 'payment') — سندات الصرف post their JE
    //     directly against the supplier AP account and do NOT write a
    //     supplier_settlements row, so the JE is the ONLY record of the payment.
    //     (Excluding 'payment' here silently dropped voucher payments from the
    //     balance; supplier_settlements rows are created only by the manual
    //     settlements screen, which never posts a JE — no double-count.)
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
              "purchase_invoice", "purchase_return",
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

// Read-only preview for the supplier create forms: which parent (محلي/أجنبي)
// the auto-minted AP sub-account would nest under, the LAST code already used
// there, and the NEXT code that would be assigned. Uses the exact same
// resolution+numbering as the create path so the hint can't diverge.
// NOTE: registered BEFORE /:id (Express 5 matches in order).
router.get("/next-account-code", async (req, res) => {
  const rawCompanyId = req.query.companyId ? parseInt(String(req.query.companyId)) : undefined;
  const companyId = resolveCompanyId(req, rawCompanyId);
  if (!companyId) { res.status(400).json({ error: "معرّف الشركة مطلوب" }); return; }
  const cat = String(req.query.category ?? "");
  const category: SupplierCategory | undefined =
    cat === "foreign" ? "foreign" : cat === "local" ? "local" : undefined;
  // Explicit parent picked by the user in the form wins over the heuristic.
  const rawParentId = req.query.parentId ? parseInt(String(req.query.parentId)) : NaN;
  // Mirror POST /: explicit parent first, but if it's invalid (wrong tenant,
  // not liability, deleted…) fall back to the category heuristic so preview
  // and save can never diverge.
  const explicitPeek = Number.isInteger(rawParentId) && rawParentId > 0
    ? await peekSupplierNextAccountUnderParent(companyId, rawParentId)
    : null;
  const peek = explicitPeek ?? await peekSupplierNextAccount(companyId, category);
  if (!peek) {
    res.json({ found: false, parentCode: null, parentName: null, lastCode: null, nextCode: null });
    return;
  }
  res.json({ found: true, ...peek });
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

  // Validate branchId belongs to the same company (prevents cross-tenant assignment)
  if (data.branchId) {
    const [b] = await db.select().from(branchesTable).where(and(eq(branchesTable.id, Number(data.branchId)), eq(branchesTable.companyId, companyId)));
    if (!b) { res.status(400).json({ error: "الفرع المحدّد غير موجود في هذه الشركة" }); return; }
  }

  // Auto-create a sub-account under the suppliers parent if none was provided.
  // The optional `accountCategory` (محلي/أجنبي) picks WHICH parent to nest
  // under (falls back to the generic supplier parent when unset/unmapped).
  const supplierCategory: SupplierCategory | undefined =
    data.accountCategory === "foreign" ? "foreign"
    : data.accountCategory === "local" ? "local"
    : undefined;
  // `accountParentId` = explicit parent picked in the form ("الحساب الرئيسي")
  // — takes priority over the category heuristic. Invalid/foreign ids resolve
  // to null inside ensureSupplierLedgerUnderParent (tenant+liability guarded)
  // and we then fall back to the heuristic so creation never hard-fails.
  const accountParentId: number | null =
    data.accountParentId && Number.isInteger(Number(data.accountParentId)) && Number(data.accountParentId) > 0
      ? Number(data.accountParentId) : null;
  let accountId: number | null = data.accountId ? Number(data.accountId) : null;
  if (!accountId) {
    try {
      if (accountParentId) {
        accountId = await ensureSupplierLedgerUnderParent(companyId, String(data.nameAr).trim(), accountParentId);
      }
      if (!accountId) {
        accountId = await ensureSupplierAccount(companyId, String(data.nameAr).trim(), supplierCategory);
      }
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
    branchId: data.branchId ? Number(data.branchId) : null,
    includeInStatements: data.includeInStatements === false ? false : true,
  }).returning();
  res.status(201).json(supplier);
});

// Bulk-import opening balances for suppliers → one draft "opening" JE.
// Registered BEFORE "/:id" (Express 5 / path-to-regexp 8: literal segments
// must precede the param route or ":id" swallows "import").
router.post("/import/opening-balances", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, (req as any).authUser?.companyId ?? undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const body = req.body || {};
    const data = Array.isArray(body.rows) ? body.rows : Array.isArray(body.balances) ? body.balances : [];
    const result = await importPartyOpeningBalances({ req, cid, party: "supplier", rows: data, date: body.date });
    res.json(result);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? "فشل استيراد الأرصدة الافتتاحية" });
  }
});

// Bulk-import supplier MASTER DATA (code, names, tax/CR, address, contact).
// Upsert only — carries NO opening balance. Registered BEFORE "/:id"
// (Express 5 / path-to-regexp 8: literal segments must precede the param route).
router.post("/import", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, (req as any).authUser?.companyId ?? undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const body = req.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : Array.isArray(body.suppliers) ? body.suppliers : [];
    if (!rows.length) { res.status(400).json({ error: "لا توجد بيانات" }); return; }
    const result = await importPartyMasterData({ req, cid, party: "supplier", rows });
    res.json(result);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? "فشل استيراد بيانات الموردين" });
  }
});

/* POST /api/suppliers/repair-accounts
   Re-links suppliers whose account_id is NULL or points at a DELETED account
   (historically possible before the accounts DELETE guard). For each broken
   supplier we re-mint (or idempotently reuse a same-name sibling) an AP
   sub-account under the suppliers parent. Registered BEFORE "/:id". */
router.post("/repair-accounts", async (req, res) => {
  try {
    const rawCompanyId = req.query.companyId ? parseInt(req.query.companyId as string) : undefined;
    const cid = resolveCompanyId(req, rawCompanyId);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }

    const [allSuppliers, allAccounts] = await Promise.all([
      db.select().from(suppliersTable).where(eq(suppliersTable.companyId, cid)),
      db.select({ id: accountsTable.id }).from(accountsTable).where(eq(accountsTable.companyId, cid)),
    ]);
    const accountIds = new Set(allAccounts.map(a => a.id));
    const broken = allSuppliers.filter(s => s.accountId == null || !accountIds.has(s.accountId));

    let repaired = 0, failed = 0;
    const details: { id: number; nameAr: string | null; accountId: number | null }[] = [];
    for (const s of broken) {
      const name = (s.nameAr ?? "").trim();
      if (!name) { failed++; continue; }
      try {
        const newAccId = await ensureSupplierAccount(cid, name);
        if (newAccId) {
          await db.update(suppliersTable).set({ accountId: newAccId }).where(eq(suppliersTable.id, s.id));
          repaired++;
          details.push({ id: s.id, nameAr: s.nameAr, accountId: newAccId });
        } else {
          failed++;
        }
      } catch (err) {
        console.error(`repair-accounts: supplier ${s.id} failed:`, err);
        failed++;
      }
    }
    res.json({ checked: allSuppliers.length, broken: broken.length, repaired, failed, details });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "فشل إصلاح الربط المحاسبي" });
  }
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

  if (data.branchId) {
    const [b] = await db.select().from(branchesTable).where(and(eq(branchesTable.id, Number(data.branchId)), eq(branchesTable.companyId, existing.companyId)));
    if (!b) { res.status(400).json({ error: "الفرع المحدّد غير موجود في هذه الشركة" }); return; }
  }

  // Resolve the final accountId. Never silently NULL the link on edit:
  //  - explicit accountId from the form wins;
  //  - otherwise keep the existing link IF its account still exists;
  //  - otherwise (never linked, or the linked account was deleted) re-mint
  //    an AP sub-account — same behaviour as create.
  let accountId: number | null = data.accountId ? Number(data.accountId) : null;
  if (!accountId && existing.accountId != null) {
    const [still] = await db.select({ id: accountsTable.id }).from(accountsTable)
      .where(and(eq(accountsTable.id, existing.accountId), eq(accountsTable.companyId, existing.companyId)));
    if (still) accountId = existing.accountId;
  }
  if (!accountId) {
    const supplierCategory: SupplierCategory | undefined =
      data.accountCategory === "foreign" ? "foreign"
      : data.accountCategory === "local" ? "local"
      : undefined;
    try {
      accountId = await ensureSupplierAccount(existing.companyId, String(data.nameAr ?? existing.nameAr ?? "").trim(), supplierCategory);
    } catch (err) {
      console.error("ensureSupplierAccount (PUT) failed:", err);
      accountId = null;
    }
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
    accountId,
    ...(data.branchId !== undefined
      ? { branchId: data.branchId === null || data.branchId === "" ? null : Number(data.branchId) }
      : {}),
    ...(typeof data.includeInStatements === "boolean"
      ? { includeInStatements: data.includeInStatements }
      : {}),
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
