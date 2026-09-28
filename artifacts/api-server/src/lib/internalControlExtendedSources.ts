// Read-only source definitions. Every join is tenant/project scoped; these
// queries deliberately exclude historical rows whose policy cannot be proven.
export const INTERNAL_CONTROL_EXTENDED_SOURCES: Record<string,{source:string;query:string;condition:string}> = {
  high_general_journal: {
    source:"journal_entries",
    query:"SELECT s.*, (SELECT COALESCE(sum(l.debit),0) FROM journal_entry_lines l WHERE l.entry_id=s.id) AS debit_total FROM journal_entries s",
    condition:"c.status='posted' AND c.entry_type='general' AND c.created_by IS NOT NULL AND c.debit_total > $threshold",
  },
  journal_backdated:{
    source:"journal_entries",query:"SELECT s.* FROM journal_entries s",
    condition:"c.status='posted' AND CASE WHEN c.entry_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN c.entry_date < to_char(c.created_at::date - ($threshold)::integer, 'YYYY-MM-DD') ELSE false END",
  },
  sales_backdated:{
    source:"sales_invoices",query:"SELECT s.* FROM sales_invoices s",
    condition:"c.status='posted' AND CASE WHEN c.invoice_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN c.invoice_date < to_char(c.created_at::date - ($threshold)::integer, 'YYYY-MM-DD') ELSE false END",
  },
  purchase_backdated:{
    source:"purchase_invoices",query:"SELECT s.* FROM purchase_invoices s",
    condition:"c.status='posted' AND CASE WHEN c.invoice_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN c.invoice_date < to_char(c.created_at::date - ($threshold)::integer, 'YYYY-MM-DD') ELSE false END",
  },
  guarantee_missing_link:{
    source:"contracting_guarantees",
    query:"SELECT s.*,p.branch_id FROM contracting_guarantees s JOIN contracting_projects p ON p.company_id=s.company_id AND p.id=s.project_id",
    condition:"c.status IN ('issued','active','extended') AND c.archived_at IS NULL AND ((c.guarantee_type='initial' AND c.tender_id IS NULL) OR (c.guarantee_type<>'initial' AND c.owner_contract_id IS NULL AND c.subcontract_id IS NULL))",
  },
  guarantee_percent_mismatch:{
    source:"contracting_guarantees",
    query:"SELECT s.*,p.branch_id FROM contracting_guarantees s JOIN contracting_projects p ON p.company_id=s.company_id AND p.id=s.project_id",
    condition:"c.status IN ('issued','active','extended') AND c.archived_at IS NULL AND c.base_amount IS NOT NULL AND c.guarantee_percent IS NOT NULL AND c.calculation_mode='auto' AND NULLIF(trim(c.override_reason),'') IS NULL AND abs(c.amount - round(c.base_amount*c.guarantee_percent/100,2)) > 0.01",
  },
  stock_large_issue:{
    source:"stock_ledger",
    query:"SELECT s.*,w.branch_id FROM stock_ledger s JOIN warehouses w ON w.company_id=s.company_id AND w.id=s.warehouse_id",
    condition:"c.tx_type IN ('sale','goods_delivery','production_issue','purchase_return') AND abs(c.qty)>$threshold",
  },
  stock_large_transfer:{
    source:"stock_transfers",
    // Only source-warehouse facts are exposed; no destination-branch evidence.
    query:"SELECT s.id,s.company_id,s.transfer_number,s.created_at,s.status,w.branch_id, (SELECT COALESCE(max(abs(l.qty*l.conversion_factor)),0) FROM stock_transfer_items l WHERE l.transfer_id=s.id) AS largest_line_qty FROM stock_transfers s JOIN warehouses w ON w.company_id=s.company_id AND w.id=s.from_warehouse_id",
    condition:"c.status='posted' AND c.largest_line_qty>$threshold",
  },
  stock_count_difference:{
    source:"stock_counts",
    query:"SELECT s.*,w.branch_id,(SELECT count(*)::integer FROM stock_count_items l WHERE l.count_id=s.id AND abs(l.actual_qty-l.system_qty)>0.0001) AS differing_lines,(SELECT COALESCE(sum(abs(l.actual_qty-l.system_qty)*l.cost_price),0) FROM stock_count_items l WHERE l.count_id=s.id) AS difference_value FROM stock_counts s JOIN warehouses w ON w.company_id=s.company_id AND w.id=s.warehouse_id",
    condition:"c.status='posted' AND c.differing_lines>0",
  },
  prepaid_missing_reference:{
    source:"accounting_adjustments",query:"SELECT s.*,NULL::integer AS branch_id FROM accounting_adjustments s",
    condition:"c.type='prepaid' AND c.status='active' AND c.source_id IS NULL AND NULLIF(trim(c.notes),'') IS NULL",
  },
  prepaid_schedule_due:{
    source:"accounting_adjustments",
    // Run existence matches the real generator (draft runs already reserve a
    // period; it must not be described as missing merely because JE is draft).
    query:"SELECT s.*,NULL::integer AS branch_id, COALESCE((SELECT jsonb_agg(r.period_month) FROM accounting_adjustment_runs r WHERE r.company_id=s.company_id AND r.adjustment_id=s.id),'[]'::jsonb) AS run_periods FROM accounting_adjustments s",
    condition:"c.type='prepaid' AND c.status='active' AND c.auto_generate IS TRUE",
  },
  prepaid_unposted_run:{
    source:"accounting_adjustment_runs",
    query:"SELECT r.*,r.generated_at AS created_at,j.branch_id,j.status AS journal_status,j.entry_date,a.type,a.status AS adjustment_status FROM accounting_adjustment_runs r JOIN accounting_adjustments a ON a.id=r.adjustment_id AND a.company_id=r.company_id JOIN journal_entries j ON j.id=r.journal_entry_id AND j.company_id=r.company_id",
    condition:"c.type='prepaid' AND c.adjustment_status='active' AND c.journal_status='draft' AND c.generated_at::date < CURRENT_DATE - ($threshold)::integer",
  },
  bill_exceeds_unchanged_contract:{
    source:"contracting_progress_bills",
    // Restrict to unchanged base contracts without ANY related amendment. Do
    // not compare a historical bill with a later edited/current contract value.
    query:`SELECT s.*,p.branch_id,COALESCE(o.value,b.value) AS verified_contract_value
      FROM contracting_progress_bills s
      JOIN contracting_projects p ON p.id=s.project_id AND p.company_id=s.company_id
      LEFT JOIN contracting_owner_contracts o ON o.id=s.owner_contract_id AND o.company_id=s.company_id AND o.project_id=s.project_id AND s.direction='outgoing'
      LEFT JOIN contracting_sub_contracts b ON b.id=s.subcontractor_contract_id AND b.company_id=s.company_id AND b.project_id=s.project_id AND b.contractor_id=s.contractor_id AND s.direction='incoming'
      WHERE COALESCE(o.updated_at,b.updated_at)<=s.created_at
        AND COALESCE(o.contract_type,b.contract_type)='main'
        AND COALESCE(o.price_includes_vat,b.price_includes_vat) IS FALSE
        AND NOT EXISTS(SELECT 1 FROM contracting_owner_contracts x WHERE x.company_id=s.company_id AND x.project_id=s.project_id AND x.contract_type IN ('addendum','change_order') AND (x.parent_contract_id=o.id OR x.parent_contract_id IS NULL))
        AND NOT EXISTS(SELECT 1 FROM contracting_sub_contracts x WHERE x.company_id=s.company_id AND x.project_id=s.project_id AND x.contractor_id=s.contractor_id AND x.contract_type IN ('addendum','change_order') AND (x.parent_contract_id=b.id OR x.parent_contract_id IS NULL))`,
    condition:"c.status IN ('approved','paid') AND c.journal_entry_id IS NOT NULL AND c.reversal_journal_entry_id IS NULL AND c.legacy_contract_link_pending IS FALSE AND c.price_includes_vat IS FALSE AND c.gross_amount > c.verified_contract_value + 0.01",
  },
  bill_quantity_exceeded:{
    source:"contracting_bill_lines",
    query:`SELECT l.*,p.branch_id,s.status AS bill_status,s.reversal_journal_entry_id,q.quantity AS verified_contract_qty
      FROM contracting_bill_lines l
      JOIN contracting_progress_bills s ON s.id=l.bill_id AND s.company_id=l.company_id AND s.project_id=l.project_id
      JOIN contracting_projects p ON p.id=l.project_id AND p.company_id=l.company_id
      JOIN contracting_contract_boq_lines q ON q.id=l.boq_line_id AND q.company_id=l.company_id AND q.project_id=l.project_id AND q.work_item_id=l.work_item_id
        AND ((q.direction='owner' AND s.direction='outgoing' AND q.owner_contract_id=s.owner_contract_id) OR (q.direction='subcontract' AND s.direction='incoming' AND q.subcontractor_contract_id=s.subcontractor_contract_id))
      WHERE q.updated_at<=l.created_at AND q.unit=l.unit_snapshot
        AND q.base_line_id IS NULL AND l.change_order_id IS NULL AND l.change_order_subcontract_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM contracting_contract_boq_lines x WHERE x.company_id=q.company_id AND x.project_id=q.project_id AND x.base_line_id=q.id)`,
    condition:"c.bill_status IN ('approved','paid') AND c.reversal_journal_entry_id IS NULL AND c.excess_approved IS FALSE AND c.cumulative_qty>c.verified_contract_qty+0.0001",
  },
};

/** Pure check shared with the real anniversary/periodicity schedule producer. */
export function overduePrepaidSlot(schedule:Array<{ym:string;isoDate:string}>,runs:string[],today:string,graceDays:number) {
  if(new Set(runs).size>=schedule.length)return null; // legacy shifted periods: same generator cap
  const cutoff=new Date(`${today}T00:00:00Z`); cutoff.setUTCDate(cutoff.getUTCDate()-graceDays);
  const iso=cutoff.toISOString().slice(0,10);
  return schedule.find(slot=>slot.isoDate<iso&&!runs.includes(slot.ym))??null;
}