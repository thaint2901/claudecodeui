import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCliOptionsToSDK } from '../claude-sdk.js';

test('fork options map to resumeSessionAt + forkSession', () => {
  const sdk = mapCliOptionsToSDK({
    sessionId: 'prov-1',
    resumeSessionAt: 'a1',
    forkSession: true,
  });
  assert.equal(sdk.resume, 'prov-1');
  assert.equal(sdk.resumeSessionAt, 'a1');
  assert.equal(sdk.forkSession, true);
});

test('first-prompt fork sets forkSession without resumeSessionAt', () => {
  const sdk = mapCliOptionsToSDK({ sessionId: 'prov-1', forkSession: true });
  assert.equal(sdk.forkSession, true);
  assert.equal('resumeSessionAt' in sdk, false);
});

test('plain resume is untouched (regression)', () => {
  const sdk = mapCliOptionsToSDK({ sessionId: 'prov-1' });
  assert.equal(sdk.resume, 'prov-1');
  assert.equal('forkSession' in sdk, false);
  assert.equal('resumeSessionAt' in sdk, false);
});
