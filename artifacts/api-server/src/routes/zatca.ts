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
import { createHash } from "crypto";
import { extractAuth } from "../middleware/auth.js";
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

// ─── Sandbox vs Production base URL ──────────────────────────────────────────
function getZatcaBaseUrl(isSandbox: boolean): string {
  return isSandbox
    ? "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal"
    : "https://gw-fatoora.zatca.gov.sa/e-invoicing/core";
}

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
      isSandbox: company.isSandbox ?? true,
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
    const baseUrl = getZatcaBaseUrl(company.isSandbox ?? true);
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
        { companyId: id, status: response.status, isSandbox: company.isSandbox ?? true, zatcaResponse: data },
        "ZATCA compliance request rejected",
      );
      res.status(response.status).json({
        error: "فشل استدعاء ZATCA Compliance API",
        zatcaResponse: data,
        hint: "تأكد من صحة OTP وأن CSR صالح. OTP صالح لمدة ساعة واحدة فقط.",
      });
      return;
    }

    // Save CSID token and secret
    await db.update(companiesTable).set({
      zatcaCsid: data.binarySecurityToken ?? null,
      zatcaCsidToken: data.binarySecurityToken ?? null,
      zatcaCsidSecret: data.secret ?? null,
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

  try {
    const baseUrl = getZatcaBaseUrl(company.isSandbox ?? true);

    const response = await fetch(`${baseUrl}/production/csids`, {
      method: "POST",
      headers: {
        "Accept-Version": "V2",
        "Accept-Language": "en",
        "Authorization": basicAuth(company.zatcaCsidToken, company.zatcaCsidSecret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ compliance_request_id: complianceRequestId ?? company.zatcaCsidToken }),
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
        { companyId: id, status: response.status, isSandbox: company.isSandbox ?? true, zatcaResponse: data },
        "ZATCA production-csid request rejected",
      );
      res.status(response.status).json({
        error: "فشل استدعاء ZATCA Production CSID API",
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

  if (!invoice.xmlContent) {
    res.status(400).json({ error: "يجب إصدار الفاتورة أولاً لتوليد XML. اذهب لصفحة الفاتورة واضغط 'إصدار واعتماد'." });
    return;
  }

  try {
    const baseUrl = getZatcaBaseUrl(company.isSandbox ?? true);
    const xmlBase64 = Buffer.from(invoice.xmlContent).toString("base64");
    const hashBase64 = hashXml(invoice.xmlContent);

    const endpoint = invoice.invoiceType === "simplified"
      ? `${baseUrl}/compliance/invoices/reporting/single`
      : `${baseUrl}/compliance/invoices/clearance/single`;

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
      res.status(response.status).json({
        success: false,
        complianceCheck: false,
        zatcaResponse: data,
        hint: "الفاتورة التجريبية فشلت في التحقق. راجع رسائل الخطأ وصحح البيانات قبل الانتقال للإنتاج.",
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

  if (!invoice.xmlContent) {
    res.status(400).json({ error: "XML الفاتورة غير موجود. أعد إصدار الفاتورة." });
    return;
  }

  try {
    const baseUrl = getZatcaBaseUrl(company.isSandbox ?? true);
    const xmlBase64 = Buffer.from(invoice.xmlContent).toString("base64");
    const hashBase64 = hashXml(invoice.xmlContent);

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

    const newStatus = response.ok
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

    if (!response.ok) {
      res.status(response.status).json({
        success: false,
        zatcaStatus: newStatus,
        zatcaResponse: data,
        hint: "راجع رسائل الخطأ من ZATCA وتحقق من صحة بيانات الفاتورة.",
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
