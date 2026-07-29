import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBackgroundTaskSummary, isNonTranscriptKind, resolveBackgroundTaskOutcome } from './realtimeKinds.js';

test('background_task must never be appended to the transcript store', () => {
  assert.equal(isNonTranscriptKind('background_task'), true);
});

test('the kinds that already dodge the generic append path stay classified', () => {
  for (const kind of ['session_upserted', 'loading_progress', 'session_lock_state_changed']) {
    assert.equal(isNonTranscriptKind(kind), true, `${kind} must not be appended`);
  }
});

test('real chat message kinds remain transcript-bound', () => {
  for (const kind of ['text', 'tool_use', 'tool_result', 'thinking']) {
    assert.equal(isNonTranscriptKind(kind), false, `${kind} belongs in the transcript`);
  }
});

test('a background task only reads as a success when it explicitly says so', () => {
  assert.deepEqual(resolveBackgroundTaskOutcome('completed'), { status: 'completed', outcome: 'completed' });
  assert.equal(resolveBackgroundTaskOutcome('failed').status, 'failed');
  assert.equal(resolveBackgroundTaskOutcome('stopped').status, 'stopped');
});

test('an unknown or missing status never renders as a success', () => {
  for (const status of [undefined, null, '', 'timed_out', 42, {}]) {
    const resolved = resolveBackgroundTaskOutcome(status);
    assert.notEqual(resolved.status, 'completed', `status ${JSON.stringify(status)} must not read as success`);
    assert.match(resolved.outcome, /did not report success/);
  }
});

test('a background task with no output path renders a row without one, never "undefined"', () => {
  const summary = buildBackgroundTaskSummary(
    'failed',
    'Echo t1-t10 with delays — the Claude CLI process ended before this task reported a result, so its output was never written.',
    undefined,
  );
  assert.doesNotMatch(summary, /undefined/, 'a task lost with the process never produced an output file');
  assert.doesNotMatch(summary, /output:/, 'and must not claim a path it does not have');
  assert.match(summary, /^Background task failed: Echo t1-t10 with delays/);
});

test('a background task that did write an output file still shows the path', () => {
  assert.equal(
    buildBackgroundTaskSummary('completed', 'sonar finished', '/tmp/bg3.output'),
    'Background task completed: sonar finished — output: /tmp/bg3.output',
  );
});

test('a background task frame with no summary at all still reads as a sentence', () => {
  assert.equal(
    buildBackgroundTaskSummary('failed', undefined, ''),
    'Background task failed: Background task finished',
  );
});
