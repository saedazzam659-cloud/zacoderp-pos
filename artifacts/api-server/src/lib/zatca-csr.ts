/**
 * ZATCA CSR (Certificate Signing Request) Generator
 * Generates ECDSA secp256k1 key pair and CSR for ZATCA compliance
 */
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface CsrParams {
  commonName: string;
  organizationName: string;
  organizationUnit: string;
  country?: string;
  serialNumber: string;
  vatNumber: string;
  invoiceType: string;
  isSandbox?: boolean;
}

export interface GeneratedCsr {
  privateKey: string;
  publicKey: string;
  csr: string;
}

export function generateCsr(params: CsrParams): GeneratedCsr {
  const workDir = join(tmpdir(), `zatca-csr-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  const keyPath = join(workDir, "private.pem");
  const csrPath = join(workDir, "csr.pem");
  const pubPath = join(workDir, "public.pem");
  const cnfPath = join(workDir, "csr.cnf");

  const environment = params.isSandbox ? "ZATCA_E-Invoice_Solutions_Provider_Demo" : "ZATCA_E-Invoice_Solutions_Provider";
  const invoiceTypeValue = params.invoiceType === "simplified" ? "1000" : params.invoiceType === "standard" ? "0100" : "1100";

  const cnfContent = `[req]
default_bits = 2048
prompt = no
default_md = sha256
req_extensions = req_ext
distinguished_name = dn

[dn]
C = ${params.country ?? "SA"}
OU = ${params.organizationUnit || "E-Invoice"}
O = ${params.organizationName}
CN = ${params.commonName}

[req_ext]
subjectAltName = @alt_names
1.3.6.1.4.1.311.20.2 = ASN1:UTF8String:${environment}
2.16.840.1.114028.10.1.12 = ASN1:UTF8String:${params.vatNumber}
2.16.840.1.114028.10.1.11 = ASN1:UTF8String:${params.serialNumber}
2.16.840.1.114028.10.1.13 = ASN1:UTF8String:${invoiceTypeValue}
2.16.840.1.114028.10.1.14 = ASN1:UTF8String:1
2.16.840.1.114028.10.1.15 = ASN1:UTF8String:1
2.16.840.1.114028.10.1.7 = ASN1:UTF8String:1

[alt_names]
URI = ${params.vatNumber}
`;

  writeFileSync(cnfPath, cnfContent);

  try {
    // Generate EC private key (secp256k1)
    execSync(`openssl ecparam -name secp256k1 -genkey -noout -out "${keyPath}"`, { timeout: 15000 });

    // Generate CSR using the private key and config
    execSync(`openssl req -new -key "${keyPath}" -config "${cnfPath}" -out "${csrPath}"`, { timeout: 15000 });

    // Extract public key
    execSync(`openssl ec -in "${keyPath}" -pubout -out "${pubPath}"`, { timeout: 15000 });

    const privateKey = readFileSync(keyPath, "utf8");
    const csr = readFileSync(csrPath, "utf8");
    const publicKey = readFileSync(pubPath, "utf8");

    return { privateKey, publicKey, csr };
  } finally {
    // Cleanup temp files
    try { unlinkSync(keyPath); } catch {}
    try { unlinkSync(csrPath); } catch {}
    try { unlinkSync(pubPath); } catch {}
    try { unlinkSync(cnfPath); } catch {}
    try { execSync(`rmdir "${workDir}"`, { timeout: 2000 }); } catch {}
  }
}
