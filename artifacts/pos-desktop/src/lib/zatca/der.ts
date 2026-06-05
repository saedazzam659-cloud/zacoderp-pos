// Minimal ASN.1 DER encoder + decoder for ZATCA (Task #233).
//
// The cloud generates the CSR by shelling out to `openssl` and parses the CSID
// certificate's issuer/serial with `node-forge`. Neither is available in the
// Tauri webview, so this module provides just enough DER to:
//   • ENCODE a PKCS#10 CSR (see csr.ts), and
//   • DECODE an X.509 certificate's issuer DN + serial number (see xades.ts).
//
// It is deliberately tiny and only handles the constructs ZATCA actually uses
// (SEQUENCE, SET, INTEGER, OID, the string types, BIT STRING, OCTET STRING,
// and implicit context tags). Lengths use definite-form per DER.

import { utf8ToBytes, bytesToHex } from "./crypto";

// ─── Encoding ────────────────────────────────────────────────────────
function encodeLen(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Wrap `content` in a TLV with the given tag byte. */
export function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.of(tag), encodeLen(content.length), content]);
}

export function derSeq(...items: Uint8Array[]): Uint8Array {
  return tlv(0x30, concatBytes(items));
}
export function derSet(...items: Uint8Array[]): Uint8Array {
  return tlv(0x31, concatBytes(items));
}
/** INTEGER from a non-negative small integer (used for CSR version = 0). */
export function derIntFromBytes(bytes: Uint8Array): Uint8Array {
  return tlv(0x02, bytes);
}
export function derVersionZero(): Uint8Array {
  return tlv(0x02, Uint8Array.of(0x00));
}
export function derUtf8(s: string): Uint8Array {
  return tlv(0x0c, utf8ToBytes(s));
}
export function derPrintable(s: string): Uint8Array {
  return tlv(0x13, utf8ToBytes(s));
}
export function derIA5(s: string): Uint8Array {
  return tlv(0x16, utf8ToBytes(s));
}
export function derOctet(content: Uint8Array): Uint8Array {
  return tlv(0x04, content);
}
export function derBitString(content: Uint8Array): Uint8Array {
  // 0 unused trailing bits.
  return tlv(0x03, concatBytes([Uint8Array.of(0x00), content]));
}
export function derOid(oid: string): Uint8Array {
  const arcs = oid.split(".").map((x) => parseInt(x, 10));
  if (arcs.length < 2) throw new Error(`invalid OID: ${oid}`);
  const body: number[] = [40 * arcs[0] + arcs[1]];
  for (let i = 2; i < arcs.length; i++) {
    let v = arcs[i];
    const stack = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    body.push(...stack);
  }
  return tlv(0x06, Uint8Array.from(body));
}
/** Implicit context tag. `constructed` chooses the 0x20 bit. */
export function derContext(tagNum: number, constructed: boolean, content: Uint8Array): Uint8Array {
  const tag = 0x80 | (constructed ? 0x20 : 0x00) | tagNum;
  return tlv(tag, content);
}

// ─── Decoding (just enough for X.509 issuer/serial) ──────────────────
export interface DerNode {
  tag: number;
  contentStart: number;
  contentEnd: number;
  end: number;
}

export function readNode(buf: Uint8Array, off: number): DerNode {
  const tag = buf[off];
  let i = off + 1;
  let len = buf[i++];
  if (len & 0x80) {
    const num = len & 0x7f;
    len = 0;
    for (let k = 0; k < num; k++) len = len * 256 + buf[i++];
  }
  const contentStart = i;
  const contentEnd = i + len;
  return { tag, contentStart, contentEnd, end: contentEnd };
}

export function readChildren(buf: Uint8Array, node: DerNode): DerNode[] {
  const out: DerNode[] = [];
  let o = node.contentStart;
  while (o < node.contentEnd) {
    const c = readNode(buf, o);
    out.push(c);
    o = c.end;
  }
  return out;
}

export function decodeOid(buf: Uint8Array, node: DerNode): string {
  const c = buf.subarray(node.contentStart, node.contentEnd);
  const first = c[0];
  const arcs: number[] = [Math.floor(first / 40), first % 40];
  let v = 0;
  for (let i = 1; i < c.length; i++) {
    v = v * 128 + (c[i] & 0x7f);
    if (!(c[i] & 0x80)) {
      arcs.push(v);
      v = 0;
    }
  }
  return arcs.join(".");
}

/** Decode a DER INTEGER node as a non-negative decimal string. */
export function decodeIntDecimal(buf: Uint8Array, node: DerNode): string {
  const bytes = buf.subarray(node.contentStart, node.contentEnd);
  const hex = bytesToHex(bytes) || "0";
  return BigInt("0x" + hex).toString(10);
}
