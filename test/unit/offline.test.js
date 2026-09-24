'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { offlineUuid, isValidUsername, createOfflineSession } = require('../../src/main/auth/offline');

test('offline UUID matches Java UUID.nameUUIDFromBytes("OfflinePlayer:<name>")', () => {
  // Known values produced by vanilla servers in offline mode
  // (verified with java.util.UUID.nameUUIDFromBytes on Java 17)
  assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
  assert.equal(offlineUuid('Steve'), '5627dd98-e6be-3c21-b8a8-e92344183641');
  assert.equal(offlineUuid('ForjaTester'), 'c49cc91b-38d5-38cc-bad1-81c47931a612');
});

test('offline UUID is version 3, IETF variant, deterministic', () => {
  const u = offlineUuid('ForjaTester');
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(u, offlineUuid('ForjaTester'));
  assert.notEqual(u, offlineUuid('forjatester')); // case-sensitive like vanilla
});

test('username validation', () => {
  assert.equal(isValidUsername('Steve'), true);
  assert.equal(isValidUsername('ab'), false);
  assert.equal(isValidUsername('a'.repeat(17)), false);
  assert.equal(isValidUsername('Игрок'), false);
  assert.equal(isValidUsername('bad name'), false);
});

test('offline session shape', () => {
  const s = createOfflineSession('Steve');
  assert.equal(s.type, 'offline');
  assert.equal(s.uuid.length, 32);
  assert.equal(s.userType, 'legacy');
  assert.throws(() => createOfflineSession('x'), { code: 'INVALID_USERNAME' });
});
