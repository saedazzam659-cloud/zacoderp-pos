import { Router } from "express";
import { db } from "@workspace/db";
import { invoicesTable, invoiceLineItemsTable, companiesTable, customersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { createHash } from "crypto";
import { CreateInvoiceBody, UpdateInvoiceBody, ListInvoicesQueryParams, GetInvoiceParams, IssueInvoiceParams, CancelInvoiceParams } from "@workspace/api-zod";

const router = Router();

function generateInvoiceNumber(companyId: number): string {
  const now = new Date();
  const year = now.getFullYear();
  const seq = Math.floor(Math.random() * 900000) + 100000;
  return `INV-${year}-${companyId}-${seq}`;
}

function generateQrCode(invoice: typeof invoicesTable.$inferSelect, company: typeof companiesTable.$inferSelect | null): string {
  const data = [
    company?.nameAr ?? "",
    company?.vatNumber ?? "",
    invoice.issueDate,
    invoice.grandTotal,
    invoice.vatTotal,
  ].join("|");
  return Buffer.from(data).toString("base64");
}

function generateHash(invoice: typeof invoicesTable.$inferSelect): string {
  const data = `${invoice.id}|${invoice.invoiceNumber}|${invoice.grandTotal}|${invoice.issueDate}`;
  return createHash("sha256").update(data).digest("hex");
}

async function getInvoiceWithRelations(id: number) {
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!invoice) return null;
  
  const lineItems = await db.select().from(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, id));
  const [company] = invoice.companyId
    ? await db.select().from(companiesTable).where(eq(companiesTable.id, invoice.companyId))
    : [null];
  const [customer] = invoice.customerId
    ? await db.select().from(customersTable).where(eq(customersTable.id, invoice.customerId))
    : [null];

  return { ...invoice, lineItems, company, customer };
}

router.get("/", async (req, res) => {
  const params = ListInvoicesQueryParams.safeParse(req.query);
  const conditions = [];
  if (params.success) {
    if (params.data.companyId) conditions.push(eq(invoicesTable.companyId, params.data.companyId));
    if (params.data.status) conditions.push(eq(invoicesTable.status, params.data.status));
    if (params.data.invoiceType) conditions.push(eq(invoicesTable.invoiceType, params.data.invoiceType));
  }
  
  const query = conditions.length > 0
    ? db.select().from(invoicesTable).where(and(...conditions)).orderBy(desc(invoicesTable.createdAt))
    : db.select().from(invoicesTable).orderBy(desc(invoicesTable.createdAt));

  const invoices = await query;
  
  const enriched = await Promise.all(invoices.map(async (inv) => {
    const lineItems = await db.select().from(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, inv.id));
    const [company] = inv.companyId ? await db.select().from(companiesTable).where(eq(companiesTable.id, inv.companyId)) : [null];
    const [customer] = inv.customerId ? await db.select().from(customersTable).where(eq(customersTable.id, inv.customerId)) : [null];
    return { ...inv, lineItems, company, customer };
  }));
  
  res.json(enriched);
});

router.post("/", async (req, res) => {
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  
  let subtotal = 0;
  let discountTotal = 0;
  let vatTotal = 0;
  const lineItemCalcs = (data.lineItems ?? []).map(item => {
    const itemSubtotal = Number(item.quantity) * Number(item.unitPrice);
    const discount = Number(item.discountAmount ?? 0);
    const taxable = itemSubtotal - discount;
    const vatAmount = taxable * (Number(item.vatRate ?? 15) / 100);
    const total = taxable + vatAmount;
    subtotal += itemSubtotal;
    discountTotal += discount;
    vatTotal += vatAmount;
    return { ...item, subtotal: itemSubtotal.toFixed(2), vatAmount: vatAmount.toFixed(2), total: total.toFixed(2) };
  });
  const grandTotal = subtotal - discountTotal + vatTotal;
  
  const invoiceNumber = generateInvoiceNumber(data.companyId);
  
  const [invoice] = await db.insert(invoicesTable).values({
    companyId: data.companyId,
    customerId: data.customerId,
    invoiceNumber,
    invoiceType: data.invoiceType,
    status: "draft",
    issueDate: data.issueDate,
    supplyDate: data.supplyDate,
    dueDate: data.dueDate,
    currency: data.currency ?? "SAR",
    subtotal: subtotal.toFixed(2),
    discountTotal: discountTotal.toFixed(2),
    vatTotal: vatTotal.toFixed(2),
    grandTotal: grandTotal.toFixed(2),
    notes: data.notes,
    zatcaStatus: "pending",
  }).returning();
  
  if (lineItemCalcs.length > 0) {
    await db.insert(invoiceLineItemsTable).values(lineItemCalcs.map(item => ({
      invoiceId: invoice.id,
      description: item.description,
      quantity: String(item.quantity),
      unitPrice: String(item.unitPrice),
      discountAmount: String(item.discountAmount ?? 0),
      vatRate: String(item.vatRate ?? 15),
      vatAmount: item.vatAmount,
      subtotal: item.subtotal,
      total: item.total,
    })));
  }
  
  const result = await getInvoiceWithRelations(invoice.id);
  res.status(201).json(result);
});

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const result = await getInvoiceWithRelations(id);
  if (!result) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  res.json(result);
});

router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const parsed = UpdateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  
  let subtotal = 0;
  let discountTotal = 0;
  let vatTotal = 0;
  const lineItemCalcs = (data.lineItems ?? []).map(item => {
    const itemSubtotal = Number(item.quantity) * Number(item.unitPrice);
    const discount = Number(item.discountAmount ?? 0);
    const taxable = itemSubtotal - discount;
    const vatAmount = taxable * (Number(item.vatRate ?? 15) / 100);
    const total = taxable + vatAmount;
    subtotal += itemSubtotal;
    discountTotal += discount;
    vatTotal += vatAmount;
    return { ...item, subtotal: itemSubtotal.toFixed(2), vatAmount: vatAmount.toFixed(2), total: total.toFixed(2) };
  });
  const grandTotal = subtotal - discountTotal + vatTotal;
  
  const [invoice] = await db.update(invoicesTable).set({
    companyId: data.companyId,
    customerId: data.customerId,
    invoiceType: data.invoiceType,
    issueDate: data.issueDate,
    supplyDate: data.supplyDate,
    dueDate: data.dueDate,
    currency: data.currency ?? "SAR",
    subtotal: subtotal.toFixed(2),
    discountTotal: discountTotal.toFixed(2),
    vatTotal: vatTotal.toFixed(2),
    grandTotal: grandTotal.toFixed(2),
    notes: data.notes,
    updatedAt: new Date(),
  }).where(eq(invoicesTable.id, id)).returning();
  
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  
  if (lineItemCalcs.length > 0) {
    await db.delete(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, id));
    await db.insert(invoiceLineItemsTable).values(lineItemCalcs.map(item => ({
      invoiceId: id,
      description: item.description,
      quantity: String(item.quantity),
      unitPrice: String(item.unitPrice),
      discountAmount: String(item.discountAmount ?? 0),
      vatRate: String(item.vatRate ?? 15),
      vatAmount: item.vatAmount,
      subtotal: item.subtotal,
      total: item.total,
    })));
  }
  
  const result = await getInvoiceWithRelations(id);
  res.json(result);
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  await db.delete(invoicesTable).where(eq(invoicesTable.id, id));
  res.status(204).send();
});

router.post("/:id/issue", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  
  const [company] = existing.companyId
    ? await db.select().from(companiesTable).where(eq(companiesTable.id, existing.companyId))
    : [null];
  
  const qrCode = generateQrCode(existing, company ?? null);
  const invoiceHash = generateHash(existing);
  
  const [invoice] = await db.update(invoicesTable).set({
    status: "issued",
    qrCode,
    invoiceHash,
    zatcaStatus: "reported",
    updatedAt: new Date(),
  }).where(eq(invoicesTable.id, id)).returning();
  
  const result = await getInvoiceWithRelations(id);
  res.json(result);
});

router.post("/:id/cancel", async (req, res) => {
  const id = parseInt(req.params.id);
  const [invoice] = await db.update(invoicesTable).set({
    status: "cancelled",
    updatedAt: new Date(),
  }).where(eq(invoicesTable.id, id)).returning();
  
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  
  const result = await getInvoiceWithRelations(id);
  res.json(result);
});

export default router;
