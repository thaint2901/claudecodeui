import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();

test('normalizeMessage extracts text from a nested stream_event/content_block_delta', () => {
  const raw = {
    type: 'stream_event',
    session_id: 'sess-1',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
  };

  const result = provider.normalizeMessage(raw, 'sess-1');

  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'stream_delta');
  assert.equal(result[0].content, 'Hel');
});

test('normalizeMessage emits stream_end on nested content_block_stop', () => {
  const raw = {
    type: 'stream_event',
    session_id: 'sess-1',
    event: { type: 'content_block_stop', index: 0 },
  };

  const result = provider.normalizeMessage(raw, 'sess-1');

  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'stream_end');
});

test('normalizeMessage ignores other nested stream_event subtypes without misinterpreting them', () => {
  const raw = {
    type: 'stream_event',
    session_id: 'sess-1',
    event: { type: 'message_start' },
  };

  const result = provider.normalizeMessage(raw, 'sess-1');

  assert.deepEqual(result, []);
});

test('normalizeMessage does not match a top-level content_block_delta (old, incorrect shape)', () => {
  const raw = { type: 'content_block_delta', delta: { text: 'stale-shape' } };

  const result = provider.normalizeMessage(raw, 'sess-1');

  assert.deepEqual(result, []);
});
