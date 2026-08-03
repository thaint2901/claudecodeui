import assert from 'node:assert/strict';
import test from 'node:test';

import { broadcast, setBroadcastHandler, _resetForTest } from '@/modules/events/index.js';

test('broadcast before any handler is registered is a silent no-op', () => {
  _resetForTest();
  assert.doesNotThrow(() => broadcast({ kind: 'status' }));
});

test('broadcast after registration delivers the exact same object reference', () => {
  _resetForTest();
  const seen: unknown[] = [];
  setBroadcastHandler((m) => seen.push(m));
  const payload = { kind: 'session_upserted', data: { id: 's1' } };
  broadcast(payload);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], payload);
});

test('a later registration replaces the earlier handler', () => {
  _resetForTest();
  const first: unknown[] = [];
  const second: unknown[] = [];
  setBroadcastHandler((m) => first.push(m));
  setBroadcastHandler((m) => second.push(m));
  broadcast({ kind: 'status' });
  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
});
