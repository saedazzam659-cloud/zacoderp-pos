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