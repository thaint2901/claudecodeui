import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldFlushQueuedDraft, type QueuedDraft } from './useMessageQueue.js';

// Characterizes the REAL flush effect's gate as it exists today (see the
// flush effect in useChatComposerState.ts before extraction). The brief's
// sketch used `wasLoading`/`flushedSessionKey` names, but the actual effect
// has no "already flushed for this session" memory — `flushSessionKeyRef`
// only detects an in-progress session switch (the commit where `sessionKey`
// already points at the new session but `queuedDraft` still describes the
// old one), and `wasLoading` only picks the flush delay (0 vs 750ms), never
// gates whether a flush happens at all. This test encodes what IS there:
// `previousSessionKey` (the ref's value before this render) replaces
// `flushedSessionKey`, and `wasLoading` is dropped from the gate entirely.
const draft = { content: 'queued', images: [] } as QueuedDraft;

test('flushes when idle, the session has not just switched, and a draft is queued', () => {
  assert.equal(
    shouldFlushQueuedDraft({ isLoading: false, queuedDraft: draft, sessionKey: 's1', previousSessionKey: 's1' }),
    true,
  );
});

test('no flush while still loading', () => {
  assert.equal(
    shouldFlushQueuedDraft({ isLoading: true, queuedDraft: draft, sessionKey: 's1', previousSessionKey: 's1' }),
    false,
  );
});

test('no flush without a queued draft', () => {
  assert.equal(
    shouldFlushQueuedDraft({ isLoading: false, queuedDraft: null, sessionKey: 's1', previousSessionKey: 's1' }),
    false,
  );
});

test('no flush across a session switch, even with an idle stale draft', () => {
  assert.equal(
    shouldFlushQueuedDraft({ isLoading: false, queuedDraft: draft, sessionKey: 's2', previousSessionKey: 's1' }),
    false,
  );
});

test('the gate does not special-case a null session key on its own', () => {
  // Mirrors the real effect: the null-session guard lives inside the flush
  // timeout callback (`sessionKey && !readQueuedMessage(sessionKey)`), not in
  // this predicate — when previousSessionKey and sessionKey agree (both
  // null), that alone is not a "session switch".
  assert.equal(
    shouldFlushQueuedDraft({ isLoading: false, queuedDraft: draft, sessionKey: null, previousSessionKey: null }),
    true,
  );
});
