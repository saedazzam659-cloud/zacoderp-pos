import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(
  new URL("../src/routes/agentInstances.ts", import.meta.url),
  "utf8",
);
const schema = readFileSync(
  new URL("../../../lib/db/src/schema/agentInstances.ts", import.meta.url),
  "utf8",
);
const ensureSchema = readFileSync(
  new URL("../src/lib/ensureSchema.ts", import.meta.url),
  "utf8",
);
const cloudflareDns = readFileSync(
  new URL("../src/lib/cloudflareDns.ts", import.meta.url),
  "utf8",
);

test("automatic domain setup is additive and defaults to manual mode", () => {
  assert.match(schema, /autoDomainSetup:\s*boolean\("auto_domain_setup"\)\.notNull\(\)\.default\(false\)/);
  assert.match(ensureSchema, /auto_domain_setup\s+BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(route, /autoDomainSetup:\s*d\.autoDomainSetup \?\? false/);
  assert.match(route, /autoDomainStatus:\s*d\.autoDomainSetup \? "pending" : "disabled"/);
});

test("public projection never returns provider record ids or lease metadata", () => {
  const projection = route.slice(
    route.indexOf("function publicRow"),
    route.indexOf("const upsertSchema"),
  );
  assert.match(projection, /autoDomainZoneId:\s*_autoZoneId/);
  assert.match(projection, /autoDomainRecordId:\s*_autoRecordId/);
  assert.match(projection, /autoDomainLeaseAt:\s*_autoLeaseAt/);
  assert.match(projection, /deployLeaseId:\s*_deployLeaseId/);
  assert.match(projection, /deployOperationPhase:\s*_deployOperationPhase/);
  assert.match(projection, /deployProviderMutationUntil:\s*_deployProviderMutationUntil/);
  assert.doesNotMatch(projection, /CLOUDFLARE_API_TOKEN\s*:/);
});

test("preview confirmation is signed, short lived, and bound to the exact plan", () => {
  assert.match(route, /Date\.now\(\) \+ 15 \* 60_000/);
  assert.match(route, /hmacSign\(`auto-domain:\$\{body\}`\)/);
  assert.match(route, /timingSafeEqual\(a, b\)/);
  assert.match(route, /payload\.domain === inst\.domain/);
  assert.match(route, /payload\.originIp === plan\.originIp/);
  assert.match(route, /payload\.zoneId === plan\.zoneId/);
  assert.match(route, /payload\.existingRecordId === plan\.existingRecordId/);
  assert.match(route, /payload\.existingContent === plan\.existingContent/);
});

test("automatic path shares the deployment lease and never silently stops web servers", () => {
  assert.match(route, /eq\(agentInstancesTable\.deployStatus, "deploying"\)/);
  assert.match(route, /autoDomainLeaseAt:\s*leaseAt/);
  assert.match(route, /الوضع الآلي الآمن لا يوقف خدمات قائمة/);
  assert.match(route, /safeWebServerMode:\s*true/);
  assert.match(route, /لن يتم إيقافها تلقائيًا/);
  assert.match(route, /خدمة Caddy الحالية غير مُدارة/);
});

test("shared deploy lease is fenced by operation id and is never age-stolen", () => {
  assert.match(schema, /deployLeaseId:\s*text\("deploy_lease_id"\)/);
  assert.match(ensureSchema, /ADD COLUMN IF NOT EXISTS deploy_lease_id TEXT/);
  assert.match(route, /deployLeaseId:\s*operationId/);
  assert.match(route, /eq\(agentInstancesTable\.deployLeaseId, operationId\)/);
  assert.match(route, /deployLeaseId:\s*null/);
  assert.doesNotMatch(
    route,
    /or\(ne\(agentInstancesTable\.deployStatus,\s*"deploying"\),\s*lt\(agentInstancesTable\.updatedAt/,
  );
});

test("target edits and deletion are fenced while an operation owns the agent", () => {
  const updateRoute = route.slice(
    route.indexOf('router.put("/:id"'),
    route.indexOf('// DELETE /api/admin/agent-instances/:id'),
  );
  assert.match(updateRoute, /existing\.deployStatus === "deploying"/);
  assert.match(updateRoute, /ne\(agentInstancesTable\.deployStatus, "deploying"\)/);

  const deleteRoute = route.slice(
    route.indexOf('router.delete("/:id"'),
    route.indexOf('// ── External DB'),
  );
  assert.match(deleteRoute, /existing\.deployStatus === "deploying"/);
  assert.match(deleteRoute, /ne\(agentInstancesTable\.deployStatus, "deploying"\)/);
});

test("apply and provision take the fence before the authoritative re-plan", () => {
  const applyRoute = route.slice(
    route.indexOf('router.post("/:id/auto-domain/apply"'),
    route.indexOf('// POST /:id/deploy'),
  );
  assert.ok(
    applyRoute.indexOf("deployLeaseId: operationId") < applyRoute.indexOf("replanConfirmedAutoDomain(fresh"),
    "standalone apply must claim before final DNS re-plan",
  );
  assert.ok(
    applyRoute.indexOf("startAgentOperationHeartbeat") < applyRoute.indexOf("replanConfirmedAutoDomain(fresh"),
    "standalone apply must heartbeat throughout its fenced preflight",
  );

  const provisionRoute = route.slice(
    route.indexOf('router.post("/:id/provision"'),
    route.indexOf('// ── حزم التسطيب الخارجية'),
  );
  assert.ok(
    provisionRoute.indexOf("deployLeaseId: operationId") < provisionRoute.indexOf("replanConfirmedAutoDomain(fresh"),
    "provision must claim before final DNS re-plan",
  );
  assert.ok(
    provisionRoute.indexOf("startAgentOperationHeartbeat") < provisionRoute.indexOf("replanConfirmedAutoDomain(fresh"),
    "provision must heartbeat throughout its fenced preflight",
  );
});

test("lost-worker recovery revokes the remote generation before releasing the lease", () => {
  assert.match(route, /startAgentOperationHeartbeat/);
  assert.match(route, /flock -w 30 9/);
  assert.match(route, /ZACOD_CONTROL_FENCE_LOST/);
  assert.match(route, /router\.post\("\/:id\/operation\/recover"/);
  const recovery = route.slice(
    route.indexOf('router.post("/:id/operation/recover"'),
    route.indexOf("/** Persist the TOFU"),
  );
  assert.ok(
    recovery.indexOf("deployLeaseId: recoveryId") < recovery.indexOf("revokeRemoteOperationFence(inst, recoveryId)"),
    "recovery must fence the old DB worker before contacting the host",
  );
  assert.ok(
    recovery.indexOf("revokeRemoteOperationFence(inst, recoveryId)") < recovery.lastIndexOf("deployLeaseId: null"),
    "recovery must revoke the remote generation before releasing the shared lease",
  );
});

test("preview and installed-policy sync cannot race an active operation", () => {
  const preview = route.slice(
    route.indexOf('router.post("/:id/auto-domain/preview"'),
    route.indexOf("// Explicit action for an already-installed agent"),
  );
  assert.match(preview, /inst\.deployStatus === "deploying"/);
  assert.match(preview, /ne\(agentInstancesTable\.deployStatus, "deploying"\)/);

  const updateRoute = route.slice(
    route.indexOf('router.put("/:id"'),
    route.indexOf("// DELETE /api/admin/agent-instances/:id"),
  );
  assert.ok(
    updateRoute.indexOf("deployLeaseId: operationId") < updateRoute.indexOf("syncInstalledAgentSuperadminPolicy"),
    "installed-policy SSH sync must run only after claiming the shared lease",
  );
  assert.match(updateRoute, /initializeRemoteOperationFence\(existing, operationId\)/);
});

test("provider and fail2ban mutations use the same recoverable operation fence", () => {
  assert.match(route, /runFencedProviderMutation\([\s\S]*applyCloudflareARecord/);
  assert.match(route, /runFencedProviderMutation\([\s\S]*updateCloudflareProxy/);
  assert.match(route, /deployOperationPhase:\s*"provider_mutation"/);
  assert.match(route, /deployProviderMutationUntil:\s*providerUntil/);
  assert.match(route, /router\.post\("\/:id\/unban"[\s\S]*sshRunOperationScript\(inst, operationId, unbanScript/);
  assert.match(cloudflareDns, /new AbortController\(\)/);
  assert.match(cloudflareDns, /controller\.abort\(\), 25_000/);
});

test("manual setup-kit callers keep their pre-existing behavior", () => {
  // The manual download and SSH deploy routes still call buildSetupKit without
  // safeWebServerMode, while automatic setup opts into the stricter branch.
  const plainCalls = route.match(/buildSetupKit\(inst\)/g) ?? [];
  assert.ok(plainCalls.length >= 2, "manual setup/deploy callers must remain");
  assert.match(route, /buildSetupKit\(inst, \{ safeWebServerMode: true \}\)/);
});

test("only supported local firewalls receive narrow HTTP/HTTPS rules", () => {
  const start = route.indexOf("async function openAutoDomainWebPorts");
  const end = route.indexOf("function autoDomainWaitConfig", start);
  const script = route.slice(start, end);
  assert.match(script, /ufw allow 80\/tcp/);
  assert.match(script, /ufw allow 443\/tcp/);
  assert.match(script, /--add-service=http/);
  assert.match(script, /--add-service=https/);
  assert.doesNotMatch(script, /iptables/);
  assert.doesNotMatch(script, /0\.0\.0\.0\/0/);
});

test("provider credentials are runtime-only and never accepted by agent upsert", () => {
  const upsert = route.slice(
    route.indexOf("const upsertSchema"),
    route.indexOf("router.post(\"/\","),
  );
  assert.doesNotMatch(upsert, /cloudflareToken/i);
  assert.doesNotMatch(upsert, /apiToken/i);
  assert.match(route, /isCloudflareDnsConfigured\(\)/);
});