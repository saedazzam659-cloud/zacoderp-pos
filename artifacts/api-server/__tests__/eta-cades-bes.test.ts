import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  serializeEtaJson,
  serializeEtaJsonWire,
  EtaDecimal,
  signEtaCadesBes,
  verifyEtaCadesBes,
} from "../src/lib/eta-cades-bes.js";

test("ETA serialization emits ETA's quoted token stream in input order", () => {
  const input = {
    z: "last",
    nested: { b: 2, a: true },
    array: [{ z: 1, a: null }, "x"],
    a: "first",
  };
  assert.equal(
    serializeEtaJson(input),
    '"Z""last""NESTED""B""2""A""true""ARRAY""ARRAY""ARRAY""Z""1""A""null""ARRAY""x""A""first"',
  );
  assert.throws(() => serializeEtaJson({ value: Number.NaN }), /non-finite/);
});

test("ETA decimal lexical text is preserved in both canonical and wire forms", () => {
  const value = { Lines: [{ Amount: new EtaDecimal("10.50") }] };
  assert.equal(serializeEtaJson(value), '"LINES""LINES""LINES""AMOUNT""10.50"');
  assert.equal(serializeEtaJsonWire(value), '{"Lines":[{"Amount":10.50}]}');
});

test("ETA CAdES-BES is detached, includes signingCertificateV2, and verifies locally", () => {
  const dir = mkdtempSync(join(tmpdir(), "eta-cades-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1",
      "-subj", "/CN=ETA local test",
    ], { stdio: "ignore" });
    const key = readFileSync(keyPath, "utf8");
    const cert = readFileSync(certPath, "utf8");
    const result = signEtaCadesBes({ b: 2, a: "document" }, cert, key);
    assert.match(result.signature, /^[A-Za-z0-9+/]+=*$/);
    assert.equal(verifyEtaCadesBes(result.serializedDocument, result.signature, cert), true);
    assert.equal(verifyEtaCadesBes(`${result.serializedDocument} `, result.signature, cert), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});