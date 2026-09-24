import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { branchesTable } from "@workspace/db";
import { suppliersTable, purchaseInvoicesTable, purchaseReturnsTable, supplierSettlementsTable,
  journalEntriesTable, journalEntryLinesTable, accountsTable } from "@workspace/db";
import { eq, and, sql, inArray, notInArray, isNotNull, isNull } from "drizzle-orm";
import {
  extractAuth,
  resolveCompanyId,
  branchScopeSpread,
  getAllowedBranchIds,
} from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import {
  ensureSupplierLedger, ensureSupplierLedgerUnderParent,
  peekSupplierNextAccount, peekSupplierNextAccountUnderParent,
  type SupplierCategory,
} from "../lib/entityAccounts.js";
import { importPartyOpeningBalances } from "../lib/openingBalanceImport.js";
import { importPartyMasterData } from "../lib/partyMasterImport.js";
import {
  buildSupplierBulkAccountCodes,
  SupplierBulkAccountPlanError,
} from "../lib/supplierBulkAccounts.js";
import {
  planSupplierBulkImportRows,
  summarizeSupplierBulkImportRows,
  chooseSupplierBulkCreateBranchId,
  type SupplierBulkImportPlan,
  type SupplierBulkImportPlanRow,
} from "../lib/supplierBulkImport.js";
import { z } from "zod";

// Auto-create a sub-account under the "Accounts Payable — Suppliers" parent.
// Delegates to the shared entity-account helper which reads the parent
// from the Account Mapping screen (entity_account_parents.supplier_account_parent)
// and falls back to code-prefix / name-like lookup when the mapping isn't set.
async function ensureSupplierAccount(
  companyId: number,
  supplierName: string,
  category?: SupplierCategory,
  executor: any = db,
): Promise<number | null> {
  return ensureSupplierLedger(companyId, supplierName, category, executor);
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
  // Accounts shared by MORE THAN ONE supplier (e.g. a common "مورد عام"
  // account) are excluded from direct-JE attribution — a shared account's JE
  // net cannot be assigned to a single supplier without misstating the others.
  const accCount = new Map<number, number>();
  for (const s of supplierRows) if (s.accountId != null) accCount.set(s.accountId, (accCount.get(s.accountId) ?? 0) + 1);
  const accIdToSupplier = new Map<number, number>();
  for (const s of supplierRows) if (s.accountId != null && accCount.get(s.accountId) === 1) accIdToSupplier.set(s.accountId, s.id);
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
      .where(and(
        eq(purchaseReturnsTable.companyId, companyId),
        eq(purchaseReturnsTable.status, "posted"),
        // Cash/bank returns are refunded on the spot (the JE debits the cash
        // box or bank, and the AP pass-through legs net to zero) — they must
        // NOT reduce the supplier's payable balance. Only CREDIT returns do.
        sql`coalesce(${purchaseReturnsTable.paymentType}, 'credit') NOT IN ('cash','bank')`,
      ))
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

const bulkAssignAccountsBody = z.object({
  companyId: z.coerce.number().int().positive().optional(),
  supplierIds: z.array(z.coerce.number().int().positive()).min(1).max(5000),
  parentAccountId: z.coerce.number().int().positive(),
  leadingZeros: z.coerce.number().int().min(0).max(5),
  allowReassign: z.boolean().optional().default(false),
});

const bulkImportAssignAccountsBody = z.object({
  companyId: z.coerce.number().int().positive().optional(),
  branchId: z.coerce.number().int().positive().optional(),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
  parentAccountId: z.coerce.number().int().positive(),
  leadingZeros: z.coerce.number().int().min(0).max(5),
  allowReassign: z.boolean().optional().default(false),
});

function publicSupplierBulkImportPlan(plan: SupplierBulkImportPlan) {
  return {
    canCommit: plan.canCommit,
    summary: plan.summary,
    rows: plan.rows.map((row) => ({
      rowNumber: row.rowNumber,
      status: row.status,
      matchedBy: row.scopeBlocked ? null : row.matchedBy,
      supplierId: row.scopeBlocked ? null : row.supplierId,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      currentAccount: row.scopeBlocked ? null : row.currentAccount,
      accountCode: row.accountCode,
      error: row.scopeBlocked ? "غير مصرح بإجراء العملية على أحد الصفوف" : row.error,
    })),
  };
}

function accountDepthFromParentChain(
  account: typeof accountsTable.$inferSelect,
  accountById: Map<number, typeof accountsTable.$inferSelect>,
): number {
  let depth = 1;
  let current: typeof accountsTable.$inferSelect | undefined = account;
  const seen = new Set<number>();
  while (current?.parentId != null && !seen.has(current.id)) {
    seen.add(current.id);
    current = accountById.get(current.parentId);
    if (!current) break;
    depth++;
  }
  return depth;
}

function normalizedSupplierIdentity(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

async function lockSupplierIdentity(connection: any, companyId: number): Promise<void> {
  await connection.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtext('supplier-identity-company'),
      ${companyId}::int
    )
  `);
}

async function assertSupplierIdentityAvailable(
  connection: any,
  companyId: number,
  data: Record<string, unknown>,
  excludeId?: number,
): Promise<void> {
  const existing = await connection.select({
    id: suppliersTable.id,
    code: suppliersTable.code,
    nameAr: suppliersTable.nameAr,
    vatNumber: suppliersTable.vatNumber,
    crNumber: suppliersTable.crNumber,
  }).from(suppliersTable).where(eq(suppliersTable.companyId, companyId));
  const others = excludeId == null ? existing : existing.filter((row: any) => row.id !== excludeId);
  const checks = [
    ["code", "كود المورد", data.code],
    ["nameAr", "الاسم", data.nameAr],
    ["vatNumber", "الرقم الضريبي", data.vatNumber],
    ["crNumber", "رقم السجل التجاري", data.crNumber],
  ] as const;
  for (const [field, label, raw] of checks) {
    const key = normalizedSupplierIdentity(raw);
    if (!key) continue;
    if (others.some((row: any) => normalizedSupplierIdentity(row[field]) === key)) {
      throw new SupplierBulkAccountPlanError(`${label} "${String(raw).trim()}" مستخدم لمورد آخر`, 409);
    }
  }
}

async function resolveSupplierImportCreateBranchId(
  connection: any,
  req: any,
  companyId: number,
  requestedBranchId: number | undefined,
): Promise<number | null> {
  const allowed = getAllowedBranchIds(req);
  const branchId = chooseSupplierBulkCreateBranchId(allowed, requestedBranchId);

  if (branchId != null) {
    const [branch] = await connection.select({ id: branchesTable.id }).from(branchesTable).where(and(
      eq(branchesTable.id, branchId),
      eq(branchesTable.companyId, companyId),
    ));
    if (!branch) {
      throw new SupplierBulkAccountPlanError(
        "الفرع المحدد غير موجود في هذه الشركة",
        400,
      );
    }
  }
  return branchId;
}

async function loadSupplierBulkImportPlan(
  connection: any,
  req: any,
  companyId: number,
  data: z.infer<typeof bulkImportAssignAccountsBody>,
  lockSuppliers: boolean,
): Promise<{
  parent: typeof accountsTable.$inferSelect;
  plan: SupplierBulkImportPlan;
  createBranchId: number | null;
  childAccountLevel: number;
}> {
  const [parent] = await connection.select().from(accountsTable).where(and(
    eq(accountsTable.id, data.parentAccountId),
    eq(accountsTable.companyId, companyId),
  ));
  if (!parent) {
    throw new SupplierBulkAccountPlanError("الحساب الرئيسي غير موجود في هذه الشركة");
  }
  if (parent.accountType !== "liability") {
    throw new SupplierBulkAccountPlanError("يجب اختيار حساب رئيسي من نوع الالتزامات");
  }
  if (!parent.isActive) {
    throw new SupplierBulkAccountPlanError("الحساب الرئيسي المختار غير نشط");
  }

  const companySupplierQuery = connection
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.companyId, companyId));
  const allSuppliers = lockSuppliers
    ? await companySupplierQuery.for("update")
    : await companySupplierQuery;
  const [scopedSuppliers, allAccounts] = await Promise.all([
    connection.select({ id: suppliersTable.id }).from(suppliersTable).where(and(
      eq(suppliersTable.companyId, companyId),
      ...branchScopeSpread(req, suppliersTable.branchId, undefined),
    )),
    connection.select().from(accountsTable).where(eq(accountsTable.companyId, companyId)),
  ]);
  const scopedIds = new Set<number>(scopedSuppliers.map((supplier: { id: number }) => supplier.id));
  const accountById = new Map<number, typeof accountsTable.$inferSelect>(
    allAccounts.map((account: typeof accountsTable.$inferSelect) => [account.id, account]),
  );

  const initialPlan = planSupplierBulkImportRows({
    rawRows: data.rows,
    existingSuppliers: allSuppliers.map((supplier: typeof suppliersTable.$inferSelect) => {
      const current = supplier.accountId == null ? null : accountById.get(supplier.accountId) ?? null;
      return {
        ...supplier,
        accessible: scopedIds.has(supplier.id),
        currentAccount: current ? {
          id: current.id,
          code: current.code,
          nameAr: current.nameAr,
          parentId: current.parentId,
        } : null,
      };
    }),
    parentAccountId: data.parentAccountId,
    parentAccountCode: parent.code,
    leadingZeros: data.leadingZeros,
    allowReassign: data.allowReassign,
  });
  if (initialPlan.rows.some(row => row.scopeBlocked)) {
    throw new SupplierBulkAccountPlanError(
      "غير مصرح بإجراء العملية على أحد الموردين أو معرّفاته",
      403,
    );
  }
  const createBranchId = initialPlan.rows.some(row => row.status === "create")
    ? await resolveSupplierImportCreateBranchId(
        connection,
        req,
        companyId,
        data.branchId,
      )
    : null;

  const codeOwners = new Map(
    allAccounts
      .filter((account: typeof accountsTable.$inferSelect) => account.code)
      .map((account: typeof accountsTable.$inferSelect) => [String(account.code), account]),
  );
  const siblingNames = new Map(
    allAccounts
      .filter((account: typeof accountsTable.$inferSelect) => account.parentId === data.parentAccountId)
      .map((account: typeof accountsTable.$inferSelect) => [
        String(account.nameAr ?? "").trim().toLowerCase(),
        account,
      ]),
  );
  const rows = initialPlan.rows.map((row): SupplierBulkImportPlanRow => {
    if (row.error) return row;
    const codeOwner = row.accountCode ? codeOwners.get(row.accountCode) : null;
    if (codeOwner) {
      return {
        ...row,
        status: "error",
        error: `رقم الحساب ${row.accountCode} مستخدم بالفعل — غيّر عدد الأصفار أو الحساب الأب`,
      };
    }
    const sibling = siblingNames.get(row.nameAr.trim().toLowerCase());
    if (sibling) {
      return {
        ...row,
        status: "error",
        error: `يوجد حساب فرعي باسم "${row.nameAr}" تحت الحساب الرئيسي بالفعل`,
      };
    }
    return row;
  });
  const summary = summarizeSupplierBulkImportRows(rows);
  return {
    parent,
    createBranchId,
    childAccountLevel: accountDepthFromParentChain(parent, accountById) + 1,
    plan: {
      rows,
      summary,
      canCommit: summary.errors === 0 && summary.blocked === 0,
    },
  };
}

router.post("/bulk-import-assign-accounts/preview", async (req, res): Promise<void> => {
  const parsed = bulkImportAssignAccountsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "بيانات ملف الموردين أو إعدادات الحسابات غير صحيحة" });
    return;
  }
  const companyId = resolveCompanyId(req, parsed.data.companyId);
  if (!companyId) {
    res.status(400).json({ error: "معرّف الشركة مطلوب" });
    return;
  }
  try {
    const { parent, plan } = await loadSupplierBulkImportPlan(
      db,
      req,
      companyId,
      parsed.data,
      false,
    );
    res.json({
      ...publicSupplierBulkImportPlan(plan),
      parentAccount: { id: parent.id, code: parent.code, nameAr: parent.nameAr },
    });
  } catch (error: unknown) {
    if (error instanceof SupplierBulkAccountPlanError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    req.log?.error({ error }, "Supplier Excel account preview failed");
    res.status(500).json({ error: "تعذّرت معاينة ملف الموردين" });
  }
});

router.post("/bulk-import-assign-accounts", async (req, res): Promise<void> => {
  const parsed = bulkImportAssignAccountsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "بيانات ملف الموردين أو إعدادات الحسابات غير صحيحة" });
    return;
  }
  const companyId = resolveCompanyId(req, parsed.data.companyId);
  if (!companyId) {
    res.status(400).json({ error: "معرّف الشركة مطلوب" });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('supplier-bulk-account-company'),
          ${companyId}::int
        )
      `);
      await lockSupplierIdentity(tx, companyId);
      const { parent, plan, createBranchId, childAccountLevel } = await loadSupplierBulkImportPlan(
        tx,
        req,
        companyId,
        parsed.data,
        true,
      );
      if (!plan.canCommit) {
        const firstError = plan.rows.find(row => row.error)?.error
          ?? "يحتوي الملف على صفوف غير صالحة";
        throw new SupplierBulkAccountPlanError(firstError, 409);
      }

      const persistedSuppliers: Array<{
        id: number;
        nameAr: string;
        nameEn: string | null;
        planRow: SupplierBulkImportPlanRow;
      }> = [];
      let suppliersCreated = 0;
      let suppliersUpdated = 0;
      for (const row of plan.rows) {
        if (row.supplierId != null) {
          const [saved] = await tx.update(suppliersTable)
            .set(row.patch as Partial<typeof suppliersTable.$inferInsert>)
            .where(and(
              eq(suppliersTable.id, row.supplierId),
              eq(suppliersTable.companyId, companyId),
              ...branchScopeSpread(req, suppliersTable.branchId, undefined),
            ))
            .returning({
              id: suppliersTable.id,
              nameAr: suppliersTable.nameAr,
              nameEn: suppliersTable.nameEn,
            });
          if (!saved) {
            throw new SupplierBulkAccountPlanError(
              `تغيّر نطاق المورد "${row.nameAr}" أثناء التنفيذ — لم يتم حفظ أي شيء`,
              409,
            );
          }
          persistedSuppliers.push({ ...saved, planRow: row });
          suppliersUpdated++;
        } else {
          const [saved] = await tx.insert(suppliersTable).values({
            companyId,
            branchId: createBranchId,
            accountId: null,
            country: row.patch.country ?? "SA",
            currencyCode: row.patch.currencyCode ?? "SAR",
            ...row.patch,
          } as typeof suppliersTable.$inferInsert).returning({
            id: suppliersTable.id,
            nameAr: suppliersTable.nameAr,
            nameEn: suppliersTable.nameEn,
          });
          if (!saved) throw new Error("تعذّر إنشاء المورد");
          persistedSuppliers.push({ ...saved, planRow: row });
          suppliersCreated++;
        }
      }

      const codes = persistedSuppliers.map(supplier => supplier.planRow.accountCode!);
      await tx.execute(sql`
        INSERT INTO supplier_bulk_account_code_guards (company_id, code)
        SELECT ${companyId}::int, value
          FROM jsonb_array_elements_text(${JSON.stringify(codes)}::jsonb)
        ON CONFLICT (company_id, code) DO NOTHING
      `);
      const createdAccounts = await tx.insert(accountsTable).values(
        persistedSuppliers.map((supplier) => ({
          companyId,
          parentId: parsed.data.parentAccountId,
          code: supplier.planRow.accountCode!,
          nameAr: supplier.nameAr,
          nameEn: supplier.nameEn,
          accountType: "liability" as const,
          reportDirection: parent.reportDirection ?? null,
          level: childAccountLevel,
          isPosting: true,
          isActive: true,
        })),
      ).returning({ id: accountsTable.id, code: accountsTable.code });
      const createdAccountByCode = new Map(createdAccounts.map(account => [account.code, account.id]));

      const assignments = [];
      for (const supplier of persistedSuppliers) {
        const accountCode = supplier.planRow.accountCode!;
        const accountId = createdAccountByCode.get(accountCode);
        if (!accountId) throw new Error("تعذّر مطابقة الحساب الجديد بالمورد");
        const oldAccountCondition = supplier.planRow.previousAccountId == null
          ? isNull(suppliersTable.accountId)
          : eq(suppliersTable.accountId, supplier.planRow.previousAccountId);
        const [updated] = await tx.update(suppliersTable).set({ accountId }).where(and(
          eq(suppliersTable.id, supplier.id),
          eq(suppliersTable.companyId, companyId),
          oldAccountCondition,
          ...branchScopeSpread(req, suppliersTable.branchId, undefined),
        )).returning({ id: suppliersTable.id });
        if (!updated) {
          throw new SupplierBulkAccountPlanError(
            `تغيّر ربط المورد "${supplier.nameAr}" أثناء التنفيذ — لم يتم حفظ أي شيء`,
            409,
          );
        }
        assignments.push({
          supplierId: supplier.id,
          supplierName: supplier.nameAr,
          accountId,
          accountCode,
          previousAccountId: supplier.planRow.previousAccountId,
        });
      }

      if (parent.isPosting) {
        await tx.update(accountsTable).set({
          isPosting: false,
          updatedAt: new Date(),
        }).where(and(
          eq(accountsTable.id, parsed.data.parentAccountId),
          eq(accountsTable.companyId, companyId),
        ));
      }

      return {
        created: assignments.length,
        suppliersCreated,
        suppliersUpdated,
        reassigned: assignments.filter(assignment => assignment.previousAccountId != null).length,
        parentAccount: { id: parent.id, code: parent.code, nameAr: parent.nameAr },
        assignments,
      };
    });
    res.status(201).json(result);
  } catch (error: unknown) {
    if (error instanceof SupplierBulkAccountPlanError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      res.status(409).json({
        error: "تعارض رقم حساب أو بيانات مورد مع عملية أخرى — لم يتم حفظ أي شيء",
      });
      return;
    }
    req.log?.error({ error }, "Supplier Excel import and account assignment failed");
    res.status(500).json({ error: "تعذّر استيراد الموردين وإنشاء الحسابات" });
  }
});

// Explicit bulk repair tool for imported suppliers that have no AP account.
// This route is deliberately independent from POST / and PUT /:id so the
// existing single-supplier account creation and linking behavior stays intact.
router.post("/bulk-assign-accounts", async (req, res): Promise<void> => {
  const parsed = bulkAssignAccountsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "بيانات إنشاء حسابات الموردين غير صحيحة" });
    return;
  }

  const { parentAccountId, leadingZeros, allowReassign } = parsed.data;
  const supplierIds = [...new Set(parsed.data.supplierIds)];
  if (supplierIds.length !== parsed.data.supplierIds.length) {
    res.status(400).json({ error: "قائمة الموردين تحتوي على تكرار" });
    return;
  }

  const companyId = resolveCompanyId(req, parsed.data.companyId);
  if (!companyId) {
    res.status(400).json({ error: "معرّف الشركة مطلوب" });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      // All account-code INSERTs/changes take this same lock through the
      // database trigger installed by ensureSchema. Unlike a table lock, it
      // serializes only account writers for this company and never blocks
      // reads or another company's chart.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('supplier-bulk-account-company'),
          ${companyId}::int
        )
      `);

      const [parent] = await tx.select().from(accountsTable).where(and(
        eq(accountsTable.id, parentAccountId),
        eq(accountsTable.companyId, companyId),
      ));
      if (!parent) {
        throw new SupplierBulkAccountPlanError("الحساب الرئيسي غير موجود في هذه الشركة");
      }
      if (parent.accountType !== "liability") {
        throw new SupplierBulkAccountPlanError("يجب اختيار حساب رئيسي من نوع الالتزامات");
      }
      if (!parent.isActive) {
        throw new SupplierBulkAccountPlanError("الحساب الرئيسي المختار غير نشط");
      }
      const allAccounts = await tx.select().from(accountsTable)
        .where(eq(accountsTable.companyId, companyId));
      const accountById = new Map<number, typeof accountsTable.$inferSelect>(
        allAccounts.map(account => [account.id, account]),
      );
      const childAccountLevel = accountDepthFromParentChain(parent, accountById) + 1;

      const rows = await tx.select({
        id: suppliersTable.id,
        nameAr: suppliersTable.nameAr,
        nameEn: suppliersTable.nameEn,
        accountId: suppliersTable.accountId,
      }).from(suppliersTable).where(and(
        eq(suppliersTable.companyId, companyId),
        inArray(suppliersTable.id, supplierIds),
        ...branchScopeSpread(req, suppliersTable.branchId, undefined),
      )).for("update");
      const rowById = new Map(rows.map(row => [row.id, row]));
      const orderedSuppliers = supplierIds.map(id => rowById.get(id)).filter(Boolean) as typeof rows;
      if (orderedSuppliers.length !== supplierIds.length) {
        throw new SupplierBulkAccountPlanError(
          "بعض الموردين المحددين غير موجودين أو خارج نطاق الفرع المسموح",
          403,
        );
      }

      const alreadyLinked = orderedSuppliers.filter(supplier => supplier.accountId != null);
      if (alreadyLinked.length > 0 && !allowReassign) {
        throw new SupplierBulkAccountPlanError(
          `يوجد ${alreadyLinked.length} مورد مرتبط بحساب بالفعل — فعّل استبدال الربط أو ألغِ تحديده`,
          409,
        );
      }

      const selectedNames = new Set<string>();
      for (const supplier of orderedSuppliers) {
        const normalized = String(supplier.nameAr ?? "").trim().toLowerCase();
        if (!normalized) {
          throw new SupplierBulkAccountPlanError(`المورد رقم ${supplier.id} ليس له اسم عربي صالح`);
        }
        if (selectedNames.has(normalized)) {
          throw new SupplierBulkAccountPlanError(
            `اسم المورد "${supplier.nameAr}" مكرر داخل التحديد`,
            409,
          );
        }
        selectedNames.add(normalized);
      }

      const codes = buildSupplierBulkAccountCodes(parent.code, leadingZeros, orderedSuppliers.length);
      const [codeConflicts, siblingAccounts] = await Promise.all([
        tx.select({ code: accountsTable.code, nameAr: accountsTable.nameAr })
          .from(accountsTable)
          .where(and(
            eq(accountsTable.companyId, companyId),
            inArray(accountsTable.code, codes),
          )),
        tx.select({ nameAr: accountsTable.nameAr })
          .from(accountsTable)
          .where(and(
            eq(accountsTable.companyId, companyId),
            eq(accountsTable.parentId, parentAccountId),
          )),
      ]);
      if (codeConflicts.length > 0) {
        throw new SupplierBulkAccountPlanError(
          `رقم الحساب ${codeConflicts[0]!.code} مستخدم بالفعل — لم يتم إنشاء أي حساب`,
          409,
        );
      }

      const siblingNames = new Set(
        siblingAccounts.map(account => String(account.nameAr ?? "").trim().toLowerCase()),
      );
      const nameConflict = orderedSuppliers.find(
        supplier => siblingNames.has(String(supplier.nameAr ?? "").trim().toLowerCase()),
      );
      if (nameConflict) {
        throw new SupplierBulkAccountPlanError(
          `يوجد حساب فرعي باسم "${nameConflict.nameAr}" تحت الحساب الرئيسي بالفعل`,
          409,
        );
      }

      // Reserve these exact keys before insertion. The account trigger rejects
      // a later stale-code insert from any other producer, while all unrelated
      // historical or future account codes keep their existing behavior.
      await tx.execute(sql`
        INSERT INTO supplier_bulk_account_code_guards (company_id, code)
        SELECT ${companyId}::int, value
          FROM jsonb_array_elements_text(${JSON.stringify(codes)}::jsonb)
        ON CONFLICT (company_id, code) DO NOTHING
      `);

      const created = await tx.insert(accountsTable).values(
        orderedSuppliers.map((supplier, index) => ({
          companyId,
          parentId: parentAccountId,
          code: codes[index]!,
          nameAr: String(supplier.nameAr).trim(),
          nameEn: supplier.nameEn ?? null,
          accountType: "liability" as const,
          reportDirection: parent.reportDirection ?? null,
          level: childAccountLevel,
          isPosting: true,
          isActive: true,
        })),
      ).returning({ id: accountsTable.id, code: accountsTable.code });

      const createdByCode = new Map(created.map(account => [account.code, account.id]));
      const assignments = orderedSuppliers.map((supplier, index) => ({
        supplierId: supplier.id,
        accountId: createdByCode.get(codes[index]!)!,
        accountCode: codes[index]!,
        supplierName: supplier.nameAr,
      }));
      if (assignments.some(assignment => !assignment.accountId)) {
        throw new Error("تعذّر مطابقة الحسابات الجديدة بالموردين");
      }

      const accountIdCase = sql.join(
        assignments.map(assignment =>
          sql`WHEN ${suppliersTable.id} = ${assignment.supplierId} THEN ${assignment.accountId}`),
        sql` `,
      );
      const updatedSuppliers = await tx.update(suppliersTable).set({
        accountId: sql<number>`CASE ${accountIdCase} ELSE ${suppliersTable.accountId} END`,
      }).where(and(
        eq(suppliersTable.companyId, companyId),
        inArray(suppliersTable.id, supplierIds),
        ...(!allowReassign ? [isNull(suppliersTable.accountId)] : []),
        ...branchScopeSpread(req, suppliersTable.branchId, undefined),
      )).returning({ id: suppliersTable.id });
      if (updatedSuppliers.length !== assignments.length) {
        throw new SupplierBulkAccountPlanError(
          "تغيّر ربط أحد الموردين أثناء التنفيذ — لم يتم إنشاء أو ربط أي حساب",
          409,
        );
      }

      if (parent.isPosting) {
        await tx.update(accountsTable).set({
          isPosting: false,
          updatedAt: new Date(),
        }).where(and(
          eq(accountsTable.id, parentAccountId),
          eq(accountsTable.companyId, companyId),
        ));
      }

      return {
        created: assignments.length,
        reassigned: alreadyLinked.length,
        parentAccount: {
          id: parent.id,
          code: parent.code,
          nameAr: parent.nameAr,
        },
        assignments,
      };
    });

    res.status(201).json(result);
  } catch (error: unknown) {
    if (error instanceof SupplierBulkAccountPlanError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      res.status(409).json({
        error: "تعارض رقم حساب مع عملية أخرى — لم يتم إنشاء أو ربط أي حساب",
      });
      return;
    }
    req.log?.error({ error }, "Bulk supplier account assignment failed");
    res.status(500).json({ error: "تعذّر إنشاء وربط حسابات الموردين" });
  }
});

router.post("/", async (req, res) => {
  const data = req.body;
  const classification = z.enum(["supplier", "subcontractor", "both"]).nullable().optional().safeParse(data?.partyClassification);
  if (!classification.success) { res.status(400).json({ error: "تصنيف المورد غير صالح" }); return; }
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
  // NOTE: sharing one COA account across several suppliers is ALLOWED by
  // design (e.g. many small local suppliers linked to a shared "مورد عام"
  // account so they don't clutter the chart of accounts).

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
  const requestedAccountId: number | null = data.accountId ? Number(data.accountId) : null;
  if (requestedAccountId) {
    // Tenant guard: the linked account must belong to THIS company.
    const [acc] = await db.select({ id: accountsTable.id }).from(accountsTable)
      .where(and(eq(accountsTable.id, requestedAccountId), eq(accountsTable.companyId, companyId)));
    if (!acc) { res.status(400).json({ error: "الحساب المحدّد غير موجود في هذه الشركة" }); return; }
  }

  try {
    const supplier = await db.transaction(async (tx) => {
      await lockSupplierIdentity(tx, companyId);
      await assertSupplierIdentityAvailable(tx, companyId, data);
      let accountId = requestedAccountId;
      if (!accountId) {
        if (accountParentId) {
          accountId = await ensureSupplierLedgerUnderParent(
            companyId,
            String(data.nameAr).trim(),
            accountParentId,
            tx,
          );
        }
        if (!accountId) {
          accountId = await ensureSupplierAccount(
            companyId,
            String(data.nameAr).trim(),
            supplierCategory,
            tx,
          );
        }
      }
      const [created] = await tx.insert(suppliersTable).values({
        companyId,
        partyClassification: classification.data === undefined ? "supplier" : classification.data,
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
      return created;
    });
    res.status(201).json(supplier);
  } catch (error: any) {
    if (error instanceof SupplierBulkAccountPlanError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
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

const updateSupplier = async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
  if (!existing) { res.status(404).json({ error: "المورد غير موجود" }); return; }
  const companyId = resolveCompanyId(req, existing.companyId);
  if (companyId && existing.companyId !== companyId) { res.status(403).json({ error: "غير مصرح" }); return; }
  const data = req.body;
  const classification = z.enum(["supplier", "subcontractor", "both"]).nullable().optional().safeParse(data?.partyClassification);
  if (!classification.success) { res.status(400).json({ error: "تصنيف المورد غير صالح" }); return; }

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
  // Shared COA accounts across suppliers are allowed (e.g. "مورد عام").

  if (data.branchId) {
    const [b] = await db.select().from(branchesTable).where(and(eq(branchesTable.id, Number(data.branchId)), eq(branchesTable.companyId, existing.companyId)));
    if (!b) { res.status(400).json({ error: "الفرع المحدّد غير موجود في هذه الشركة" }); return; }
  }

  // Resolve the final accountId. Never silently NULL the link on edit:
  //  - explicit accountId from the form wins;
  //  - otherwise keep the existing link IF its account still exists;
  //  - otherwise (never linked, or the linked account was deleted) re-mint
  //    an AP sub-account — same behaviour as create.
  const requestedAccountId: number | null = data.accountId ? Number(data.accountId) : null;
  if (requestedAccountId) {
    // Tenant guard: the linked account must belong to THIS company.
    const [acc] = await db.select({ id: accountsTable.id }).from(accountsTable)
      .where(and(eq(accountsTable.id, requestedAccountId), eq(accountsTable.companyId, existing.companyId)));
    if (!acc) { res.status(400).json({ error: "الحساب المحدّد غير موجود في هذه الشركة" }); return; }
  }
  const supplierCategory: SupplierCategory | undefined =
    data.accountCategory === "foreign" ? "foreign"
    : data.accountCategory === "local" ? "local"
    : undefined;

  const [supplier] = await db.transaction(async (tx) => {
    await lockSupplierIdentity(tx, existing.companyId);
    await assertSupplierIdentityAvailable(tx, existing.companyId, {
      code: data.code ?? existing.code,
      nameAr: data.nameAr ?? existing.nameAr,
      vatNumber: data.vatNumber ?? existing.vatNumber,
      crNumber: data.crNumber ?? existing.crNumber,
    }, id);
    let accountId = requestedAccountId;
    if (!accountId && existing.accountId != null) {
      const [still] = await tx.select({ id: accountsTable.id }).from(accountsTable)
        .where(and(eq(accountsTable.id, existing.accountId), eq(accountsTable.companyId, existing.companyId)));
      if (still) accountId = existing.accountId;
    }
    if (!accountId) {
      accountId = await ensureSupplierAccount(
        existing.companyId,
        String(data.nameAr ?? existing.nameAr ?? "").trim(),
        supplierCategory,
        tx,
      );
    }
    return tx.update(suppliersTable).set({
      ...(classification.data !== undefined ? { partyClassification: classification.data } : {}),
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
      // The legacy PUT form sends a complete record; PATCH is sparse and must
      // not erase unrelated fields when only classification is being changed.
      ...(req.method === "PATCH"
        ? Object.fromEntries(
            ["code", "nameAr", "nameEn", "vatNumber", "crNumber", "email", "phone",
              "city", "district", "street", "buildingNumber", "postalCode", "country"]
              .filter(key => data[key] === undefined)
              .map(key => [key, (existing as any)[key]]),
          )
        : {}),
      ...(data.branchId !== undefined
        ? { branchId: data.branchId === null || data.branchId === "" ? null : Number(data.branchId) }
        : {}),
      ...(typeof data.includeInStatements === "boolean"
        ? { includeInStatements: data.includeInStatements }
        : {}),
    }).where(eq(suppliersTable.id, id)).returning();
  });
  if (!supplier) { res.status(404).json({ error: "المورد غير موجود" }); return; }
  res.json(supplier);
};
router.put("/:id", updateSupplier);
router.patch("/:id", updateSupplier);

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
