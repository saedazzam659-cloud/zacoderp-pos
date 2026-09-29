import { Router } from "express";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db, companiesTable, customersTable, salesInvoiceLinesTable, salesInvoicesTable,
  taxIntegrationSetupsTable, taxIntegrationAuditTable, taxIntegrationSubmissionsTable,
} from "@workspace/db";
import { extractAuth } from "../middleware/auth.js";
import {
  authenticateEta, submitEtaDocuments, submitJordanInvoice, testEtaConnection, testJordanEndpointReachability,
  type TaxEnvironment, type TaxProviderRequest, type TaxProviderResponse,
} from "../lib/taxIntegrationAdapters.js";
import { buildEtaSignedInvoice, buildJordanUblInvoiceXml, newJordanDocumentUuid, type TaxInvoiceSnapshot } from "../lib/taxInvoiceDocuments.js";
import { serializeEtaJsonWire } from "../lib/eta-cades-bes.js";
import { mayRetryTaxSubmission } from "../lib/taxSubmissionPolicy.js";

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
  const [setup] = await db.select().from(taxIntegrationSetupsTable).where(and(
    eq(taxIntegrationSetupsTable.companyId, c.company.id),
    eq(taxIntegrationSetupsTable.provider, c.cfg.provider),
  )).limit(1);
  if (!setup) { res.status(404).json({ error: "احفظ بيانات التكامل أولاً" }); return; }

  let credentials: Record<string, string>;
  try { credentials = decryptCredentials(setup.credentialsEnc); }
  catch { res.status(500).json({ error: "تعذر قراءة بيانات التكامل المحفوظة" }); return; }

  const environment = setup.environment as TaxEnvironment;
  const result = c.company.country === "EG"
    ? await testEtaConnection(
      { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
      providerTransport,
      environment,
    )
    : await testJordanEndpointReachability(
      environment === "sandbox" ? (credentials.sandboxEndpoint ?? "") : "",
      providerTransport,
      environment,
    );

  const status = !result.ok ? "configured_unverified"
    : c.company.country === "EG" ? "connection_verified"
      : "endpoint_reachable_unverified";
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
      httpStatus: "httpStatus" in result ? result.httpStatus : null,
      credentialsVerified: c.company.country === "EG" && result.ok,
    },
  });
  const message = result.ok
    ? c.company.country === "EG"
      ? "تم التحقق من بيانات اعتماد ETA."
      : "الخادم متاح، لكن هذا الاختبار لا يتحقق من بيانات JoFotara."
    : "reason" in result && result.reason === "production_test_unsupported"
      ? "لا يوجد اختبار آمن موثق لبيانات JoFotara في الإنتاج؛ لم نرسل أي طلب إلى عنوان الإنتاج."
      : "تعذر الوصول إلى المزود أو رفض الطلب.";
  const httpStatus = result.ok ? 200
    : "reason" in result && result.reason === "production_test_unsupported" ? 409 : 502;
  res.status(httpStatus).json({
    ok: result.ok,
    setupStatus: status,
    credentialsVerified: c.company.country === "EG" && result.ok,
    httpStatus: "httpStatus" in result ? result.httpStatus : null,
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
  const requiredStatus = c.company.country === "EG" ? "connection_verified"
    : environment === "sandbox" ? "endpoint_reachable_unverified" : "configured_unverified";
  if (setup.status !== requiredStatus) {
    res.status(409).json({
      error: c.company.country === "JO"
        ? "اختبر الوصول إلى خادم JoFotara قبل الإرسال؛ الاختبار لا يتحقق من بيانات الاعتماد."
        : "تحقق من بيانات اعتماد ETA قبل الإرسال.",
    }); return;
  }

  const snapshot = await loadInvoiceSnapshot(c.company.id, invoiceId);
  if (!snapshot) { res.status(404).json({ error: "الفاتورة غير موجودة في هذه الشركة" }); return; }
  if (snapshot.invoice.status !== "posted") {
    res.status(409).json({ error: "لا يمكن إرسال فاتورة قبل ترحيلها" }); return;
  }

  let document: Record<string, unknown> | null = null;
  let jordanXml: string | null = null;
  let documentUuid: string | null = null;
  let requestHash: string;
  let credentials: Record<string, string>;
  try {
    credentials = decryptCredentials(setup.credentialsEnc);
    if (c.company.country === "EG") {
      document = buildEtaSignedInvoice(snapshot, {
        taxpayerId: credentials.taxpayerId,
        taxpayerActivityCode: credentials.taxpayerActivityCode,
        branchCode: credentials.branchCode,
        signingCertificate: credentials.signingCertificate,
        signingPrivateKey: credentials.signingPrivateKey,
        signingPrivateKeyPassphrase: credentials.signingPrivateKeyPassphrase,
      });
      requestHash = createHash("sha256").update(serializeEtaJsonWire(document)).digest("hex");
    } else {
      const [previous] = await db.select({
        status: taxIntegrationSubmissionsTable.status,
        documentUuid: taxIntegrationSubmissionsTable.documentUuid,
      }).from(taxIntegrationSubmissionsTable).where(and(
        eq(taxIntegrationSubmissionsTable.companyId, c.company.id),
        eq(taxIntegrationSubmissionsTable.provider, c.cfg.provider),
        eq(taxIntegrationSubmissionsTable.invoiceId, invoiceId),
        eq(taxIntegrationSubmissionsTable.environment, environment),
      )).limit(1);
      documentUuid = previous?.documentUuid ?? newJordanDocumentUuid();
      jordanXml = buildJordanUblInvoiceXml(snapshot, documentUuid);
      requestHash = createHash("sha256").update(jordanXml, "utf8").digest("hex");
    }
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
    documentUuid,
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
  if (c.company.country === "EG") {
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
        signedDocuments: [document!],
      }, providerTransport);
    } finally {
      // The short-lived bearer token is only held in memory for this request.
      authentication.accessToken = "";
    }
  } else {
    providerResult = await submitJordanInvoice({
      environment,
      endpoint: credentials.sandboxEndpoint,
      userNumber: credentials.userNumber,
      secretKey: credentials.secretKey,
      ublXml: jordanXml!,
    }, providerTransport);
  }

  const providerStatus = providerResult.ok
    ? c.company.country === "EG" ? "processing" : "submitted"
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

export default router;