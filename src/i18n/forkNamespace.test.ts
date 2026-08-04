import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const localesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locales');

// Derived from disk, not hardcoded: a locale directory arriving from an upstream sync must
// be covered by the guards below, not silently skipped.
const ALL_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const BRANCH_KEYS = [
  'editTitle', 'editAria', 'previous', 'next', 'editLabel', 'groupAria',
  'announced', 'forkFailed', 'forkFailedRestored', 'switchFailed', 'editBlockedWhileRunning',
];
const EDIT_SENT_PROMPT_KEYS = ['banner', 'cancel', 'dismiss'];
const SESSION_LOCK_KEYS = ['bannerText', 'stopAndResume', 'stopping'];

function loadLocaleFile(locale: string, file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(localesDir, locale, file), 'utf8'));
}

function assertNonEmptyStrings(obj: unknown, trail: string): void {
  if (typeof obj === 'string') {
    assert.ok(obj.trim().length > 0, `${trail} is empty`);
    return;
  }
  assert.ok(obj !== null && typeof obj === 'object', `${trail} is not an object or string`);
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    assertNonEmptyStrings(v, `${trail}.${k}`);
  }
}

// Without this, a wrong localesDir would make every loop below iterate nothing and pass.
test('the discovered locale list is non-trivial', () => {
  assert.ok(ALL_LOCALES.length >= 10, `expected >=10 locale dirs, found ${ALL_LOCALES.length}`);
  assert.ok(ALL_LOCALES.includes('en'), 'en is missing from the discovered locales');
});

test('every locale ships fork.json with the branch and editSentPrompt groups', () => {
  for (const locale of ALL_LOCALES) {
    const forkPath = path.join(localesDir, locale, 'fork.json');
    assert.ok(existsSync(forkPath), `${locale}/fork.json is missing`);
    const fork = loadLocaleFile(locale, 'fork.json');
    assert.deepEqual(
      Object.keys(fork.branch as object).sort(), [...BRANCH_KEYS].sort(),
      `${locale}/fork.json branch keys mismatch`,
    );
    assert.deepEqual(
      Object.keys(fork.editSentPrompt as object).sort(), [...EDIT_SENT_PROMPT_KEYS].sort(),
      `${locale}/fork.json editSentPrompt keys mismatch`,
    );
  }
});

test('en fork.json carries sessionLock; other locales may rely on en fallback', () => {
  const enFork = loadLocaleFile('en', 'fork.json');
  assert.deepEqual(Object.keys(enFork.sessionLock as object).sort(), [...SESSION_LOCK_KEYS].sort());
  for (const locale of ALL_LOCALES) {
    const fork = loadLocaleFile(locale, 'fork.json');
    if ('sessionLock' in fork) {
      assert.deepEqual(
        Object.keys(fork.sessionLock as object).sort(), [...SESSION_LOCK_KEYS].sort(),
        `${locale}/fork.json sessionLock keys mismatch`,
      );
    }
  }
});

test('fork.json values are all non-empty strings', () => {
  for (const locale of ALL_LOCALES) {
    assertNonEmptyStrings(loadLocaleFile(locale, 'fork.json'), `${locale}/fork.json`);
  }
});

test('upstream chat.json no longer contains fork-owned key groups', () => {
  for (const locale of ALL_LOCALES) {
    const chat = loadLocaleFile(locale, 'chat.json');
    assert.ok(!('branch' in chat), `${locale}/chat.json still has the branch group`);
    assert.ok(!('sessionLock' in chat), `${locale}/chat.json still has the sessionLock group`);
    const input = (chat.input ?? {}) as Record<string, unknown>;
    assert.ok(!('editSentPrompt' in input), `${locale}/chat.json still has input.editSentPrompt`);
  }
});
