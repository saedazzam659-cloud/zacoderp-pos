import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertControllerTokenMatchesVerifier,
  buildShellControllerSyncScript,
  shellControllerSyncDiagnostic,
} from "../src/lib/shellControllerSync.ts";
import { sha256Verifier } from "../src/lib/agentControllerLinks.ts";

test("controller sync script is cwd-independent, atomic, and does not restart services", () => {
  const secret = "controller-token-that-must-not-be-written-to-the-script";
  const script = buildShellControllerSyncScript({
    controllerOrigins: [
      { platformId: "platform:source-1234", origin: "https://source.example", auth: "license" },
      {
        platformId: "platform:target-1234", origin: "https://target.example",
        auth: "controllerToken", controllerToken: secret,
      },
    ],
    activeControllerId: "platform:source-1234",
    controllerEpoch: 0,
  });

  assert.match(script, /CFG=\/opt\/zacod\/config\.json/);
  assert.match(script, /command -v python3/);
  assert.match(script, /flock -w 30 9/);
  assert.match(script, /os\.replace\(temporary, path\)/);
  assert.match(script, /ZACOD_CONTROLLER_SYNCED/);
  assert.doesNotMatch(script, /\bnode\b|systemctl|cd \/opt\/zacod/);
  assert.doesNotMatch(script, new RegExp(secret));
});

test("controller sync diagnostics identify installation failures and redact secrets", () => {
  assert.equal(
    shellControllerSyncDiagnostic(70, "ZACOD_CONTROLLER_CONFIG_MISSING"),
    "agent_controller_config_missing",
  );
  assert.equal(
    shellControllerSyncDiagnostic(71, "ZACOD_CONTROLLER_PYTHON_MISSING"),
    "agent_python_runtime_missing",
  );
  assert.equal(
    shellControllerSyncDiagnostic(73, "ZACOD_CONTROLLER_CONFIG_BUSY"),
    "agent_controller_config_busy",
  );
  const detail = shellControllerSyncDiagnostic(1, "token=super-secret-controller-token");
  assert.match(detail, /^remote_sync_exit_1:/);
  assert.doesNotMatch(detail, /super-secret-controller-token/);
});

test("controller token verifier is checked before shell config construction", () => {
  const token = "controller-token";
  assert.doesNotThrow(() => assertControllerTokenMatchesVerifier(token, sha256Verifier(token)));
  assert.throws(
    () => assertControllerTokenMatchesVerifier(token, sha256Verifier("different-token")),
    /credentials_unavailable/,
  );
  assert.throws(
    () => assertControllerTokenMatchesVerifier("", sha256Verifier("")),
    /credentials_unavailable/,
  );
});