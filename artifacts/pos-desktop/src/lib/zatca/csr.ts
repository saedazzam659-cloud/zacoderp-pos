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

export interface ZatcaCsrParams {
  commonName: string;
  organizationName: string;
  organizationUnit: string;
  country?: string;
  /** EGS serial — the cloud sends "1-...|2-...|3-..." style or a device serial. */
  serialNumber: string;
  vatNumber: string;
  invoiceType: string; // "simplified" | "standard" | other → both
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
  vat: "2.16.840.1.114028.10.1.12",
  egsSerial: "2.16.840.1.114028.10.1.11",
  invoiceType: "2.16.840.1.114028.10.1.13",
  location: "2.16.840.1.114028.10.1.14",
  industry: "2.16.840.1.114028.10.1.15",
  title: "2.16.840.1.114028.10.1.7",
} as const;

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

  const environment = params.isSandbox
    ? "ZATCA_E-Invoice_Solutions_Provider_Demo"
    : "ZATCA_E-Invoice_Solutions_Provider";
  const invoiceTypeValue =
    params.invoiceType === "simplified" ? "1000" : params.invoiceType === "standard" ? "0100" : "1100";

  // Subject — order matches the cloud's openssl config (C, OU, O, CN).
  const subject = derSeq(
    rdn(OID.C, derPrintable(params.country ?? "SA")),
    rdn(OID.OU, derUtf8(params.organizationUnit || "E-Invoice")),
    rdn(OID.O, derUtf8(params.organizationName)),
    rdn(OID.CN, derUtf8(params.commonName)),
  );

  const spki = buildSubjectPublicKeyInfo(keyPair.publicKeyUncompressed);

  // subjectAltName with a single URI = VAT (matches the cloud config's [alt_names]).
  // GeneralName URI is [6] IMPLICIT IA5String → context-primitive tag 6.
  const sanValue = derSeq(derContext(6, false, new TextEncoder().encode(params.vatNumber)));

  // ZATCA EGS attributes as individual custom-OID UTF8String extensions
  // (openssl `<OID> = ASN1:UTF8String:<value>` → extnValue = DER(UTF8String)).
  const extensions = derSeq(
    extension(OID.subjectAltName, sanValue),
    extension(OID.msTemplate, derUtf8(environment)),
    extension(OID.vat, derUtf8(params.vatNumber)),
    extension(OID.egsSerial, derUtf8(params.serialNumber)),
    extension(OID.invoiceType, derUtf8(invoiceTypeValue)),
    extension(OID.location, derUtf8("1")),
    extension(OID.industry, derUtf8("1")),
    extension(OID.title, derUtf8("1")),
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
