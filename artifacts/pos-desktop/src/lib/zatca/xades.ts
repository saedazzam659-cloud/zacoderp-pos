// XAdES-BES signer for ZATCA UBL invoices — browser-safe port of the cloud's
// `zatca-xades-signer.ts` (Task #233, Option B).
//
// Identical XML output to the cloud: same SignedInfo / SignedProperties /
// UBLExtensions layout, the same quirky cert-digest rule (sha256 of the cert's
// hex-ASCII), and the same IEEE-P1363 (r||s) ECDSA-SHA256 SignatureValue.
//
// Two Node-only dependencies are replaced:
//   • `crypto` (createHash/createSign/createPrivateKey) → ./crypto
//   • `node-forge` (X.509 issuer/serial parse)          → ./der walker

import {
  sha256B64,
  signEcdsaP1363,
  bytesToB64,
  b64ToBytes,
  bytesToHex,
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

export function signZatcaUbl(input: SignXadesInput): SignXadesResult {
  const { ublXml, certificatePem, privateKey, invoiceHash } = input;

  // 1. Strip PEM, get cert DER bytes.
  const certBody = certificatePem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!certBody) throw new Error("certificate is empty after PEM strip");
  const certBytes = b64ToBytes(certBody);

  // ZATCA's quirky cert-digest rule: sha256 of the *hex of the cert bytes* as
  // an ASCII string, then base64.
  const certHexAscii = bytesToHex(certBytes);
  const certDigestB64 = sha256B64(certHexAscii);

  // 2. Issuer DN (RFC 4514) + serial (decimal) from the cert DER.
  const { issuerName, serialNumber } = parseCertIssuerSerial(certBytes);

  // 3. SignedProperties → digest.
  const signingTime = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const signedProps = buildSignedProperties({ signingTime, certDigestB64, issuerName, serialNumber });
  const signedPropsHashB64 = sha256B64(signedProps);

  // 4. SignedInfo over invoice digest + signed-properties digest.
  const signedInfo = buildSignedInfo({ invoiceHashB64: invoiceHash, signedPropsHashB64 });

  // 5. ECDSA-SHA256 over SignedInfo, P1363 (r||s) form.
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
  signingTime: string;
  certDigestB64: string;
  issuerName: string;
  serialNumber: string;
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
