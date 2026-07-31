# Phase 0+1: Test safety net + fork-maintenance standards

> **Correction (2026-07-31, post-review):** the divergence figures quoted below in Tasks 4-5 (159 commits ahead, 73 overlap files, ChatInterface 24-vs-9) were measured on local `main`'s merge-inflated DAG and are wrong. The shipped CLAUDE.md/ADR-0001 carry the corrected numbers (96 / 37 / 9-vs-32) plus the exact measurement commands — `docs/adr/ADR-0001-fork-customization-strategy.md` is authoritative. This plan is kept unedited below as the historical execution record.

Goal: make the existing test suite runnable and green via `npm test`, correct two false claims in CLAUDE.md, and codify the fork-customization strategy (ADR-0001 + CLAUDE.md section). This is the enabler PR for the refactor sequence — no product runtime code changes.

Baseline (measured 2026-07-31 on b9a6f50): server suite 228 pass / 3 fail in 44 files; client suite 69 pass / 1 crashing file (9 files). All 53 test files use `node:test` + `node:assert/strict`. There is no `npm test` script. Failures are stale tests, not product bugs.

## Global Constraints

- **No product runtime code changes.** Only these may change: test files, `package.json` scripts block, `CLAUDE.md`, new files under `docs/adr/`. The single file rename in Task 3 is the only change under `src/`.
- Every commit must pass `npm run typecheck` and `npm run lint` (0 errors; pre-existing warnings are acceptable and must not increase).
- Test framework is `node:test` + `node:assert/strict` run via `tsx --test`. Do NOT introduce vitest, jest, or any new dependency. `package.json` `dependencies`/`devDependencies` must not change.
- Conventional Commits, no attribution footer (project disables attribution globally).
- Backend tests need `--experimental-test-module-mocks` (Node 24, `mock.module`). Backend tsconfig is `server/tsconfig.json` (alias `@/*` → `server/*`); frontend tsconfig is `tsconfig.json` (alias `@/*` → `src/*`). The two suites cannot share one invocation.
- Do not modify `.claude/**`, `src/i18n/**`, or any file under `server/` outside the two test files named in Tasks 1–2.

## Task 1: Fix the two stale assertions in rename-session.service.test.ts

File: `server/modules/providers/tests/rename-session.service.test.ts`.

Two tests fail because the implementation's return shape gained a `writeBack` boolean (added by the fork-name-writeback work) that the expected objects don't include:

- "renameSessionById updates the DB and writes back a custom-title event for Claude sessions" — actual includes `writeBack: true` (verify by running)
- "renameSessionById still succeeds when the session has no transcript on disk" — actual `{ sessionId: 'app-rename-2', summary: 'Still renamed', writeBack: false }`, expected lacks `writeBack`

Steps:
1. Read the implementation of `renameSessionById` (follow the import in the test file) and confirm the documented return contract includes `writeBack: boolean` (true when the on-disk write-back landed, false when swallowed).
2. Update ONLY the expected objects in the two failing assertions to include the correct `writeBack` value per case. Do not change the implementation. Do not restructure the tests.
3. Verify: `npx tsx --test --experimental-test-module-mocks --tsconfig server/tsconfig.json server/modules/providers/tests/rename-session.service.test.ts` → all tests in the file pass.
4. Commit: `test(providers): expect the writeBack flag renameSessionById now returns`

## Task 2: Resolve the duplicate claude-sdk-options test file

Two files test the same subject and have diverged:
- `server/claude-sdk-options.test.ts` (81 lines, root) — passes; the newer, canonical version
- `server/tests/claude-sdk-options.test.js` (45 lines) — fails with `'1' !== undefined` on "always forwards subagent text, but does not enable fork-subagent by default"; it is a stale fork of the same tests

Note: `server/tests/claude-sdk-fork-options.test.js` is a DIFFERENT, passing file — do not touch it.

Steps:
1. Read both files fully. Run `git log --oneline --follow` on each to confirm which is newer.
2. For each test case in the `.js` file, confirm an equivalent (same behavior under test) exists in the `.ts` file. If a `.js` case covers behavior the `.ts` file does not AND the assertion matches the CURRENT implementation's actual behavior (verify by running), port it into the `.ts` file in the same style.
3. Delete `server/tests/claude-sdk-options.test.js`.
4. Verify: `npx tsx --test --experimental-test-module-mocks --tsconfig server/tsconfig.json server/claude-sdk-options.test.ts` passes, and `server/tests/claude-sdk-fork-options.test.js` remains untouched.
5. Commit: `test(server): drop the stale duplicate of claude-sdk-options and keep the ts version`

## Task 3: Wire npm test scripts and disable the known-crashing client test

Part A — rename the crasher. `src/components/chat/tools/components/SubagentContainer.test.ts` crashes under `tsx --test` at import time (ESM named-export interop through the component chain ToolRenderer → Markdown → react-syntax-highlighter). It cannot run but DOES typecheck, so keep it typechecked while removing it from test discovery:
1. Rename to `src/components/chat/tools/components/SubagentContainer.test-disabled.ts` (git mv).
2. Add a header comment at the top of the file: it is excluded from `npm run test:client` because importing the component chain crashes under tsx --test (react-syntax-highlighter ESM interop); it still typechecks; re-enable by renaming back once the import chain is testable.

Part B — add scripts to `package.json` (scripts block only), exactly:
```json
"test": "npm run test:server && npm run test:client",
"test:server": "tsx --test --experimental-test-module-mocks --tsconfig server/tsconfig.json \"server/**/*.test.ts\" \"server/**/*.test.js\"",
"test:client": "tsx --test --tsconfig tsconfig.json \"src/**/*.test.ts\" \"src/**/*.test.tsx\"",
"test:coverage": "tsx --test --experimental-test-module-mocks --experimental-test-coverage --tsconfig server/tsconfig.json \"server/**/*.test.ts\" \"server/**/*.test.js\""
```
The globs are expanded by Node's test runner (Node ≥21 supports glob args), not the shell — keep them quoted. If glob expansion does not work in this environment, report BLOCKED with the observed error instead of inventing a different mechanism.

Part C — verify and record counts:
1. `npm run test:server` → 0 fail (Tasks 1–2 already landed; expect ~228–230 pass, exact count in your report).
2. `npm run test:client` → 0 fail, 69 pass expected, and confirm the disabled file is NOT executed.
3. `npm test` → exit 0. `npm run typecheck` → green (the renamed file must still be typechecked — run `npx tsc --noEmit -p tsconfig.json` explicitly and confirm no new errors).
4. `npm run test:coverage` → runs and prints a coverage table (do not gate on a threshold).
5. Commit: `test: wire npm test around the node:test suites both tiers already use`

## Task 4: Correct CLAUDE.md's two false claims and add the Fork Maintenance section

File: `CLAUDE.md` (repo root). Three surgical edit groups — do not reflow or reformat anything else:

Group 1 — test-runner truth (multiple places):
- The paragraph claiming test files "are Vitest-style — run them with `npx vitest run <path>`" (in the Common Commands area): rewrite to state all test files use `node:test` + `node:assert/strict`; `npm test` runs both tiers; `npm run test:server` / `test:client` / `test:coverage` exist; a single file runs via `npx tsx --test --experimental-test-module-mocks --tsconfig server/tsconfig.json <path>`.
- The Gotchas bullet starting "**No `npm test` script.**": replace with a bullet documenting the new scripts and that vitest is NOT a dependency. Keep the guidance that `mock.module` tests need `--experimental-test-module-mocks`.
- Any other `vitest` mentions in CLAUDE.md: search the file for "vitest" case-insensitively and update each to match reality.
- Update the reference to `SubagentContainer.test.ts` to the new `test-disabled` filename.

Group 2 — boundaries-lint truth:
- The Key Conventions bullet "**Backend module boundaries are enforced by ESLint.**": append a sentence stating enforcement covers ONLY `server/modules/*`; `server/routes/` and root-level `server/*.js` are unclassified and the rules skip them (verified 2026-07-31: a deep import from `routes/agent.js` into module internals lints clean).

Group 3 — new section `## Fork Maintenance` (place after Key Conventions, before the Editing Checklist):
- One intro line: this repo is a long-lived fork (159 commits ahead as of 2026-07-31); these rules minimize the upstream conflict surface. Full rationale: `docs/adr/ADR-0001-fork-customization-strategy.md`.
- Rule 1 — fork-owned files: new fork logic lives in new files the fork owns; an upstream-owned file receives at most an import plus a ≤2-line call site. Litmus: if `git log --oneline <file> | head` is mostly fork commits on an upstream file, extraction is overdue (current worst: ChatInterface.tsx, 24 fork edits vs 9 upstream).
- Rule 2 — i18n namespace: new fork-feature translation keys go in a `fork.json` namespace per locale, never appended to upstream's `chat.json`/`settings.json` (the namespace lands in a later PR; the rule binds from now).
- Rule 3 — upstream sync protocol: `git rerere` enabled; preview merges with `git merge-tree --write-tree --messages <base> <ours> <theirs>` before merging; diff the file list (`git diff --stat`) of upstream pulls, never trust commit subjects (upstream has removed whole features in innocuously-named PRs).

Verify: `npm run typecheck && npm run lint` still green. Commit: `docs: correct the test-runner and boundaries claims, codify fork maintenance rules`

## Task 5: Write ADR-0001 — fork customization strategy

New file: `docs/adr/ADR-0001-fork-customization-strategy.md` (create `docs/adr/`). Nygard format, exactly these sections: title `# ADR-0001: Extension-point strategy for fork customizations`, **Date** 2026-07-31, **Status** accepted, **Deciders** thaint2901 + Claude architecture-review session.

- **Context** (numbers, all measured 2026-07-31): fork is 159 commits ahead of upstream `siteboon/claudecodeui` (merge-base 27eaf01); 73 files touched by both sides; hottest file on BOTH lists is `src/components/chat/view/ChatInterface.tsx` (24 fork edits vs 9 upstream edits in upstream's last 60 commits); a past upstream merge cost ~30 add/add conflicts concentrated in i18n JSON; planned future customizations follow the same pattern (in-flight branches: hermes provider, computer-use, command-palette).
- **Decision**: adopt an extension-point strategy — (1) additive structure: new features are new `server/modules/*` folders and new `src/components/*` feature folders; (2) fork-owned files: behavior changes to upstream code are extracted into fork-owned hooks/services with ≤2-line call sites in upstream files; (3) fork i18n namespace `fork.json`; (4) provider execution moves behind `IProvider`/registry so adding a provider is one folder + one registry line.
- **Alternatives Considered** (pros/cons/why-not each): (a) status quo inline patching — rejected: measured conflict cost above; (b) full plugin/patch layer isolating all fork code — rejected: upstream cadence is ~3 commits since merge-base, the machinery outweighs the benefit; (c) hard fork, never sync — rejected: loses upstream fixes/features the fork demonstrably absorbs (v1.36.x adoptions).
- **Consequences**: positive — conflict surface shrinks measurably; negative — indirection (call sites + fork files) and a registration discipline to follow; neutral — the scorecard below is the acceptance gate for the refactor phases. Include this baseline→target table: upstream-overlap files 73 → <30; provider registration points 4 → 1; backend dependency cycles 5 → 0; legacy deep-imports bypassing barrels 24 → 0; `MessageKind` definitions 2 → 1; `useChatComposerState` Code Health 4.15 → ≥7; legacy-tier line coverage 0% → ≥50% on refactor-touched paths.

Verify: valid markdown, all five Nygard sections present. Commit: `docs(adr): record the extension-point strategy for fork customizations`
