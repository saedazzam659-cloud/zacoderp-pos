import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ensureProjectFinancialLinks } from "./project-financial-link.js";
import { ensureContractingCostAllocationTables } from "./contracting-cost-allocation-service.js";

export type ProjectFinancialSource = {
  sourceType: string;
  sourceId: number;
  sourceDate: string;
  documentNumber: string | null;
  category: "revenue" | "direct_expense" | "cogs" | "prepaid_recognition" | "inventory_receipt" | "inventory_delivery" | "unmapped_cost";
  amount: number;
};

export type ConsolidatedMovement = {
  sourceType: string;
  sourceId: number;
  sourceDate: string;
  documentNumber: string | null;
  category: string;
  revenueAmount: number;
  costAmount: number;
  cashAmount: number;
  projectId?: number;
  note?: string;
  journalEntryId?: number;
  sourceDocumentId?: number;
  allocationSourceType?: string;
  allocationSourceId?: number;
};

export const consolidatedOperationTypes = ["all", "revenue", "cost", "cash", "inventory", "unmapped"] as const;
export type ConsolidatedFilters = { dateFrom?: string; dateTo?: string; operationType?: typeof consolidatedOperationTypes[number] };

export function filterConsolidatedMovements(rows: ConsolidatedMovement[], filters: ConsolidatedFilters) {
  return rows.filter(row => (!filters.dateFrom || row.sourceDate.slice(0, 10) >= filters.dateFrom)
    && (!filters.dateTo || row.sourceDate.slice(0, 10) <= filters.dateTo)
    && (!filters.operationType || filters.operationType === "all"
      || (filters.operationType === "revenue" && row.revenueAmount !== 0)
      || (filters.operationType === "cost" && row.costAmount !== 0)
      || (filters.operationType === "cash" && row.category === "cash")
      || (filters.operationType === "inventory" && row.category.startsWith("inventory_"))
      || (filters.operationType === "unmapped" && row.category === "unmapped_cost")));
}

export function summarizeConsolidatedMovements(rows: ConsolidatedMovement[]) {
  const round = (value: number) => Number(value.toFixed(2));
  const revenue = round(rows.reduce((sum, row) => sum + row.revenueAmount, 0));
  const cost = round(rows.reduce((sum, row) => sum + row.costAmount, 0));
  return { revenue, cost, profit: round(revenue - cost),
    cash: round(rows.reduce((sum, row) => sum + row.cashAmount, 0)) };
}

/** Net all-project allocations before attributing the remaining certificate cost. */
export function certificateCostResidual(currentWork: number, allocatedGlobally: number): number {
  return Number(Math.max(0, currentWork - allocatedGlobally).toFixed(2));
}

/** Source-owned movements only; never convert cash, stock receipts or planning into P&L. */
export async function consolidatedProjectMovements(companyId: number, projectId: number, existing: ProjectFinancialSource[]) {
  const movements: ConsolidatedMovement[] = existing.map(row => ({
    ...row,
    revenueAmount: row.category === "revenue" ? row.amount : 0,
    costAmount: ["direct_expense", "cogs", "prepaid_recognition"].includes(row.category) ? row.amount : 0,
    cashAmount: 0,
    note: row.category === "unmapped_cost" ? "تعذرت مطابقة سطر القيد؛ لا يدخل الإجمالي" : undefined,
  }));
  const result = await db.execute(sql`
    WITH allocation_net AS (
      SELECT source_type, source_record_id, SUM(allocated_amount)::numeric amount
      FROM contracting_cost_allocations WHERE company_id=${companyId}
      GROUP BY source_type, source_record_id
    )
    SELECT 'contracting_material_movement' source_type, m.id source_id, m.movement_date::text source_date,
           je.doc_number document_number, 'material' category,
           CASE WHEN m.direction='return' THEN -m.total_cost::numeric ELSE m.total_cost::numeric END amount,
           m.journal_entry_id journal_entry_id
      FROM contracting_material_movements m
      JOIN journal_entries je ON je.id=m.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
     WHERE m.company_id=${companyId} AND m.project_id=${projectId} AND m.status='posted'
    UNION ALL
    SELECT 'contracting_cost_allocation', a.id, a.source_date::text,
           COALESCE(bill.bill_number, pi.doc_number), a.category,
           a.allocated_amount::numeric,
           COALESCE(pr.posted_journal_id, dep.journal_entry_id, bill.journal_entry_id,
             pi.journal_entry_id, jl.entry_id)
      FROM contracting_cost_allocations a
      LEFT JOIN payroll_allocation_snapshots ps ON a.source_type='payroll_snapshot'
        AND ps.id=a.source_record_id AND ps.company_id=${companyId}
      LEFT JOIN payroll_runs pr ON pr.id=ps.payroll_run_id AND pr.company_id=${companyId}
      LEFT JOIN fa_depreciation_runs dep ON a.source_type='fixed_asset_depreciation'
        AND dep.id=a.source_record_id AND dep.company_id=${companyId}
      LEFT JOIN contracting_progress_bills bill ON a.source_type='subcontract_bill'
        AND bill.id=a.source_record_id AND bill.company_id=${companyId}
      LEFT JOIN purchase_invoice_lines pil ON a.source_type='purchase_invoice_line'
        AND pil.id=a.source_record_id AND pil.company_id=${companyId}
      LEFT JOIN purchase_invoices pi ON pi.id=pil.invoice_id AND pi.company_id=${companyId}
      LEFT JOIN journal_entry_lines jl ON a.source_type='journal_expense_line' AND jl.id=a.source_record_id
     WHERE a.company_id=${companyId} AND a.project_id=${projectId}
       AND (a.category <> 'material' OR a.source_type IN ('purchase_invoice_line','journal_expense_line'))
       AND (a.source_type <> 'payroll_snapshot' OR
         (pr.status='posted' AND EXISTS (SELECT 1 FROM journal_entries j
           WHERE j.id=pr.posted_journal_id AND j.company_id=${companyId} AND j.status='posted')))
       AND (a.source_type <> 'fixed_asset_depreciation' OR
         (dep.status='posted' AND EXISTS (SELECT 1 FROM journal_entries j
           WHERE j.id=dep.journal_entry_id AND j.company_id=${companyId} AND j.status='posted')))
       AND (a.source_type <> 'subcontract_bill' OR EXISTS (
         SELECT 1 FROM contracting_progress_bills b JOIN journal_entries j
           ON j.id=b.journal_entry_id AND j.company_id=${companyId} AND j.status='posted'
          WHERE b.id=a.source_record_id AND b.company_id=${companyId}
            AND b.reversal_journal_entry_id IS NULL))
       AND (a.source_type <> 'journal_expense_line' OR EXISTS (
         SELECT 1 FROM journal_entry_lines l JOIN journal_entries j
           ON j.id=l.entry_id AND j.company_id=${companyId} AND j.status='posted'
          WHERE l.id=a.source_record_id))
       AND (a.source_type <> 'purchase_invoice_line' OR EXISTS (
         SELECT 1 FROM purchase_invoice_lines l JOIN purchase_invoices i ON i.id=l.invoice_id
           JOIN journal_entries j ON j.id=i.journal_entry_id AND j.company_id=${companyId} AND j.status='posted'
          WHERE l.id=a.source_record_id AND i.company_id=${companyId} AND i.status='posted'))
    UNION ALL
    SELECT 'journal_entry_line', l.id, je.entry_date::text, je.doc_number,
           CASE WHEN ac.account_type='revenue' THEN 'revenue' ELSE 'manual_expense' END,
           CASE WHEN ac.account_type='revenue' THEN (l.credit::numeric-l.debit::numeric)*COALESCE(je.exchange_rate::numeric,1)
                ELSE CASE WHEN l.debit::numeric-l.credit::numeric > 0
                  THEN GREATEST((l.debit::numeric-l.credit::numeric)*COALESCE(je.exchange_rate::numeric,1)
                    - COALESCE(an.amount,0),0)
                  ELSE (l.debit::numeric-l.credit::numeric)*COALESCE(je.exchange_rate::numeric,1) END END, je.id
      FROM journal_entry_lines l
      JOIN journal_entries je ON je.id=l.entry_id AND je.company_id=${companyId} AND je.status='posted'
      JOIN accounts ac ON ac.id=l.account_id AND ac.company_id=${companyId}
      LEFT JOIN allocation_net an ON an.source_type='journal_expense_line' AND an.source_record_id=l.id
     WHERE l.project_id=${projectId} AND ac.account_type IN ('revenue','expense')
       AND je.entry_type IN ('general','opening','closing','adjustment','depreciation')
       AND NOT EXISTS (SELECT 1 FROM purchase_invoices x WHERE x.company_id=${companyId} AND x.journal_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM purchase_returns x WHERE x.company_id=${companyId} AND x.journal_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM sales_invoices x WHERE x.company_id=${companyId} AND x.journal_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM sales_returns x WHERE x.company_id=${companyId} AND x.journal_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM goods_receipts x WHERE x.company_id=${companyId} AND x.journal_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM goods_deliveries x WHERE x.company_id=${companyId} AND x.journal_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM payment_vouchers x WHERE x.company_id=${companyId} AND x.journal_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM receipt_vouchers x WHERE x.company_id=${companyId} AND x.journal_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM accounting_adjustment_runs x WHERE x.company_id=${companyId} AND x.journal_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM payroll_runs x WHERE x.company_id=${companyId} AND x.posted_journal_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM fa_depreciation_runs x WHERE x.company_id=${companyId} AND x.journal_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM contracting_progress_bills x WHERE x.company_id=${companyId} AND (x.journal_entry_id=je.id OR x.reversal_journal_entry_id=je.id))
       AND NOT EXISTS (SELECT 1 FROM contracting_material_movements x WHERE x.company_id=${companyId} AND x.journal_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM contracting_accounting_settlements x WHERE x.company_id=${companyId} AND (x.journal_entry_id=je.id OR x.reversal_journal_entry_id=je.id))
       AND NOT EXISTS (SELECT 1 FROM contracting_fiscal_invoices x WHERE x.company_id=${companyId} AND x.journal_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM production_cost_allocations x WHERE x.company_id=${companyId} AND (x.reclassification_journal_entry_id=je.id OR x.reversal_journal_entry_id=je.id))
    UNION ALL
    SELECT 'contracting_settlement', s.id, s.settlement_date::text, je.doc_number, 'cash',
           CASE WHEN s.direction='outgoing' AND s.kind IN ('bill_receipt','advance_receipt','retention_receipt') THEN s.amount::numeric
                WHEN s.direction='incoming' AND s.kind IN ('bill_payment','advance_payment','retention_payment') THEN -s.amount::numeric
                ELSE 0::numeric END, je.id
      FROM contracting_accounting_settlements s
      JOIN journal_entries je ON je.id=s.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
     WHERE s.company_id=${companyId} AND s.project_id=${projectId} AND s.status='posted'
       AND s.kind <> 'advance_application'
    UNION ALL
    SELECT 'receipt_voucher_line', l.id, v.date, v.code, 'cash',
           l.amount::numeric * COALESCE(v.exchange_rate::numeric,1), je.id
      FROM receipt_voucher_lines l
      JOIN receipt_vouchers v ON v.id=l.voucher_id AND v.company_id=${companyId} AND v.status='posted'
      JOIN journal_entries je ON je.id=v.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
      JOIN sales_invoices i ON i.id=l.sales_invoice_id AND i.company_id=${companyId} AND i.project_id=${projectId}
     WHERE l.contracting_kind IS NULL
    UNION ALL
    SELECT 'payment_voucher_cash_line', l.id, v.date, v.code, 'cash',
           -l.amount::numeric * COALESCE(v.exchange_rate::numeric,1), je.id
      FROM payment_voucher_lines l
      JOIN payment_vouchers v ON v.id=l.voucher_id AND v.company_id=${companyId} AND v.status='posted'
      JOIN journal_entries je ON je.id=v.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
      LEFT JOIN purchase_invoices i ON i.id=l.purchase_invoice_id AND i.company_id=${companyId}
     WHERE (l.project_id=${projectId} OR (l.project_id IS NULL AND i.project_id=${projectId}))
       AND l.contracting_kind IS NULL
    UNION ALL
    -- Legacy single-voucher header: never infer a share from a multi-line voucher.
    SELECT 'receipt_voucher', v.id, v.date, v.code, 'cash',
           v.amount::numeric * COALESCE(v.exchange_rate::numeric,1), je.id
      FROM receipt_vouchers v
      JOIN sales_invoices i ON i.id=v.sales_invoice_id AND i.company_id=${companyId} AND i.project_id=${projectId}
      JOIN journal_entries je ON je.id=v.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
     WHERE v.company_id=${companyId} AND v.status='posted'
       AND NOT EXISTS (SELECT 1 FROM receipt_voucher_lines l WHERE l.voucher_id=v.id)
       AND NOT EXISTS (SELECT 1 FROM settlement_links sl WHERE sl.company_id=${companyId}
         AND sl.source_type='receipt_voucher' AND sl.source_id=v.id)
    UNION ALL
    SELECT 'payment_voucher', v.id, v.date, v.code, 'cash',
           -v.amount::numeric * COALESCE(v.exchange_rate::numeric,1), je.id
      FROM payment_vouchers v
      JOIN purchase_invoices i ON i.id=v.purchase_invoice_id AND i.company_id=${companyId} AND i.project_id=${projectId}
      JOIN journal_entries je ON je.id=v.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
     WHERE v.company_id=${companyId} AND v.status='posted'
       AND NOT EXISTS (SELECT 1 FROM payment_voucher_lines l WHERE l.voucher_id=v.id)
       AND NOT EXISTS (SELECT 1 FROM settlement_links sl WHERE sl.company_id=${companyId}
         AND sl.source_type='payment_voucher' AND sl.source_id=v.id)
    UNION ALL
    SELECT 'receipt_settlement_link', sl.id, v.date, v.code, 'cash',
           sl.amount::numeric * COALESCE(v.exchange_rate::numeric,1), je.id
      FROM settlement_links sl
      JOIN sales_invoices i ON i.id=sl.sales_invoice_id AND i.company_id=${companyId} AND i.project_id=${projectId}
      JOIN receipt_vouchers v ON v.id=sl.source_id AND v.company_id=${companyId} AND v.status='posted'
      JOIN journal_entries je ON je.id=v.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
     WHERE sl.company_id=${companyId} AND sl.source_type='receipt_voucher'
       AND NOT EXISTS (SELECT 1 FROM receipt_voucher_lines l WHERE l.voucher_id=v.id AND l.sales_invoice_id=i.id)
    UNION ALL
    SELECT 'payment_settlement_link', sl.id, v.date, v.code, 'cash',
           -sl.amount::numeric * COALESCE(v.exchange_rate::numeric,1), je.id
      FROM settlement_links sl
      JOIN purchase_invoices i ON i.id=sl.purchase_invoice_id AND i.company_id=${companyId} AND i.project_id=${projectId}
      JOIN payment_vouchers v ON v.id=sl.source_id AND v.company_id=${companyId} AND v.status='posted'
      JOIN journal_entries je ON je.id=v.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
     WHERE sl.company_id=${companyId} AND sl.source_type='payment_voucher'
       AND NOT EXISTS (SELECT 1 FROM payment_voucher_lines l WHERE l.voucher_id=v.id
         AND (l.purchase_invoice_id=i.id OR l.project_id=${projectId}))
  `);
  const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
  const allocationIds = (rows as any[]).filter(row => row.source_type === "contracting_cost_allocation")
    .map(row => Number(row.source_id));
  const allocationDetails = new Map<number, { sourceType: string; sourceId: number }>();
  if (allocationIds.length) {
    const details = await db.execute(sql`SELECT id, source_type, source_record_id
      FROM contracting_cost_allocations WHERE company_id=${companyId}
        AND id IN (${sql.join(allocationIds.map(id => sql`${id}`), sql`, `)})`);
    for (const row of (Array.isArray(details) ? details : (details as any).rows ?? []) as any[]) {
      allocationDetails.set(Number(row.id), { sourceType: String(row.source_type), sourceId: Number(row.source_record_id) });
    }
  }
  for (const row of rows as any[]) {
    const category = String(row.category);
    const amount = Number(Number(row.amount).toFixed(2));
    movements.push({
      sourceType: String(row.source_type), sourceId: Number(row.source_id),
      sourceDate: String(row.source_date), documentNumber: row.document_number ?? null,
      category, revenueAmount: category === "revenue" ? amount : 0,
      costAmount: category === "cash" || category === "revenue" ? 0 : amount,
      cashAmount: category === "cash" ? amount : 0,
      journalEntryId: row.journal_entry_id == null ? undefined : Number(row.journal_entry_id),
      ...(allocationDetails.has(Number(row.source_id)) && row.source_type === "contracting_cost_allocation"
        ? { allocationSourceType: allocationDetails.get(Number(row.source_id))!.sourceType,
          allocationSourceId: allocationDetails.get(Number(row.source_id))!.sourceId } : {}),
      note: category === "cash" ? "تدفق نقدي فقط؛ ليس إيراداً أو تكلفة إضافية" : undefined,
    });
  }
  const existingIds = movements.filter(row => row.journalEntryId == null
    || ["purchase_return_expense", "payment_voucher_line", "receipt_voucher_line",
      "payment_voucher_cash_line", "receipt_settlement_link", "payment_settlement_link"].includes(row.sourceType));
  if (existingIds.length) {
    // Exact source IDs, never a document-number or amount match.
    const refs = sql.join(existingIds.map(row => sql`(${row.sourceType}, ${row.sourceId})`), sql`, `);
    const result = await db.execute(sql`
      WITH refs(source_type, source_id) AS (VALUES ${refs})
      SELECT refs.source_type, refs.source_id,
        COALESCE(si.journal_entry_id, sr.journal_entry_id, pi.journal_entry_id,
          pr.journal_entry_id, prepi.journal_entry_id, prepay.journal_entry_id,
          pv.journal_entry_id, rv.journal_entry_id, gr.journal_entry_id, gd.journal_entry_id) journal_entry_id,
        COALESCE(si.id, sr.id, pi.id, pr.id, pv.id, rv.id, gr.id, gd.id) source_document_id
      FROM refs
      LEFT JOIN sales_invoices si ON refs.source_type='sales_invoice'
        AND si.id=refs.source_id AND si.company_id=${companyId}
      LEFT JOIN sales_returns sr ON refs.source_type='sales_return'
        AND sr.id=refs.source_id AND sr.company_id=${companyId}
      LEFT JOIN purchase_invoices pi ON refs.source_type='purchase_invoice_expense'
        AND pi.id=refs.source_id AND pi.company_id=${companyId}
      LEFT JOIN journal_entry_lines pl ON refs.source_type='purchase_return_expense' AND pl.id=refs.source_id
      LEFT JOIN purchase_returns pr ON pr.journal_entry_id=pl.entry_id AND pr.company_id=${companyId}
      LEFT JOIN accounting_adjustment_runs prepi ON refs.source_type IN ('prepaid_adjustment_run','purchase_prepaid_adjustment_run')
        AND prepi.id=refs.source_id AND prepi.company_id=${companyId}
      LEFT JOIN payment_voucher_lines pvl ON refs.source_type IN ('payment_voucher_line','payment_voucher_cash_line')
        AND pvl.id=refs.source_id
      LEFT JOIN payment_vouchers pv ON pv.id=pvl.voucher_id AND pv.company_id=${companyId}
      LEFT JOIN receipt_voucher_lines rvl ON refs.source_type='receipt_voucher_line'
        AND rvl.id=refs.source_id
      LEFT JOIN receipt_vouchers rv ON rv.id=rvl.voucher_id AND rv.company_id=${companyId}
      LEFT JOIN goods_receipts gr ON refs.source_type='goods_receipt'
        AND gr.id=refs.source_id AND gr.company_id=${companyId}
      LEFT JOIN goods_deliveries gd ON refs.source_type IN ('goods_delivery','goods_delivery_cogs')
        AND gd.id=refs.source_id AND gd.company_id=${companyId}
      LEFT JOIN journal_entries prepay ON prepay.id=prepi.journal_entry_id AND prepay.company_id=${companyId}
    `);
    const byKey = new Map((Array.isArray(result) ? result : (result as any).rows ?? []).map((row: any) =>
      [`${row.source_type}:${row.source_id}`, row]));
    for (const movement of existingIds) {
      const ref = byKey.get(`${movement.sourceType}:${movement.sourceId}`);
      if (ref?.journal_entry_id != null) movement.journalEntryId = Number(ref.journal_entry_id);
      if (ref?.source_document_id != null) movement.sourceDocumentId = Number(ref.source_document_id);
    }
  }
  return movements.sort((a, b) => a.sourceDate.localeCompare(b.sourceDate) || a.sourceId - b.sourceId);
}

/** Signed amounts: revenue positive; expense/COGS positive; returns negative. */
export async function projectFinancialSources(companyId: number, projectId: number): Promise<ProjectFinancialSource[]> {
  await ensureProjectFinancialLinks();
  await ensureContractingCostAllocationTables();
  const result = await db.execute(sql`
    WITH allocation_net AS (
      -- The allocation service records reversals as negative rows. Net ALL
      -- projects globally; only the unallocated residual belongs to the
      -- document's header/line project.
      SELECT source_type, source_record_id, SUM(allocated_amount)::numeric amount
        FROM contracting_cost_allocations
       WHERE company_id=${companyId} AND source_type IN ('purchase_invoice_line', 'journal_expense_line')
       GROUP BY source_type, source_record_id
    ), purchase_allocated AS (
      SELECT pil.invoice_id, SUM(alloc.amount) amount
        FROM allocation_net alloc
        JOIN purchase_invoice_lines pil ON pil.id=alloc.source_record_id
        JOIN accounts a ON a.id=pil.account_id AND a.company_id=${companyId} AND a.account_type='expense'
       WHERE alloc.source_type='purchase_invoice_line' AND pil.company_id=${companyId}
       GROUP BY pil.invoice_id
    )
    SELECT 'sales_invoice' source_type, i.id source_id, i.invoice_date source_date,
           i.doc_number document_number, 'revenue' category,
           (i.total_amount::numeric - i.vat_amount::numeric) * COALESCE(i.exchange_rate::numeric, 1) amount
      FROM sales_invoices i
      JOIN journal_entries je ON je.id=i.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
     WHERE i.company_id=${companyId} AND i.project_id=${projectId}
       AND i.status='posted'
    UNION ALL
    SELECT 'sales_return', r.id, r.return_date, r.doc_number, 'revenue',
           -(r.total_amount::numeric - r.vat_amount::numeric) * COALESCE(r.exchange_rate::numeric, 1)
      FROM sales_returns r
      JOIN journal_entries je ON je.id=r.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
     WHERE r.company_id=${companyId} AND r.project_id=${projectId}
       AND r.status='posted'
    UNION ALL
    SELECT 'purchase_invoice_expense', i.id, i.invoice_date, i.doc_number, 'direct_expense',
           GREATEST(
             SUM(jel.debit::numeric * COALESCE(je.exchange_rate::numeric, 1) - COALESCE(jalloc.amount, 0))
               - COALESCE(palloc.amount, 0), 0
           )
      FROM purchase_invoices i
      JOIN journal_entries je ON je.id=i.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
      JOIN journal_entry_lines jel ON jel.entry_id=je.id
      JOIN accounts a ON a.id=jel.account_id AND a.company_id=${companyId} AND a.account_type='expense'
      LEFT JOIN allocation_net jalloc ON jalloc.source_type='journal_expense_line' AND jalloc.source_record_id=jel.id
      LEFT JOIN purchase_allocated palloc ON palloc.invoice_id=i.id
     WHERE i.company_id=${companyId} AND i.project_id=${projectId} AND i.status='posted'
       AND jel.debit::numeric > 0
     GROUP BY i.id, i.invoice_date, i.doc_number, palloc.amount
    HAVING GREATEST(
      SUM(jel.debit::numeric * COALESCE(je.exchange_rate::numeric, 1) - COALESCE(jalloc.amount, 0))
        - COALESCE(palloc.amount, 0), 0
    ) > 0
    UNION ALL
    SELECT 'purchase_return_expense', jel.id, r.return_date, r.doc_number, 'direct_expense',
           (jel.debit::numeric - jel.credit::numeric) * COALESCE(je.exchange_rate::numeric, 1)
      FROM purchase_returns r
      JOIN journal_entries je ON je.id=r.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
      JOIN journal_entry_lines jel ON jel.entry_id=je.id
      JOIN accounts a ON a.id=jel.account_id AND a.company_id=${companyId} AND a.account_type='expense'
     WHERE r.company_id=${companyId} AND r.project_id=${projectId} AND r.status='posted'
       AND jel.credit::numeric > 0
    UNION ALL
    SELECT 'purchase_prepaid_adjustment_run', run.id, je.entry_date, je.doc_number,
           CASE WHEN recognized.expense_base > 0 THEN 'prepaid_recognition' ELSE 'unmapped_cost' END,
           GREATEST(recognized.expense_base - recognized.allocated, 0)
      FROM purchase_invoice_lines l
      JOIN purchase_invoices i ON i.id=l.invoice_id AND i.company_id=${companyId}
      JOIN accounting_adjustment_runs run ON run.adjustment_id=l.deferred_adjustment_id
        AND run.company_id=${companyId}
      JOIN journal_entries je ON je.id=run.journal_entry_id AND je.company_id=${companyId}
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(jel.debit::numeric * COALESCE(je.exchange_rate::numeric, 1)), 0) expense_base,
               COALESCE(SUM(COALESCE(alloc.amount, 0)), 0) allocated
          FROM journal_entry_lines jel
          JOIN accounts acct ON acct.id=jel.account_id AND acct.company_id=${companyId} AND acct.account_type='expense'
          LEFT JOIN allocation_net alloc ON alloc.source_type='journal_expense_line' AND alloc.source_record_id=jel.id
         WHERE jel.entry_id=je.id AND jel.debit::numeric > 0
      ) recognized
     WHERE i.project_id=${projectId} AND i.status='posted' AND je.status='posted'
    UNION ALL
    SELECT l.ref_type, l.ref_id, l.tx_date::text, i.doc_number, 'cogs', -SUM(l.total_cost::numeric)
      FROM stock_ledger l JOIN sales_invoices i ON i.id=l.ref_id AND i.company_id=l.company_id
      JOIN journal_entries je ON je.id=i.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
     WHERE l.company_id=${companyId} AND i.project_id=${projectId} AND i.status='posted'
       AND l.ref_type='sales_invoice'
     GROUP BY l.ref_type, l.ref_id, l.tx_date, i.doc_number
    UNION ALL
    SELECT 'goods_delivery_cogs', gd.id, l.tx_date::text, i.doc_number, 'cogs',
           SUM(l.total_cost::numeric)
      FROM sales_invoices i
      JOIN journal_entries ije ON ije.id=i.journal_entry_id AND ije.company_id=${companyId} AND ije.status='posted'
      JOIN goods_deliveries gd ON gd.id=i.source_gdn_id AND gd.company_id=${companyId}
      JOIN journal_entries gje ON gje.id=gd.journal_entry_id AND gje.company_id=${companyId} AND gje.status='posted'
      JOIN stock_ledger l ON l.ref_id=gd.id AND l.ref_type='goods_delivery' AND l.company_id=${companyId}
     WHERE i.company_id=${companyId} AND i.project_id=${projectId} AND i.status='posted'
       AND gd.project_id=i.project_id AND gd.status='invoiced'
     GROUP BY gd.id, l.tx_date, i.doc_number
    UNION ALL
    SELECT l.ref_type, l.ref_id, l.tx_date::text, r.doc_number, 'cogs', -SUM(l.total_cost::numeric)
      FROM stock_ledger l JOIN sales_returns r ON r.id=l.ref_id AND r.company_id=l.company_id
      JOIN journal_entries je ON je.id=r.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
     WHERE l.company_id=${companyId} AND r.project_id=${projectId} AND r.status='posted'
       AND l.ref_type='sales_return'
     GROUP BY l.ref_type, l.ref_id, l.tx_date, r.doc_number
    UNION ALL
    SELECT 'payment_voucher_line', l.id, v.date, v.code,
           CASE WHEN jel.id IS NULL THEN 'unmapped_cost' ELSE 'direct_expense' END,
           CASE WHEN jel.id IS NULL THEN 0::numeric
             WHEN l.amount::numeric < 0 THEN
               (jel.debit::numeric - jel.credit::numeric) * COALESCE(je.exchange_rate::numeric, 1)
             ELSE GREATEST(jel.debit::numeric * COALESCE(je.exchange_rate::numeric, 1)
               - COALESCE(alloc.amount, 0), 0) END
      FROM payment_voucher_lines l JOIN payment_vouchers v ON v.id=l.voucher_id
       AND v.company_id=${companyId}
      JOIN journal_entries je ON je.id=v.journal_entry_id AND je.company_id=${companyId} AND je.status='posted'
      JOIN accounts acct ON acct.id=l.account_id AND acct.company_id=${companyId} AND acct.account_type='expense'
      -- buildPaymentJournal creates one DR per voucher line, followed by
      -- that line's optional VAT DR. Its JE sort_order is the number of prior
      -- voucher lines plus the number of prior positive-tax lines. This maps
      -- repeated account/amount pairs to their exact JE line, not siblings.
      LEFT JOIN journal_entry_lines jel ON jel.entry_id=je.id
       AND jel.sort_order=(
         SELECT COUNT(*) + COUNT(*) FILTER (WHERE previous.tax_amount::numeric > 0)
           FROM payment_voucher_lines previous
          WHERE previous.voucher_id=l.voucher_id
            AND (previous.sort_order < l.sort_order
              OR (previous.sort_order=l.sort_order AND previous.id < l.id))
       )
       AND jel.account_id=l.account_id
       AND (jel.debit::numeric - jel.credit::numeric)=l.amount::numeric
       AND (SELECT COUNT(*) FROM journal_entry_lines same_position
             WHERE same_position.entry_id=je.id AND same_position.sort_order=jel.sort_order)=1
      LEFT JOIN allocation_net alloc ON alloc.source_type='journal_expense_line' AND alloc.source_record_id=jel.id
     WHERE l.project_id=${projectId} AND l.op_type='direct'
       AND l.purchase_invoice_id IS NULL AND l.contracting_kind IS NULL
       AND v.status='posted'
    UNION ALL
    SELECT 'prepaid_adjustment_run', run.id, je.entry_date, je.doc_number,
           CASE WHEN recognized.expense_base > 0 THEN 'prepaid_recognition' ELSE 'unmapped_cost' END,
           GREATEST(recognized.expense_base - recognized.allocated, 0)
      FROM payment_voucher_lines l
      JOIN payment_vouchers v ON v.id=l.voucher_id AND v.company_id=${companyId}
      JOIN accounting_adjustment_runs run ON run.adjustment_id=l.deferred_adjustment_id
        AND run.company_id=${companyId}
      JOIN journal_entries je ON je.id=run.journal_entry_id AND je.company_id=${companyId}
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(jel.debit::numeric * COALESCE(je.exchange_rate::numeric, 1)), 0) expense_base,
               COALESCE(SUM(COALESCE(alloc.amount, 0)), 0) allocated
          FROM journal_entry_lines jel
          JOIN accounts acct ON acct.id=jel.account_id AND acct.company_id=${companyId} AND acct.account_type='expense'
          LEFT JOIN allocation_net alloc ON alloc.source_type='journal_expense_line' AND alloc.source_record_id=jel.id
         WHERE jel.entry_id=je.id AND jel.debit::numeric > 0
      ) recognized
     WHERE l.project_id=${projectId} AND l.op_type='prepaid' AND v.status='posted'
       AND je.status='posted'
    UNION ALL
    SELECT 'goods_receipt', gr.id, gr.receipt_date, gr.doc_number, 'inventory_receipt', 0::numeric
      FROM goods_receipts gr
      LEFT JOIN journal_entries je ON je.id=gr.journal_entry_id AND je.company_id=${companyId}
     WHERE gr.company_id=${companyId} AND gr.project_id=${projectId}
       AND gr.status IN ('posted', 'invoiced')
       AND (gr.journal_entry_id IS NULL OR je.status='posted')
    UNION ALL
    SELECT 'goods_delivery', gd.id, gd.delivery_date, gd.doc_number, 'inventory_delivery', 0::numeric
      FROM goods_deliveries gd
      LEFT JOIN journal_entries je ON je.id=gd.journal_entry_id AND je.company_id=${companyId}
     WHERE gd.company_id=${companyId} AND gd.project_id=${projectId}
       AND gd.status IN ('posted', 'invoiced')
       AND (gd.journal_entry_id IS NULL OR je.status='posted')
    ORDER BY source_date, source_id
  `);
  const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
  return rows.map((row: any) => ({
    sourceType: String(row.source_type), sourceId: Number(row.source_id),
    sourceDate: String(row.source_date), documentNumber: row.document_number ?? null,
    category: String(row.category) as ProjectFinancialSource["category"],
    amount: Number(Number(row.amount).toFixed(2)),
  }));
}