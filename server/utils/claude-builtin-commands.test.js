import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setClaudeBuiltinCommands,
  getClaudeBuiltinCommandEntries,
} from './claude-builtin-commands.js';

test('returns empty array before any capture', () => {
  setClaudeBuiltinCommands(null); // reset/ignore invalid
  assert.deepEqual(getClaudeBuiltinCommandEntries(), []);
});

test('maps captured names to slash-prefixed entries with descriptions', () => {
  setClaudeBuiltinCommands(['clear', 'compact', 'zzz-unknown']);
  const entries = getClaudeBuiltinCommandEntries();
  assert.equal(entries.length, 3);
  const clear = entries.find((e) => e.name === '/clear');
  assert.ok(clear);
  assert.equal(clear.namespace, 'claude-builtin');
  assert.equal(clear.metadata.type, 'claude-builtin');
  assert.match(clear.description, /context/i);
  const unknown = entries.find((e) => e.name === '/zzz-unknown');
  assert.equal(unknown.description, 'Claude Code built-in command');
});

test('later capture overwrites earlier capture', () => {
  setClaudeBuiltinCommands(['clear']);
  setClaudeBuiltinCommands(['compact']);
  assert.deepEqual(getClaudeBuiltinCommandEntries().map((e) => e.name), ['/compact']);
});

test('excludeNames filters collisions with ccui pseudo-commands', () => {
  setClaudeBuiltinCommands(['config', 'clear']);
  const entries = getClaudeBuiltinCommandEntries(['/config']);
  assert.deepEqual(entries.map((e) => e.name), ['/clear']);
});

test('non-array input is ignored, keeping previous cache', () => {
  setClaudeBuiltinCommands(['clear']);
  setClaudeBuiltinCommands(undefined);
  assert.deepEqual(getClaudeBuiltinCommandEntries().map((e) => e.name), ['/clear']);
});
