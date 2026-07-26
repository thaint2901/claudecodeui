# Edit Prompt → Conversation Fork — Implementation Plan

> **STATUS: IMPLEMENTED AND SUPERSEDED (2026-07-26).** Shipped in PR #5. The
> unticked `- [ ]` boxes below are the plan as originally written, kept for
> history — they are **not** outstanding work. Where this plan and the shipped
> code disagree, the code and
> `docs/business/capabilities/chat-and-agent-streaming/edit-prompt-fork.md`
> win. Known divergences: **Task 11's branch badge was built and then removed**
> (two surfaces counting branches differently contradicted each other), the
> sidebar branch list likewise, the `‹ ›` pager moved off the fork anchor onto
> the prompt that follows it, and the prompt's controls became hover-gated.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user edit a previously sent prompt in a Claude session; sending forks the conversation in place (ChatGPT-style) with a `< 1/2 >` branch switcher, per spec `docs/superpowers/specs/2026-07-23-edit-prompt-fork-design.md`.

**Architecture:** Session-level fork graph in SQLite (Approach A). The Agent SDK's `resume + resumeSessionAt + forkSession` creates a new provider session whose JSONL already contains the copied history, so message loading is untouched. Only fork relationships (4 new `sessions` columns), one gateway event (`branch_created`), two REST endpoints, and frontend edit/switcher UI are added.

**Tech Stack:** Express + ws + better-sqlite3 (server, ESM TS/JS), `@anthropic-ai/claude-agent-sdk` 0.3.165, React + Zustand (frontend).

## Global Constraints

- Node 22+ (`.nvmrc`). Server tests: `npx tsx --test --tsconfig server/tsconfig.json <path>` (NO `npm test`, NO vitest — vitest cannot resolve `@/` in this checkout).
- Conventional Commits enforced by commitlint (`feat`, `fix`, `test`, `docs`, `chore`; scope encouraged: `feat(chat): …`). Husky attribution OFF.
- Backend cross-module imports MUST go through module barrels (`server/modules/<m>/index.ts`) — eslint-plugin-boundaries fails deep imports.
- Every NEW WebSocket `kind` must get an explicit `case` in `src/components/chat/hooks/useChatRealtimeHandlers.ts` — unhandled kinds fall to `default` and corrupt the message store (known gotcha).
- Feature is Claude-only. UI affordances hidden for other providers.
- Dev server reads the MAIN checkout, not this worktree — for manual testing `cp` changed files to `/home/thaint/projects/claudecodeui/...` and browse `localhost:5173` (never 3001). Backend has no hot reload (`server:dev` is plain tsx).
- The spec's error contract: a failed fork must leave NO fork row in the DB (row is written only after the SDK announces the new session id). **As shipped this holds only for failures *before* the announcement** — the row is written mid-stream, so a run that errors afterwards keeps its branch row and its moved active leaf. See §4.4 of the spec.
- After finishing all tasks run: `npm run typecheck && npm run lint && npx tsx --test --tsconfig server/tsconfig.json server/modules/database/tests/*.test.ts server/modules/providers/list/claude/tests/*.test.ts server/modules/websocket/services/tests/*.test.ts` (adjust to files that exist).

---

### Task 0: Spike — lock down `resumeSessionAt` semantics

**Files:**
- Create: `scripts/spike-resume-session-at.mjs` (committed for reproducibility)
- Modify: `docs/superpowers/specs/2026-07-23-edit-prompt-fork-design.md` (§2 and §7: record findings)

**Interfaces:**
- Produces: a decision constant used by Task 3 — `RESUME_POINT_RULE`, one of `'preceding-any-uuid'` (resumeSessionAt = uuid of the entry immediately before the edited user message, whatever its type) or `'preceding-assistant-uuid'` (nearest preceding assistant entry).

- [ ] **Step 1: Write the spike script**

```js
// scripts/spike-resume-session-at.mjs
// Usage: node scripts/spike-resume-session-at.mjs
// Requires a working `claude` login. Creates a throwaway 3-turn session in a
// temp dir, then forks it twice (resumeSessionAt = user uuid vs assistant
// uuid) and prints what each branch JSONL contains.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const cwd = mkdtempSync(path.join(tmpdir(), 'fork-spike-'));
const base = { cwd, allowedTools: [], maxTurns: 1, extraArgs: { 'replay-user-messages': null } };

async function run(prompt, extra = {}) {
  const messages = [];
  for await (const m of query({ prompt, options: { ...base, ...extra } })) messages.push(m);
  return messages;
}

// 1) Build a 3-turn session, capturing user-message uuids as they replay.
let sessionId, userUuids = [], assistantUuids = [];
for (const prompt of ['Say exactly: ONE', 'Say exactly: TWO', 'Say exactly: THREE']) {
  const msgs = await run(prompt, sessionId ? { resume: sessionId } : {});
  for (const m of msgs) {
    if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
    if (m.type === 'user' && m.uuid) userUuids.push(m.uuid);
    if (m.type === 'assistant' && m.uuid) assistantUuids.push(m.uuid);
  }
}
console.log({ sessionId, userUuids, assistantUuids });

// 2) Fork at the SECOND user message uuid (simulating "edit prompt 2").
async function fork(label, resumeSessionAt) {
  const msgs = await run('Say exactly: EDITED', { resume: sessionId, forkSession: true, ...(resumeSessionAt ? { resumeSessionAt } : {}) });
  const forkId = msgs.find((m) => m.type === 'system' && m.subtype === 'init')?.session_id;
  const projDir = path.join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const jsonl = readFileSync(path.join(projDir, `${forkId}.jsonl`), 'utf8');
  const texts = jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .map((e) => JSON.stringify(e.message?.content ?? e.summary ?? '').slice(0, 80));
  console.log(`\n=== ${label} (fork ${forkId}) ===`);
  console.log(texts.join('\n'));
}

await fork('resumeSessionAt = user uuid of turn 2 (want: ONE only, then EDITED)', userUuids[1]);
await fork('resumeSessionAt = assistant uuid of turn 1 (want: ONE only, then EDITED)', assistantUuids[0]);
await fork('no resumeSessionAt (want: full copy + EDITED)', undefined);
```

- [ ] **Step 2: Run it**

Run: `node scripts/spike-resume-session-at.mjs`
Expected: three fork listings. Determine which uuid choice yields a branch whose last pre-EDITED turn is "ONE" (i.e. the edited prompt "TWO" and everything after it are excluded).

- [ ] **Step 3: Record the result in the spec**

In `docs/superpowers/specs/2026-07-23-edit-prompt-fork-design.md` §2, replace the sentence "behavior with a *user* message UUID must be confirmed by the spike in §7 before implementation" with the observed rule, and add to §7.0 e.g.:
`Spike result (2026-07-23): RESUME_POINT_RULE = 'preceding-assistant-uuid' — resumeSessionAt must be the uuid of the assistant message preceding the edited prompt; a user-message uuid <works | is ignored | errors>.`

- [ ] **Step 4: Commit**

```bash
git add scripts/spike-resume-session-at.mjs docs/superpowers/specs/2026-07-23-edit-prompt-fork-design.md
git commit -m "docs(chat): record resumeSessionAt spike results for edit-prompt fork"
```

---

### Task 1: DB migration — four fork columns

**Files:**
- Modify: `server/modules/database/schema.ts:99-120` (SESSIONS_TABLE_SCHEMA_SQL)
- Modify: `server/modules/database/migrations.ts` (new `addForkColumns`, call it in `runMigrations` after `addProviderSessionIdMapping` at :454)
- Test: `server/modules/database/tests/sessions.db.integration.test.ts` (append)

**Interfaces:**
- Produces: `sessions` columns `fork_root_session_id TEXT`, `forked_from_session_id TEXT`, `forked_at_message_uuid TEXT`, `active_leaf BOOLEAN DEFAULT 1`; index `idx_sessions_fork_root`.

- [ ] **Step 1: Write the failing test** (append to the integration test file, using its existing `withIsolatedDatabase` helper)

```ts
test('migration adds fork columns with safe defaults', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('plain-session', 'claude', '/workspace/demo-project');
    const row = sessionsDb.getSessionById('plain-session');
    assert.equal(row?.fork_root_session_id, null);
    assert.equal(row?.forked_from_session_id, null);
    assert.equal(row?.forked_at_message_uuid, null);
    assert.equal(row?.active_leaf, 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/database/tests/sessions.db.integration.test.ts`
Expected: FAIL — TS/`undefined` on the new fields (they don't exist yet).

- [ ] **Step 3: Implement**

`schema.ts` — inside `SESSIONS_TABLE_SCHEMA_SQL`, after the `isArchived BOOLEAN DEFAULT 0,` line add:

```sql
    -- Conversation-fork graph (edit-prompt feature). NULL/1 for never-forked
    -- sessions. See docs/superpowers/specs/2026-07-23-edit-prompt-fork-design.md
    fork_root_session_id TEXT,
    forked_from_session_id TEXT,
    forked_at_message_uuid TEXT,
    active_leaf BOOLEAN DEFAULT 1,
```

`migrations.ts` — mirror `addProviderSessionIdMapping` (:393-403):

```ts
/** Adds the conversation-fork columns used by the edit-prompt feature. */
const addForkColumns = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'fork_root_session_id', 'TEXT');
  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'forked_from_session_id', 'TEXT');
  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'forked_at_message_uuid', 'TEXT');
  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'active_leaf', 'BOOLEAN DEFAULT 1');
};
```

In `runMigrations`, after `addProviderSessionIdMapping(db);` (:454) add `addForkColumns(db);`, and with the other index creations (:457-462) add:
`db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_fork_root ON sessions(fork_root_session_id)');`

`sessions.db.ts` — extend `SessionRow` (:5-15) with:

```ts
  fork_root_session_id: string | null;
  forked_from_session_id: string | null;
  forked_at_message_uuid: string | null;
  active_leaf: number;
```

and extend `SESSION_ROW_COLUMNS` (:17-18) to
`'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at, fork_root_session_id, forked_from_session_id, forked_at_message_uuid, active_leaf'`.

- [ ] **Step 4: Run test to verify it passes** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/modules/database/schema.ts server/modules/database/migrations.ts server/modules/database/repositories/sessions.db.ts server/modules/database/tests/sessions.db.integration.test.ts
git commit -m "feat(db): add conversation-fork columns to sessions"
```

---

### Task 2: Repository fork methods + sidebar filtering

**Files:**
- Modify: `server/modules/database/repositories/sessions.db.ts`
- Test: `server/modules/database/tests/sessions-fork.integration.test.ts` (new, copy the `withIsolatedDatabase` helper from the sibling test)

**Interfaces:**
- Produces (on `sessionsDb`):
  - `createForkedSession(args: { providerSessionId: string; parentSessionId: string; forkedAtMessageUuid: string; provider: string; projectPath: string; jsonlPath?: string | null }): string` — returns new app `session_id` (= providerSessionId).
  - `activateBranch(sessionId: string): SessionRow | null` — flips active leaf inside the cluster; returns activated row.
  - `getClusterBranches(sessionId: string): SessionRow[]` — all branches of the session's cluster ordered by `created_at`; `[]` when the session was never forked.
- Consumes: Task 1 columns.

- [ ] **Step 1: Write the failing tests**

```ts
// server/modules/database/tests/sessions-fork.integration.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
// copy withIsolatedDatabase from sessions.db.integration.test.ts (imports incl.)

test('createForkedSession builds the cluster and keeps one active leaf', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('root-s', 'claude', '/workspace/p');
    const branchId = sessionsDb.createForkedSession({
      providerSessionId: 'branch-1',
      parentSessionId: 'root-s',
      forkedAtMessageUuid: 'uuid-msg-2',
      provider: 'claude',
      projectPath: '/workspace/p',
      jsonlPath: null,
    });
    assert.equal(branchId, 'branch-1');
    const root = sessionsDb.getSessionById('root-s');
    const branch = sessionsDb.getSessionById('branch-1');
    assert.equal(root?.fork_root_session_id, 'root-s');
    assert.equal(root?.active_leaf, 0);
    assert.equal(branch?.fork_root_session_id, 'root-s');
    assert.equal(branch?.forked_from_session_id, 'root-s');
    assert.equal(branch?.forked_at_message_uuid, 'uuid-msg-2');
    assert.equal(branch?.active_leaf, 1);

    // second fork from the branch keeps the same root, single active leaf
    sessionsDb.createForkedSession({
      providerSessionId: 'branch-2', parentSessionId: 'branch-1',
      forkedAtMessageUuid: 'uuid-msg-5', provider: 'claude', projectPath: '/workspace/p',
    });
    const cluster = sessionsDb.getClusterBranches('root-s');
    assert.deepEqual(cluster.map((r) => r.session_id).sort(), ['branch-1', 'branch-2', 'root-s']);
    assert.equal(cluster.filter((r) => r.active_leaf === 1).length, 1);
  });
});

test('activateBranch flips exactly one active leaf', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('root-s', 'claude', '/workspace/p');
    sessionsDb.createForkedSession({
      providerSessionId: 'branch-1', parentSessionId: 'root-s',
      forkedAtMessageUuid: 'u2', provider: 'claude', projectPath: '/workspace/p',
    });
    const activated = sessionsDb.activateBranch('root-s');
    assert.equal(activated?.session_id, 'root-s');
    assert.equal(sessionsDb.getSessionById('root-s')?.active_leaf, 1);
    assert.equal(sessionsDb.getSessionById('branch-1')?.active_leaf, 0);
  });
});

test('sidebar page/count queries hide non-active branches; non-forked sessions unaffected', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('plain', 'claude', '/workspace/p');
    sessionsDb.createSession('root-s', 'claude', '/workspace/p');
    sessionsDb.createForkedSession({
      providerSessionId: 'branch-1', parentSessionId: 'root-s',
      forkedAtMessageUuid: 'u2', provider: 'claude', projectPath: '/workspace/p',
    });
    const page = sessionsDb.getSessionsByProjectPathPage('/workspace/p', 10, 0);
    assert.deepEqual(page.map((r) => r.session_id).sort(), ['branch-1', 'plain']);
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/p'), 2);
  });
});

test('getClusterBranches returns [] for never-forked sessions', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('plain', 'claude', '/workspace/p');
    assert.deepEqual(sessionsDb.getClusterBranches('plain'), []);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/database/tests/sessions-fork.integration.test.ts`
Expected: FAIL — `createForkedSession is not a function`.

- [ ] **Step 3: Implement in `sessions.db.ts`** (append inside the `sessionsDb` object)

```ts
  /**
   * Records one conversation branch created by the edit-prompt fork flow.
   * The fork's provider-native id doubles as its app session_id (same
   * convention as disk-discovered sessions), so the filesystem watcher's
   * later createSession() call updates this row instead of duplicating it.
   * Runs in a transaction so the cluster never has 0 or 2 active leaves.
   */
  createForkedSession(args: {
    providerSessionId: string;
    parentSessionId: string;
    forkedAtMessageUuid: string;
    provider: string;
    projectPath: string;
    jsonlPath?: string | null;
  }): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(args.provider, args.projectPath);
    projectsDb.createProjectPath(normalizedProjectPath);

    const insertBranch = db.transaction(() => {
      const parent = db
        .prepare(`SELECT ${SESSION_ROW_COLUMNS} FROM sessions WHERE session_id = ? LIMIT 1`)
        .get(args.parentSessionId) as SessionRow | undefined;
      if (!parent) {
        throw new Error(`Fork parent session "${args.parentSessionId}" not found`);
      }

      const rootId = parent.fork_root_session_id ?? parent.session_id;

      // Whole cluster (including a root that predates its own fork column)
      // goes inactive; the new branch becomes the single active leaf.
      db.prepare(
        `UPDATE sessions SET active_leaf = 0, fork_root_session_id = ?
         WHERE session_id = ? OR fork_root_session_id = ?`
      ).run(rootId, rootId, rootId);

      db.prepare(
        `INSERT INTO sessions (
           session_id, provider, provider_session_id, custom_name, project_path,
           jsonl_path, isArchived, created_at, updated_at,
           fork_root_session_id, forked_from_session_id, forked_at_message_uuid, active_leaf
         ) VALUES (?, ?, ?, NULL, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, 1)`
      ).run(
        args.providerSessionId, args.provider, args.providerSessionId,
        normalizedProjectPath, args.jsonlPath ?? null,
        rootId, args.parentSessionId, args.forkedAtMessageUuid,
      );

      return args.providerSessionId;
    });

    return insertBranch();
  },

  /** Makes one branch the cluster's visible leaf (two-step, one transaction). */
  activateBranch(sessionId: string): SessionRow | null {
    const db = getConnection();
    const activate = db.transaction(() => {
      const row = db
        .prepare(`SELECT ${SESSION_ROW_COLUMNS} FROM sessions WHERE session_id = ? LIMIT 1`)
        .get(sessionId) as SessionRow | undefined;
      if (!row || !row.fork_root_session_id) {
        return null;
      }
      db.prepare('UPDATE sessions SET active_leaf = 0 WHERE fork_root_session_id = ?')
        .run(row.fork_root_session_id);
      db.prepare('UPDATE sessions SET active_leaf = 1, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?')
        .run(sessionId);
      return db
        .prepare(`SELECT ${SESSION_ROW_COLUMNS} FROM sessions WHERE session_id = ? LIMIT 1`)
        .get(sessionId) as SessionRow | undefined;
    });
    return normalizeSessionRow(activate() ?? null) ?? null;
  },

  /** All branches of a session's fork cluster; [] when never forked. */
  getClusterBranches(sessionId: string): SessionRow[] {
    const db = getConnection();
    const row = db
      .prepare('SELECT fork_root_session_id FROM sessions WHERE session_id = ? LIMIT 1')
      .get(sessionId) as { fork_root_session_id: string | null } | undefined;
    if (!row?.fork_root_session_id) {
      return [];
    }
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS} FROM sessions
         WHERE fork_root_session_id = ?
         ORDER BY datetime(created_at) ASC, session_id ASC`
      )
      .all(row.fork_root_session_id) as SessionRow[];
    return normalizeSessionRows(rows);
  },
```

Sidebar filtering — in `getSessionsByProjectPathPage` (:361-376) and `countSessionsByProjectPath` (:378-391), change the WHERE clause to add `AND active_leaf = 1`:

```sql
         WHERE project_path = ?
           AND isArchived = 0
           AND active_leaf = 1
```

Do NOT touch `getAllSessions` / `getSessionsByProjectPath` / archived queries — watchers and deletion flows must keep seeing every row.

- [ ] **Step 4: Run tests** (same command). Expected: PASS. Also re-run `server/modules/database/tests/sessions.db.integration.test.ts` — Expected: PASS (regression).

- [ ] **Step 5: Commit**

```bash
git add server/modules/database/repositories/sessions.db.ts server/modules/database/tests/sessions-fork.integration.test.ts
git commit -m "feat(db): fork cluster repository methods and sidebar active-leaf filtering"
```

---

### Task 3: Resume-point lookup in the Claude provider

**Files:**
- Create: `server/modules/providers/list/claude/claude-fork.provider.ts`
- Create: `server/modules/providers/list/claude/tests/claude-fork.provider.test.ts`
- Modify: `server/modules/providers/index.ts` (barrel export — follow the file's existing export style)

**Interfaces:**
- Produces: `findForkResumePoint(jsonlPath: string, providerSessionId: string, editAtMessageUuid: string): Promise<{ resumeSessionAt: string | null }>`
  - `resumeSessionAt: null` ⇔ the edited message is the first prompt (fork from the beginning).
  - Throws `ForkResumePointError` (exported, `code: 'RESUME_POINT_NOT_FOUND'`) when the uuid is not in the transcript.
- Consumes: Task 0's `RESUME_POINT_RULE`. The code below implements `'preceding-assistant-uuid'`; if the spike concluded `'preceding-any-uuid'`, keep the same shape but track every uuid-bearing entry instead of only assistants (one-line filter change, marked below).

- [ ] **Step 1: Write the failing test**

```ts
// server/modules/providers/list/claude/tests/claude-fork.provider.test.ts
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findForkResumePoint, ForkResumePointError } from '@/modules/providers/list/claude/claude-fork.provider.js';

const SID = 'prov-session-1';
const line = (obj: Record<string, unknown>) => JSON.stringify({ sessionId: SID, ...obj });

async function withFixture(run: (jsonlPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fork-fixture-'));
  const jsonlPath = path.join(dir, `${SID}.jsonl`);
  await writeFile(jsonlPath, [
    line({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'ONE' } }),
    line({ uuid: 'a1', type: 'assistant', message: { role: 'assistant', content: [] } }),
    line({ uuid: 'u2', type: 'user', message: { role: 'user', content: 'TWO' } }),
    line({ uuid: 'a2', type: 'assistant', message: { role: 'assistant', content: [] } }),
    // foreign-session line that must be ignored:
    JSON.stringify({ sessionId: 'other', uuid: 'x9', type: 'assistant' }),
  ].join('\n'));
  try { await run(jsonlPath); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('finds the assistant message preceding the edited prompt', async () => {
  await withFixture(async (p) => {
    assert.deepEqual(await findForkResumePoint(p, SID, 'u2'), { resumeSessionAt: 'a1' });
  });
});

test('editing the first prompt resumes from the beginning', async () => {
  await withFixture(async (p) => {
    assert.deepEqual(await findForkResumePoint(p, SID, 'u1'), { resumeSessionAt: null });
  });
});

test('unknown uuid throws RESUME_POINT_NOT_FOUND', async () => {
  await withFixture(async (p) => {
    await assert.rejects(
      () => findForkResumePoint(p, SID, 'missing-uuid'),
      (err: unknown) => err instanceof ForkResumePointError && err.code === 'RESUME_POINT_NOT_FOUND',
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/providers/list/claude/tests/claude-fork.provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/modules/providers/list/claude/claude-fork.provider.ts
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

export class ForkResumePointError extends Error {
  readonly code = 'RESUME_POINT_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'ForkResumePointError';
  }
}

/**
 * Scans one Claude transcript for the resume point of an edit-prompt fork:
 * the uuid of the assistant message immediately preceding the edited user
 * message (RESUME_POINT_RULE = 'preceding-assistant-uuid', see spike results
 * in the design spec). `null` means the edited message is the first prompt.
 */
export async function findForkResumePoint(
  jsonlPath: string,
  providerSessionId: string,
  editAtMessageUuid: string,
): Promise<{ resumeSessionAt: string | null }> {
  const rl = readline.createInterface({
    input: createReadStream(jsonlPath, 'utf8'),
    crlfDelay: Infinity,
  });

  let lastResumableUuid: string | null = null;
  try {
    for await (const rawLine of rl) {
      if (!rawLine.trim()) continue;
      let entry: { sessionId?: string; uuid?: string; type?: string };
      try {
        entry = JSON.parse(rawLine);
      } catch {
        continue; // tolerate partial/corrupt trailing lines
      }
      if (entry.sessionId !== providerSessionId || !entry.uuid) continue;
      if (entry.uuid === editAtMessageUuid) {
        return { resumeSessionAt: lastResumableUuid };
      }
      // RESUME_POINT_RULE: only assistant uuids are valid resume anchors.
      // If the spike concluded 'preceding-any-uuid', drop this type check.
      if (entry.type === 'assistant') {
        lastResumableUuid = entry.uuid;
      }
    }
  } finally {
    rl.close();
  }

  throw new ForkResumePointError(
    `Message ${editAtMessageUuid} not found in transcript for session ${providerSessionId}`,
  );
}
```

Barrel: add to `server/modules/providers/index.ts`, matching its existing export lines:

```ts
export { findForkResumePoint, ForkResumePointError } from '@/modules/providers/list/claude/claude-fork.provider.js';
```

- [ ] **Step 4: Run tests** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/modules/providers/list/claude/claude-fork.provider.ts server/modules/providers/list/claude/tests/claude-fork.provider.test.ts server/modules/providers/index.ts
git commit -m "feat(providers): resume-point lookup for edit-prompt fork"
```

---

### Task 4: SDK option passthrough in `mapCliOptionsToSDK`

**Files:**
- Modify: `server/claude-sdk.js:160-238`
- Test: `server/tests/claude-sdk-fork-options.test.js` (new; plain `node:test`, no `@/` imports needed if we import the function directly)

**Interfaces:**
- Consumes: `options.resumeSessionAt?: string`, `options.forkSession?: boolean` (set by Task 5).
- Produces: `sdkOptions.resumeSessionAt` / `sdkOptions.forkSession` handed to `query()`. `mapCliOptionsToSDK` becomes an export of `server/claude-sdk.js`.

- [ ] **Step 1: Export the function.** Find the export statement at the bottom of `server/claude-sdk.js` (`grep -n "^export" server/claude-sdk.js`) and add `mapCliOptionsToSDK` to it.

- [ ] **Step 2: Write the failing test**

```js
// server/tests/claude-sdk-fork-options.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCliOptionsToSDK } from '../claude-sdk.js';

test('fork options map to resumeSessionAt + forkSession', () => {
  const sdk = mapCliOptionsToSDK({
    sessionId: 'prov-1',
    resumeSessionAt: 'a1',
    forkSession: true,
  });
  assert.equal(sdk.resume, 'prov-1');
  assert.equal(sdk.resumeSessionAt, 'a1');
  assert.equal(sdk.forkSession, true);
});

test('first-prompt fork sets forkSession without resumeSessionAt', () => {
  const sdk = mapCliOptionsToSDK({ sessionId: 'prov-1', forkSession: true });
  assert.equal(sdk.forkSession, true);
  assert.equal('resumeSessionAt' in sdk, false);
});

test('plain resume is untouched (regression)', () => {
  const sdk = mapCliOptionsToSDK({ sessionId: 'prov-1' });
  assert.equal(sdk.resume, 'prov-1');
  assert.equal('forkSession' in sdk, false);
  assert.equal('resumeSessionAt' in sdk, false);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/tests/claude-sdk-fork-options.test.js`
Expected: FAIL (option keys absent / export missing).

- [ ] **Step 4: Implement** — in `mapCliOptionsToSDK`, replace the block at :233-235 with:

```js
  if (sessionId) {
    sdkOptions.resume = sessionId;
    if (options.forkSession) {
      sdkOptions.forkSession = true;
      if (options.resumeSessionAt) {
        sdkOptions.resumeSessionAt = options.resumeSessionAt;
      }
    }
  }
```

- [ ] **Step 5: Run tests** (same command). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/claude-sdk.js server/tests/claude-sdk-fork-options.test.js
git commit -m "feat(chat): pass resumeSessionAt/forkSession through to the Agent SDK"
```

---

### Task 5: Chat gateway — accept `editAtMessageUuid`

**Files:**
- Modify: `server/shared/types.ts:207` area (gateway event kinds union: add `'branch_created'`)
- Modify: `server/modules/websocket/services/chat-websocket.service.ts:141-220` (`handleChatSend`)
- Test: `server/modules/websocket/services/tests/chat-websocket-fork.test.ts` (new; if a tests/ dir with existing service tests exists, follow its bootstrap — check `ls server/modules/websocket/services/tests` and `server/routes/tests/` for the closest mocking pattern)

**Interfaces:**
- Consumes: `findForkResumePoint`/`ForkResumePointError` via the providers barrel `@/modules/providers/index.js`; `chatRunRegistry.startRun` gains a `forkMeta` param (typed in Task 6 — implement Tasks 5+6 together if the type ordering bites; they are split for review only).
- Produces: `runtimeOptions.resumeSessionAt` / `runtimeOptions.forkSession`; `startRun({..., forkMeta})`; protocol error code `'FORK_FAILED'`.

- [ ] **Step 1: Implement the fork branch in `handleChatSend`** — after the `session`/`provider`/`spawnFn` guards (:164-169) and BEFORE `startRun` (:171), insert:

```ts
  const clientOptions = (data.options ?? {}) as AnyRecord;
  const editAtMessageUuid =
    typeof clientOptions.editAtMessageUuid === 'string' && clientOptions.editAtMessageUuid.trim().length > 0
      ? clientOptions.editAtMessageUuid.trim()
      : null;

  let forkResumeSessionAt: string | null = null;
  if (editAtMessageUuid) {
    if (provider !== 'claude') {
      sendProtocolError(ws, 'FORK_FAILED', 'Editing a sent prompt is only supported for Claude sessions.', sessionId);
      return;
    }
    if (!session.provider_session_id || !session.jsonl_path) {
      sendProtocolError(ws, 'FORK_FAILED', 'This session has no transcript to fork yet.', sessionId);
      return;
    }
    try {
      const point = await findForkResumePoint(session.jsonl_path, session.provider_session_id, editAtMessageUuid);
      forkResumeSessionAt = point.resumeSessionAt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendProtocolError(ws, 'FORK_FAILED', `Cannot fork: ${message}`, sessionId);
      return;
    }
  }
```

(Move the existing `const clientOptions = ...` at :189 up into this block — do not declare it twice.)

Then extend `startRun` (:171-177) with fork metadata and `runtimeOptions` (:196-205) with the SDK options:

```ts
  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
    forkMeta: editAtMessageUuid
      ? {
          parentSessionId: sessionId,
          parentProviderSessionId: session.provider_session_id as string,
          forkedAtMessageUuid: editAtMessageUuid,
          projectPath: session.project_path ?? '',
        }
      : undefined,
  });
```

```ts
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    images: filterImagesToUploadStore(clientOptions.images),
    sessionId: session.provider_session_id ?? undefined,
    resume: Boolean(session.provider_session_id),
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
    ...(editAtMessageUuid
      ? { forkSession: true, ...(forkResumeSessionAt ? { resumeSessionAt: forkResumeSessionAt } : {}) }
      : {}),
  };
  delete runtimeOptions.editAtMessageUuid;
```

Import at the top of the file: `import { findForkResumePoint } from '@/modules/providers/index.js';`

In `server/shared/types.ts`, add `| 'branch_created'` next to `| 'session_upserted'` (:207).

- [ ] **Step 2: Write a focused unit test for the option shaping.** If mocking the registry/spawn in the service test is disproportionate, extract the pure part — add to the service file:

```ts
/** Exported for tests: shapes the fork-specific runtime options. */
export function buildForkRuntimeOptions(
  editAtMessageUuid: string | null,
  forkResumeSessionAt: string | null,
): AnyRecord {
  if (!editAtMessageUuid) return {};
  return { forkSession: true, ...(forkResumeSessionAt ? { resumeSessionAt: forkResumeSessionAt } : {}) };
}
```

use it in `runtimeOptions` (`...buildForkRuntimeOptions(editAtMessageUuid, forkResumeSessionAt)`), and test:

```ts
// server/modules/websocket/services/tests/chat-websocket-fork.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildForkRuntimeOptions } from '@/modules/websocket/services/chat-websocket.service.js';

test('fork options include forkSession and optional resumeSessionAt', () => {
  assert.deepEqual(buildForkRuntimeOptions('u2', 'a1'), { forkSession: true, resumeSessionAt: 'a1' });
  assert.deepEqual(buildForkRuntimeOptions('u1', null), { forkSession: true });
  assert.deepEqual(buildForkRuntimeOptions(null, null), {});
});
```

- [ ] **Step 3: Run tests**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/services/tests/chat-websocket-fork.test.ts`
Expected: PASS. Also run `npm run typecheck` — expected clean (Task 6 must land before typecheck passes if `forkMeta` typing complains; in that case commit Tasks 5+6 together).

- [ ] **Step 4: Commit**

```bash
git add server/shared/types.ts server/modules/websocket/services/chat-websocket.service.ts server/modules/websocket/services/tests/chat-websocket-fork.test.ts
git commit -m "feat(chat): accept editAtMessageUuid and shape fork runtime options"
```

---

### Task 6: Run registry — branch row + `branch_created` event

**Files:**
- Modify: `server/modules/websocket/services/chat-run-registry.service.ts` (ChatRun type, `startRun` input, `recordProviderSessionId` :172-197)

**Interfaces:**
- Consumes: `sessionsDb.createForkedSession` (Task 2), `forkMeta` from Task 5.
- Produces: on fork, a NEW app session row; the parent's mapping is NOT overwritten; a `branch_created` gateway event `{ kind: 'branch_created', sessionId: <parent app id>, branchSessionId, forkedAtMessageUuid, seq, timestamp }` is recorded/sent through the run's normal event path.

- [ ] **Step 1: Extend types.** In the ChatRun type/start-input (top of the file), add:

```ts
  forkMeta?: {
    parentSessionId: string;
    parentProviderSessionId: string;
    forkedAtMessageUuid: string;
    projectPath: string;
  };
```

and carry it from `startRun`'s input onto the run object.

- [ ] **Step 2: Branch `recordProviderSessionId`.** Replace the body of `recordProviderSessionId` (:172-197) with:

```ts
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  // Edit-prompt fork: the announced id belongs to a NEW branch session.
  // The parent's app-id → provider-id mapping must stay intact (it still
  // addresses the original transcript), so instead of remapping we insert
  // the branch row and flip the cluster's active leaf.
  if (run.forkMeta && providerSessionId !== run.forkMeta.parentProviderSessionId) {
    try {
      const branchSessionId = sessionsDb.createForkedSession({
        providerSessionId,
        parentSessionId: run.forkMeta.parentSessionId,
        forkedAtMessageUuid: run.forkMeta.forkedAtMessageUuid,
        provider: run.provider,
        projectPath: run.forkMeta.projectPath,
      });
      run.branchSessionId = branchSessionId;

      const event = decorateAndRecordEvent(run, {
        kind: 'branch_created',
        sessionId: run.appSessionId,
        branchSessionId,
        forkedAtMessageUuid: run.forkMeta.forkedAtMessageUuid,
        timestamp: new Date().toISOString(),
      } as unknown as NormalizedMessage);
      if (event && run.connection && run.connection.readyState === WS_OPEN_STATE) {
        run.connection.send(JSON.stringify(event));
      }

      void broadcastCanonicalSessionUpsert(branchSessionId).catch(() => undefined);
      void broadcastCanonicalSessionUpsert(run.forkMeta.parentSessionId).catch(() => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to persist fork branch', {
        appSessionId: run.appSessionId, providerSessionId, error: message,
      });
    }
    return;
  }

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastCanonicalSessionUpsert(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId, providerSessionId, error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId, providerSessionId, error: message,
    });
  }
}
```

Add `branchSessionId?: string;` to the ChatRun type. Adapt the send mechanics to the file's actuals: if the run stores its socket under a different name than `connection`, or events are sent via a shared `sendToRunConnections(run, event)` helper used by the writer, use that instead — the contract is only "the event goes through `decorateAndRecordEvent` (so it gets a `seq` and is replayable) and reaches the client like any other run event."

- [ ] **Step 3: Typecheck + full server test run**

Run: `npm run typecheck && npx tsx --test --tsconfig server/tsconfig.json server/modules/database/tests/sessions-fork.integration.test.ts`
Expected: clean / PASS.

- [ ] **Step 4: Commit**

```bash
git add server/modules/websocket/services/chat-run-registry.service.ts
git commit -m "feat(chat): create fork branch session row and emit branch_created"
```

---

### Task 7: REST — branches list + activate

**Files:**
- Modify: `server/modules/providers/provider.routes.ts` (after the messages route, :629)
- Test: `server/modules/database/tests/sessions-fork.integration.test.ts` (append endpoint-shaping test for the mapper only) — route handlers here are thin; follow existing route tests in `server/routes/tests/` only if an equivalent harness already exists, otherwise cover via the repository tests + manual curl.

**Interfaces:**
- Produces:
  - `GET /api/providers/sessions/:sessionId/branches` → `{ success, data: { branches: [{ sessionId, forkedFromSessionId, forkedAtMessageUuid, createdAt, activeLeaf }] } }` (cluster order; dead-transcript branches filtered; `[]` for never-forked sessions).
  - `POST /api/providers/sessions/:sessionId/activate-branch` → `{ success, data: { session } }`; 404 `AppError` when the session isn't part of a cluster.

- [ ] **Step 1: Implement routes** (imports: `existsSync` from `node:fs`; `sessionsDb` from `@/modules/database/index.js` — both may already be imported):

```ts
router.get(
  '/sessions/:sessionId/branches',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const branches = sessionsDb
      .getClusterBranches(sessionId)
      .filter((row) => !row.jsonl_path || existsSync(row.jsonl_path))
      .map((row) => ({
        sessionId: row.session_id,
        forkedFromSessionId: row.forked_from_session_id,
        forkedAtMessageUuid: row.forked_at_message_uuid,
        createdAt: row.created_at,
        activeLeaf: row.active_leaf === 1,
      }));
    res.json(createApiSuccessResponse({ branches }));
  }),
);

router.post(
  '/sessions/:sessionId/activate-branch',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const session = sessionsDb.activateBranch(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" is not part of a fork cluster.`, {
        code: 'NOT_A_BRANCH',
        statusCode: 404,
      });
    }
    res.json(createApiSuccessResponse({ session }));
  }),
);
```

- [ ] **Step 2: Verify manually against the dev server** (backend restart required — no hot reload):

```bash
TOKEN=<localStorage auth-token or minted JWT>
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/providers/sessions/<some-id>/branches
```

Expected: `{"success":true,"data":{"branches":[]}}` for a normal session.

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/modules/providers/provider.routes.ts
git commit -m "feat(providers): branches list and activate-branch endpoints"
```

---

### Task 8: Frontend realtime — `branch_created` + silent switch on complete

**Files:**
- Modify: `src/components/chat/hooks/useChatRealtimeHandlers.ts` (args interface :20-43, new `case 'branch_created'`, extend `case 'complete'` :228-270, extend `case 'protocol_error'` :144)
- Modify: `src/components/chat/view/ChatInterface.tsx` (wire the two new callbacks)

**Interfaces:**
- Consumes: `branch_created` event `{ sessionId, branchSessionId, forkedAtMessageUuid }`; `protocol_error` with `code === 'FORK_FAILED'`.
- Produces (new hook args): `onBranchCreated?: (parentSessionId: string, branchSessionId: string) => void` — called on `complete` of a run that emitted `branch_created`; `onForkFailed?: (sessionId: string, error: string) => void`.

- [ ] **Step 1: Implement the handler changes.**

Add to the args interface and destructure: `onBranchCreated`, `onForkFailed`.

Inside the hook add a ref: `const pendingBranchRef = useRef<Map<string, string>>(new Map());`

New explicit case (place with the gateway-event cases, BEFORE the store-routing default — the mandatory-explicit-case gotcha):

```ts
        case 'branch_created': {
          // Gateway-only event: never enters the message store.
          const branchId = (msg as unknown as { branchSessionId?: string }).branchSessionId;
          if (sid && branchId) {
            pendingBranchRef.current.set(sid, branchId);
          }
          return;
        }
```

In `case 'complete':`, after the existing `refreshFromServer` block (:265-267) add:

```ts
          const branchId = sid ? pendingBranchRef.current.get(sid) : undefined;
          if (sid && branchId) {
            pendingBranchRef.current.delete(sid);
            void sessionStore.refreshFromServer(branchId);
            onBranchCreated?.(sid, branchId);
          }
```

In `case 'protocol_error':` (:144), add before its existing generic handling:

```ts
          if ((msg as unknown as { code?: string }).code === 'FORK_FAILED') {
            onForkFailed?.(sid ?? '', (msg as unknown as { error?: string }).error ?? 'Fork failed');
          }
```

- [ ] **Step 2: Wire in `ChatInterface.tsx`.** Where the hook is called, pass:

```ts
    onBranchCreated: (_parentId, branchId) => {
      // In-place swap: the branch transcript already contains the copied
      // history, so pointing the view at it is the whole "switch".
      clearForkView();
      sessionStore.setActiveSession(branchId);
      setCurrentSessionId(branchId);
    },
    onForkFailed: (_sid, error) => {
      clearForkView();
      console.error('Fork failed:', error);
    },
```

(`clearForkView`/`setCurrentSessionId` come from `useChatSessionState` — `clearForkView` is added in Task 9; when executing tasks in order, wire `onForkFailed` minimally first and complete it in Task 9.) If the chat view derives everything from `selectedSession`, additionally invoke the same session-selection callback the sidebar uses (find the prop on ChatInterface — e.g. `onSessionSelect` — and call it with the branch session object fetched from `GET /api/providers/sessions/:id/branches`/the `session_upserted` payload).

- [ ] **Step 3: Typecheck + lint** — `npm run typecheck && npm run lint`. Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/hooks/useChatRealtimeHandlers.ts src/components/chat/view/ChatInterface.tsx
git commit -m "feat(chat): handle branch_created and swap to the fork on completion"
```

---

### Task 9: Frontend — ✏️ edit mode, optimistic hide, composer note

**Files:**
- Modify: `src/components/chat/hooks/useChatMessages.ts:66` area (`normalizedToChatMessages`) + the `ChatMessage` type (grep `interface ChatMessage`/`type ChatMessage` under `src/components/chat/types/`)
- Modify: `src/components/chat/view/subcomponents/MessageComponent.tsx` (:27-38 props, :98-106 user bubble controls)
- Modify: `src/components/chat/hooks/useChatComposerState.ts` (edit state + payload, near `editQueuedDraft` :1047 and `handleSubmit` :953-961)
- Modify: `src/components/chat/view/subcomponents/ChatComposer.tsx` (props :57-126, banner region :317-341)
- Modify: `src/components/chat/hooks/useChatSessionState.ts` (fork view-hiding, near :122 and the :272-280 memo)
- Modify: `src/components/chat/view/ChatInterface.tsx` (wiring)

**Interfaces:**
- Consumes: `NormalizedMessage.id` (transcript uuid), Task 8 callbacks.
- Produces:
  - `ChatMessage.uuid?: string`
  - `useChatComposerState`: `editingSentPrompt: { uuid: string; content: string } | null`, `startEditSentPrompt(uuid, content)`, `cancelEditSentPrompt()`; `chat.send` options gain `editAtMessageUuid` when editing.
  - `useChatSessionState`: `beginForkView(uuid: string)`, `clearForkView()` (used by Task 8).
  - `MessageComponent` props: `onEditPrompt?: (message: ChatMessage) => void`, `canEditPrompt?: boolean`.

- [ ] **Step 1: Propagate the uuid.** In `normalizedToChatMessages`, add `uuid: normalized.id` to the produced user/assistant chat message objects, and add `uuid?: string;` to the `ChatMessage` type.

- [ ] **Step 2: Fork view-hiding in `useChatSessionState.ts`.** Add state near :122:

```ts
  const [forkHiddenIds, setForkHiddenIds] = useState<Set<string> | null>(null);
```

In the `chatMessages` memo, apply BEFORE the `viewHiddenCount` slice (:278):

```ts
    let visible = all;
    if (forkHiddenIds && forkHiddenIds.size > 0) {
      visible = visible.filter((m) => !m.uuid || !forkHiddenIds.has(m.uuid));
    }
```

(then apply the existing `viewHiddenCount` logic to `visible`). Add callbacks near `rewindMessages` (:304):

```ts
  /** Optimistically hides the edited prompt and everything after it while the fork runs. */
  const beginForkView = useCallback((uuid: string) => {
    const all = /* the same merged list the memo uses */ chatMessages;
    const idx = all.findIndex((m) => m.uuid === uuid);
    if (idx < 0) return;
    setForkHiddenIds(new Set(all.slice(idx).map((m) => m.uuid).filter((u): u is string => Boolean(u))));
  }, [chatMessages]);
  const clearForkView = useCallback(() => setForkHiddenIds(null), []);
```

Export both from the hook's return object. Note the ID-set approach (NOT `viewHiddenCount`): the count resets whenever store messages change (:265-269), which would un-hide the old tail the moment the new prompt streams in; the ID set survives appends and hides only the pre-fork tail.

- [ ] **Step 3: Composer edit state in `useChatComposerState.ts`.** Next to `editQueuedDraft` (:1047):

```ts
  const [editingSentPrompt, setEditingSentPrompt] = useState<{ uuid: string; content: string } | null>(null);

  const startEditSentPrompt = useCallback((uuid: string, content: string) => {
    setEditingSentPrompt({ uuid, content });
    setInput(content);
    inputValueRef.current = content;
    textareaRef.current?.focus();
  }, []);

  const cancelEditSentPrompt = useCallback(() => {
    setEditingSentPrompt(null);
    setInput('');
    inputValueRef.current = '';
  }, []);
```

In `handleSubmit`'s payload (:953-961) extend options and clear the state after `sendMessage(...)`:

```ts
        options: {
          ...buildSendOptions(messageContent),
          images: uploadedImages,
          ...(editingSentPrompt ? { editAtMessageUuid: editingSentPrompt.uuid } : {}),
        },
```

```ts
      if (editingSentPrompt) {
        onForkSubmitted?.(editingSentPrompt.uuid);
        setEditingSentPrompt(null);
      }
```

Add `onForkSubmitted?: (uuid: string) => void` to the hook's args (ChatInterface passes `beginForkView`). Export `editingSentPrompt`, `startEditSentPrompt`, `cancelEditSentPrompt` from the return object (:1305-1354). ESLint TDZ gotcha: declare the new `useState` ABOVE any `useCallback` that closes over it.

- [ ] **Step 4: ✏️ button in `MessageComponent.tsx`.** Add props `onEditPrompt?: (message: ChatMessage) => void; canEditPrompt?: boolean;`. In the user-bubble controls row (:102-106), next to `MessageCopyControl`:

```tsx
                  {canEditPrompt && message.uuid && onEditPrompt && (
                    <button
                      type="button"
                      onClick={() => onEditPrompt(message)}
                      className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                      title="Edit & fork from here"
                      aria-label="Edit this prompt and fork the conversation"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
```

(`Pencil` from `lucide-react` — match the icon import style already used in the file/siblings.)

- [ ] **Step 5: Composer banner in `ChatComposer.tsx`.** Add props `editingSentPrompt: { uuid: string; content: string } | null; onCancelEditSentPrompt: () => void;`. In the banner region (next to the `queuedDraft` block, :333-341):

```tsx
      {editingSentPrompt && (
        <div className="mx-auto mb-3 max-w-[54.25rem]">
          <Alert>
            <AlertDescription className="flex items-center justify-between gap-2">
              <span>
                Editing a sent prompt — the new branch only rewinds the conversation.
                Code changes after this point are kept (see the Git tab).
              </span>
              <button type="button" onClick={onCancelEditSentPrompt} className="underline">
                Cancel
              </button>
            </AlertDescription>
          </Alert>
        </div>
      )}
```

(`Alert`, `AlertDescription` from `@/shared/view/ui/Alert` — match the import path used by `PermissionRequestsBanner.tssx`.) Localize the two strings through i18next if the file already uses `useTranslation` (check imports; add keys to `src/i18n/` en resource and mirror keys in other locales as untranslated English).

- [ ] **Step 6: Wire in `ChatInterface.tsx`.**

```tsx
  <MessageComponent
    ...
    canEditPrompt={provider === 'claude' && !isProcessingSession}
    onEditPrompt={(m) => m.uuid && startEditSentPrompt(m.uuid, typeof m.content === 'string' ? m.content : '')}
  />
```

(`isProcessingSession` — reuse whatever boolean ChatInterface already derives for "this session is streaming"; grep for the prop feeding the abort button.) Pass `editingSentPrompt`/`onCancelEditSentPrompt={cancelEditSentPrompt}` to `ChatComposer`, `onForkSubmitted={beginForkView}` to `useChatComposerState`, and complete Task 8's `onForkFailed` wiring with `clearForkView()` + keep the composer text (do NOT clear input on failure).

- [ ] **Step 7: Verify** — `npm run typecheck && npm run lint`, then manual: copy changed files to the main checkout, restart dev server, on a Claude session hover a user message → ✏️ appears; Cursor session → no button.

- [ ] **Step 8: Commit**

```bash
git add src/components/chat
git commit -m "feat(chat): edit-sent-prompt mode with optimistic fork view"
```

---

### Task 10: BranchSwitcher `< 1/2 >`

**Files:**
- Create: `src/components/chat/view/subcomponents/BranchSwitcher.tsx`
- Modify: `src/components/chat/view/ChatInterface.tsx` (fetch branches, render switcher under matching user messages)
- Modify: the frontend api util (grep `sessions` in `src/utils/api.*` — add `sessionBranches`, `activateBranch` helpers following its function style)

**Interfaces:**
- Consumes: Task 7 endpoints; `ChatMessage.uuid` (Task 9).
- Produces: `BranchSwitcher({ current, total, onPrev, onNext })` — pure presentational; branch state lives in ChatInterface.

- [ ] **Step 1: Component**

```tsx
// src/components/chat/view/subcomponents/BranchSwitcher.tsx
import { ChevronLeft, ChevronRight } from 'lucide-react';

type BranchSwitcherProps = {
  current: number; // 1-based index of the displayed branch at this fork point
  total: number;
  onPrev: () => void;
  onNext: () => void;
};

export function BranchSwitcher({ current, total, onPrev, onNext }: BranchSwitcherProps) {
  if (total < 2) return null;
  return (
    <div className="mt-1 flex items-center justify-end gap-1 text-xs text-muted-foreground">
      <button type="button" onClick={onPrev} disabled={current <= 1} aria-label="Previous branch"
        className="disabled:opacity-40">
        <ChevronLeft className="h-3 w-3" />
      </button>
      <span>{current}/{total}</span>
      <button type="button" onClick={onNext} disabled={current >= total} aria-label="Next branch"
        className="disabled:opacity-40">
        <ChevronRight className="h-3 w-3" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Branch state in ChatInterface.** On session change (and after `onBranchCreated`), fetch branches:

```ts
  const [branches, setBranches] = useState<Array<{
    sessionId: string; forkedFromSessionId: string | null;
    forkedAtMessageUuid: string | null; createdAt: string; activeLeaf: boolean;
  }>>([]);

  useEffect(() => {
    let cancelled = false;
    if (!currentSessionId) { setBranches([]); return; }
    void api.sessionBranches(currentSessionId).then((rows) => {
      if (!cancelled) setBranches(rows);
    }).catch(() => { if (!cancelled) setBranches([]); });
    return () => { cancelled = true; };
  }, [currentSessionId]);
```

Sibling computation for a user message with uuid `u`: the alternatives at that fork point are the branches with `forkedAtMessageUuid === u` **plus their common parent** (the branch those forks split from, identified by the forks' `forkedFromSessionId`), ordered parent-first then `createdAt`:

```ts
  const siblingsAt = useCallback((uuid: string) => {
    const forks = branches.filter((b) => b.forkedAtMessageUuid === uuid);
    if (forks.length === 0) return [];
    const parentIds = [...new Set(forks.map((b) => b.forkedFromSessionId).filter(Boolean))] as string[];
    const parents = branches.filter((b) => parentIds.includes(b.sessionId));
    return [...parents, ...forks];
  }, [branches]);
```

Render under each user message (same map that renders `MessageComponent`):

```tsx
  {message.uuid && (() => {
    const sibs = siblingsAt(message.uuid);
    const idx = sibs.findIndex((b) => b.sessionId === currentSessionId || b.activeLeaf);
    return (
      <BranchSwitcher
        current={idx + 1}
        total={sibs.length}
        onPrev={() => switchBranch(sibs[idx - 1]?.sessionId)}
        onNext={() => switchBranch(sibs[idx + 1]?.sessionId)}
      />
    );
  })()}
```

```ts
  const switchBranch = useCallback(async (branchSessionId?: string) => {
    if (!branchSessionId) return;
    await api.activateBranch(branchSessionId);
    await sessionStore.refreshFromServer(branchSessionId);
    sessionStore.setActiveSession(branchSessionId);
    setCurrentSessionId(branchSessionId);
    clearForkView();
  }, [sessionStore, setCurrentSessionId, clearForkView]);
```

Subtlety: a switcher shows at message `u` only when the CURRENT branch's transcript still contains a message with uuid `u` — branches that diverged earlier never match, which is exactly the ChatGPT behavior.

- [ ] **Step 3: api helpers** (match the util's existing style):

```ts
  sessionBranches: async (sessionId) =>
    (await authenticatedJson(`/api/providers/sessions/${encodeURIComponent(sessionId)}/branches`)).data.branches,
  activateBranch: async (sessionId) =>
    (await authenticatedJson(`/api/providers/sessions/${encodeURIComponent(sessionId)}/activate-branch`, { method: 'POST' })).data.session,
```

- [ ] **Step 4: Verify** — `npm run typecheck && npm run lint`; manual: after one edit-fork, `< 1/2 >` appears at the fork point; arrows swap the view in place.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat src/utils
git commit -m "feat(chat): branch switcher for forked conversations"
```

---

### Task 11: Sidebar branch badge — ❌ NOT SHIPPED (built, then removed)

> Built during review and then reverted, along with the sidebar branch list.
> Two surfaces counted branches differently — siblings at this anchor vs.
> whole-cluster size — and contradicted each other on screen. The server-side
> `branchCount` and `getForkClusterSizesByProjectPath` described below have
> since been deleted end to end; the `‹ n/total ›` pager on the forked prompt
> is the only branch count that ships. Kept for history — do not implement.

**Files:**
- Modify: the projects module code that maps `sessionsDb` rows into the `/api/projects` session payload (grep `messageCount` or `custom_name` under `server/modules/projects/` to find the mapper) — add `branchCount`.
- Modify: `src/components/.../SidebarSessionItem.tsx:187-191` (next to the messageCount Badge)

**Interfaces:**
- Produces: session payload field `branchCount?: number` (cluster size; `0`/absent for never-forked sessions); a branch badge in the sidebar row.

- [ ] **Step 1: Server** — in the mapper, for rows with `fork_root_session_id`, add:

```ts
    branchCount: row.fork_root_session_id
      ? sessionsDb.getClusterBranches(row.session_id).length
      : 0,
```

(If the mapper is hot-path for large lists, replace with one grouped count query `SELECT fork_root_session_id, COUNT(*) c FROM sessions WHERE fork_root_session_id IS NOT NULL GROUP BY fork_root_session_id` executed once per project load.)

- [ ] **Step 2: Frontend** — in `SidebarSessionItem.tsx` next to the messageCount Badge (:187-191):

```tsx
                {(sessionView.branchCount ?? 0) > 1 && (
                  <Badge variant="outline" className="gap-0.5 px-1 py-0 text-xs" title="Forked conversation">
                    <GitBranch className="h-2.5 w-2.5" />
                    {sessionView.branchCount}
                  </Badge>
                )}
```

(`GitBranch` from `lucide-react`; extend the `SessionWithProvider`/view-model type with `branchCount?: number` where `messageCount` is declared.)

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck && npm run lint`

```bash
git add server/modules/projects src/components
git commit -m "feat(sidebar): branch badge for forked conversation clusters"
```

---

### Task 12: Docs, smoke test, final verification

**Files:**
- Create: `docs/business/capabilities/chat-and-agent-streaming/edit-prompt-fork.md`
- Modify: `docs/business/subsystems/` chat subsystem doc (one bullet referencing the new capability)

- [ ] **Step 1: Capability doc.** `docs/business/**` is hand-authored narrative — read a sibling (e.g. `slash-commands.md`) and follow its exact section structure (Description / Actors / Trigger / Flow / Output / Technical Mapping / Dependencies). Content: user edits a sent prompt (Claude only) → conversation forks in place via Agent SDK `resume + resumeSessionAt + forkSession` → branch switcher; code changes are never reverted (Git panel); fork graph lives in cloudcli SQLite; forks made outside cloudcli appear as ordinary sessions.

- [ ] **Step 2: E2E smoke (manual, dev server :5173).** Checklist:
  1. Claude session: send "Say ONE", then "Say TWO".
  2. Hover prompt 1 → ✏️ → text loads into composer with the Git-note banner → change to "Say THREE" → send.
  3. During stream: old tail hidden, new prompt streaming. After complete: view is the branch; sidebar still shows ONE row (~~branch badge `⑂ 2`~~ — the badge was removed, see Task 11; the row carries no branch affordance at all).
  4. `< 1/2 >` appears at the fork point; `<` restores the original conversation in place; `>` returns.
  5. Cursor/Codex session: no ✏️ on hover.
  6. Kill `claude` binary from PATH temporarily or edit a session whose JSONL was deleted → error toast, old view intact, edited text still in composer.
  7. Two tabs: switching branch in tab A updates tab B's sidebar row.

- [ ] **Step 3: Full verification**

```bash
npm run typecheck && npm run lint && npx tsx --test --tsconfig server/tsconfig.json \
  server/modules/database/tests/ server/modules/providers/list/claude/tests/ \
  server/modules/websocket/services/tests/ server/tests/
```

Expected: all pass, lint clean.

- [ ] **Step 4: Commit**

```bash
git add docs/business
git commit -m "docs(chat): edit-prompt fork capability documentation"
```
