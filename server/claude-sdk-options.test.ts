import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCliOptionsToSDK, shouldRecaptureSessionId } from '@/claude-sdk.js';

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
