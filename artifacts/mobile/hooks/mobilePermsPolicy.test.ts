import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
// Require the .ts source so Node's type-strip test runner can resolve it without a bundler.
const require = createRequire(import.meta.url);
const { effectiveMobilePermission, mobilePermsQueryKey, normalizeMe, verifiedMeForSession } = require('./mobilePermsPolicy.ts') as typeof import('./mobilePermsPolicy');

const ordinary = 'customer_statement_view';
const detailed = 'customer_statement_detailed_view';
const identity = { id: 7, companyId: 3, role: 'user' };

test('direct and wrapped /me responses both normalize', () => {
  const payload = { ...identity, mobilePermissions: { [ordinary]: true, [detailed]: false } };
  assert.deepEqual(normalizeMe(payload), payload);
  assert.deepEqual(normalizeMe({ user: payload }), payload);
  assert.equal(effectiveMobilePermission(identity, normalizeMe({ user: payload }), true, ordinary), true);
  assert.equal(effectiveMobilePermission(identity, normalizeMe(payload), true, detailed), false);
});

test('fresh null is authoritative over an earlier false, absent keys remain allowed', () => {
  const previouslyDenied = { ...identity, mobilePermissions: { [ordinary]: false } };
  const fresh = normalizeMe({ ...identity, mobilePermissions: null });
  assert.equal(effectiveMobilePermission(previouslyDenied, fresh, true, ordinary), true);
  assert.equal(effectiveMobilePermission(identity, normalizeMe(identity), true, ordinary), true);
  assert.equal(effectiveMobilePermission(identity, normalizeMe({ ...identity, mobilePermissions: { [detailed]: false } }), true, ordinary), true);
});

test('explicit false hides statements; initial failed refresh cannot grant access', () => {
  const fresh = normalizeMe({ ...identity, mobilePermissions: { [ordinary]: false, [detailed]: false } });
  assert.equal(effectiveMobilePermission(identity, fresh, true, ordinary), false);
  assert.equal(effectiveMobilePermission(identity, fresh, true, detailed), false);
  assert.equal(verifiedMeForSession(identity, null, 0, 5, 5), false);
  assert.equal(effectiveMobilePermission(identity, null, false, ordinary), false);
  assert.equal(effectiveMobilePermission(null, fresh, true, ordinary), false);
  assert.throws(() => normalizeMe({ ok: true }), /هوية/);
});

test('transient refresh failure retains only the previously verified /me permissions', () => {
  const allowed = normalizeMe({ ...identity, mobilePermissions: { [ordinary]: true, [detailed]: false } });
  // React Query preserves dataUpdatedAt + data when a refetch fails.
  const stillVerified = verifiedMeForSession(identity, allowed, 1000, 5, 5);
  assert.equal(stillVerified, true);
  assert.equal(effectiveMobilePermission(identity, allowed, stillVerified, ordinary), true);
  assert.equal(effectiveMobilePermission(identity, allowed, stillVerified, detailed), false);
  assert.equal(verifiedMeForSession(identity, allowed, 0, 5, 5), false);
});

test('response belonging to another user or server company cannot grant rights', () => {
  const allowed = normalizeMe({ ...identity, mobilePermissions: null });
  assert.equal(effectiveMobilePermission({ ...identity, id: 8 }, allowed, true, ordinary), false);
  assert.equal(effectiveMobilePermission({ ...identity, companyId: 4 }, allowed, true, ordinary), false);
  assert.equal(effectiveMobilePermission(identity, allowed, true, ordinary), true);
  assert.equal(verifiedMeForSession({ ...identity, id: 8 }, allowed, 1000, 5, 5), false);
  assert.equal(verifiedMeForSession(identity, allowed, 1000, 5, 6), false);
  assert.notDeepEqual(mobilePermsQueryKey(2, identity), mobilePermsQueryKey(3, identity));
  assert.notDeepEqual(mobilePermsQueryKey(2, identity), mobilePermsQueryKey(2, { ...identity, id: 8 }));
  assert.notDeepEqual(mobilePermsQueryKey(2, identity), mobilePermsQueryKey(2, { ...identity, companyId: 4 }));
});