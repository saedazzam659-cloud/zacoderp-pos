import { test } from "node:test";
import assert from "node:assert/strict";
import { serveAgentRequestAfterSchemaReady } from "../src/routes/agentInstances.ts";
import { assertStrictSchemaReady } from "../src/lib/ensureSchema.ts";

function responseStub() {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body: any;
  return {
    headers,
    get statusCode() { return statusCode; },
    get body() { return body; },
    setHeader(name: string, value: string) { headers.set(name, value); },
    status(code: number) {
      statusCode = code;
      return { json(value: unknown) { body = value; } };
    },
  };
}

test("agent traffic waits for schema readiness and reconciliation stays single-flight", async () => {
  const agentId = 9_001;
  const ctx = { db: {}, pool: {} };
  let releaseHeal!: () => void;
  const healGate = new Promise<void>((resolve) => {
    releaseHeal = resolve;
  });
  let healCalls = 0;
  let nextCalls = 0;
  let activeContext: unknown;

  const runWithExternalDb = (candidate: unknown, fn: () => unknown) => {
    activeContext = candidate;
    try {
      return fn();
    } finally {
      activeContext = undefined;
    }
  };
  const healRunner = async () => {
    healCalls += 1;
    assert.equal(activeContext, ctx);
    await healGate;
  };

  const firstResponse = responseStub();
  const secondResponse = responseStub();
  const first = serveAgentRequestAfterSchemaReady(agentId, ctx, runWithExternalDb, firstResponse, () => {
    nextCalls += 1;
    assert.equal(activeContext, ctx);
  }, healRunner, 1_000);
  const second = serveAgentRequestAfterSchemaReady(agentId, ctx, runWithExternalDb, secondResponse, () => {
    nextCalls += 1;
    assert.equal(activeContext, ctx);
  }, healRunner, 1_000);

  assert.equal(nextCalls, 0, "requests must not race a pending schema heal");
  assert.equal(healCalls, 1, "concurrent requests must share one schema-heal flight");

  releaseHeal();
  await Promise.all([first, second]);

  assert.equal(nextCalls, 2);
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);

  await serveAgentRequestAfterSchemaReady(agentId, ctx, runWithExternalDb, responseStub(), () => {
    nextCalls += 1;
  }, healRunner, 1_000);
  assert.equal(nextCalls, 3);
  assert.equal(healCalls, 1, "a successful heal remains cached for the process lifetime");
});

test("a slow schema heal returns retryable 503 without running downstream SQL", async () => {
  const agentId = 9_002;
  const ctx = { db: {}, pool: {} };
  const response = responseStub();
  let nextCalls = 0;
  const never = new Promise<void>(() => {});

  await serveAgentRequestAfterSchemaReady(
    agentId,
    ctx,
    (_candidate, fn) => fn(),
    response,
    () => { nextCalls += 1; },
    () => never,
    5,
  );

  assert.equal(nextCalls, 0);
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers.get("Retry-After"), "3");
  assert.equal(response.body?.code, "AGENT_SCHEMA_PREPARING");
});

test("a failed schema heal fails closed and the next request retries", async () => {
  const agentId = 9_003;
  const ctx = { db: {}, pool: {} };
  let healCalls = 0;
  let nextCalls = 0;
  const runWithExternalDb = (_candidate: unknown, fn: () => unknown) => fn();
  const failingHeal = async () => {
    healCalls += 1;
    throw new Error("ddl failed");
  };

  const firstResponse = responseStub();
  await serveAgentRequestAfterSchemaReady(
    agentId, ctx, runWithExternalDb, firstResponse,
    () => { nextCalls += 1; }, failingHeal, 1_000,
  );
  assert.equal(firstResponse.statusCode, 503);
  assert.equal(firstResponse.body?.code, "AGENT_SCHEMA_FAILED");
  assert.equal(nextCalls, 0);

  const secondResponse = responseStub();
  await serveAgentRequestAfterSchemaReady(
    agentId, ctx, runWithExternalDb, secondResponse,
    () => { nextCalls += 1; }, failingHeal, 1_000,
  );
  assert.equal(secondResponse.statusCode, 503);
  assert.equal(healCalls, 2, "failed reconciliation must be retried");
  assert.equal(nextCalls, 0);
});

test("strict schema verification rejects failed DDL and required missing tables", () => {
  assert.throws(
    () => assertStrictSchemaReady({ failures: ["sales_invoices.pos_session_id: lock timeout"] }),
    /schema reconciliation incomplete.*sales_invoices\.pos_session_id/,
  );
  assert.throws(
    () => assertStrictSchemaReady({ failures: [], missingTables: ["sales_invoices"] }),
    /missing tables: sales_invoices/,
  );
});

test("strict schema verification permits only explicitly optional lazy tables", () => {
  assert.doesNotThrow(() => assertStrictSchemaReady({
    failures: [],
    missingTables: ["integration_invoice_queue"],
    optionalMissingTables: ["integration_invoice_queue"],
  }));
});