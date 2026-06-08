/**
 * Automated ZATCA compliance-check orchestrator.
 *
 * ZATCA only authorises a Production CSID (PCSID) after the EGS has submitted —
 * and passed — the FULL set of sample documents that match the certificate's
 * registered invoice type. For `invoiceType = "both"` that is SIX documents:
 *   standard  invoice (388) / credit note (381) / debit note (383)  → clearance
 *   simplified invoice (388) / credit note (381) / debit note (383) → reporting
 *
 * If any required type is skipped, ZATCA never marks compliance complete and the
 * /production/csids call keeps returning 401. This module builds, signs, and
 * submits every required sample document in one server-side pass so the operator
 * can complete onboarding with a single click.
 *
 * The signing + hashing convention mirrors the proven offline POS register
 * pipeline: generate UBL with an EMPTY QR placeholder, hash the whole string
 * (DigestValue), XAdES-sign, then inject the Phase-2 (cryptographic-stamp) QR
 * into the empty placeholder. The QR is excluded from the signed digest, so
 * injecting it after signing does not invalidate the signature.
 */
import { randomUUID } from "crypto";
import { buildSignedZatcaInvoice } from "./zatca-build-signed.js";

// ZATCA's documented genesis Previous-Invoice-Hash (base64 of the SHA256 of "0").
const GENESIS_HASH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZmNTI5OWIxNmI2ZjRiMmUyNjY5MDkwMzBiMzdhZGZiMzU3NGI0OTJiNA==";

/** Subset of the companies row this module needs. */
export interface ComplianceCompany {
  nameAr: string;
  nameEn?: string | null;
  vatNumber: string;
  crNumber: string;
  city: string;
  district?: string | null;
  street: string;
  buildingNumber: string;
  postalCode: string;
  country?: string | null;
  invoiceType?: string | null;
  zatcaPrivateKey?: string | null;
  zatcaCsidToken?: string | null;
  zatcaCsidSecret?: string | null;
}

type DocumentType = "invoice" | "credit" | "debit";
type Flow = "standard" | "simplified";

export interface ComplianceDocResult {
  flow: Flow;
  documentType: DocumentType;
  invoiceNumber: string;
  ok: boolean;
  httpStatus: number;
  status?: string;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  note?: string;
}

export interface AutoComplianceResult {
  allPassed: boolean;
  results: ComplianceDocResult[];
}

interface MinimalLogger {
  warn: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/** Which sample documents are required for the company's registered invoice type. */
function buildDocSet(invoiceType: string): Array<{ flow: Flow; documentType: DocumentType; invoiceNumber: string }> {
  const flows: Flow[] =
    invoiceType === "standard" ? ["standard"]
    : invoiceType === "simplified" ? ["simplified"]
    : ["standard", "simplified"];

  const docs: Array<{ flow: Flow; documentType: DocumentType; invoiceNumber: string }> = [];
  for (const flow of flows) {
    const p = flow === "standard" ? "STD" : "SIM";
    docs.push({ flow, documentType: "invoice", invoiceNumber: `COMP-${p}-INV-001` });
    docs.push({ flow, documentType: "credit", invoiceNumber: `COMP-${p}-CN-001` });
    docs.push({ flow, documentType: "debit", invoiceNumber: `COMP-${p}-DN-001` });
  }
  return docs;
}

export async function runAutoComplianceCheck(args: {
  company: ComplianceCompany;
  baseUrl: string;
  log?: MinimalLogger;
}): Promise<AutoComplianceResult> {
  const { company, baseUrl, log } = args;

  const privateKeyPem = company.zatcaPrivateKey;
  const certBody = company.zatcaCsidToken;
  const csidSecret = company.zatcaCsidSecret;
  if (!privateKeyPem || !certBody || !csidSecret) {
    throw new Error("CSID token / secret / private key missing — complete the CSID step first.");
  }

  const authHeader = `Basic ${Buffer.from(`${certBody}:${csidSecret}`).toString("base64")}`;

  const now = new Date();
  const issueDate = now.toISOString().split("T")[0] ?? "1970-01-01";
  const issueTime = now.toISOString().split("T")[1]?.split(".")[0] ?? "00:00:00";

  const companyForXml = {
    nameAr: company.nameAr,
    nameEn: company.nameEn ?? null,
    vatNumber: company.vatNumber,
    crNumber: company.crNumber,
    street: company.street,
    buildingNumber: company.buildingNumber,
    city: company.city,
    district: company.district ?? null,
    postalCode: company.postalCode,
    country: company.country ?? "SA",
  };

  const docs = buildDocSet(company.invoiceType ?? "both");
  const results: ComplianceDocResult[] = [];
  let prevHash = GENESIS_HASH;
  let icv = 1;
  let allPassed = true;

  for (const doc of docs) {
    const uuid = randomUUID();
    const lineItems = [{
      id: 1,
      description: "صنف امتثال تجريبي",
      quantity: "1",
      unitCode: "PCE",
      unitPrice: "100.00",
      discountAmount: "0.00",
      taxCategory: "S",
      vatRate: "15",
      vatAmount: "15.00",
      subtotal: "100.00",
      total: "115.00",
    }];

    // Standard (B2B/clearance) documents require a buyer with a VAT number +
    // address. Simplified (B2C/reporting) documents do not.
    const customer = doc.flow === "standard" ? {
      nameAr: "عميل امتثال تجريبي",
      vatNumber: "399999999900003",
      crNumber: null,
      street: "الرياض",
      buildingNumber: "1111",
      city: "الرياض",
      district: null,
      postalCode: "12345",
      country: "SA",
    } : null;

    const prefix = doc.flow === "standard" ? "STD" : "SIM";
    const billingReferenceId =
      doc.documentType !== "invoice" ? `COMP-${prefix}-INV-001` : null;

    const { finalXml, invoiceHash } = buildSignedZatcaInvoice({
      invoiceData: {
        invoiceNumber: doc.invoiceNumber,
        uuid,
        invoiceType: doc.flow,
        documentType: doc.documentType,
        billingReferenceId,
        instructionNote: doc.documentType !== "invoice" ? "تصحيح فاتورة الامتثال التجريبية" : null,
        issueDate,
        issueTime,
        supplyDate: issueDate,
        currency: "SAR",
        paymentMethod: "10",
        subtotal: "100.00",
        discountTotal: "0.00",
        vatTotal: "15.00",
        grandTotal: "115.00",
        notes: "مستند امتثال تجريبي مُولّد تلقائياً",
        invoiceCounterValue: icv,
        previousInvoiceHash: prevHash,
        lineItems,
        company: companyForXml,
        customer,
      },
      certificatePem: certBody,
      privateKeyPem,
      seller: { nameAr: company.nameAr, vatNumber: company.vatNumber },
      qr: {
        invoiceTimestamp: `${issueDate}T${issueTime}Z`,
        invoiceTotal: "115.00",
        vatAmount: "15.00",
      },
    });

    // Single compliance-invoice endpoint for every flow (see routes/zatca.ts).
    // The .../clearance/single and .../reporting/single paths are LIVE-invoice
    // only and 404 during onboarding, so compliance never completes.
    const endpoint = `${baseUrl}/compliance/invoices`;

    const result: ComplianceDocResult = {
      flow: doc.flow,
      documentType: doc.documentType,
      invoiceNumber: doc.invoiceNumber,
      ok: false,
      httpStatus: 0,
      errors: [],
      warnings: [],
    };

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Accept-Version": "V2",
          "Accept-Language": "en",
          "Authorization": authHeader,
          "Clearance-Status": doc.flow === "standard" ? "1" : "0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          invoiceHash,
          uuid,
          invoice: Buffer.from(finalXml).toString("base64"),
        }),
      });

      result.httpStatus = resp.status;
      const data = await resp.json().catch(() => ({})) as {
        validationResults?: {
          errorMessages?: Array<{ code: string; message: string }>;
          warningMessages?: Array<{ code: string; message: string }>;
          status?: string;
        };
        clearanceStatus?: string;
        reportingStatus?: string;
      };
      const vr = data.validationResults ?? {};
      result.errors = vr.errorMessages ?? [];
      result.warnings = vr.warningMessages ?? [];
      result.status = data.clearanceStatus ?? data.reportingStatus ?? vr.status;
      // Pass = gateway accepted (2xx) AND no blocking validation errors. Warnings
      // (e.g. PIH chain notes on synthetic samples) do not block compliance.
      result.ok = resp.ok && result.errors.length === 0;

      if (!result.ok) {
        log?.warn?.(
          {
            flow: doc.flow,
            documentType: doc.documentType,
            status: resp.status,
            endpoint,
            zatcaResponse: data,
          },
          "auto-compliance sample document rejected",
        );
      }
    } catch (err) {
      result.note = err instanceof Error ? err.message : String(err);
      log?.warn?.({ flow: doc.flow, documentType: doc.documentType, err: result.note }, "auto-compliance submit threw");
    }

    if (!result.ok) allPassed = false;
    results.push(result);

    // Chain the synthetic PIH from each document's hash to the next.
    prevHash = invoiceHash;
    icv += 1;
  }

  return { allPassed, results };
}
