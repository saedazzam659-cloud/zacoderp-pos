import { test } from "node:test";
import assert from "node:assert/strict";
import { agentDbPoolMax, parseAgentDbPoolOverrides } from "../src/lib/agentDbPoolConfig.ts";

test("agent DB pool override is scoped to the selected agent", () => {
  const overrides = parseAgentDbPoolOverrides("2=20,7=12");
  assert.equal(agentDbPoolMax(2, 10, overrides), 20);
  assert.equal(agentDbPoolMax(7, 10, overrides), 12);
  assert.equal(agentDbPoolMax(3, 10, overrides), 10);
});

test("invalid, zero, and excessive agent DB pool overrides are ignored", () => {
  const overrides = parseAgentDbPoolOverrides("0=20,2=0,3=101,nope,4=8=9,5=15");
  assert.deepEqual([...overrides], [[5, 15]]);
});
