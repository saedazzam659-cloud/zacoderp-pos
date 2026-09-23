import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = readFileSync(new URL("../src/routes/agentInstances.ts", import.meta.url), "utf8");
const bootstrap = source.slice(
  source.indexOf("const installScript = `#!/usr/bin/env bash"),
  source.indexOf("return { config, heartbeatScript, caddyfile, installScript };"),
);
function section(start: string, end: string): string {
  const from = bootstrap.indexOf(start);
  const to = bootstrap.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing bootstrap section: ${start}`);
  return bootstrap.slice(from, to);
}
const cron = section("ZACOD_BOOTSTRAP_STAGE=heartbeat-cron", "# حصانة دائمة");
const nodeSetup = section("ZACOD_BOOTSTRAP_STAGE=node\n", "ZACOD_BOOTSTRAP_STAGE=heartbeat-config");
const errorTrap = section("ZACOD_BOOTSTRAP_STAGE=preflight", "${safeSetupGuard}")
  .replaceAll("\\\\n", "\\n");

function bash(script: string, env: Record<string, string> = {}) {
  const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  return spawnSync("bash", ["-c", script], { env: { ...process.env, ...env }, encoding: "utf8" });
}

function runCron(script: string, inheritedPipefail: boolean, env: Record<string, string>) {
  if (!inheritedPipefail) return bash(script, env);
  // Bash reads exported SHELLOPTS when the child starts, not merely via a
  // set -o command in the same shell as the cron expression.
  return bash('set -o pipefail; export SHELLOPTS; bash -c "$CRON_SCRIPT"',
    { ...env, CRON_SCRIPT: script, EXPECT_PIPEFAIL: "1" });
}

test("heartbeat cron survives an empty or heartbeat-only crontab with or without pipefail", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-bootstrap-cron-"));
  try {
    for (const pipefail of [false, true]) {
      for (const prior of [null, "* * * * * /old # zacod-heartbeat\n",
        "0 1 * * * /other # other\n* * * * * /old # zacod-heartbeat\n"]) {
        const input = path.join(dir, "input");
        const output = path.join(dir, "output");
        rmSync(input, { force: true });
        if (prior !== null) writeFileSync(input, prior);
        const script = `set -e
if [ "\${EXPECT_PIPEFAIL:-0}" = 1 ]; then set -o | grep -Eq '^pipefail[[:space:]]+on$'; fi
crontab() {
  if [ "$1" = -l ]; then
    [ -f "$INPUT" ] && cat "$INPUT" || return 1
  else
    cat > "$OUTPUT"
    [ "$FAIL_INSTALL" != 1 ] || return 43
  fi
}
${cron}`;
        const env = { INPUT: input, OUTPUT: output, FAIL_INSTALL: "0" };
        const result = runCron(script, pipefail, env);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(output, "utf8"),
          (prior?.includes("/other") ? "0 1 * * * /other # other\n" : "") +
          "*/5 * * * * /opt/zacod/heartbeat.sh # zacod-heartbeat\n");
        const rejected = runCron(script, pipefail, { ...env, FAIL_INSTALL: "1" });
        assert.equal(rejected.status, 43, "failed crontab install must fail bootstrap");
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NodeSource pipefail is scoped and failures identify only their stage and exit", () => {
  const mocks = `
node() { if [ "$1" = -p ]; then echo 18; else [ "$INSTALLED" = 1 ]; fi; }
curl() { if [ "$FAIL" = download ]; then return 22; fi; printf 'true\\n'; }
apt-get() { if [ "$1" = install ] && [ "$3" = nodejs ]; then
  if [ "$FAIL" = package ]; then return 27; fi
  INSTALLED=1
fi; }
`;
  const script = `set -e
${errorTrap}
${mocks}
${nodeSetup}
set -o | grep '^pipefail'`;
  const ok = bash(script, { FAIL: "none" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /pipefail\s+off/);
  for (const [failure, stage, code] of [
    ["download", "node-repository", 22],
    ["package", "node-package", 27],
  ] as const) {
    const result = bash(script, { FAIL: failure });
    assert.equal(result.status, code);
    assert.match(result.stderr, new RegExp(`bootstrap stage ${stage} failed \\(exit ${code}\\)`));
    assert.doesNotMatch(result.stderr, /BASH_COMMAND|licenseKey|SESSION_SECRET/);
  }
});