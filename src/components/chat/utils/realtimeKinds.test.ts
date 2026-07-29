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
 * How many arms the first `switch (msg.kind)` is expected to have. Bump this in
 * the same edit that adds the new kind to `NON_TRANSCRIPT_KINDS` — that pairing
 * is the whole point, and a floor (`>= 8`) would let a ninth arm slip in
 * unlisted.
 */
const EXPECTED_EARLY_RETURN_ARMS = 8;

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
  const region = source.slice(switchAt, defaultAt);

  // `\w` and `-` rather than `[a-z_]`: a kind with a digit, a capital or a
  // hyphen used to be silently unextractable, so an arm added under such a name
  // would pass this whole check while carrying none of its protection.
  const kinds = [...region.matchAll(/case\s+'([\w-]+)':/g)].map((match) => match[1]);
  // Counted independently of the label pattern, so a label the pattern still
  // cannot read fails here instead of shrinking the list unnoticed.
  const armCount = (region.match(/^\s+case\b/gm) ?? []).length;
  assert.equal(
    kinds.length,
    armCount,
    `every case arm must be extractable — found ${armCount} arms but could only read ${kinds.length} labels`,
  );
  assert.equal(
    kinds.length,
    EXPECTED_EARLY_RETURN_ARMS,
    `the first switch has ${kinds.length} arms, not ${EXPECTED_EARLY_RETURN_ARMS} — add the new kind to NON_TRANSCRIPT_KINDS and bump the expected count together`,
  );
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

// The signal must NOT depend on which session is on screen. Alice starts a
// 20-minute build in session S and switches to session T to keep working — which
// is the entire reason a shell is backgrounded. Gating on the viewed session
// silences the notification in exactly that case, and the only trace left is a
// row in S's store bucket, which nothing surfaces (there is no unread or badge
// mechanism in useSessionStore or the sidebar). `showCompletionTitleIndicator`
// holds `[Done]` until the user comes back, so it is built for precisely the
// away-from-it case. Delivery is already owner-scoped server-side, so a frame
// that arrives is by construction the recipient's own work.
test('a settled outcome signals no matter which session is on screen', () => {
  assert.equal(shouldSignalBackgroundTaskCompletion({ advisory: false }), true);
});

test('the long-hold advisory still signals nothing at all', () => {
  assert.equal(
    shouldSignalBackgroundTaskCompletion({ advisory: true }),
    false,
    'an advisory about work that is STILL RUNNING is not a completion',
  );
});

test('the signal decision takes no view state, so it cannot be re-gated on the viewed session by accident', () => {
  const source = readFileSync(
    path.join(HERE, 'realtimeKinds.ts'),
    'utf8',
  );
  const signature = source.slice(source.indexOf('export function shouldSignalBackgroundTaskCompletion'));
  const params = signature.slice(0, signature.indexOf('}):'));
  assert.doesNotMatch(params, /sessionId|activeView/, 'the viewed session is deliberately not an input to this decision');
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
