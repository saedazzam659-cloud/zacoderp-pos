import { randomUUID } from "node:crypto";
import { db, companiesTable, customersTable, journalEntriesTable, journalEntryLinesTable, accountingMappingsTable, accountsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { ensureContractingAccountingTables } from "./contracting-accounting-storage.js";
import { assertProjectBranchAccess } from "./contracting-accounting-service.js";
import { buildSignedZatcaInvoice } from "./zatca-build-signed.js";
import { assertZatcaSubmissionAllowed, resolveZatcaChain, withZatcaChainLock } from "./zatcaRegistrationTransfer.js";
import { resolveZatcaEnv, getZatcaBaseUrl, csidEnvMismatchMessage } from "./zatca-env.js";
import type { InvoiceData, PrepaymentAdjustment } from "./zatca-xml.js";
import { assertWritableForDate } from "./periodGuard.js";
import { fullAuditFor } from "./journalAudit.js";
import { nextJeSubSequence } from "./sequences.js";
import { contractingQuotedNet } from "./contracting-accounting-math.js";

const rows = (r: any): any[] => Array.isArray(r) ? r : r?.rows ?? [];
const fail = (message: string, status = 422): never => { throw Object.assign(new Error(message), { status }); };
const positiveId=(v:number) => {
  if (!Number.isSafeInteger(v) || v<1) fail("معرّف الشركة أو المشروع أو العقد أو الفاتورة غير صالح");
  return v;
};
const cents = (v: any): bigint => {
  const s = String(v ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return fail("مبلغ الضريبة غير صالح");
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
};
const amt = (n: bigint) => `${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
const date = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s)
    fail("تاريخ الفاتورة غير صالح");
  return s;
};
async function contractScope(tx: any, companyId: number, projectId: number, contractId: number, req: any, lock: boolean) {
  const r = await tx.execute(sql`SELECT c.id,c.advance_payment,c.vat_percent,c.status,
    COALESCE(c.customer_id,p.customer_id) AS customer_id,p.branch_id
    FROM contracting_owner_contracts c JOIN contracting_projects p
      ON p.id=c.project_id AND p.company_id=c.company_id
    JOIN customers x ON x.id=COALESCE(c.customer_id,p.customer_id) AND x.company_id=c.company_id
    WHERE c.company_id=${companyId} AND c.project_id=${projectId} AND c.id=${contractId}
    ${lock ? sql`FOR UPDATE OF c` : sql``}`);
  const c = rows(r)[0];
  if (!c) fail("عقد المالك أو عميله غير موجود في هذه الشركة والمشروع", 404);
  assertProjectBranchAccess(req, c.branch_id);
  return c;
}
const publicRow = (r: any) => ({
  id: Number(r.id), kind: r.kind, projectId: Number(r.project_id),
  ownerContractId: Number(r.owner_contract_id), billId: r.bill_id == null ? null : Number(r.bill_id),
  invoiceNumber: r.invoice_number, invoiceIssueDate: String(r.invoice_date).slice(0, 10),
  invoiceIssueTime: r.invoice_time, taxableAmount: r.taxable_amount, vatAmount: r.vat_amount,
  priceIncludesVat: r.price_includes_vat === true, vatPercent: r.vat_percent,
  grossAmount: r.gross_amount, prepaymentAdjustments: r.prepayment_adjustments,
  zatcaStatus: r.status, zatcaUuid: r.zatca_uuid,
  xmlDownloadUrl:["cleared","reported"].includes(r.status)&&r.xml_content
    ? `/api/contracting/fiscal-invoices/${r.id}/xml` : null,
});

/** No accounting movement: the later direct settlement or multi-receipt owns the only cash JE. */
export async function createTaxableAdvance(input: {
  companyId: number; projectId: number; contractId: number; intentKey: string;
  taxableAmount: string; priceIncludesVat?: boolean; invoiceDate: string; userId: number | null; req: any;
}) {
  positiveId(input.companyId); positiveId(input.projectId); positiveId(input.contractId);
  await ensureContractingAccountingTables();
  if (!/^[\w:.-]{8,128}$/.test(input.intentKey)) fail("مفتاح نية سلفة ثابت (8–128 حرفاً) مطلوب");
  if (input.priceIncludesVat !== undefined && typeof input.priceIncludesVat !== "boolean")
    fail("خيار السعر شامل الضريبة غير صالح");
  const quoted = cents(input.taxableAmount);
  if (quoted <= 0n) fail("قيمة السلفة الخاضعة للضريبة يجب أن تكون موجبة");
  date(input.invoiceDate);
  return db.transaction(async (tx) => {
    const c = await contractScope(tx, input.companyId, input.projectId, input.contractId, input.req, true);
    const inclusive = input.priceIncludesVat === true;
    const existing = rows(await tx.execute(sql`SELECT * FROM contracting_fiscal_invoices
      WHERE company_id=${input.companyId} AND intent_key=${input.intentKey}`))[0];
    if (existing) {
      if (existing.kind !== "advance" || Number(existing.project_id) !== input.projectId ||
          Number(existing.owner_contract_id) !== input.contractId ||
          existing.price_includes_vat !== inclusive ||
          cents(inclusive ? existing.gross_amount : existing.taxable_amount) !== quoted ||
          String(existing.invoice_date).slice(0, 10) !== input.invoiceDate)
        fail("مفتاح النية مستخدم لفاتورة سلفة مختلفة", 409);
      return { ...publicRow(existing), idempotentReplay: true };
    }
    if (c.status !== "approved") fail("اعتمد عقد المالك قبل إصدار فاتورة السلفة");
    const base = cents(contractingQuotedNet(input.taxableAmount, c.vat_percent, inclusive));
    if (base <= 0n) fail("مبلغ السلفة شامل الضريبة صغير جداً ولا يغطي أساساً ضريبياً");
    const rate = cents(c.vat_percent);
    if (rate !== 500n && rate !== 1500n)
      fail("فاتورة السلفة الضريبية تدعم نسب ضريبة العقد 5% و15% فقط؛ لا تغيّر العقد أو تصدر مستنداً غير قابل للاعتماد");
    const vat = inclusive ? quoted - base : (base * rate + 5000n) / 10000n;
    const used = rows(await tx.execute(sql`SELECT
      (SELECT COALESCE(SUM(amount),0) FROM contracting_accounting_settlements
       WHERE company_id=${input.companyId} AND owner_contract_id=${input.contractId}
         AND kind='advance_receipt' AND status='posted') AS captured,
      (SELECT COALESCE(SUM(GREATEST(0,f.taxable_amount-COALESCE((
           SELECT SUM(s.amount) FROM contracting_accounting_settlements s
           WHERE s.company_id=f.company_id AND s.taxable_advance_invoice_id=f.id
             AND s.kind='advance_receipt' AND s.status='posted'),0))),0)
       FROM contracting_fiscal_invoices f
       WHERE f.company_id=${input.companyId} AND f.owner_contract_id=${input.contractId}
         AND f.kind='advance' AND f.status <> 'rejected') AS uncollected`))[0];
    if (base + cents(used.captured) + cents(used.uncollected) > cents(c.advance_payment))
      fail("فاتورة السلفة تتجاوز سقف سلفة العقد بعد الدفعات والفواتير المفتوحة");
    const now = new Date();
    const invoiceTime = now.toISOString().slice(11, 19);
    const key = `CTG-ADV-${randomUUID()}`;
    const created = rows(await tx.execute(sql`INSERT INTO contracting_fiscal_invoices
      (company_id,project_id,owner_contract_id,intent_key,kind,invoice_number,
       invoice_date,invoice_time,customer_id,taxable_amount,price_includes_vat,vat_percent,vat_amount,gross_amount,created_by)
      VALUES (${input.companyId},${input.projectId},${input.contractId},${input.intentKey},
        'advance',${key},${input.invoiceDate},${invoiceTime},${c.customer_id},
        ${amt(base)},${inclusive},${c.vat_percent},${amt(vat)},${amt(base + vat)},${input.userId}) RETURNING *`))[0];
    return { ...publicRow(created), idempotentReplay: false };
  });
}

export async function listFiscalInvoices(input: {companyId: number; projectId: number; contractId: number; req: any}) {
  positiveId(input.companyId); positiveId(input.projectId); positiveId(input.contractId);
  await ensureContractingAccountingTables();
  await contractScope(db, input.companyId, input.projectId, input.contractId, input.req, false);
  const fiscal = rows(await db.execute(sql`SELECT f.*,
    COALESCE((SELECT SUM(s.amount) FROM contracting_accounting_settlements s
      WHERE s.company_id=f.company_id AND s.taxable_advance_invoice_id=f.id
      AND s.kind='advance_receipt' AND s.status='posted'),0) AS captured_base,
    COALESCE((SELECT SUM(s.amount + COALESCE(s.taxable_vat_amount,0))
      FROM contracting_accounting_settlements s
      WHERE s.company_id=f.company_id AND s.taxable_advance_invoice_id=f.id
        AND s.kind='advance_receipt' AND s.status='posted'),0) AS captured_gross,
    COALESCE((SELECT SUM(s.amount) FROM contracting_accounting_settlements s
      WHERE s.company_id=f.company_id AND s.taxable_advance_invoice_id=f.id
      AND s.kind='advance_application' AND s.status='posted'),0) AS recovered_base
    FROM contracting_fiscal_invoices f WHERE f.company_id=${input.companyId}
      AND f.project_id=${input.projectId} AND f.owner_contract_id=${input.contractId}
    ORDER BY f.id DESC`));
  return fiscal.map((f) => ({ ...publicRow(f), capturedBase: f.captured_base,
    capturedGross:f.captured_gross,
    outstandingGross:f.kind==="advance" ? amt(cents(f.gross_amount)-cents(f.captured_gross)) : null,
    recoveredBase: f.recovered_base }));
}

async function advanceInvoiceAccounts(companyId: number) {
  const mappings = await db.select({documentType:accountingMappingsTable.documentType,
    roleKey:accountingMappingsTable.roleKey,accountId:accountingMappingsTable.accountId})
    .from(accountingMappingsTable).innerJoin(accountsTable,and(
      eq(accountsTable.id,accountingMappingsTable.accountId),eq(accountsTable.companyId,companyId)))
    .where(eq(accountingMappingsTable.companyId,companyId));
  const get = (doc:string,role:string) => mappings.find(m=>m.documentType===doc && m.roleKey===role)?.accountId;
  const ar=get("contracting_taxable_advance_invoice","advance_receivable");
  const liability=get("contracting_advance_receipt","advance_liability");
  const vat=get("contracting_outgoing_bill","vat_output");
  if (!ar || !liability || !vat || new Set([ar,liability,vat]).size!==3)
    fail("الربط المحاسبي للسلفة الضريبية غير مكتمل أو يكرر نفس الحساب: اربط contracting_taxable_advance_invoice / advance_receivable، وcontracting_advance_receipt / advance_liability، وcontracting_outgoing_bill / vat_output كلٌ بحساب مختلف");
  const reused=await db.select({id:customersTable.id}).from(customersTable)
    .where(and(eq(customersTable.companyId,companyId),eq(customersTable.accountId,ar))).limit(1);
  if (reused.length) fail("حساب ذمم فاتورة السلفة الضريبية يجب أن يكون حساباً مستقلاً عن حسابات العملاء الفردية لمنع تكرار أرصدتهم");
  return {ar,liability,vat};
}
async function finalizeAcceptedAdvance(f:any, companyId:number, req?:any) {
  const accounts=await advanceInvoiceAccounts(companyId);
  const invoiceDate=String(f.invoice_date).slice(0,10);
  const writable=await assertWritableForDate(companyId,invoiceDate);
  if (!writable.ok) fail(`تعذر ترحيل قيد فاتورة السلفة في فترة مغلقة: ${writable.reason}`,423);
  return db.transaction(async tx=>{
    const source=rows(await tx.execute(sql`SELECT * FROM contracting_fiscal_invoices
      WHERE company_id=${companyId} AND id=${f.id} FOR UPDATE`))[0];
    if (!source) fail("فاتورة السلفة غير موجودة",404);
    if (source.journal_entry_id) {
      if (source.status==="accepted_unposted") fail("فاتورة السلفة بها قيد غير متسق؛ يلزم مراجعة محاسبية",409);
      return publicRow(source);
    }
    if (source.status!=="accepted_unposted") fail("لم يتم قبول فاتورة السلفة من ZATCA بعد",409);
    const jeNumber=await nextJeSubSequence(companyId,"contracting_taxable_advance_invoice",{
      userId:req?.authUser?.id??null,refTable:"journal_entries",docDate:invoiceDate});
    if (!jeNumber) fail("تعذر حجز رقم قيد فاتورة السلفة",409);
    const branch=rows(await tx.execute(sql`SELECT branch_id FROM contracting_projects
      WHERE company_id=${companyId} AND id=${source.project_id}`))[0];
    const [je]=await tx.insert(journalEntriesTable).values({
      companyId,branchId:branch?.branch_id??null,docNumber:jeNumber,entryDate:invoiceDate,
      currency:"SAR",exchangeRate:"1",description:`فاتورة دفعة مقدمة ${source.invoice_number}`,
      entryType:"contracting_taxable_advance_invoice",status:"posted",
      periodId:writable.period?.id??null,
      ...(req?fullAuditFor(req,"posted"):{}),
    }).returning({id:journalEntriesTable.id});
    await tx.insert(journalEntryLinesTable).values([
      {entryId:je.id,accountId:accounts.ar,debit:String(source.gross_amount),credit:"0.00",sortOrder:0,description:"ذمة فاتورة الدفعة المقدمة"},
      {entryId:je.id,accountId:accounts.liability,debit:"0.00",credit:String(source.taxable_amount),sortOrder:1,description:"التزام دفعة مقدمة"},
      {entryId:je.id,accountId:accounts.vat,debit:"0.00",credit:String(source.vat_amount),sortOrder:2,description:"ضريبة مخرجات الدفعة المقدمة"},
    ]);
    const accepted=source.zatca_response?.acceptedType;
    const updated=rows(await tx.execute(sql`UPDATE contracting_fiscal_invoices SET
      journal_entry_id=${je.id},status=${accepted==="standard"?"cleared":"reported"}
      WHERE id=${f.id} AND company_id=${companyId} RETURNING *`))[0];
    return publicRow(updated);
  });
}

/** Bill -> contract -> source locking matches accounting approval. No request-provided
 * prepayment, references or tax values are used to build the fiscal document. */
export async function issueOwnerBillInvoice(input: {companyId: number; projectId: number; billId: number; req: any; userId: number | null}) {
  positiveId(input.companyId); positiveId(input.projectId); positiveId(input.billId);
  await ensureContractingAccountingTables();
  return db.transaction(async (tx) => {
    const bill = rows(await tx.execute(sql`SELECT b.*,j.status AS journal_status
      FROM contracting_progress_bills b LEFT JOIN journal_entries j
        ON j.id=b.journal_entry_id AND j.company_id=b.company_id
      WHERE b.company_id=${input.companyId} AND b.project_id=${input.projectId}
        AND b.id=${input.billId} FOR UPDATE OF b`))[0];
    if (!bill || bill.direction !== "outgoing" || !bill.owner_contract_id) fail("مستخلص مالك غير موجود", 404);
    const c = await contractScope(tx, input.companyId, input.projectId, Number(bill.owner_contract_id), input.req, true);
    const existing = rows(await tx.execute(sql`SELECT * FROM contracting_fiscal_invoices
      WHERE company_id=${input.companyId} AND bill_id=${input.billId}`))[0];
    if (existing) return { ...publicRow(existing), idempotentReplay: true };
    if (!["approved","posted","partially_paid","paid"].includes(bill.status) || bill.journal_status !== "posted" || bill.reversal_journal_entry_id)
      fail("يجب اعتماد وترحيل المستخلص قبل إصدار الفاتورة الضريبية");
    const billRate = cents(bill.vat_percent);
    if (billRate !== 500n && billRate !== 1500n)
      fail("فاتورة المستخلص الضريبية تدعم نسب الضريبة 5% و15% فقط");
    const applications = rows(await tx.execute(sql`SELECT s.amount,s.taxable_vat_amount,s.taxable_advance_invoice_id,
      f.invoice_number,f.invoice_date,f.invoice_time,f.status,f.taxable_amount,f.vat_amount,f.vat_percent
      FROM contracting_accounting_settlements s
      JOIN contracting_accounting_settlements source ON source.id=s.source_settlement_id
        AND source.company_id=s.company_id AND source.status='posted'
        AND source.taxable_advance_invoice_id=s.taxable_advance_invoice_id
      JOIN contracting_fiscal_invoices f ON f.id=s.taxable_advance_invoice_id
        AND f.company_id=s.company_id AND f.owner_contract_id=s.owner_contract_id
        AND f.project_id=s.project_id AND f.kind='advance'
      WHERE s.company_id=${input.companyId} AND s.bill_id=${input.billId}
        AND s.kind='advance_application' AND s.status='posted'
        AND s.taxable_advance_invoice_id IS NOT NULL
      ORDER BY s.id FOR UPDATE OF s`));
    const taxableAppsCount = rows(await tx.execute(sql`SELECT COUNT(*)::int AS n FROM contracting_accounting_settlements
      WHERE company_id=${input.companyId} AND bill_id=${input.billId} AND kind='advance_application'
        AND status='posted' AND taxable_advance_invoice_id IS NOT NULL`))[0]?.n;
    if (applications.length !== Number(taxableAppsCount)) fail("مرجع الاسترداد الضريبي غير صالح؛ لا يمكن إصدار الفاتورة", 409);
    // An ordinary VAT-correct posted owner bill is also eligible for type 388.
    // Only actual posted 386-linked recovery creates prepayment references;
    // legacy untaxed advances remain ordinary accounting payments.
    const grouped=new Map<number,PrepaymentAdjustment>();
    for (const a of applications) {
      if (!["cleared","reported"].includes(a.status) || String(a.invoice_date).slice(0,10) > String(bill.bill_date).slice(0,10))
        fail("يجب قبول فاتورة السلفة الأصلية بتاريخ سابق أو مساوٍ للمستخلص", 409);
      if (cents(a.amount) <= 0n || cents(a.taxable_vat_amount) > cents(a.vat_amount)
        || cents(a.amount) > cents(a.taxable_amount))
        fail("مبالغ استرداد السلفة الضريبية غير صالحة أو تتجاوز فاتورة السلفة الأصلية",409);
      const prior=grouped.get(Number(a.taxable_advance_invoice_id));
      grouped.set(Number(a.taxable_advance_invoice_id),{
        invoiceNumber:a.invoice_number,invoiceIssueDate:String(a.invoice_date).slice(0,10),
        invoiceIssueTime:a.invoice_time,
        taxableAmount:amt(cents(a.amount)+(prior?cents(prior.taxableAmount):0n)),
        taxAmount:amt(cents(a.taxable_vat_amount)+(prior?cents(prior.taxAmount):0n)),
        taxCategory:"S",taxPercent:a.vat_percent,
      });
    }
    const adjustments=[...grouped.values()];
    for (const [sourceId, a] of grouped) {
      const source = applications.find(row => Number(row.taxable_advance_invoice_id) === sourceId);
      if (!source || cents(a.taxableAmount) > cents(source.taxable_amount)
        || cents(a.taxAmount) > cents(source.vat_amount)
        || cents(a.taxAmount) !== (cents(a.taxableAmount) * cents(a.taxPercent) + 5000n) / 10000n)
        fail("مبالغ استرداد السلفة لا تطابق نسبة الفاتورة الأصلية بالتقريب الدقيق؛ اختر مبلغ استرداد قابل للتمثيل",409);
    }
    const base = cents(bill.gross_amount) - cents(bill.previous_paid);
    const vat = cents(bill.vat_amount);
    if (base <= 0n || vat !== (base * billRate + 5000n) / 10000n)
      fail("ضريبة المستخلص المخزنة لا تطابق نسبة الضريبة المسجلة من وعائه قبل المحتجز؛ لا يمكن إعادة تسعير مستخلص معتمد تلقائياً. يلزم مسار تصحيح منفصل",409);
    if (adjustments.reduce((s,a)=>s+cents(a.taxableAmount)+cents(a.taxAmount),0n) > base + vat)
      fail("تطبيق السلفة الضريبية يتجاوز إجمالي المستخلص",409);
    const now = new Date();
    const number = `CTG-BILL-${randomUUID()}`;
    const issued = rows(await tx.execute(sql`INSERT INTO contracting_fiscal_invoices
      (company_id,project_id,owner_contract_id,bill_id,kind,invoice_number,invoice_date,
       invoice_time,customer_id,taxable_amount,price_includes_vat,vat_percent,vat_amount,gross_amount,prepayment_adjustments,created_by)
      VALUES (${input.companyId},${input.projectId},${bill.owner_contract_id},${input.billId},
        'bill',${number},${String(bill.bill_date).slice(0,10)},${now.toISOString().slice(11,19)},
        ${c.customer_id},${amt(base)},${bill.price_includes_vat === true},${bill.vat_percent},${amt(vat)},${amt(base+vat)},${JSON.stringify(adjustments)}::jsonb,
        ${input.userId}) RETURNING *`))[0];
    return { ...publicRow(issued), idempotentReplay:false };
  });
}

/** Only this source bridge signs/sends fiscal records. It never posts an accounting
 * journal or sales invoice. Persist signed payload before sending for safe retries. */
export async function submitContractingFiscalInvoice(companyId: number, id: number, req?: any) {
  positiveId(companyId);positiveId(id);
  await ensureContractingAccountingTables();
  return withZatcaChainLock(companyId, async () => {
    await assertZatcaSubmissionAllowed(companyId);
    const f = rows(await db.execute(sql`SELECT * FROM contracting_fiscal_invoices
      WHERE id=${id} AND company_id=${companyId}`))[0];
    if (!f) fail("الفاتورة الضريبية غير موجودة", 404);
    if (["cleared","reported"].includes(f.status)) return { ...publicRow(f), idempotentReplay:true };
    if (f.status==="rejected") fail("رفضت ZATCA هذه الفاتورة؛ راجع سبب الرفض وأنشئ نية إصدار جديدة بدلاً من إعادة استخدام مرجع مرفوض",409);
    if (f.status==="accepted_unposted") return { ...await finalizeAcceptedAdvance(f,companyId,req),idempotentReplay:true };
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id,companyId));
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id,Number(f.customer_id)));
    if (!company || !customer || customer.companyId !== companyId) fail("بيانات الشركة أو العميل المرتبط غير مكتملة");
    const token = company.zatcaPcsidToken ?? company.zatcaCsidToken;
    const secret = company.zatcaPcsidSecret ?? company.zatcaCsidSecret;
    if (!token || !secret || !company.zatcaPrivateKey) fail("شهادة ومفتاح ZATCA غير مهيأين للشركة؛ أكمل إعداد الربط أولاً");
    if (f.kind==="advance") await advanceInvoiceAccounts(companyId);
    const writable=await assertWritableForDate(companyId,String(f.invoice_date).slice(0,10));
    if (!writable.ok) fail(`فترة الفاتورة الضريبية مغلقة: ${writable.reason}`,423);
    const env = resolveZatcaEnv(company);
    const mismatch = csidEnvMismatchMessage(token,env);
    if (mismatch) fail(mismatch);
    const chain = await resolveZatcaChain(companyId);
    if (f.zatca_icv != null && Number(f.zatca_icv) !== chain.maxIcv+1)
      fail("تقدمت سلسلة ZATCA بعد توقيع الفاتورة المعلقة؛ تحقق من حالتها قبل أي إعادة إرسال",409);
    const customerVat = String(customer.vatNumber ?? "").replace(/\D/g,"");
    const invoiceType = customerVat.length === 15 ? "standard" : "simplified";
    const v = (x: any) => String(x ?? "");
    const data: Omit<InvoiceData,"qrCode"> = {
      invoiceNumber:f.invoice_number, uuid:f.zatca_uuid ?? randomUUID(),
      invoiceType, prepaymentInvoice:f.kind==="advance",
      prepaymentAdjustments:f.kind==="bill" ? f.prepayment_adjustments : undefined,
      issueDate:String(f.invoice_date).slice(0,10), issueTime:f.invoice_time,
      supplyDate:String(f.invoice_date).slice(0,10),currency:"SAR",paymentMethod:"30",
      subtotal:v(f.taxable_amount),discountTotal:"0.00",vatTotal:v(f.vat_amount),
      grandTotal:v(f.gross_amount),notes:f.kind==="bill" ? "مستخلص مالك (المحتجز منفصل عن الوعاء الضريبي)" : "دفعة مقدمة لعقد المالك",
      invoiceCounterValue:chain.maxIcv+1,previousInvoiceHash:chain.previousInvoiceHash,
      lineItems:[{id:1,description:f.kind==="advance"?"دفعة مقدمة لعقد المالك":"قيمة الأعمال المعتمدة قبل المحتجز",
        quantity:"1",unitCode:"PCE",unitPrice:v(f.taxable_amount),discountAmount:"0.00",
        taxCategory:"S",vatRate:v(f.vat_percent),vatAmount:v(f.vat_amount),
        subtotal:v(f.taxable_amount),total:v(f.gross_amount)}],
      company:{nameAr:v(company.nameAr),nameEn:company.nameEn,vatNumber:v(company.vatNumber),
        crNumber:v(company.crNumber),street:v(company.street),buildingNumber:v(company.buildingNumber),
        city:v(company.city),district:company.district,postalCode:v(company.postalCode),
        country:company.country ?? "SA"},
      customer:{nameAr:v(customer.nameAr),vatNumber:customer.vatNumber,crNumber:customer.crNumber,
        street:customer.street,buildingNumber:customer.buildingNumber,city:customer.city,
        district:customer.district,postalCode:customer.postalCode,country:customer.country ?? "SA"},
    };
    const built = f.xml_content && f.invoice_hash
      ? { finalXml:f.xml_content, invoiceHash:f.invoice_hash }
      : buildSignedZatcaInvoice({invoiceData:data,certificatePem:token,privateKeyPem:company.zatcaPrivateKey,
          seller:{nameAr:v(company.nameAr),vatNumber:v(company.vatNumber)},
          qr:{invoiceTimestamp:`${data.issueDate}T${data.issueTime}Z`,invoiceTotal:data.grandTotal,vatAmount:data.vatTotal}});
    if (!f.xml_content) await db.execute(sql`UPDATE contracting_fiscal_invoices SET
      xml_content=${built.finalXml},invoice_hash=${built.invoiceHash},
      zatca_uuid=${data.uuid},zatca_icv=${chain.maxIcv+1},zatca_pih=${chain.previousInvoiceHash}
      WHERE company_id=${companyId} AND id=${id} AND status='issued'`);
    const endpoint = invoiceType === "standard" ? "clearance" : "reporting";
    const response = await fetch(`${getZatcaBaseUrl(env)}/invoices/${endpoint}/single`,{
      method:"POST",headers:{"Accept-Version":"V2","Accept-Language":"en",
        Authorization:"Basic "+Buffer.from(`${token}:${secret}`).toString("base64"),
        "Clearance-Status":invoiceType==="standard"?"1":"0","Content-Type":"application/json"},
      body:JSON.stringify({invoiceHash:built.invoiceHash,uuid:data.uuid,invoice:Buffer.from(built.finalXml).toString("base64")}),
    });
    const raw = await response.text();
    let verdict:any = {};
    try { verdict=JSON.parse(raw); } catch { verdict={message:raw.slice(0,1000)}; }
    const accepted=response.ok && (invoiceType==="standard"
      ? verdict.clearanceStatus==="CLEARED"
      : ["REPORTED","REPORTED_WITH_WARNINGS"].includes(verdict.reportingStatus));
    await db.execute(sql`UPDATE contracting_fiscal_invoices SET status=${accepted?(f.kind==="advance"?"accepted_unposted":invoiceType==="standard"?"cleared":"reported"):"rejected"},
      zatca_response=${JSON.stringify({httpStatus:response.status,verdict,acceptedType:invoiceType})}::jsonb
      WHERE company_id=${companyId} AND id=${id}`);
    if (!accepted) fail(`رفضت ZATCA الفاتورة (${response.status}): ${JSON.stringify(verdict).slice(0,1000)}`,409);
    if (f.kind==="advance") return { ...await finalizeAcceptedAdvance(f,companyId,req),idempotentReplay:false };
    return { ...publicRow({...f,status:invoiceType==="standard"?"cleared":"reported",zatca_uuid:data.uuid}), idempotentReplay:false };
  });
}