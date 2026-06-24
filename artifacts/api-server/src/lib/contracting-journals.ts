// ─────────────────────────────────────────────────────────────────────────
// Contracting Journal Engine (IFRS 15 — Revenue from Contracts with
// Customers, Percentage-of-Completion method).
//
// Two lifecycle JEs, both fired by PUT /bills/:id when the bill status
// flips to "approved":
//
//   1) Outgoing progress bill (مستخلص للمالك) — direction = "outgoing"
//        DR Receivable          = netAmount     (cash due now incl. VAT)
//        DR Retention Receivable= retentionAmount
//        CR Revenue             = grossAmount - previousPaid (period revenue)
//        CR VAT Output          = vatAmount
//
//      Why grossAmount-previousPaid: bills in this module store the
//      cumulative progress value in `grossAmount`; `previousPaid` is the
//      cumulative previously billed amount. The DELTA is the new revenue
//      to recognise this period under IFRS 15 (point-in-time recognition
//      via stage-of-completion measured by the bill).
//
//      Balance proof:
//        DR = netAmount + retentionAmount
//           = (grossAmount - retentionAmount - previousPaid + vatAmount) + retentionAmount
//           = grossAmount - previousPaid + vatAmount
//        CR = (grossAmount - previousPaid) + vatAmount
//        ✓
//
//   2) Incoming progress bill (مستخلص باطن) — direction = "incoming"
//        DR WIP / Construction Cost = grossAmount - previousPaid
//        DR VAT Input               = vatAmount
//        CR Payable (Subcontractor) = netAmount
//        CR Retention Payable       = retentionAmount
//      Same balance proof, mirrored.
//
// Account routing uses the generic accountingMappings table:
//   documentType = "contracting_outgoing_bill" | "contracting_incoming_bill"
//   roleKey      = receivable|retention_receivable|revenue|vat_output
//                | wip|vat_input|payable|retention_payable
//
// Posting status comes from resolvePostingStatus(cid, "ctgOutgoingBill"
// | "ctgIncomingBill"). Flipping the matching toggle off in
// /general-settings causes the JE to be saved as draft (zero impact on
// financial reports until manually posted from مركز الترحيل).
// ─────────────────────────────────────────────────────────────────────────
import { and, eq } from "drizzle-orm";
import {
  db,
  contractingProgressBillsTable,
  journalEntriesTable,
  journalEntryLinesTable,
} from "@workspace/db";
import { resolvePostingStatus } from "./postingStatus.js";
import { loadMappings } from "./accountingMappings.js";
import { assertWritableForDate } from "./periodGuard.js";
import { nextSequenceNumber } from "./sequences.js";

type DbOrTx = typeof db;

const fix = (n: number) => n.toFixed(2);
const r2 = (n: number) => Math.round(n * 100) / 100;

interface BillAmounts {
  gross: number;
  retention: number;
  prevPaid: number;
  due: number;
  vat: number;
  net: number;
  /** New revenue / cost recognised this period (delta vs previous bills). */
  period: number;
}

function readAmounts(b: typeof contractingProgressBillsTable.$inferSelect): BillAmounts {
  const gross     = Number(b.grossAmount     || 0);
  const retention = Number(b.retentionAmount || 0);
  const prevPaid  = Number(b.previousPaid    || 0);
  const due       = Number(b.dueAmount       || 0);
  const vat       = Number(b.vatAmount       || 0);
  const net       = Number(b.netAmount       || 0);
  const period    = r2(gross - prevPaid);
  return { gross, retention, prevPaid, due, vat, net, period };
}

// ═════════════════════════════════════════════════════════════════════════
// 1) OUTGOING PROGRESS BILL  (revenue side — مستخلص للمالك)
// ═════════════════════════════════════════════════════════════════════════
export async function buildOutgoingBillJournal(
  cid: number,
  billId: number,
  dx: DbOrTx = db,
): Promise<number | null> {
  const [b] = await dx.select().from(contractingProgressBillsTable)
    .where(and(
      eq(contractingProgressBillsTable.id, billId),
      eq(contractingProgressBillsTable.companyId, cid),
    ));
  if (!b) throw new Error("المستخلص غير موجود");
  if (b.direction !== "outgoing") {
    throw new Error("هذه الدالة مخصصة لمستخلصات العملاء فقط");
  }
  if (b.journalEntryId) return b.journalEntryId; // already posted (idempotent)

  const a = readAmounts(b);
  // Nothing to post (zero-value bill).
  if (a.gross <= 0 && a.vat <= 0) return null;

  const map = await loadMappings(cid, "contracting_outgoing_bill");
  const arAcc        = map("contracting_outgoing_bill", "receivable");
  const retAcc       = map("contracting_outgoing_bill", "retention_receivable");
  const revAcc       = map("contracting_outgoing_bill", "revenue");
  const vatOutAcc    = map("contracting_outgoing_bill", "vat_output");

  if (!arAcc)     throw new Error("حساب العملاء (receivable) للمستخلصات غير مربوط في الربط المحاسبي");
  if (!revAcc)    throw new Error("حساب إيرادات المقاولات (revenue) غير مربوط في الربط المحاسبي");
  if (a.retention > 0 && !retAcc) {
    throw new Error("حساب المحتجزات لدى العملاء (retention_receivable) غير مربوط في الربط المحاسبي");
  }
  if (a.vat > 0 && !vatOutAcc) {
    throw new Error("حساب ضريبة المخرجات (vat_output) للمستخلصات غير مربوط في الربط المحاسبي");
  }

  const outW = await assertWritableForDate(cid, b.billDate);
  if (!outW.ok) throw new Error(outW.reason);
  const desc = `مستخلص مالك معتمد رقم ${b.billNumber} — مشروع #${b.projectId}`;
  // JE draws its own continuous "journal_entry" number; bill number stays in
  // the description + source link. Falls back to the bill number.
  const jeDocNumber = (await nextSequenceNumber(cid, "journal_entry", {
    userId: null, refTable: "journal_entries", branchId: null, docDate: b.billDate,
  })) ?? b.billNumber;
  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    docNumber: jeDocNumber,
    entryDate: b.billDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "contracting_outgoing_bill",
    status: await resolvePostingStatus(cid, "ctgOutgoingBill"),
  }).returning();

  const lines: any[] = [];
  let i = 0;
  // DR side
  if (a.net > 0) {
    lines.push({ entryId: entry.id, accountId: arAcc, debit: fix(a.net), credit: "0.00",
      description: `ذمم — ${b.billNumber}`, sortOrder: i++ });
  }
  if (a.retention > 0 && retAcc) {
    lines.push({ entryId: entry.id, accountId: retAcc, debit: fix(a.retention), credit: "0.00",
      description: `محتجزات لدى العميل — ${b.billNumber}`, sortOrder: i++ });
  }
  // CR side
  if (a.period > 0) {
    lines.push({ entryId: entry.id, accountId: revAcc, debit: "0.00", credit: fix(a.period),
      description: `إيراد فترة المستخلص — ${b.billNumber}`, sortOrder: i++ });
  }
  if (a.vat > 0 && vatOutAcc) {
    lines.push({ entryId: entry.id, accountId: vatOutAcc, debit: "0.00", credit: fix(a.vat),
      description: `ضريبة مخرجات — ${b.billNumber}`, sortOrder: i++ });
  }

  const dr = lines.reduce((s, l) => s + Number(l.debit  || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  if (Math.abs(dr - cr) > 0.05) {
    throw new Error(`قيد المستخلص غير متوازن: مدين ${fix(dr)} ≠ دائن ${fix(cr)}`);
  }

  await dx.insert(journalEntryLinesTable).values(lines);
  await dx.update(contractingProgressBillsTable)
    .set({ journalEntryId: entry.id, updatedAt: new Date() })
    .where(and(
      eq(contractingProgressBillsTable.id, billId),
      eq(contractingProgressBillsTable.companyId, cid),
    ));

  return entry.id;
}

// ═════════════════════════════════════════════════════════════════════════
// 2) INCOMING PROGRESS BILL  (cost side — مستخلص باطن)
// ═════════════════════════════════════════════════════════════════════════
export async function buildIncomingBillJournal(
  cid: number,
  billId: number,
  dx: DbOrTx = db,
): Promise<number | null> {
  const [b] = await dx.select().from(contractingProgressBillsTable)
    .where(and(
      eq(contractingProgressBillsTable.id, billId),
      eq(contractingProgressBillsTable.companyId, cid),
    ));
  if (!b) throw new Error("المستخلص غير موجود");
  if (b.direction !== "incoming") {
    throw new Error("هذه الدالة مخصصة لمستخلصات الباطن فقط");
  }
  if (b.journalEntryId) return b.journalEntryId;

  const a = readAmounts(b);
  if (a.gross <= 0 && a.vat <= 0) return null;

  const map = await loadMappings(cid, "contracting_incoming_bill");
  const wipAcc    = map("contracting_incoming_bill", "wip");
  const vatInAcc  = map("contracting_incoming_bill", "vat_input");
  const apAcc     = map("contracting_incoming_bill", "payable");
  const retAcc    = map("contracting_incoming_bill", "retention_payable");

  if (!apAcc)  throw new Error("حساب الموردين (payable) لمستخلصات الباطن غير مربوط في الربط المحاسبي");
  if (!wipAcc) throw new Error("حساب أعمال تحت التنفيذ (wip) غير مربوط في الربط المحاسبي");
  if (a.retention > 0 && !retAcc) {
    throw new Error("حساب محتجزات الموردين (retention_payable) غير مربوط في الربط المحاسبي");
  }
  if (a.vat > 0 && !vatInAcc) {
    throw new Error("حساب ضريبة المدخلات (vat_input) لمستخلصات الباطن غير مربوط في الربط المحاسبي");
  }

  const inW = await assertWritableForDate(cid, b.billDate);
  if (!inW.ok) throw new Error(inW.reason);
  const desc = `مستخلص باطن معتمد رقم ${b.billNumber} — مشروع #${b.projectId}`;
  // JE draws its own continuous "journal_entry" number; bill number stays in
  // the description + source link. Falls back to the bill number.
  const jeDocNumber = (await nextSequenceNumber(cid, "journal_entry", {
    userId: null, refTable: "journal_entries", branchId: null, docDate: b.billDate,
  })) ?? b.billNumber;
  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    docNumber: jeDocNumber,
    entryDate: b.billDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "contracting_incoming_bill",
    status: await resolvePostingStatus(cid, "ctgIncomingBill"),
  }).returning();

  const lines: any[] = [];
  let i = 0;
  // DR side
  if (a.period > 0) {
    lines.push({ entryId: entry.id, accountId: wipAcc, debit: fix(a.period), credit: "0.00",
      description: `أعمال تحت التنفيذ — ${b.billNumber}`, sortOrder: i++ });
  }
  if (a.vat > 0 && vatInAcc) {
    lines.push({ entryId: entry.id, accountId: vatInAcc, debit: fix(a.vat), credit: "0.00",
      description: `ضريبة مدخلات — ${b.billNumber}`, sortOrder: i++ });
  }
  // CR side
  if (a.net > 0) {
    lines.push({ entryId: entry.id, accountId: apAcc, debit: "0.00", credit: fix(a.net),
      description: `مستحق مقاول باطن — ${b.billNumber}`, sortOrder: i++ });
  }
  if (a.retention > 0 && retAcc) {
    lines.push({ entryId: entry.id, accountId: retAcc, debit: "0.00", credit: fix(a.retention),
      description: `محتجزات لدى الباطن — ${b.billNumber}`, sortOrder: i++ });
  }

  const dr = lines.reduce((s, l) => s + Number(l.debit  || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  if (Math.abs(dr - cr) > 0.05) {
    throw new Error(`قيد مستخلص الباطن غير متوازن: مدين ${fix(dr)} ≠ دائن ${fix(cr)}`);
  }

  await dx.insert(journalEntryLinesTable).values(lines);
  await dx.update(contractingProgressBillsTable)
    .set({ journalEntryId: entry.id, updatedAt: new Date() })
    .where(and(
      eq(contractingProgressBillsTable.id, billId),
      eq(contractingProgressBillsTable.companyId, cid),
    ));

  return entry.id;
}
