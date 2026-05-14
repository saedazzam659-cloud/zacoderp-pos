/**
 * Phase 1B.3 — XAdES-BES signer for ZATCA UBL invoices.
 *
 * Implements the ZATCA-mandated subset of XAdES-BES required by section 6
 * of the "Detailed Guidelines for E-invoicing Implementation":
 *   • Reference#0 — over the invoice document with all transforms (ZATCA's
 *     6 enveloped signature transforms + canonicalization)
 *   • Reference#1 — over the QualifyingProperties/SignedProperties block
 *   • SignatureValue — ECDSA-SHA256 over SignedInfo (canonical form)
 *   • KeyInfo / X509Data — base64 of the certificate body
 *   • SignedSignatureProperties — SigningTime + SigningCertificate digest
 *
 * Inputs: the canonical ZATCA UBL XML (with UBLExtensions placeholders),
 * the certificate PEM, and the EC private key PEM.
 *
 * Output: same XML with the UBLExtensions block populated. Caller flips
 * `isSigned: true` when calling submitToZatca, which lets the production
 * endpoint accept it.
 *
 * Important caveats (documented for the on-call engineer):
 *  1. ZATCA expects a very specific canonicalization order. We use
 *     C14N 1.1 over the canonical UBL XML which works for the common
 *     case. Edge cases involving namespace prefixes inside extension
 *     elements may need additional treatment.
 *  2. The signature itself uses the JWS-style P1363 fixed-length encoding
 *     (ECDSA r||s, 64 bytes for P-256). Node's crypto.sign returns DER —
 *     we convert.
 *  3. The certificate digest is sha256 of the DER bytes.
 */
import { createSign, createHash, createPrivateKey, type KeyObject } from "crypto";
import forge from "node-forge";

export interface SignXadesInput {
  ublXml: string;          // unsigned UBL with placeholder UBLExtensions
  certificatePem: string;  // the CSID/PCSID certificate
  privateKeyPem: string;   // EC private key matching the certificate
  invoiceHash: string;     // base64 sha256 of canonical UBL (caller computed)
}

export interface SignXadesResult {
  signedXml: string;
  signatureValueB64: string;
  signedPropertiesHashB64: string;
}

/**
 * Sign the UBL invoice and embed XAdES-BES into UBLExtensions.
 *
 * @throws if the private key can't be parsed or the XML doesn't contain
 *         the expected UBLExtensions placeholder.
 */
export function signZatcaUbl(input: SignXadesInput): SignXadesResult {
  const { ublXml, certificatePem, privateKeyPem, invoiceHash } = input;

  // 1. Strip cert headers, get DER, derive cert digest (base64 of sha256 hex
  //    bytes per ZATCA spec — yes, hex string then sha256, then base64).
  const certBody = certificatePem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!certBody) throw new Error("certificate is empty after PEM strip");

  // ZATCA's quirky cert-digest rule: digest the *hex of the cert bytes* as ASCII.
  const certBytes = Buffer.from(certBody, "base64");
  const certHexAscii = certBytes.toString("hex");
  const certDigestB64 = createHash("sha256").update(certHexAscii, "utf8").digest("base64");

  // 2. Parse cert subject + issuer + serial from PEM. We do a minimal ASN.1
  //    walk just for the issuer Name and serialNumber — the rest of the
  //    KeyInfo only needs the base64 cert body itself.
  const { issuerName, serialNumber } = parseCertIssuerSerial(certBytes);

  // 3. Build SignedProperties XML, hash it, embed.
  const signingTime = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const signedProps = buildSignedProperties({
    signingTime,
    certDigestB64,
    issuerName,
    serialNumber,
  });
  const signedPropsHashB64 = createHash("sha256")
    .update(signedProps, "utf8")
    .digest("base64");

  // 4. Build SignedInfo over (a) invoice digest + (b) signed-properties digest.
  const signedInfo = buildSignedInfo({ invoiceHashB64: invoiceHash, signedPropsHashB64 });

  // 5. Sign SignedInfo with ECDSA-SHA256 (P1363 / fixed-length encoding).
  let key: KeyObject;
  try { key = createPrivateKey(privateKeyPem); }
  catch (e) { throw new Error(`invalid EC private key: ${e instanceof Error ? e.message : String(e)}`); }

  const signer = createSign("SHA256");
  signer.update(signedInfo, "utf8");
  signer.end();
  const sigDer = signer.sign({ key, dsaEncoding: "ieee-p1363" });
  const signatureValueB64 = sigDer.toString("base64");

  // 6. Compose the UBLExtensions block and inject.
  const ext = buildUblExtensionsBlock({
    signedInfo, signatureValueB64,
    certBodyB64: certBody, signedProperties: signedProps,
  });
  const PLACEHOLDER_RE = /<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/;
  if (!PLACEHOLDER_RE.test(ublXml)) {
    throw new Error("UBL XML missing <ext:UBLExtensions> placeholder block");
  }
  const signedXml = ublXml.replace(PLACEHOLDER_RE, ext);

  return { signedXml, signatureValueB64, signedPropertiesHashB64: signedPropsHashB64 };
}

function buildSignedInfo(opts: { invoiceHashB64: string; signedPropsHashB64: string }): string {
  return `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
<ds:Reference Id="invoiceSignedData" URI="">
<ds:Transforms>
<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
<ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
</ds:Transform>
<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
<ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
</ds:Transform>
<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
<ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
</ds:Transform>
<ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
</ds:Transforms>
<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
<ds:DigestValue>${opts.invoiceHashB64}</ds:DigestValue>
</ds:Reference>
<ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
<ds:DigestValue>${opts.signedPropsHashB64}</ds:DigestValue>
</ds:Reference>
</ds:SignedInfo>`;
}

function buildSignedProperties(opts: {
  signingTime: string; certDigestB64: string;
  issuerName: string; serialNumber: string;
}): string {
  return `<xades:SignedProperties Id="xadesSignedProperties" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">
<xades:SignedSignatureProperties>
<xades:SigningTime>${opts.signingTime}</xades:SigningTime>
<xades:SigningCertificate>
<xades:Cert>
<xades:CertDigest>
<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/>
<ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${opts.certDigestB64}</ds:DigestValue>
</xades:CertDigest>
<xades:IssuerSerial>
<ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${escapeXml(opts.issuerName)}</ds:X509IssuerName>
<ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${opts.serialNumber}</ds:X509SerialNumber>
</xades:IssuerSerial>
</xades:Cert>
</xades:SigningCertificate>
</xades:SignedSignatureProperties>
</xades:SignedProperties>`;
}

function buildUblExtensionsBlock(opts: {
  signedInfo: string; signatureValueB64: string;
  certBodyB64: string; signedProperties: string;
}): string {
  return `<ext:UBLExtensions xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
<ext:UBLExtension>
<ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
<ext:ExtensionContent>
<sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">
<sac:SignatureInformation>
<cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">urn:oasis:names:specification:ubl:signature:1</cbc:ID>
<sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
<ds:Signature Id="signature" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
${opts.signedInfo}
<ds:SignatureValue>${opts.signatureValueB64}</ds:SignatureValue>
<ds:KeyInfo>
<ds:X509Data>
<ds:X509Certificate>${opts.certBodyB64}</ds:X509Certificate>
</ds:X509Data>
</ds:KeyInfo>
<ds:Object>
<xades:QualifyingProperties Target="signature" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">
${opts.signedProperties}
</xades:QualifyingProperties>
</ds:Object>
</ds:Signature>
</sac:SignatureInformation>
</sig:UBLDocumentSignatures>
</ext:ExtensionContent>
</ext:UBLExtension>
</ext:UBLExtensions>`;
}

// Phase 1B.3.1 — full X.509 ASN.1 parsing via node-forge.
//
// Extracts the certificate's Issuer Distinguished Name (RFC 4514 form,
// e.g. "CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local") and the
// integer serial number. ZATCA validates these against the CA registry,
// so they MUST match the bytes inside the DER — synthetic placeholders
// would cause production submissions to be rejected with
// "IssuerSerial mismatch".
//
// RFC 4514 attribute-type ordering is most-significant-first (CN first,
// C last). forge gives us the parsed Name with the original ordering,
// which we reverse so the output matches xmlsec / openssl conventions.
function parseCertIssuerSerial(der: Buffer): { issuerName: string; serialNumber: string } {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(der.toString("binary")));
  const cert = forge.pki.certificateFromAsn1(asn1);

  // forge stores attributes in the order they appear in the DER (which is
  // CA-down to CN — the opposite of RFC 4514). Reverse for the canonical
  // string.
  const shortMap: Record<string, string> = {
    "2.5.4.3":  "CN",  // commonName
    "2.5.4.6":  "C",   // countryName
    "2.5.4.7":  "L",   // localityName
    "2.5.4.8":  "ST",  // stateOrProvinceName
    "2.5.4.10": "O",   // organizationName
    "2.5.4.11": "OU",  // organizationalUnitName
    "0.9.2342.19200300.100.1.25": "DC", // domainComponent
    "1.2.840.113549.1.9.1":       "E",  // emailAddress
  };
  const parts: string[] = [];
  for (const a of cert.issuer.attributes) {
    const name = shortMap[a.type ?? ""] ?? a.shortName ?? a.name ?? a.type ?? "";
    const value = String(a.value ?? "");
    // RFC 4514 quoting: escape ',', '+', '"', '\', '<', '>', ';', leading '#' or ' ', trailing ' '.
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/,/g, "\\,")
      .replace(/\+/g, "\\+")
      .replace(/"/g, "\\\"")
      .replace(/</g, "\\<")
      .replace(/>/g, "\\>")
      .replace(/;/g, "\\;")
      .replace(/^ /, "\\ ")
      .replace(/^#/, "\\#")
      .replace(/ $/, "\\ ");
    parts.push(`${name}=${escaped}`);
  }
  const issuerName = parts.reverse().join(", ");

  // forge gives serialNumber as a hex string (no 0x prefix). ZATCA's
  // ds:X509SerialNumber must be the decimal big-integer form.
  const serialHex = (cert.serialNumber || "").replace(/^0+/, "") || "0";
  const serialNumber = BigInt("0x" + serialHex).toString(10);

  return { issuerName, serialNumber };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
