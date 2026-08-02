# Phase 4: IProviderRuntime — pull agent execution behind the provider registry

**Date**: 2026-08-02
**Status**: approved direction (option 1: contract + adapters + physical move, no TS conversion), spec pending user review
**Strategic context**: independent development per `docs/adr/ADR-0002-independent-development.md` — structural quality is the sole driver. This phase implements scorecard items "provider registration points 4 → 1" and cuts 13 of the 24 legacy barrel-bypass deep imports.

## Problem

Execution is the one provider capability outside the `IProvider` abstraction. `IProvider` (server/shared/interfaces.ts) covers models/mcp/auth/skills/sessions/sessionSynchronizer — all read/metadata paths — while the actual agent run lives in 4 unclassified root files (`server/claude-sdk.js` 981 LOC, `cursor-cli.js` 354, `openai-codex.js` 515, `opencode-cli.js` 406) hand-wired into untyped `spawnFns`/`abortFns` object literals at `server/index.js:119-130`. Three call sites import the spawn functions directly: the WS hub (via config), `routes/agent.js` (POST /api/agent), `routes/git.js` (commit-message generation). A missing map entry is a runtime `undefined is not a function`, not a compile error. The 4 files also deep-import `modules/providers/services/*` (13 imports), invisible to the boundaries linter because they are unclassified.

Measured surface (explorer, 2026-08-02, at d790e77):

- Spawn signatures are already uniform: `(command: string, options = {}, ws) => Promise<void>` — the contract formalizes what exists.
- Four asymmetries the contract must absorb, not erase (behavior-preserving):
  1. **Rejection**: `queryClaudeSDK`/`queryCodex` never reject (errors reported via writer, resolve void); `spawnCursor`/`spawnOpenCode` reject on non-zero exit/spawn error — after emitting `error`+`complete` via the writer.
  2. **Abort**: Claude `async (id) => Promise<boolean>` (awaits SDK `interrupt()`); Cursor/Codex/OpenCode sync `(id) => boolean`. The hub already accepts the union (`chat-websocket.service.ts:67`).
  3. **Writer feature-detect**: only `openai-codex.js` branches on `isSSEStreamWriter || isWebSocketWriter`; the other three call `ws.send(obj)` unconditionally.
  4. **Fork recapture is Claude-only**: the Claude SDK announces a NEW session id mid-stream on forks; Claude's runtime calls `setSessionId` more than once. Other providers must not be forced to implement any of this.
- Abort is keyed by the **provider-native** session id (`run.providerSessionId`), not the app session id.
- `resolveToolApproval`/`getPendingApprovalsForSession` (claude-sdk.js module state) are load-bearing WS-hub dependencies but Claude-only → optional capability, not part of the uniform contract.
- Dead exports with zero consumers: all 8 `isXSessionActive`/`getActiveXSessions` getters + `reconnectSessionWriter` (superseded by `chatRunRegistry.attachConnection`).
- `mapCliOptionsToSDK`, `shouldRecaptureSessionId`, `recaptureForkSession` are consumed by tests only — they remain exported from the moved file.

## Design

### 1. Contract (the boundary artifact — contract-first)

Added to `server/shared/interfaces.ts` (types to `server/shared/types.ts` where shared):

```ts
/** Writer handed to a run. ChatSessionWriter, SSEStreamWriter and the
 *  inline writers in routes/git.js all satisfy it today. */
export interface ProviderRunWriter {
  send(message: unknown): void;
  /** Optional: how app-level tracking learns the provider-native session id.
   *  Claude MAY call this more than once (fork recapture). */
  setSessionId?(providerSessionId: string): void;
  userId?: number | string | null;
  isWebSocketWriter?: boolean;
  isSSEStreamWriter?: boolean;
}

/** Options bag for one run. Known keys typed; providers tolerate extras
 *  (the hub spreads client options), hence the index signature. */
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
 * abort(): keyed by provider-native session id; returns whether a live
 * run was found and signalled. Sync or async per provider.
 */
export interface IProviderRuntime {
  run(command: string, options: ProviderRunOptions, writer: ProviderRunWriter): Promise<void>;
  abort(providerSessionId: string): boolean | Promise<boolean>;
  /** Claude-only tool-approval channel; absent for providers without one. */
  readonly approvals?: IProviderRuntimeApprovals;
}
```

`IProvider` gains a 7th member: `readonly runtime: IProviderRuntime;` — same pattern as the existing six (abstract field on `AbstractProvider`, field initializer in each concrete provider).

Rationale for codifying (not normalizing) the rejection asymmetry: normalizing would change observable behavior of routes/agent.js and the hub's catch paths — out of scope for a behavior-preserving phase. The JSDoc contract makes today's tolerated union explicit. Revisit only if a 5th provider arrives.

### 2. Physical move — FIRST, before adapters (avoids eslint classification churn)

`git mv` each file, keeping its name and `.js` extension (no logic edits, no TS conversion):

| From | To |
|---|---|
| `server/claude-sdk.js` | `server/modules/providers/list/claude/claude-sdk.js` |
| `server/cursor-cli.js` | `server/modules/providers/list/cursor/cursor-cli.js` |
| `server/openai-codex.js` | `server/modules/providers/list/codex/openai-codex.js` |
| `server/opencode-cli.js` | `server/modules/providers/list/opencode/opencode-cli.js` |

Why move-first: adapters created before the move would be module-classified files importing unclassified root files (`boundaries/no-unknown` risk), requiring a temporary `backend-legacy-runtime` classification that the move would then remove — double churn. Moved first, the files' 13 deep imports into `modules/providers/services/*` become **same-module internal imports** (exempt via `checkInternals: false`), and adapters import siblings.

Import updates in the moved files themselves: `./modules/...`, `./shared/...`, `./services/...`, `./utils/...` relative paths re-pointed via the `@/` alias (`@/shared/utils.js` etc.). Consumers updated mechanically: `server/index.js`, `routes/agent.js`, `routes/git.js` (import path only in this task — the spawnFns maps still exist until tasks 4–6), tests (`server/claude-sdk-options.test.ts`, `server/tests/claude-sdk-fork-options.test.js`, `server/opencode-cli.test.js`).

**Lint probe is part of this task's verify step**: run `npx eslint` on the four moved files and on one importer; if `boundaries/no-unknown` fires on their imports of unclassified top-level files (`server/services/notification-orchestrator.js` is the known candidate), the fix is to classify that dependency explicitly (extend `boundaries/elements` with a file-mode entry, mirroring the existing `backend-legacy-runtime` precedent) — NOT to disable the rule. Record what the probe showed in the task report.

Included cleanup in the move commits (justified: this phase's deliverable IS the formalized execution surface; zero consumers verified 2026-08-02): drop the 8 dead `isXSessionActive`/`getActiveXSessions` exports and `reconnectSessionWriter`. Keep `resolveOpenCodePermissionOptions` (tested), `mapCliOptionsToSDK`/`shouldRecaptureSessionId`/`recaptureForkSession` (tested).

### 3. Runtime adapters — 4 new thin files

`server/modules/providers/list/<p>/<p>-runtime.provider.ts`, each ~20–40 lines:

```ts
// claude-runtime.provider.ts (the richest one; others have no approvals)
import type { IProviderRuntime, IProviderRuntimeApprovals, ProviderRunOptions, ProviderRunWriter } from '@/shared/interfaces.js';
import { queryClaudeSDK, abortClaudeSDKSession, resolveToolApproval, getPendingApprovalsForSession } from './claude-sdk.js';

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

Cursor/Codex/OpenCode analogous, no `approvals`. Explicit delegation methods (not `run = queryClaudeSDK` field aliasing) so the TS signature is checked against the contract at the adapter boundary — the one place a JS implementation drift would surface at compile time.

Each concrete provider class gains `readonly runtime: IProviderRuntime = new <P>RuntimeProvider();`; `AbstractProvider` gains the abstract field.

### 4. WS hub migration — DI shape preserved

`ChatWebSocketDependencies` (chat-websocket.service.ts:59-79) replaces four keys (`spawnFns`, `abortFns`, `resolveToolApproval`, `getPendingApprovalsForSession`) with one:

```ts
resolveRuntime(provider: LLMProvider): IProviderRuntime;
```

Call-site rewrites (behavior identical):
- spawn (lines ~231, ~503, ~387): `dependencies.resolveRuntime(provider).run(command, runtimeOptions, run.writer)`
- abort (~539-542): `Boolean(await dependencies.resolveRuntime(run.provider).abort(run.providerSessionId))`
- permission response (~634): `dependencies.resolveRuntime(run.provider).approvals?.resolve(requestId, decision) ?? false` — today `resolveToolApproval` returns false for unknown request ids regardless of provider; `?? false` preserves exactly that for approvals-less providers.
- pending approvals (~595): `dependencies.resolveRuntime(run.provider).approvals?.getPendingForSession(run.providerSessionId) ?? []`

`server/index.js` chat config shrinks to:

```js
chat: {
  resolveRuntime: (provider) => providerRegistry.resolveProvider(provider).runtime,
},
```

DI (not a direct registry import inside the websocket module) is deliberate: it keeps the websocket→providers edge out of the module graph (phase 6 untangles the existing cycle triangle; this phase must not thicken it) and preserves the established test seam — `first-prompt-fork.test.ts` and friends mock `ChatWebSocketDependencies`; they are updated to provide `resolveRuntime` returning stub runtimes.

### 5. REST call-site migration

- `routes/agent.js` (POST /api/agent, 4 provider branches at lines ~962-995): replace the 4 direct imports with `providerRegistry` (barrel import from `../modules/providers/index.js`) and call `providerRegistry.resolveProvider(p).runtime.run(command, options, writer)`. The hand-rolled SSE/collector writers already satisfy `ProviderRunWriter`.
- `routes/git.js` (`generateCommitMessageWithAI`, lines ~1129-1135): same replacement for its claude/cursor branches; its inline `{ send, setSessionId: () => {} }` writer already satisfies the contract.
- Verify `providerRegistry` is exported from the module barrel (it is: `server/modules/providers/index.ts`).

After tasks 4–6, zero non-test files import the moved runtime files except the sibling adapters. The "add a provider" checklist becomes: create `list/<p>/` folder (runtime + sub-providers) + one line in `provider.registry.ts` (+ UI logo, models list — unchanged frontend steps).

### 6. Tests

- **Contract pin (new)**: `server/modules/providers/tests/provider-runtime.test.ts` — for each of the 4 registry providers: `runtime` exists, `run`/`abort` are functions; Claude exposes `approvals` with both methods, the other three do not; `resolveProvider('claude').runtime.approvals.resolve('nonexistent-id', {})` returns false (pins the unknown-id semantics the hub's `?? false` relies on).
- **Updated**: the 3 moved-file test suites get new import paths (no assertion changes); `first-prompt-fork.test.ts` + `fork-name-writeback.test.ts` + any dependency-mocking hub test switch mocks from `spawnFns`/`abortFns` to `resolveRuntime` stubs.
- **Gates per task**: `npm test` (both tiers), `npm run typecheck`, `npm run lint` (0 errors; warning count not above the branch baseline recorded in Task 1) — every commit.
- **Final gates**: CodeScene ≥7.0 for every NEW file (adapters, contract test); moved `.js` files keep their baseline scores (6.78/…) — improving them is out of scope, gate only that they don't regress. `npx vite build` unaffected (backend-only phase) — skip.
- **Manual smoke (3 call sites × live paths)** on a second dev instance (`SERVER_PORT=3002 VITE_PORT=5174`): (a) WS chat — send a Claude message, verify streamed reply + transcript on disk; (b) abort — start a long run, abort mid-stream, verify the run stops and the UI unblocks; (c) REST — `POST /api/git/generate-commit-message` (or the agent endpoint) returns a generated message. JWT via the established mint recipe.

### 7. Docs in this phase

- **ADR-0003 — provider runtime contract**: Nygard format. Decision: IProviderRuntime with optional approvals capability; codify (not normalize) the rejection asymmetry; adapters + physical move without TS conversion. Alternatives rejected: (a) status quo maps — the measured registration/typo cost; (b) hub imports registry directly (no DI) — thickens the websocket↔providers cycle phase 6 must break; (c) move + TS conversion now — risk against 0–35.8% coverage; (d) normalize run() to never-reject — observable behavior change, violates the phase invariant. Consequences: registration points 4→1 (compile-checked via `Record<LLMProvider, IProvider>`), barrel-bypass deep imports 24→11, dead exports −9; the `.js` files inside `list/<p>/` are an acknowledged intermediate state (TS conversion is its own future phase).
- **CLAUDE.md**: update the "New CLI provider?" editing-checklist bullet (spawn-map step disappears), the repository-layout tree (4 files move), the "How a chat message flows" step 3 (spawn functions resolved via `providerRegistry`), and the `claude-sdk.js:192` pointer in the Gotchas (path changes).

## Execution order (one task per row, SDD)

1. Contract types in `shared/interfaces.ts`/`types.ts` (type-only, zero runtime change) + contract-pin test skeleton marked skipped where it needs later tasks.
2. Move claude-sdk.js (+ lint probe, dead-export drop, consumer import paths, test paths).
3. Move cursor-cli.js + openai-codex.js + opencode-cli.js (same recipe, three files — mechanically identical, one task).
4. Adapters ×4 + `IProvider.runtime` field + registry + un-skip contract test.
5. WS hub migration (`ChatWebSocketDependencies.resolveRuntime`) + hub test updates + delete the 4 spawn/abort imports and map keys from `server/index.js`.
6. REST migration (routes/agent.js, routes/git.js).
7. Docs: ADR-0003 + CLAUDE.md updates.
8. Final: whole-branch review, CodeScene gate, manual smoke, PR.

## Out of scope

- TS conversion of the 4 moved `.js` files (future phase, needs coverage first).
- Normalizing run()/abort() asymmetries (documented instead).
- The websocket↔projects↔providers cycle triangle, `shared/utils.ts` split, wire-type unification (phase 6).
- `routes/agent.js`/`routes/git.js` structural refactors beyond the import swap (phase 5/6 territory).
- Moving `server/opencode-cli.test.js` next to its subject (follow-up note, not required).
