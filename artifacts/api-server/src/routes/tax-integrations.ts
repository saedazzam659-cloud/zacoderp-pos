import { Router } from "express";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db, companiesTable, customersTable, salesInvoiceLinesTable, salesInvoicesTable,
  taxIntegrationSetupsTable, taxIntegrationAuditTable, taxIntegrationSubmissionsTable,
  contractingBillLinesTable, contractingContractBoqLinesTable, contractingOwnerContractsTable,
  contractingOwnerBillTaxMappingsTable, contractingProgressBillsTable, contractingProjectsTable,
  contractingTaxSubmissionsTable, journalEntriesTable,
} from "@workspace/db";
import { extractAuth } from "../middleware/auth.js";
import {
  authenticateEta, getEtaSubmissionStatus, submitEtaDocuments, testEtaConnection,
  type TaxEnvironment, type TaxProviderRequest, type TaxProviderResponse,
} from "../lib/taxIntegrationAdapters.js";
import { buildEtaSignedInvoice, buildJordanUblInvoiceXml, newJordanDocumentUuid, type TaxInvoiceSnapshot } from "../lib/taxInvoiceDocuments.js";
import { serializeEtaJsonWire } from "../lib/eta-cades-bes.js";
import { mayRetryTaxSubmission } from "../lib/taxSubmissionPolicy.js";
import type { OwnerBillLineTaxSnapshot } from "../lib/contracting-local-tax-snapshot.js";
import { ensureContractingLocalTaxMappingTables } from "../lib/contracting-local-tax-mapping-service.js";

const router = Router();
router.use(extractAuth);

const PROVIDERS = {
  EG: {
    provider: "egypt_eta", module: "egypt_tax",
    requiredKeys: ["taxpayerId", "taxpayerActivityCode", "branchCode", "clientId", "clientSecret", "signingCertificate", "signingPrivateKey"],
    optionalKeys: ["signingPrivateKeyPassphrase"],
  },
  JO: {
    provider: "jordan_national", module: "jordan_tax",
    requiredKeys: ["taxNumber", "userNumber", "secretKey"],
    optionalKeys: ["sandboxEndpoint"],
  },
} as const;
const MAX_FIELD = 256 * 1024;

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for tax credential storage");
  return createHash("sha256").update(secret, "utf8").digest();
}

function encryptCredentials(value: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(part => part.toString("base64url")).join(".");
}

function decryptCredentials(value: string): Record<string, string> {
  const [ivPart, tagPart, bodyPart] = value.split(".");
  if (!ivPart || !tagPart || !bodyPart) throw new Error("Stored tax credentials are malformed");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(bodyPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed: unknown = JSON.parse(plain);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored tax credentials are malformed");
  return parsed as Record<string, string>;
}

async function providerTransport(request: TaxProviderRequest): Promise<TaxProviderResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: controller.signal,
      redirect: "error",
    });
    const text = request.method === "HEAD" ? "" : await response.text();
    let body: unknown = {};
    if (text) {
      try { body = JSON.parse(text); } catch { body = {}; }
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function companyContext(req: any, company: any, res: any): typeof PROVIDERS[keyof typeof PROVIDERS] | null {
  const country = company?.country as keyof typeof PROVIDERS;
  const cfg = PROVIDERS[country];
  if (!req.authUser?.companyId || req.authUser.companyId !== company.id || !cfg) {
    res.status(403).json({ error: "هذه الوحدة غير متاحة لدولة الشركة" });
    return null;
  }
  if (req.authUser.role !== "superadmin") {
    let permissions: Record<string, unknown> = {};
    try { permissions = JSON.parse(company.menuPermissions ?? "{}"); } catch { permissions = {}; }
    if (permissions[cfg.module] !== true) {
      res.status(403).json({ error: "وحدة التكامل الضريبي غير مفعلة لهذه الشركة" });
      return null;
    }
  }
  return cfg;
}

async function context(req: any, res: any) {
  if (!req.authUser) {
    res.status(401).json({ error: "غير مصرح" }); return null;
  }
  if (req.authUser.role !== "admin") {
    res.status(403).json({ error: "هذه الإعدادات متاحة لمدير الشركة فقط" }); return null;
  }
  const companyId = Number(req.authUser?.companyId);
  if (!Number.isInteger(companyId) || companyId < 1) {
    res.status(401).json({ error: "غير مصرح" }); return null;
  }
  const [company] = await db.select({
    id: companiesTable.id, country: companiesTable.country, menuPermissions: companiesTable.menuPermissions,
  }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  if (!company) { res.status(403).json({ error: "الشركة غير موجودة" }); return null; }
  const cfg = companyContext(req, company, res);
  return cfg ? { company, cfg } : null;
}

async function loadInvoiceSnapshot(companyId: number, invoiceId: number): Promise<TaxInvoiceSnapshot | null> {
  const [invoice] = await db.select().from(salesInvoicesTable).where(and(
    eq(salesInvoicesTable.id, invoiceId),
    eq(salesInvoicesTable.companyId, companyId),
  )).limit(1);
  if (!invoice) return null;
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  if (!company) return null;
  const lines = await db.select().from(salesInvoiceLinesTable).where(and(
    eq(salesInvoiceLinesTable.companyId, companyId),
    eq(salesInvoiceLinesTable.invoiceId, invoiceId),
  ));
  const [customer] = invoice.customerId
    ? await db.select().from(customersTable).where(and(
      eq(customersTable.companyId, companyId),
      eq(customersTable.id, invoice.customerId),
    )).limit(1)
    : [];
  return {
    invoice: {
      id: invoice.id,
      docNumber: invoice.docNumber,
      invoiceDate: invoice.invoiceDate,
      postedAt: invoice.postedAt,
      status: invoice.status,
      paymentType: invoice.paymentType,
      currencyCode: invoice.currencyCode,
      exchangeRate: invoice.exchangeRate,
      subtotal: invoice.subtotal,
      vatAmount: invoice.vatAmount,
      discountAmount: invoice.discountAmount,
      totalAmount: invoice.totalAmount,
      priceIncludesVat: invoice.priceIncludesVat,
    },
    company: {
      country: company.country,
      nameAr: company.nameAr,
      nameEn: company.nameEn,
      vatNumber: company.vatNumber,
      crNumber: company.crNumber,
      city: company.city,
      district: company.district,
      street: company.street,
      buildingNumber: company.buildingNumber,
      postalCode: company.postalCode,
      additionalNumber: company.additionalNumber,
      phone: company.phone,
    },
    customer: customer ? {
      nameAr: customer.nameAr,
      nameEn: customer.nameEn,
      vatNumber: customer.vatNumber,
      crNumber: customer.crNumber,
      country: customer.country,
      city: customer.city,
      district: customer.district,
      street: customer.street,
      buildingNumber: customer.buildingNumber,
      postalCode: customer.postalCode,
    } : null,
    lines: lines.map(line => ({
      itemName: line.itemName,
      itemCode: line.itemCode,
      unit: line.unit,
      qty: line.qty,
      unitPrice: line.unitPrice,
      discount: line.discount,
      discountAmount: line.discountAmount,
      vatRate: line.vatRate,
    })),
  };
}

const LOCAL_BILL_STATUSES = ["approved", "posted", "partially_paid", "paid"] as const;

function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100);
}

function fixedCents(value: number): string {
  return (value / 100).toFixed(2);
}

function submissionError(message: string, status = 422): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

async function loadOwnerBillTaxSnapshot(
  companyId: number,
  billId: number,
  provider: string,
): Promise<{ billNumber: string; snapshot: TaxInvoiceSnapshot }> {
  await ensureContractingLocalTaxMappingTables();
  const [bill] = await db.select().from(contractingProgressBillsTable).where(and(
    eq(contractingProgressBillsTable.id, billId),
    eq(contractingProgressBillsTable.companyId, companyId),
  )).limit(1);
  if (!bill) throw submissionError("المستخلص غير موجود في هذه الشركة", 404);
  if (bill.direction !== "outgoing" || bill.ownerContractId == null || bill.subcontractorContractId != null) {
    throw submissionError("الإرسال الضريبي المحلي متاح لمستخلصات المالك الصادرة فقط", 409);
  }
  if (bill.reversalJournalEntryId != null || bill.status === "reversed") {
    throw submissionError("لا يمكن إرسال مستخلص معكوس", 409);
  }
  if (bill.correctionOfId != null) {
    throw submissionError("تصحيح المستخلص يتطلب مساراً ضريبياً مستقلاً؛ لم يُرسل", 409);
  }
  if (!LOCAL_BILL_STATUSES.includes(bill.status as typeof LOCAL_BILL_STATUSES[number]) || bill.journalEntryId == null) {
    throw submissionError("لا يمكن إرسال مستخلص قبل ترحيل قيده المحاسبي", 409);
  }
  const [journal] = await db.select({ status: journalEntriesTable.status }).from(journalEntriesTable).where(and(
    eq(journalEntriesTable.id, bill.journalEntryId),
    eq(journalEntriesTable.companyId, companyId),
  )).limit(1);
  if (!journal || journal.status !== "posted") {
    throw submissionError("قيد المستخلص غير مرحّل؛ لم يُرسل", 409);
  }

  const [project] = await db.select().from(contractingProjectsTable).where(and(
    eq(contractingProjectsTable.id, bill.projectId),
    eq(contractingProjectsTable.companyId, companyId),
  )).limit(1);
  const [ownerContract] = await db.select().from(contractingOwnerContractsTable).where(and(
    eq(contractingOwnerContractsTable.id, bill.ownerContractId),
    eq(contractingOwnerContractsTable.companyId, companyId),
    eq(contractingOwnerContractsTable.projectId, bill.projectId),
  )).limit(1);
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  if (!project || !ownerContract || !company) {
    throw submissionError("تعذر التحقق من المشروع أو عقد المالك أو الشركة", 409);
  }
  const countryCode = String(company.country ?? "").toUpperCase();
  if ((countryCode === "EG" && provider !== "egypt_eta")
    || (countryCode === "JO" && provider !== "jordan_national")
    || !["EG", "JO"].includes(countryCode)) {
    throw submissionError("مزود الضريبة لا يطابق دولة الشركة", 403);
  }

  const rows = await db.select({
    line: contractingBillLinesTable,
    boqLine: contractingContractBoqLinesTable,
  }).from(contractingBillLinesTable).leftJoin(
    contractingContractBoqLinesTable,
    and(
      eq(contractingContractBoqLinesTable.id, contractingBillLinesTable.boqLineId),
      eq(contractingContractBoqLinesTable.companyId, companyId),
      eq(contractingContractBoqLinesTable.projectId, bill.projectId),
    ),
  ).where(and(
    eq(contractingBillLinesTable.companyId, companyId),
    eq(contractingBillLinesTable.projectId, bill.projectId),
    eq(contractingBillLinesTable.billId, billId),
  ));
  if (rows.length === 0) throw submissionError("المستخلص لا يحتوي على بنود BOQ ضريبية قابلة للإرسال", 422);
  const taxRows = rows.map(row => row.line.localTaxSnapshot as OwnerBillLineTaxSnapshot | null);
  if (rows.some((row, index) =>
    !taxRows[index]
    || row.line.localTaxSnapshotError
    || taxRows[index]!.countryCode !== countryCode
    || taxRows[index]!.currencyCode !== String(project.currencyCode ?? "").toUpperCase()
  )) {
    throw submissionError(
      rows.find(row => row.line.localTaxSnapshotError)?.line.localTaxSnapshotError
        ?? "توجد بنود لم تُحسم ضريبتها عند اعتماد المستخلص؛ لا يمكن إرسالها",
      422,
    );
  }
  const providerMappings = await db.select().from(contractingOwnerBillTaxMappingsTable).where(and(
    eq(contractingOwnerBillTaxMappingsTable.companyId, companyId),
    eq(contractingOwnerBillTaxMappingsTable.projectId, bill.projectId),
    eq(contractingOwnerBillTaxMappingsTable.ownerContractId, bill.ownerContractId),
    eq(contractingOwnerBillTaxMappingsTable.countryCode, countryCode),
    eq(contractingOwnerBillTaxMappingsTable.provider, provider),
    inArray(contractingOwnerBillTaxMappingsTable.boqLineId, rows.map(row => Number(row.line.boqLineId)).filter(Number.isInteger)),
  ));
  const mappingByBoq = new Map(providerMappings.map(mapping => [mapping.boqLineId, mapping]));
  const missingMap = rows.find(row => row.line.boqLineId == null || !mappingByBoq.has(row.line.boqLineId));
  if (missingMap) {
    throw submissionError("أكمل ربط الصنف والوحدة والفئة الضريبية لكل بند BOQ قبل الإرسال", 422);
  }
  if (ownerContract.customerId == null) {
    throw submissionError("اربط عقد المالك بعميل مسجل قبل إعداد مستند ETA/JoFotara", 422);
  }
  const [customer] = await db.select().from(customersTable).where(and(
    eq(customersTable.id, ownerContract.customerId),
    eq(customersTable.companyId, companyId),
  )).limit(1);
  if (!customer) throw submissionError("العميل المرتبط بعقد المالك غير موجود في هذه الشركة", 422);

  const currencyCode = String(project.currencyCode ?? "").toUpperCase();
  const expectedCurrency = countryCode === "EG" ? "EGP" : "JOD";
  if (currencyCode !== expectedCurrency) {
    throw submissionError("عملة المشروع المحلية غير مثبتة أو لا تطابق دولة الشركة", 422);
  }
  const lineBaseCents = taxRows.reduce((sum, row) => sum + roundCents(Number(row!.taxBase)), 0);
  const lineTaxCents = taxRows.reduce((sum, row) => sum + roundCents(Number(row!.taxAmount)), 0);
  const periodGrossCents = roundCents(Number(bill.grossAmount) - Number(bill.previousPaid));
  const billVatCents = roundCents(Number(bill.vatAmount));
  if (lineBaseCents !== periodGrossCents || lineTaxCents !== billVatCents
    || roundCents(Number(bill.netAmount) - Number(bill.vatAmount)) !== roundCents(Number(bill.dueAmount))
    || roundCents(Number(bill.netAmount) + Number(bill.retentionAmount)) !== lineBaseCents + billVatCents) {
    throw submissionError("إجماليات البنود المثبتة لا تتطابق مع المستخلص المرحّل؛ لم يُرسل", 422);
  }
  if (!String(bill.billNumber ?? "").trim()) throw submissionError("رقم المستخلص مطلوب قبل الإرسال", 422);

  const snapshot: TaxInvoiceSnapshot = {
    invoice: {
      id: bill.id,
      docNumber: bill.billNumber,
      invoiceDate: bill.billDate,
      postedAt: bill.approvedAt,
      status: "posted",
      paymentType: null,
      currencyCode,
      exchangeRate: "1",
      subtotal: fixedCents(lineBaseCents),
      vatAmount: fixedCents(lineTaxCents),
      discountAmount: "0.00",
      totalAmount: fixedCents(lineBaseCents + lineTaxCents),
      priceIncludesVat: false,
    },
    company: {
      country: company.country,
      nameAr: company.nameAr,
      nameEn: company.nameEn,
      vatNumber: company.vatNumber,
      crNumber: company.crNumber,
      city: company.city,
      district: company.district,
      street: company.street,
      buildingNumber: company.buildingNumber,
      postalCode: company.postalCode,
      additionalNumber: company.additionalNumber,
      phone: company.phone,
    },
    customer: {
      nameAr: customer.nameAr,
      nameEn: customer.nameEn,
      vatNumber: customer.vatNumber,
      crNumber: customer.crNumber,
      country: customer.country,
      city: customer.city,
      district: customer.district,
      street: customer.street,
      buildingNumber: customer.buildingNumber,
      postalCode: customer.postalCode,
    },
    lines: rows.map((row, index) => {
      const lineTax = taxRows[index]!;
      const mapping = mappingByBoq.get(Number(row.line.boqLineId))!;
      const description = String(row.boqLine?.description ?? row.boqLine?.lineCode ?? "").trim();
      if (!description) throw submissionError("أضف وصفاً أو رمزاً معتمداً لكل بند BOQ قبل الإرسال", 422);
      return {
        itemName: description,
        itemCode: mapping.providerItemCode,
        unit: mapping.providerUnitCode,
        qty: "1.0000",
        unitPrice: lineTax.taxBase,
        discount: "0",
        discountAmount: "0.00",
        vatRate: lineTax.taxRatePercent,
        providerMapping: {
          providerItemCode: mapping.providerItemCode,
          providerUnitCode: mapping.providerUnitCode,
          providerTaxCategoryCode: mapping.providerTaxCategoryCode,
        },
      };
    }),
  };
  return { billNumber: bill.billNumber, snapshot };
}

async function claimContractingBillSubmission(input: {
  companyId: number;
  billId: number;
  provider: string;
  environment: TaxEnvironment;
  retry: boolean;
  requestHash: string;
}) {
  const [created] = await db.insert(contractingTaxSubmissionsTable).values({
    companyId: input.companyId,
    billId: input.billId,
    provider: input.provider,
    environment: input.environment,
    status: "submitting",
    attemptCount: 1,
    requestHash: input.requestHash,
  }).onConflictDoNothing().returning();
  if (created) return { ok: true as const, row: created };

  const [existing] = await db.select().from(contractingTaxSubmissionsTable).where(and(
    eq(contractingTaxSubmissionsTable.companyId, input.companyId),
    eq(contractingTaxSubmissionsTable.provider, input.provider),
    eq(contractingTaxSubmissionsTable.billId, input.billId),
    eq(contractingTaxSubmissionsTable.environment, input.environment),
  )).limit(1);
  if (!existing || !mayRetryTaxSubmission(existing.status, input.retry)) {
    return { ok: false as const, row: existing ?? null };
  }
  const [retried] = await db.update(contractingTaxSubmissionsTable).set({
    status: "submitting",
    attemptCount: existing.attemptCount + 1,
    providerSubmissionId: null,
    responseCode: null,
    errorCode: null,
    requestHash: input.requestHash,
    lastAttemptAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(contractingTaxSubmissionsTable.id, existing.id),
    eq(contractingTaxSubmissionsTable.status, "rejected"),
  )).returning();
  return retried ? { ok: true as const, row: retried } : { ok: false as const, row: existing };
}

async function claimSubmission(input: {
  companyId: number;
  invoiceId: number;
  provider: string;
  environment: TaxEnvironment;
  retry: boolean;
  documentUuid: string | null;
  requestHash: string;
}) {
  const [created] = await db.insert(taxIntegrationSubmissionsTable).values({
    companyId: input.companyId,
    invoiceId: input.invoiceId,
    provider: input.provider,
    environment: input.environment,
    status: "submitting",
    attemptCount: 1,
    documentUuid: input.documentUuid,
    requestHash: input.requestHash,
  }).onConflictDoNothing().returning();
  if (created) return { ok: true as const, row: created };

  const [existing] = await db.select().from(taxIntegrationSubmissionsTable).where(and(
    eq(taxIntegrationSubmissionsTable.companyId, input.companyId),
    eq(taxIntegrationSubmissionsTable.provider, input.provider),
    eq(taxIntegrationSubmissionsTable.invoiceId, input.invoiceId),
    eq(taxIntegrationSubmissionsTable.environment, input.environment),
  )).limit(1);
  if (!existing) return { ok: false as const, row: null };
  if (!mayRetryTaxSubmission(existing.status, input.retry)) return { ok: false as const, row: existing };

  const [retried] = await db.update(taxIntegrationSubmissionsTable).set({
    status: "submitting",
    environment: input.environment,
    attemptCount: existing.attemptCount + 1,
    documentUuid: existing.documentUuid ?? input.documentUuid,
    providerSubmissionId: null,
    responseCode: null,
    errorCode: null,
    requestHash: input.requestHash,
    lastAttemptAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(taxIntegrationSubmissionsTable.id, existing.id),
    eq(taxIntegrationSubmissionsTable.status, "rejected"),
  )).returning();
  return retried ? { ok: true as const, row: retried } : { ok: false as const, row: existing };
}

router.get("/setup", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  const [row] = await db.select({
    environment: taxIntegrationSetupsTable.environment,
    status: taxIntegrationSetupsTable.status,
    updatedAt: taxIntegrationSetupsTable.updatedAt,
  }).from(taxIntegrationSetupsTable).where(and(
    eq(taxIntegrationSetupsTable.companyId, c.company.id),
    eq(taxIntegrationSetupsTable.provider, c.cfg.provider),
  )).limit(1);
  res.json({
    country: c.company.country, provider: c.cfg.provider,
    environment: row?.environment ?? null,
    hasCredentials: !!row,
    setupStatus: row?.status ?? "not_configured",
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  });
});

router.put("/setup", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  const user = req.authUser;
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  const { environment, credentials } = req.body ?? {};
  if (environment !== "sandbox" && environment !== "production") {
    res.status(400).json({ error: "بيئة التكامل غير صحيحة" }); return;
  }
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    res.status(400).json({ error: "بيانات الاعتماد غير صحيحة" }); return;
  }
  const requiredKeys: readonly string[] = c.cfg.requiredKeys;
  const optionalKeys: readonly string[] = c.cfg.optionalKeys;
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(credentials);
  if (keys.some(key => !allowedKeys.has(key)) || requiredKeys.some(key => !keys.includes(key))) {
    res.status(400).json({ error: "بيانات الاعتماد المطلوبة غير مكتملة" }); return;
  }
  const clean: Record<string, string> = {};
  for (const key of [...requiredKeys, ...optionalKeys]) {
    const value = credentials[key];
    if (value === undefined && optionalKeys.includes(key)) continue;
    if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_FIELD) {
      res.status(400).json({ error: "إحدى بيانات الاعتماد غير صالحة" }); return;
    }
    clean[key] = value;
  }
  if (c.company.country === "JO" && environment === "sandbox") {
    try {
      const sandbox = new URL(clean.sandboxEndpoint ?? "");
      const host = sandbox.hostname.toLowerCase();
      if (sandbox.protocol !== "https:" || host === "backend.jofotara.gov.jo"
        || (host !== "jofotara.gov.jo" && !host.endsWith(".jofotara.gov.jo"))) {
        throw new Error("invalid host");
      }
    } catch {
      res.status(400).json({ error: "أدخل عنوان اختبار HTTPS رسمي من JoFotara. لا تستخدم عنوان الإنتاج في بيئة الاختبار." }); return;
    }
  }
  const now = new Date();
  const encrypted = encryptCredentials(clean);
  await db.insert(taxIntegrationSetupsTable).values({
    companyId: c.company.id, country: c.company.country, provider: c.cfg.provider,
    environment, credentialsEnc: encrypted, status: "configured_unverified",
    updatedBy: user.id, updatedAt: now,
  }).onConflictDoUpdate({
    target: [taxIntegrationSetupsTable.companyId, taxIntegrationSetupsTable.provider],
    set: { country: c.company.country, environment, credentialsEnc: encrypted, status: "configured_unverified", updatedBy: user.id, updatedAt: now },
  });
  await db.insert(taxIntegrationAuditTable).values({
    companyId: c.company.id, userId: user.id, provider: c.cfg.provider,
    action: "credentials_replaced", environment, metadata: { fieldCount: keys.length },
  });
  res.json({ country: c.company.country, provider: c.cfg.provider, environment, hasCredentials: true, setupStatus: "configured_unverified", updatedAt: now.toISOString() });
});

router.post("/test-connection", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  if (c.company.country === "JO") {
    res.status(409).json({
      ok: false,
      setupStatus: "configured_unverified",
      credentialsVerified: false,
      httpStatus: null,
      message: "اختبار JoFotara الشبكي متوقف حتى توفير بيئة اختبار رسمية؛ لم يُرسل أي طلب.",
    });
    return;
  }
  const [setup] = await db.select().from(taxIntegrationSetupsTable).where(and(
    eq(taxIntegrationSetupsTable.companyId, c.company.id),
    eq(taxIntegrationSetupsTable.provider, c.cfg.provider),
  )).limit(1);
  if (!setup) { res.status(404).json({ error: "احفظ بيانات التكامل أولاً" }); return; }

  let credentials: Record<string, string>;
  try { credentials = decryptCredentials(setup.credentialsEnc); }
  catch { res.status(500).json({ error: "تعذر قراءة بيانات التكامل المحفوظة" }); return; }

  const environment = setup.environment as TaxEnvironment;
  const result = await testEtaConnection(
    { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
    providerTransport,
    environment,
  );

  const status = result.ok ? "connection_verified" : "configured_unverified";
  const now = new Date();
  await db.update(taxIntegrationSetupsTable).set({ status, updatedAt: now }).where(and(
    eq(taxIntegrationSetupsTable.companyId, c.company.id),
    eq(taxIntegrationSetupsTable.provider, c.cfg.provider),
  ));
  const user = req.authUser!;
  await db.insert(taxIntegrationAuditTable).values({
    companyId: c.company.id,
    userId: user.id,
    provider: c.cfg.provider,
    action: result.ok ? "connection_test_succeeded" : "connection_test_failed",
    environment,
    metadata: {
      httpStatus: result.httpStatus ?? null,
      credentialsVerified: result.ok,
    },
  });
  const message = result.ok ? "تم التحقق من بيانات اعتماد ETA." : "تعذر الوصول إلى ETA أو رفض الطلب.";
  res.status(result.ok ? 200 : 502).json({
    ok: result.ok,
    setupStatus: status,
    credentialsVerified: result.ok,
    httpStatus: result.httpStatus ?? null,
    message,
  });
});

router.get("/submissions", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  const raw = typeof req.query.invoiceIds === "string" ? req.query.invoiceIds : "";
  const ids = [...new Set(raw.split(",").map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0))];
  if (ids.length > 100) { res.status(400).json({ error: "يمكن الاستعلام عن 100 فاتورة كحد أقصى" }); return; }
  if (ids.length === 0) { res.json([]); return; }
  const [setup] = await db.select({ environment: taxIntegrationSetupsTable.environment }).from(taxIntegrationSetupsTable).where(and(
    eq(taxIntegrationSetupsTable.companyId, c.company.id),
    eq(taxIntegrationSetupsTable.provider, c.cfg.provider),
  )).limit(1);
  if (!setup) { res.json([]); return; }
  const rows = await db.select({
    invoiceId: taxIntegrationSubmissionsTable.invoiceId,
    environment: taxIntegrationSubmissionsTable.environment,
    status: taxIntegrationSubmissionsTable.status,
    attemptCount: taxIntegrationSubmissionsTable.attemptCount,
    providerSubmissionId: taxIntegrationSubmissionsTable.providerSubmissionId,
    responseCode: taxIntegrationSubmissionsTable.responseCode,
    updatedAt: taxIntegrationSubmissionsTable.updatedAt,
  }).from(taxIntegrationSubmissionsTable).where(and(
    eq(taxIntegrationSubmissionsTable.companyId, c.company.id),
    eq(taxIntegrationSubmissionsTable.provider, c.cfg.provider),
    eq(taxIntegrationSubmissionsTable.environment, setup.environment),
    inArray(taxIntegrationSubmissionsTable.invoiceId, ids),
  ));
  res.json(rows.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() })));
});

router.post("/invoices/:invoiceId/submit", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  if (c.company.country === "JO") {
    res.status(409).json({
      error: "إرسال فواتير JoFotara متوقف حتى توفير بيئة اختبار رسمية؛ استخدم المعاينة المحلية فقط.",
    });
    return;
  }
  const invoiceId = Number(req.params.invoiceId);
  if (!Number.isInteger(invoiceId) || invoiceId < 1) {
    res.status(400).json({ error: "رقم الفاتورة غير صالح" }); return;
  }
  const [setup] = await db.select().from(taxIntegrationSetupsTable).where(and(
    eq(taxIntegrationSetupsTable.companyId, c.company.id),
    eq(taxIntegrationSetupsTable.provider, c.cfg.provider),
  )).limit(1);
  if (!setup) { res.status(409).json({ error: "إعداد التكامل الضريبي غير مكتمل" }); return; }
  const environment = setup.environment as TaxEnvironment;
  if (environment === "production" && req.body?.confirmProduction !== true) {
    res.status(409).json({ error: "يتطلب الإرسال إلى الإنتاج تأكيداً صريحاً" }); return;
  }
  const requiredStatus = "connection_verified";
  if (setup.status !== requiredStatus) {
    res.status(409).json({ error: "تحقق من بيانات اعتماد ETA قبل الإرسال." }); return;
  }

  const snapshot = await loadInvoiceSnapshot(c.company.id, invoiceId);
  if (!snapshot) { res.status(404).json({ error: "الفاتورة غير موجودة في هذه الشركة" }); return; }
  if (snapshot.invoice.status !== "posted") {
    res.status(409).json({ error: "لا يمكن إرسال فاتورة قبل ترحيلها" }); return;
  }

  let document: Record<string, unknown>;
  let requestHash: string;
  let credentials: Record<string, string>;
  try {
    credentials = decryptCredentials(setup.credentialsEnc);
    document = buildEtaSignedInvoice(snapshot, {
      taxpayerId: credentials.taxpayerId,
      taxpayerActivityCode: credentials.taxpayerActivityCode,
      branchCode: credentials.branchCode,
      signingCertificate: credentials.signingCertificate,
      signingPrivateKey: credentials.signingPrivateKey,
      signingPrivateKeyPassphrase: credentials.signingPrivateKeyPassphrase,
    });
    requestHash = createHash("sha256").update(serializeEtaJsonWire(document)).digest("hex");
  } catch (error) {
    const message = error instanceof Error ? error.message : "تعذر تجهيز الفاتورة";
    res.status(422).json({ error: message }); return;
  }

  const claim = await claimSubmission({
    companyId: c.company.id,
    invoiceId,
    provider: c.cfg.provider,
    environment,
    retry: req.body?.retry === true,
    documentUuid: null,
    requestHash,
  });
  if (!claim.ok) {
    res.status(409).json({
      error: claim.row
        ? "توجد محاولة إرسال سابقة. لا تعِد الإرسال إلا بعد رفض موثق من المزود."
        : "تعذر حجز محاولة إرسال الفاتورة.",
      submissionStatus: claim.row?.status ?? null,
      attemptCount: claim.row?.attemptCount ?? null,
    });
    return;
  }

  let providerResult:
    | { ok: true; httpStatus: number; providerSubmissionId?: string }
    | { ok: false; reason: "provider_rejected" | "provider_unavailable" | "invalid_credentials"; httpStatus?: number };
  const authentication = await authenticateEta(
    { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
    providerTransport,
    environment,
  );
  if (!authentication.ok) {
    const failedStatus = authentication.reason === "provider_unavailable" ? "unknown" : "rejected";
    await db.update(taxIntegrationSubmissionsTable).set({
      status: failedStatus,
      errorCode: authentication.reason,
      responseCode: authentication.httpStatus ? String(authentication.httpStatus) : null,
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(taxIntegrationSubmissionsTable.id, claim.row.id));
    res.status(502).json({ error: "فشل التحقق من ETA؛ لم يتم إرسال الفاتورة", submissionStatus: failedStatus });
    return;
  }
  try {
    providerResult = await submitEtaDocuments({
      environment,
      accessToken: authentication.accessToken,
      signedDocuments: [document],
    }, providerTransport);
  } finally {
    // The short-lived bearer token is only held in memory for this request.
    authentication.accessToken = "";
  }

  const providerStatus = providerResult.ok
    ? "processing"
    : providerResult.reason === "provider_rejected" && (providerResult.httpStatus ?? 0) < 500
      ? "rejected"
      : "unknown";
  const errorCode = providerResult.ok ? null
    : providerResult.httpStatus ? `HTTP_${providerResult.httpStatus}` : providerResult.reason;
  await db.update(taxIntegrationSubmissionsTable).set({
    status: providerStatus,
    providerSubmissionId: providerResult.ok ? providerResult.providerSubmissionId ?? null : null,
    responseCode: providerResult.httpStatus ? String(providerResult.httpStatus) : null,
    errorCode,
    lastAttemptAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(taxIntegrationSubmissionsTable.id, claim.row.id));
  const user = req.authUser!;
  await db.insert(taxIntegrationAuditTable).values({
    companyId: c.company.id,
    userId: user.id,
    provider: c.cfg.provider,
    action: `invoice_submission_${providerStatus}`,
    environment,
    metadata: {
      invoiceId,
      invoiceNumber: snapshot.invoice.docNumber,
      httpStatus: providerResult.httpStatus ?? null,
      attemptCount: claim.row.attemptCount,
    },
  });
  res.status(providerResult.ok ? 202 : 502).json({
    ok: providerResult.ok,
    invoiceId,
    status: providerStatus,
    providerSubmissionId: providerResult.ok ? providerResult.providerSubmissionId ?? null : null,
    message: providerResult.ok
      ? "استلم المزود طلب الإرسال؛ القبول الضريبي النهائي لم يُتحقق منه بعد."
      : providerStatus === "rejected"
        ? "رفض المزود الفاتورة. راجع بياناتها قبل أي إعادة إرسال."
        : "تعذر تأكيد نتيجة الإرسال. أُوقف التكرار لحماية الفاتورة من الإرسال المزدوج.",
  });
});

router.get("/logs", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  const rows = await db.select({
    id: taxIntegrationAuditTable.id, provider: taxIntegrationAuditTable.provider,
    action: taxIntegrationAuditTable.action, environment: taxIntegrationAuditTable.environment,
    metadata: taxIntegrationAuditTable.metadata, createdAt: taxIntegrationAuditTable.createdAt,
  }).from(taxIntegrationAuditTable).where(and(
    eq(taxIntegrationAuditTable.companyId, c.company.id),
    eq(taxIntegrationAuditTable.provider, c.cfg.provider),
  ))
    .orderBy(desc(taxIntegrationAuditTable.createdAt)).limit(100);
  res.json(rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })));
});

router.get("/contracting-bills/submissions", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  const projectId = Number(req.query.projectId);
  if (!Number.isInteger(projectId) || projectId < 1) {
    res.status(400).json({ error: "رقم المشروع غير صالح" }); return;
  }
  const [setup] = await db.select({
    provider: taxIntegrationSetupsTable.provider,
    environment: taxIntegrationSetupsTable.environment,
    status: taxIntegrationSetupsTable.status,
  }).from(taxIntegrationSetupsTable).where(and(
    eq(taxIntegrationSetupsTable.companyId, c.company.id),
    eq(taxIntegrationSetupsTable.provider, c.cfg.provider),
  )).limit(1);
  const rows = await db.select({
    billId: contractingTaxSubmissionsTable.billId,
    provider: contractingTaxSubmissionsTable.provider,
    environment: contractingTaxSubmissionsTable.environment,
    status: contractingTaxSubmissionsTable.status,
    attemptCount: contractingTaxSubmissionsTable.attemptCount,
    providerSubmissionId: contractingTaxSubmissionsTable.providerSubmissionId,
    responseCode: contractingTaxSubmissionsTable.responseCode,
    errorCode: contractingTaxSubmissionsTable.errorCode,
    updatedAt: contractingTaxSubmissionsTable.updatedAt,
  }).from(contractingTaxSubmissionsTable).innerJoin(
    contractingProgressBillsTable,
    and(
      eq(contractingProgressBillsTable.id, contractingTaxSubmissionsTable.billId),
      eq(contractingProgressBillsTable.companyId, contractingTaxSubmissionsTable.companyId),
    ),
  ).where(and(
    eq(contractingTaxSubmissionsTable.companyId, c.company.id),
    eq(contractingTaxSubmissionsTable.provider, c.cfg.provider),
    eq(contractingProgressBillsTable.projectId, projectId),
  )).orderBy(desc(contractingTaxSubmissionsTable.updatedAt));
  res.json({
    setup: setup ?? null,
    submissions: rows.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
  });
});

router.get("/contracting-bills/:billId/readiness", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  const billId = Number(req.params.billId);
  if (!Number.isInteger(billId) || billId < 1) {
    res.status(400).json({ error: "رقم المستخلص غير صالح" }); return;
  }
  const countryCode = String(c.company.country ?? "").toUpperCase();
  const previewOnly = countryCode === "JO";
  const blockers: string[] = [];
  const [setup] = await db.select({
    environment: taxIntegrationSetupsTable.environment,
    status: taxIntegrationSetupsTable.status,
  }).from(taxIntegrationSetupsTable).where(and(
    eq(taxIntegrationSetupsTable.companyId, c.company.id),
    eq(taxIntegrationSetupsTable.provider, c.cfg.provider),
  )).limit(1);
  try {
    await loadOwnerBillTaxSnapshot(c.company.id, billId, c.cfg.provider);
  } catch (error) {
    const status = Number((error as { status?: number })?.status) || 422;
    if (status === 404) {
      res.status(404).json({ error: error instanceof Error ? error.message : "المستخلص غير موجود" });
      return;
    }
    blockers.push(error instanceof Error ? error.message : "تعذر التحقق من بيانات المستخلص");
  }
  if (!previewOnly && countryCode === "EG" && (!setup || setup.status !== "connection_verified")) {
    blockers.push("تحقق من إعداد ETA وبيانات الاعتماد قبل الإرسال");
  }
  if (!["EG", "JO"].includes(countryCode)) blockers.push("المسار المحلي متاح لمصر والأردن فقط");
  const ready = blockers.length === 0;
  res.json({
    billId,
    countryCode,
    provider: c.cfg.provider,
    ready,
    canSubmit: ready && countryCode === "EG",
    canPreview: ready && previewOnly,
    previewOnly,
    environment: setup?.environment ?? null,
    blockers,
  });
});

router.post("/contracting-bills/:billId/refresh-status", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  const billId = Number(req.params.billId);
  if (!Number.isInteger(billId) || billId < 1) {
    res.status(400).json({ error: "رقم المستخلص غير صالح" }); return;
  }
  if (c.company.country !== "EG" || c.cfg.provider !== "egypt_eta") {
    res.status(409).json({ error: "تحديث الحالة متاح لإرسالات ETA المصرية فقط" }); return;
  }
  const [submission] = await db.select().from(contractingTaxSubmissionsTable).where(and(
    eq(contractingTaxSubmissionsTable.companyId, c.company.id),
    eq(contractingTaxSubmissionsTable.billId, billId),
    eq(contractingTaxSubmissionsTable.provider, "egypt_eta"),
  )).orderBy(desc(contractingTaxSubmissionsTable.updatedAt)).limit(1);
  if (!submission) { res.status(404).json({ error: "لا يوجد إرسال ETA لهذا المستخلص" }); return; }
  if (!submission.providerSubmissionId) {
    res.status(409).json({
      error: "لم يُعد ETA رقم طلب يمكن الاستعلام عنه؛ لا تعِد الإرسال تلقائياً.",
      status: submission.status,
      attemptCount: submission.attemptCount,
    });
    return;
  }
  const [bill] = await db.select({ billNumber: contractingProgressBillsTable.billNumber })
    .from(contractingProgressBillsTable).where(and(
      eq(contractingProgressBillsTable.id, billId),
      eq(contractingProgressBillsTable.companyId, c.company.id),
    )).limit(1);
  if (!bill?.billNumber) { res.status(404).json({ error: "المستخلص غير موجود" }); return; }
  const [setup] = await db.select().from(taxIntegrationSetupsTable).where(and(
    eq(taxIntegrationSetupsTable.companyId, c.company.id),
    eq(taxIntegrationSetupsTable.provider, "egypt_eta"),
  )).limit(1);
  if (!setup || setup.environment !== submission.environment || setup.status !== "connection_verified") {
    res.status(409).json({ error: "إعداد ETA الحالي لا يطابق بيئة الإرسال المسجل؛ لم يتم الاستعلام" }); return;
  }
  let credentials: Record<string, string>;
  try {
    credentials = decryptCredentials(setup.credentialsEnc);
  } catch {
    res.status(500).json({ error: "تعذر قراءة إعداد ETA المحفوظ" }); return;
  }
  const authentication = await authenticateEta(
    { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
    providerTransport,
    submission.environment as TaxEnvironment,
  );
  if (!authentication.ok) {
    res.status(502).json({
      error: "تعذر التحقق من ETA قبل تحديث الحالة؛ بقيت الحالة المسجلة دون تغيير.",
      status: submission.status,
    });
    return;
  }
  const result = await getEtaSubmissionStatus({
    environment: submission.environment as TaxEnvironment,
    accessToken: authentication.accessToken,
    providerSubmissionId: submission.providerSubmissionId,
    internalId: bill.billNumber,
  }, providerTransport);
  authentication.accessToken = "";
  await db.update(contractingTaxSubmissionsTable).set({
    status: result.status,
    responseCode: result.httpStatus ? String(result.httpStatus) : null,
    errorCode: result.errorCode ?? null,
    lastAttemptAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(contractingTaxSubmissionsTable.id, submission.id));
  await db.insert(taxIntegrationAuditTable).values({
    companyId: c.company.id,
    userId: req.authUser!.id,
    provider: "egypt_eta",
    action: `contracting_bill_status_${result.status}`,
    environment: submission.environment,
    metadata: { billId, httpStatus: result.httpStatus ?? null },
  });
  res.status(result.ok ? 200 : 502).json({
    ok: result.ok,
    billId,
    status: result.status,
    responseCode: result.httpStatus ? String(result.httpStatus) : null,
    errorCode: result.errorCode ?? null,
    message: result.status === "accepted"
      ? "أكد ETA الحالة النهائية valid."
      : result.status === "rejected"
        ? "أعاد ETA حالة نهائية غير صالحة للمستند."
        : result.status === "processing"
          ? "لا يزال ETA يعالج المستند."
          : "تعذر مطابقة حالة ETA مع المستند؛ أُبقيت الإعادة محظورة.",
  });
});

router.post("/contracting-bills/:billId/preview", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  const billId = Number(req.params.billId);
  if (!Number.isInteger(billId) || billId < 1) {
    res.status(400).json({ error: "رقم المستخلص غير صالح" }); return;
  }
  if (c.company.country !== "JO" || c.cfg.provider !== "jordan_national") {
    res.status(409).json({ error: "المعاينة المحلية مخصصة لوثائق JoFotara فقط" }); return;
  }
  try {
    const { billNumber, snapshot } = await loadOwnerBillTaxSnapshot(
      c.company.id,
      billId,
      c.cfg.provider,
    );
    const documentUuid = newJordanDocumentUuid();
    const xml = buildJordanUblInvoiceXml(snapshot, documentUuid);
    res.json({
      ok: true,
      sent: false,
      status: "local_preview_only",
      billId,
      billNumber,
      documentUuid,
      xml,
      message: "أُنشئت معاينة XML محلياً فقط؛ لم يتم الاتصال بنظام JoFotara ولم تُقبل الفاتورة.",
    });
  } catch (error) {
    const status = Number((error as { status?: number })?.status) || 422;
    res.status(status).json({ error: error instanceof Error ? error.message : "تعذر إنشاء المعاينة المحلية" });
  }
});

router.post("/contracting-bills/:billId/submit", async (req, res): Promise<void> => {
  const c = await context(req, res); if (!c) return;
  const billId = Number(req.params.billId);
  if (!Number.isInteger(billId) || billId < 1) {
    res.status(400).json({ error: "رقم المستخلص غير صالح" }); return;
  }
  // ISTD has not confirmed an official sandbox endpoint. Never invoke the
  // shared fetch transport for Jordan, regardless of saved endpoint settings.
  if (c.company.country === "JO" || c.cfg.provider === "jordan_national") {
    res.status(409).json({
      error: "إرسال JoFotara متوقف حتى تأكيد عنوان بيئة الاختبار رسمياً؛ استخدم المعاينة المحلية فقط.",
      sent: false,
    });
    return;
  }
  if (c.company.country !== "EG" || c.cfg.provider !== "egypt_eta") {
    res.status(403).json({ error: "مزود الإرسال لا يطابق دولة الشركة" }); return;
  }
  const [setup] = await db.select().from(taxIntegrationSetupsTable).where(and(
    eq(taxIntegrationSetupsTable.companyId, c.company.id),
    eq(taxIntegrationSetupsTable.provider, c.cfg.provider),
  )).limit(1);
  if (!setup) { res.status(409).json({ error: "إعداد تكامل ETA غير مكتمل" }); return; }
  const environment = setup.environment as TaxEnvironment;
  if (environment !== "sandbox" && environment !== "production") {
    res.status(409).json({ error: "بيئة ETA المحفوظة غير صالحة" }); return;
  }
  if (environment === "production" && req.body?.confirmProduction !== true) {
    res.status(409).json({ error: "يتطلب إرسال مستخلص المالك إلى ETA الإنتاج تأكيداً صريحاً", sent: false }); return;
  }
  if (setup.status !== "connection_verified") {
    res.status(409).json({ error: "تحقق من إعداد ETA وبيانات الاعتماد قبل إرسال المستخلص", sent: false }); return;
  }

  let snapshot: TaxInvoiceSnapshot;
  let billNumber: string;
  let document: Record<string, unknown>;
  let credentials: Record<string, string>;
  let requestHash: string;
  try {
    ({ billNumber, snapshot } = await loadOwnerBillTaxSnapshot(
      c.company.id,
      billId,
      c.cfg.provider,
    ));
    credentials = decryptCredentials(setup.credentialsEnc);
    document = buildEtaSignedInvoice(snapshot, {
      taxpayerId: credentials.taxpayerId,
      taxpayerActivityCode: credentials.taxpayerActivityCode,
      branchCode: credentials.branchCode,
      signingCertificate: credentials.signingCertificate,
      signingPrivateKey: credentials.signingPrivateKey,
      signingPrivateKeyPassphrase: credentials.signingPrivateKeyPassphrase,
    });
    requestHash = createHash("sha256").update(serializeEtaJsonWire(document)).digest("hex");
  } catch (error) {
    res.status(Number((error as { status?: number })?.status) || 422).json({
      error: error instanceof Error ? error.message : "تعذر تجهيز مستند ETA",
      sent: false,
    });
    return;
  }

  const claim = await claimContractingBillSubmission({
    companyId: c.company.id,
    billId,
    provider: c.cfg.provider,
    environment,
    retry: req.body?.retry === true,
    requestHash,
  });
  if (!claim.ok) {
    res.status(409).json({
      error: claim.row
        ? "توجد محاولة سابقة؛ لا تعِد الإرسال إلا بعد رفض نهائي موثق من ETA."
        : "تعذر حجز محاولة إرسال المستخلص.",
      submissionStatus: claim.row?.status ?? null,
      attemptCount: claim.row?.attemptCount ?? null,
      sent: false,
    });
    return;
  }

  let providerResult:
    | { ok: true; httpStatus: number; providerSubmissionId?: string }
    | { ok: false; reason: "provider_rejected" | "provider_unavailable" | "invalid_credentials"; httpStatus?: number };
  const authentication = await authenticateEta(
    { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
    providerTransport,
    environment,
  );
  if (!authentication.ok) {
    const failedStatus = authentication.reason === "provider_unavailable" ? "unknown" : "rejected";
    await db.update(contractingTaxSubmissionsTable).set({
      status: failedStatus,
      errorCode: authentication.reason,
      responseCode: authentication.httpStatus ? String(authentication.httpStatus) : null,
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(contractingTaxSubmissionsTable.id, claim.row.id));
    res.status(502).json({
      error: "فشل التحقق من ETA؛ لم يتم تأكيد إرسال المستخلص",
      submissionStatus: failedStatus,
      sent: false,
    });
    return;
  }
  try {
    providerResult = await submitEtaDocuments({
      environment,
      accessToken: authentication.accessToken,
      signedDocuments: [document],
    }, providerTransport);
  } catch {
    providerResult = { ok: false, reason: "provider_unavailable" };
  } finally {
    authentication.accessToken = "";
  }
  const providerStatus = providerResult.ok
    ? "processing"
    : providerResult.reason === "provider_rejected" && (providerResult.httpStatus ?? 0) < 500
      ? "rejected"
      : "unknown";
  const errorCode = providerResult.ok ? null
    : providerResult.httpStatus ? `HTTP_${providerResult.httpStatus}` : providerResult.reason;
  await db.update(contractingTaxSubmissionsTable).set({
    status: providerStatus,
    providerSubmissionId: providerResult.ok ? providerResult.providerSubmissionId ?? null : null,
    responseCode: providerResult.httpStatus ? String(providerResult.httpStatus) : null,
    errorCode,
    lastAttemptAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(contractingTaxSubmissionsTable.id, claim.row.id));
  await db.insert(taxIntegrationAuditTable).values({
    companyId: c.company.id,
    userId: req.authUser!.id,
    provider: c.cfg.provider,
    action: `contracting_bill_submission_${providerStatus}`,
    environment,
    metadata: {
      billId,
      billNumber,
      httpStatus: providerResult.httpStatus ?? null,
      attemptCount: claim.row.attemptCount,
    },
  });
  res.status(providerResult.ok ? 202 : 502).json({
    ok: providerResult.ok,
    sent: providerResult.ok,
    billId,
    billNumber,
    status: providerStatus,
    providerSubmissionId: providerResult.ok ? providerResult.providerSubmissionId ?? null : null,
    message: providerResult.ok
      ? "استلم ETA طلب الإرسال؛ الحالة قيد المعالجة وليست قبولاً ضريبياً نهائياً."
      : providerStatus === "rejected"
        ? "رفض ETA المستند؛ راجع سبب الرفض قبل أي إعادة إرسال."
        : "تعذر تأكيد نتيجة الإرسال؛ أُوقفت الإعادة الآلية لحماية المستند من التكرار.",
  });
});

export default router;