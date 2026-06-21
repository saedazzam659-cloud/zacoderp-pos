// XAdES-BES signer for ZATCA UBL invoices — browser-safe port of the cloud's
// `zatca-xades-signer.ts`.
//
// Produces ZATCA-valid signatures matching the cloud signer's PROVEN math
// (cloud passed production simplified/B2C compliance):
//   • cert digest      = base64( lower-hex( sha256( base64-cert-body ASCII ) ) )
//   • SignedProperties = same base64-of-hex digest convention
//   • SignatureValue   = IEEE-P1363 (r||s) ECDSA-SHA256 over the canonical SignedInfo
//
// The cloud canonicalizes (C14N) the SignedInfo / SignedProperties at runtime
// before hashing/signing. This app has no C14N library, so instead the templates
// are authored ALREADY in C14N (canonical) fixed-point form — xmlns decls before
// other attributes, self-closing tags expanded — and the SAME bytes are embedded
// AND hashed/signed verbatim. ZATCA's canonicalization of the embedded node-set is
// then a no-op, so the recomputed digests/signature match (the zatca-xml-js
// approach). NOTE: this makes the signer sensitive to template whitespace/tag-shape
// edits — keep buildSignedInfo / buildSignedProperties as C14N fixed points.
//
// Two Node-only dependencies are replaced:
//   • `crypto` (createHash/createSign/createPrivateKey) → ./crypto
//   • `node-forge` (X.509 issuer/serial parse)          → ./der walker

import {
  sha256Hex,
  signEcdsaP1363,
  bytesToB64,
  b64ToBytes,
  utf8ToBytes,
  bytesToUtf8,
} from "./crypto";
import {
  type DerNode,
  readNode,
  readChildren,
  decodeOid,
  decodeIntDecimal,
} from "./der";

export interface SignXadesInput {
  ublXml: string; // unsigned UBL with placeholder UBLExtensions
  certificatePem: string; // the CSID/PCSID certificate (PEM or bare base64)
  privateKey: Uint8Array; // 32-byte secp256k1 secret matching the certificate
  invoiceHash: string; // base64 sha256 of canonical UBL (caller computed)
}

export interface SignXadesResult {
  signedXml: string;
  signatureValueB64: string;
  signedPropertiesHashB64: string;
}

// ZATCA's base64-OF-HEX encoding quirk (cert digest + SignedProperties digest):
// base64( lower-hex( sha256( input ) ) ) — i.e. sha256 → 64-char hex STRING →
// base64 of that ASCII hex, NOT the standard raw-32-byte base64 the rest of
// XML-DSIG uses. The strict simplified (B2C) reporting validator recomputes the
// SignedProperties digest this way; raw-bytes base64 yields `signed-properties-
// hashing`. Mirrors the cloud signer (zatca-xades-signer.ts) and zatca-xml-js.
function sha256B64OfHex(input: string): string {
  return bytesToB64(utf8ToBytes(sha256Hex(input)));
}

// Recover the cert DER + its single-base64 body from a ZATCA cert input.
// ZATCA's `binarySecurityToken` carries an EXTRA base64 layer over the DER:
// decoding once yields the ASCII base64 cert body ("MII…"), NOT raw DER. Every
// X.509 DER starts with 0x30 (SEQUENCE), so when the first decoded byte is not
// 0x30 we unwrap the extra layer. Mirrors the cloud's certDerFromToken.
function certDerFromToken(certInput: string): { der: Uint8Array; bodyB64: string } {
  const stripped = certInput
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  let der = b64ToBytes(stripped);
  if (der[0] !== 0x30) {
    // Unwrap ZATCA's extra base64 layer (binarySecurityToken → cert body).
    der = b64ToBytes(bytesToUtf8(der).trim());
  }
  return { der, bodyB64: bytesToB64(der) };
}

export function signZatcaUbl(input: SignXadesInput): SignXadesResult {
  const { ublXml, certificatePem, privateKey, invoiceHash } = input;

  // 1. Recover the cert DER + canonical single-base64 body (unwraps ZATCA's
  //    double-base64 binarySecurityToken so the digest + ASN.1 parse use real bytes).
  const { der: certBytes, bodyB64: certBody } = certDerFromToken(certificatePem);
  if (!certBody) throw new Error("certificate is empty after PEM strip");

  // ZATCA cert-digest = base64( lower-hex( sha256( base64-cert-body ASCII ) ) ).
  // The hash is over the base64 cert STRING (the exact <ds:X509Certificate> text),
  // NOT the DER bytes — matches what ZATCA recomputes (cloud + zatca-xml-js).
  const certDigestB64 = sha256B64OfHex(certBody);

  // 2. Issuer DN (RFC 4514) + serial (decimal) from the cert DER.
  const { issuerName, serialNumber } = parseCertIssuerSerial(certBytes);

  // 3. SignedProperties → digest. buildSignedProperties emits the C14N (canonical)
  //    form directly — namespace decls first, self-closing tags expanded — so it is
  //    a C14N fixed point. We embed THIS exact string, so ZATCA's canonicalization
  //    of the embedded node-set is a no-op and a verbatim sha256 matches. The digest
  //    uses the base64-OF-HEX quirk (Reference#2 carries no <ds:Transforms>).
  const signingTime = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const signedProps = buildSignedProperties({ signingTime, certDigestB64, issuerName, serialNumber });
  const signedPropsHashB64 = sha256B64OfHex(signedProps);

  // 4. SignedInfo over invoice digest + signed-properties digest. buildSignedInfo
  //    also emits the C14N form so that signing it verbatim equals signing the
  //    canonical form ZATCA verifies against (CanonicalizationMethod = c14n11).
  const signedInfo = buildSignedInfo({ invoiceHashB64: invoiceHash, signedPropsHashB64 });

  // 5. ECDSA-SHA256 over the (already-canonical) SignedInfo, P1363 (r||s) form.
  const sig = signEcdsaP1363(utf8ToBytes(signedInfo), privateKey);
  const signatureValueB64 = bytesToB64(sig);

  // 6. Compose UBLExtensions and inject.
  const ext = buildUblExtensionsBlock({
    signedInfo,
    signatureValueB64,
    certBodyB64: certBody,
    signedProperties: signedProps,
  });
  const PLACEHOLDER_RE = /<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/;
  if (!PLACEHOLDER_RE.test(ublXml)) {
    throw new Error("UBL XML missing <ext:UBLExtensions> placeholder block");
  }
  const signedXml = ublXml.replace(PLACEHOLDER_RE, ext);

  return { signedXml, signatureValueB64, signedPropertiesHashB64: signedPropsHashB64 };
}

function buildSignedInfo(opts: { invoiceHashB64: string; signedPropsHashB64: string }): string {
  // Authored in C14N (canonical) form — self-closing tags expanded — so signing
  // it verbatim equals signing the form ZATCA canonicalizes & verifies.
  return `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"></ds:CanonicalizationMethod>
<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"></ds:SignatureMethod>
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
<ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"></ds:Transform>
</ds:Transforms>
<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>
<ds:DigestValue>${opts.invoiceHashB64}</ds:DigestValue>
</ds:Reference>
<ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>
<ds:DigestValue>${opts.signedPropsHashB64}</ds:DigestValue>
</ds:Reference>
</ds:SignedInfo>`;
}

function buildSignedProperties(opts: {
  signingTime: string;
  certDigestB64: string;
  issuerName: string;
  serialNumber: string;
}): string {
  // Authored in C14N (canonical) form — xmlns decls before other attributes,
  // self-closing <ds:DigestMethod> expanded — so it is a C14N fixed point. We embed
  // this exact string and hash it verbatim (base64-of-hex); ZATCA's canonicalization
  // of the embedded node-set is then a no-op and the recomputed digest matches.
  return `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
<xades:SignedSignatureProperties>
<xades:SigningTime>${opts.signingTime}</xades:SigningTime>
<xades:SigningCertificate>
<xades:Cert>
<xades:CertDigest>
<ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>
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
  signedInfo: string;
  signatureValueB64: string;
  certBodyB64: string;
  signedProperties: string;
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

// ─── Minimal X.509 issuer/serial parse (replaces node-forge) ─────────
const OID_SHORT: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "0.9.2342.19200300.100.1.25": "DC",
  "1.2.840.113549.1.9.1": "E",
};

export function parseCertIssuerSerial(der: Uint8Array): { issuerName: string; serialNumber: string } {
  // Certificate ::= SEQ { tbsCertificate, sigAlg, signature }
  const cert = readNode(der, 0);
  const tbs = readChildren(der, cert)[0];
  const tbsKids = readChildren(der, tbs);

  // tbs ::= [0] version?, serialNumber, sigAlg, issuer, validity, subject, ...
  let idx = 0;
  if (tbsKids[0].tag === 0xa0) idx = 1; // optional EXPLICIT [0] version
  const serialNumber = decodeIntDecimal(der, tbsKids[idx]);
  const issuerNode = tbsKids[idx + 2]; // serial(idx), sigAlg(idx+1), issuer(idx+2)

  const parts: string[] = [];
  for (const rdn of readChildren(der, issuerNode)) {
    for (const atv of readChildren(der, rdn)) {
      const [oidNode, valNode] = readChildren(der, atv);
      const oid = decodeOid(der, oidNode);
      const name = OID_SHORT[oid] ?? oid;
      const value = bytesToUtf8(der.subarray(valNode.contentStart, valNode.contentEnd));
      parts.push(`${name}=${rfc4514Escape(value)}`);
    }
  }
  // DER order is CA-down (CN last); RFC 4514 is most-significant-first (CN first).
  const issuerName = parts.reverse().join(", ");
  return { issuerName, serialNumber };
}

function rfc4514Escape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/\+/g, "\\+")
    .replace(/"/g, '\\"')
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/;/g, "\\;")
    .replace(/^ /, "\\ ")
    .replace(/^#/, "\\#")
    .replace(/ $/, "\\ ");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Re-exported so callers can navigate certs without importing der directly.
export type { DerNode };
