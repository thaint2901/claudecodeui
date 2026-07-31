import assert from 'node:assert/strict';
import test from 'node:test';

import { createInstance } from 'i18next';

import { registerForkNamespace } from './forkNamespace.js';
import deFork from './locales/de/fork.json';
import enFork from './locales/en/fork.json';

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
