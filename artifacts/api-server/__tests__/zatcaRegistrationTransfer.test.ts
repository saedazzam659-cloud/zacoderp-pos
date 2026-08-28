import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decryptTransferEnvelope, encryptTransferEnvelope, transferGateError,
  validateTransferEnvelope, chooseZatcaChain, hasFrozenTransferBinding,
  mayCompleteExpiredTransfer, hasActivatedTransferBinding, completionChainAllowed,
} from "../src/lib/zatcaRegistrationTransfer.js";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-at-least-sixteen";
const target = { agentId: 3, installationId: "install-3", dbFingerprint: "fingerprint-3", companyId: 9 };
const envelope = () => ({
  version: 1 as const, sourceCompanyId: 1, vatNumber: "310123456700003", environment: "sandbox",
  target, credentials: { zatcaPrivateKey: "private", zatcaPcsidToken: "token", zatcaPcsidSecret: "secret" },
  chain: { icv: 4, pih: "hash" }, nonce: "nonce", issuedAt: new Date(Date.now() - 1000).toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
test("chain resolver preserves the highest seed and deterministic accepted tie", () => {
  assert.deepEqual(chooseZatcaChain({ icv: 12, pih: "seed" }, { icv: 3, hash: "old" }), { maxIcv: 12, previousInvoiceHash: "seed" });
  assert.deepEqual(chooseZatcaChain({ icv: 12, pih: "seed" }, { icv: 12, hash: "accepted" }), { maxIcv: 12, previousInvoiceHash: "accepted" });
});
test("registration envelope is authenticated and target-bound", () => {
  const blob = encryptTransferEnvelope(envelope());
  assert.equal(decryptTransferEnvelope(blob, target).sourceCompanyId, 1);
  assert.throws(() => decryptTransferEnvelope(blob, { ...target, companyId: 10 }));
  assert.throws(() => decryptTransferEnvelope({ ...blob, ciphertext: blob.ciphertext.slice(1) + "A" }, target));
});
test("registration envelope rejects expiry and submission gate states", () => {
  const expired = { ...envelope(), expiresAt: new Date(Date.now() - 1).toISOString() };
  assert.throws(() => validateTransferEnvelope(expired));
  assert.equal(transferGateError("active"), null);
  assert.ok(transferGateError("frozen"));
  assert.ok(transferGateError("moved"));
});
test("prepare requires exact frozen bindings on both parties and expiry only permits recovery", () => {
  const frozen = { zatcaTransferState: "frozen", zatcaTransferId: "t1", zatcaTransferTargetBinding: "b1" };
  assert.equal(hasFrozenTransferBinding(frozen, "t1", "b1"), true);
  assert.equal(hasFrozenTransferBinding({ ...frozen, zatcaTransferId: "other" }, "t1", "b1"), false);
  const expired = new Date(Date.now() - 1000);
  assert.equal(mayCompleteExpiredTransfer(expired, false), false);
  assert.equal(mayCompleteExpiredTransfer(expired, true), true);
  assert.equal(hasActivatedTransferBinding({ zatcaTransferState: "active", zatcaTransferId: "t1", zatcaTransferTargetBinding: "b1" }, "t1", "b1"), true);
  assert.equal(hasActivatedTransferBinding({ zatcaTransferState: "active", zatcaTransferId: "t1", zatcaTransferTargetBinding: "other" }, "t1", "b1"), false);
  const activated = { zatcaTransferState: "active", zatcaTransferId: "t1", zatcaTransferTargetBinding: "b1" };
  assert.equal(completionChainAllowed(activated, "t1", "b1", { maxIcv: 15, previousInvoiceHash: "advanced" }, { icv: 12, pih: "snapshot" }), true);
  assert.equal(completionChainAllowed({ ...activated, zatcaTransferState: "frozen" }, "t1", "b1", { maxIcv: 15, previousInvoiceHash: "advanced" }, { icv: 12, pih: "snapshot" }), false);
});
test("all company onboarding and compliance posts are lock-and-gate protected", () => {
  const source = readFileSync(new URL("../src/routes/zatca.ts", import.meta.url), "utf8");
  assert.match(source, /router\.use\("\/companies\/:id"[\s\S]*withZatcaChainLock[\s\S]*assertZatcaSubmissionAllowed/);
  for (const path of ["generate-csr", "compliance", "production-csid", "compliance-check", "auto-compliance-check"]) {
    assert.match(source, new RegExp(`router\\.post\\("/companies/:id/${path}"`));
  }
});