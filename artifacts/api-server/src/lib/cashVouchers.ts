import { db } from "@workspace/db";
import { paymentVouchersTable, receiptVouchersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

type Args = {
  companyId: number;
  branchId?: number | null;
  date: string;
  cashBoxId?: number | null;
  bankAccountId?: number | null;
  paymentType?: "cash" | "bank";
  entityType: "customer" | "supplier" | "employee" | "other";
  entityId?: number | null;
  amount: number | string;
  currencyId?: number | null;
  exchangeRate?: number | string;
  refType: string;
  refNumber?: string | null;
  description?: string;
};

export async function createPostedReceiptVoucher(a: Args) {
  const existing = await db.select().from(receiptVouchersTable)
    .where(eq(receiptVouchersTable.companyId, a.companyId));
  const code = `RV-${String(existing.length + 1).padStart(4, "0")}`;
  const [row] = await db.insert(receiptVouchersTable).values({
    companyId:     a.companyId,
    branchId:      a.branchId ?? null,
    code,
    date:          a.date,
    paymentType:   a.paymentType ?? "cash",
    cashBoxId:     a.cashBoxId ?? null,
    bankAccountId: a.bankAccountId ?? null,
    entityType:    a.entityType,
    entityId:      a.entityId ?? null,
    amount:        String(a.amount),
    exchangeRate:  String(a.exchangeRate ?? "1"),
    refType:       a.refType,
    refNumber:     a.refNumber ?? null,
    description:   a.description ?? null,
    status:        "posted",
  }).returning();
  return row;
}

export async function createPostedPaymentVoucher(a: Args) {
  const existing = await db.select().from(paymentVouchersTable)
    .where(eq(paymentVouchersTable.companyId, a.companyId));
  const code = `PV-${String(existing.length + 1).padStart(4, "0")}`;
  const [row] = await db.insert(paymentVouchersTable).values({
    companyId:     a.companyId,
    branchId:      a.branchId ?? null,
    code,
    date:          a.date,
    paymentType:   a.paymentType ?? "cash",
    cashBoxId:     a.cashBoxId ?? null,
    bankAccountId: a.bankAccountId ?? null,
    entityType:    a.entityType,
    entityId:      a.entityId ?? null,
    amount:        String(a.amount),
    exchangeRate:  String(a.exchangeRate ?? "1"),
    refType:       a.refType,
    refNumber:     a.refNumber ?? null,
    description:   a.description ?? null,
    status:        "posted",
  }).returning();
  return row;
}
