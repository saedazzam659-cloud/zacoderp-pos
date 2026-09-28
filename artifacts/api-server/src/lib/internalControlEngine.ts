import { db, companiesTable, internalControlCasesTable as cases, internalControlRulesTable as rules, internalControlHistoryTable as history, usersTable, auditLogTable, getActiveExternalDb, runWithExternalDb, type ExternalDbContext } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { INTERNAL_CONTROL_RULES, type ControlRule } from "./internalControlRules.js";
import { internalControlEventKey } from "./internalControlPolicy.js";
import { logger } from "./logger.js";
import { INTERNAL_CONTROL_EXTENDED_SOURCES, overduePrepaidSlot } from "./internalControlExtendedSources.js";
import { installmentsBetween, normalizePeriodicity } from "./adjustmentPosting.js";

export async function internalControlEnabled(companyId: number): Promise<boolean> {
  const [c] = await db.select({ menu: companiesTable.menuPermissions }).from(companiesTable).where(eq(companiesTable.id, companyId));
  try { return (typeof c?.menu === "string" ? JSON.parse(c.menu) : c?.menu)?.internal_control === true; } catch { return false; }
}
export async function getInternalControlRules(companyId: number): Promise<ControlRule[]> {
  const saved = await db.select().from(rules).where(eq(rules.companyId, companyId));
  return INTERNAL_CONTROL_RULES.map(def => {
    const config = saved.find(r => r.key === def.key)?.config ?? {};
    // Only editable properties are loaded; stored JSON cannot override support/category/key.
    return {...def, ...Object.fromEntries(["enabled","severity","threshold","excludedUserIds","excludedRoles"].filter(k => k in config).map(k => [k,config[k]]))};
  });
}
const safeEvidenceKeys = new Set([
  "id","status","amount","qty","subtotal","discount_amount","doc_number","code","supplier_invoice_number",
  "supplier_id","customer_id","project_id","item_id","warehouse_id","expiry_date","extension_date",
  "allow_negative","negative_limit","total_amount","allocated","kind","direction","applied_amount",
  "created_by","created_by_id","created_by_user_id","posted_by","posted_by_id","journal_entry_id",
  "owner_contract_id","subcontractor_contract_id","reversal_journal_entry_id","entry_date","description",
  "branch_id","invoice_date","created_at","adjustment_number",
  "bill_number","retention_enabled","retention_amount","advance_recovery_enabled",
  "advance_recovery_amount","advance_recovery_remaining_before","advance_recovery_remaining_after",
  "advance_recovery_contract_advance_amount",
  "totalAmount","discountAmount","subtotal","unitPrice","costPrice","sellingPrice","quantity",
  "debit_total","transfer_number","count_number","largest_line_qty","differing_lines","difference_value",
  "base_amount","guarantee_percent","calculation_mode","override_reason","verified_contract_value",
  "verified_contract_qty","cumulative_qty","current_qty","bill_id","boq_line_id","unit_snapshot",
  "gross_amount","start_date","end_date","periodicity","period_month","adjustment_id","generated_at",
  "overdue_period","overdue_date","journal_status",
  "accountId","taxId","vatNumber","nameAr","nameEn","price","taxRate","branchId",
]);
function evidenceOf(row: any): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row ?? {}).filter(([k,v]) => safeEvidenceKeys.has(k) && (v == null || ["string","number","boolean"].includes(typeof v))));
}
async function persist(companyId: number, rule: ControlRule, row: any, source: string, extra: any = {}) {
  const userId = row.created_by ?? row.created_by_id ?? row.created_by_user_id ?? row.user_id ?? null;
  if (rule.excludedUserIds.includes(userId)) return 0;
  if (rule.excludedRoles.length && userId) {
    const [u] = await db.select({role:usersTable.role}).from(usersTable).where(and(eq(usersTable.companyId,companyId),eq(usersTable.id,userId)));
    if (u && rule.excludedRoles.includes(u.role)) return 0;
  }
  return db.transaction(async tx => {
  const result = await tx.insert(cases).values({
    companyId, branchId: row.branch_id ?? null, ruleKey:rule.key,
    eventKey:internalControlEventKey(source,row.id), category:rule.category, source,
    documentType:source, documentId:String(row.entity_id ?? row.id),
    documentNumber:row.doc_number ?? row.code ?? row.guarantee_number ?? row.adjustment_number ?? row.bill_number ?? null,
    projectId:row.project_id ?? null, customerId:row.customer_id ?? null, supplierId:row.supplier_id ?? null,
    userId, approverId:row.posted_by ?? row.posted_by_id ?? null,
    occurredAt:row.created_at ? new Date(row.created_at) : new Date(),
    description:rule.name, reason:rule.threshold == null ? rule.name : `${rule.name} (${rule.threshold} ${rule.thresholdUnit})`,
    severity:rule.severity, evidence:{values:evidenceOf(row),threshold:rule.threshold,...extra},
    // No invented URL for unsupported document routing; original pages retain their own ACL.
    documentUrl:source === "journal_entries" ? `/accounting/journals/${row.id}` :
      source === "receipt_vouchers" ? `/cash/receipt-vouchers/${row.id}` :
      source === "payment_vouchers" ? `/cash/payment-vouchers/${row.id}` : null,
  }).onConflictDoNothing({target:[cases.companyId,cases.ruleKey,cases.eventKey]}).returning({id:cases.id});
  if(result.length) await tx.insert(history).values({companyId,caseId:result[0].id,action:"created",toStatus:"open",note:rule.name});
  return result.length;
  });
}

// All source SQL is a static, reviewed allowlist. User input is bound separately.
export const SOURCES: Record<string, {source:string; query:string; condition:string}> = {
  ...INTERNAL_CONTROL_EXTENDED_SOURCES,
  high_payment:{source:"payment_vouchers",query:"SELECT s.* FROM payment_vouchers s",condition:"c.status = 'posted' AND c.amount > $threshold"},
  high_receipt:{source:"receipt_vouchers",query:"SELECT s.* FROM receipt_vouchers s",condition:"c.status = 'posted' AND c.amount > $threshold"},
  journal_no_reference:{source:"journal_entries",query:"SELECT s.* FROM journal_entries s",condition:"c.status = 'posted' AND NULLIF(trim(c.doc_number),'') IS NULL AND NULLIF(trim(c.description),'') IS NULL"},
  same_creator_approver:{source:"journal_entries",query:"SELECT s.* FROM journal_entries s",condition:"c.status = 'posted' AND c.created_by IS NOT NULL AND c.created_by = c.posted_by"},
  sales_discount:{source:"sales_invoices",query:"SELECT s.* FROM sales_invoices s",condition:"c.status = 'posted' AND c.subtotal > 0 AND c.discount_amount / c.subtotal * 100 > $threshold"},
  purchase_missing_supplier:{source:"purchase_invoices",query:"SELECT s.* FROM purchase_invoices s",condition:"c.status = 'posted' AND c.supplier_id IS NULL"},
  duplicate_supplier_invoice:{source:"purchase_invoices",query:"SELECT s.* FROM purchase_invoices s",condition:"c.status = 'posted' AND NULLIF(trim(c.supplier_invoice_number),'') IS NOT NULL AND c.supplier_id IS NOT NULL AND EXISTS (SELECT 1 FROM purchase_invoices d WHERE d.company_id = c.company_id AND d.branch_id IS NOT DISTINCT FROM c.branch_id AND d.supplier_id = c.supplier_id AND d.supplier_invoice_number = c.supplier_invoice_number AND d.status = 'posted' AND d.id < c.id)"},
  negative_stock:{source:"stock_balance",query:"SELECT s.*, w.branch_id,w.allow_negative,w.negative_limit FROM stock_balance s JOIN warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id",condition:"c.qty < 0 AND (NOT c.allow_negative OR (c.negative_limit IS NOT NULL AND c.qty < -abs(c.negative_limit)))"},
  manual_stock_adjustment:{source:"stock_adjustments",query:"SELECT s.*, w.branch_id FROM stock_adjustments s JOIN warehouses w ON w.id=s.warehouse_id AND w.company_id=s.company_id",condition:"c.status = 'posted'"},
  guarantee_expired:{source:"contracting_guarantees",query:"SELECT s.*, p.branch_id FROM contracting_guarantees s JOIN contracting_projects p ON p.id=s.project_id AND p.company_id=s.company_id",condition:"c.status IN ('issued','active','extended') AND c.archived_at IS NULL AND COALESCE(c.extension_date,c.expiry_date) < CURRENT_DATE"},
  guarantee_expiring:{source:"contracting_guarantees",query:"SELECT s.*, p.branch_id FROM contracting_guarantees s JOIN contracting_projects p ON p.id=s.project_id AND p.company_id=s.company_id",condition:"c.status IN ('issued','active','extended') AND c.archived_at IS NULL AND COALESCE(c.extension_date,c.expiry_date) >= CURRENT_DATE AND COALESCE(c.extension_date,c.expiry_date) <= CURRENT_DATE + ($threshold)::integer"},
  advance_missing_contract:{source:"contracting_accounting_settlements",query:"SELECT s.*, p.branch_id FROM contracting_accounting_settlements s JOIN contracting_projects p ON p.id=s.project_id AND p.company_id=s.company_id",condition:"c.kind IN ('advance_receipt','advance_payment') AND c.status = 'posted' AND c.journal_entry_id IS NOT NULL AND c.reversal_journal_entry_id IS NULL AND c.owner_contract_id IS NULL AND c.subcontractor_contract_id IS NULL"},
  bill_retention_disabled:{source:"contracting_progress_bills",query:"SELECT s.*,p.branch_id FROM contracting_progress_bills s JOIN contracting_projects p ON p.id=s.project_id AND p.company_id=s.company_id",condition:"c.status IN ('approved','paid') AND c.reversal_journal_entry_id IS NULL AND c.retention_enabled IS FALSE AND c.retention_amount > 0.01"},
  bill_recovery_snapshot:{source:"contracting_progress_bills",query:"SELECT s.*,p.branch_id FROM contracting_progress_bills s JOIN contracting_projects p ON p.id=s.project_id AND p.company_id=s.company_id",condition:"c.status IN ('approved','paid') AND c.reversal_journal_entry_id IS NULL AND c.advance_recovery_enabled IS TRUE AND c.advance_recovery_contract_advance_amount IS NOT NULL AND abs(c.advance_recovery_remaining_before - c.advance_recovery_amount - c.advance_recovery_remaining_after) > 0.01"},
  prepaid_overallocated:{source:"accounting_adjustments",query:"SELECT s.*, NULL::integer AS branch_id, COALESCE((SELECT sum(r.amount) FROM accounting_adjustment_runs r JOIN journal_entries j ON j.id=r.journal_entry_id AND j.company_id=r.company_id AND j.status='posted' WHERE r.company_id=s.company_id AND r.adjustment_id=s.id),0) AS allocated FROM accounting_adjustments s",condition:"c.type = 'prepaid' AND c.status NOT IN ('cancelled','carried_forward') AND c.allocated > c.total_amount + 0.01"},
};

// Audit rows have no authoritative branch column. Never infer a branch from
// request-body metadata. Their evidence is visible only to all-branch users.
export async function evaluateInternalControlAudit(auditId: number) {
  const [a] = await db.select().from(auditLogTable).where(eq(auditLogTable.id,auditId));
  if (!a?.companyId || a.module.startsWith("internal_control") || !await internalControlEnabled(a.companyId)) return 0;
  registerInternalControlDatasource();
  const definitions = await getInternalControlRules(a.companyId);
  const meta = a.metadata as any;
  const before = meta?.before; const after = meta?.after;
  const hasSnapshots = before && after && typeof before === "object" && typeof after === "object";
  const changed = hasSnapshots ? Object.keys(evidenceOf(before)).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])) : [];
  const keys: string[] = [];
  if (a.action === "denied") keys.push("permission_denied");
  if ((a.statusCode ?? 200) < 400) {
    if (["delete","cancel"].includes(a.action)) keys.push("document_cancelled");
    if (a.action === "edit" && hasSnapshots && ["posted","approved"].includes(before.status) && changed.length) keys.push("post_approval_edit");
    if (a.action === "edit" && ["customers","suppliers","items","accounts","taxes","bank_accounts","contracting_projects"].includes(a.module)) keys.push("master_data_change");
  }
  let created = 0;
  for (const rule of definitions.filter(r => r.enabled && keys.includes(r.key))) {
    if (rule.excludedRoles.includes(a.role ?? "") || rule.excludedUserIds.includes(a.userId!)) continue;
    created += await persist(a.companyId,rule,{id:a.id,entity_id:a.entityId,user_id:a.userId,created_at:a.createdAt},"audit_log", {
      auditId:a.id, module:a.module, action:a.action, entityType:a.entityType, entityId:a.entityId,
      snapshotsAvailable:!!hasSnapshots,
      ...(hasSnapshots ? {before:evidenceOf(before),after:evidenceOf(after),changedFields:changed} : {}),
    });
  }
  // Where the existing audit provides an unambiguous document id, evaluate the
  // real current source as well. Never infer an id from an untrusted request
  // body or attribute today's values as a historical "before" snapshot.
  const sourceByModule:Record<string,string> = {
    payment_vouchers:"payment_vouchers",receipt_vouchers:"receipt_vouchers",
    journal_entries:"journal_entries",sales_invoices:"sales_invoices",
    purchase_invoices:"purchase_invoices",stock_adjustments:"stock_adjustments",
  };
  const sourceName=sourceByModule[a.module];
  if(sourceName && a.entityId && /^\d+$/.test(a.entityId) && (a.statusCode??200)<400 && !["delete","denied"].includes(a.action)) {
    for(const rule of definitions.filter(r=>r.enabled&&r.supported&&SOURCES[r.key]?.source===sourceName&&(!r.thresholdUnit||r.threshold!=null))) {
      const source=SOURCES[rule.key],parts=source.condition.split("$threshold");
      const condition=parts.length===1?sql.raw(parts[0]):sql`${sql.raw(parts[0])}${rule.threshold}${sql.raw(parts[1])}`;
      try {
        const found=await db.transaction(async tx=>{
          await tx.execute(sql`SET LOCAL statement_timeout = '3000ms'`);
          return (await tx.execute(sql`SELECT to_jsonb(c) AS row FROM (${sql.raw(source.query)}) c WHERE c.company_id=${a.companyId} AND c.id=${Number(a.entityId)} AND ${condition} LIMIT 1`)).rows;
        });
        for(const item of found) created+=await persist(a.companyId,rule,item.row,sourceName);
      }catch(err){logger.warn({err,rule:rule.key},"internal-control immediate source evaluation failed");}
    }
  }
  return created;
}

const cursors = new WeakMap<object, Map<string,number>>();
const centralKey = {};
function cursorStore() {
  const key = getActiveExternalDb()?.pool ?? centralKey;
  let map = cursors.get(key); if (!map) { map = new Map(); cursors.set(key,map); } return map;
}
export async function scanInternalControl(companyId:number, branchIds?:number[]) {
  if (!await internalControlEnabled(companyId)) throw new Error("وحدة الرقابة الداخلية غير مفعلة");
  const result = {created:0,evaluated:0,errors:[] as string[],bounded:true};
  const definitions = await getInternalControlRules(companyId);
  const cursors = cursorStore();
  for (const rule of definitions.filter(r => r.supported && r.enabled && SOURCES[r.key] && (!r.thresholdUnit || r.threshold != null))) {
    const source = SOURCES[rule.key];
    const cursorKey = `${companyId}:${rule.key}:${branchIds?.join(",") ?? "all"}`;
    const cursor = cursors.get(cursorKey) ?? 0;
    try {
      const parts = source.condition.split("$threshold");
      const condition = parts.length === 1 ? sql.raw(parts[0]) : sql`${sql.raw(parts[0])}${rule.threshold}${sql.raw(parts[1])}`;
      const scope = branchIds === undefined ? sql`true` : branchIds.length ? sql`c.branch_id IN (${sql.join(branchIds.map(b => sql`${b}`),sql`,`)})` : sql`false`;
      const rows = await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '3000ms'`);
        return (await tx.execute(sql`SELECT to_jsonb(c) AS row FROM (${sql.raw(source.query)}) c WHERE c.company_id=${companyId} AND c.id>${cursor} AND ${scope} AND ${condition} ORDER BY c.id LIMIT 100`)).rows;
      });
      for (const entry of rows) {
        result.evaluated++;
        const row=entry.row as any;
        if(rule.key==="prepaid_schedule_due") {
          // Reuse the exact production anniversary schedule, including grouped
          // periodicity and the legacy run-count cap. Observe only; never call
          // the posting service or rewrite schedule/run data.
          const start=new Date(row.start_date),end=new Date(row.end_date);
          if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<start||end.getUTCFullYear()-start.getUTCFullYear()>100) continue;
          const due=overduePrepaidSlot(installmentsBetween(row.start_date,row.end_date,normalizePeriodicity(row.periodicity)),row.run_periods??[],new Date().toISOString().slice(0,10),Number(rule.threshold));
          if(!due)continue;
          row.overdue_period=due.ym;row.overdue_date=due.isoDate;
        }
        result.created += await persist(companyId,rule,row,source.source);
      }
      cursors.set(cursorKey,rows.length === 100 ? Number((rows[rows.length-1].row as any).id) : 0);
    } catch (err) { result.errors.push(`${rule.key}: تعذر فحص المصدر`); logger.warn({err,companyId,rule:rule.key},"internal-control scan rule failed"); }
  }
  if (branchIds === undefined) {
    const cursorKey = `${companyId}:audit`; const cursor = cursors.get(cursorKey) ?? 0;
    const rows = await db.select({id:auditLogTable.id}).from(auditLogTable).where(and(eq(auditLogTable.companyId,companyId),sql`${auditLogTable.id}>${cursor}`)).orderBy(auditLogTable.id).limit(100);
    for (const a of rows) { result.evaluated++; result.created += await evaluateInternalControlAudit(a.id); }
    cursors.set(cursorKey,rows.length===100 ? rows[rows.length-1].id : 0);
  }
  return result;
}

// Capture the datasource explicitly. No external request can cause a scheduled
// callback to fall back to central DB. At most one timer per active datasource.
const registered = new WeakSet<object>();
export function registerInternalControlDatasource() {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  const context = getActiveExternalDb();
  const key = context?.pool ?? centralKey;
  if (registered.has(key)) return;
  registered.add(key);
  let busy = false; let companyCursor = 0;
  const run = async () => {
    if (busy) return; busy = true;
    try {
      const companies = await db.select({id:companiesTable.id}).from(companiesTable)
        .where(and(eq(companiesTable.status,"active"),sql`${companiesTable.id}>${companyCursor}`)).orderBy(companiesTable.id).limit(10);
      for (const c of companies) if (await internalControlEnabled(c.id)) await scanInternalControl(c.id);
      companyCursor = companies.length === 10 ? companies[companies.length-1].id : 0;
    } catch (err) { logger.warn({err},"internal-control scheduled scan failed"); } finally { busy=false; }
  };
  const tick = () => { void (context ? runWithExternalDb(context as ExternalDbContext,run) : run()); };
  const timer = setInterval(tick,5*60_000); timer.unref();
}