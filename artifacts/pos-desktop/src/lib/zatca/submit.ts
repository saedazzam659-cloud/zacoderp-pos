// Per-invoice ZATCA pipeline (Task #233, Option B): build UBL → hash → sign
// (XAdES-BES) → Phase-2 QR → submit via the Rust HTTPS proxy → persist status,
// maintaining the PIH chain + ICV counter in local SQLite.
//
// Everything here runs inside the webview against DEVICE-LOCAL state (keyring
// private key + CSID, local chain). The standalone path makes ZERO Zacod-cloud
// calls — the only network egress is the direct ZATCA gateway POST.

import {
  bytesToB64,
  b64ToBytes,
  hexToBytes,
  publicKeyFromPrivate,
} from "./crypto";
import { derSeq, derOid, derBitString, readNode, readChildren } from "./der";
import { generateZatcaXml, hashUbl, type ZatcaInvoiceData } from "./ubl";
import { signZatcaUbl } from "./xades";
import { buildPhase2Qr } from "./tlv";
import { utf8ToBytes } from "./crypto";
import { submitInvoice, type ZatcaSubmissionResult } from "./gateway";
import {
  zatcaChainHead,
  zatcaLoadSecret,
  zatcaRecordInvoice,
  zatcaUpdateInvoiceStatus,
  zatcaGetOnboarding,
  type ZatcaEnvironment,
} from "./native";

// ZATCA-documented genesis PIH for the first invoice in a chain: base64 of the
// ASCII hex string of sha256("0"). Subsequent invoices chain on the previous
// invoice's DigestValue (base64 of the raw 32-byte hash).
export const GENESIS_PIH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";

const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const OID_SECP256K1 = "1.3.132.0.10";

/** DER SubjectPublicKeyInfo of the EGS public key (QR tag 8). */
function publicKeySpki(priv: Uint8Array): Uint8Array {
  const pub = publicKeyFromPrivate(priv, false); // 65-byte uncompressed point
  return derSeq(
    derSeq(derOid(OID_EC_PUBLIC_KEY), derOid(OID_SECP256K1)),
    derBitString(pub),
  );
}

/** Raw ECDSA signature bytes of the CSID certificate (QR tag 9). Returns null
 * when the cert can't be parsed (tag 9 is optional in the Phase-2 QR). */
function certSignatureBytes(certBase64: string): Uint8Array | null {
  try {
    const der = b64ToBytes(
      certBase64
        .replace(/-----BEGIN [^-]+-----/g, "")
        .replace(/-----END [^-]+-----/g, "")
        .replace(/\s+/g, ""),
    );
    const cert = readNode(der, 0); // Certificate ::= SEQUENCE
    const kids = readChildren(der, cert); // [tbsCertificate, sigAlg, signatureValue]
    const sigVal = kids[kids.length - 1]; // BIT STRING
    let content = der.slice(sigVal.contentStart, sigVal.contentEnd);
    if (content.length > 0 && content[0] === 0x00) content = content.slice(1); // unused-bits byte
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export interface ActiveCredentials {
  env: ZatcaEnvironment;
  /** "production" once a production CSID is issued, else "compliance". */
  mode: "compliance" | "production";
  privateKey: Uint8Array;
  /** The active CSID certificate (bare base64 binarySecurityToken). */
  cert: string;
  token: string;
  secret: string;
}

interface StoredCsid {
  token: string;
  secret: string;
}

function parseCsidSecret(raw: string | null): StoredCsid | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<StoredCsid>;
    if (o.token && o.secret) return { token: o.token, secret: o.secret };
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Load the credentials to sign + submit with. Prefers the PRODUCTION CSID;
 * falls back to the COMPLIANCE CSID (used during onboarding compliance checks).
 * Throws an Arabic error when the device hasn't onboarded.
 */
export async function loadActiveCredentials(): Promise<ActiveCredentials> {
  const [onb, privHex, prodRaw, compRaw] = await Promise.all([
    zatcaGetOnboarding(),
    zatcaLoadSecret("privkey"),
    zatcaLoadSecret("production"),
    zatcaLoadSecret("compliance"),
  ]);
  if (!privHex) throw new Error("لم يتم إنشاء مفتاح التوقيع بعد — أكمل التسجيل في زاتكا أولاً.");
  const prod = parseCsidSecret(prodRaw);
  const comp = parseCsidSecret(compRaw);
  const chosen = prod ?? comp;
  if (!chosen) throw new Error("لا توجد شهادة زاتكا فعّالة — أكمل خطوات التسجيل.");
  return {
    env: onb.environment,
    mode: prod ? "production" : "compliance",
    privateKey: hexToBytes(privHex),
    cert: chosen.token,
    token: chosen.token,
    secret: chosen.secret,
  };
}

export interface BuildInvoiceInput {
  /** v4 UUID used both as the local chain key and the submission `uuid`. */
  uuid: string;
  invoiceNumber: string;
  flow: "simplified" | "standard";
  issueDate: string; // YYYY-MM-DD
  issueTime?: string; // HH:MM:SS
  currency?: string;
  data: Omit<
    ZatcaInvoiceData,
    "invoiceCounterValue" | "previousInvoiceHash" | "qrCode" | "invoiceType"
  >;
  /** Phase-2 QR tags 1-5 (seller-displayed values). */
  qr: { sellerName: string; vatNumber: string; invoiceTotal: string; vatTotal: string };
}

export interface SignedInvoice {
  uuid: string;
  icv: number;
  pih: string;
  invoiceHash: string;
  signedXml: string;
  qrBase64: string;
  flow: "simplified" | "standard";
  invoiceNumber: string;
}

const QR_PLACEHOLDER_RE =
  /(<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">)(<\/cbc:EmbeddedDocumentBinaryObject>)/;

/**
 * Build + sign one invoice and record it into the local PIH chain. Does NOT
 * submit — call `submitSigned` next (split so a submit failure can be retried
 * without re-consuming an ICV).
 */
export async function buildAndSignInvoice(
  creds: ActiveCredentials,
  input: BuildInvoiceInput,
): Promise<SignedInvoice> {
  const head = await zatcaChainHead();
  const icv = head ? head.icv + 1 : 1;
  const pih = head ? head.invoiceHash : GENESIS_PIH;

  // 1. UBL with an EMPTY QR placeholder (the QR is excluded from the digest
  //    transforms, so it is injected post-signature).
  const ublXml = generateZatcaXml({
    ...input.data,
    invoiceType: input.flow,
    invoiceCounterValue: icv,
    previousInvoiceHash: pih,
    qrCode: "",
  });

  // 2. DigestValue (same whole-string hashing convention as the cloud builder).
  const invoiceHash = hashUbl(ublXml);

  // 3. XAdES-BES signature (UBLExtensions injected; QR placeholder untouched).
  const { signedXml: signedNoQr, signatureValueB64 } = signZatcaUbl({
    ublXml,
    certificatePem: creds.cert,
    privateKey: creds.privateKey,
    invoiceHash,
  });

  // 4. Phase-2 (9-tag) QR from the signed artifacts.
  const issueTime = input.issueTime ?? "00:00:00";
  const qrBase64 = buildPhase2Qr({
    sellerName: input.qr.sellerName,
    vatNumber: input.qr.vatNumber,
    timestamp: `${input.issueDate}T${issueTime}Z`,
    invoiceTotal: input.qr.invoiceTotal,
    vatTotal: input.qr.vatTotal,
    invoiceHashB64: invoiceHash,
    signatureB64: signatureValueB64,
    publicKeyDer: publicKeySpki(creds.privateKey),
    certSignatureDer: certSignatureBytes(creds.cert),
  });

  // 5. Inject the QR into the (excluded) AdditionalDocumentReference element.
  if (!QR_PLACEHOLDER_RE.test(signedNoQr)) {
    throw new Error("تعذّر إدراج رمز QR — عنصر QR غير موجود في فاتورة UBL");
  }
  const signedXml = signedNoQr.replace(QR_PLACEHOLDER_RE, `$1${qrBase64}$2`);

  // 6. Persist into the chain (status pending → ready to submit / retry).
  await zatcaRecordInvoice({
    localUuid: input.uuid,
    icv,
    pih,
    invoiceHash,
    invoiceNo: input.invoiceNumber,
    invoiceType: input.flow,
    signedXml,
    qrBase64,
    status: "pending",
  });

  return {
    uuid: input.uuid,
    icv,
    pih,
    invoiceHash,
    signedXml,
    qrBase64,
    flow: input.flow,
    invoiceNumber: input.invoiceNumber,
  };
}

export interface SubmitOutcome {
  /** Local status persisted: "submitted" | "rejected" | "pending" (offline). */
  status: "submitted" | "rejected" | "pending";
  zatcaStatus: string | null;
  offline: boolean;
  result?: ZatcaSubmissionResult;
  error?: string;
}

/**
 * Submit an already-signed invoice to ZATCA. Network failure leaves the row
 * `pending` for a later retry (offline queue); an HTTP error from ZATCA marks
 * it `rejected` with the validation payload.
 */
export async function submitSigned(
  creds: ActiveCredentials,
  signed: SignedInvoice,
  opts?: { compliance?: boolean },
): Promise<SubmitOutcome> {
  const body = {
    invoiceHash: signed.invoiceHash,
    uuid: signed.uuid,
    invoice: bytesToB64(utf8ToBytes(signed.signedXml)),
  };
  let result: ZatcaSubmissionResult;
  try {
    result = await submitInvoice({
      env: creds.env,
      token: creds.token,
      secret: creds.secret,
      flow: signed.flow,
      body,
      compliance: opts?.compliance,
    });
  } catch (e) {
    // The Rust proxy threw (no connectivity / TLS) — keep it queued.
    const error = e instanceof Error ? e.message : String(e);
    await zatcaUpdateInvoiceStatus({
      localUuid: signed.uuid,
      status: "pending",
      zatcaStatus: null,
      responseJson: JSON.stringify({ offline: true, error }),
    });
    return { status: "pending", zatcaStatus: null, offline: true, error };
  }

  const status = result.ok ? "submitted" : "rejected";
  await zatcaUpdateInvoiceStatus({
    localUuid: signed.uuid,
    status,
    zatcaStatus: result.zatcaStatus,
    warningsJson: result.warnings ? JSON.stringify(result.warnings) : null,
    responseJson: result.raw || null,
  });
  return { status, zatcaStatus: result.zatcaStatus, offline: false, result };
}

/** Build + sign + submit in one shot (the common register path). */
export async function processInvoice(
  input: BuildInvoiceInput,
  opts?: { compliance?: boolean },
): Promise<{ signed: SignedInvoice; outcome: SubmitOutcome }> {
  const creds = await loadActiveCredentials();
  const signed = await buildAndSignInvoice(creds, input);
  const outcome = await submitSigned(creds, signed, opts);
  return { signed, outcome };
}
