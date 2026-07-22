import test from 'node:test';
import assert from 'node:assert/strict';

import { parseForkCommand, parseSubtaskCommand } from '../services/chat-websocket.service.js';

test('parses /fork with and without a prompt', () => {
  assert.deepEqual(parseForkCommand('/fork'), { prompt: '' });
  assert.deepEqual(parseForkCommand('/fork open a draft PR'), { prompt: 'open a draft PR' });
  assert.deepEqual(parseForkCommand('  /fork   spaced  '), { prompt: 'spaced' });
});

test('rejects non-fork input', () => {
  assert.equal(parseForkCommand('/forked'), null);
  assert.equal(parseForkCommand('tell me about /fork'), null);
  assert.equal(parseForkCommand('/subtask x'), null);
});

test('parses /subtask task text', () => {
  assert.deepEqual(parseSubtaskCommand('/subtask review the readme'), { task: 'review the readme' });
  assert.equal(parseSubtaskCommand('/subtask'), null); // task text required
  assert.equal(parseSubtaskCommand('/subtasks x'), null);
});
