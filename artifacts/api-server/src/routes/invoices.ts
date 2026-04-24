import { Router } from "express";
import { db } from "@workspace/db";
import { invoicesTable, invoiceLineItemsTable, companiesTable, customersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { createHash } from "crypto";
import { CreateInvoiceBody, UpdateInvoiceBody, ListInvoicesQueryParams } from "@workspace/api-zod";
import { generateZatcaQr } from "../lib/zatca-tlv.js";
import { generateZatcaXml, hashXml } from "../lib/zatca-xml.js";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("sales_invoices"));
router.use(moduleAudit("sales_invoices"));

const GENESIS_HASH = "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZmNTI5OWIxNmI2ZjRiMmUyNjY5MDkwMzBiMzdhZGZiMzU3NGI0OTJiNA==";

function generateInvoiceNumber(companyId: number): string {
  const now = new Date();
  const year = now.getFullYear();
  const seq = Math.floor(Math.random() * 900000) + 100000;
  return `INV-${year}-${companyId}-${seq}`;
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
  const rawCompanyId = params.success ? params.data.companyId : undefined;
  // Force company isolation: non-superadmin users only see their own company
  const companyId = resolveCompanyId(req, rawCompanyId);

  const conditions = [];
  if (companyId) conditions.push(eq(invoicesTable.companyId, companyId));
  if (params.success) {
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
  
  const d = data as typeof data & {
    paymentMethod?: string;
    buyerName?: string; buyerVatNumber?: string; buyerCrNumber?: string;
    buyerStreet?: string; buyerBuildingNumber?: string; buyerDistrict?: string;
    buyerCity?: string; buyerPostalCode?: string; buyerCountry?: string;
  };

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
    paymentMethod: d.paymentMethod ?? "10",
    subtotal: subtotal.toFixed(2),
    discountTotal: discountTotal.toFixed(2),
    vatTotal: vatTotal.toFixed(2),
    grandTotal: grandTotal.toFixed(2),
    notes: data.notes,
    buyerName: d.buyerName,
    buyerVatNumber: d.buyerVatNumber,
    buyerCrNumber: d.buyerCrNumber,
    buyerStreet: d.buyerStreet,
    buyerBuildingNumber: d.buyerBuildingNumber,
    buyerDistrict: d.buyerDistrict,
    buyerCity: d.buyerCity,
    buyerPostalCode: d.buyerPostalCode,
    buyerCountry: d.buyerCountry ?? "SA",
    zatcaStatus: "pending",
  }).returning();
  
  if (lineItemCalcs.length > 0) {
    await db.insert(invoiceLineItemsTable).values(lineItemCalcs.map(item => ({
      invoiceId: invoice.id,
      description: item.description,
      quantity: String(item.quantity),
      unitCode: (item as { unitCode?: string }).unitCode ?? "PCE",
      unitPrice: String(item.unitPrice),
      discountAmount: String(item.discountAmount ?? 0),
      taxCategory: (item as { taxCategory?: string }).taxCategory ?? "S",
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
  
  const ud = data as typeof data & {
    paymentMethod?: string;
    buyerName?: string; buyerVatNumber?: string; buyerCrNumber?: string;
    buyerStreet?: string; buyerBuildingNumber?: string; buyerDistrict?: string;
    buyerCity?: string; buyerPostalCode?: string; buyerCountry?: string;
  };

  const [invoice] = await db.update(invoicesTable).set({
    companyId: data.companyId,
    customerId: data.customerId,
    invoiceType: data.invoiceType,
    issueDate: data.issueDate,
    supplyDate: data.supplyDate,
    dueDate: data.dueDate,
    currency: data.currency ?? "SAR",
    paymentMethod: ud.paymentMethod ?? "10",
    subtotal: subtotal.toFixed(2),
    discountTotal: discountTotal.toFixed(2),
    vatTotal: vatTotal.toFixed(2),
    grandTotal: grandTotal.toFixed(2),
    notes: data.notes,
    buyerName: ud.buyerName,
    buyerVatNumber: ud.buyerVatNumber,
    buyerCrNumber: ud.buyerCrNumber,
    buyerStreet: ud.buyerStreet,
    buyerBuildingNumber: ud.buyerBuildingNumber,
    buyerDistrict: ud.buyerDistrict,
    buyerCity: ud.buyerCity,
    buyerPostalCode: ud.buyerPostalCode,
    buyerCountry: ud.buyerCountry ?? "SA",
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
      unitCode: (item as { unitCode?: string }).unitCode ?? "PCE",
      unitPrice: String(item.unitPrice),
      discountAmount: String(item.discountAmount ?? 0),
      taxCategory: (item as { taxCategory?: string }).taxCategory ?? "S",
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

  if (existing.status !== "draft") {
    res.status(400).json({ error: "يمكن إصدار المسودات فقط" });
    return;
  }

  const [company] = existing.companyId
    ? await db.select().from(companiesTable).where(eq(companiesTable.id, existing.companyId))
    : [null];

  const [customer] = existing.customerId
    ? await db.select().from(customersTable).where(eq(customersTable.id, existing.customerId))
    : [null];

  const lineItems = await db.select().from(invoiceLineItemsTable)
    .where(eq(invoiceLineItemsTable.invoiceId, id));

  // Increment invoice counter
  const nextCounter = (company?.invoiceCounter ?? 0) + 1;
  if (company) {
    await db.update(companiesTable).set({
      invoiceCounter: nextCounter,
      updatedAt: new Date(),
    }).where(eq(companiesTable.id, company.id));
  }

  // Get previous invoice hash for chaining
  const previousInvoices = await db.select()
    .from(invoicesTable)
    .where(eq(invoicesTable.companyId, existing.companyId!))
    .orderBy(desc(invoicesTable.createdAt))
    .limit(2);
  
  const prevInvoice = previousInvoices.find(inv => inv.id !== id && inv.invoiceHash);
  const previousInvoiceHash = prevInvoice?.invoiceHash ?? GENESIS_HASH;

  // Generate TLV QR code
  const issueTimestamp = new Date().toISOString().replace("Z", "+03:00");
  const qrCode = generateZatcaQr({
    sellerName: company?.nameAr ?? "",
    vatNumber: company?.vatNumber ?? "",
    invoiceTimestamp: issueTimestamp,
    invoiceTotal: existing.grandTotal,
    vatAmount: existing.vatTotal,
  });

  // Generate UBL 2.1 XML
  const xmlContent = generateZatcaXml({
    invoiceNumber: existing.invoiceNumber,
    invoiceType: existing.invoiceType,
    issueDate: existing.issueDate,
    issueTime: new Date().toTimeString().split(" ")[0],
    supplyDate: existing.supplyDate,
    currency: existing.currency,
    paymentMethod: existing.paymentMethod ?? "10",
    subtotal: existing.subtotal,
    discountTotal: existing.discountTotal,
    vatTotal: existing.vatTotal,
    grandTotal: existing.grandTotal,
    notes: existing.notes,
    invoiceCounterValue: nextCounter,
    previousInvoiceHash,
    qrCode,
    lineItems: lineItems.map(li => ({
      id: li.id,
      description: li.description,
      quantity: li.quantity,
      unitCode: li.unitCode ?? "PCE",
      unitPrice: li.unitPrice,
      discountAmount: li.discountAmount,
      taxCategory: li.taxCategory ?? "S",
      vatRate: li.vatRate,
      vatAmount: li.vatAmount,
      subtotal: li.subtotal,
      total: li.total,
    })),
    company: company ?? {
      nameAr: "غير محدد",
      vatNumber: "",
      crNumber: "",
      street: "",
      buildingNumber: "",
      city: "",
      postalCode: "",
      country: "SA",
    },
    customer: existing.buyerName ? {
      nameAr: existing.buyerName,
      vatNumber: existing.buyerVatNumber,
      crNumber: existing.buyerCrNumber,
      street: existing.buyerStreet,
      buildingNumber: existing.buyerBuildingNumber,
      district: existing.buyerDistrict,
      city: existing.buyerCity,
      postalCode: existing.buyerPostalCode,
      country: existing.buyerCountry ?? "SA",
    } : customer ?? null,
  });

  const invoiceHash = hashXml(xmlContent);

  await db.update(invoicesTable).set({
    status: "issued",
    qrCode,
    invoiceHash,
    xmlContent,
    invoiceCounterValue: nextCounter,
    previousInvoiceHash,
    zatcaStatus: "pending",
    updatedAt: new Date(),
  }).where(eq(invoicesTable.id, id));

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
