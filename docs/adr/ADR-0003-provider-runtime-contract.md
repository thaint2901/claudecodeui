# ADR-0003: Provider runtime contract (IProviderRuntime)

**Date:** 2026-08-02
**Status:** accepted
**Deciders:** thaint2901 + Claude phase-4 session

## Context

Execution is the one provider capability that sat outside the `IProvider` abstraction. `IProvider` (`server/shared/interfaces.ts`) already covers models/mcp/auth/skills/sessions/sessionSynchronizer — all read/metadata paths — while the actual agent run lived in 4 unclassified root files (`server/claude-sdk.js` 981 LOC, `cursor-cli.js` 354, `openai-codex.js` 515, `opencode-cli.js` 406) hand-wired into untyped `spawnFns`/`abortFns` object literals at `server/index.js:119-130`. Three call sites imported the spawn functions directly: the WS hub (via config), `routes/agent.js` (`POST /api/agent`), and `routes/git.js` (commit-message generation). A missing map entry was a runtime `undefined is not a function`, not a compile error. The 4 files also deep-imported `modules/providers/services/*` (13 of the measured 24 barrel-bypass imports), invisible to the boundaries linter because they were unclassified.

Measured surface (explorer, 2026-08-02, at `d790e77`):

- Spawn signatures were already uniform: `(command: string, options = {}, ws) => Promise<void>` — the contract formalizes what already existed rather than inventing new shape.
- Four asymmetries the contract must absorb, not erase (behavior-preserving):
  1. **Rejection**: `queryClaudeSDK`/`queryCodex` never reject (errors reported via writer, resolve void); `spawnCursor`/`spawnOpenCode` reject on non-zero exit/spawn error — after emitting `error`+`complete` via the writer.
  2. **Abort**: Claude `async (id) => Promise<boolean>` (awaits SDK `interrupt()`); Cursor/Codex/OpenCode sync `(id) => boolean`. The hub already accepted the union (`chat-websocket.service.ts:67`).
  3. **Writer feature-detect**: only `openai-codex.js` branches on `isSSEStreamWriter || isWebSocketWriter`; the other three call `ws.send(obj)` unconditionally.
  4. **Fork recapture is Claude-only**: the Claude SDK announces a NEW session id mid-stream on forks; Claude's runtime calls `setSessionId` more than once. Other providers must not be forced to implement any of this.
- Abort is keyed by the **provider-native** session id (`run.providerSessionId`), not the app session id.
- `resolveToolApproval`/`getPendingApprovalsForSession` (claude-sdk.js module state) are load-bearing WS-hub dependencies but Claude-only → modeled as an optional capability, not part of the uniform contract.
- Dead exports with zero consumers: all 8 `isXSessionActive`/`getActiveXSessions` getters + `reconnectSessionWriter` (superseded by `chatRunRegistry.attachConnection`).
- `mapCliOptionsToSDK`, `shouldRecaptureSessionId`, `recaptureForkSession` are consumed by tests only — they remain exported from the moved file.

## Decision

Introduce `IProviderRuntime` on `server/shared/interfaces.ts`:

```ts
export interface IProviderRuntime {
  run(command: string, options: ProviderRunOptions, writer: ProviderRunWriter): Promise<void>;
  abort(providerSessionId: string): boolean | Promise<boolean>;
  readonly approvals?: IProviderRuntimeApprovals;
}
```

`run`/`abort` codify the signatures above; the four asymmetries (rejection, sync-vs-async abort, writer feature-detect, fork recapture) stay as per-provider implementation detail behind the one contract, not normalized away. `approvals` is optional and populated only for Claude.

Sequencing was move-first: the 4 root CLI/SDK files moved into `server/modules/providers/list/<provider>/` unchanged (Task 2/3), then thin TS adapter classes (`<provider>-runtime.provider.ts`) were added per provider that implement `IProviderRuntime` by delegating 1:1 to the moved `.js`/SDK module (Task 4), and each adapter was wired onto the provider class as `.runtime`. `server/index.js`'s WS hub config now injects a single DI seam, `resolveRuntime: (provider) => providerRegistry.resolveProvider(provider).runtime`, replacing the `spawnFns`/`abortFns` maps. `routes/agent.js` and `routes/git.js` now call `providerRegistry.resolveProvider(<name>).runtime.run(...)` directly instead of importing spawn functions.

## Alternatives Considered

**(a) Keep the `spawnFns`/`abortFns` maps, just type them.**
Pros: smallest possible diff; no new interface or adapter files.
Cons: does not close the actual gap — a provider still isn't required to *have* an execution capability at the type level, only to appear in a map; three call sites still hand-import functions instead of going through the registry; doesn't reduce registration points (still 2: map entry + registry entry).
Rejected: leaves the untyped-map risk (missing entry = runtime crash) fully in place.

**(b) Have the WS hub import `providerRegistry` directly instead of a `resolveRuntime` DI seam.**
Pros: one fewer indirection to read.
Cons: thickens the websocket↔providers cycle that phase 6 is scoped to break; the hub already depends on the registry's *shape* (`IProviderRuntime`) — importing the module directly would also couple it to the registry's *construction*, closing off the seam phase 6 needs to sever that edge.
Rejected: trades a small readability win for a coupling phase 6 would have to undo.

**(c) Move the 4 files into `modules/providers/list/<p>/` AND convert them to TypeScript in this same task.**
Pros: eliminates the `.js`-in-a-TS-module smell in one pass; gets compile-time checking on the provider internals immediately.
Cons: these files carry 0–35.8% existing line coverage (measured across the 4 files pre-move); a same-task rewrite-and-retype compounds move risk with behavior risk on the least-covered code in the backend, with no regression test net to catch a semantic slip.
Rejected: risk/reward doesn't clear the bar given the coverage floor; deferred to a dedicated TS-conversion phase.

**(d) Normalize `run()` to a single rejection contract (e.g. never reject; always resolve, with errors surfaced only via the writer).**
Pros: one behavior to document and test instead of two.
Cons: is an observable behavior change for Cursor/OpenCode callers that currently `try/catch` around the spawn call — normalizing here would be a silent behavior change riding on what should be a structural (interface-only) refactor.
Rejected: violates behavior-preservation; if wanted, it is its own follow-up change with its own test coverage, not bundled into the contract's introduction.

## Consequences

**Positive:**
- Provider registration points: 4 → 1 (adding a provider's execution capability is now a compile-checked `IProviderRuntime` implementation registered once in `provider.registry.ts`, not a second untyped map entry in `server/index.js`).
- Barrel-bypass deep imports: 24 → 11 (the 13 imports the 4 CLI/SDK files made into `modules/providers/services/*` are now inside the `providers` module boundary instead of crossing it from unclassified root files).
- Dead exports removed: 9 (all 8 `isXSessionActive`/`getActiveXSessions` getters + `reconnectSessionWriter`).
- The 3 call sites that used to hand-import spawn functions (WS hub, `routes/agent.js`, `routes/git.js`) now all resolve execution through `providerRegistry`/`resolveRuntime`, so there is exactly one place execution is looked up, not three.

**Negative:**
- A **latent intra-module cycle** was introduced by this task's own wiring: `provider.registry.ts` → provider class → runtime adapter → CLI file → `provider-models.service.ts` → `provider.registry.ts`. It crashed at module-eval time during Task 4 (the registry singleton wasn't constructed yet when `provider-models.service.ts` captured `providerRegistry.resolveProvider` eagerly at import time) and was neutralized by making that capture lazy — resolved per-call instead of at module load. The cycle itself was **not** dissolved, only defused; it remains latent in the module graph, and dissolving it is explicitly deferred to phase 6. Any future code in this service family that goes back to capturing `providerRegistry` eagerly at module scope will reintroduce the same crash. **Amendment:** a madge elementary-cycle count taken after this task's wiring landed shows the module graph's cycle count rose from 5 to 15, not the single cycle disclosed above — the same adapter→CLI wiring also creates cycle paths through `provider-auth.service.ts` and `sessions.service.ts`, both carrying the identical eager-capture hazard, so a phase-6 engineer must dissolve all three service families, not just `provider-models.service.ts`.
- `resolveToolApproval` (the underlying Claude-only function backing `IProviderRuntimeApprovals.resolve`) returns `undefined` for an unknown request id — it has no return statement at all, so tsc infers `void`. The contract now states this honestly: `resolve` is typed `boolean | undefined` with "falsy for unknown ids" JSDoc (trued up post-review in `bfd6196`). One `@ts-expect-error` remains on the adapter regardless, because `void` is not assignable to `boolean | undefined` in a direct property-assignment position; behavior-preservation forbade adding a return statement to the untyped JS. The WS hub discards the call's value, so no coalescing is needed at the call site.
- `handlePermissionResponse` in the WS hub hardcodes `resolveRuntime('claude')` because the `chat.permission-response` payload carries no provider identifier and there is no `requestId` → run index to derive one from. This reproduces pre-refactor behavior exactly (only Claude's approval function was ever wired), but it means a second provider ever growing interactive approvals would need that index built first. Recorded as a follow-up: thread the provider through the `chat.permission-response` payload.
- `.js` files now living inside `server/modules/providers/list/<provider>/` (`claude-sdk.js`, `cursor-cli.js`, `openai-codex.js`, `opencode-cli.js`) are an acknowledged intermediate state — TypeScript modules importing untyped JS pending a dedicated TS-conversion phase, not a design end-state.

**Incidental fixes landed while executing this task (worth recording, not part of the contract decision itself):**
- `openai-codex.js`'s module-level 30-minute stale-session cleanup `setInterval` got `.unref()`. Task 4's wiring made this file reachable from `provider.registry.ts` for the first time, which meant any process merely touching the registry (e.g. the test suite) would hang on exit instead of draining its event loop naturally.
- `claude-builtin-commands.js` was homed into `server/modules/providers/list/claude/` as a Task 2 amendment (it belongs with the rest of Claude's provider-specific code, not at the `server/` root).
