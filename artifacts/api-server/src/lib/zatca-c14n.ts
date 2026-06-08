/**
 * ZATCA-correct XML Canonicalization (C14N 1.1, inclusive) helpers.
 *
 * ZATCA recomputes every digest/signature over the CANONICAL form of the XML,
 * not over the raw serialized template strings. The previous pipeline hashed
 * the raw strings, which produced three rejections during the compliance test:
 *   • invalid-invoice-hash        — Reference#1 DigestValue was a plain sha256
 *                                   of the whole (QR-containing) string instead
 *                                   of sha256(C14N(invoice with the 3 enveloped-
 *                                   signature transforms applied)).
 *   • signed-properties-hashing   — Reference#2 DigestValue was sha256 of the
 *                                   raw <xades:SignedProperties> template, but
 *                                   ZATCA canonicalizes that node IN CONTEXT,
 *                                   which inlines ALL in-scope namespaces on its
 *                                   apex (the 9 declared on <Invoice>).
 *   • signature-method            — SignatureValue signed the raw <ds:SignedInfo>
 *                                   template; ZATCA verifies over C14N(SignedInfo)
 *                                   (CanonicalizationMethod = c14n11, inclusive),
 *                                   which likewise inlines all in-scope namespaces.
 *
 * Inclusive C14N (unlike exclusive) renders EVERY in-scope namespace on the apex
 * of the canonicalized subset — including the unused default namespace
 * (xmlns="…Invoice-2"). `xml-crypto`'s C14nCanonicalization does this correctly
 * ONLY when the ancestor namespaces are supplied via `findAncestorNs`; calling it
 * with empty options silently drops them. That subtlety was the whole bug.
 */
import { DOMParser } from "@xmldom/xmldom";
import { select } from "xpath";
import { C14nCanonicalization, findAncestorNs } from "xml-crypto";

/** The 9 namespaces declared on the ZATCA <Invoice> root (must match generateZatcaXml). */
const ZATCA_NS = {
  default: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  ext: "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
  sig: "urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2",
  sac: "urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2",
  sbc: "urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2",
  xades: "http://uri.etsi.org/01903/v1.3.2#",
  ds: "http://www.w3.org/2000/09/xmldsig#",
} as const;

const CAC_NS = ZATCA_NS.cac;

/** Root element declaring all 9 namespaces — used to reproduce in-context scope. */
const ROOT_DECL =
  `xmlns="${ZATCA_NS.default}" xmlns:cac="${ZATCA_NS.cac}" xmlns:cbc="${ZATCA_NS.cbc}" ` +
  `xmlns:ext="${ZATCA_NS.ext}" xmlns:sig="${ZATCA_NS.sig}" xmlns:sac="${ZATCA_NS.sac}" ` +
  `xmlns:sbc="${ZATCA_NS.sbc}" xmlns:xades="${ZATCA_NS.xades}" xmlns:ds="${ZATCA_NS.ds}"`;

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
  removeAll(`//*[local-name()='Signature' and namespace-uri()='${CAC_NS}']`);
  removeAll(
    "//*[local-name()='AdditionalDocumentReference']" +
      "[*[local-name()='ID' and normalize-space(text())='QR']]",
  );

  const root = (doc as unknown as { documentElement: Node }).documentElement;
  return String(new C14nCanonicalization().process(root, {}));
}

/**
 * Canonicalize a self-contained XAdES fragment (e.g. <xades:SignedProperties> or
 * <ds:SignedInfo>) exactly as it will be canonicalized inside the final signed
 * document. C14N output depends only on the node's own subtree plus the
 * namespaces in scope, so wrapping the fragment under a synthetic root that
 * declares the same 9 namespaces yields byte-identical output to what ZATCA
 * recomputes from the assembled invoice.
 *
 * @param fragmentXml the raw fragment XML (the same string embedded in the doc)
 * @param localName   the local-name of the fragment's apex element to select
 */
const IN_CONTEXT_FRAGMENTS = ["SignedProperties", "SignedInfo"] as const;
type InContextFragment = (typeof IN_CONTEXT_FRAGMENTS)[number];

export function canonicalizeInContext(fragmentXml: string, localName: InContextFragment): string {
  if (!IN_CONTEXT_FRAGMENTS.includes(localName)) {
    throw new Error(`canonicalizeInContext: unsupported fragment '${localName}'`);
  }
  const wrapped = `<Invoice ${ROOT_DECL}>${fragmentXml}</Invoice>`;
  const doc = new DOMParser().parseFromString(wrapped, "text/xml");
  if (!(doc as unknown as { documentElement?: unknown }).documentElement) {
    throw new Error(`canonicalizeInContext: failed to parse <${localName}> fragment`);
  }
  const expr = `//*[local-name()='${localName}']`;
  const result = select(expr, doc as unknown as Node);
  const node = (Array.isArray(result) ? result[0] : result) as unknown as Node | undefined;
  if (!node) {
    throw new Error(`canonicalizeInContext: <${localName}> not found in fragment`);
  }
  const ancestorNamespaces = findAncestorNs(doc as unknown as Document, expr);
  return String(new C14nCanonicalization().process(node, { ancestorNamespaces }));
}
