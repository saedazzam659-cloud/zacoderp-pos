import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffEligibility, isPublicControllerAddress, mintHandoffToken, verifyHandoffToken } from "../src/lib/controllerHandoff.ts";

test("handoff capability is signed, short lived, and epoch-bound", () => {
  process.env.SESSION_SECRET = "test-session-secret";
  const token = mintHandoffToken({ agentId: 9, targetPlatformId: "platform:target-1234", targetOrigin: "https://target.example", runtimeMode: "preserve", controllerEpoch: 3 }, 1000);
  assert.equal(verifyHandoffToken(token, 1001).controllerEpoch, 3);
  assert.throws(() => verifyHandoffToken(`${token}x`, 1001), /invalid/);
  assert.throws(() => verifyHandoffToken(token, 602_000), /expired/);
  assert.equal(verifyHandoffToken(token, 602_000, true).controllerEpoch, 3);
});
test("eligibility never approves stale, unpinned, or non-central target release agents", () => {
  const base = { status: "active", licenseKey: "x", lastHeartbeatAt: new Date(), dbStatus: "initialized", sshHost: "x", sshUser: "root", sshSecretEnc: "x", sshStatus: "ok", sshHostKeyFp: "SHA256:x", deployStatus: "ok", mode: "full", packageSource: "central" };
  assert.deepEqual(handoffEligibility(base, "target_release"), []);
  const codes = handoffEligibility({ ...base, lastHeartbeatAt: new Date(Date.now() - 300_001), sshHostKeyFp: null, packageSource: "external" }, "target_release").map(x => x.code);
  assert.deepEqual(codes, ["HEARTBEAT_STALE", "SSH_NOT_READY", "TARGET_RELEASE_INELIGIBLE"]);
});
test("controller token transport rejects private, metadata, CGNAT and ULA addresses", () => {
  for (const ip of [
    "0.1.2.3", "127.0.0.1", "169.254.169.254", "10.0.0.1", "172.16.0.1", "192.0.2.1",
    "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "100.64.0.1",
    "224.0.0.1", "240.0.0.1", "::1", "fe80::1", "fd00::1", "2001:db8::1",
    "2001::1", "2001:2::1", "2001:4:112::1", "2001:20::1", "2002::1", "3fff::1", "3fff:0fff::1",
    "2620:4f:8000::1", "100::1", "64:ff9b::1", "::ffff:127.0.0.1",
  ]) assert.equal(isPublicControllerAddress(ip), false, ip);
  assert.equal(isPublicControllerAddress("8.8.8.8"), true);
  assert.equal(isPublicControllerAddress("1.1.1.1"), true);
  assert.equal(isPublicControllerAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicControllerAddress("2001:4860:4860::8888"), true);
  assert.equal(isPublicControllerAddress("::ffff:8.8.8.8"), true);
});