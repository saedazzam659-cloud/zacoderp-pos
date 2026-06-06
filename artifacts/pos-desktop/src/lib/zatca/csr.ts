// ZATCA EGS CSR (PKCS#10) builder — browser-safe port of the cloud's
// `zatca-csr.ts` (Task #233, Option B).
//
// The cloud shells out to `openssl req` with a config that puts the ZATCA EGS
// attributes as custom-OID extensions plus a subjectAltName URI. This module
// reproduces the SAME structure entirely in TS using the secp256k1 key from
// `./crypto` and the DER encoder in `./der`, so the generated CSR is accepted
// by the same ZATCA onboarding endpoint the cloud talks to.
//
// Structure (RFC 2986):
//   CertificationRequest ::= SEQUENCE {
//     certificationRequestInfo,  -- version, subject, SPKI, [0] attributes
//     signatureAlgorithm,        -- ecdsa-with-SHA256
//     signature BIT STRING }     -- DER ECDSA over DER(certificationRequestInfo)

import {
  type EcKeyPair,
  generateEcKeyPair,
  signEcdsaDer,
  bytesToB64,
} from "./crypto";
import {
  concatBytes,
  derSeq,
  derSet,
  derUtf8,
  derPrintable,
  derOid,
  derOctet,
  derBitString,
  derContext,
  derVersionZero,
  tlv,
} from "./der";

export type ZatcaCsrEnv = "sandbox" | "simulation" | "production";

export interface ZatcaCsrParams {
  commonName: string;
  organizationName: string;
  organizationUnit: string;
  country?: string;
  /** EGS serial — the cloud sends "1-...|2-...|3-..." style or a device serial. */
  serialNumber: string;
  vatNumber: string;
  invoiceType: string; // "simplified" | "standard" | other → both
  /** Registered address line (building + street + district + city + postal). */
  registeredAddress?: string;
  /** Business / industry category (ZATCA requires it non-empty). */
  businessCategory?: string;
  /**
   * Target ZATCA environment — controls the certificate-template name.
   * Back-compat: when omitted, `isSandbox` decides sandbox vs production.
   */
  environment?: ZatcaCsrEnv;
  isSandbox?: boolean;
}

export interface GeneratedCsr {
  csrPem: string;
  csrDer: Uint8Array;
  keyPair: EcKeyPair;
}

// OIDs
const OID = {
  CN: "2.5.4.3",
  C: "2.5.4.6",
  O: "2.5.4.10",
  OU: "2.5.4.11",
  ecPublicKey: "1.2.840.10045.2.1",
  secp256k1: "1.3.132.0.10",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  extensionRequest: "1.2.840.113549.1.9.14",
  subjectAltName: "2.5.29.17",
  msTemplate: "1.3.6.1.4.1.311.20.2",
  // ZATCA dirName SAN attributes — these are the exact OIDs openssl emits for
  // the csr.cnf short names SN/UID/title/registeredAddress/businessCategory.
  surname: "2.5.4.4", // SN  → EGS serial number
  userId: "0.9.2342.19200300.100.1.1", // UID → VAT / org identifier
  title: "2.5.4.12", // title → invoice-type flags
  registeredAddress: "2.5.4.26",
  businessCategory: "2.5.4.15",
} as const;

// ZATCA certificate-template name per environment. These exact strings are
// validated by ZATCA — any other value is rejected at /compliance with 400.
function templateName(env: ZatcaCsrEnv): string {
  switch (env) {
    case "production":
      return "ZATCA-Code-Signing";
    case "simulation":
      return "PREZATCA-Code-Signing";
    case "sandbox":
    default:
      return "TSTZATCA-Code-Signing";
  }
}

// Invoice-type flags for the CSR `title` field: position 1 = standard (B2B
// tax) invoices, position 2 = simplified (B2C) invoices. "both" => 1100.
function invoiceTypeFlags(invoiceType: string): string {
  switch (invoiceType) {
    case "standard":
      return "1000";
    case "simplified":
      return "0100";
    case "both":
    default:
      return "1100";
  }
}

function rdn(oid: string, valueTlv: Uint8Array): Uint8Array {
  return derSet(derSeq(derOid(oid), valueTlv));
}

/** Extension SEQUENCE { extnID, extnValue OCTET STRING(DER) } (critical=false). */
function extension(oid: string, derValue: Uint8Array): Uint8Array {
  return derSeq(derOid(oid), derOctet(derValue));
}

function buildSubjectPublicKeyInfo(pubUncompressed: Uint8Array): Uint8Array {
  return derSeq(
    derSeq(derOid(OID.ecPublicKey), derOid(OID.secp256k1)),
    derBitString(pubUncompressed),
  );
}

function pemWrap(label: string, der: Uint8Array): string {
  const b64 = bytesToB64(der);
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export function buildZatcaCsr(params: ZatcaCsrParams, existing?: EcKeyPair): GeneratedCsr {
  const keyPair = existing ?? generateEcKeyPair();

  const env: ZatcaCsrEnv =
    params.environment ?? (params.isSandbox === false ? "production" : "sandbox");
  const template = templateName(env);
  const titleValue = invoiceTypeFlags(params.invoiceType);

  // ZATCA requires a non-empty businessCategory + registeredAddress; fall back
  // to the org unit / name (and a placeholder) so the CSR is never empty.
  const businessCategory =
    (params.businessCategory ?? "").trim() ||
    (params.organizationUnit ?? "").trim() ||
    "Other";
  const registeredAddress =
    (params.registeredAddress ?? "").trim() ||
    (params.organizationName ?? "").trim() ||
    "غير محدد";

  // Subject — order matches the cloud's openssl config (C, OU, O, CN).
  const subject = derSeq(
    rdn(OID.C, derPrintable(params.country ?? "SA")),
    rdn(OID.OU, derUtf8(params.organizationUnit || "E-Invoice")),
    rdn(OID.O, derUtf8(params.organizationName)),
    rdn(OID.CN, derUtf8(params.commonName)),
  );

  const spki = buildSubjectPublicKeyInfo(keyPair.publicKeyUncompressed);

  // subjectAltName = directoryName ([4] EXPLICIT Name) carrying the ZATCA EGS
  // attributes (SN/UID/title/registeredAddress/businessCategory), exactly like
  // ZATCA's csr.cnf dir_sect. All values are UTF8String and use the same OIDs
  // openssl emits for those short names. DigiCert OIDs + the URI SAN (which
  // ZATCA rejects with 400) are gone.
  const dirName = derSeq(
    rdn(OID.surname, derUtf8(params.serialNumber)),
    rdn(OID.userId, derUtf8(params.vatNumber)),
    rdn(OID.title, derUtf8(titleValue)),
    rdn(OID.registeredAddress, derUtf8(registeredAddress)),
    rdn(OID.businessCategory, derUtf8(businessCategory)),
  );
  const sanValue = derSeq(derContext(4, true, dirName));

  const extensions = derSeq(
    extension(OID.msTemplate, derUtf8(template)),
    extension(OID.subjectAltName, sanValue),
  );

  // extensionRequest attribute: SEQUENCE { OID, SET { Extensions } }
  const attribute = derSeq(derOid(OID.extensionRequest), derSet(extensions));
  // attributes [0] IMPLICIT SET OF Attribute
  const attributes = derContext(0, true, attribute);

  const cri = derSeq(derVersionZero(), subject, spki, attributes);

  const signature = signEcdsaDer(cri, keyPair.privateKey);
  const sigAlg = derSeq(derOid(OID.ecdsaWithSha256));

  const csrDer = derSeq(cri, sigAlg, derBitString(signature));

  return { csrPem: pemWrap("CERTIFICATE REQUEST", csrDer), csrDer, keyPair };
}

/** ZATCA sends/expects the CSR as the base64 of the PEM string. */
export function csrPemToBase64(csrPem: string): string {
  return bytesToB64(new TextEncoder().encode(csrPem));
}
