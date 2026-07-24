import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCliOptionsToSDK, shouldRecaptureSessionId, recaptureForkSession } from '@/claude-sdk.js';

test('mapCliOptionsToSDK enables includePartialMessages so the SDK streams partial assistant text', () => {
  const sdkOptions = mapCliOptionsToSDK({
    sessionId: null,
    cwd: process.cwd(),
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    permissionMode: 'default',
  });

  assert.equal(sdkOptions.includePartialMessages, true);
});

test('shouldRecaptureSessionId re-captures only for fork runs whose announced id differs', () => {
  // Fork run: SDK announces a new id distinct from the parent-seeded capture.
  assert.equal(shouldRecaptureSessionId(true, 'fork-new-id', 'parent-id'), true);

  // Fork run, but the announced id matches what's already captured — no-op.
  assert.equal(shouldRecaptureSessionId(true, 'parent-id', 'parent-id'), false);

  // Non-fork (resume) run must never re-capture, even if ids differ.
  assert.equal(shouldRecaptureSessionId(false, 'fork-new-id', 'parent-id'), false);

  // No announced id yet.
  assert.equal(shouldRecaptureSessionId(true, undefined, 'parent-id'), false);
});

test('recaptureForkSession removes the old id, tracks the new one, relabels the writer, and announces once', () => {
  const calls: string[] = [];
  const queryInstance = { marker: 'query-instance' };
  const ws = {
    setSessionId: (id: string) => {
      calls.push(`setSessionId:${id}`);
    },
  };

  const result = recaptureForkSession({
    oldId: 'parent-id',
    newId: 'fork-new-id',
    queryInstance,
    ws,
    removeSession: (id: string) => calls.push(`removeSession:${id}`),
    addSession: (id: string, instance: unknown, writer: unknown) => {
      assert.equal(instance, queryInstance);
      assert.equal(writer, ws);
      calls.push(`addSession:${id}`);
    },
    sendSessionCreated: () => calls.push('sendSessionCreated'),
  });

  assert.equal(result, 'fork-new-id');
  // Call order: old id removed before the new id is added, then the writer
  // is relabeled, then (and only then) session_created is announced.
  assert.deepEqual(calls, [
    'removeSession:parent-id',
    'addSession:fork-new-id',
    'setSessionId:fork-new-id',
    'sendSessionCreated',
  ]);
});

test('recaptureForkSession tolerates a writer with no setSessionId and still announces exactly once', () => {
  let sendCount = 0;
  const result = recaptureForkSession({
    oldId: 'parent-id',
    newId: 'fork-new-id',
    queryInstance: {},
    ws: {},
    removeSession: () => {},
    addSession: () => {},
    sendSessionCreated: () => {
      sendCount += 1;
    },
  });

  assert.equal(result, 'fork-new-id');
  assert.equal(sendCount, 1);
});
