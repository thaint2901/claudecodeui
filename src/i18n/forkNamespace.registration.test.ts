import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createInstance } from 'i18next';

import appI18n from './config.js';
import { registerForkNamespace } from './forkNamespace.js';
import deFork from './locales/de/fork.json';
import enFork from './locales/en/fork.json';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every `fork:` key literal actually used in application source. */
function collectUsedForkKeys(): string[] {
  const used = new Set<string>();
  const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(tsx?|jsx?)$/.test(f) && !f.includes('.test.'));
  for (const file of files) {
    const source = readFileSync(path.join(srcDir, file), 'utf8');
    for (const match of source.matchAll(/['"`]fork:([A-Za-z0-9_.]+)['"`]/g)) {
      used.add(match[1]);
    }
  }
  return [...used].sort();
}

test('registerForkNamespace exposes fork keys per locale with en fallback', async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: 'de',
    fallbackLng: 'en',
    ns: ['chat'],
    defaultNS: 'chat',
    resources: { en: { chat: {} }, de: { chat: {} } },
    interpolation: { escapeValue: false },
  });
  registerForkNamespace(i18n);

  assert.equal(i18n.t('fork:branch.editLabel', { lng: 'en' }), enFork.branch.editLabel);
  assert.equal(i18n.t('fork:branch.editTitle', { lng: 'de' }), deFork.branch.editTitle);
  // de has no sessionLock group — must fall back to the en value, not the raw key
  assert.equal(i18n.t('fork:sessionLock.stopAndResume', { lng: 'de' }), enFork.sessionLock.stopAndResume);
});

// Guards the 2-line call site in config.js that Fork Maintenance Rule 2 is built around:
// deleting `registerForkNamespace(i18n)` there must fail the suite, not just render raw keys.
test('the app i18n singleton has the fork namespace registered', () => {
  assert.ok(appI18n.hasResourceBundle('en', 'fork'), 'config.js did not register the fork namespace');
  assert.equal(appI18n.t('fork:branch.editTitle'), enFork.branch.editTitle);
});

test('every fork: key used in application source resolves through the app singleton', () => {
  const usedKeys = collectUsedForkKeys();
  assert.ok(usedKeys.length >= 17, `expected >=17 fork: call sites, found ${usedKeys.length}`);
  // i18next returns the bare key when a lookup misses, so key === result means unresolved.
  const unresolved = usedKeys.filter((key) => appI18n.t(`fork:${key}`) === key);
  assert.deepEqual(unresolved, [], `fork keys used in source but absent from fork.json: ${unresolved.join(', ')}`);
});
