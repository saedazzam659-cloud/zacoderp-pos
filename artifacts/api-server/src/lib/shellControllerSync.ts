import { createHash, timingSafeEqual } from "node:crypto";

export type ShellControllerOrigin = {
  platformId: string;
  origin: string;
  auth: "license" | "controllerToken";
  controllerToken?: string;
};

export type ShellControllerState = {
  controllerOrigins: ShellControllerOrigin[];
  activeControllerId: string;
  controllerEpoch: number;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the only remote mutation used by controller handoff.  This deliberately
 * does not depend on the application cwd or its systemd unit: the heartbeat
 * reads config.json on its next run, so restarting the application could
 * interrupt an unrelated business request.
 */
export function buildShellControllerSyncScript(state: ShellControllerState): string {
  const encodedState = Buffer.from(JSON.stringify(state), "utf8").toString("base64");
  return `set -Eeuo pipefail
umask 077
CFG=/opt/zacod/config.json
test -f "$CFG" || { echo ZACOD_CONTROLLER_CONFIG_MISSING >&2; exit 70; }
command -v python3 >/dev/null 2>&1 || { echo ZACOD_CONTROLLER_PYTHON_MISSING >&2; exit 71; }
command -v flock >/dev/null 2>&1 || { echo ZACOD_CONTROLLER_FLOCK_MISSING >&2; exit 72; }
exec 9>/var/lock/zacod-controller-config.lock
flock -w 30 9 || { echo ZACOD_CONTROLLER_CONFIG_BUSY >&2; exit 73; }
STATE_B64=${shellQuote(encodedState)} CFG="$CFG" python3 - <<'PY'
import base64
import json
import os
import stat
import tempfile

path = os.environ["CFG"]
with open(path, "r", encoding="utf-8") as source:
    old = json.load(source)
if not isinstance(old, dict):
    raise ValueError("controller config must be a JSON object")
add = json.loads(base64.b64decode(os.environ["STATE_B64"]).decode("utf-8"))
if not isinstance(add, dict):
    raise ValueError("controller state must be a JSON object")
old.update(add)

directory = os.path.dirname(path) or "."
old_stat = os.stat(path)
fd, temporary = tempfile.mkstemp(prefix=".config.json.controller-", dir=directory)
try:
    os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
    try:
        os.fchown(fd, old_stat.st_uid, old_stat.st_gid)
    except PermissionError:
        pass
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        json.dump(old, target, indent=2, ensure_ascii=False)
        target.write("\\n")
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary, path)
except BaseException:
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PY
echo ZACOD_CONTROLLER_SYNCED`;
}

/**
 * Remote output is diagnostic input, not a place to echo credentials.  Keep a
 * stable, actionable code for known installation problems and only expose a
 * short redacted tail for other failures.
 */
export function shellControllerSyncDiagnostic(code: number, output: string): string {
  const text = output.replace(/\r/g, "").trim();
  if (text.includes("ZACOD_CONTROLLER_CONFIG_MISSING")) return "agent_controller_config_missing";
  if (text.includes("ZACOD_CONTROLLER_PYTHON_MISSING")) return "agent_python_runtime_missing";
  if (text.includes("ZACOD_CONTROLLER_FLOCK_MISSING")) return "agent_flock_runtime_missing";
  if (text.includes("ZACOD_CONTROLLER_CONFIG_BUSY")) return "agent_controller_config_busy";
  if (/permission denied|operation not permitted|eacces/i.test(text)) {
    return "agent_controller_config_permission_denied";
  }

  const redacted = text
    // Base64/base64url values cover controller tokens and encoded state.
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[REDACTED]")
    .replace(/((?:password|passwd|secret|token|license|credential)[^:=\n]*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(-600);
  return redacted ? `remote_sync_exit_${code}: ${redacted}` : `remote_sync_exit_${code}`;
}

/**
 * Validate that a decrypted token is the one registered for its link before
 * placing it in the agent's shell config.  The token itself is never returned.
 */
export function assertControllerTokenMatchesVerifier(token: string, verifier: string): void {
  const actual = createHash("sha256").update(token, "utf8").digest("hex");
  if (!token || !/^[a-f0-9]{64}$/i.test(verifier)) {
    throw new Error("controller_link_credentials_unavailable");
  }
  const expectedBytes = Buffer.from(verifier, "hex");
  const actualBytes = Buffer.from(actual, "hex");
  if (!timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error("controller_link_credentials_unavailable");
  }
}