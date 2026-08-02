# Phase 4: IProviderRuntime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull agent execution (run/abort) behind the provider registry: add `IProviderRuntime` to `IProvider`, move the 4 loose provider files into `server/modules/providers/list/<p>/`, and replace the untyped `spawnFns`/`abortFns` maps at all 3 call sites.

**Architecture:** Contract-first. New types in `server/shared/interfaces.ts` codify (not normalize) today's measured behavior. Files move first (their 13 deep imports become same-module internal, exempt from boundaries lint), thin TS adapters delegate to the moved `.js` files, then the WS hub and REST routes resolve runtimes through `providerRegistry`. Spec: `docs/superpowers/specs/2026-08-02-phase4-provider-runtime-design.md`.

**Tech Stack:** Node 22+/ESM, TypeScript strict (new files only — moved files stay `.js`), node:test + tsx, eslint-plugin-boundaries.

## Global Constraints

- **Behavior-preserving.** Moved files: import-path edits and dead-export deletion ONLY — no logic, formatting, or comment rewrites. New adapters delegate 1:1.
- Asymmetries are codified, not normalized: Cursor/OpenCode `run()` may reject; Claude/Codex never reject; abort is sync (Cursor/Codex/OpenCode) or async (Claude); `approvals` exists only on Claude.
- Every commit: `npm test` green (both tiers), `npm run typecheck` green, `npm run lint` 0 errors and warning count ≤ the baseline recorded in Task 1's report.
- No new dependencies; `package.json` deps unchanged. No vitest/jest.
- Do NOT edit `eslint.config.js` — a config-protection hook blocks it. If a lint fix seems to require it, report BLOCKED with the exact eslint error instead.
- Conventional Commits, NO attribution footer. Never use `--no-verify`.
- Test framework: `node:test` + `node:assert/strict` via `npx tsx --test --experimental-test-module-mocks --tsconfig server/tsconfig.json <path>`.
- Backend alias `@/*` → `server/*` (server/tsconfig.json).

---

### Task 1: Contract types + baseline recording

**Files:**
- Modify: `server/shared/interfaces.ts` (append after the `IProviderSessionSynchronizer` section, before EOF)
- Test: none yet (contract test lands in Task 4 — it needs the registry field)

**Interfaces:**
- Produces: `ProviderRunWriter`, `ProviderRunOptions`, `IProviderRuntimeApprovals`, `IProviderRuntime` — exact shapes below; Tasks 4–6 import them from `@/shared/interfaces.js`.

- [ ] **Step 1: Record baselines.** Run `npm run lint 2>&1 | tail -3` and note the warning count; run `npm test 2>&1 | tail -5` and note pass counts (expect server 232, client 99 — if different, record actuals). Put all numbers in your report; later tasks gate against them.
- [ ] **Step 2: Append the contract to `server/shared/interfaces.ts`** — exactly this block (after the `IProviderSessionSynchronizer` interface):

```ts
// ---------------------------
//----------------- PROVIDER RUNTIME INTERFACE ------------
/**
 * Writer handed to a run. ChatSessionWriter, SSEStreamWriter and the
 * inline writers in routes/git.js all satisfy it today.
 */
export interface ProviderRunWriter {
  send(message: unknown): void;
  /**
   * Optional: how app-level tracking learns the provider-native session id.
   * Claude MAY call this more than once (fork recapture).
   */
  setSessionId?(providerSessionId: string): void;
  userId?: number | string | null;
  isWebSocketWriter?: boolean;
  isSSEStreamWriter?: boolean;
}

/**
 * Options bag for one run. Known keys typed; providers tolerate extras
 * (the hub spreads client options), hence the index signature.
 */
export interface ProviderRunOptions {
  sessionId?: string | null;
  sessionSummary?: string | null;
  cwd?: string;
  projectPath?: string;
  model?: string;
  effort?: string;
  images?: unknown[];
  permissionMode?: string;
  toolsSettings?: Record<string, unknown>;
  skipPermissions?: boolean;
  resume?: boolean;
  forkSession?: boolean;
  forkSubagent?: boolean;
  resumeSessionAt?: string;
  [key: string]: unknown;
}

export interface IProviderRuntimeApprovals {
  /** Resolve a pending canUseTool request. Returns false for unknown ids. */
  resolve(requestId: string, decision: Record<string, unknown>): boolean;
  getPendingForSession(providerSessionId: string): unknown[];
}

/**
 * Execution contract for one provider.
 *
 * run(): resolves when the run ends. MAY reject on spawn/exit failure
 * (Cursor, OpenCode today) but MUST have already emitted `error` +
 * `complete` events via the writer before rejecting — callers treat
 * rejection as already-reported. Claude/Codex never reject.
 *
 * abort(): keyed by the provider-native session id; returns whether a
 * live run was found and signalled. Sync or async per provider.
 */
export interface IProviderRuntime {
  run(command: string, options: ProviderRunOptions, writer: ProviderRunWriter): Promise<void>;
  abort(providerSessionId: string): boolean | Promise<boolean>;
  /** Claude-only tool-approval channel; absent for providers without one. */
  readonly approvals?: IProviderRuntimeApprovals;
}
```

Do NOT add `runtime` to `IProvider` yet — that happens in Task 4 with the adapters (adding it now breaks typecheck: concrete providers wouldn't implement it).
- [ ] **Step 3: Verify** `npm run typecheck` green, `npm run lint` 0 errors.
- [ ] **Step 4: Commit** `feat(providers): define the IProviderRuntime contract types`

### Task 2: Move claude-sdk.js into the claude provider folder

**Files:**
- Move: `server/claude-sdk.js` → `server/modules/providers/list/claude/claude-sdk.js` (git mv, keep name and `.js`)
- Modify: the moved file's import paths + every importer (grep-verified list, step 3)

**Interfaces:**
- Consumes: nothing new. Produces: same exports at the new path; Task 4's adapter imports `./claude-sdk.js` as a sibling.

- [ ] **Step 1: `git mv server/claude-sdk.js server/modules/providers/list/claude/claude-sdk.js`**
- [ ] **Step 2: Fix imports INSIDE the moved file** (mechanical, no logic edits):
  - `./modules/providers/list/claude/claude-models.provider.js` → `./claude-models.provider.js` (now same directory)
  - `./modules/providers/services/<x>.service.js` → `@/modules/providers/services/<x>.service.js` (same module — internal, lint-exempt)
  - `./shared/<x>.js` → `@/shared/<x>.js`; `./services/<x>.js` → `@/services/<x>.js`; `./utils/<x>.js` → `@/utils/<x>.js`; `./load-env.js` or other root-relative imports → `@/<x>.js`
- [ ] **Step 3: Update every importer.** Run `grep -rln "claude-sdk" server/ --include='*.js' --include='*.ts' | grep -v modules/providers/list/claude` — expected importers: `server/index.js`, `server/routes/agent.js`, `server/routes/git.js`, `server/claude-sdk-options.test.ts`, `server/tests/claude-sdk-fork-options.test.js`, possibly `server/modules/websocket/services/chat-session-writer.service.ts` and websocket tests. Update each to `@/modules/providers/list/claude/claude-sdk.js` (or the correct relative path for plain-JS `routes/*` files: `../modules/providers/list/claude/claude-sdk.js`). Report the ACTUAL list you found.
- [ ] **Step 4: Drop dead exports** (zero consumers, verified 2026-08-02): delete the functions `isClaudeSDKSessionActive`, `getActiveClaudeSDKSessions`, `reconnectSessionWriter` and remove them from the export block. Keep `mapCliOptionsToSDK`, `shouldRecaptureSessionId`, `recaptureForkSession`, and all run/abort/approval exports.
- [ ] **Step 5: Lint probe.** `npx eslint server/modules/providers/list/claude/claude-sdk.js server/index.js` — expect 0 errors. If `boundaries/no-unknown` (or any boundaries rule) fires: do NOT edit eslint.config.js; report BLOCKED with the verbatim error.
- [ ] **Step 6: Verify** `npm test` green both tiers, `npm run typecheck`, `npm run lint` 0 errors / warnings ≤ baseline.
- [ ] **Step 7: Commit** `refactor(providers): move claude-sdk.js into the claude provider folder`

### Task 3: Move cursor-cli.js, openai-codex.js, opencode-cli.js (same recipe ×3)

**Files:**
- Move: `server/cursor-cli.js` → `server/modules/providers/list/cursor/cursor-cli.js`; `server/openai-codex.js` → `server/modules/providers/list/codex/openai-codex.js`; `server/opencode-cli.js` → `server/modules/providers/list/opencode/opencode-cli.js`
- Modify: each moved file's imports + importers

**Interfaces:** same exports at new paths; Task 4 adapters import as siblings.

- [ ] **Step 1: git mv all three** (paths above).
- [ ] **Step 2: Fix imports inside each** (same rules as Task 2 Step 2 — these three import only `@/modules/providers/services/*` trio + shared/utils + image-attachments + notification-orchestrator).
- [ ] **Step 3: Update importers.** Grep per file (`cursor-cli`, `openai-codex`, `opencode-cli`); expected: `server/index.js`, `server/routes/agent.js` (all three), `server/routes/git.js` (cursor only), `server/opencode-cli.test.js` (opencode), `server/modules/providers/services/provider-capabilities.service.ts` has a COMMENT referencing `opencode-cli.js` — update the comment's path text too. Report actual lists.
- [ ] **Step 4: Drop dead exports:** `isCursorSessionActive`, `getActiveCursorSessions`, `isCodexSessionActive`, `getActiveCodexSessions`, `isOpenCodeSessionActive`, `getActiveOpenCodeSessions`. Keep `resolveOpenCodePermissionOptions` (tested) and all spawn/abort exports.
- [ ] **Step 5: Lint probe** on the three moved files: 0 errors expected; BLOCKED protocol as Task 2.
- [ ] **Step 6: Verify** full gates (test/typecheck/lint).
- [ ] **Step 7: Commit** `refactor(providers): move the cursor, codex and opencode runtimes into their provider folders`

### Task 4: Runtime adapters + IProvider.runtime + contract test

**Files:**
- Create: `server/modules/providers/list/claude/claude-runtime.provider.ts`, `.../cursor/cursor-runtime.provider.ts`, `.../codex/codex-runtime.provider.ts`, `.../opencode/opencode-runtime.provider.ts`
- Modify: `server/shared/interfaces.ts` (add `runtime` to `IProvider`), `server/modules/providers/shared/base/abstract.provider.ts`, the 4 concrete provider classes (`claude.provider.ts`, `cursor.provider.ts`, `codex.provider.ts`, `opencode.provider.ts`)
- Test: `server/modules/providers/tests/provider-runtime.test.ts`

**Interfaces:**
- Consumes: contract types (Task 1), moved files (Tasks 2–3).
- Produces: `providerRegistry.resolveProvider(p).runtime` — used by Tasks 5–6.

- [ ] **Step 1: Write the failing test** `server/modules/providers/tests/provider-runtime.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';

const PROVIDERS = ['claude', 'cursor', 'codex', 'opencode'] as const;

test('every provider exposes a runtime with run and abort', () => {
  for (const id of PROVIDERS) {
    const runtime = providerRegistry.resolveProvider(id).runtime;
    assert.ok(runtime, `${id} runtime missing`);
    assert.equal(typeof runtime.run, 'function', `${id} run`);
    assert.equal(typeof runtime.abort, 'function', `${id} abort`);
  }
});

test('only claude exposes the approvals capability', () => {
  const claude = providerRegistry.resolveProvider('claude').runtime;
  assert.equal(typeof claude.approvals?.resolve, 'function');
  assert.equal(typeof claude.approvals?.getPendingForSession, 'function');
  for (const id of ['cursor', 'codex', 'opencode'] as const) {
    assert.equal(providerRegistry.resolveProvider(id).runtime.approvals, undefined, id);
  }
});

test('claude approvals.resolve returns false for an unknown request id', () => {
  const claude = providerRegistry.resolveProvider('claude').runtime;
  assert.equal(claude.approvals?.resolve('nonexistent-request-id', {}), false);
});

test('claude approvals.getPendingForSession returns [] for an unknown session', () => {
  const claude = providerRegistry.resolveProvider('claude').runtime;
  assert.deepEqual(claude.approvals?.getPendingForSession('nonexistent-session'), []);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`runtime` undefined).
- [ ] **Step 3: Create the 4 adapters.** Claude (exact):

```ts
import type {
  IProviderRuntime,
  IProviderRuntimeApprovals,
  ProviderRunOptions,
  ProviderRunWriter,
} from '@/shared/interfaces.js';

import {
  abortClaudeSDKSession,
  getPendingApprovalsForSession,
  queryClaudeSDK,
  resolveToolApproval,
} from './claude-sdk.js';

/**
 * Execution adapter for Claude (Agent SDK). Delegates 1:1 to claude-sdk.js;
 * explicit method bodies so the JS implementation is checked against the
 * IProviderRuntime signature at this boundary.
 */
export class ClaudeRuntimeProvider implements IProviderRuntime {
  run(command: string, options: ProviderRunOptions, writer: ProviderRunWriter): Promise<void> {
    return queryClaudeSDK(command, options, writer);
  }

  abort(providerSessionId: string): Promise<boolean> {
    return abortClaudeSDKSession(providerSessionId);
  }

  readonly approvals: IProviderRuntimeApprovals = {
    resolve: resolveToolApproval,
    getPendingForSession: getPendingApprovalsForSession,
  };
}
```

Cursor/Codex/OpenCode: same shape, importing (`spawnCursor`,`abortCursorSession`) / (`queryCodex`,`abortCodexSession`) / (`spawnOpenCode`,`abortOpenCodeSession`), abort return type `boolean`, NO `approvals` property. If tsc complains about a JS function's inferred params, add a targeted `// @ts-expect-error` ONLY with a one-line reason comment — do not widen the contract types.
- [ ] **Step 4: Wire the field.** `IProvider` gains `readonly runtime: IProviderRuntime;` (after `sessionSynchronizer`); `AbstractProvider` gains `abstract readonly runtime: IProviderRuntime;`; each concrete provider class gains `readonly runtime: IProviderRuntime = new <P>RuntimeProvider();` with the matching import.
- [ ] **Step 5: Run the test — expect PASS.** Full gates.
- [ ] **Step 6: Commit** `feat(providers): expose provider execution through runtime adapters on the registry`

### Task 5: WS hub migration to resolveRuntime

**Files:**
- Modify: `server/modules/websocket/services/chat-websocket.service.ts` (the `ChatWebSocketDependencies` type + 5 call sites), `server/index.js` (chat config + imports)
- Test: update `server/modules/websocket/tests/first-prompt-fork.test.ts`, `server/modules/websocket/tests/fork-name-writeback.test.ts`, `server/modules/websocket/tests/fork-command.test.ts`, `server/modules/websocket/services/tests/chat-websocket-fork.test.ts` (whichever of these mock spawnFns/abortFns — grep `spawnFns` in server/modules/websocket to find the real set)

**Interfaces:**
- Consumes: `providerRegistry.resolveProvider(p).runtime` (Task 4), `IProviderRuntime` type.
- Produces: `ChatWebSocketDependencies.resolveRuntime(provider: LLMProvider): IProviderRuntime` — the new DI seam.

- [ ] **Step 1: Update the type.** In `ChatWebSocketDependencies`, DELETE `spawnFns`, `abortFns`, `resolveToolApproval`, `getPendingApprovalsForSession`; ADD `resolveRuntime(provider: LLMProvider): IProviderRuntime;` (type-only import from `@/shared/interfaces.js`). Delete the now-unused `ProviderSpawnFn`/`ProviderAbortFn` local types if nothing else references them.
- [ ] **Step 2: Rewrite the call sites** (grep `spawnFns\|abortFns\|resolveToolApproval\|getPendingApprovalsForSession` inside the file):
  - spawn (2 sites): `await dependencies.resolveRuntime(provider).run(command, runtimeOptions, run.writer)` (and the fork variant with its own args)
  - abort: `Boolean(await dependencies.resolveRuntime(run.provider).abort(run.providerSessionId))`
  - permission response: `dependencies.resolveRuntime(run.provider).approvals?.resolve(data.requestId, decision) ?? false` — preserve the exact decision-object construction
  - pending approvals: `dependencies.resolveRuntime(run.provider).approvals?.getPendingForSession(run.providerSessionId) ?? []`
- [ ] **Step 3: Update `server/index.js`.** Replace the 4 spawn/abort/approval imports and the `spawnFns`/`abortFns`/`resolveToolApproval`/`getPendingApprovalsForSession` keys with:

```js
import { providerRegistry } from './modules/providers/index.js';
// ... in createWebSocketServer config:
chat: {
    resolveRuntime: (provider) => providerRegistry.resolveProvider(provider).runtime,
},
```

Verify `providerRegistry` IS exported from `server/modules/providers/index.ts` — if not, add the re-export to the barrel (one line).
- [ ] **Step 4: Update the mocking tests.** Replace `spawnFns: { claude: fake }`-style mocks with `resolveRuntime: () => ({ run: fake, abort: fakeAbort })` stubs preserving each test's original fake behavior (incl. rejection fakes). Do not weaken any assertion.
- [ ] **Step 5: Full gates.** `npm test`, typecheck, lint.
- [ ] **Step 6: Commit** `refactor(websocket): resolve provider runtimes through the registry seam`

### Task 6: REST call sites (routes/agent.js, routes/git.js)

**Files:**
- Modify: `server/routes/agent.js` (imports + 4 provider branches in POST /), `server/routes/git.js` (imports + `generateCommitMessageWithAI` claude/cursor branches)

**Interfaces:**
- Consumes: `providerRegistry` from `../modules/providers/index.js`.

- [ ] **Step 1: routes/agent.js.** Delete the 4 direct runtime imports; add `import { providerRegistry } from '../modules/providers/index.js';`. In each provider branch replace `queryClaudeSDK(...)` / `spawnCursor(...)` / `queryCodex(...)` / `spawnOpenCode(...)` with `providerRegistry.resolveProvider('<id>').runtime.run(command, options, writer)` — keep every options object EXACTLY as-is (incl. `permissionMode: 'bypassPermissions'` / `skipPermissions: true`).
- [ ] **Step 2: routes/git.js.** Same swap for its `queryClaudeSDK`/`spawnCursor` calls inside `generateCommitMessageWithAI`.
- [ ] **Step 3: Confirm zero stragglers:** `grep -rn "claude-sdk\|cursor-cli\|openai-codex\|opencode-cli" server/ --include='*.js' --include='*.ts' | grep -v "modules/providers/list" | grep -v test` → must return ONLY comments (if any). Report the output.
- [ ] **Step 4: Full gates + commit** `refactor(routes): run agents through the provider registry runtime`

### Task 7: ADR-0003 + CLAUDE.md

**Files:**
- Create: `docs/adr/ADR-0003-provider-runtime-contract.md`
- Modify: `CLAUDE.md` (4 spots)

- [ ] **Step 1: ADR-0003** — Nygard sections, exactly: title `# ADR-0003: Provider runtime contract (IProviderRuntime)`, **Date** 2026-08-02, **Status** accepted, **Deciders** thaint2901 + Claude phase-4 session. Context: the measured gap (execution outside IProvider; untyped maps; 3 call sites; 13/24 barrel-bypass imports; the 4 asymmetries listed in the spec's Problem section). Decision: IProviderRuntime {run, abort, approvals?} codifying asymmetries; move-first sequencing; thin TS adapters over moved `.js` files; DI seam `resolveRuntime` in the WS hub. Alternatives Considered (pros/cons/why-not): (a) keep spawnFns maps; (b) hub imports registry directly instead of DI — thickens the websocket↔providers cycle phase 6 must break; (c) move + TS-convert now — risk vs 0–35.8% coverage; (d) normalize run() to never-reject — observable behavior change. Consequences: registration points 4→1 (compile-checked), barrel-bypass 24→11, dead exports −9; `.js`-in-modules is an acknowledged intermediate state pending a TS-conversion phase.
- [ ] **Step 2: CLAUDE.md** — surgical edits: (1) "Repository layout" tree: remove the 4 loose-file lines under `server/`, note runtimes live in `modules/providers/list/<p>/`; (2) "How a chat message flows" step 3: spawn functions → "the provider's `runtime` resolved via `providerRegistry`"; (3) "CLI provider model" numbered steps: replace step 1–2 (spawn/abort pair + spawnFns map) with "implement `<p>-runtime.provider.ts` + sub-providers in `server/modules/providers/list/<p>/` and register the provider class in `provider.registry.ts`"; (4) Gotchas: the `claude-sdk.js:192` CLAUDE_CLI_PATH pointer → new path `server/modules/providers/list/claude/claude-sdk.js`. Search CLAUDE.md for `claude-sdk`, `spawnFns`, `cursor-cli`, `opencode-cli`, `openai-codex` and fix every stale path.
- [ ] **Step 3: Gates + commit** `docs: record ADR-0003 and repoint provider-runtime paths in CLAUDE.md`

### Task 8 (controller, not an SDD dispatch): final review + gates + smoke + PR

- Whole-branch review (most capable model), ONE fix dispatch if needed.
- CodeScene: every NEW file ≥7.0; moved `.js` files not below baseline (claude-sdk 6.78 reference).
- Manual smoke ×3 on `SERVER_PORT=3002 VITE_PORT=5174`: WS chat send (Claude, verify streamed reply + on-disk transcript), abort mid-run (UI unblocks), REST generate-commit-message.
- Push, draft PR, memory update.
