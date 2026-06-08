/**
 * ZATCA-correct XML Canonicalization (C14N 1.1, inclusive) helpers.
 *
 * ZATCA recomputes every digest/signature over the CANONICAL form of the XML,
 * not over the raw serialized template strings. Hashing/signing raw strings is
 * what produced `invalid-invoice-hash`, `signed-properties-hashing`, and (in
 * combination with a missing cac:Signature) the `signature-method` rejections.
 *
 * TWO DIFFERENT canonicalization SCOPES are required — getting the scope wrong is
 * the whole subtlety:
 *
 *  • Invoice hash (Reference#1, "invoiceSignedData"): computed over the WHOLE
 *    document AFTER the three enveloped-signature transforms (remove
 *    ext:UBLExtensions, cac:Signature, and the QR AdditionalDocumentReference).
 *    Inclusive C14N keeps EVERY in-scope namespace — including the unused default
 *    xmlns — on the <Invoice> apex. The documentElement is the root, so it has no
 *    ancestors → canonicalize with empty options.
 *
 *  • XAdES fragment digests (Reference#2 over <xades:SignedProperties>, and the
 *    SignatureValue over <ds:SignedInfo>): computed over each fragment as a
 *    SELF-CONTAINED element. ZATCA's validator canonicalizes the referenced
 *    element in ISOLATION, so the canonical form contains ONLY the namespaces
 *    declared inside the fragment itself — xades on the SignedProperties apex plus
 *    ds inline on each ds child; ds on the SignedInfo apex — NOT the 9
 *    invoice-root namespaces. The signer templates are authored self-contained
 *    exactly for this. (An earlier attempt wrapped the fragment in the invoice's
 *    9-ns root, which injected 8 phantom namespaces onto the apex and was exactly
 *    what produced `signed-properties-hashing`.)
 */
import { DOMParser } from "@xmldom/xmldom";
import { select } from "xpath";
import { C14nCanonicalization } from "xml-crypto";

/** cac namespace — used to target cac:Signature for removal in the invoice hash. */
const ZATCA_CAC_NS = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";

/**
 * Canonicalize the invoice for the Reference#1 ("invoiceSignedData") digest.
 *
 * Applies ZATCA's three enveloped-signature transforms (remove ext:UBLExtensions,
 * cac:Signature, and the cac:AdditionalDocumentReference whose cbc:ID is "QR"),
 * then inclusive-C14N the whole remaining document. Pass the EMPTY-QR UBL: the QR
 * AdditionalDocumentReference is removed here anyway, so the resulting digest is
 * identical whether or not the Phase-2 QR has been injected yet — which is exactly
 * why the QR can be injected AFTER signing without invalidating the signature.
 */
export function canonicalizeInvoiceForHash(ublXml: string): string {
  const doc = new DOMParser().parseFromString(ublXml, "text/xml");
  if (!(doc as unknown as { documentElement?: unknown }).documentElement) {
    throw new Error("canonicalizeInvoiceForHash: failed to parse invoice XML");
  }

  const removeAll = (expr: string): void => {
    const result = select(expr, doc as unknown as Node);
    const nodes = Array.isArray(result) ? result : [];
    for (const n of nodes) {
      const node = n as unknown as { parentNode?: { removeChild(c: unknown): unknown } | null };
      node.parentNode?.removeChild(n);
    }
  };

  removeAll("//*[local-name()='UBLExtensions']");
  removeAll(`//*[local-name()='Signature' and namespace-uri()='${ZATCA_CAC_NS}']`);
  removeAll(
    "//*[local-name()='AdditionalDocumentReference']" +
      "[*[local-name()='ID' and normalize-space(text())='QR']]",
  );

  const root = (doc as unknown as { documentElement: Node }).documentElement;
  return String(new C14nCanonicalization().process(root, {}));
}

const FRAGMENTS = ["SignedProperties", "SignedInfo"] as const;
type Fragment = (typeof FRAGMENTS)[number];

/**
 * Canonicalize a self-contained XAdES fragment (<xades:SignedProperties> or
 * <ds:SignedInfo>) in ISOLATION, exactly as ZATCA canonicalizes the referenced
 * element when recomputing its digest/signature. The templates declare every
 * namespace they use internally, so inclusive C14N of the parsed fragment on its
 * own yields the byte sequence ZATCA expects (only xades/ds appear, never the
 * invoice-root namespaces).
 *
 * @param fragmentXml the raw fragment XML (the same string embedded in the doc)
 * @param name        which fragment — gates the input to known, trusted shapes
 */
export function canonicalizeFragment(fragmentXml: string, name: Fragment): string {
  if (!FRAGMENTS.includes(name)) {
    throw new Error(`canonicalizeFragment: unsupported fragment '${name}'`);
  }
  const doc = new DOMParser().parseFromString(fragmentXml, "text/xml");
  const root = (doc as unknown as { documentElement?: Node }).documentElement;
  if (!root) {
    throw new Error(`canonicalizeFragment: failed to parse <${name}> fragment`);
  }
  return String(new C14nCanonicalization().process(root, {}));
}
