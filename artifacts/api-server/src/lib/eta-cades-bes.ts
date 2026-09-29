/**
 * ETA document serialization and detached CAdES-BES (CMS) signing.
 *
 * ETA's signature serializer is not JSON canonicalization. It is a token
 * stream: each member name and scalar is a quoted token, with no punctuation;
 * an array's member name is repeated for each array element.
 */
import { createHash, createSign, createVerify, X509Certificate } from "node:crypto";
import forge from "node-forge";

export class EtaDecimal {
  readonly lexical: string;
  constructor(lexical: string) {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(lexical)) {
      throw new TypeError("invalid ETA decimal lexical value");
    }
    this.lexical = lexical;
  }
}

function token(value: unknown): string {
  if (value instanceof EtaDecimal) return JSON.stringify(value.lexical);
  if (value === null) return '"null"';
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("ETA JSON cannot contain non-finite numbers");
    }
    return JSON.stringify(String(value));
  }
  throw new TypeError("ETA serialization contains an unsupported simple value");
}

export function serializeEtaJson(value: unknown): string {
  const seen = new Set<object>();
  const encode = (v: unknown, memberName?: string): string => {
    if (v === undefined) return "";
    if (v === null || typeof v !== "object" || v instanceof EtaDecimal) return token(v);
    if (seen.has(v)) throw new TypeError("ETA serialization cannot contain circular values");
    seen.add(v);
    let result = "";
    if (Array.isArray(v)) {
      // The array's property name precedes the array and every element.
      if (memberName !== undefined) result += JSON.stringify(memberName.toUpperCase());
      for (const item of v) {
        if (memberName !== undefined) result += JSON.stringify(memberName.toUpperCase());
        result += encode(item);
      }
    } else {
      for (const [name, child] of Object.entries(v as Record<string, unknown>)) {
        if (child === undefined) continue;
        result += JSON.stringify(name.toUpperCase());
        result += encode(child, name);
      }
    }
    seen.delete(v);
    return result;
  };
  return encode(value);
}

/** Punctuation-preserving JSON for submission; EtaDecimal keeps its scale. */
export function serializeEtaJsonWire(value: unknown): string {
  const seen = new Set<object>();
  const encode = (v: unknown): string => {
    if (v === undefined) return "";
    if (v instanceof EtaDecimal) return v.lexical;
    if (v === null || typeof v !== "object") {
      if (typeof v === "number" && !Number.isFinite(v)) throw new TypeError("non-finite number");
      return JSON.stringify(v);
    }
    if (seen.has(v)) throw new TypeError("JSON cannot contain circular values");
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) result = `[${v.map(encode).join(",")}]`;
    else result = `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}:${encode(x)}`).join(",")}}`;
    seen.delete(v);
    return result;
  };
  return encode(value);
}

export interface EtaCadesResult {
  /** Base64 DER CMS SignedData, with no embedded document bytes. */
  signature: string;
  serializedDocument: string;
  documentDigest: string;
}

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  contentType: "1.2.840.113549.1.9.3",
  signingTime: "1.2.840.113549.1.9.5",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
} as const;

const asn = forge.asn1;
const seq = (...v: forge.asn1.Asn1[]) => asn.create(asn.Class.UNIVERSAL, asn.Type.SEQUENCE, true, v);
const set = (...v: forge.asn1.Asn1[]) => asn.create(asn.Class.UNIVERSAL, asn.Type.SET, true, v);
const oid = (v: string) => asn.create(asn.Class.UNIVERSAL, asn.Type.OID, false, asn.oidToDer(v).getBytes());
const octets = (v: Buffer) => asn.create(asn.Class.UNIVERSAL, asn.Type.OCTETSTRING, false, v.toString("binary"));
const integer = (v: Buffer) => asn.create(asn.Class.UNIVERSAL, asn.Type.INTEGER, false, v.toString("binary"));
const nullValue = () => asn.create(asn.Class.UNIVERSAL, asn.Type.NULL, false, "");
const context = (tag: number, children: forge.asn1.Asn1[], constructed = true) =>
  asn.create(asn.Class.CONTEXT_SPECIFIC, tag, constructed, children);
const der = (v: forge.asn1.Asn1) => Buffer.from(asn.toDer(v).getBytes(), "binary");

function certParts(certPem: string) {
  const cert = new X509Certificate(certPem);
  const derBytes = Buffer.from(cert.raw);
  const parsed = asn.fromDer(derBytes.toString("binary"));
  const tbs = (parsed.value as forge.asn1.Asn1[])[0];
  const items = tbs.value as forge.asn1.Asn1[];
  const offset = items[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  return { derBytes, parsed, issuer: items[offset + 2], serial: items[offset], publicKey: cert.publicKey };
}

function attribute(type: string, value: forge.asn1.Asn1): forge.asn1.Asn1 {
  return seq(oid(type), set(value));
}

function signingAttributes(document: Buffer, certDer: Buffer): forge.asn1.Asn1 {
  const digest = createHash("sha256").update(document).digest();
  const certHash = createHash("sha256").update(certDer).digest();
  const signingTime = new Date();
  // CMS requires DER SET OF sorting.  forge's ASN.1 SET flag does not sort.
  const attrs = [
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octets(digest)),
    attribute(OID.signingTime, asn.create(asn.Class.UNIVERSAL, asn.Type.UTCTIME, false, asn.dateToUtcTime(signingTime))),
    attribute(OID.signingCertificateV2, seq(seq(octets(certHash)))),
  ];
  attrs.sort((a, b) => Buffer.compare(der(a), der(b)));
  return set(...attrs);
}

/** Create the detached CAdES-BES profile required by ETA. RSA keys are required. */
export function signEtaCadesBes(
  document: unknown,
  certificatePem: string,
  privateKeyPem: string,
  privateKeyPassphrase?: string,
): EtaCadesResult {
  const serializedDocument = typeof document === "string" ? document : serializeEtaJson(document);
  const bytes = Buffer.from(serializedDocument, "utf8");
  const cert = certParts(certificatePem);
  if (cert.publicKey.asymmetricKeyType !== "rsa") {
    throw new Error("ETA CAdES-BES signer supports RSA certificates only");
  }
  const attrs = signingAttributes(bytes, cert.derBytes);
  const attrsDer = der(attrs);
  const signer = createSign("RSA-SHA256");
  signer.update(attrsDer);
  const signature = signer.sign(privateKeyPassphrase
    ? { key: privateKeyPem, passphrase: privateKeyPassphrase }
    : privateKeyPem);
  const signerInfo = seq(
    integer(Buffer.from([1])),
    seq(cert.issuer, integer(Buffer.from(cert.serial.value as string, "binary"))),
    seq(oid(OID.sha256), nullValue()),
    context(0, (attrs.value as forge.asn1.Asn1[])),
    seq(oid(OID.rsaEncryption), nullValue()),
    octets(signature),
  );
  const signedData = seq(
    integer(Buffer.from([1])),
    set(seq(oid(OID.sha256), nullValue())),
    seq(oid(OID.data)), // detached: no [0] eContent
    context(0, [cert.parsed]),
    set(signerInfo),
  );
  const contentInfo = seq(oid(OID.signedData), context(0, [signedData]));
  return {
    signature: der(contentInfo).toString("base64"),
    serializedDocument,
    documentDigest: createHash("sha256").update(bytes).digest("base64"),
  };
}

/** Locally verify the CMS signature and its detached document digest. */
export function verifyEtaCadesBes(document: string, signatureB64: string, certificatePem: string): boolean {
  const outer = asn.fromDer(Buffer.from(signatureB64, "base64").toString("binary"));
  const signedData = ((outer.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0];
  const values = signedData.value as forge.asn1.Asn1[];
  const signerInfo = (values[values.length - 1].value as forge.asn1.Asn1[])[0];
  const si = signerInfo.value as forge.asn1.Asn1[];
  const attrSet = si[3];
  const signature = Buffer.from((si[5].value as string), "binary");
  const attrsDer = der(set(...(attrSet.value as forge.asn1.Asn1[])));
  const verify = createVerify("RSA-SHA256");
  verify.update(attrsDer);
  if (!verify.verify(certificatePem, signature)) return false;
  const expected = createHash("sha256").update(Buffer.from(document, "utf8")).digest("hex");
  for (const attr of attrSet.value as forge.asn1.Asn1[]) {
    const av = attr.value as forge.asn1.Asn1[];
    if (asn.derToOid(av[0].value as string) === OID.messageDigest) {
      const got = Buffer.from(((av[1].value as forge.asn1.Asn1[])[0].value as string), "binary").toString("hex");
      return got === expected;
    }
  }
  return false;
}