import assert from 'node:assert/strict';
import test from 'node:test';

import { buildForkRuntimeOptions } from '@/modules/websocket/services/chat-websocket.service.js';

test('fork options include forkSession and optional resumeSessionAt', () => {
  assert.deepEqual(buildForkRuntimeOptions('u2', 'a1'), { forkSession: true, resumeSessionAt: 'a1' });
  assert.deepEqual(buildForkRuntimeOptions('u1', null), { forkSession: true });
  assert.deepEqual(buildForkRuntimeOptions(null, null), {});
});
