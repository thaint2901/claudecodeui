# Phase 5: Extract the file API into server/modules/files/ — design

**Date**: 2026-08-03
**Status**: approved (design approved in-session; TS-now decision is the user's explicit choice)
**Branch strategy**: `worktree-refactor-phase5-files-module` is **stacked on the phase-4 branch** at `b9c7467` (user decision — PR #13 stays draft; merge/fold order decided later). All diffs and review packages measure against `b9c7467`, never `origin/main`.

## Problem

`server/index.js` (1,657 LOC at base) is the bootstrap and also the entire filesystem/project-file CRUD feature: 10 inline route handlers plus their helper cluster, ~900 LOC, 0% test coverage, unimportable as a module (importing it starts the server). The extraction gives the file API a home in the module system (barrel + boundaries lint), makes it testable for the first time, and slims the bootstrap toward its one job.

## Scope — exactly what moves

Route handlers (paths stay byte-identical; current lines at `b9c7467`):

| Route | Line |
|---|---|
| `GET /api/browse-filesystem` | 325 |
| `POST /api/create-folder` | 405 |
| `GET /api/projects/:projectId/file` | 446 |
| `GET /api/projects/:projectId/files/content` | 488 |
| `PUT /api/projects/:projectId/file` | 546 |
| `GET /api/projects/:projectId/files` | 596 |
| `POST /api/projects/:projectId/files/create` | 671 |
| `PUT /api/projects/:projectId/files/rename` | 748 |
| `DELETE /api/projects/:projectId/files` | 825 |
| `POST /api/projects/:projectId/files/upload` | 1058 (handler `uploadFilesHandler` at 891) |

Helper cluster that moves with them: `expandWorkspacePath` (313), `validatePathInProject` (633), `validateFilename` (649), `uploadFilesHandler` (891), and the contiguous block 1386–1533 — `permToRwx`, `EXCLUDED_DIRS`, the `FS_CONCURRENCY` semaphore (`acquire`/`release`, used only by `getFileTree`), and `getFileTree` itself — plus the imports only they use (`mime-types`; multer is dynamically imported inside the upload handler, so no top-level multer import exists).

**Stays in `index.js`**: `/health`, `POST /api/system/update`, `GET .../token-usage` (sessions domain), `app.get('*')` static fallback, `readUsageNumber`, server-marker helpers, all bootstrap. Target: `index.js` ≈ 750 LOC.

## Design

### Module layout (pattern: `modules/projects/`)

```
server/modules/files/
  index.ts            # barrel: exports createFilesRouter
  files.routes.ts     # the 10 routes, relative to /api mount
  files.service.ts    # path validation, getFileTree, permToRwx, upload mutex + handler logic
  tests/              # endpoint tests (this tier's first coverage)
```

### Auth seam — DI factory, no middleware import

Phase-4 lesson: a module importing root-level `server/middleware/auth.js` trips `boundaries/no-unknown` (unclassified target), and `eslint.config.js` is hook-protected. Solution: the module exports `createFilesRouter(authenticateToken)`; `server/index.js` injects the middleware at mount:

```js
app.use('/api', createFilesRouter(authenticateToken));
```

Each route inside the router attaches the injected auth exactly where the inline handlers attach it today — auth semantics byte-identical (mount-path middleware would instead run auth on every later `/api/*` request; ruled out). Tests inject `(req, res, next) => next()`.

### Sequencing — three gated stages (mitigates ADR-0003's move+type compounding risk)

- **Stage A — pure move, `.js`**: handler + helper bodies copied verbatim into `files.routes.js`/`files.service.js` (only mechanical edits: `app.` → `router.`, path prefix, export/import plumbing); the barrel starts as `index.js`. All three are renamed to `.ts` only in Stage C. Diff reviewable as a move. Suites + typecheck + lint green.
- **Stage B — endpoint tests**: `node:test`, real express app on port 0, `fetch`, temp dirs, isolated `DATABASE_PATH` (existing `withIsolatedDatabase` pattern) with real project rows. Must cover: read/write/create/rename/delete file, **path-traversal rejection through every path-accepting endpoint** (`validatePathInProject` is security code — heaviest coverage here), `validateFilename` rejects, browse-filesystem, create-folder, upload happy path + mutex, file-tree depth/hidden behavior. This net is what ADR-0003's alternative (c) said was missing.
- **Stage C — TS conversion**: rename module files to `.ts`, strict mode, Stage-B tests as the behavior referee. Commented `@ts-expect-error` allowed where clean typing is impossible without behavior change (phase-4 precedent).

## Acceptance gates

- `npm test` both tiers green with natural exit; `npm run typecheck` clean; `npm run lint` 0 errors, warnings not increased.
- CodeScene ≥ 7.0 for every new module file; no function cc > 30 (decompose `uploadFilesHandler`, cc=27 file-level driver, if needed to clear the file gate).
- `server/index.js` ≈ 750 LOC and contains zero file-API code.
- Legacy-tier coverage on moved paths ≥ 50% (scorecard line: legacy 0% → first real number).
- Playwright smoke on the worktree instance (SERVER_PORT=3002 VITE_PORT=5174): file-tree loads, open file, edit + save, create folder, rename, delete, upload image.

## Docs in this phase

- **ADR-0004 — files module extraction with in-phase TS conversion**: records the user's TS-now decision and why it is safe here (Stage-B net exists before any typing starts), explicitly relating it to ADR-0003's alternative (c) rejection.
- CLAUDE.md: repoint file-API references to `server/modules/files/`; do NOT touch the `## Development Model` section (PR #12 conflict avoidance).

## Out of scope

- `/health`, `/api/system/update`, token-usage, `app.get('*')`, any `routes/` migration.
- Dissolving the 15 module cycles, `shared/utils.ts` split, wire types (phase 6).
- Behavior changes of any kind — response shapes, status codes, error strings stay byte-identical.

## Global constraints (bind every task)

- No new dependencies; `package.json` deps unchanged.
- Conventional Commits, NO attribution footer; never edit `eslint.config.js`; never use `--no-verify`.
- Every commit: suites green, typecheck clean, lint 0 errors.
- Stacked branch: BASE for all review packages is the task's recorded pre-dispatch HEAD; whole-branch review measures `b9c7467..HEAD`.
