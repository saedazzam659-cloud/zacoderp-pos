import { test } from "node:test";
import assert from "node:assert/strict";
import { serveAgentRequestWhileHealing } from "../src/routes/agentInstances.ts";

test("agent traffic proceeds immediately while schema reconciliation stays single-flight", async () => {
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

  serveAgentRequestWhileHealing(agentId, ctx, runWithExternalDb, () => {
    nextCalls += 1;
    assert.equal(activeContext, ctx);
  }, healRunner);
  serveAgentRequestWhileHealing(agentId, ctx, runWithExternalDb, () => {
    nextCalls += 1;
    assert.equal(activeContext, ctx);
  }, healRunner);

  assert.equal(nextCalls, 2, "requests must not wait for the background schema heal");
  assert.equal(healCalls, 1, "concurrent requests must share one schema-heal flight");

  releaseHeal();
  await healGate;
  await new Promise<void>((resolve) => setImmediate(resolve));

  serveAgentRequestWhileHealing(agentId, ctx, runWithExternalDb, () => {
    nextCalls += 1;
  }, healRunner);
  assert.equal(nextCalls, 3);
  assert.equal(healCalls, 1, "a successful heal remains cached for the process lifetime");
});