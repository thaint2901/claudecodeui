import test from 'node:test';
import assert from 'node:assert/strict';

import { matchLeadingCommand } from './commandToken.js';

const names = new Set(['/clear', '/fork', '/prp-commit', '/telegram:access']);

test('matches a known leading command and splits off the rest', () => {
  assert.deepEqual(matchLeadingCommand('/clear', names), { command: '/clear', rest: '' });
  assert.deepEqual(matchLeadingCommand('/fork review the diff', names), {
    command: '/fork',
    rest: ' review the diff',
  });
});

test('supports dashes and namespaced colon commands', () => {
  assert.equal(matchLeadingCommand('/prp-commit msg', names)?.command, '/prp-commit');
  assert.equal(matchLeadingCommand('/telegram:access', names)?.command, '/telegram:access');
});

test('returns null for unknown commands, non-leading slashes, and plain text', () => {
  assert.equal(matchLeadingCommand('/zzz nope', names), null);
  assert.equal(matchLeadingCommand('say /clear later', names), null);
  assert.equal(matchLeadingCommand('hello', names), null);
  assert.equal(matchLeadingCommand('', names), null);
});

test('longer names are not truncated into shorter known ones', () => {
  // '/clearx' is one token; it must not highlight as '/clear'.
  assert.equal(matchLeadingCommand('/clearx', names), null);
});
