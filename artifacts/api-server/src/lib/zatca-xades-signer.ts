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
import { canonicalizeFragment } from "./zatca-c14n.js";

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
/**
 * Recover the raw certificate DER and its canonical single-base64 body from a
 * ZATCA certificate input.
 *
 * ZATCA returns the certificate as a `binarySecurityToken` (stored verbatim in
 * `company.zatcaCsidToken` / `zatcaPcsidToken`). That token carries an EXTRA
 * base64 layer over the DER: decoding it once yields the ASCII base64 cert body
 * (the `<ds:X509Certificate>` value, starting with "MII…"), NOT raw DER. Every
 * X.509 DER document starts with 0x30 (SEQUENCE), so when the first decoded byte
 * is not 0x30 we unwrap the extra layer. Without this, `forge.asn1.fromDer`
 * throws "Unparsed DER bytes remain after ASN.1 parsing" (a 500 before we ever
 * reach ZATCA). Already-PEM/DER inputs are handled transparently too.
 */
export function certDerFromToken(certInput: string): { der: Buffer; bodyB64: string } {
  const stripped = certInput
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  let der = Buffer.from(stripped, "base64");
  if (der[0] !== 0x30) {
    // Unwrap ZATCA's extra base64 layer (binarySecurityToken → cert body).
    der = Buffer.from(der.toString("utf8").trim(), "base64");
  }
  return { der, bodyB64: der.toString("base64") };
}

export function signZatcaUbl(input: SignXadesInput): SignXadesResult {
  const { ublXml, certificatePem, privateKeyPem, invoiceHash } = input;

  // Recover the certificate DER + canonical base64 body. The stored value is a
  // ZATCA binarySecurityToken (double base64 over the DER); certDerFromToken
  // unwraps that layer so the ASN.1 parse and digest operate on real bytes.
  const { der: certBytes, bodyB64: certBody } = certDerFromToken(certificatePem);
  if (!certBody) throw new Error("certificate is empty after PEM strip");

  // ZATCA cert-digest = base64( lower-hex( sha256( base64-cert-body ASCII ) ) ).
  // The hash is taken over the base64 cert STRING (the exact <ds:X509Certificate>
  // text content), NOT the DER; the 64-char hex of that digest is then
  // base64-encoded. (The previous code hashed in the wrong order and over the
  // wrong bytes, so the CertDigest never matched what ZATCA recomputes.)
  const certHashHex = createHash("sha256").update(certBody, "utf8").digest("hex");
  const certDigestB64 = Buffer.from(certHashHex, "utf8").toString("base64");

  // Issuer DN + serial come from the real DER (ZATCA validates them against the
  // CA registry, so they must match the bytes inside the certificate).
  const { issuerName, serialNumber } = parseCertIssuerSerial(certBytes);

  // 3. Build SignedProperties XML, hash it, embed.
  const signingTime = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const signedProps = buildSignedProperties({
    signingTime,
    certDigestB64,
    issuerName,
    serialNumber,
  });
  // Reference#2 ("xadesSignedProperties") DigestValue — hash the CANONICAL form,
  // not the raw template. ZATCA canonicalizes the referenced SignedProperties
  // element in ISOLATION: only the namespaces declared inside the fragment appear
  // (xades on the apex + ds inline on each ds child), NOT the invoice-root ns.
  // Hashing the raw template — or canonicalizing it wrapped in the 9-ns invoice
  // root — is what produced `signed-properties-hashing`.
  const signedPropsHashB64 = createHash("sha256")
    .update(canonicalizeFragment(signedProps, "SignedProperties"), "utf8")
    .digest("base64");

  // 4. Build SignedInfo over (a) invoice digest + (b) signed-properties digest.
  const signedInfo = buildSignedInfo({ invoiceHashB64: invoiceHash, signedPropsHashB64 });

  // 5. Sign SignedInfo with ECDSA-SHA256 (P1363 / fixed-length encoding).
  //    The SignatureValue must be computed over the CANONICAL SignedInfo
  //    (CanonicalizationMethod = c14n11) canonicalized as a self-contained
  //    element — only its own xmlns:ds apex declaration appears — NOT the raw
  //    template. (The separate `signature-method`/BR-KSA-30 rejection was the
  //    missing cac:Signature block, now added in zatca-xml.ts.)
  const canonicalSignedInfo = canonicalizeFragment(signedInfo, "SignedInfo");
  let key: KeyObject;
  try { key = createPrivateKey(privateKeyPem); }
  catch (e) { throw new Error(`invalid EC private key: ${e instanceof Error ? e.message : String(e)}`); }

  const signer = createSign("SHA256");
  signer.update(canonicalSignedInfo, "utf8");
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
  // ZATCA certificates are ECDSA (secp256k1). forge.pki.certificateFromAsn1
  // tries to read the SubjectPublicKeyInfo as RSA and throws "Cannot read
  // public key. OID is not RSA." on EC keys, so we walk the TBSCertificate
  // ASN.1 directly and pull out ONLY the issuer Name + serialNumber (the public
  // key is never needed here).
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(der.toString("binary")));
  const tbsItems = (asn1.value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];

  // TBSCertificate ::= SEQUENCE { version [0] EXPLICIT (optional), serialNumber
  // INTEGER, signature AlgorithmIdentifier, issuer Name, validity, subject, … }.
  // The version tag is [0] context-specific; when present everything shifts +1.
  let idx = 0;
  const firstItem = tbsItems[0];
  if (firstItem.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && firstItem.type === 0) {
    idx = 1;
  }
  const serialAsn1 = tbsItems[idx];
  const issuerAsn1 = tbsItems[idx + 2]; // skip serialNumber (idx) + signatureAlg (idx+1)
  // RDNAttributesAsArray exists at runtime but is missing from @types/node-forge.
  const attributes = (
    forge.pki as unknown as {
      RDNAttributesAsArray(rdn: forge.asn1.Asn1): forge.pki.CertificateField[];
    }
  ).RDNAttributesAsArray(issuerAsn1);

  // RDNs come out in DER order (CA-general first, CN last). Reverse for the
  // canonical RFC 4514 string (CN first).
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
  for (const a of attributes) {
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

  // serialNumber INTEGER bytes → hex → decimal (ZATCA's ds:X509SerialNumber is
  // the decimal big-integer form).
  const serialHex = forge.util.bytesToHex(serialAsn1.value as string).replace(/^0+/, "") || "0";
  const serialNumber = BigInt("0x" + serialHex).toString(10);

  return { issuerName, serialNumber };
}

/**
 * Extract the certificate's own ECDSA signature value (QR tag 9) from its DER.
 *
 * The signatureValue is the 3rd element of the Certificate SEQUENCE — a BIT
 * STRING wrapping the DER-encoded ECDSA signature (SEQUENCE { r, s }). We avoid
 * forge.pki.certificateFromAsn1 here because it rejects EC public keys with
 * "Cannot read public key. OID is not RSA.". Returns null on any parse failure
 * so callers can omit the tag rather than 500.
 */
export function certSignatureFromDer(der: Buffer): Buffer | null {
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(der.toString("binary")));
    const sigBits = (asn1.value as forge.asn1.Asn1[])[2];
    if (typeof sigBits.value === "string") {
      // BIT STRING kept raw: drop the leading "unused bits" octet (0x00).
      let bytes = sigBits.value;
      if (bytes.length && bytes.charCodeAt(0) === 0) bytes = bytes.slice(1);
      return Buffer.from(bytes, "binary");
    }
    if (Array.isArray(sigBits.value) && sigBits.value.length) {
      // forge auto-decoded the BIT STRING into the inner ECDSA SEQUENCE{r,s};
      // re-serialize that back to the raw DER signature bytes.
      const innerDer = forge.asn1.toDer(sigBits.value[0]).getBytes();
      return Buffer.from(innerDer, "binary");
    }
    return null;
  } catch {
    return null;
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
