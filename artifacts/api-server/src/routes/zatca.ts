/**
 * ZATCA API Integration Routes
 * - POST /api/companies/:id/generate-csr   → Generate EC key + CSR
 * - POST /api/companies/:id/compliance     → Submit CSR with OTP → get CSID
 * - POST /api/companies/:id/production-csid → Get PCSID (onboarding)
 * - POST /api/invoices/:id/submit          → Clearance or Reporting
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { companiesTable, invoicesTable, invoiceLineItemsTable, customersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { generateCsr } from "../lib/zatca-csr.js";
import { generateZatcaQr } from "../lib/zatca-tlv.js";
import { generateZatcaXml, hashXml } from "../lib/zatca-xml.js";
import { buildSignedZatcaInvoice } from "../lib/zatca-build-signed.js";
import { invoiceRowToZatcaData } from "../lib/zatca-invoice-mapper.js";
import { runAutoComplianceCheck } from "../lib/zatca-compliance.js";
import { getZatcaBaseUrl, resolveZatcaEnv, envArabic, GENESIS_HASH, type ZatcaEnv } from "../lib/zatca-env.js";
import { createHash } from "crypto";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission, audit } from "../middleware/permissions.js";

const router = Router();

// Hard auth gate: every ZATCA endpoint requires a valid Bearer token. Anonymous
// callers get 401 instead of being able to mutate company-level CSR / CSID
// state via direct URL access.
router.use(extractAuth);
function requireAuthed(req: Request, res: Response, next: NextFunction) {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
}
router.use(requireAuthed);

// ZATCA environment/gateway resolution + the genesis chain hash now live in
// lib/zatca-env.ts so the sales-invoice bridge resolves the SAME gateway and
// genesis hash as the onboarding/live-submit flow. See that file for the
// three-environment notes (developer-portal / simulation / core-production).

function basicAuth(token: string, secret: string): string {
  return "Basic " + Buffer.from(`${token}:${secret}`).toString("base64");
}

// ─── 1. Generate CSR ─────────────────────────────────────────────────────────
router.post("/companies/:id/generate-csr", requirePermission("zatca_setup", "create"), audit("zatca_setup", "create"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "معرف الشركة غير صالح" });
    return;
  }

  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, id));
  if (!company) {
    res.status(404).json({ error: "الشركة غير موجودة" });
    return;
  }

  // Validate required company fields
  if (!company.nameAr?.trim()) {
    res.status(400).json({ error: "اسم الشركة بالعربي مطلوب لتوليد CSR" });
    return;
  }
  if (!company.vatNumber?.trim()) {
    res.status(400).json({ error: "الرقم الضريبي (VAT) مطلوب لتوليد CSR" });
    return;
  }

  try {
    // Build serial number: prefer explicit serialNumber, then deviceSerials, then fallback
    const serial1 = (company.deviceSerial1 ?? "").trim();
    const serial2 = (company.deviceSerial2 ?? "").trim();
    const serial3 = (company.deviceSerial3 ?? "").trim();

    const serialNumber = (company.serialNumber ?? "").trim()
      || (serial1 ? `1-${serial1}|2-${serial2 || "Node"}|3-${serial3 || company.id}` : `1-Server|2-Node|3-${company.id}`);

    // ZATCA requires a registered address + business category inside the CSR's
    // directoryName subjectAltName. Build a single-line address from the
    // company's structured address fields.
    const registeredAddress = [
      (company.buildingNumber ?? "").trim(),
      (company.street ?? "").trim(),
      (company.district ?? "").trim(),
      (company.city ?? "").trim(),
      (company.postalCode ?? "").trim(),
    ].filter(Boolean).join(" ");

    const { privateKey, csr } = generateCsr({
      commonName: serialNumber,
      organizationName: company.nameAr.trim(),
      organizationUnit: (company.industryName ?? "E-Invoice").trim(),
      country: (company.country ?? "SA").trim(),
      serialNumber,
      vatNumber: company.vatNumber.trim(),
      invoiceType: company.invoiceType ?? "both",
      registeredAddress,
      businessCategory: (company.industryName ?? "").trim(),
      environment: resolveZatcaEnv(company),
    });

    await db.update(companiesTable).set({
      serialNumber,
      zatcaPrivateKey: privateKey,
      zatcaCsr: csr,
      updatedAt: new Date(),
    }).where(eq(companiesTable.id, id));

    res.json({
      success: true,
      csr,
      serialNumber,
      message: "تم توليد CSR بنجاح. الخطوة التالية: احصل على OTP من بوابة ZATCA",
    });
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "فشل توليد CSR", details });
  }
});

// ─── 2. Compliance (CSID) ────────────────────────────────────────────────────
router.post("/companies/:id/compliance", requirePermission("zatca_setup", "create"), audit("zatca_setup", "create"), async (req, res) => {
  const id = parseInt(req.params.id);
  const { otp } = req.body as { otp: string };

  if (!otp) {
    res.status(400).json({ error: "OTP مطلوب. احصل عليه من بوابة ZATCA (fatoora.zatca.gov.sa)" });
    return;
  }

  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, id));
  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }

  if (!company.zatcaCsr) {
    res.status(400).json({ error: "يجب توليد CSR أولاً عبر مسار /generate-csr" });
    return;
  }

  try {
    const env = resolveZatcaEnv(company);
    const baseUrl = getZatcaBaseUrl(env);
    const csrBase64 = Buffer.from(company.zatcaCsr).toString("base64");

    const response = await fetch(`${baseUrl}/compliance`, {
      method: "POST",
      headers: {
        "Accept-Version": "V2",
        "Accept-Language": "en",
        "OTP": otp,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ csr: csrBase64 }),
    });

    const data = await response.json() as {
      requestID?: string;
      dispositionMessage?: string;
      binarySecurityToken?: string;
      secret?: string;
      errors?: unknown;
    };

    if (!response.ok) {
      req.log.warn(
        { companyId: id, status: response.status, environment: env, zatcaResponse: data },
        "ZATCA compliance request rejected",
      );
      res.status(response.status).json({
        error: "فشل استدعاء ZATCA Compliance API",
        zatcaResponse: data,
        hint: "تأكد من صحة OTP وأن CSR صالح. OTP صالح لمدة ساعة واحدة فقط.",
      });
      return;
    }

    // Save CSID token + secret AND the compliance requestID. The requestID is
    // required later by /production/csids; persisting it here (not just in the
    // browser) makes the production-csid step work across sessions/devices.
    await db.update(companiesTable).set({
      zatcaCsid: data.binarySecurityToken ?? null,
      zatcaCsidToken: data.binarySecurityToken ?? null,
      zatcaCsidSecret: data.secret ?? null,
      zatcaComplianceRequestId: data.requestID ?? null,
      updatedAt: new Date(),
    }).where(eq(companiesTable.id, id));

    res.json({
      success: true,
      requestID: data.requestID,
      dispositionMessage: data.dispositionMessage,
      binarySecurityToken: data.binarySecurityToken,
      message: "تم الحصول على CSID بنجاح. الشركة جاهزة لإصدار الفواتير التجريبية.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: "فشل الاتصال بـ ZATCA",
      details: message,
      hint: "تأكد من الاتصال بالإنترنت وصحة بيانات الشركة.",
    });
  }
});

// ─── 3. Production CSID (Onboarding) ─────────────────────────────────────────
router.post("/companies/:id/production-csid", requirePermission("zatca_setup", "create"), audit("zatca_setup", "create"), async (req, res) => {
  const id = parseInt(req.params.id);
  // ZATCA's /production/csids expects `compliance_request_id` = the `requestID`
  // returned by the earlier /compliance call (NOT the binary security token).
  // The client forwards it from the compliance step.
  const { complianceRequestId } = req.body as { complianceRequestId?: string };
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, id));

  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }

  if (!company.zatcaCsidToken || !company.zatcaCsidSecret) {
    res.status(400).json({ error: "CSID غير متوفر. يجب استخراج CSID أولاً." });
    return;
  }

  // ZATCA's /production/csids expects the COMPLIANCE `requestID` — NOT the
  // binary CSID token. Prefer the value the client forwarded; otherwise use the
  // one persisted on the company during the /compliance step. Never fall back
  // to the binary token (ZATCA rejects it, surfacing as an opaque failure).
  const requestId = complianceRequestId ?? company.zatcaComplianceRequestId;
  if (!requestId) {
    res.status(400).json({
      error: "معرّف طلب الامتثال غير متوفر. أعد تنفيذ خطوة «استخراج شهادة الامتثال (CSID)» للحصول عليه، ثم استخرج شهادة الإنتاج.",
    });
    return;
  }

  try {
    const env = resolveZatcaEnv(company);
    const baseUrl = getZatcaBaseUrl(env);

    const response = await fetch(`${baseUrl}/production/csids`, {
      method: "POST",
      headers: {
        "Accept-Version": "V2",
        "Accept-Language": "en",
        "Authorization": basicAuth(company.zatcaCsidToken, company.zatcaCsidSecret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ compliance_request_id: requestId }),
    });

    // ZATCA may return a non-JSON body (e.g. an HTML 404 page from the wrong
    // gateway) — parse defensively so a bad body surfaces the real status +
    // raw text instead of throwing an opaque 500 in the catch below.
    const rawBody = await response.text();
    let data: {
      requestID?: string;
      dispositionMessage?: string;
      binarySecurityToken?: string;
      secret?: string;
      errors?: unknown;
      raw?: string;
    } = {};
    try { data = rawBody ? JSON.parse(rawBody) : {}; } catch { data = { raw: rawBody }; }

    if (!response.ok) {
      req.log.warn(
        { companyId: id, status: response.status, environment: env, endpoint: `${baseUrl}/production/csids`, zatcaResponse: data },
        "ZATCA production-csid request rejected",
      );
      res.status(response.status).json({
        error: "فشل استدعاء ZATCA Production CSID API",
        zatcaStatus: response.status,
        environment: env,
        zatcaResponse: data,
      });
      return;
    }

    await db.update(companiesTable).set({
      zatcaPcsid: data.binarySecurityToken ?? null,
      zatcaPcsidToken: data.binarySecurityToken ?? null,
      zatcaPcsidSecret: data.secret ?? null,
      updatedAt: new Date(),
    }).where(eq(companiesTable.id, id));

    res.json({
      success: true,
      requestID: data.requestID,
      dispositionMessage: data.dispositionMessage,
      message: "تم الحصول على PCSID بنجاح. الشركة مرتبطة بالكامل ببيئة الإنتاج.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ companyId: id, err: message }, "ZATCA production-csid threw");
    res.status(500).json({ error: "فشل الاتصال بـ ZATCA", details: message });
  }
});

// ─── 3.5 Compliance Check — فاتورة تجريبية ──────────────────────────────────
// يُستخدم للتحقق من صحة الفاتورة مقابل شهادة الامتثال CSID قبل الانتقال للإنتاج
router.post("/companies/:id/compliance-check", requirePermission("zatca_setup", "create"), audit("zatca_setup", "create"), async (req, res) => {
  const id = parseInt(req.params.id);
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, id));
  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }

  if (!company.zatcaCsidToken || !company.zatcaCsidSecret) {
    res.status(400).json({
      error: "CSID غير متوفر. يجب الحصول على CSID أولاً قبل إجراء الفحص التجريبي.",
      hint: "أكمل الخطوة 2 (الشهادة الأولية) أولاً."
    });
    return;
  }

  if (!company.zatcaPrivateKey) {
    res.status(400).json({
      error: "المفتاح الخاص غير متوفر. لا يمكن توقيع الفاتورة التجريبية.",
      hint: "أعد توليد CSR والحصول على CSID — يتم حفظ المفتاح الخاص مع الشهادة.",
    });
    return;
  }

  const { invoiceId } = req.body as { invoiceId?: number };
  if (!invoiceId) {
    res.status(400).json({ error: "invoiceId مطلوب — أدخل رقم فاتورة لاختبارها." });
    return;
  }

  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  if (!invoice || invoice.companyId !== id) {
    res.status(404).json({ error: "الفاتورة غير موجودة أو لا تنتمي لهذه الشركة." });
    return;
  }

  try {
    const env = resolveZatcaEnv(company);
    const baseUrl = getZatcaBaseUrl(env);

    // REBUILD + SIGN the document from the invoice's authoritative data using the
    // CSID (compliance) certificate — never trust a previously stored xmlContent,
    // which may be a Phase-1 / unsigned / wrong-certificate document. The hash is
    // computed over the empty-QR UBL exactly as ZATCA recomputes it (the old code
    // hashed the QR-containing string → invalid-invoice-hash).
    const lineItems = await db.select().from(invoiceLineItemsTable)
      .where(eq(invoiceLineItemsTable.invoiceId, invoice.id));
    const [customer] = invoice.customerId
      ? await db.select().from(customersTable).where(eq(customersTable.id, invoice.customerId))
      : [null];

    const now = new Date();
    const issueTime = now.toTimeString().split(" ")[0];
    const built = buildSignedZatcaInvoice({
      invoiceData: invoiceRowToZatcaData(invoice, lineItems, company, customer ?? null, {
        invoiceCounterValue: invoice.invoiceCounterValue ?? 1,
        previousInvoiceHash: invoice.previousInvoiceHash ?? GENESIS_HASH,
        issueTime,
      }),
      certificatePem: company.zatcaCsidToken,
      privateKeyPem: company.zatcaPrivateKey,
      seller: { nameAr: company.nameAr ?? "", vatNumber: company.vatNumber ?? "" },
      qr: {
        invoiceTimestamp: `${invoice.issueDate}T${issueTime}Z`,
        invoiceTotal: invoice.grandTotal,
        vatAmount: invoice.vatTotal,
      },
    });
    const xmlBase64 = Buffer.from(built.finalXml).toString("base64");
    const hashBase64 = built.invoiceHash;

    // ZATCA exposes ONE compliance-invoice endpoint for BOTH standard (clearance)
    // and simplified (reporting) documents — it auto-detects the flow from the
    // InvoiceTypeCode inside the XML. The split .../clearance/single and
    // .../reporting/single paths only exist for LIVE invoices, not compliance;
    // hitting them during onboarding returns 404 and compliance never completes.
    const endpoint = `${baseUrl}/compliance/invoices`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Accept-Version": "V2",
        "Accept-Language": "en",
        "Authorization": `Basic ${Buffer.from(`${company.zatcaCsidToken}:${company.zatcaCsidSecret}`).toString("base64")}`,
        "Clearance-Status": invoice.invoiceType === "standard" ? "1" : "0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        invoiceHash: hashBase64,
        uuid: invoice.invoiceNumber,
        invoice: xmlBase64,
      }),
    });

    const data = await response.json() as {
      validationResults?: {
        infoMessages?: Array<{ code: string; message: string }>;
        warningMessages?: Array<{ code: string; message: string }>;
        errorMessages?: Array<{ code: string; message: string }>;
        status?: string;
      };
      reportingStatus?: string;
      clearanceStatus?: string;
    };

    if (!response.ok) {
      // Mirror the /compliance route's logging so a gateway-level rejection
      // (404/401/403) is diagnosable from deployment logs instead of being
      // swallowed behind a generic "فشل الفحص".
      req.log.warn(
        {
          companyId: id, invoiceId, invoiceType: invoice.invoiceType,
          status: response.status, environment: env,
          endpoint, zatcaResponse: data,
        },
        "ZATCA compliance-check rejected",
      );
      // A 404/401/403 from the gateway is NOT an invoice-validation failure —
      // ZATCA never even validated the document. It almost always means the
      // CSID/onboarding environment doesn't match the active "وضع الربط".
      const isGatewayError = response.status === 404 || response.status === 401 || response.status === 403;
      const envAr = envArabic[env];
      res.status(response.status).json({
        success: false,
        complianceCheck: false,
        zatcaStatus: response.status,
        environment: env,
        endpoint,
        zatcaResponse: data,
        hint: isGatewayError
          ? `رفضت بوابة ZATCA الطلب (رمز ${response.status}) قبل التحقق من الفاتورة. تأكد أن وضع الربط الحالي (${envAr}) مطابق للبيئة التي حصلت منها على شهادة CSID — يجب أن يتم الإعداد (CSR + CSID) والفحص التجريبي على نفس البيئة.`
          : "الفاتورة التجريبية فشلت في التحقق. راجع رسائل الخطأ وصحح البيانات قبل الانتقال للإنتاج.",
      });
      return;
    }

    res.json({
      success: true,
      complianceCheck: true,
      validationResults: data.validationResults,
      status: data.clearanceStatus ?? data.reportingStatus,
      message: "اجتازت الفاتورة التجريبية فحص الامتثال بنجاح. يمكنك الآن طلب شهادة الإنتاج (PCSID).",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "فشل الاتصال بـ ZATCA", details: message });
  }
});

// ─── 3b. Automated Compliance Check (one-click sample-document submission) ─────
// ZATCA only authorises a Production CSID after the EGS submits + passes the full
// set of sample documents matching the certificate's registered invoice type
// (invoice/credit/debit × standard/simplified). This route builds, signs, and
// submits every required sample in one server-side pass so the operator does not
// have to hand-craft them. Sample documents are synthetic — never persisted.
router.post("/companies/:id/auto-compliance-check", requirePermission("zatca_setup", "create"), audit("zatca_setup", "create"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "معرف الشركة غير صالح" });
    return;
  }

  // Tenant scope: this endpoint triggers live ZATCA submissions using the
  // target company's certificate, so a non-superadmin must only ever act on
  // their OWN company. resolveCompanyId returns the user's companyId (or, for a
  // superadmin, the deliberately-addressed acting/impersonated tenant). Block
  // any attempt to target a different company id (cross-tenant IDOR).
  const scopedCompanyId = resolveCompanyId(req);
  if (req.authUser?.role !== "superadmin" && scopedCompanyId !== id) {
    res.status(403).json({ error: "لا يمكنك تشغيل الفحص التجريبي لشركة أخرى." });
    return;
  }

  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, id));
  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }

  if (!company.zatcaCsidToken || !company.zatcaCsidSecret || !company.zatcaPrivateKey) {
    res.status(400).json({
      error: "CSID أو المفتاح الخاص غير متوفر. أكمل الخطوة 2 (الشهادة الأولية CSID) أولاً.",
      hint: "يجب توليد CSR والحصول على CSID قبل تشغيل الفحص التجريبي التلقائي.",
    });
    return;
  }

  const env = resolveZatcaEnv(company);
  // The compliance chain runs on ALL environments INCLUDING production — obtaining
  // a real Production CSID REQUIRES passing the compliance check on the production
  // gateway first. (This was previously blocked for production, which made it
  // impossible to onboard a live company and produced the 401 at /production/csids.)

  try {
    const baseUrl = getZatcaBaseUrl(env);
    const { allPassed, results } = await runAutoComplianceCheck({
      company,
      baseUrl,
      log: req.log,
    });

    res.status(allPassed ? 200 : 422).json({
      success: allPassed,
      environment: env,
      allPassed,
      results,
      message: allPassed
        ? "اجتازت جميع المستندات التجريبية فحص الامتثال بنجاح. يمكنك الآن طلب شهادة الإنتاج (PCSID) في الخطوة 4."
        : "فشل أحد المستندات التجريبية أو أكثر في فحص الامتثال. راجع تفاصيل كل مستند أدناه وصحّح الأخطاء قبل المتابعة.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.warn({ companyId: id, environment: env, err: message }, "auto-compliance-check failed");
    res.status(500).json({ error: "فشل تشغيل الفحص التجريبي التلقائي", details: message });
  }
});

// ─── 4. Submit Invoice to ZATCA ───────────────────────────────────────────────
router.post("/invoices/:id/submit", requirePermission("zatca_bridge", "create"), audit("zatca_bridge", "create"), async (req, res) => {
  const id = parseInt(req.params.id);

  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  if (invoice.status !== "issued") {
    res.status(400).json({ error: "يجب إصدار الفاتورة أولاً قبل إرسالها لـ ZATCA" });
    return;
  }

  const [company] = invoice.companyId
    ? await db.select().from(companiesTable).where(eq(companiesTable.id, invoice.companyId))
    : [null];

  if (!company) {
    res.status(400).json({ error: "الشركة غير موجودة" });
    return;
  }

  const authToken = company.zatcaPcsidToken ?? company.zatcaCsidToken;
  const authSecret = company.zatcaPcsidSecret ?? company.zatcaCsidSecret;

  if (!authToken || !authSecret) {
    res.status(400).json({
      error: "لا توجد شهادة ZATCA. يجب استخراج CSID أو PCSID أولاً.",
      hint: "اذهب لصفحة الشركة → تبويب الشهادة → استخراج CSID",
    });
    return;
  }

  if (!company.zatcaPrivateKey) {
    res.status(400).json({
      error: "المفتاح الخاص غير متوفر. لا يمكن توقيع الفاتورة.",
      hint: "أعد توليد CSR والحصول على الشهادة (CSID/PCSID).",
    });
    return;
  }

  try {
    const env = resolveZatcaEnv(company);
    const baseUrl = getZatcaBaseUrl(env);

    // REBUILD + SIGN from authoritative invoice data using the live certificate
    // (PCSID when available, else CSID). The signed finalXml + empty-QR hash are
    // what ZATCA recomputes — never re-hash a stored QR-containing string.
    const lineItems = await db.select().from(invoiceLineItemsTable)
      .where(eq(invoiceLineItemsTable.invoiceId, invoice.id));
    const [customer] = invoice.customerId
      ? await db.select().from(customersTable).where(eq(customersTable.id, invoice.customerId))
      : [null];

    const now = new Date();
    const issueTime = now.toTimeString().split(" ")[0];
    const built = buildSignedZatcaInvoice({
      invoiceData: invoiceRowToZatcaData(invoice, lineItems, company, customer ?? null, {
        invoiceCounterValue: invoice.invoiceCounterValue ?? 1,
        previousInvoiceHash: invoice.previousInvoiceHash ?? GENESIS_HASH,
        issueTime,
      }),
      certificatePem: authToken,
      privateKeyPem: company.zatcaPrivateKey,
      seller: { nameAr: company.nameAr ?? "", vatNumber: company.vatNumber ?? "" },
      qr: {
        invoiceTimestamp: `${invoice.issueDate}T${issueTime}Z`,
        invoiceTotal: invoice.grandTotal,
        vatAmount: invoice.vatTotal,
      },
    });
    const xmlBase64 = Buffer.from(built.finalXml).toString("base64");
    const hashBase64 = built.invoiceHash;

    const endpoint = invoice.invoiceType === "simplified"
      ? `${baseUrl}/invoices/reporting/single`
      : `${baseUrl}/invoices/clearance/single`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Accept-Version": "V2",
        "Accept-Language": "en",
        "Authorization": basicAuth(authToken, authSecret),
        "Clearance-Status": invoice.invoiceType === "standard" ? "1" : "0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        invoiceHash: hashBase64,
        uuid: invoice.invoiceNumber,
        invoice: xmlBase64,
      }),
    });

    const data = await response.json() as {
      reportingStatus?: string;
      clearanceStatus?: string;
      warningMessages?: Array<{ code: string; message: string }>;
      errorMessages?: Array<{ code: string; message: string }>;
      clearedInvoice?: string;
    };

    // The verdict must come from ZATCA's actual document status, NOT just an
    // HTTP 200. ZATCA can return 200 with clearanceStatus=NOT_CLEARED or a
    // reportingStatus other than REPORTED — treating that as success would
    // produce a false "معتمدة". Only CLEARED / REPORTED(_WITH_WARNINGS) pass.
    const clearance = (data.clearanceStatus ?? "").toUpperCase();
    const reporting = (data.reportingStatus ?? "").toUpperCase();
    const accepted = invoice.invoiceType === "simplified"
      ? reporting === "REPORTED" || reporting === "REPORTED_WITH_WARNINGS"
      : clearance === "CLEARED";
    const succeeded = response.ok && accepted;
    const newStatus = succeeded
      ? (invoice.invoiceType === "simplified" ? "reported" : "cleared")
      : "rejected";

    await db.update(invoicesTable).set({
      zatcaStatus: newStatus,
      zatcaResponseCode: String(response.status),
      zatcaWarningMessages: data.warningMessages ? JSON.stringify(data.warningMessages) : null,
      zatcaErrorMessages: data.errorMessages ? JSON.stringify(data.errorMessages) : null,
      zatcaClearanceStatus: data.clearanceStatus ?? data.reportingStatus ?? null,
      updatedAt: new Date(),
    }).where(eq(invoicesTable.id, id));

    if (!succeeded) {
      res.status(response.ok ? 422 : response.status).json({
        success: false,
        zatcaStatus: newStatus,
        clearanceStatus: data.clearanceStatus,
        reportingStatus: data.reportingStatus,
        zatcaResponse: data,
        hint: response.ok
          ? "قبلت بوابة ZATCA الطلب لكن لم يتم تخليص/إبلاغ الفاتورة. راجع رسائل التحقق وصحّح البيانات."
          : "راجع رسائل الخطأ من ZATCA وتحقق من صحة بيانات الفاتورة.",
      });
      return;
    }

    res.json({
      success: true,
      zatcaStatus: newStatus,
      clearanceStatus: data.clearanceStatus,
      reportingStatus: data.reportingStatus,
      warningMessages: data.warningMessages ?? [],
      message: invoice.invoiceType === "simplified"
        ? "تم إبلاغ ZATCA بالفاتورة المبسطة بنجاح."
        : "تم تخليص الفاتورة الضريبية بنجاح.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "فشل الاتصال بـ ZATCA", details: message });
  }
});

export default router;
