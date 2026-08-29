import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoute = readFileSync(resolve(here, "../src/routes/agentInstances.ts"), "utf8");
const backupRoute = readFileSync(resolve(here, "../src/routes/backup.ts"), "utf8");
const agentUi = readFileSync(
  resolve(here, "../../zatca-invoicing/src/pages/admin/AgentServers.tsx"),
  "utf8",
);

test("agent schema upgrade takes a custom-format backup before reconciliation", () => {
  const start = agentRoute.indexOf("async function runAgentDatabaseSchemaUpgrade");
  const end = agentRoute.indexOf("// POST /:id/schema-upgrade", start);
  const worker = agentRoute.slice(start, end);
  const reconcileStart = agentRoute.indexOf("async function reconcileAgentDatabaseSchema");
  const reconcileEnd = agentRoute.indexOf("async function resumeAgentServiceAfterSchemaUpgrade", reconcileStart);
  const reconcileWorker = agentRoute.slice(reconcileStart, reconcileEnd);

  const backup = worker.indexOf("pg_dump --format=custom --no-owner --no-privileges");
  const reconcile = worker.indexOf("await reconcileAgentDatabaseSchema(inst)");

  assert.ok(backup >= 0, "upgrade worker must create a pg_dump backup");
  assert.ok(reconcile > backup, "schema reconciliation must start only after backup succeeds");
  assert.match(reconcileWorker, /runSchemaHealOnActiveDb[\s\S]*assertAgentSupplierMetadataSchema/);
  assert.match(reconcileWorker, /pg_try_advisory_lock/);
  assert.match(reconcileWorker, /await import\("@workspace\/db"\)/);
  assert.match(reconcileWorker, /await import\("\.\.\/lib\/ensureSchema\.js"\)/);
  assert.doesNotMatch(
    reconcileWorker,
    /\b(createExternalDb|ensureAgentSchemaTable|ensureAndCheckAgentSchemaVersion|computeDbFingerprint)\b/,
    "upgrade reconciliation must not call helpers that are not defined in this module",
  );
  assert.match(reconcileWorker, /SELECT installation_id, fingerprint FROM zacod_installation/);
  assert.match(worker, /test -s "\$BACKUP_FILE"/);
  assert.match(worker, /DATABASE_URL missing from app\.env/);
  assert.match(worker, /remoteIdentity !== agentDatabaseIdentity\(inst\)/);
  assert.match(worker, /PGPASSFILE="\$PASSFILE"/);
  assert.doesNotMatch(worker, /decryptSecret|dbUrlEnc|connection\.password/);
  assert.match(worker, /systemctl stop zacod-app/);
  assert.match(worker, /resumeAgentServiceAfterSchemaUpgrade/);
});

test("agent schema upgrade shares the existing central and remote operation fences", () => {
  const start = agentRoute.indexOf('router.post("/:id/schema-upgrade"');
  const end = agentRoute.indexOf("// ── تعدد السيرفرات", start);
  const route = agentRoute.slice(start, end);

  assert.match(route, /ne\(agentInstancesTable\.deployStatus, "deploying"\)/);
  assert.match(route, /startAgentOperationHeartbeat\(id, operationId\)/);
  assert.match(route, /initializeRemoteOperationFence\(inst, operationId\)/);
  assert.match(route, /dbStatus: "initializing"/);
  assert.match(route, /void runAgentDatabaseSchemaUpgrade\(inst, operationId, stopHeartbeat\)/);
  const recovery = agentRoute.slice(
    agentRoute.indexOf('router.post("/:id/operation/recover"'),
    agentRoute.indexOf("/** Persist the TOFU host-key pin", agentRoute.indexOf('router.post("/:id/operation/recover"')),
  );
  assert.match(recovery, /withAgentSchemaUpgradeLock[\s\S]*revokeRemoteOperationFence[\s\S]*resumeAgentServiceAfterSchemaUpgrade/);
});

test("all full-company restore paths reconcile the active schema before reporting success", () => {
  const portableRestore = backupRoute.slice(
    backupRoute.indexOf('router.post("/portable/restore"'),
    backupRoute.indexOf("/* ─── POST /restore", backupRoute.indexOf('router.post("/portable/restore"')),
  );
  const restoreWorker = backupRoute.slice(
    backupRoute.indexOf("export async function restoreFromSnapshotPayload"),
    backupRoute.indexOf('router.post("/restore"', backupRoute.indexOf("export async function restoreFromSnapshotPayload")),
  );

  assert.match(portableRestore, /restorePortableBackupPackage[\s\S]*runAgentRequestSchemaHealOnActiveDb/);
  assert.equal(
    (restoreWorker.match(/runAgentRequestSchemaHealOnActiveDb\(\)/g) ?? []).length,
    2,
    "v2 and legacy restore branches must both reconcile the active schema",
  );
});

test("agent UI exposes a dedicated confirmed schema-upgrade action", () => {
  assert.match(agentUi, /data-testid={`button-schema-upgrade-\$\{a\.id\}`}/);
  assert.match(agentUi, /data-testid="button-schema-upgrade-confirm"/);
  assert.match(agentUi, /لا تُستعاد قاعدة التطوير/);
  assert.match(agentUi, /لا تُحذف بيانات العملاء أو الفواتير أو المرفقات/);
});