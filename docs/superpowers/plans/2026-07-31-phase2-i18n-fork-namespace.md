# Phase 2: i18n fork.json Namespace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all fork-added translation keys out of upstream's `chat.json` into a fork-owned `fork.json` namespace per locale, eliminating the i18n add/add conflict surface with upstream (ADR-0001 Rule 2).

**Architecture:** A new `fork` i18next namespace backed by `src/i18n/locales/<locale>/fork.json` files. A fork-owned module `src/i18n/forkNamespace.js` registers the namespace via `i18n.addResourceBundle()` after init, so upstream-owned `src/i18n/config.js` changes by exactly 2 lines (import + call — Fork Maintenance Rule 1). Consumer components switch migrated keys to the explicit `fork:` prefix for grep-ability. A leaf `node:test` guard enforces structure and purity forever.

**Tech Stack:** i18next (static resources, no backend), react-i18next, node:test + tsx.

## Global Constraints

- **UI strings must not change.** Every translated value is copied byte-identical; only the namespace/key-path moves.
- **No new dependencies; `package.json` must not change at all** (scripts already exist from Phase 0).
- Only these paths may change: `src/i18n/**` (new `fork.json` ×10, new `forkNamespace.js`, new tests, `config.js` ≤2-line call site), the 5 consumer files listed in Task 2 (t()/useTranslation edits only, plus one comment in `useBranchSwitchController.ts`), `CLAUDE.md` (one parenthetical in Fork Maintenance Rule 2), and this plan doc.
- `src/i18n/config.js` is upstream-owned: its diff must be exactly 1 import line + 1 call line.
- Edits to upstream `chat.json` files (Task 3) must be **pure deletions** — no reformatting, no key reordering. Semantic verification required (see Task 3 Step 3).
- The `fr` locale exists on disk but is NOT registered in `config.js`. Create `fr/fork.json` for file parity, but do NOT register `fr` and do NOT touch `config.js` beyond the 2 lines.
- `sessionLock` currently exists only in `en/chat.json`. Do NOT fabricate translations for other locales — `fallbackLng: 'en'` covers them at runtime.
- Every commit must pass: `npm test` (baseline: server 232 pass / 0 fail, client 69 pass / 0 fail — client count grows as tasks add tests), `npm run typecheck`, `npm run lint` (0 errors, warnings must not increase).
- Conventional Commits, no attribution footer.
- Test framework is `node:test` + `node:assert/strict` via tsx (see package.json scripts). Do NOT introduce vitest/jest.

**Migrated key inventory (measured 2026-07-31, `git diff 27eaf01..HEAD`):**
- `branch` (top-level in chat.json, all 10 locales, 11 keys): `editTitle`, `editAria`, `previous`, `next`, `editLabel`, `groupAria`, `announced`, `forkFailed`, `forkFailedRestored`, `switchFailed`, `editBlockedWhileRunning`
- `input.editSentPrompt` (nested under upstream's `input`, all 10 locales, 3 keys): `banner`, `cancel`, `dismiss` — promoted to top-level `editSentPrompt` in fork.json
- `sessionLock` (top-level, **en only**, 3 keys): `bannerText`, `stopAndResume`, `stopping`

Locales on disk: `de en fr it ja ko ru tr zh-CN zh-TW` (10). Registered in config.js: all except `fr` (9).

---

### Task 1: Create fork.json per locale + fork-owned registration module + guard tests

**Files:**
- Create: `src/i18n/locales/<locale>/fork.json` for all 10 locales (generated, not hand-typed)
- Create: `src/i18n/forkNamespace.js`
- Create: `src/i18n/forkNamespace.test.ts`
- Create: `src/i18n/forkNamespace.registration.test.ts`
- Modify: `src/i18n/config.js` (exactly 2 lines)

**Interfaces:**
- Produces: `registerForkNamespace(i18nInstance)` exported from `src/i18n/forkNamespace.js`; namespace name string `'fork'`; fork.json shape `{ branch: {...}, editSentPrompt: {...}, sessionLock?: {...} }`. Task 2 relies on keys resolving as `fork:branch.*`, `fork:editSentPrompt.*`, `fork:sessionLock.*`.

- [ ] **Step 1: Write the structural guard test (it must fail — files don't exist yet)**

Create `src/i18n/forkNamespace.test.ts`:

```ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const localesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locales');

const ALL_LOCALES = ['de', 'en', 'fr', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'];
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx --test --tsconfig tsconfig.json src/i18n/forkNamespace.test.ts`
Expected: FAIL — `de/fork.json is missing`.

- [ ] **Step 3: Generate the 10 fork.json files (script, not hand-typing)**

Write a throwaway script in the SDD workspace directory (NOT committed to the repo), then run it from the worktree root:

```js
import { readFileSync, writeFileSync } from 'node:fs';
const locales = ['de', 'en', 'fr', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'];
for (const l of locales) {
  const chat = JSON.parse(readFileSync(`src/i18n/locales/${l}/chat.json`, 'utf8'));
  const fork = {};
  if (chat.branch) fork.branch = chat.branch;
  if (chat.input?.editSentPrompt) fork.editSentPrompt = chat.input.editSentPrompt;
  if (chat.sessionLock) fork.sessionLock = chat.sessionLock;
  writeFileSync(`src/i18n/locales/${l}/fork.json`, JSON.stringify(fork, null, 2) + '\n');
}
```

Do NOT edit chat.json in this task — keys are duplicated until Task 3, which is intentional (each task leaves the app working).

- [ ] **Step 4: Run the guard test — it must now pass**

Run: `npx tsx --test --tsconfig tsconfig.json src/i18n/forkNamespace.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create the fork-owned registration module**

Create `src/i18n/forkNamespace.js` (plain JSON imports — same idiom as config.js; Vite and tsx/esbuild both support them):

```js
/**
 * Fork-owned i18n namespace registration (ADR-0001 Rule 2).
 *
 * All fork-feature translation keys live in fork.json per locale, never in
 * upstream's chat.json/settings.json. This module is the single registration
 * point so upstream-owned config.js only carries a 2-line call site.
 * The `fr` locale exists on disk but is not registered in config.js, so it
 * is not registered here either.
 */
import deFork from './locales/de/fork.json';
import enFork from './locales/en/fork.json';
import itFork from './locales/it/fork.json';
import jaFork from './locales/ja/fork.json';
import koFork from './locales/ko/fork.json';
import ruFork from './locales/ru/fork.json';
import trFork from './locales/tr/fork.json';
import zhCNFork from './locales/zh-CN/fork.json';
import zhTWFork from './locales/zh-TW/fork.json';

export const FORK_NAMESPACE = 'fork';

const forkResources = {
  de: deFork,
  en: enFork,
  it: itFork,
  ja: jaFork,
  ko: koFork,
  ru: ruFork,
  tr: trFork,
  'zh-CN': zhCNFork,
  'zh-TW': zhTWFork,
};

/**
 * Registers the fork namespace on an initialized i18next instance.
 * addResourceBundle marks the namespace as loaded, so useTranslation(['chat', 'fork'])
 * resolves synchronously with the static-resources setup config.js uses.
 */
export function registerForkNamespace(i18nInstance) {
  for (const [lng, bundle] of Object.entries(forkResources)) {
    i18nInstance.addResourceBundle(lng, FORK_NAMESPACE, bundle, true, false);
  }
}
```

- [ ] **Step 6: Write the registration behavior test**

Create `src/i18n/forkNamespace.registration.test.ts`:

```ts
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
```

If tsx cannot load the JSON imports in `forkNamespace.js` (unlikely — esbuild handles JSON), report BLOCKED with the observed error; the sanctioned fallback is splitting a pure `registerForkNamespace(i18n, resources)` core from the JSON-importing wrapper — do not invent another mechanism.

- [ ] **Step 7: Run the registration test**

Run: `npx tsx --test --tsconfig tsconfig.json src/i18n/forkNamespace.registration.test.ts`
Expected: PASS.

- [ ] **Step 8: Add the 2-line call site to config.js**

In `src/i18n/config.js`: add one import near the other local imports:

```js
import { registerForkNamespace } from './forkNamespace.js';
```

and one call immediately AFTER the `i18n.use(...).init({...})` statement completes (before the `i18n.on('languageChanged', ...)` block):

```js
registerForkNamespace(i18n);
```

The whole config.js diff must be exactly these 2 added lines. Do not add `'fork'` to the `ns` array — `addResourceBundle` self-registers the namespace, and keeping the array untouched keeps the upstream diff minimal.

- [ ] **Step 9: Full verification and commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: client suite now 69 + 4 = 73 pass (3 structural + 1 registration), 0 fail; server 232 pass unchanged; typecheck and lint green; `git diff --numstat -- src/i18n/config.js` shows `2 0`.

```bash
git add src/i18n/locales/*/fork.json src/i18n/forkNamespace.js src/i18n/forkNamespace.test.ts src/i18n/forkNamespace.registration.test.ts src/i18n/config.js
git commit -m "feat(i18n): add the fork namespace with fork-owned registration"
```

---

### Task 2: Switch the consumer call sites to the fork namespace

**Files:**
- Modify: `src/components/chat/view/ChatInterface.tsx` (1 useTranslation + 6 t() sites)
- Modify: `src/components/chat/view/subcomponents/BranchSwitcher.tsx` (1 useTranslation + 3 t() sites)
- Modify: `src/components/chat/view/subcomponents/MessageComponent.tsx` (1 useTranslation + 3 t() sites)
- Modify: `src/components/chat/view/subcomponents/ChatComposer.tsx` (1 useTranslation + 3 t() sites)
- Modify: `src/components/chat/view/subcomponents/SessionLockControls.tsx` (2 useTranslation + 2 t() sites)
- Modify: `src/components/chat/hooks/useBranchSwitchController.ts` (1 doc comment only)

**Interfaces:**
- Consumes: the `fork` namespace registered by Task 1 (`fork:branch.*`, `fork:editSentPrompt.*`, `fork:sessionLock.*`).
- Produces: nothing new — behavior-identical UI.

Convention (uniform, for grep-ability): every migrated call gets the explicit `fork:` prefix; each touched `useTranslation('chat')` becomes `useTranslation(['chat', 'fork'])`. Do NOT change any other t() call in these files — they read upstream chat keys.

- [ ] **Step 1: Update useTranslation hooks (6 sites in 5 files)**

In each file, change `useTranslation('chat')` to `useTranslation(['chat', 'fork'])`:
- `ChatInterface.tsx:73`
- `BranchSwitcher.tsx:75`
- `MessageComponent.tsx:62`
- `ChatComposer.tsx:206`
- `SessionLockControls.tsx:20` and `SessionLockControls.tsx:51`

(Line numbers are as of 043d3f3 — re-locate by content if drifted.)

- [ ] **Step 2: Update the 17 t() call sites**

`ChatInterface.tsx` (6): `t('branch.announced', { current, total })` → `t('fork:branch.announced', { current, total })`; `t('branch.switchFailed')` → `t('fork:branch.switchFailed')` (×2); `t('branch.editBlockedWhileRunning')` → `t('fork:branch.editBlockedWhileRunning')`; `t('branch.forkFailedRestored', { defaultValue: ... })` → `t('fork:branch.forkFailedRestored', { defaultValue: ... })` (keep the defaultValue option verbatim); same for `t('branch.forkFailed', ...)`.

`BranchSwitcher.tsx` (3): `t('branch.groupAria')`, `t('branch.previous')`, `t('branch.next')` → `fork:branch.*` equivalents.

`MessageComponent.tsx` (3): `t('branch.editTitle')`, `t('branch.editAria')`, `t('branch.editLabel')` → `fork:branch.*` equivalents.

`ChatComposer.tsx` (3): `t('input.editSentPrompt.dismiss', { defaultValue: 'Dismiss' })` → `t('fork:editSentPrompt.dismiss', { defaultValue: 'Dismiss' })`; `t('input.editSentPrompt.banner')` → `t('fork:editSentPrompt.banner')`; `t('input.editSentPrompt.cancel')` → `t('fork:editSentPrompt.cancel')`. Note the path change: `input.editSentPrompt` → `editSentPrompt` (promoted to top level in fork.json).

`SessionLockControls.tsx` (2): `t('sessionLock.bannerText')` → `t('fork:sessionLock.bannerText')`; the ternary `isStopping ? t('sessionLock.stopping') : t('sessionLock.stopAndResume')` → `fork:sessionLock.*` equivalents.

`useBranchSwitchController.ts:60` (comment only): the doc comment mentions i18n key `branch.announced` — update the backtick path to `fork:branch.announced` so the docs match reality. No code change in this file.

- [ ] **Step 3: Verify no migrated-key reference remains on the old paths**

Run: `grep -rn "t('branch\.\|t('sessionLock\.\|t('input\.editSentPrompt" src --include='*.tsx' --include='*.ts'`
Expected: zero matches.

- [ ] **Step 4: Full verification and commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green, counts unchanged from Task 1's end state (client 73, server 232).

```bash
git add src/components/chat/view/ChatInterface.tsx src/components/chat/view/subcomponents/BranchSwitcher.tsx src/components/chat/view/subcomponents/MessageComponent.tsx src/components/chat/view/subcomponents/ChatComposer.tsx src/components/chat/view/subcomponents/SessionLockControls.tsx src/components/chat/hooks/useBranchSwitchController.ts
git commit -m "refactor(chat): read fork-feature strings from the fork namespace"
```

---

### Task 3: Strip fork keys from upstream chat.json + purity guard + CLAUDE.md status

**Files:**
- Modify: `src/i18n/locales/<locale>/chat.json` ×10 (pure deletions)
- Modify: `src/i18n/forkNamespace.test.ts` (add purity test)
- Modify: `CLAUDE.md` (one parenthetical)

**Interfaces:**
- Consumes: Task 2 must be complete (no code reads the old paths) — re-run the Task 2 Step 3 grep before deleting anything; abort with BLOCKED if it matches.

- [ ] **Step 1: Add the purity test (fails until keys are stripped)**

Append to `src/i18n/forkNamespace.test.ts`:

```ts
test('upstream chat.json no longer contains fork-owned key groups', () => {
  for (const locale of ALL_LOCALES) {
    const chat = loadLocaleFile(locale, 'chat.json');
    assert.ok(!('branch' in chat), `${locale}/chat.json still has the branch group`);
    assert.ok(!('sessionLock' in chat), `${locale}/chat.json still has the sessionLock group`);
    const input = (chat.input ?? {}) as Record<string, unknown>;
    assert.ok(!('editSentPrompt' in input), `${locale}/chat.json still has input.editSentPrompt`);
  }
});
```

Run: `npx tsx --test --tsconfig tsconfig.json src/i18n/forkNamespace.test.ts`
Expected: the new test FAILS (keys still present), the original 3 pass.

- [ ] **Step 2: Check the JSON round-trip formatting assumption, then strip**

First verify per locale that `JSON.stringify(JSON.parse(file), null, 2) + '\n'` reproduces the file byte-identical (throwaway script in the SDD workspace):

```js
import { readFileSync } from 'node:fs';
const locales = ['de', 'en', 'fr', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'];
for (const l of locales) {
  const p = `src/i18n/locales/${l}/chat.json`;
  const raw = readFileSync(p, 'utf8');
  const roundTrip = JSON.stringify(JSON.parse(raw), null, 2) + '\n';
  console.log(l, roundTrip === raw ? 'ROUNDTRIP-OK' : 'ROUNDTRIP-DIFFERS');
}
```

For every ROUNDTRIP-OK locale, strip via script (workspace throwaway):

```js
import { readFileSync, writeFileSync } from 'node:fs';
const locales = ['de', 'en', 'fr', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'];
for (const l of locales) {
  const p = `src/i18n/locales/${l}/chat.json`;
  const chat = JSON.parse(readFileSync(p, 'utf8'));
  delete chat.branch;
  delete chat.sessionLock;
  if (chat.input) delete chat.input.editSentPrompt;
  writeFileSync(p, JSON.stringify(chat, null, 2) + '\n');
}
```

For any ROUNDTRIP-DIFFERS locale (if any): delete the same groups by hand-editing only those line ranges (plus the adjacent comma), never rewriting the whole file.

- [ ] **Step 3: Semantic verification — deletions only, nothing else changed**

Throwaway script in the SDD workspace:

```js
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const locales = ['de', 'en', 'fr', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'];
for (const l of locales) {
  const p = `src/i18n/locales/${l}/chat.json`;
  const before = JSON.parse(execSync(`git show HEAD:${p}`, { encoding: 'utf8' }));
  const after = JSON.parse(readFileSync(p, 'utf8'));
  delete before.branch;
  delete before.sessionLock;
  if (before.input) delete before.input.editSentPrompt;
  assert.deepStrictEqual(after, before, `${l}/chat.json changed beyond the fork-key removal`);
  console.log(l, 'SEMANTIC-OK');
}
```

All 10 must print SEMANTIC-OK. Also check `git diff --numstat -- 'src/i18n/locales/*/chat.json'`: insertions should be 0 or tiny (a comma line when a deleted group was the last member of its parent).

- [ ] **Step 4: Run the full guard test — all 4 tests pass**

Run: `npx tsx --test --tsconfig tsconfig.json src/i18n/forkNamespace.test.ts`
Expected: PASS (4 tests, purity included).

- [ ] **Step 5: Update CLAUDE.md Fork Maintenance Rule 2**

In `CLAUDE.md`, find the exact string `(the namespace lands in a later PR; the rule binds from now)` and replace it with `(landed 2026-07-31: fork.json per locale, registered via src/i18n/forkNamespace.js, enforced by src/i18n/forkNamespace.test.ts)`. No other CLAUDE.md changes.

- [ ] **Step 6: Full verification and commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: client 74 pass / 0 fail (73 from Task 1 + 1 purity), server 232 pass, typecheck/lint green.

```bash
git add src/i18n/locales/*/chat.json src/i18n/forkNamespace.test.ts CLAUDE.md
git commit -m "refactor(i18n): remove fork keys from upstream chat.json and guard purity"
```
