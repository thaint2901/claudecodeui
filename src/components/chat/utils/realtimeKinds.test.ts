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
  assert.deepEqual(resolveBackgroundTaskOutcome('completed'), { status: 'completed', outcome: 'completed', advisory: false });
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

test('a still-running advisory renders as an advisory, not as an outcome', () => {
  const resolved = resolveBackgroundTaskOutcome('running');
  assert.equal(resolved.status, 'running', 'the row must not borrow a settled outcome\'s status');
  assert.equal(resolved.advisory, true, 'so the caller can keep completion signals off it');
  assert.doesNotMatch(resolved.outcome, /completed|failed|stopped|did not report success/);
});

test('a settled outcome is never classified as an advisory', () => {
  for (const status of ['completed', 'failed', 'stopped', undefined, 'timed_out']) {
    assert.equal(
      resolveBackgroundTaskOutcome(status).advisory,
      false,
      `status ${JSON.stringify(status)} is an outcome, not an advisory`,
    );
  }
});

test('the advisory row says it is still running, holding a process, and will not be stopped for you', () => {
  const { outcome } = resolveBackgroundTaskOutcome('running');
  const summary = buildBackgroundTaskSummary(
    outcome,
    'Echo t1-t10 with delays — 10 minutes so far, holding a Claude CLI process open for this session. '
    + 'Nothing will stop it automatically.',
    undefined,
  );
  assert.match(summary, /still running/, 'the command has not finished');
  assert.match(summary, /holding a Claude CLI process open/, 'and that is what the hold costs');
  assert.match(summary, /Nothing will stop it automatically/, 'and nobody is going to end it for the user');
  assert.doesNotMatch(summary, /failed|did not report success/, 'an advisory is not a failure');
  assert.doesNotMatch(summary, /undefined/);
});
