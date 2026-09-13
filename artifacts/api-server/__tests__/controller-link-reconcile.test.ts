import { test } from "node:test";
import assert from "node:assert/strict";
import { decideControllerLinkReconcile } from "../src/lib/controllerLinkReconcile.ts";

const expected = { epoch: 0, active: "platform:source-1234" };

test("reconcile selects one verified winner and only explicit absences", () => {
  const decision = decideControllerLinkReconcile([
    { linkId: "paired", status: 200, ok: true, controllerEpoch: expected.epoch, activeControllerId: expected.active },
    { linkId: "absent", status: 403, ok: false, error: "controller_link_not_found" },
  ], expected.epoch, expected.active);
  assert.deepEqual(decision, { kind: "reconcile", winnerLinkId: "paired", deleteLinkIds: ["absent"] });
});

test("reconcile blocks multiple verified winners", () => {
  const decision = decideControllerLinkReconcile([
    { linkId: "one", status: 200, ok: true, controllerEpoch: 0, activeControllerId: expected.active },
    { linkId: "two", status: 200, ok: true, controllerEpoch: 0, activeControllerId: expected.active },
  ], expected.epoch, expected.active);
  assert.deepEqual(decision, { kind: "ambiguous", winnerLinkIds: ["one", "two"] });
});

test("reconcile never treats network errors or identity failures as absence", () => {
  const network = decideControllerLinkReconcile([
    { linkId: "paired", status: 200, ok: true, controllerEpoch: 0, activeControllerId: expected.active },
    { linkId: "unknown", status: 0, ok: false, error: "target_readback_unavailable" },
  ], expected.epoch, expected.active);
  assert.deepEqual(network, { kind: "unproven", unknownLinkIds: ["unknown"] });

  const identityMismatch = decideControllerLinkReconcile([
    { linkId: "paired", status: 200, ok: true, controllerEpoch: 0, activeControllerId: expected.active },
    { linkId: "unknown", status: 403, ok: false, error: "controller_identity_mismatch" },
  ], expected.epoch, expected.active);
  assert.deepEqual(identityMismatch, { kind: "unproven", unknownLinkIds: ["unknown"] });
});

test("reconcile rejects a verified readback at the wrong epoch or leader", () => {
  const decision = decideControllerLinkReconcile([
    { linkId: "wrong-epoch", status: 200, ok: true, controllerEpoch: 1, activeControllerId: expected.active },
    { linkId: "absent", status: 403, ok: false, error: "controller_link_not_found" },
  ], expected.epoch, expected.active);
  assert.deepEqual(decision, { kind: "no_verified_pair" });
});