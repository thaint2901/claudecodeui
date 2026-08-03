# Phase 5: Files Module Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the ~900-LOC inline file API out of `server/index.js` into `server/modules/files/` (routes + service + tests + barrel), then convert the module to TypeScript — behavior byte-identical.

**Architecture:** Three gated stages: (A) pure-move extraction into `.js` module files behind a `createFilesRouter(authenticateToken)` DI factory, (B) endpoint tests that pin current behavior, (C) TS conversion with the stage-B tests as referee. Spec: `docs/superpowers/specs/2026-08-03-phase5-files-module-design.md`.

**Tech Stack:** Express 4 router, node:test + fetch, better-sqlite3 repositories via `@/modules/database` barrel, tsx runner.

## Global Constraints

- **Behavior byte-identical**: response shapes, status codes, error strings, route paths, and registration order must not change. Only mechanical edits allowed in stage A: `app.METHOD('/api/X'` → `router.METHOD('/X'`, `authenticateToken` parameter injection, import/export plumbing.
- No new dependencies; `package.json` `dependencies`/`devDependencies` unchanged (multer is already a dependency and is dynamically imported inside the upload handler — keep it dynamic).
- Conventional Commits, NO attribution footer. Never edit `eslint.config.js`. Never use `--no-verify`.
- Every commit: `npm test` green both tiers, `npm run typecheck` clean, `npm run lint` 0 errors and warnings not increased.
- Backend eslint has NO `no-undef` rule — a missed import in `.js` files surfaces only at runtime. Stage A therefore requires the module-load probe (Task 1 Step 4) before committing.
- Module imports: database access ONLY via `@/modules/database/index.js` barrel; shared helpers ONLY from `@/shared/utils.js`; NEVER import `server/middleware/auth.js` from inside the module (boundaries/no-unknown — auth is injected).
- Branch is stacked on phase-4 at `b9c7467`; BASE for each review package is the recorded pre-dispatch HEAD.

---

### Task 1: Stage A — pure-move extraction into modules/files (.js)

**Files:**
- Create: `server/modules/files/files.service.js`
- Create: `server/modules/files/files.routes.js`
- Create: `server/modules/files/index.js`
- Modify: `server/index.js` (remove moved blocks; add import + mount)

**Interfaces:**
- Consumes: `projectsDb` from `@/modules/database/index.js` (`getProjectPathById(projectId): string | null`), `WORKSPACES_ROOT`, `validateWorkspacePath` from `@/shared/utils.js` (exactly as the handlers use them today).
- Produces: `createFilesRouter(authenticateToken)` → `express.Router` (exported from `server/modules/files/index.js`); service exports `expandWorkspacePath`, `validatePathInProject`, `validateFilename`, `getFileTree`, `uploadFilesHandler` (the semaphore, `EXCLUDED_DIRS`, `permToRwx` stay module-private).

- [ ] **Step 1: Move the helper cluster into `files.service.js`** — copy these blocks of `server/index.js` VERBATIM (current line refs at base `f0d3207`; re-locate by content if drifted):
  - `expandWorkspacePath` arrow fn (313–322)
  - `validatePathInProject` WITH its full JSDoc comment block (ends line 647; the JSDoc opener sits a few lines above the `function` keyword — take the whole comment)
  - `validateFilename` WITH its JSDoc (ends 669)
  - the upload block: comment `// POST /api/projects/:projectId/files/upload - Upload files` + `// Dynamic import of multer for file uploads` + `uploadFilesHandler` (889–1056)
  - the contiguous tail block 1386–1533: `permToRwx`, `EXCLUDED_DIRS`, `FS_CONCURRENCY` env parsing, `acquire`/`release`, `getFileTree`
  Add at top only the imports these bodies reference (read the bodies and copy the exact import specifiers from `server/index.js`: `fs`/`fsPromises`, `path`, `os` if referenced, `projectsDb` if referenced inside `uploadFilesHandler`, shared utils if referenced). Export the five names in **Produces**; keep the rest unexported.

- [ ] **Step 2: Create `files.routes.js` with the 10 routes** — factory shape:

```js
import express from 'express';

import { projectsDb } from '@/modules/database/index.js';
import { WORKSPACES_ROOT, validateWorkspacePath } from '@/shared/utils.js';

import {
    expandWorkspacePath,
    getFileTree,
    uploadFilesHandler,
    validateFilename,
    validatePathInProject,
} from './files.service.js';

export function createFilesRouter(authenticateToken) {
    const router = express.Router();

    // GET /api/browse-filesystem (mounted at /api)
    router.get('/browse-filesystem', authenticateToken, async (req, res) => {
        /* body VERBATIM from server/index.js lines 325–403 */
    });

    // ... same pattern for the other 9 routes ...

    router.post('/projects/:projectId/files/upload', authenticateToken, uploadFilesHandler);

    return router;
}
```

  The 10 routes and their source blocks: `/browse-filesystem` GET (325–403), `/create-folder` POST (405–444), `/projects/:projectId/file` GET (446–486), `/projects/:projectId/files/content` GET (487–544, uses `mime` — import `mime-types` here), `/projects/:projectId/file` PUT (546–594), `/projects/:projectId/files` GET (596–631), `/projects/:projectId/files/create` POST (671–746), `/projects/:projectId/files/rename` PUT (748–823), `/projects/:projectId/files` DELETE (825–888), `/projects/:projectId/files/upload` POST (one line, 1058–1063). Keep each preceding `//` comment with its route. The ONLY permitted edits per block: strip the `/api` prefix, swap `app.` → `router.`, keep `authenticateToken` in place (it is now the injected parameter).

- [ ] **Step 3: Barrel + mount.** `server/modules/files/index.js`:

```js
export { createFilesRouter } from './files.routes.js';
```

  In `server/index.js`: delete every moved block; add `import { createFilesRouter } from './modules/files/index.js';` to the module imports group; at the exact position where the browse-filesystem handler used to start (after the session-lock/projects mounts — put the mount where line 325 was, so registration order is undisturbed), add:

```js
app.use('/api', createFilesRouter(authenticateToken));
```

  Remove `import mime from 'mime-types';` from `server/index.js` ONLY IF `mime.` no longer appears anywhere in the file (verify with grep).

- [ ] **Step 4: Module-load probe** (catches missed imports that eslint cannot):

Run: `DATABASE_PATH=$(mktemp -d)/probe.db npx tsx -e "const m = await import('./server/modules/files/index.js'); const r = m.createFilesRouter((req,res,next)=>next()); console.log('LOADS', typeof r.use);"`
Expected: prints `LOADS function`.

- [ ] **Step 5: Verify** — `npm test` (both tiers green, natural exit), `npm run typecheck`, `npm run lint` (0 errors, warnings ≤ base), and `wc -l server/index.js` (expect ≈ 750, record exact number in your report).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(files): move the file API out of index.js into modules/files (stage A)"
```

---

### Task 2: Stage B — endpoint tests pinning current behavior

**Files:**
- Create: `server/modules/files/tests/files.routes.test.ts`

**Interfaces:**
- Consumes: `createFilesRouter` from `@/modules/files/index.js`; `initializeDatabase`, `projectsDb` from `@/modules/database/index.js` (`createProjectPath(projectPath, customProjectName?)` — read `server/modules/database/repositories/projects.db.ts:19` for the exact return shape to extract the created project id).
- Produces: the behavior net Task 3 relies on. Do not change any module source in this task.

- [ ] **Step 1: Test scaffold** (isolation pattern copied from `server/modules/database/tests/projects.db.integration.test.ts` but via the barrel, NOT `init-db.js` deep import):

```ts
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'files-module-'));
process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');

const { initializeDatabase, projectsDb } = await import('@/modules/database/index.js');
const { createFilesRouter } = await import('@/modules/files/index.js');

await initializeDatabase();

const projectDir = path.join(tempRoot, 'proj');
await mkdir(projectDir, { recursive: true });
await writeFile(path.join(projectDir, 'hello.txt'), 'hello world\n');
const created = projectsDb.createProjectPath(projectDir);
const projectId = /* extract id from `created` per the repository's return shape */;

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/api', createFilesRouter((req, res, next) => next()));
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const api = (p: string) => `http://127.0.0.1:${port}/api${p}`;

test.after(async () => {
    server.close();
    await rm(tempRoot, { recursive: true, force: true });
});
```

  NOTE: `express.json` must mirror `server/index.js`'s body-parser config for the routes to behave identically (check index.js for the exact `limit` and `verify` options and reproduce only what affects these routes).

- [ ] **Step 2: Write the tests.** One `test()` per row; the assertion targets are THE CURRENT behavior — read each handler body first and pin exactly what it returns today (status + body keys + error strings). Required coverage:

| # | Behavior | Sketch |
|---|---|---|
| 1 | read file happy path | `GET /projects/:id/file?filePath=hello.txt` (or absolute — match handler semantics) → 200, content matches |
| 2 | read file missing param | no `filePath` → 400 `{ error: 'Invalid file path' }` |
| 3 | read file traversal | `filePath=../../etc/passwd` → the handler's actual rejection status (pin it) |
| 4 | save file roundtrip | `PUT /projects/:id/file` writes; follow-up read returns new content |
| 5 | save file traversal rejected | same vector as 3 on the PUT route |
| 6 | file tree | `GET /projects/:id/files` → 200 array; contains `hello.txt` entry; nested dir children appear |
| 7 | tree on unknown project | bogus projectId → 404 `{ error: 'Project not found' }` |
| 8 | files/content raw bytes | `GET /projects/:id/files/content?...` → 200, correct `Content-Type` from mime lookup |
| 9 | create file | `POST /projects/:id/files/create` → success; file exists on disk |
| 10 | create with bad filename | name failing `validateFilename` → pinned 4xx + error string |
| 11 | create traversal | target dir outside root → pinned rejection |
| 12 | rename | `PUT /projects/:id/files/rename` → renamed on disk |
| 13 | rename to bad name | pinned 4xx |
| 14 | delete file | `DELETE /projects/:id/files` → gone from disk |
| 15 | delete traversal | pinned rejection |
| 16 | browse-filesystem | explicit `dirPath=<tempRoot>` → 200 listing containing `proj`; nonexistent dir → pinned error |
| 17 | create-folder | inside workspace → created; traversal/system path → pinned rejection |
| 18 | upload happy path | `FormData` + `Blob` via fetch → files land where the handler puts them (read handler for field name + destination) |
| 19 | upload traversal filename | malicious filename → pinned rejection (handler validates via `validatePathInProject` at line ~978 of the original) |

- [ ] **Step 3: Run** — `npx tsx --test --experimental-test-module-mocks --tsconfig server/tsconfig.json server/modules/files/tests/files.routes.test.ts` → all pass. Then full `npm test` both tiers.

- [ ] **Step 4: Coverage number** — `npm run test:coverage 2>&1 | grep -A2 "modules/files"`; record line % for `files.routes.js` and `files.service.js` in your report (spec gate: ≥50%).

- [ ] **Step 5: Commit**

```bash
git add server/modules/files/tests/files.routes.test.ts
git commit -m "test(files): endpoint coverage for the extracted file API (stage B)"
```

---

### Task 3: Stage C — TypeScript conversion

**Files:**
- Rename (git mv): `server/modules/files/files.service.js` → `.ts`, `files.routes.js` → `.ts`, `index.js` → `index.ts`
- Test: stage-B suite is the referee — zero test edits allowed except import extensions if needed (alias imports need none).

**Interfaces:**
- Consumes: stage-B tests green at start (verify before touching anything).
- Produces: same exported names, now typed: `createFilesRouter(authenticateToken: RequestHandler): Router`.

- [ ] **Step 1:** `git mv` all three files to `.ts`.
- [ ] **Step 2: Type the code — types only, zero behavior edits.** Use `import type { Request, Response, RequestHandler, Router } from 'express';`. Define local interfaces for structured values (e.g. `interface FileTreeItem { name: string; path: string; type: 'file' | 'directory'; children?: FileTreeItem[]; /* derive the exact remaining fields from what getFileTree actually builds — don't guess */ }`). Where strict mode fights untyped runtime values, prefer narrow local types; a commented `@ts-expect-error <reason>` is allowed ONLY where clean typing would require a behavior change (phase-4 precedent). Adding a return statement, changing a comparison, reordering conditions are all FORBIDDEN.
- [ ] **Step 3: Verify** — stage-B suite passes unchanged; `npm run typecheck` clean; `npm run lint` 0 errors; full `npm test` both tiers natural exit.
- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(files): convert modules/files to TypeScript (stage C)"
```

---

### Task 4: ADR-0004 + CLAUDE.md pointers

**Files:**
- Create: `docs/adr/ADR-0004-files-module-extraction.md`
- Modify: `CLAUDE.md` (pointer updates ONLY; do NOT touch the `## Development Model` section)

- [ ] **Step 1: Write ADR-0004** — Nygard format, sections exactly: title `# ADR-0004: Files module extraction with in-phase TS conversion`, **Date** 2026-08-03, **Status** accepted, **Deciders** thaint2901 + Claude phase-5 session, then:
  - **Context**: `server/index.js` was bootstrap + the whole file API (10 inline handlers + helper cluster, ~900 LOC, 0% coverage, unimportable). Cite the measured base: 1,657 LOC at `b9c7467`, and the resulting LOC after stage A (take the number from Task 1's report).
  - **Decision**: extract into `server/modules/files/` behind `createFilesRouter(authenticateToken)` (DI keeps middleware out of the module — boundaries/no-unknown lesson from phase 4); three gated stages A/B/C; TS conversion done IN-PHASE (user decision 2026-08-03) — safe because stage B builds the behavior net first, which is exactly what ADR-0003's alternative (c) said was missing when it deferred TS conversion for the provider files.
  - **Alternatives Considered**: (a) extract as `.js` and defer TS (the phase-4 pattern) — rejected by user choice; the stage-B net changes the risk calculus vs ADR-0003's situation. (b) mount-path auth (`app.use('/api', authenticateToken, router)`) — rejected: would run auth on every later `/api/*` request, an observable behavior change. (c) leave the file API in `index.js` and only add tests — rejected: keeps the bootstrap unimportable and the module system incomplete.
  - **Consequences**: positive — bootstrap ≈ 750 LOC, first legacy-tier coverage (cite stage-B %), file API inside boundaries lint; negative — `modules/files` depends on `modules/database` (one more inter-module edge; no new cycle — verify with a madge run and state the cycle count vs the known 15); the `/health`, system-update, token-usage handlers still live in `index.js` (future phases).
- [ ] **Step 2: CLAUDE.md pointers** — grep CLAUDE.md for `index.js` and file-API claims; update: the repo-layout line for `server/index.js` (it no longer contains the file API), add `files/` to the modules list in the layout block, and any sentence claiming index.js holds ~900 LOC of file handlers. Do NOT edit the `## Development Model` section or divergence figures (ADR-0001 owns those).
- [ ] **Step 3: Verify** — ADR has all five Nygard sections; `npm run typecheck && npm run lint` still green.
- [ ] **Step 4: Commit**

```bash
git add docs/adr/ADR-0004-files-module-extraction.md CLAUDE.md
git commit -m "docs: ADR-0004 and CLAUDE.md pointers for the files module"
```

---

## After all tasks (controller-run, NOT subagent tasks)

1. Whole-branch review (most capable model) over `b9c7467..HEAD`.
2. CodeScene gate: ≥7.0 per new module file, no function cc>30 (decompose inside `files.service.ts` if the gate fails — behavior-preserving, stage-B referee).
3. madge cycle count (must not exceed the known 15).
4. Playwright smoke on SERVER_PORT=3002 VITE_PORT=5174: file-tree loads, open file, edit+save, create folder, rename, delete, upload image.
5. Push, draft PR (base: phase-4 branch head), memory update, SDD workspace cleanup.
