import assert from 'node:assert/strict';
import test from 'node:test';
import { branchWarehouses, formScope, positiveId, referenceList, requiredReference, selectedBranch, selectedWarehouse } from './formReferences';

test('query scope separates two domains with identical numeric company/user/document IDs', async () => {
  const central = await formScope(7, 2, 4, async () => 'zacoderp.com', () => 4);
  const agent = await formScope(7, 2, 4, async () => 'agent.example.com', () => 4);
  assert.notDeepEqual(['sales-invoice', central, 10], ['sales-invoice', agent, 10]);
  await assert.rejects(formScope(7, 2, 4, async () => 'agent.example.com', () => 5), /تغيّرت جلسة/);
});

test('branch selection uses only fetched authorized branches, never an auth map ID', () => {
  assert.equal(selectedBranch([{ id: 2, isDefault: true }], null), 2);
  assert.equal(selectedBranch([], null), null);
  assert.equal(selectedBranch([{ id: 2 }], 9, 9), 9); // locked historical label until explicitly changed
  assert.equal(positiveId('0'), null);
  assert.equal(positiveId('2.5'), null);
});

test('warehouse is selected only from the chosen branch; branch change cannot reuse prior warehouse', () => {
  const all = [{ id: 11, branchId: 1, isDefault: true }, { id: 22, branchId: 2 }];
  assert.deepEqual(branchWarehouses(all, 2).map((x) => x.id), [22]);
  assert.equal(selectedWarehouse(branchWarehouses(all, 2), null), 22);
  assert.equal(selectedWarehouse(branchWarehouses(all, 2), 11), 22);
  assert.deepEqual(branchWarehouses([{ id: 3, branchId: null }], 1), []);
});

test('failed/unexpected reference arrays cannot be treated as empty success or saveable', async () => {
  await assert.rejects(referenceList('/api/org/branches', async () => ({ branches: [] })), /استجابة/);
  await assert.rejects(referenceList('/api/org/branches', async () => { throw new Error('403'); }), /403/);
  assert.match(requiredReference('الفروع', false, Error('403'), undefined), /403/);
  assert.match(requiredReference('الفروع', true, null, undefined), /انتظر/);
  assert.equal(requiredReference('الفروع', false, null, []), '');
});

test('existing historical reference is not silently replaced before edit hydration', () => {
  const branches = [{ id: 1 }];
  assert.equal(selectedBranch(branches, null, 8), 8);
  assert.equal(selectedBranch(branches, 1, 8), 1);
  assert.equal(selectedWarehouse([{ id: 4, branchId: 1 }], 8), 4);
});