import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommandArgs } from './useSlashDispatch.js';

// Characterizes executeCommand's actual pure decision: given the raw composer
// text and the already-matched command's name, split whatever follows the
// name into whitespace-separated tokens. (See report for why this — not a
// from-scratch "classify raw text" function — is the real carve-able
// expression inside concern C: the text/kind classification the task brief
// sketched actually lives in handleSubmit, outside concern C's scope.)

test('parseCommandArgs splits the text following the command name into tokens', () => {
  assert.deepEqual(parseCommandArgs('/compact focus on X', '/compact'), ['focus', 'on', 'X']);
});

test('parseCommandArgs returns an empty array when the command name has no trailing text', () => {
  assert.deepEqual(parseCommandArgs('/compact', '/compact'), []);
});

test('parseCommandArgs returns an empty array when the input does not contain the command name', () => {
  assert.deepEqual(parseCommandArgs('hello world', '/compact'), []);
});
