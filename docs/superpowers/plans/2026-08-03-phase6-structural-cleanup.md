# Phase 6: Structural Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dissolve all 16 dependency cycles (15 server + 1 frontend), split and delete the `server/shared/utils.ts` god module, single-source the wire types at root `shared/wire-types.ts` with an exhaustive realtime switch, and extend boundaries lint to the legacy tier.

**Architecture:** Two structural rules kill the cycles (`list/` never imports `services/`; broadcast inverted through a new leaf `server/modules/events/`). Utils exports move to ownership-based homes (4 shared leaf files + provider-module internals). Wire types get one cross-tier source with re-export facades so ~55 importers stay untouched. The boundaries linter then classifies the legacy tier so every rule is machine-enforced.

**Tech Stack:** Node 22/24, TypeScript strict (two tsconfigs, per-tier `@/` aliases), `node:test` + `tsx --test`, eslint-plugin-boundaries, madge (via npx).

**Spec:** `docs/superpowers/specs/2026-08-03-phase6-structural-cleanup-design.md` (approved). Baseline branch point: `6533049` (phase-5 HEAD).

## Global Constraints

- No new dependencies; `package.json` deps unchanged.
- Conventional Commits, NO attribution footer; never use `--no-verify`.
- `eslint.config.js` edits ONLY at the two pre-authorized points (Task 3 = touch #1, Task 5 = touch #2); each diff quoted in the task report. The config-protection hook prompt will be approved by the user — if the hook denies, STOP and report BLOCKED (do not work around it).
- Every commit: `npm test` green (natural exit, no hang), `npm run typecheck` clean, `npm run lint` 0 errors and warnings NOT increased (baseline 247).
- Behavior-preserving throughout: wire payload bytes, status codes, error strings identical. Type-level edits only where the spec says so.
- Stacked branch: BASE for review packages = the task's recorded pre-dispatch HEAD; whole-branch review measures `6533049..HEAD`. Never diff against `origin/main` or local `main`.
- Run everything from the worktree root `/home/thaint/projects/claudecodeui/.claude/worktrees/refactor-phase6-structural-cleanup`.
- madge invocations: server = `npx madge --circular --extensions ts,js --ts-config server/tsconfig.json server/`; frontend = `npx madge --circular --extensions ts,tsx,js,jsx --ts-config tsconfig.json src/`.

---

### Task 1: Rule A — `list/` never imports `services/` (+ the frontend cycle)

**Files:**
- Modify: `server/modules/providers/list/claude/claude-sdk.js:32` (remove `providerAuthService` import)
- Modify: `server/modules/providers/list/codex/openai-codex.js:19` (+ its `provider-models.service` and `sessions.service` imports)
- Modify: `server/modules/providers/list/cursor/cursor-cli.js:6`
- Modify: `server/modules/providers/list/opencode/opencode-cli.js:8`
- Possibly create: small helper file(s) under `server/modules/providers/shared/` (only if a used function cannot be replaced by a sibling call — see Step 2)
- Modify: `server/modules/providers/services/provider-models.service.ts:145` (revert lazy capture to plain top-level import — ONLY after madge confirms the back-edges are gone)
- Modify: `src/components/chat/tools/ToolRenderer.tsx` (or the minimal frontend edge — see Step 5)
- Test: existing suites are the referee; no new test files required by this task

**Interfaces:**
- Consumes: nothing from other tasks (first task).
- Produces: the guarantee "no file under `server/modules/providers/list/**` imports from `server/modules/providers/services/**`" — later tasks (3, 5) rely on this staying true; and `provider-models.service.ts` back to a plain eager `import { providerRegistry }`.

- [ ] **Step 1: Record BASE and measure the starting point**

Run: `git rev-parse HEAD` (record), then the server madge command from Global Constraints.
Expected: 15 circular dependencies (verbatim list matches the spec's Problem section).

- [ ] **Step 2: For each of the 6 closing edges, read the usage and apply the narrowest fix**

For each CLI file, grep its usages (e.g. `grep -n "providerAuthService\|providerModelsService\|sessionsService" <file>`), read each call site, then apply in this preference order:

1. **Sibling substitution (expected for the 4 auth edges):** `providerAuthService.getStatus('<own-provider>')` inside provider `<p>`'s own CLI file is registry resolution of a compile-time-known constant — replace with a direct import of the sibling auth provider (e.g. in `claude-sdk.js`: import from `./claude-auth.provider.js` — check the sibling's actual export shape first; if it exports a class, instantiate once at module level exactly as the provider class does; if it exports an instance, use it directly). Behavior identical: the same underlying function ends up called.
2. **Extraction to intra-module shared:** if the CLI file uses a service function that is NOT just own-provider resolution, extract that function into `server/modules/providers/shared/<name>.ts` IF AND ONLY IF the function itself does not import the registry or any `services/` file (otherwise the cycle just moves). Do NOT hoist calls into the `<p>-runtime.provider.ts` adapters — adapters also live under `list/`.
3. **Flag BLOCKED** with the exact call site and what it needs — do not invent a new mechanism.

For `openai-codex.js`'s two extra imports: read what it calls on `provider-models.service` (likely the session model-override read) and `sessions.service`; apply the same preference order. Note: Task 3 will move the active-model persistence helpers into `modules/providers/shared/active-model-store.ts` — if codex's usage is exactly those helpers, you may import them from their CURRENT home `@/shared/utils.js` directly (that import is legal and cycle-free; Task 3 will re-point it).

- [ ] **Step 3: Verify Rule A holds and cycles dropped**

Run: `grep -rn "services/" server/modules/providers/list/ --include='*.js' --include='*.ts' | grep -v test` → zero import lines into `providers/services/`.
Run the server madge command.
Expected: exactly **5** cycles remain (the barrel-triangle set: spec cycles 7, 9, 10, 11, 13). If more remain, a closing edge was missed — re-grep.

- [ ] **Step 4: Revert the phase-4 lazy-capture workaround**

In `provider-models.service.ts`, restore a plain top-level `import { providerRegistry } from '@/modules/providers/provider.registry.js';` and use it directly at the former lazy-capture site (line ~145). This is safe ONLY now that no CLI file imports this service (the import chain registry→provider→adapter→CLI→this-service no longer exists).
Run: `npm run test:server` — natural exit, 0 fail (the phase-4 crash mode was module-eval-time; the suite loading the registry is the regression net).

- [ ] **Step 5: Break the frontend cycle**

Run the frontend madge command → confirm the single cycle `ToolRenderer.tsx > tools/components/index.ts > SubagentContainer.tsx > SubagentTranscriptPanel.tsx`. Read the three files; replace the SMALLEST barrel hop with direct-file imports (expected: `ToolRenderer.tsx`'s import from `./components` barrel → direct imports of the concrete component files it uses). Re-run madge → 0 cycles in src/.

- [ ] **Step 6: Full gates + commit**

Run: `npm test` (natural exit), `npm run typecheck`, `npm run lint`.
Commit: `refactor(providers): ban list->services imports and break the frontend tools cycle`

### Task 2: Rule B — events broadcast inversion

**Files:**
- Create: `server/modules/events/events.service.ts`
- Create: `server/modules/events/index.ts`
- Create: `server/modules/events/tests/events.service.test.ts`
- Modify: `server/modules/websocket/index.ts` (register the handler at startup)
- Modify: `server/modules/providers/services/session-lock-watcher.service.ts:23`, `server/modules/providers/services/sessions-watcher.service.ts:9`, `server/modules/projects/services/projects-with-sessions-fetch.service.ts:6`, `server/modules/providers/services/sessions.service.ts` (its websocket import)

**Interfaces:**
- Consumes: Task 1's madge baseline (5 cycles remaining).
- Produces: `broadcast(message: unknown): void` and `setBroadcastHandler(handler: (message: unknown) => void): void` exported from `@/modules/events/index.js` — Task 6's ADR references this seam.

- [ ] **Step 1: Write the failing test**

`server/modules/events/tests/events.service.test.ts`:
```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { broadcast, setBroadcastHandler, _resetForTest } from '@/modules/events/index.js';

test('broadcast before any handler is registered is a silent no-op', () => {
  _resetForTest();
  assert.doesNotThrow(() => broadcast({ kind: 'status' }));
});

test('broadcast after registration delivers the exact same object reference', () => {
  _resetForTest();
  const seen: unknown[] = [];
  setBroadcastHandler((m) => seen.push(m));
  const payload = { kind: 'session_upserted', data: { id: 's1' } };
  broadcast(payload);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], payload);
});

test('a later registration replaces the earlier handler', () => {
  _resetForTest();
  const first: unknown[] = [];
  const second: unknown[] = [];
  setBroadcastHandler((m) => first.push(m));
  setBroadcastHandler((m) => second.push(m));
  broadcast({ kind: 'status' });
  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
});
```

- [ ] **Step 2: Run it to verify it fails** (module not found), **then implement**

`server/modules/events/events.service.ts`:
```ts
/**
 * Leaf broadcast seam (imports nothing from other modules).
 *
 * Services publish app-level realtime payloads here; the websocket hub
 * registers the one real handler at startup. Before registration,
 * broadcast() is a silent no-op — identical to today's "zero connected
 * clients" behavior, never queued, never thrown.
 */
type BroadcastHandler = (message: unknown) => void;

let broadcastHandler: BroadcastHandler | null = null;

export function setBroadcastHandler(handler: BroadcastHandler): void {
  broadcastHandler = handler;
}

export function broadcast(message: unknown): void {
  if (!broadcastHandler) return;
  broadcastHandler(message);
}

/** Test-only: clears the registered handler. */
export function _resetForTest(): void {
  broadcastHandler = null;
}
```
`server/modules/events/index.ts`: `export { broadcast, setBroadcastHandler, _resetForTest } from './events.service.js';`
Run the test file → 3 pass.

- [ ] **Step 3: Register the handler in the websocket hub**

In `server/modules/websocket/index.ts`, at the point where the module's startup wiring runs (read the file; put it next to where `connectedClients` is owned), add `import { setBroadcastHandler } from '@/modules/events/index.js';` and register a handler whose body is EXACTLY the send-to-all-clients loop the four consumer services use today (read one consumer's loop first — expected shape: iterate `connectedClients`, check `readyState === WS_OPEN_STATE`, `client.send(JSON.stringify(message))`). Serialization stays inside the handler so the wire bytes are unchanged.

- [ ] **Step 4: Convert the four consumers**

In each of the four files, replace the `import ... from '@/modules/websocket/index.js'` + iteration block with `import { broadcast } from '@/modules/events/index.js';` + `broadcast(<the same payload object>)`. **Before converting each site, verify its loop is the plain all-clients broadcast.** If any site filters clients (per-user, per-session), STOP converting that site and report it in your report's Concerns — do not force it through the seam.

- [ ] **Step 5: Verify cycles + full gates + commit**

Run server madge → **0 cycles** (amended: Task 1's blanket Rule A cleanup already killed cycle 9 and the codex-hybrid variants; the 3 cycles remaining after Task 1 all die with this task's four conversions — verify the third listed cycle, which closes through `chat-websocket.service`, actually dies; if it survives, its closing edge is a websocket-internal import of the providers barrel — report it, do not chase it beyond the four planned conversions without flagging).
Run: `npm test`, `npm run typecheck`, `npm run lint`.
Commit: `refactor(events): invert realtime broadcast through a leaf events module`

### Task 3: Split `server/shared/utils.ts` by ownership and delete it

**Files:**
- Create: `server/shared/http.ts`, `server/shared/workspace-paths.ts`, `server/shared/messages.ts`, `server/shared/json.ts`
- Create: `server/modules/providers/shared/active-model-store.ts`, `server/modules/providers/shared/skill-files.ts`, `server/modules/providers/shared/session-scan.ts`, `server/modules/providers/shared/windows-shell.ts`, `server/modules/providers/list/opencode/opencode-paths.ts`
- Modify: ~48 importer files (mechanical re-point), `server/modules/projects/*` (generateDisplayName move + barrel re-export), `server/modules/providers/index.ts` (barrel re-exports for externally-consumed relocated helpers)
- Modify: `eslint.config.js` (**pre-authorized touch #1**)
- Delete: `server/shared/utils.ts`

**Interfaces:**
- Consumes: Task 1's Rule A guarantee (relocations into `providers/shared/` must not recreate `list/`→`services/` edges — they cannot, since `providers/shared/` is not `services/`).
- Produces: the export→home mapping in the two tables of the spec's Sub-goal B (exact same function names and signatures — bodies move verbatim); `generateDisplayName` exported from `server/shared/workspace-paths.ts` AND re-exported from the projects barrel.

- [ ] **Step 1: Move the 4 shared-leaf groups (bodies verbatim), commit 1**

Create `http.ts`, `workspace-paths.ts`, `messages.ts`, `json.ts` per the spec's first table — cut the export blocks (including their JSDoc and any module-private helpers ONLY they use) out of `utils.ts` verbatim; `utils.ts` temporarily re-exports the moved names (`export { AppError, asyncHandler, createApiSuccessResponse } from './http.js';` etc.) so all importers still compile. `FORBIDDEN_WORKSPACE_PATHS` becomes a non-exported `const` inside `workspace-paths.ts`. Also move `generateDisplayName` from `modules/projects` into `workspace-paths.ts` now (Relocation C): its old home file re-exports it, the projects barrel keeps exporting it, and `sessions-watcher.service.ts:11` re-points to `@/shared/workspace-paths.js`.

In the same commit, apply **eslint touch #1** (quote this diff in your report; the hook prompt will be user-approved). In `boundaries/elements`, replace the `backend-shared-utils` pattern array and add the cross-tier element:
```js
{
  type: "backend-shared-utils",
  pattern: [
    "server/shared/utils.{js,ts}",        // removed again in Step 3 when the file dies
    "server/shared/http.{js,ts}",
    "server/shared/workspace-paths.{js,ts}",
    "server/shared/messages.{js,ts}",
    "server/shared/json.{js,ts}",
    "server/shared/frontmatter.ts",
    "server/shared/claude-cli-path.ts",
    "server/shared/image-attachments.ts",
  ],
  mode: "file",
},
{
  type: "cross-tier-shared",              // repo-root shared/ — importable by every backend element
  pattern: ["shared/**/*.{js,ts}"],
  mode: "file",
},
```
(Adjust to the file's ACTUAL current content — read it first; keep existing elements' order, append `cross-tier-shared` after the shared-utils entry. `boundaries/include` stays `server/**` — the root-shared element classifies these files as import TARGETS only.)
Run madge (server) → **0 cycles** (stays 0 — cycle 9 already died in Task 1; Relocation C remains as ownership cleanup, not a cycle fix). Gates green. Commit: `refactor(shared): split utils.ts leaf domains into http/workspace-paths/messages/json`

- [ ] **Step 2: Relocate the provider-domain slices, commit 2**

Per the spec's second table: create the five provider-module files, move bodies verbatim, make `getProviderSessionActiveModelChangesPath` non-exported inside `active-model-store.ts`. Home `sanitizeLeafDirectoryName` beside its consumers: first `grep -rn "sanitizeLeafDirectoryName" server/ --include='*.ts' --include='*.js' | grep -v utils.ts` — put it with the domain its consumers belong to (report where it went and why). For every relocated export with a consumer OUTSIDE `modules/providers/` (measured: `server/index.js:18` uses `getOpenCodeDatabasePath`), add a providers-barrel re-export and re-point that consumer to the barrel. `utils.ts` keeps temporary re-exports. Gates green. Commit: `refactor(providers): home provider-domain helpers inside the providers module`

- [ ] **Step 3: Re-point all importers, delete utils.ts, commit 3**

`grep -rln "shared/utils" server/` → re-point every import to the new homes (the temporary re-exports tell you the mapping — each name has exactly one new home). Delete `server/shared/utils.ts`; remove its line from the eslint pattern added in Step 1. Verify: `grep -rn "shared/utils" server/ src/` → 0 hits in code (CLAUDE.md mentions are Task 6's job, leave them). Run all gates + madge (server 0, src 0). CodeScene on the 9 new files → all ≥ 7.0, no function cc > 30 (report scores). Commit: `refactor(shared): delete utils.ts — every export now lives with its owner`

### Task 4: Wire types to one source + exhaustive realtime switch

**Files:**
- Create: `shared/wire-types.ts` (repo ROOT — sibling of `shared/networkHosts.js`)
- Modify: `server/shared/types.ts` (delete local defs, re-export), `src/stores/useSessionStore.ts` (same), `src/contexts/WebSocketContext.tsx` (ClientEventKind), `src/components/chat/hooks/useChatRealtimeHandlers.ts` (exhaustive switches)
- Test: mutation checks via typecheck (Step 4); client suite is the behavior referee

**Interfaces:**
- Consumes: Task 3's `cross-tier-shared` eslint element (already landed).
- Produces: `shared/wire-types.ts` exporting `MessageKind`, `GatewayEventKind`, `ServerEventKind`, `NormalizedMessage`, `assertNever`, `isGatewayEventKind` — Task 6 documents it.

- [ ] **Step 1: Create `shared/wire-types.ts`**

Copy the CURRENT server definitions as the base (`server/shared/types.ts` ~L180: `MessageKind`, the `NormalizedMessage` interface, and the gateway union right after it), then apply exactly these reconciliations (from the measured delta — verify each against both current files as you go):
- `GatewayEventKind` gains `'session_lock_state_changed'`.
- Add `export type ServerEventKind = MessageKind | GatewayEventKind;`
- `NormalizedMessage` gains explicit optionals the client had (or the server set via its index signature): `exitCode?: number; actualSessionId?: string; isFinal?: boolean; aborted?: boolean;` and keeps server-only `reason?: string;`, top-level `toolUseResult?: unknown;`, and the `[key: string]: unknown` index signature.
- `toolResult?: { content?: string; isError?: boolean; toolUseResult?: unknown } | null;`
- `images?: Array<{ path?: string; data?: string; name?: string }>;`
- Runtime helpers at the bottom (this file is imported at runtime, like `networkHosts.js`):
```ts
const GATEWAY_EVENT_KINDS = [
  'chat_subscribed', 'session_upserted', 'branch_created',
  'loading_progress', 'protocol_error', 'session_lock_state_changed',
] as const;

export type GatewayEventKind = (typeof GATEWAY_EVENT_KINDS)[number];

export function isGatewayEventKind(kind: string): kind is GatewayEventKind {
  return (GATEWAY_EVENT_KINDS as readonly string[]).includes(kind);
}

export function assertNever(x: never): never {
  throw new Error(`Unhandled kind: ${String(x)}`);
}
```

- [ ] **Step 2: Facades**

`server/shared/types.ts`: delete the local `MessageKind`/gateway-union/`NormalizedMessage` blocks; add `export type { MessageKind, GatewayEventKind, ServerEventKind, NormalizedMessage } from '../../shared/wire-types.js';` (relative — the `@/` alias must NOT be used, it points at `server/shared/`). Keep every other export in place.
`src/stores/useSessionStore.ts`: delete its local `MessageKind` + `NormalizedMessage`; `export type { MessageKind, NormalizedMessage } from '../../shared/wire-types.js';`. Fix any type errors the reconciled shape surfaces at client sites minimally (optional-chaining/`??` defaults/type guards only — behavior identical, suites green).
Run `npm run typecheck` after each facade.

- [ ] **Step 3: Type the event stream + exhaustive switches**

`WebSocketContext.tsx`: `import type { ServerEventKind } from '../../shared/wire-types.js';` then `export type ClientEventKind = ServerEventKind | 'websocket_reconnected';` and re-type `ServerEvent.kind` from `string` to `ClientEventKind`.
`useChatRealtimeHandlers.ts`: restructure switch 1 into a guarded exhaustive block — `if (isGatewayEventKind(msg.kind) || msg.kind === 'websocket_reconnected')` containing a switch over `GatewayEventKind | 'websocket_reconnected'` with every existing case body UNCHANGED (preserve the `session_upserted`→`loading_progress` fallthrough exactly) and `default: assertNever(...)`; the code after the guard keeps running for NormalizedMessage kinds exactly as today (gateway kinds must `return` after their switch, as the current cases already do — verify each). Switch 2 lists ALL 14 `MessageKind` members explicitly — the kinds that currently fall to its intentional no-op default become grouped `case` labels with a one-line comment ("already routed via merge; no UI side effect") and `break`; `default:` becomes `assertNever`. Do NOT change any case body.

- [ ] **Step 4: Mutation check (compile-time exhaustiveness proves itself)**

Add `| 'zzz_probe'` to `MessageKind` in wire-types.ts → `npm run typecheck` must FAIL pointing at the switch. Revert. Record the error line in your report. Repeat once for `GATEWAY_EVENT_KINDS` (add a probe literal to the array).

- [ ] **Step 5: Single-source check + gates + commit**

`grep -rnE "type MessageKind|MessageKind =" --include='*.ts' --include='*.tsx' server/ src/ shared/` → exactly ONE definition (wire-types.ts). Full gates (`npm test` both tiers, typecheck, lint). Commit: `refactor(wire): single-source MessageKind/NormalizedMessage and make the realtime switch exhaustive`

### Task 5: Boundaries lint over the legacy tier

**Files:**
- Modify: `server/modules/providers/index.ts`, `server/modules/projects/index.ts`, `server/modules/notifications/index.ts` (barrel additions)
- Create: `server/modules/browser-use/index.ts`
- Modify: `server/routes/agent.js:13`, `server/routes/commands.js:6,13`, `server/routes/cursor.js:5`, `server/routes/auth.js:4`, `server/index.js:45,47,50,52,54,55` (re-point to barrels)
- Modify: `eslint.config.js` (**pre-authorized touch #2**)

**Interfaces:**
- Consumes: Task 3's barrel state (providers barrel already gained relocation re-exports) and Task 3's `cross-tier-shared` element.
- Produces: lint-enforced barrel discipline for the whole backend; the mutation-check evidence Task 6's ADR cites.

- [ ] **Step 1: Barrel exports + re-point the 11 imports**

Additions (names must match what each `.routes` file exports — read them first; routers are `export default router`):
- `providers/index.ts`: `export { providerModelsService } from './services/provider-models.service.js';`, `export { getClaudeBuiltinCommandEntries } from './list/claude/claude-builtin-commands.js';`, `export { CURSOR_FALLBACK_MODELS } from './list/cursor/cursor-models.provider.js';`, `export { default as providerRoutes } from './provider.routes.js';`
- `projects/index.ts`: `export { default as projectsRoutes } from './projects.routes.js';`
- `notifications/index.ts`: `export { default as notificationRoutes } from './notifications.routes.js';`
- NEW `browser-use/index.ts`: `export { default as browserUseRoutes } from './browser-use.routes.js'; export { default as browserUseMcpRoutes } from './browser-use-mcp.routes.js'; export { browserUseService } from './browser-use.service.js';`
- `routes/auth.js:4` → `import { getConnection } from '../modules/database/index.js';`
Re-point the 11 measured import sites accordingly (`server/index.js` mount lines keep the same local variable names so the mount code below them is untouched). Gates green after this step alone.

- [ ] **Step 2: eslint touch #2 — classify the legacy tier**

Read the current `boundaries/elements` array, then APPEND (after all existing entries, so specific patterns like `backend-legacy-runtime` keep winning first-match):
```js
{
  type: "backend-legacy",
  pattern: [
    "server/routes/**/*.{js,ts}",
    "server/middleware/**/*.{js,ts}",
    "server/services/**/*.{js,ts}",
    "server/utils/**/*.{js,ts}",
    "server/constants/**/*.{js,ts}",
    "server/tests/**/*.{js,ts}",
    "server/*.{js,ts}",
  ],
  mode: "file",
},
```
No new `boundaries/dependencies` rule should be needed: the existing `{ to: { type: "backend-module" }, disallow: { to: { internalPath: "**" } } }` rule has no `from` filter, so newly-classified legacy sources inherit the barrel-only restriction automatically — VERIFY this reading against the actual config before assuming; if the rule is scoped otherwise, mirror the module rule pair for `from: backend-legacy`. Quote the final diff in your report.

- [ ] **Step 3: Lint the world + fix stragglers**

`npm run lint` — any NEW `boundaries/no-unknown` error means a legacy file imports something still unclassified (candidates: stray files at odd paths). Resolve by extending the `backend-legacy` pattern minimally (same edit session — still touch #2) or re-pointing the import to an existing classified home. 0 errors required; warnings ≤ 247.

- [ ] **Step 4: Mutation check**

In `routes/agent.js`, temporarily re-add `import { providerModelsService } from '../modules/providers/services/provider-models.service.js';` → `npx eslint server/routes/agent.js` must report a boundaries ERROR (record it verbatim). Revert. Then `git status --porcelain` to confirm clean revert.

- [ ] **Step 5: Full gates + commit**

`npm test`, typecheck, lint, madge (server 0, src 0). Commit: `refactor(lint): extend boundaries enforcement to the legacy tier via barrel-only imports`

### Task 6: ADR-0005 + CLAUDE.md true-up

**Files:**
- Create: `docs/adr/ADR-0005-structural-cleanup.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: final measured numbers from Tasks 1–5 reports (madge 0/0, mutation-check evidence, CodeScene scores).
- Produces: the phase's documentary record; PR body source material.

- [ ] **Step 1: ADR-0005** (Nygard format, exactly these sections)

Title `# ADR-0005: Structural cleanup — cycle dissolution, utils split, wire-type single source, full-tier boundaries`; **Date** 2026-08-03; **Status** accepted; **Deciders** thaint2901 + Claude phase-6 session. **Context**: the measured problem block from the spec (15+1 cycles with the three roots, utils.ts 1,286 LOC/36 exports/fan-in 48, wire-type drift incl. the undeclared `session_lock_state_changed`, 11 legacy deep imports). **Decision**: Rule A + Rule B (events seam) + Relocation C; ownership split with NO shim and deletion; root `shared/wire-types.ts` with facades + exhaustive switches; `backend-legacy` element. **Alternatives Considered** (each with pros/cons/why-not): lazy-capture everywhere (defuses, doesn't dissolve — graph still cyclic, hazard documentation lives forever); utils.ts re-export shim (zero churn but the god module survives on paper and in lint config); codegen server→client for wire types (machinery for a problem the root shared/ dir already solves — both tsconfigs include it today); leaving routes/ unclassified (the measured 11-deep-import gap persists and regrows). **Consequences**: positive — cycles 15+1→0, ADR-0003's eager-capture hazard retired (lazy workaround reverted in Task 1), kind-exhaustiveness is now a compile error, scorecard lines closed (cite final numbers from task reports); negative — `_resetForTest` export on the events seam (test-only), legacy tier now lint-bound (future route edits must use barrels — friction by design); record both pre-authorized eslint diffs.

- [ ] **Step 2: CLAUDE.md** (surgical, do NOT touch the `## Fork Maintenance` section — PR #12 conflict avoidance)

- Repoint every `shared/utils.ts` mention to the new homes (grep `utils` in CLAUDE.md; the Key Conventions boundaries bullet lists allowed runtime shared imports — replace `server/shared/utils.ts` with the four new leaf files).
- Modules list in the layout block: add `events/` (one line: leaf broadcast seam between services and the websocket hub) and note browser-use now has a barrel.
- Boundaries bullet: replace the "Enforcement covers ONLY `server/modules/*`…" caveat (verified 2026-07-31) with: enforcement now covers the legacy tier too (`backend-legacy` element added 2026-08-03); a deep import from `routes/` into module internals fails lint.
- Add a Key Conventions line: `shared/wire-types.ts` (repo root) is the single source for `MessageKind`/`NormalizedMessage`/gateway kinds; both tiers re-export from it; the realtime switch is exhaustive — adding a kind without a case is a compile error. Update the old gotcha bullet about unhandled kinds corrupting the session store: the exhaustive switch turned this into a compile error (keep one clause of historical context).

- [ ] **Step 3: Gates + commit**

`npm run typecheck && npm run lint` (docs-only, but cheap). Commit: `docs(adr): record the structural cleanup decisions and true up CLAUDE.md`

---

## After all tasks (controller-run)

1. Whole-branch review (most capable model) over `6533049..HEAD` with the ledger's deferred minors.
2. ONE fix wave if findings; scoped re-review.
3. Final gates: `npm test` natural exit both tiers; typecheck; lint 0 errors/≤247 warnings; madge server 0 + src showing ONLY the accepted recursive triad (ToolRenderer↔SubagentContainer↔SubagentTranscriptPanel — ADR-0005 exception); CodeScene ≥7.0 on every new/heavily-edited file.
4. Smoke on worktree instance (`SERVER_PORT=3002 VITE_PORT=5174 npm run dev`; kill child pids individually afterwards; never touch the systemd 5173 instance): chat send + streamed reply; abort mid-stream; **sidebar realtime update on session create** (end-to-end proof of the events inversion); Files tab loads (phase-5 canary).
5. Push, draft PR #15 (base = `worktree-refactor-phase5-files-module`), body via `--body-file`, ends with the standard generated-with line; verify gh account `thaint2901` first.
6. Memory + scorecard final numbers; delete SDD workspace.
