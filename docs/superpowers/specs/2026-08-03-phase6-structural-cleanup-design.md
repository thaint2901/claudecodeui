# Phase 6: Structural cleanup — cycles, utils split, wire types, boundaries gate — design

**Date**: 2026-08-03
**Status**: approved (design approved in-session)
**Branch strategy**: `worktree-refactor-phase6-structural-cleanup` is **stacked on the phase-5 branch** at `6533049` (user decision). All diffs and review packages measure against `6533049`, never `origin/main`. Final PR (#15) targets the phase-5 branch. Merge order remains #13 → #14 → #15.
**User decisions binding this phase**: (1) stack on phase 5; (2) editing `eslint.config.js` is PERMITTED this phase — the config-protection hook prompt will be approved by the user; present each config diff explicitly before applying; (3) all 4 sub-goals ship as ONE PR.

## Problem (measured 2026-08-03 at `6533049`)

1. **15 module dependency cycles** (madge, server tier): 6 close via `list/<provider>/` CLI files importing `services/` (providerAuthService ×4 at `claude-sdk.js:32`, `openai-codex.js:19`, `cursor-cli.js:6`, `opencode-cli.js:8`; plus `openai-codex.js` → provider-models + sessions.service), 5 form the websocket↔projects↔providers barrel triangle (services importing `websocket/index.js` for `connectedClients`/`WS_OPEN_STATE` broadcast, plus `sessions-watcher.service.ts:11` → projects barrel for `generateDisplayName`), 4 are hybrids that die when the first two roots die. All three service families (`provider-models`, `provider-auth`, `sessions`) carry ADR-0003's eager-registry-capture crash hazard. 1 frontend cycle: `ToolRenderer.tsx → tools/components/index.ts → SubagentContainer.tsx → SubagentTranscriptPanel.tsx → ToolRenderer`.
2. **`server/shared/utils.ts` god module**: 1,286 LOC, 36 exports, fan-in 48 files. Two dead exports measured: `getProviderSessionActiveModelChangesPath` (0 external importers), `FORBIDDEN_WORKSPACE_PATHS` (0 real importers — only a comment-string match in a test).
3. **Wire types duplicated and incomplete**: `MessageKind`/`NormalizedMessage` hand-duplicated in `server/shared/types.ts` (~L180) and `src/stores/useSessionStore.ts` (L17). MessageKind is currently identical (14 members) but NormalizedMessage has field-level drift (server-only `reason`/`toolUseResult`/index signature; client-only explicit `exitCode`/`actualSessionId`/`isFinal`; `toolResult` optionality + null-union mismatch; `images` looseness mismatch). The server emits `session_lock_state_changed` (`session-lock-watcher.service.ts:121`) which appears in NO server union. The client's `ServerEvent.kind` is a bare `string` — no exhaustiveness possible today. Client also synthesizes `websocket_reconnected` (client-only, never on wire).
4. **Boundaries lint covers only `server/modules/*`**: `routes/` + root `server/*.js|ts` are unclassified; 11 deep imports bypass barrels (measured list in Sub-goal D). `browser-use` is the only module with no `index.ts` barrel at all.

## Sub-goal A — dissolve cycles (15 → 0 server, 1 → 0 frontend)

Strategy: two structural rules + one relocation, NOT 15 individual patches.

**Rule A — `server/modules/providers/list/**` never imports `server/modules/providers/services/**`.** Remove the 6 closing edges. Per edge, the implementer chooses the minimal behavior-preserving mechanic: move the needed function into the provider's own folder (`list/<p>/` or `modules/providers/shared/`), or inject the dependency from the TS runtime adapter at call time. What each CLI file actually uses from each service must be read before choosing. This kills cycles 1–6, 8, 12, 14, 15 (10 of 15) and permanently retires the eager-capture hazard: after Rule A, the phase-4 lazy-capture workaround in `provider-models.service.ts:145` can revert to a plain top-level import (the registry edge is then one-directional).

**Rule B — broadcast inversion via a new leaf module `server/modules/events/`.** A tiny module (barrel `index.ts` + `events.service.ts`, ~50 LOC, imports NOTHING from other modules): `setBroadcastHandler(fn)` + `broadcast(message)` (raw-object in, the handler owns serialization exactly as `websocket/index.ts` does today; payloads on the wire stay byte-identical). `websocket/index.ts` registers the handler at startup; the four services that today import the websocket barrel only to iterate `connectedClients` (`session-lock-watcher.service.ts:23`, `sessions-watcher.service.ts:9`, `projects-with-sessions-fetch.service.ts:6`, `sessions.service.ts`) switch to `broadcast()` from the events barrel. Kills cycles 7, 10, 11, 13. Before-startup sends (handler not yet registered) must behave as today's zero-connected-clients case: silently dropped, never queued, never thrown.

**Relocation C — `generateDisplayName`** moves out of `modules/projects` into `server/shared/workspace-paths.ts`. Because that file (and its eslint classification) is created by Sub-goal B, **Relocation C executes inside Sub-goal B's task**, not A's. `modules/projects` keeps re-exporting it from its barrel (external consumers unchanged); `sessions-watcher.service.ts:11` imports the shared home directly. Kills cycle 9.

**Frontend cycle**: break with a direct-file import replacing whichever barrel hop re-enters the cluster (minimal edit, implementer picks the exact edge after reading the three files). **Amendment (2026-08-03, post-Task-1)**: removing the barrel hop revealed that the triad `ToolRenderer → SubagentContainer → SubagentTranscriptPanel → ToolRenderer` is a direct, intentional recursive-render composition (the transcript drawer renders nested tool calls with ToolRenderer itself), not a barrel artifact. Controller ruling: ACCEPTED as a documented exception — forcing 0 via React.lazy/render-prop adds complexity and behavior risk for no architectural gain. ADR-0005 records it.

**Gate A (amended to measured reality)**: Task 1's blanket Rule A cleanup (all 12 `list/`→`services/` import lines, not just the 6 madge-visible closing edges) killed 12 of 15 server cycles including cycle 9 — `npx madge --circular ... server/` → 3 remaining (all in the websocket/projects triangle, Rule B's targets); `src/` → the accepted recursive triad only. Suites green.

## Sub-goal B — split `server/shared/utils.ts` by ownership, then delete it

**New shared leaf files** (`server/shared/`), grouped by the measured domains:

| New file | Exports (from utils.ts) |
|---|---|
| `http.ts` | `AppError`, `asyncHandler`, `createApiSuccessResponse` |
| `workspace-paths.ts` | `WORKSPACES_ROOT`, `normalizeProjectPath`, `validateWorkspacePath` (+ `FORBIDDEN_WORKSPACE_PATHS` becomes a non-exported internal const) (+ `generateDisplayName` arriving via Relocation C) |
| `messages.ts` | `generateMessageId`, `createNormalizedMessage`, `createCompleteMessage`, `sliceTailPage` |
| `json.ts` | `readObjectRecord`, `readOptionalString`, `readStringArray`, `readStringRecord`, `parseIncomingJsonObject`, `readJsonConfig`, `writeJsonConfig`, `readJsonRecord` |

**Provider-domain slices move INTO `server/modules/providers/`** (they were never truly shared):

| New home (inside providers module) | Exports |
|---|---|
| `shared/active-model-store.ts` | `buildDefaultProviderCurrentActiveModel`, `readProviderSessionActiveModelChange`, `writeProviderSessionActiveModelChange`; `getProviderSessionActiveModelChangesPath` becomes non-exported internal |
| `shared/skill-files.ts` | `findTopmostGitRoot`, `addUniqueProviderSkillSource`, `findProviderSkillMarkdownFiles`, `readProviderSkillMarkdownDefinition`, `readProviderSkillMarkdownDefinitionFromContent` |
| `shared/session-scan.ts` | `normalizeSessionName`, `normalizeProviderTimestamp`, `findFilesRecursivelyCreatedAfter`, `readFileTimestamps`, `buildLookupMap`, `extractFirstValidJsonlData` |
| `shared/windows-shell.ts` | `flattenPromptForWindowsShell` (cursor + opencode) |
| `list/opencode/opencode-paths.ts` | `getOpenCodeDatabasePath`, `unwrapJsonStringLiteral` |
| (with its consumers — implementer verifies who imports it and homes it beside them) | `sanitizeLeafDirectoryName` |

Rules for the move: any relocated export with consumers OUTSIDE the providers module (measured example: `server/index.js:18` imports `getOpenCodeDatabasePath`) gets a providers-barrel re-export so external call sites import legally. Relocations must not violate Rule A (`list/**` may import `modules/providers/shared/**` — intra-module, legal).

All ~48 importer files update to the new homes. **`utils.ts` is then DELETED** — no re-export shim (independent development, ADR-0002; no merge-conflict rationale remains).

**`eslint.config.js` touch #1 (pre-authorized)**: the `backend-shared-utils` file pattern must be updated in the SAME commit as the split (new shared files are otherwise unclassified → `boundaries/no-unknown` fires on every module file importing them). Diff presented before applying.

**Gate B**: `utils.ts` gone; madge server → **0 cycles** (Relocation C landed here); no new file > 400 LOC; suites + typecheck + lint green; CodeScene ≥ 7.0 per new file.

## Sub-goal C — wire types to one source + exhaustive realtime switch

**New file `shared/wire-types.ts` at repo ROOT** (the true cross-tier directory — measured: both tsconfigs already `include` root `shared/`, zero config needed for typecheck; server build emits it into `dist-server/shared/`). Contents:

- `MessageKind` (14 members, unchanged).
- `GatewayEventKind` — the existing 5 members **+ `session_lock_state_changed`** (the server already emits it; the union was lying).
- `ServerEventKind = MessageKind | GatewayEventKind`.
- `NormalizedMessage` — single reconciled shape: union of both sides' knowledge. Server-only fields kept (`reason?`, top-level `toolUseResult?`); client-only fields promoted to explicit optionals (`exitCode?: number`, `actualSessionId?: string`, `isFinal?: boolean`, plus `aborted?: boolean` which `createCompleteMessage` sets but neither side declared); `toolResult?: { content?: string; isError?: boolean; toolUseResult?: unknown } | null` (optionality relaxed to the server's reality, null union kept for the client); `images?` typed to the client's narrow array shape; the server's `[key: string]: unknown` index signature KEPT (server writes extras today — removing it is out of scope behavior/type risk).
- Runtime helpers (this file is imported at runtime, like `networkHosts.js`): `assertNever(x: never): never` and `isGatewayEventKind(kind): kind is GatewayEventKind`.

**Facades — churn contained to 2 files + 1 context**:
- `server/shared/types.ts` re-exports `MessageKind`/`GatewayEventKind`/`ServerEventKind`/`NormalizedMessage` from `../../shared/wire-types.js`; its 50+ importers unchanged.
- `src/stores/useSessionStore.ts` deletes its local copies and re-exports from `../../shared/wire-types.js`; its type importers unchanged. Client-side type errors surfaced by the reconciled shape are fixed minimally at the erroring sites (type guards/defaults only — no behavior change; suites are the referee).
- `src/contexts/WebSocketContext.tsx`: `ClientEventKind = ServerEventKind | 'websocket_reconnected'` (the one client-synthesized kind); `ServerEvent.kind` re-typed from `string` to `ClientEventKind`.

**Exhaustive switch**: restructure `useChatRealtimeHandlers.ts` — gateway branch becomes `if (isGatewayEventKind(msg.kind) || msg.kind === 'websocket_reconnected')` guarding a switch that is EXHAUSTIVE over those kinds with `assertNever` in default; the NormalizedMessage path's switch (currently intentional no-op default over 6 kinds) becomes explicit cases for ALL 14 MessageKind members (no-op cases listed, commented) + `assertNever` default. **From then on, adding a kind without handling it is a compile error** — this deletes the documented "unhandled kind corrupts the session store" bug class.

**`eslint.config.js`**: the `cross-tier-shared` element for root `shared/**` (mode file, importable by all backend elements) lands as part of **touch #1 in Sub-goal B** — the pattern matching nothing until this file exists is harmless, and it spares a third edit to the protected file. `server/shared/types.ts` importing it then never trips `boundaries/no-unknown`.

**Gate C**: exactly ONE definition of `MessageKind`/`NormalizedMessage` repo-wide (grep); typecheck both tiers; client suite green; mutation check — add a dummy kind to the union, `npm run typecheck` must FAIL at the switch, revert.

## Sub-goal D — boundaries lint covers the legacy tier (the lock-in gate, LAST)

**Fix the 11 measured deep imports** (source:line → resolution):
1. `routes/agent.js:13` + 3. `routes/commands.js:6` (`providerModelsService`) → add to providers barrel.
2. `routes/auth.js:4` (`getConnection`) → switch to existing database barrel export.
4. `routes/commands.js:13` (`getClaudeBuiltinCommandEntries`) → add to providers barrel.
5. `routes/cursor.js:5` (`CURSOR_FALLBACK_MODELS`) → add to providers barrel.
6. `index.js:45` (projects router) → export from projects barrel.
7. `index.js:47` (notifications router) → export from notifications barrel.
8. `index.js:50` (provider routes) → export from providers barrel.
9–11. `index.js:52,54,55` (browser-use routes/mcp-routes/service) → **create `server/modules/browser-use/index.ts`** (the only barrel-less module) exporting all three.

**`eslint.config.js` touch #2 (pre-authorized, single diff presented before applying)**: add element `backend-legacy` covering `server/routes/**`, root `server/*.{js,ts}`, `server/middleware/**`, `server/services/**`, `server/utils/**`, `server/constants/**`, `server/tests/**` (classifying routes/ as a source forces classifying everything routes/ imports, or `boundaries/no-unknown` fires on those edges). Rules: `backend-legacy` → `backend-module` ONLY via barrel (same `internalPath: index` allow-list as modules use); `backend-legacy` → `backend-legacy`/shared elements: allow. Keep `default: "allow"` semantics otherwise unchanged.

**Gate D**: `npm run lint` 0 errors; **mutation check** — temporarily re-add a deep import in `routes/agent.js`, lint must go RED, revert with evidence in the task report.

## Execution order & docs

Tasks run **A → B → C → D** (D last locks in A–C's structure). `eslint.config.js` is edited at B (shared patterns + cross-tier element) and D (legacy element) — both pre-authorized; each diff shown in the implementer's report.

- **ADR-0005 — structural cleanup**: records the two cycle rules + events inversion, the utils dissolution (no shim), wire-type single-sourcing at root `shared/`, and full-tier boundaries coverage; notes ADR-0003's cycle-count consequence (15) is now resolved and the lazy-capture workaround retired.
- **CLAUDE.md**: repoint every `shared/utils.ts` reference to the new homes; add `events/` and the `browser-use` barrel to the modules list; boundaries claim updated (enforcement now covers the legacy tier — the 2026-07-31 caveat paragraph retires); wire-types pointer (`shared/wire-types.ts` is the single source); do NOT touch the `## Fork Maintenance` section (PR #12 conflict avoidance — same rule as phases 4–5).
- Memory update + scorecard final numbers at finish.

## Acceptance gates (whole phase)

- `npm test` both tiers green, natural exit; `npm run typecheck` clean; `npm run lint` 0 errors, warnings not increased (baseline 247).
- madge circular: server 0; src: 0 barrel-mediated — the recursive-render triad (ToolRenderer↔SubagentContainer↔SubagentTranscriptPanel) is an accepted, ADR-0005-documented exception.
- CodeScene ≥ 7.0 for every new/heavily-edited file; no function cc > 30.
- Wire payloads byte-identical (broadcast path refactor is transport-internal; smoke verifies).
- Smoke on worktree instance (SERVER_PORT=3002 VITE_PORT=5174): chat send + streamed reply; abort mid-stream; sidebar realtime update on session create (exercises the events inversion end-to-end); Files tab loads (regression canary for stacked phase 5).
- Draft PR #15, base = phase-5 branch.

## Out of scope

- `routes/` full migration into modules; token-usage/system-update extraction from `index.js`.
- TS conversion of the 4 moved CLI `.js` files (recorded follow-up from phase 4).
- Frontend giant hooks (`useChatSessionState`, `useProjectsState`, `useSidebarController`); the 44-key composer contract.
- Any wire-payload behavior change; any new dependency.

## Global constraints (bind every task)

- No new dependencies; `package.json` deps unchanged.
- Conventional Commits, NO attribution footer; never use `--no-verify`; `eslint.config.js` edits ONLY at the two pre-authorized points with diffs in the report.
- Every commit: suites green, typecheck clean, lint 0 errors.
- Stacked branch: BASE for review packages = task's recorded pre-dispatch HEAD; whole-branch review measures `6533049..HEAD`.
