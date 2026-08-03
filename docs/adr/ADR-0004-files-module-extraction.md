# ADR-0004: Files module extraction with in-phase TS conversion

**Date:** 2026-08-03
**Status:** accepted
**Deciders:** thaint2901 + Claude phase-5 session

## Context

`server/index.js` was two things at once: the app's bootstrap (env, DB, sessions watcher, single ws server, route mounting) and, inline, the entire file API — 10 route handlers (browse-filesystem, project file-tree, file read/save/rename/delete, directory create, upload, etc.) plus their helper cluster (`expandWorkspacePath`, `validatePathInProject`, `validateFilename`, `getFileTree`, the FS-concurrency semaphore, upload-size constants). That block accounted for ~900 LOC with 0% test coverage, and being unclassified in `boundaries/elements` meant it sat outside the module-boundary lint entirely (same blind spot ADR-0003 documented for `server/routes/`).

Measured base: `server/index.js` was **1,657 LOC** at `b9c7467`. Stage A (pure-move extraction, commit `cd7350c`) brought it to **766 LOC** — the phase-5 plan's own estimate was ≈750; the 16-line difference was blank-line bookkeeping around the moved spans, not missed content (verified by grepping every moved identifier post-move — zero hits left in `index.js`).

## Decision

Extract the file API into `server/modules/files/` (`index.ts`, `files.routes.ts`, `files.service.ts`, `tests/`), exposing a single `createFilesRouter(authenticateToken)` factory. `authenticateToken` is injected as a parameter and applied per-route inside the router, not captured by the module — the same DI-keeps-middleware-out-of-the-module lesson phase 4 established for `IProviderRuntime` construction, applied here to avoid the module importing `server/middleware/auth.js` directly.

The work ran as three gated stages:

- **Stage A** (`cd7350c`) — pure mechanical move to `.js`: 10 routes + helpers relocated verbatim, `/api` prefix stripped, `app.` → `router.`, zero behavior change (module-load probe + full `npm test` green before/after).
- **Stage B** (`eb0a3bc`, fix `9b87ab5`) — 19 endpoint tests added against the moved `.js`, establishing the first-ever coverage on this code: `files.routes` 74.72% line, `files.service` 79.95% line.
- **Stage C** (`37ab854`) — converted all three files to TypeScript, with **zero `@ts-expect-error`** anywhere in the module.

TS conversion was done **in-phase** (user decision, 2026-08-03), rather than deferred to a later phase the way ADR-0003 deferred it for the provider CLI/SDK files. This is safe here specifically because Stage B built the behavior-net *first*: ADR-0003's alternative (c) rejected same-task move+convert for the provider files because they carried 0–35.8% pre-existing coverage and a rewrite-and-retype would have compounded move risk with behavior risk on uncovered code. The files module has the opposite risk profile going into Stage C — the endpoint tests from Stage B exist precisely to catch a semantic slip during the type conversion, closing the gap ADR-0003 said was missing.

## Alternatives Considered

**(a) Extract as `.js` and defer TS conversion, matching the phase-4 pattern.**
Pros: smaller per-task diff; defers type-conversion risk to a dedicated phase, exactly as ADR-0003 did for the 4 provider CLI/SDK files.
Cons: leaves `modules/files` as another "`.js`-in-a-TS-module" intermediate state phase 4 explicitly flagged as not a design end-state.
Rejected by user choice — the stage-B behavior net changes the risk calculus relative to ADR-0003's situation (see Decision), so deferring here would be over-cautious rather than risk-appropriate.

**(b) Mount-path auth: `app.use('/api', authenticateToken, router)` instead of per-route `authenticateToken` inside the router.**
Pros: one line instead of repeating the middleware on every route.
Cons: `/api` is also the mount point for other route modules registered after this one in `index.js` (e.g. the token-usage handler at line ~317, `/api/system/update`); running `authenticateToken` at the `/api` mount level would apply it to *every* later `/api/*` request handled on that path, not just the file routes — an observable behavior change, not a refactor.
Rejected: violates behavior-preservation.

**(c) Leave the file API in `index.js` and only add tests around it in place.**
Pros: no risk of a move-introduced regression at all.
Cons: keeps the bootstrap file unimportable as a module (mixing bootstrap side effects with route logic) and leaves the module system incomplete — the file API stays outside `boundaries/elements` enforcement indefinitely.
Rejected: doesn't address the actual problem (an unclassified, untested 900-LOC block sitting in the one file every request path touches at startup).

## Consequences

**Positive:**
- `server/index.js`: 1,657 → 766 LOC; bootstrap responsibilities (env, DB, sessions watcher, ws server, route mounting) are no longer entangled with file-API business logic.
- First-ever coverage on this code: `files.routes` 74.72% line, `files.service` 79.95% line (19 endpoint tests), up from 0%.
- The file API is now inside `boundaries/elements` — cross-module imports must go through `modules/files/index.ts`, same enforcement every other `server/modules/*` folder gets.
- Stage C shipped with zero `@ts-expect-error` — no type debt inherited into the new module.

**Negative:**
- `modules/files` now depends on `modules/database` (`@/modules/database/index.js` for `projectsDb`, used in both `files.routes.ts` and `files.service.ts`) — one more inter-module edge in the graph. Verified with `npx madge --circular --extensions ts,js --ts-config server/tsconfig.json server/`: **15 elementary cycles**, unchanged from the pre-phase-5 count. The new edge does not introduce a new cycle.
- `server/index.js` still isn't fully decomposed: the `/health` check, the `/api/system/update` handler, and the token-usage endpoint (`/api/projects/:projectId/sessions/:sessionId/token-usage`) remain inline in `index.js`. Left for a future phase — this ADR scopes only the file API.
- `files.routes.ts` still carries pre-existing `console.log` debug statements (e.g. in `/browse-filesystem`) copied verbatim from the original `index.js` code during Stage A's pure-move — not cleaned up, since Stage A was explicitly behavior-preserving and Stage C's TS conversion was scoped to typing, not logging hygiene.
