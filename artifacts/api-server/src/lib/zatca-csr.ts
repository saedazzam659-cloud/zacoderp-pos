/**
 * ZATCA CSR (Certificate Signing Request) Generator
 *
 * Generates an ECDSA secp256k1 key pair and a CSR that conforms to the ZATCA
 * e-invoicing onboarding specification. The CSR carries:
 *   - the certificate-template name in OID 1.3.6.1.4.1.311.20.2
 *     (TSTZATCA-Code-Signing / PREZATCA-Code-Signing / ZATCA-Code-Signing)
 *   - a subjectAltName built as a directoryName (dirName) holding the EGS
 *     serial number (SN), VAT/organization identifier (UID), invoice-type
 *     flags (title), registered address and business category.
 *
 * This layout matches ZATCA's published csr.cnf template. Earlier versions
 * used a DigiCert-style OID set and a URI SAN, which ZATCA rejects with 400.
 */
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export type ZatcaCsrEnv = "sandbox" | "simulation" | "production";

export interface CsrParams {
  commonName: string;
  organizationName: string;
  organizationUnit: string;
  country?: string;
  serialNumber: string;
  vatNumber: string;
  invoiceType: string;
  /** Registered address line (building + street + district + city + postal). */
  registeredAddress: string;
  /** Business / industry category (must be non-empty for ZATCA). */
  businessCategory: string;
  /**
   * Target ZATCA environment. Controls the certificate-template name.
   * Back-compat: when omitted, `isSandbox` decides sandbox vs production.
   */
  environment?: ZatcaCsrEnv;
  isSandbox?: boolean;
}

export interface GeneratedCsr {
  privateKey: string;
  publicKey: string;
  csr: string;
}

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

// openssl .cnf values are single-line; strip CR/LF and trim to avoid breaking
// the config file. ZATCA values (VAT, serial, address) are plain text.
function cnfValue(v: string): string {
  return (v ?? "").replace(/[\r\n]+/g, " ").trim();
}

export function generateCsr(params: CsrParams): GeneratedCsr {
  const workDir = join(tmpdir(), `zatca-csr-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  const keyPath = join(workDir, "private.pem");
  const csrPath = join(workDir, "csr.pem");
  const pubPath = join(workDir, "public.pem");
  const cnfPath = join(workDir, "csr.cnf");

  const env: ZatcaCsrEnv =
    params.environment ?? (params.isSandbox === false ? "production" : "sandbox");
  const template = templateName(env);
  const titleValue = invoiceTypeFlags(params.invoiceType);

  // Business category is required by ZATCA; fall back to the org unit / a
  // generic value so the CSR is never emitted with an empty businessCategory.
  const businessCategory =
    cnfValue(params.businessCategory) || cnfValue(params.organizationUnit) || "Other";
  const registeredAddress = cnfValue(params.registeredAddress) || cnfValue(params.organizationName);

  const cnfContent = `[req]
default_bits = 2048
prompt = no
default_md = sha256
req_extensions = v3_req
distinguished_name = dn

[dn]
C = ${cnfValue(params.country ?? "SA")}
OU = ${cnfValue(params.organizationUnit) || "E-Invoice"}
O = ${cnfValue(params.organizationName)}
CN = ${cnfValue(params.commonName)}

[v3_req]
1.3.6.1.4.1.311.20.2 = ASN1:UTF8String:${template}
subjectAltName = dirName:dir_sect

[dir_sect]
SN = ${cnfValue(params.serialNumber)}
UID = ${cnfValue(params.vatNumber)}
title = ${titleValue}
registeredAddress = ${registeredAddress}
businessCategory = ${businessCategory}
`;

  writeFileSync(cnfPath, cnfContent);

  try {
    // Generate EC private key (secp256k1 — required by ZATCA).
    execSync(`openssl ecparam -name secp256k1 -genkey -noout -out "${keyPath}"`, { timeout: 15000 });

    // Generate CSR using the private key and config.
    execSync(`openssl req -new -key "${keyPath}" -config "${cnfPath}" -out "${csrPath}"`, { timeout: 15000 });

    // Extract public key.
    execSync(`openssl ec -in "${keyPath}" -pubout -out "${pubPath}"`, { timeout: 15000 });

    const privateKey = readFileSync(keyPath, "utf8");
    const csr = readFileSync(csrPath, "utf8");
    const publicKey = readFileSync(pubPath, "utf8");

    return { privateKey, publicKey, csr };
  } finally {
    // Cleanup temp files.
    try { unlinkSync(keyPath); } catch {}
    try { unlinkSync(csrPath); } catch {}
    try { unlinkSync(pubPath); } catch {}
    try { unlinkSync(cnfPath); } catch {}
    try { execSync(`rmdir "${workDir}"`, { timeout: 2000 }); } catch {}
  }
}
