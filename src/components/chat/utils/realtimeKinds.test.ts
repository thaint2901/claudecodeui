import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildBackgroundTaskSummary,
  isNonTranscriptKind,
  resolveBackgroundTaskOutcome,
  shouldSignalBackgroundTaskCompletion,
} from './realtimeKinds.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HANDLERS_SOURCE = path.join(HERE, '..', 'hooks', 'useChatRealtimeHandlers.ts');

/**
 * The `case '<kind>':` labels of the FIRST `switch (msg.kind)` in
 * useChatRealtimeHandlers — the switch whose every arm returns before the
 * generic append path.
 */
function readEarlyReturningKinds(): string[] {
  const source = readFileSync(HANDLERS_SOURCE, 'utf8');
  const switchAt = source.indexOf('switch (msg.kind) {');
  assert.notEqual(switchAt, -1, 'the first kind switch must still be findable for this check to mean anything');
  const defaultAt = source.indexOf('default:', switchAt);
  assert.notEqual(defaultAt, -1, 'the first kind switch must still end in a default arm');

  const kinds = [...source.slice(switchAt, defaultAt).matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]);
  assert.ok(kinds.length >= 8, `expected the extraction to find the switch arms, found ${kinds.length}`);
  return kinds;
}

test('background_task must never be appended to the transcript store', () => {
  assert.equal(isNonTranscriptKind('background_task'), true);
});

test('the kinds that already dodge the generic append path stay classified', () => {
  for (const kind of ['session_upserted', 'loading_progress', 'session_lock_state_changed']) {
    assert.equal(isNonTranscriptKind(kind), true, `${kind} must not be appended`);
  }
});

test('every kind that returns early from the first switch is on the allowlist', () => {
  // The allowlist is the SECOND line of defence: if one of these arms ever
  // loses its `return`, the allow-by-default `shouldPersist` guard is the only
  // thing left between a frame with no `.id` and a corrupted session store.
  // Reading the arms out of the source is what makes a newly added kind fail
  // here instead of silently shipping without that defence.
  for (const kind of readEarlyReturningKinds()) {
    assert.equal(isNonTranscriptKind(kind), true, `${kind} returns early but has no allowlist entry`);
  }
});

test('the frontend hook still returns early for all eight known non-transcript kinds', () => {
  const kinds = readEarlyReturningKinds();
  for (const kind of [
    'websocket_reconnected',
    'chat_subscribed',
    'branch_created',
    'protocol_error',
    'session_upserted',
    'loading_progress',
    'session_lock_state_changed',
    'background_task',
  ]) {
    assert.ok(kinds.includes(kind), `${kind} must still be handled in the first switch`);
    assert.equal(isNonTranscriptKind(kind), true, `${kind} must not be appendable`);
  }
});

test('a settled task only rings the chime for the session the user is looking at', () => {
  assert.equal(
    shouldSignalBackgroundTaskCompletion({ advisory: false, sessionId: 'app-1', activeViewSessionId: 'app-1' }),
    true,
  );
  assert.equal(
    shouldSignalBackgroundTaskCompletion({ advisory: false, sessionId: 'app-2', activeViewSessionId: 'app-1' }),
    false,
    'another session settling must not flash this tab\'s title or ring its chime',
  );
  assert.equal(
    shouldSignalBackgroundTaskCompletion({ advisory: false, sessionId: 'app-1', activeViewSessionId: null }),
    false,
    'with no session in view there is nothing the signal could be about',
  );
});

test('the long-hold advisory signals nothing, viewed session or not', () => {
  for (const activeViewSessionId of ['app-1', 'app-2', null]) {
    assert.equal(
      shouldSignalBackgroundTaskCompletion({ advisory: true, sessionId: 'app-1', activeViewSessionId }),
      false,
      'an advisory about work that is STILL RUNNING is not a completion',
    );
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
