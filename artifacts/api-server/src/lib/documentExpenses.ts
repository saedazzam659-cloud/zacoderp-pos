import { db, centralPool, getActiveExternalDb, runWithExternalDb, documentExpensesTable, purchaseInvoicesTable, purchaseInvoiceLinesTable, purchaseReturnsTable, purchaseReturnLinesTable, salesInvoicesTable, salesInvoiceLinesTable, salesReturnsTable, salesReturnLinesTable, costCentersTable, itemsTable, itemGroupsTable, accountsTable, accountingMappingsTable, warehousesTable, suppliersTable, customersTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { branchScopeSpread, intersectBranchRequest, resolveCompanyId } from "../middleware/auth.js";
import { allocateExpense, cents, type ExpenseRow, type ExpenseLine } from "./documentExpenseAllocation.js";
import { lockStockBalances } from "./stockHelpers.js";

export const expenseDocuments: Record<string, { header: any; lines: any; parent: any; module: string }> = {
  sales_invoice: { header: salesInvoicesTable, lines: salesInvoiceLinesTable, parent: salesInvoiceLinesTable.invoiceId, module: "sales_invoices" },
  sales_return: { header: salesReturnsTable, lines: salesReturnLinesTable, parent: salesReturnLinesTable.returnId, module: "sales_returns" },
  purchase_invoice: { header: purchaseInvoicesTable, lines: purchaseInvoiceLinesTable, parent: purchaseInvoiceLinesTable.invoiceId, module: "purchase_invoices" },
  purchase_return: { header: purchaseReturnsTable, lines: purchaseReturnLinesTable, parent: purchaseReturnLinesTable.returnId, module: "purchase_returns" },
};
export async function ensureDocumentExpenseSchema() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS document_expenses (
    company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    document_type text NOT NULL, document_id integer NOT NULL,
    version integer NOT NULL DEFAULT 0, rows jsonb NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY(company_id, document_type, document_id))`);
}
/** Isolate optional legacy DB work whose caller deliberately catches errors. */
export async function withDocumentExpenseSavepoint<T>(work: () => Promise<T>): Promise<T> {
  const context = getActiveExternalDb();
  const activePool = context?.pool ?? centralPool;
  return db.transaction(async tx =>
    runWithExternalDb({ db: tx as any, pool: activePool }, work));
}
export function expenseWhere(cid: number, type: string, id: number) {
  return and(eq(documentExpensesTable.companyId, cid), eq(documentExpensesTable.documentType, type), eq(documentExpensesTable.documentId, id));
}
export async function readExpenseRows(executor: any, cid: number, type: string, id: number) {
  const [state] = await executor.select().from(documentExpensesTable).where(expenseWhere(cid, type, id));
  return { version: state?.version ?? 0, rows: (state?.rows ?? []) as ExpenseRow[] };
}
export async function expenseDocument(executor: any, req: any, cid: number, type: string, id: number, lock = false) {
  const config = expenseDocuments[type];
  if (!config || !Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("نوع أو رقم المستند غير صالح"), { status: 400 });
  let query = executor.select().from(config.header).where(and(eq(config.header.id, id), eq(config.header.companyId, cid), ...branchScopeSpread(req, config.header.branchId, undefined)));
  if (lock) query = query.for("update");
  const [doc] = await query;
  if (!doc) throw Object.assign(new Error("المستند غير موجود أو خارج نطاق الفروع"), { status: 404 });
  return doc;
}
export async function expenseOptions(executor: any, cid: number, type: string, doc: any) {
  const centers = await executor.select().from(costCentersTable).where(and(eq(costCentersTable.companyId, cid), eq(costCentersTable.isActive, true), eq(costCentersTable.isPosting, true)));
  const lines: ExpenseLine[] = [];
  if (type === "purchase_invoice") {
    const source = await executor.select().from(purchaseInvoiceLinesTable).where(eq(purchaseInvoiceLinesTable.invoiceId, doc.id));
    for (const line of source) {
      if (!line.itemId || !line.warehouseId) continue;
      const [warehouse] = await executor.select({ id: warehousesTable.id }).from(warehousesTable).where(and(eq(warehousesTable.id, line.warehouseId), eq(warehousesTable.companyId, cid)));
      if (!warehouse) throw new Error("مستودع بند الفاتورة غير تابع للشركة");
      const [item] = await executor.select().from(itemsTable).where(and(eq(itemsTable.companyId, cid), eq(itemsTable.id, line.itemId)));
      if (!item || ["service", "prepaid_expense"].includes(item.itemType ?? "")) continue;
      if (item.groupId) {
        const [group] = await executor.select().from(itemGroupsTable).where(and(eq(itemGroupsTable.id, item.groupId), eq(itemGroupsTable.companyId, cid)));
        if (group?.categoryType && group.categoryType !== "inventory" && group.categoryType !== "normal") continue;
      }
      const quantity = (Number(line.qty || 0) + Number(line.freeQty || 0)) * Number(line.conversionFactor || 1);
      if (quantity <= 0) continue;
      lines.push({ lineId: line.id, itemId: line.itemId, warehouseId: line.warehouseId, description: line.itemName ?? "", quantity, value: Math.max(0, Number(line.finalCost || line.lineTotal || 0)) });
    }
  }
  return { canCapitalize: type === "purchase_invoice" && !doc.lcId && !doc.sourceGrnId && !Number(doc.totalExpensesLoaded || 0), lines, costCenters: centers.map((c: any) => ({ id: c.id, code: c.code, name: c.nameAr })) };
}
export function validateExpenseRows(input: unknown, options: Awaited<ReturnType<typeof expenseOptions>>): ExpenseRow[] {
  if (!Array.isArray(input) || input.length > 100) throw new Error("المصاريف يجب أن تكون قائمة لا تتجاوز 100 بند");
  return input.map(r => {
    if (!r || typeof r.description !== "string" || !r.description.trim() || r.description.length > 500) throw new Error("وصف المصروف مطلوب (500 حرف كحد أقصى)");
    if (!["period", "capitalized"].includes(r.treatment) || !["value", "quantity", "manual"].includes(r.allocationMethod)) throw new Error("معالجة أو طريقة توزيع غير صالحة");
    if (r.treatment === "capitalized" && !options.canCapitalize) throw new Error("تحميل التكلفة متاح فقط لفاتورة مشتريات مباشرة غير مرتبطة باعتماد أو استلام مخزني");
    if (r.costCenterId != null && !options.costCenters.some((c: any) => c.id === r.costCenterId)) throw new Error("مركز التكلفة غير صالح لهذه الشركة");
    if (r.reference != null && (typeof r.reference !== "string" || r.reference.length > 250)) throw new Error("مرجع المصروف غير صالح");
    const row: ExpenseRow = { description: r.description.trim(), amount: cents(r.amount) / 100, treatment: r.treatment, allocationMethod: r.allocationMethod, allocations: Array.isArray(r.allocations) ? r.allocations : [], costCenterId: r.costCenterId ?? null, reference: r.reference ?? "" };
    allocateExpense(row, options.lines);
    return row;
  });
}
export async function expenseSnapshot(executor: any, cid: number, type: string, doc: any) {
  const state = await readExpenseRows(executor, cid, type, doc.id);
  const options = await expenseOptions(executor, cid, type, doc);
  // Invalidated manual allocations remain visible so users can repair them.
  const allocationPreviews = state.rows.map((row, rowIndex) => {
    try { return { rowIndex, allocations: allocateExpense(row, options.lines) }; }
    catch (e: any) { return { rowIndex, allocations: [], error: e.message }; }
  });
  return { ...state, status: doc.status, editable: doc.status === "draft", options, allocationPreviews };
}
export async function capitalizedExpenseShares(executor: any, cid: number, doc: any): Promise<Map<number, number>> {
  const state = await readExpenseRows(executor, cid, "purchase_invoice", doc.id);
  const shares = new Map<number, number>();
  if (!state.rows.length) return shares;
  const options = await expenseOptions(executor, cid, "purchase_invoice", doc);
  for (const row of validateExpenseRows(state.rows, options)) {
    for (const a of allocateExpense(row, options.lines)) shares.set(a.lineId, (shares.get(a.lineId) ?? 0) + a.amount);
  }
  return shares;
}
/** Additional balanced lines in the document's existing JE: reversal follows its existing JE lifecycle. */
export async function expenseJournalLines(executor: any, cid: number, type?: string, id?: number) {
  if (!type || !expenseDocuments[type] || !id) return [];
  const state = await readExpenseRows(executor, cid, type, id);
  if (!state.rows.length) return [];
  const config = expenseDocuments[type];
  const [doc] = await executor.select().from(config.header).where(and(eq(config.header.id, id), eq(config.header.companyId, cid)));
  const options = await expenseOptions(executor, cid, type, doc);
  const rows = validateExpenseRows(state.rows, options);
  const mappings = await executor.select().from(accountingMappingsTable).where(and(eq(accountingMappingsTable.companyId, cid), eq(accountingMappingsTable.documentType, type)));
  const account = async (role: string, override?: number | null) => {
    const accountId = override ?? mappings.find((m: any) => m.roleKey === role)?.accountId;
    const [a] = accountId ? await executor.select().from(accountsTable).where(and(eq(accountsTable.id, accountId), eq(accountsTable.companyId, cid))) : [];
    if (!a || !a.isActive || !a.isPosting) throw new Error(`اضبط حساباً نشطاً قابلاً للترحيل لدور ${role}`);
    if (role === "internal_expense_payable" && a.accountType !== "liability") throw new Error("حساب التزام المصاريف يجب أن يكون حساب التزام مستقل");
    if (role === "internal_expense" && a.accountType !== "expense") throw new Error("حساب مصاريف الفترة يجب أن يكون من نوع المصروفات");
    return a.id;
  };
  const payable = await account("internal_expense_payable");
  const supplierAccounts = await executor.select({ id: suppliersTable.id }).from(suppliersTable).where(and(eq(suppliersTable.companyId, cid), eq(suppliersTable.accountId, payable))).limit(1);
  const customerAccounts = await executor.select({ id: customersTable.id }).from(customersTable).where(and(eq(customersTable.companyId, cid), eq(customersTable.accountId, payable))).limit(1);
  if (supplierAccounts.length || customerAccounts.length) throw new Error("حساب التزام المصاريف يجب أن يكون مستقلاً عن حسابات العملاء والموردين");
  const result: any[] = [];
  for (const row of rows) {
    const costCenter = options.costCenters.find((c: any) => c.id === row.costCenterId)?.code ?? null;
    if (row.treatment === "period") {
      const debit = await account("internal_expense");
      if (debit === payable) throw new Error("حساب المصروف يجب أن يختلف عن حساب التزام المصاريف");
      result.push({ accountId: debit, debit: row.amount, description: row.description, costCenter });
    } else {
      for (const a of allocateExpense(row, options.lines)) {
        if (!a.amount) continue;
        const line = options.lines.find(l => l.lineId === a.lineId)!;
        const [warehouse] = await executor.select().from(warehousesTable).where(and(eq(warehousesTable.id, line.warehouseId!), eq(warehousesTable.companyId, cid)));
        const [item] = await executor.select().from(itemsTable).where(and(eq(itemsTable.id, line.itemId), eq(itemsTable.companyId, cid)));
        const [group] = item?.groupId ? await executor.select().from(itemGroupsTable).where(and(eq(itemGroupsTable.id, item.groupId), eq(itemGroupsTable.companyId, cid))) : [];
        const debit = await account("inventory", group?.categoryType === "inventory" ? group.accountId : warehouse?.accountId ?? doc.inventoryAccountId);
        if (debit === payable) throw new Error("حساب المخزون يجب أن يختلف عن حساب التزام المصاريف");
        result.push({ accountId: debit, debit: a.amount, description: row.description, costCenter });
      }
    }
    result.push({ accountId: payable, credit: row.amount, description: row.description, costCenter: null });
  }
  return result;
}

/**
 * Wrap final handlers, not Express next(): await actual completion, buffer JSON,
 * rollback on even caught 4xx/5xx responses, publish success only after COMMIT.
 * Parent locks serialize expense replacement with document edits and posting.
 */
export function installExpenseDocumentTransactions(router: any) {
  const paths: Record<string, string> = { "sales-invoices": "sales_invoice", "sales-returns": "sales_return", "purchase-invoices": "purchase_invoice", "purchase-returns": "purchase_return" };
  for (const layer of router.stack) {
    const route = layer.route;
    const match = typeof route?.path === "string" ? /^\/([^/]+)\/:id(?:\/(post|unpost))?$/.exec(route.path) : null;
    if (!match || !paths[match[1]] || !(route.methods.put || route.methods.patch || route.methods.delete)) continue;
    const type = paths[match[1]];
    // Sales posting already holds the parent row through its atomic stock/JE
    // transaction. Crucially, ZATCA automation runs AFTER that commit; never
    // put an outer transaction around it. Invoice edit/delete/unpost likewise
    // already lock their parent, and must retain their original lifecycle.
    if (type === "sales_invoice" || (type === "sales_return" && match[2] === "post")) continue;
    const last = route.stack[route.stack.length - 1];
    const handler = last.handle;
    last.handle = async (req: any, res: any, next: any) => {
      const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
      if (!cid) return handler(req, res, next);
      const id = Number(req.params.id);
      const send = res.json.bind(res);
      let body: any, captured = false;
      res.json = (value: any) => { body = value; captured = true; return res; };
      try {
        const context = getActiveExternalDb();
        const activePool = context?.pool ?? centralPool;
        await db.transaction(async (tx) => {
          const document = await expenseDocument(tx, req, cid, type, id, true);
          // RecomputeLcUsage remains unchanged. With an outer transaction its
          // aggregate must not race another invoice on the same LC: serialize
          // before any posting/unposting writes, not after the aggregate read.
          if (type === "purchase_invoice" && document.lcId && match[2]) {
            await tx.execute(sql`SELECT id FROM letters_of_credit
              WHERE company_id = ${cid} AND id = ${document.lcId} FOR UPDATE`);
          }
          if (route.methods.put && req.body?.branchId && intersectBranchRequest(req, Number(req.body.branchId)) === "deny")
            throw Object.assign(new Error("الفرع المطلوب خارج نطاق صلاحياتك"), { status: 403 });
          if (type === "sales_return" && match[2] === "unpost" && (await readExpenseRows(tx, cid, type, id)).rows.length) {
            const config = expenseDocuments[type];
            const lines = await tx.select().from(config.lines).where(eq(config.parent, id));
            await lockStockBalances(lines.filter((l: any) => l.itemId && l.warehouseId).map((l: any) => ({ companyId: cid, itemId: l.itemId, warehouseId: l.warehouseId })), tx);
          }
          await runWithExternalDb({ db: tx as any, pool: activePool }, async () => {
            await handler(req, res, next);
            if (!captured) throw new Error("لم تكتمل عملية المستند");
            if (res.statusCode >= 400) throw Object.assign(new Error("DOCUMENT_RESPONSE_ERROR"), { responseCaptured: true });
            if (route.methods.delete) await tx.delete(documentExpensesTable).where(expenseWhere(cid, type, id));
            // PostgreSQL accepts COMMIT on an aborted transaction by rolling
            // it back. Do not publish a captured success if legacy optional
            // code swallowed a SQL exception and left this transaction dead.
            await tx.execute(sql`SELECT 1`);
          });
        });
        res.json = send;
        return send(body);
      } catch (e: any) {
        res.json = send;
        if (e.responseCaptured) return send(body);
        return res.status(e.status ?? 400).json({ error: e.message || "تعذر تنفيذ عملية المستند" });
      }
    };
  }
}