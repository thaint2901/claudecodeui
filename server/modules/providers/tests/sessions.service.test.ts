import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionsService, setLiveRunProbe, _resetForTest } from '@/modules/providers/services/sessions.service.js';
import type { LLMProvider } from '@/shared/types.js';

test('listRunningSessions returns the empty-registry answer before a probe is registered', () => {
  _resetForTest();
  assert.deepEqual(sessionsService.listRunningSessions(), []);
});

test('listRunningSessions delegates to the injected probe once registered', () => {
  _resetForTest();
  const fakeRun = {
    sessionId: 'session-1',
    provider: 'claude' as LLMProvider,
    startedAt: 123,
    lastSeq: 4,
  };
  setLiveRunProbe({
    listRunningRuns: () => [fakeRun],
  });
  assert.deepEqual(sessionsService.listRunningSessions(), [fakeRun]);
});

test('a later registration replaces the earlier probe', () => {
  _resetForTest();
  setLiveRunProbe({
    listRunningRuns: () => [{ sessionId: 'a', provider: 'claude' as LLMProvider, startedAt: 1, lastSeq: 1 }],
  });
  setLiveRunProbe({ listRunningRuns: () => [] });
  assert.deepEqual(sessionsService.listRunningSessions(), []);
});
