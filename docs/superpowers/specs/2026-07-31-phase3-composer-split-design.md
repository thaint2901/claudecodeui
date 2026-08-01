# Phase 3: Split useChatComposerState by function — design

**Date**: 2026-07-31
**Status**: approved direction (full by-function split), spec pending user review
**Strategic context**: the project now develops **independently** — the upstream-merge requirement is dropped (user decision 2026-07-31: "phát triển độc lập, bỏ yêu cầu merge từ upstream. triển khai theo best technical decision"). ADR-0002 (part of this phase) records that decision and supersedes ADR-0001's conflict-surface rationale. Structural quality is now the sole driver.

## Problem

`src/components/chat/hooks/useChatComposerState.ts` is the unhealthiest file in the codebase: 1,453 lines, the hook body ~1,041 lines, CodeScene 4.15 with a single Brain Method of cc=207, 7 `useState` + 9 `useRef` + 25 `useCallback` + 11 `useEffect` across 9 distinguishable concerns, returned as one 44-key object to a single call site (`ChatInterface.tsx`).

Measured concern map (explorer, 2026-07-31):

| # | Concern | Approx. lines | Notes |
|---|---------|--------------|-------|
| A | Draft text/input core (autosize, per-project localStorage draft, overlay scroll) | 224-231, 1142-1328 | 4 refs, 5 effects |
| B | Attachments/images (paste, dropzone, upload) | 232-234, 660-728, 866-896 | |
| C | Slash-command dispatch & modal (built-in + custom) | 269-593, 616-619 | |
| D | Slash-menu / file-mention wiring | 595-634 | pure passthrough of `useSlashCommands`/`useFileMentions` — already-extracted hooks |
| E | Submit pipeline (`buildSendOptions`, `handleSubmit`, `handleKeyDown`) | 734-1030, 1261-1300 | `handleSubmit` alone touches A+B+C+F+G+I — the cc=207 core |
| F | Message queue (in-flight stash + auto-flush + persistence) | 257-267, 1031-1074, 1169-1194 | |
| G | Edit-sent-prompt / fork | 237-241, 1091-1219 | |
| H | Voice transcript bridge | 1134-1140 | 7 lines |
| I | Session/abort/permission plumbing | 1330-1396 | |

Known hazards any split must respect:
- **Ref-seam contract**: `handleSubmitRef` and `lastEditSubmissionRef` exist specifically to break circular dependencies between F/G and E, and to dodge TDZ declaration-order constraints (`react-hooks/exhaustive-deps` does not catch declared-too-late references — CLAUDE.md gotcha).
- **Referential stability**: every callback that reaches message rows must keep `useCallback`-stable identity; an inline-arrow regression here shipped once before (CLAUDE.md gotcha).
- **Zero test coverage**: no current client test loads this hook.

## Design

### Invariant: the orchestrator keeps the external contract

`useChatComposerState.ts` is NOT deleted. It becomes a composition root: same hook signature, same 44-key return object, internally composed of the extracted hooks. Consequences: `ChatInterface.tsx` diff is 0 lines; row-facing callback identities are unchanged; the split is invisible to every consumer.

Simplifying the 44-key contract itself is explicitly deferred (recorded as a follow-up, not part of this phase). One contract change per phase.

### Extracted hooks — new folder `src/components/chat/hooks/composer/`

| New hook | Concern | Owns |
|----------|---------|------|
| `useComposerDraft.ts` | A | `input` interplay, `textareaRef` + autosize refs/effects, localStorage draft persistence, overlay scroll sync, `handleInputChange`/`handleTextareaClick`/`handleTextareaInput`/`handleClearInput` |
| `useComposerAttachments.ts` | B | `attachedImages`/`uploadingImages`/`imageErrors`, dropzone config, `handleImageFiles`/`handlePaste` |
| `useSlashDispatch.ts` | C | `commandModalPayload`, `handleBuiltInCommand`/`handleCustomCommand`/`executeCommand`/`closeCommandModal`/`showCostModal` |
| `useMessageQueue.ts` | F | `queuedDraft` state, flush/persist/session-swap effects, `editQueuedDraft`/`deleteQueuedDraft` |
| `useEditSentPromptFork.ts` | G | `editingSentPrompt` + mirror ref, `startEditSentPrompt`/`cancelEditSentPrompt`/`restoreEditSentPrompt`/`clearEditSubmission`, session-switch cancel effect |
| `useSubmitPipeline.ts` | E | `buildSendOptions`, `handleSubmit`, `handleKeyDown` — consumes the other hooks' interfaces as parameters |
| `useComposerActions.ts` | I | `handleAbortSession`/`handleGrantToolPermission`/`handlePermissionDecision`, `isInputFocused` |

D stays a passthrough in the orchestrator (its owners `useSlashCommands`/`useFileMentions` already exist as separate files). H (7-line voice bridge) stays in the orchestrator — too small for a file.

### Seam contract

- The orchestrator owns `handleSubmitRef` and `lastEditSubmissionRef` and passes them down as parameters — the existing, proven ref-indirection pattern; no new mechanism invented.
- Each extracted hook receives a narrow parameter object (only what it reads/calls) and returns a narrow API. Extracted hooks MUST NOT import each other; all cross-concern wiring flows through the orchestrator.
- Cross-group writes stay explicit: e.g. `useMessageQueue`'s flush needs `restoreDraft(text, images)` + `submitViaRef()` — both injected by the orchestrator, not imported.

### Execution order (one hook per commit, least-coupled first)

Stage 0 (gate for everything): **characterization tests before any extraction.** Cover, at minimum: queue flush triggers submit exactly once after loading ends; edit-fork branch in submit produces fork send-options and clears edit state; slash-command text is intercepted (not sent as chat); session-switch cancels an in-progress edit and clears input; draft persists per-project. Pattern: `useChatMessages.test.ts` (runs under `tsx --test`). If the hook's import chain crashes the runner (react-syntax-highlighter interop), report BLOCKED — do not fake the tests.

Then extraction commits in order: **G → C → B → F → I → A → E** (E last: it is the coupling core; by then every dependency it needs exists as an injected interface). After each commit: `npm test` green + `npm run typecheck` + `npm run lint` (0 errors) + characterization tests green.

### Acceptance gates (scorecard)

- CodeScene Code Health ≥7.0 for the orchestrator AND each extracted hook (baseline: 4.15 monolith); no function cc > 30.
- `npm test` green both tiers; characterization tests green at every commit.
- `ChatInterface.tsx` untouched (0-line diff).
- Manual smoke on a worktree dev instance (SERVER_PORT=3002 VITE_PORT=5174): send, queue-while-loading, edit-sent-prompt fork, slash command, image paste.

## Also in this phase (docs)

- **ADR-0002 — independent development**: records dropping the upstream-merge requirement; supersedes ADR-0001's conflict-surface rationale (ADR-0001 status → "superseded by ADR-0002 (strategic rationale); hygiene rules live on in CLAUDE.md"). Hygiene rules that survive on their own technical merit: fork.json i18n namespace (namespace separation), small focused files, module boundaries.
- **CLAUDE.md**: rewrite the `## Fork Maintenance` section → `## Development Model` (independent development; upstream sync protocol no longer maintained; keep the file-hygiene rules that stand on technical merit).

## Out of scope

- Changing the 44-key return contract or `ChatInterface.tsx` (follow-up).
- The other giant hooks (`useChatSessionState` 4.45, `useProjectsState` 4.61, `useSidebarController`) — same disease, separate phases.
- Any behavior change. This is a behavior-preserving refactor; characterization tests are the referee.
