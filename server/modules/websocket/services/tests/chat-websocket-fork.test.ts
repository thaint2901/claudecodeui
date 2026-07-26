import assert from 'node:assert/strict';
import test from 'node:test';

import { buildForkRuntimeOptions, normalizeEditAtMessageUuid } from '@/modules/websocket/services/chat-websocket.service.js';

test('fork options include forkSession and optional resumeSessionAt', () => {
  assert.deepEqual(buildForkRuntimeOptions('u2', 'a1'), { forkSession: true, resumeSessionAt: 'a1' });
  assert.deepEqual(buildForkRuntimeOptions('u1', null), { forkSession: true });
  assert.deepEqual(buildForkRuntimeOptions(null, null), {});
});

test('normalizeEditAtMessageUuid reduces rendered part ids to the bare transcript uuid', () => {
  const uuid = '6586cc24-436a-44bd-83b1-9b4aa68200a0';
  // The exact shape that broke the dev smoke test: user text part id.
  assert.equal(normalizeEditAtMessageUuid(`${uuid}_text_0`), uuid);
  assert.equal(normalizeEditAtMessageUuid(`${uuid}_text_12`), uuid);
  assert.equal(normalizeEditAtMessageUuid(`${uuid}_text`), uuid);
  assert.equal(normalizeEditAtMessageUuid(`${uuid}_tr_toolu_01AbC`), uuid);
  assert.equal(normalizeEditAtMessageUuid(`${uuid}_images`), uuid);
  assert.equal(normalizeEditAtMessageUuid(`${uuid}_3`), uuid);
  // Bare uuids and non-part ids pass through untouched.
  assert.equal(normalizeEditAtMessageUuid(uuid), uuid);
  assert.equal(normalizeEditAtMessageUuid('x_text_middle'), 'x_text_middle');
  // Absent / blank / non-string input → null (no fork intent).
  assert.equal(normalizeEditAtMessageUuid(undefined), null);
  assert.equal(normalizeEditAtMessageUuid('   '), null);
  assert.equal(normalizeEditAtMessageUuid(42), null);
});
