# Phase 3: Composer Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 1,041-line `useChatComposerState` hook (CodeScene 4.15, one cc=207 Brain Method) into 7 single-concern hooks under `src/components/chat/hooks/composer/`, keeping the orchestrator's external contract byte-identical.

**Architecture:** `useChatComposerState.ts` stays as the composition root — same signature, same return object — and each extraction commit only replaces *where definitions live*, never what the hook returns. Cross-hook wiring flows exclusively through orchestrator-owned refs (`handleSubmitRef`, `lastEditSubmissionRef`) and injected parameters. Extracted hooks never import each other.

**Tech Stack:** React 18 hooks, TypeScript strict, `node:test` + `node:assert/strict` via `tsx --test` (frontend tsconfig `tsconfig.json`, alias `@/*` → `src/*`).

**Spec:** `docs/superpowers/specs/2026-07-31-phase3-composer-split-design.md` (approved 2026-07-31). Deviation from spec recorded there-in §Execution order: effect-level characterization tests are infeasible without a DOM renderer (repo has no jsdom/@testing-library and adds no new deps), so the referee stack is: Task 1 smoke-import test + per-task pure-logic tests + typecheck + eslint react-hooks rules + frozen return block + end-of-phase manual smoke.

## Global Constraints

- **Behavior-preserving refactor.** No user-visible behavior change of any kind.
- **`src/components/chat/view/ChatInterface.tsx` must not change** (0-line diff across the whole phase).
- **The `return {...}` block of `useChatComposerState` must not change** in any extraction commit (Tasks 2–8). Only where the returned bindings are *defined* moves. `git diff` on the file must show the return block untouched.
- **No new dependencies.** `package.json` `dependencies`/`devDependencies` unchanged. No vitest, no jsdom, no @testing-library.
- **Extracted hooks must not import each other.** Each new hook imports only React, shared utils/types, and receives everything else via its single `params` object. Cross-concern calls go through orchestrator-injected callbacks/refs.
- **Referential stability:** every function the orchestrator returns must remain `useCallback`-wrapped with correct minimal deps after extraction. New hooks return memoized callbacks, never fresh closures. (`react-hooks/exhaustive-deps` warnings must not increase; the repo baseline is 249 warnings total, 0 errors.)
- **TDZ hazard:** inside each new hook, keep declaration order such that every closed-over binding is declared above its first use. `exhaustive-deps` does NOT catch declared-too-late references (CLAUDE.md gotcha).
- Every commit: `npm test` green (server 232+/0, client 74+/0 plus new tests), `npm run typecheck` green, `npm run lint` 0 errors, warnings ≤ baseline.
- Single-file test run: `npx tsx --test --tsconfig tsconfig.json <path>` (frontend files need no `--experimental-test-module-mocks`).
- Conventional Commits, no attribution footer.
- The 4 CLAUDE.md perf gotchas around this area are binding context; read the "Gotchas" section of CLAUDE.md before touching anything.

---

### Task 1: Smoke-import gate + composer folder scaffold

**Files:**
- Create: `src/components/chat/hooks/composer/composerImports.test.ts`

**Interfaces:**
- Produces: proof that `useChatComposerState.ts`'s module graph loads under `tsx --test` (the phase's BLOCKED gate), and the `composer/` folder that Tasks 2–8 populate.

- [ ] **Step 1: Write the smoke test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

// Phase 3 gate: the composer hook's module graph must load under tsx --test.
// If this import ever crashes (ESM interop, e.g. react-syntax-highlighter
// entering the chain), the composer split's test referee is void — fix the
// import chain before extending the split.
test('useChatComposerState module graph loads under tsx --test', async () => {
  const mod = await import('../useChatComposerState.js');
  assert.equal(typeof mod.useChatComposerState, 'function');
});
```

- [ ] **Step 2: Run it**

Run: `npx tsx --test --tsconfig tsconfig.json src/components/chat/hooks/composer/composerImports.test.ts`
Expected: PASS. **If it crashes at import time: STOP, report BLOCKED with the error** — the whole phase's test strategy needs renegotiation; do not proceed to Task 2.
Note: if the named export differs (check the actual export style in `useChatComposerState.ts` first — default vs named), adjust the assertion to the real export shape; the point is the import succeeds.

- [ ] **Step 3: Verify suite + commit**

Run: `npm run test:client && npm run typecheck && npm run lint`
Expected: all green, client count = previous + 1.

```bash
git add src/components/chat/hooks/composer/composerImports.test.ts
git commit -m "test(chat): smoke-import gate for the composer split"
```

---

### Task 2: Extract G — `useEditSentPromptFork`

**Files:**
- Create: `src/components/chat/hooks/composer/useEditSentPromptFork.ts`
- Modify: `src/components/chat/hooks/useChatComposerState.ts` (concern G: state/refs at ~lines 237-241, callbacks/effects at ~1091-1219 — locate by names below, line numbers drift)

**Interfaces:**
- Consumes: nothing from other tasks (first extraction — least coupled).
- Produces (hook return API, consumed by the orchestrator):

```ts
interface EditSentPromptForkApi {
  editingSentPrompt: EditingSentPrompt | null;      // reuse the existing type/shape as-is
  editingSentPromptRef: React.RefObject<EditingSentPrompt | null>;
  lastEditSubmissionRef: React.MutableRefObject<LastEditSubmission | null>;
  startEditSentPrompt: (...args) => void;           // exact existing signatures — copy verbatim
  cancelEditSentPrompt: (...args) => void;
  restoreEditSentPrompt: (...args) => void;
  clearEditSubmission: (...args) => void;
}
function useEditSentPromptFork(params: { /* every external binding the moved code references — TypeScript enforces the complete list; type each precisely, no `any` */ }): EditSentPromptForkApi
```

- [ ] **Step 1: Read the moved code precisely.** In `useChatComposerState.ts`, locate: `editingSentPrompt` state, `editingSentPromptRef`, `lastEditSubmissionRef`, `startEditSentPrompt`, `cancelEditSentPrompt`, `restoreEditSentPrompt`, `clearEditSubmission`, the mirror-ref effect, and the session-switch cancel effect (the one that also clears input — note exactly which setters it calls).

- [ ] **Step 2: Create `useEditSentPromptFork.ts`** — move that code verbatim into the new hook. Its `params` object receives precisely the external bindings the moved code references (e.g. the input setter and session key the cancel effect uses). Keep every `useCallback`/`useEffect` dep list semantically identical.

- [ ] **Step 3: Rewire the orchestrator.** Replace the moved definitions with one call:

```ts
const editFork = useEditSentPromptFork({ /* args */ });
const { editingSentPrompt, editingSentPromptRef, lastEditSubmissionRef,
        startEditSentPrompt, cancelEditSentPrompt, restoreEditSentPrompt,
        clearEditSubmission } = editFork;
```

The destructured names keep every downstream reference (incl. `handleSubmit`'s G-branch and the return block) compiling untouched.

- [ ] **Step 4: Verify**

Run: `npm run test:client && npm run typecheck && npm run lint`
Also: `git diff src/components/chat/hooks/useChatComposerState.ts` — confirm the `return {...}` block shows zero changed lines, and `git diff --stat` shows ChatInterface.tsx absent.

- [ ] **Step 5: Commit**

```bash
git add -A src/components/chat/hooks/
git commit -m "refactor(chat): extract useEditSentPromptFork from the composer hook"
```

---

### Task 3: Extract C — `useSlashDispatch` (+ first pure-logic test)

**Files:**
- Create: `src/components/chat/hooks/composer/useSlashDispatch.ts`
- Create: `src/components/chat/hooks/composer/useSlashDispatch.test.ts`
- Modify: `src/components/chat/hooks/useChatComposerState.ts` (concern C: ~lines 269-593, 616-619 — `handleBuiltInCommand`, `handleCustomCommand`, `executeCommand`, `closeCommandModal`, `showCostModal`, `commandModalPayload` state)

**Interfaces:**
- Consumes: `handleSubmitRef` pattern — `handleCustomCommand` re-invokes `handleSubmitRef.current` (forward ref into E). The orchestrator passes `handleSubmitRef` in as a param; the ref is orchestrator-owned.
- Produces:

```ts
interface SlashDispatchApi {
  commandModalPayload: CommandModalPayload | null;  // move the CommandModalPayload/CommandModalKind type exports WITH the hook; CommandResultModal.tsx imports these types — update its import path in this task (type-only move, allowed; it is not ChatInterface)
  closeCommandModal: () => void;
  executeCommand: (...) => ...;                     // exact existing signature
  showCostModal: (...) => ...;
}
function useSlashDispatch(params: { handleSubmitRef: ..., /* + every other external binding, typed */ }): SlashDispatchApi
```

- [ ] **Step 1: Write the failing pure-logic test.** `executeCommand`'s core decision — "does this input dispatch as a command, and which kind" — must become a named pure function `classifyCommandInvocation` exported from `useSlashDispatch.ts`. Write the test FIRST against the cases the current code handles (read the source to fill exact expected shapes — built-in vs custom vs not-a-command):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommandInvocation } from './useSlashDispatch.js';

test('plain chat text is not a command', () => {
  assert.equal(classifyCommandInvocation('hello world').kind, 'none');
});
test('slash prefix classifies as a command invocation', () => {
  const r = classifyCommandInvocation('/compact focus on X');
  assert.notEqual(r.kind, 'none');
  assert.equal(r.name, 'compact');
  assert.equal(r.args, 'focus on X');
});
test('bare slash is not a command', () => {
  assert.equal(classifyCommandInvocation('/').kind, 'none');
});
```

Adjust field names/kinds to what the existing code actually distinguishes — the test encodes CURRENT behavior (characterization), not desired behavior. Run it: FAIL (function does not exist yet).

- [ ] **Step 2: Extract the hook.** Move concern C verbatim; carve the classification expression out of the moved `executeCommand` into exported pure `classifyCommandInvocation` (same logic, no behavior change). Run the test: PASS.

- [ ] **Step 3: Rewire orchestrator** (same destructure pattern as Task 2), update `CommandResultModal.tsx`'s type import path.

- [ ] **Step 4: Verify** — full client suite + typecheck + lint + return-block-frozen check + ChatInterface absent from diff.

- [ ] **Step 5: Commit**

```bash
git add -A src/components/chat/
git commit -m "refactor(chat): extract useSlashDispatch with a pure command classifier"
```

---

### Task 4: Extract B — `useComposerAttachments`

**Files:**
- Create: `src/components/chat/hooks/composer/useComposerAttachments.ts`
- Modify: `src/components/chat/hooks/useChatComposerState.ts` (concern B: state ~232-234, `handleImageFiles`/`handlePaste`/`useDropzone` config ~660-728)

**Interfaces:**
- Produces:

```ts
interface ComposerAttachmentsApi {
  attachedImages: AttachedImage[];                  // existing types as-is
  setAttachedImages: React.Dispatch<...>;           // exported IF other concerns set it (queue restore, submit clear) — check callers first
  uploadingImages: ...; imageErrors: ...;
  handleImageFiles: (...) => ...; handlePaste: (...) => ...;
  dropzone: ReturnType<typeof useDropzone>;         // or the individual getRootProps/getInputProps/isDragActive the return block exposes — match the return block exactly
}
```

- [ ] **Step 1: Identify every writer of B's state** outside concern B (`handleSubmit` clears images; queue flush/`editQueuedDraft` restores them). The setters those sites need must be part of the returned API.
- [ ] **Step 2: Extract hook verbatim; rewire orchestrator destructure.**
- [ ] **Step 3: Verify** (suite/typecheck/lint/frozen-return/no-ChatInterface).
- [ ] **Step 4: Commit** — `refactor(chat): extract useComposerAttachments from the composer hook`

---

### Task 5: Extract F — `useMessageQueue` (+ flush-decision pure test)

**Files:**
- Create: `src/components/chat/hooks/composer/useMessageQueue.ts`
- Create: `src/components/chat/hooks/composer/useMessageQueue.test.ts`
- Modify: `src/components/chat/hooks/useChatComposerState.ts` (concern F: ~257-267, 1031-1074, 1169-1194 — `queuedDraft`, `wasLoadingRef`, `flushSessionKeyRef`, `queuedDraftSessionRef`, flush/persist/session-swap effects, `editQueuedDraft`, `deleteQueuedDraft`)

**Interfaces:**
- Consumes: `handleSubmitRef` (orchestrator-owned, injected), `setInput`/`setAttachedImages`-style restore callbacks (injected as one `restoreDraft(text, images)` param built by the orchestrator from Task 4's API).
- Produces:

```ts
interface MessageQueueApi {
  queuedDraft: QueuedDraft | null;
  editQueuedDraft: (...) => void;
  deleteQueuedDraft: (...) => void;
}
export function shouldFlushQueuedDraft(args: {
  wasLoading: boolean; isLoading: boolean;
  queuedDraft: QueuedDraft | null;
  sessionKey: string | null; flushedSessionKey: string | null;
}): boolean;
```

- [ ] **Step 1: Write the failing flush-decision test** (characterizes the CURRENT gate exactly — read the flush effect's condition and mirror it):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldFlushQueuedDraft } from './useMessageQueue.js';

const draft = { text: 'queued', images: [] } as never;
test('flushes exactly on the loading→idle edge with a draft for this session', () => {
  assert.equal(shouldFlushQueuedDraft({ wasLoading: true, isLoading: false, queuedDraft: draft, sessionKey: 's1', flushedSessionKey: null }), true);
});
test('no flush while still loading', () => {
  assert.equal(shouldFlushQueuedDraft({ wasLoading: true, isLoading: true, queuedDraft: draft, sessionKey: 's1', flushedSessionKey: null }), false);
});
test('no flush without a queued draft', () => {
  assert.equal(shouldFlushQueuedDraft({ wasLoading: true, isLoading: false, queuedDraft: null, sessionKey: 's1', flushedSessionKey: null }), false);
});
test('no double flush for the same session key', () => {
  assert.equal(shouldFlushQueuedDraft({ wasLoading: true, isLoading: false, queuedDraft: draft, sessionKey: 's1', flushedSessionKey: 's1' }), false);
});
test('no flush when idle without a preceding loading turn', () => {
  assert.equal(shouldFlushQueuedDraft({ wasLoading: false, isLoading: false, queuedDraft: draft, sessionKey: 's1', flushedSessionKey: null }), false);
});
```

Match arg names/semantics to the real condition — if the actual gate uses different state (e.g. no flushedSessionKey), encode what IS there; the test documents current behavior. Run: FAIL.

- [ ] **Step 2: Extract the hook**, carving the effect's condition into `shouldFlushQueuedDraft` (pure, exported) and calling it from the effect. Run test: PASS.
- [ ] **Step 3: Rewire orchestrator** (inject `handleSubmitRef` + `restoreDraft`).
- [ ] **Step 4: Verify** (suite/typecheck/lint/frozen-return/no-ChatInterface).
- [ ] **Step 5: Commit** — `refactor(chat): extract useMessageQueue with a pure flush gate`

---

### Task 6: Extract I — `useComposerActions`

**Files:**
- Create: `src/components/chat/hooks/composer/useComposerActions.ts`
- Modify: `src/components/chat/hooks/useChatComposerState.ts` (concern I: ~1330-1396 — `handleAbortSession`, `handleGrantToolPermission`, `handlePermissionDecision`, `isInputFocused`, `handleInputFocusChange`)

**Interfaces:**
- Produces: those five bindings, exact existing signatures, behind `useComposerActions(params)`.

- [ ] **Step 1: Extract verbatim; rewire destructure.**
- [ ] **Step 2: Verify** (suite/typecheck/lint/frozen-return/no-ChatInterface).
- [ ] **Step 3: Commit** — `refactor(chat): extract useComposerActions from the composer hook`

---

### Task 7: Extract A — `useComposerDraft`

**Files:**
- Create: `src/components/chat/hooks/composer/useComposerDraft.ts`
- Modify: `src/components/chat/hooks/useChatComposerState.ts` (concern A: ~224-231, 1142-1328 — textarea refs, autosize, overlay scroll sync, per-project localStorage draft persist/restore, `handleInputChange`/`handleTextareaClick`/`handleTextareaInput`/`handleClearInput`)

**Interfaces:**
- Consumes: `input`/`setInput` stay WHERE THEY ARE TODAY (the explorer found `input` comes via a sibling-hook setter — verify and preserve that ownership; this hook manages the textarea mechanics around it, not the value's owner).
- Produces: the refs + handlers listed above, exact existing signatures. `handleInputChange` also calls slash-menu/file-mention update callbacks (concern D) — inject those as params.

- [ ] **Step 1: Extract verbatim (largest move — 4 refs, 5 effects); rewire destructure.**
- [ ] **Step 2: Verify** (suite/typecheck/lint/frozen-return/no-ChatInterface). Manual quick-check on the dev instance is worthwhile here (autosize + draft restore are visible behaviors): optional but recommended.
- [ ] **Step 3: Commit** — `refactor(chat): extract useComposerDraft from the composer hook`

---

### Task 8: Extract E — `useSubmitPipeline` (+ send-options pure test)

**Files:**
- Create: `src/components/chat/hooks/composer/useSubmitPipeline.ts`
- Create: `src/components/chat/hooks/composer/useSubmitPipeline.test.ts`
- Modify: `src/components/chat/hooks/useChatComposerState.ts` (concern E: ~734-1030, 1261-1300 — `buildSendOptions`, `handleSubmit`, `handleKeyDown`, `handleSubmitRef` sync effect)

**Interfaces:**
- Consumes: the APIs of Tasks 2-7 (injected by the orchestrator as typed params — draft handlers, attachments API, `executeCommand`, queue API, edit-fork API incl. `lastEditSubmissionRef`), plus provider/session state the current code takes from hook args.
- Produces:

```ts
interface SubmitPipelineApi {
  handleSubmit: (...) => ...;   // exact existing signatures
  handleKeyDown: (...) => ...;
}
export function computeSendOptions(args: { /* the full input set buildSendOptions reads today, incl. editingSentPrompt/lastEditSubmission */ }): SendOptions;
```

`handleSubmitRef` stays orchestrator-owned; the orchestrator keeps the one-line effect syncing `handleSubmitRef.current = handleSubmit` AFTER this hook returns (preserves the F/G→E seam without ordering hazards).

- [ ] **Step 1: Write the failing send-options test.** Extract `buildSendOptions`'s body into exported pure `computeSendOptions`. Characterize at minimum: (a) plain send → no fork fields; (b) with an active edit-fork submission → the fork fields (`forkSession`/`resumeSessionAt`-style — use the REAL field names from the source) are present and edit state is reflected. Write the cases from the source, run: FAIL.
- [ ] **Step 2: Extract the hook + pure function.** Run test: PASS.
- [ ] **Step 3: Rewire orchestrator.** After this task the orchestrator body should be: sibling-hook passthroughs (D), voice bridge (H), the composed hook calls, the seam refs, and the frozen return block.
- [ ] **Step 4: Verify everything:** `npm test` (both tiers) + typecheck + lint + frozen-return + `git diff main --stat` shows ChatInterface.tsx absent across the whole branch.
- [ ] **Step 5: Commit** — `refactor(chat): extract useSubmitPipeline and slim the composer orchestrator`

---

### Task 9: ADR-0002 + CLAUDE.md development model

**Files:**
- Create: `docs/adr/ADR-0002-independent-development.md`
- Modify: `CLAUDE.md` (the `## Fork Maintenance` section only)
- Modify: `docs/adr/ADR-0001-fork-customization-strategy.md` (Status line only)

**Interfaces:** none (docs).

- [ ] **Step 1: Write ADR-0002** — Nygard format: title `# ADR-0002: Independent development — the upstream-merge requirement is dropped`; Date 2026-07-31; Status accepted; Deciders: thaint2901. Context: fork history (96 commits ahead at decision time), the measured conflict cost that motivated ADR-0001, and the user's 2026-07-31 decision to develop independently ("phát triển độc lập, bỏ yêu cầu merge từ upstream"). Decision: upstream `siteboon/claudecodeui` is no longer merged; upstream remains a read-only reference for cherry-picking ideas at most. Alternatives: (a) keep periodic syncs — rejected: conflict cost + the fork's direction now diverges on product level; (b) re-fork later if needed — noted as the escape hatch (git remote stays configured). Consequences: ADR-0001's conflict-surface rationale is superseded (its hygiene rules — fork.json namespace, focused files, module boundaries — survive on technical merit); scorecard drops upstream-overlap metrics, keeps health/structure metrics; future phases optimize purely for structural quality.
- [ ] **Step 2: Update ADR-0001 Status** to `superseded by ADR-0002 (strategic rationale; hygiene rules live on in CLAUDE.md)`.
- [ ] **Step 3: Rewrite CLAUDE.md `## Fork Maintenance` → `## Development Model`:** state independent development per ADR-0002; delete the upstream sync protocol rule; keep (reworded as general hygiene, no longer fork-rationale): new logic in new focused files; i18n fork.json namespace for app-specific keys.
- [ ] **Step 4: Verify** `npm run lint` (markdown untouched by lint but command must stay green) and commit:

```bash
git add docs/adr/ CLAUDE.md
git commit -m "docs(adr): record independent development and retire the upstream-sync protocol"
```

---

### Task 10: Final gates, push, draft PR (controller-executed)

**Files:** none (verification + shipping).

- [ ] **Step 1: Full suite + baselines:** `npm test`, `npm run typecheck`, `npm run lint` (0 errors, warnings ≤ 249).
- [ ] **Step 2: CodeScene gate (controller runs via MCP):** score `useChatComposerState.ts` + all 7 new hooks. Target: every file ≥ 7.0, no function cc > 30. Below target → one targeted fix round on the offending file.
- [ ] **Step 3: Manual smoke (controller, dev instance `SERVER_PORT=3002 VITE_PORT=5174 npm run dev`):** send message; queue while loading then auto-flush; edit-sent-prompt fork; slash command (built-in + custom); image paste. Kill instance child pids individually afterwards (CLAUDE.md gotcha).
- [ ] **Step 4: Push + draft PR** titled `refactor(chat): split useChatComposerState into single-concern composer hooks (phase 3)`, body: goal, hook table, referee stack, CodeScene before/after, ADR-0002 note, ending with the standard generated-with line.
