/**
 * Shared "build a signed, submittable ZATCA invoice" helper.
 *
 * This is the SINGLE source of truth for the ZATCA Phase-2 build sequence used
 * by every real submission path (issue-time storage, manual compliance check,
 * live clearance/reporting, and the sales-invoice bridge). It mirrors the proven
 * offline POS register pipeline:
 *
 *   1. generate UBL with an EMPTY QR placeholder
 *   2. hash the whole empty-QR string  → this is the DigestValue ZATCA recomputes
 *   3. XAdES-sign (the four ds:Reference transforms exclude UBLExtensions /
 *      cac:Signature / the QR AdditionalDocumentReference from the digest)
 *   4. build the Phase-2 (cryptographic-stamp) QR
 *   5. inject the QR into the empty placeholder
 *
 * Because the QR is excluded from the signed digest, injecting it AFTER signing
 * does not invalidate the signature. The naive "hash the raw XML that already
 * contains a Phase-1 QR" approach is exactly what produced `invalid-invoice-hash`.
 */
import { generateZatcaXml, hashXml, type InvoiceData } from "./zatca-xml.js";
import {
  signZatcaUbl,
  certDerFromToken,
  certSignatureFromDer,
  certPublicKeySpkiDer,
} from "./zatca-xades-signer.js";
import { buildPhase2Qr } from "./zatca-tlv.js";

/** Extract the raw certificate signature bytes from the base64 cert body (QR tag 9). */
export function certSignatureDer(certBodyBase64: string): Buffer | null {
  try {
    // Normalize through the shared decoder: the stored value is a ZATCA
    // binarySecurityToken (double base64 over the DER), so a single decode here
    // would feed ASCII base64 text into forge and the parse would fail (silently
    // dropping QR tag 9). certDerFromToken unwraps the extra layer when present.
    const { der } = certDerFromToken(certBodyBase64);
    // ZATCA certs are ECDSA (secp256k1); certSignatureFromDer walks the ASN.1
    // directly instead of forge.pki.certificateFromAsn1, which throws
    // "Cannot read public key. OID is not RSA." on EC certificates.
    return certSignatureFromDer(der);
  } catch {
    return null;
  }
}

/** Inject the Phase-2 QR into the empty QR EmbeddedDocumentBinaryObject placeholder. */
export function injectQr(signedXml: string, qrBase64: string): string {
  const re = /(<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">)(<\/cbc:EmbeddedDocumentBinaryObject>)/;
  if (!re.test(signedXml)) {
    // Fail loudly: a UBL-template change that breaks this placeholder would
    // otherwise silently submit a QR-less document that ZATCA rejects opaquely.
    throw new Error("QR placeholder not found in signed UBL — cannot inject Phase-2 QR");
  }
  return signedXml.replace(re, `$1${qrBase64}$2`);
}

export interface BuildSignedInput {
  /**
   * Full UBL invoice data. Any `qrCode` on it is IGNORED — the helper always
   * builds with an empty QR placeholder, hashes that, then injects the Phase-2 QR.
   */
  invoiceData: Omit<InvoiceData, "qrCode">;
  /** The CSID (compliance) or PCSID (production) certificate body / PEM. */
  certificatePem: string;
  /** EC private key PEM matching the certificate. */
  privateKeyPem: string;
  /** Seller identity for QR tags 1 & 2. */
  seller: { nameAr: string; vatNumber: string };
  /** QR tags 3,4,5 — timestamp + totals (already in SAR base currency). */
  qr: { invoiceTimestamp: string; invoiceTotal: string; vatAmount: string };
}

export interface BuildSignedResult {
  /** Signed UBL with the Phase-2 QR injected. Submit this (base64) to ZATCA. */
  finalXml: string;
  /** base64 sha256 over the empty-QR UBL — the value ZATCA recomputes. Send as `invoiceHash`. */
  invoiceHash: string;
  /** Phase-2 cryptographic-stamp QR (base64 TLV) — for printing/storage. */
  qrBase64: string;
  /** ECDSA signature value (base64) embedded in the XAdES block. */
  signatureValueB64: string;
}

/**
 * Build a fully signed, QR-stamped ZATCA UBL document plus its correct
 * invoice hash, ready to base64-encode and POST to any ZATCA endpoint.
 */
export function buildSignedZatcaInvoice(input: BuildSignedInput): BuildSignedResult {
  const { invoiceData, certificatePem, privateKeyPem, seller, qr } = input;

  // 1. UBL with EMPTY QR placeholder — the QR is excluded from the hash.
  const ublXml = generateZatcaXml({ ...invoiceData, qrCode: "" });
  // 2. Hash the empty-QR UBL — this is the DigestValue ZATCA recomputes.
  const invoiceHash = hashXml(ublXml);
  // 3. XAdES-sign (transforms exclude UBLExtensions / Signature / QR).
  const { signedXml, signatureValueB64 } = signZatcaUbl({
    ublXml,
    certificatePem,
    privateKeyPem,
    invoiceHash,
  });
  // 4. Build the Phase-2 cryptographic-stamp QR.
  const qrBase64 = buildPhase2Qr({
    sellerName: seller.nameAr,
    vatNumber: seller.vatNumber,
    invoiceTimestamp: qr.invoiceTimestamp,
    invoiceTotal: qr.invoiceTotal,
    vatAmount: qr.vatAmount,
    invoiceHashB64: invoiceHash,
    signatureB64: signatureValueB64,
    publicKeyDer: certPublicKeySpkiDer(certificatePem),
    certSignatureDer: certSignatureDer(certificatePem),
  });
  // 5. Inject the QR into the signed XML (safe — QR excluded from the digest).
  const finalXml = injectQr(signedXml, qrBase64);

  return { finalXml, invoiceHash, qrBase64, signatureValueB64 };
}
