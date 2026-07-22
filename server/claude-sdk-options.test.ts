import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCliOptionsToSDK } from '@/claude-sdk.js';

test('mapCliOptionsToSDK enables includePartialMessages so the SDK streams partial assistant text', () => {
  const sdkOptions = mapCliOptionsToSDK({
    sessionId: null,
    cwd: process.cwd(),
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    permissionMode: 'default',
  });

  assert.equal(sdkOptions.includePartialMessages, true);
});
