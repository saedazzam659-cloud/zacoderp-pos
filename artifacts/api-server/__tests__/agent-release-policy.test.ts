import { test } from "node:test";
import assert from "node:assert/strict";
import { isManualAgentReleaseRequest } from "../src/lib/agentReleasePolicy.ts";

test("a central publish is not an automatic full-agent update opt-in", () => {
  for (const value of [undefined, "", "true", "yes", "0", 1]) {
    assert.equal(isManualAgentReleaseRequest(value), false);
  }
  assert.equal(isManualAgentReleaseRequest("1"), true);
});
