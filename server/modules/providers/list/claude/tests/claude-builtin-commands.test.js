import test from 'node:test';
import assert from 'node:assert/strict';

import {
  setClaudeBuiltinCommands,
  getClaudeBuiltinCommandEntries,
} from '../claude-builtin-commands.js';

test('returns empty array before any capture', () => {
  setClaudeBuiltinCommands(null); // reset/ignore invalid
  assert.deepEqual(getClaudeBuiltinCommandEntries(), []);
});

test('maps captured names to slash-prefixed entries with descriptions', () => {
  setClaudeBuiltinCommands(['clear', 'compact', 'zzz-unknown']);
  const entries = getClaudeBuiltinCommandEntries();
  assert.equal(entries.length, 5); // + always-included /fork and /subtask
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
  assert.deepEqual(getClaudeBuiltinCommandEntries().map((e) => e.name), ['/compact', '/fork', '/subtask']);
});

test('excludeNames filters collisions with ccui pseudo-commands', () => {
  setClaudeBuiltinCommands(['config', 'clear']);
  const entries = getClaudeBuiltinCommandEntries(['/config']);
  assert.deepEqual(entries.map((e) => e.name), ['/clear', '/fork', '/subtask']);
});

test('non-array input is ignored, keeping previous cache', () => {
  setClaudeBuiltinCommands(['clear']);
  setClaudeBuiltinCommands(undefined);
  assert.deepEqual(getClaudeBuiltinCommandEntries().map((e) => e.name), ['/clear', '/fork', '/subtask']);
});

test('fork and subtask are always appended when captured list lacks them', () => {
  setClaudeBuiltinCommands(['clear', 'compact']);
  const names = getClaudeBuiltinCommandEntries().map((e) => e.name);
  assert.ok(names.includes('/fork'));
  assert.ok(names.includes('/subtask'));
  assert.deepEqual(names, ['/clear', '/compact', '/fork', '/subtask']);
});

test('fork is not duplicated if the CLI ever reports it itself', () => {
  setClaudeBuiltinCommands(['clear', 'fork']);
  const names = getClaudeBuiltinCommandEntries().map((e) => e.name);
  assert.deepEqual(names, ['/clear', '/fork', '/subtask']);
  assert.equal(names.filter((n) => n === '/fork').length, 1);
});

test('empty cache still returns [] even though fork/subtask are always-included', () => {
  setClaudeBuiltinCommands([]);
  assert.deepEqual(getClaudeBuiltinCommandEntries(), []);
});
