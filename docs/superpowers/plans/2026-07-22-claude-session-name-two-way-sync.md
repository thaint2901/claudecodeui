# Claude Session Name Two-Way Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a session's display name stay consistent between claudecodeui's DB (`sessions.custom_name`) and the native Claude Code CLI (`claude --resume` picker / terminal title), in both directions, for the `claude` provider only.

**Architecture:** Claude Code's own transcript files (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`) are an append-only event log the CLI already uses for naming: `custom-title` / `ai-title` / `last-prompt` events, with "the last such event in the file" as the CLI's own effective title. claudecodeui's synchronizer (`ClaudeSessionSynchronizer`) already knows how to read this, but two bugs block two-way sync:

1. Once `sessions.custom_name` is non-default, `processSessionFile` never looks at the disk again (`claude-session-synchronizer.provider.ts:138-146`) — permanent one-way lock.
2. The rename API (`PUT /sessions/:sessionId`) only writes `sessions.custom_name` in SQLite — it never appends a `custom-title` event to the transcript, so the CLI never learns about a webui rename.

Fix: (a) always re-derive the name from the transcript's latest title-event on every sync pass, falling back to the existing DB value only when the disk has no title event at all, and (b) make the rename API write a `custom-title` event into the session's own transcript via the **official** `renameSession()` function exported by `@anthropic-ai/claude-agent-sdk` (already a dependency — this app already imports `query` from the same package in `server/claude-sdk.js`), so a webui rename becomes indistinguishable from a native CLI rename on the next sync pass.

`renameSession(sessionId, title, options?)` is a public, documented SDK export (confirmed present in the installed `0.3.165` and verified live: it appends `{"type":"custom-title","customTitle":"<title>","sessionId":"<id>"}` to the correct transcript file, resolved by searching `~/.claude/projects/**` for that session id — no manual path bookkeeping needed). Using this instead of hand-rolling a raw `fs.appendFile` avoids depending on undocumented transcript internals ourselves — Anthropic owns keeping this function working across CLI versions. **Known limitation, not fixable from our side:** Claude Code's own `--resume` picker only scans a bounded tail slice of very long transcripts for title events (tracked in multiple open `anthropics/claude-code` issues, e.g. #27202, #33165) — for very long sessions the native CLI picker may still show a stale name even though the event was written correctly and our own web UI reads it fine (we read the whole file, not a tail window). This plan does not attempt to work around that upstream bug.

Because the transcript is append-only and both write paths (`claude -n <name>` / `/rename` and our new write-back) produce the same event shape, "latest event wins" gives correct bidirectional sync with no extra bookkeeping (no timestamps or line-offset tracking needed).

**Tech Stack:** TypeScript (ESM), `@anthropic-ai/claude-agent-sdk` (`renameSession` export, already an installed dependency), `better-sqlite3` (no schema change), Node's built-in `node:test` runner (this repo has no working `vitest.config`, so tests run via `tsx --test`, not `npx vitest run` — see Global Constraints).

## Global Constraints

- Scope is the `claude` provider only. Cursor/Codex/OpenCode keep today's DB-only rename behavior — do not touch their synchronizers, their `IProvider` implementations only pick up the new interface method by simply not implementing it (it's optional).
- No new DB columns/migrations, no new npm dependency (`@anthropic-ai/claude-agent-sdk` is already installed and already used by `server/claude-sdk.js`).
- Run tests with: `npx tsx --test --tsconfig server/tsconfig.json <file path>` (confirmed working in this checkout; `npx vitest run` fails here with `Cannot find package '@/modules/database/index.js'` because there's no vitest alias config — do not use it).
- **Test isolation gotcha (verified by hand, not guesswork):** the existing test pattern in this repo redirects a fake `~/.claude` by monkey-patching `os.homedir()` (`(os as any).homedir = () => fakeHome`). That works for this repo's own code (`claude-session-synchronizer.provider.ts` does `import os from 'node:os'` then calls `os.homedir()` at call time, so the patch applies). It does **NOT** work for the SDK's `renameSession()` — the SDK resolves its config directory via `process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude')` using a **named** `import { homedir } from 'node:os'`, which does not observe a later reassignment of `os.homedir`. Any test that calls `writeBackCustomName`/`renameSession` must set `process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, '.claude')` in addition to (not instead of) the existing `os.homedir()` patch, and restore/delete it in the `finally` block. Both must point at the same directory (`path.join(fakeHome, '.claude')`) so the synchronizer's file-scan and the SDK's `renameSession()` agree on where the transcript lives.
- **Path-encoding gotcha (verified by hand):** Claude Code's on-disk project-directory name replaces **both** `/` and `.` with `-` (e.g. `/home/x/.claude/y` → `-home-x--claude-y`), not just `/`. Any test helper that hand-constructs a project directory path to plant a fake transcript must use `workspacePath.replace(/[/.]/g, '-')`, not `workspacePath.replace(/[/\\]/g, '-')` — the latter silently breaks for any workspace path containing a literal `.` (which `os.tmpdir()`-based paths on Linux happen not to have, so this only bites if a test workspace path contains a dot).
- Follow existing code style exactly: JSDoc-style comments above exported members (see existing file), `@/` aliases for imports, one class per provider-specific file.
- Backend module boundaries: only touch files inside `server/modules/providers/**` and `server/shared/interfaces.ts`; do not add cross-module deep imports.
- Husky/commitlint: commit messages must use one of `build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test`. Attribution trailer is disabled globally — do not add a `Co-Authored-By` line.
- Do not touch `history.jsonl`/`nameMap` priority ordering beyond what's specified in Task 2 — that fallback chain (`ai-title`/`last-prompt`/`custom-title` end-of-file scan, then `history.jsonl` `display`, then existing DB value) is deliberate and existing tests may depend on some of it; only reorder exactly as Task 2 specifies.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/shared/interfaces.ts` | Add optional `writeBackCustomName?(...)` method to `IProviderSessionSynchronizer`. |
| `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts` | Implement `writeBackCustomName` via the SDK's `renameSession()`; fix `processSessionFile` to stop permanently locking the DB name. |
| `server/modules/providers/services/sessions.service.ts` | `renameSessionById` becomes async; after the DB write, best-effort calls the resolved provider's `writeBackCustomName`. |
| `server/modules/providers/provider.routes.ts` | `await` the now-async `renameSessionById` call. |
| `server/modules/providers/tests/claude-sessions.test.ts` (new) | Node-test coverage for both synchronizer behaviors and the write-back method. |
| `server/modules/providers/tests/rename-session.service.test.ts` (new) | Node-test coverage for `sessions.service.renameSessionById` calling write-back through the registry. |

---

### Task 1: Add the optional write-back method to the synchronizer interface

**Files:**
- Modify: `server/shared/interfaces.ts:161-172`

**Interfaces:**
- Produces: `IProviderSessionSynchronizer.writeBackCustomName?(providerSessionId: string, customName: string): Promise<void>` — consumed by Task 3 (`sessions.service.ts`) and implemented by Task 2 (`ClaudeSessionSynchronizer`).

- [ ] **Step 1: Add the method signature**

Open `server/shared/interfaces.ts` and find the `IProviderSessionSynchronizer` interface (currently lines 161-172):

```ts
export interface IProviderSessionSynchronizer {
  /**
   * Scans provider session artifacts and upserts discovered sessions into DB.
   */
  synchronize(since?: Date): Promise<number>;

  /**
   * Parses and upserts one provider artifact file without running a full scan.
   */
  synchronizeFile(filePath: string): Promise<string | null>;
}
```

Replace it with:

```ts
export interface IProviderSessionSynchronizer {
  /**
   * Scans provider session artifacts and upserts discovered sessions into DB.
   */
  synchronize(since?: Date): Promise<number>;

  /**
   * Parses and upserts one provider artifact file without running a full scan.
   */
  synchronizeFile(filePath: string): Promise<string | null>;

  /**
   * Best-effort write-back of a user-set display name into the provider's own
   * on-disk session artifact, so native CLI tooling (e.g. `claude --resume`)
   * reflects the same name the app shows. Providers with no such artifact
   * format simply don't implement this.
   */
  writeBackCustomName?(providerSessionId: string, customName: string): Promise<void>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p server/tsconfig.json`
Expected: no new errors (Cursor/Codex/OpenCode synchronizers don't implement the optional method, which is fine — TypeScript treats `?` methods as optional).

- [ ] **Step 3: Commit**

```bash
git add server/shared/interfaces.ts
git commit -m "feat(providers): add optional write-back hook to session synchronizer interface"
```

---

### Task 2: Fix the Claude synchronizer — stop permanent DB lock, implement write-back via the official SDK rename

**Files:**
- Modify: `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts`
- Test: `server/modules/providers/tests/claude-sessions.test.ts` (new)

**Interfaces:**
- Consumes: `renameSession(sessionId: string, title: string, options?: { dir?: string }): Promise<void>` from `@anthropic-ai/claude-agent-sdk` (existing dependency); existing `sessionsDb`, `buildLookupMap`, `extractFirstValidJsonlData`, `normalizeSessionName`, `readFileTimestamps` from `@/shared/utils.js`.
- Produces: `ClaudeSessionSynchronizer.writeBackCustomName(providerSessionId, customName): Promise<void>` (implements Task 1's interface method). Fixed `processSessionFile` behavior: on every sync pass, the disk-derived name (latest title event, or `history.jsonl` display) wins over a stale DB value; the DB value is used only as a last-resort fallback when disk has nothing.

- [ ] **Step 1: Write the failing tests**

Create `server/modules/providers/tests/claude-sessions.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

/**
 * `renameSession()` from `@anthropic-ai/claude-agent-sdk` resolves its config
 * directory via `process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude')`
 * using a named `import { homedir }` that does NOT observe `patchHomeDir`'s
 * reassignment of `os.homedir`. Tests that exercise `writeBackCustomName`
 * must also set `CLAUDE_CONFIG_DIR` to the same fake `.claude` directory.
 */
const patchClaudeConfigDir = (fakeHomeDir: string) => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(fakeHomeDir, '.claude');
  return () => {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes one Claude transcript file with the given lines, returning its path.
 * `sessionId` and `workspacePath` populate the first line's `sessionId`/`cwd`
 * fields the synchronizer reads to identify the session and its project.
 *
 * The on-disk project directory name replaces BOTH `/` and `.` with `-`
 * (verified against real `~/.claude/projects` entries) — do not simplify
 * this to only replacing path separators.
 */
const writeClaudeTranscript = async (
  homeDir: string,
  sessionId: string,
  workspacePath: string,
  extraLines: Record<string, unknown>[] = []
): Promise<string> => {
  const encodedProjectDir = path.join(homeDir, '.claude', 'projects', workspacePath.replace(/[/.]/g, '-'));
  await mkdir(encodedProjectDir, { recursive: true });

  const lines: string[] = [
    JSON.stringify({ sessionId, cwd: workspacePath, type: 'user', message: { role: 'user', content: 'hello' } }),
    ...extraLines.map((line) => JSON.stringify({ sessionId, ...line })),
  ];

  const filePath = path.join(encodedProjectDir, `${sessionId}.jsonl`);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

test('Claude synchronizer re-syncs a later custom-title event instead of keeping a stale DB name', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-relock-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const filePath = await writeClaudeTranscript(tempRoot, 'claude-1', workspacePath, [
      { type: 'ai-title', aiTitle: 'Fix login bug' },
    ]);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();

      // First pass: picks up the ai-title.
      await synchronizer.synchronize();
      assert.equal(sessionsDb.getSessionByProviderSessionId('claude-1')?.custom_name, 'Fix login bug');

      // User renames natively in the CLI: a new custom-title event is appended.
      await writeFile(filePath, `${JSON.stringify({ sessionId: 'claude-1', type: 'custom-title', customTitle: 'Renamed via CLI' })}\n`, {
        flag: 'a',
      });

      // Second pass must NOT be locked to the old DB value — it must pick up the new event.
      await synchronizer.synchronize();
      assert.equal(sessionsDb.getSessionByProviderSessionId('claude-1')?.custom_name, 'Renamed via CLI');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer falls back to the existing DB name when disk has no title event', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-fallback-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeClaudeTranscript(tempRoot, 'claude-2', workspacePath);

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-2', 'claude', workspacePath);
      sessionsDb.assignProviderSessionId('app-2', 'claude-2');
      sessionsDb.updateSessionCustomName('app-2', 'Manually named in webui');

      const synchronizer = new ClaudeSessionSynchronizer();
      await synchronizer.synchronize();

      // No history.jsonl entry and no title event on disk -> keep the DB value.
      assert.equal(sessionsDb.getSessionById('app-2')?.custom_name, 'Manually named in webui');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer writeBackCustomName appends a custom-title event via renameSession', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-writeback-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreConfigDir = patchClaudeConfigDir(tempRoot);

  try {
    const filePath = await writeClaudeTranscript(tempRoot, '11111111-2222-4333-8444-555555555555', workspacePath);

    const synchronizer = new ClaudeSessionSynchronizer();
    await synchronizer.writeBackCustomName('11111111-2222-4333-8444-555555555555', 'Renamed via webui');

    const contents = await readFile(filePath, 'utf8');
    const lastLine = contents.trim().split('\n').pop()!;
    assert.deepEqual(JSON.parse(lastLine), {
      type: 'custom-title',
      customTitle: 'Renamed via webui',
      sessionId: '11111111-2222-4333-8444-555555555555',
    });
  } finally {
    restoreConfigDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer writeBackCustomName does not throw when the session has no transcript on disk', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-writeback-missing-'));
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreConfigDir = patchClaudeConfigDir(tempRoot);

  try {
    const synchronizer = new ClaudeSessionSynchronizer();
    // No transcript was ever written for this id. Must resolve, not reject.
    await synchronizer.writeBackCustomName('99999999-8888-4777-8666-555555555555', 'Anything');
  } finally {
    restoreConfigDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/providers/tests/claude-sessions.test.ts`
Expected: FAIL — `writeBackCustomName` doesn't exist yet on `ClaudeSessionSynchronizer`, and the "re-syncs a later custom-title event" test fails because the current code keeps the stale `'Fix login bug'` name.

- [ ] **Step 3: Fix `processSessionFile` to stop permanently locking the DB name**

In `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts`, replace the body of `processSessionFile` (currently lines 113-157):

```ts
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name ?? undefined;

    // The transcript is append-only and both a native CLI rename
    // (`claude -n <name>`/`/rename`) and our own write-back path (see
    // `writeBackCustomName`) append the same `custom-title` event shape, so
    // "the latest title event in the file" is always the freshest name
    // regardless of which side produced it. Re-deriving this on every pass
    // (instead of freezing once `custom_name` is set) is what makes renames
    // flow in both directions.
    let sessionName = await this.extractSessionAiTitleFromEnd(filePath, parsed.sessionId);
    if (!sessionName) {
      sessionName = nameMap.get(parsed.sessionId);
    }
    if (!sessionName) {
      sessionName = existingSessionName;
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }
```

Do not change `extractSessionAiTitleFromEnd` (lines 159-200 in the original file) — it already scans backward and returns whichever of `ai-title`/`last-prompt`/`custom-title` occurs last in the file, which is exactly "latest event wins".

- [ ] **Step 4: Implement `writeBackCustomName` using the SDK's `renameSession`**

Add the `renameSession` import at the top of the file:

```ts
import { renameSession } from '@anthropic-ai/claude-agent-sdk';
```

Add the new method to the `ClaudeSessionSynchronizer` class, right after `synchronizeFile` (after the closing brace of the method ending at the original line 108):

```ts
  /**
   * Renames the session's own transcript via the Agent SDK's `renameSession`,
   * so a webui rename becomes visible to native CLI tooling (`claude
   * --resume`, terminal title) the same way `claude -n <name>`/`/rename`
   * would. `renameSession` locates the transcript by searching
   * `~/.claude/projects/**` for the session id, so no jsonl path bookkeeping
   * is needed here.
   *
   * Best-effort: if the session has no transcript on disk yet (e.g. an
   * app-created session that hasn't produced a Claude Code process run yet),
   * `renameSession` rejects and this silently swallows that instead of
   * failing the rename API call — the DB name is the source of truth for
   * the webui regardless of whether the disk write-back succeeded.
   */
  async writeBackCustomName(providerSessionId: string, customName: string): Promise<void> {
    try {
      await renameSession(providerSessionId, customName);
    } catch {
      // Session not found on disk yet, or another transient lookup failure.
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/providers/tests/claude-sessions.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p server/tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/modules/providers/list/claude/claude-session-synchronizer.provider.ts server/modules/providers/tests/claude-sessions.test.ts
git commit -m "fix(providers): stop permanently locking Claude session names, add disk write-back"
```

---

### Task 3: Wire the rename API to call write-back through the provider registry

**Files:**
- Modify: `server/modules/providers/services/sessions.service.ts` (the `renameSessionById` method)
- Modify: `server/modules/providers/provider.routes.ts:580-588`
- Test: `server/modules/providers/tests/rename-session.service.test.ts` (new)

**Interfaces:**
- Consumes: `providerRegistry.resolveProvider(provider: string): IProvider` (existing, already imported in `sessions.service.ts`), `IProvider.sessionSynchronizer.writeBackCustomName?(providerSessionId, customName)` (Task 1/2).
- Produces: `sessionsService.renameSessionById(sessionId: string, summary: string): Promise<{ sessionId: string; summary: string }>` (signature changes from sync to async — same shape otherwise).

- [ ] **Step 1: Write the failing test**

Create `server/modules/providers/tests/rename-session.service.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

// See claude-sessions.test.ts for why both of these patches are required
// together when exercising a path that calls the SDK's `renameSession`.
const patchClaudeConfigDir = (fakeHomeDir: string) => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(fakeHomeDir, '.claude');
  return () => {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'rename-session-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('renameSessionById updates the DB and writes back a custom-title event for Claude sessions', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rename-session-transcript-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreConfigDir = patchClaudeConfigDir(tempRoot);

  try {
    const providerSessionId = '22222222-3333-4444-8555-666666666666';
    const encodedProjectDir = path.join(tempRoot, '.claude', 'projects', workspacePath.replace(/[/.]/g, '-'));
    await mkdir(encodedProjectDir, { recursive: true });
    const transcriptPath = path.join(encodedProjectDir, `${providerSessionId}.jsonl`);
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ sessionId: providerSessionId, cwd: workspacePath, type: 'user' })}\n`,
      'utf8'
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-rename-1', 'claude', workspacePath);
      sessionsDb.assignProviderSessionId('app-rename-1', providerSessionId);
      // Simulate the synchronizer having already indexed the transcript path.
      sessionsDb.createSession(providerSessionId, 'claude', workspacePath, undefined, undefined, undefined, transcriptPath);

      const result = await sessionsService.renameSessionById('app-rename-1', 'New name from webui');

      assert.deepEqual(result, { sessionId: 'app-rename-1', summary: 'New name from webui' });
      assert.equal(sessionsDb.getSessionById('app-rename-1')?.custom_name, 'New name from webui');

      const contents = await readFile(transcriptPath, 'utf8');
      const lastLine = contents.trim().split('\n').pop()!;
      assert.deepEqual(JSON.parse(lastLine), {
        type: 'custom-title',
        customTitle: 'New name from webui',
        sessionId: providerSessionId,
      });
    });
  } finally {
    restoreConfigDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('renameSessionById still succeeds when the session has no transcript on disk', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rename-session-missing-'));
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreConfigDir = patchClaudeConfigDir(tempRoot);

  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-rename-2', 'claude', '/tmp/does-not-matter');
      sessionsDb.assignProviderSessionId('app-rename-2', '33333333-4444-4555-8666-777777777777');

      const result = await sessionsService.renameSessionById('app-rename-2', 'Still renamed');

      assert.deepEqual(result, { sessionId: 'app-rename-2', summary: 'Still renamed' });
      assert.equal(sessionsDb.getSessionById('app-rename-2')?.custom_name, 'Still renamed');
    });
  } finally {
    restoreConfigDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/providers/tests/rename-session.service.test.ts`
Expected: FAIL — `renameSessionById` currently never calls write-back, so the transcript assertion fails.

- [ ] **Step 3: Update `renameSessionById`**

In `server/modules/providers/services/sessions.service.ts`, replace:

```ts
  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
```

with:

```ts
  /**
   * Renames one session by id without requiring the caller to pass provider.
   *
   * Updates the DB immediately, then best-effort writes the name back into
   * the provider's own on-disk session artifact (currently only Claude
   * supports this) so native CLI tooling reflects the same name. A failed
   * write-back (missing transcript, unsupported provider) never fails the
   * rename itself — the DB is the source of truth for the webui regardless.
   */
  async renameSessionById(sessionId: string, summary: string): Promise<{ sessionId: string; summary: string }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);

    const providerSessionId = session.provider_session_id ?? session.session_id;
    const synchronizer = providerRegistry.resolveProvider(session.provider).sessionSynchronizer;
    try {
      await synchronizer.writeBackCustomName?.(providerSessionId, summary);
    } catch (error) {
      console.warn(`Failed to write back session name for "${sessionId}":`, error);
    }

    return { sessionId, summary };
  },
```

- [ ] **Step 4: Update the route to await the now-async call**

In `server/modules/providers/provider.routes.ts`, find (around line 580-588):

```ts
router.put(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const summary = parseSessionRenameSummary(req.body);
    const result = sessionsService.renameSessionById(sessionId, summary);
    res.json(createApiSuccessResponse(result));
  }),
);
```

Replace the `renameSessionById` line with:

```ts
    const result = await sessionsService.renameSessionById(sessionId, summary);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/providers/tests/rename-session.service.test.ts`
Expected: both tests PASS.

- [ ] **Step 6: Run the full provider test suite plus typecheck to catch regressions**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/providers/tests/*.test.ts server/modules/database/tests/*.test.ts`
Expected: all PASS (in particular `codex-sessions.test.ts` and `opencode-sessions.test.ts` must still pass unchanged, confirming other providers are unaffected).

Run: `npx tsc --noEmit -p server/tsconfig.json && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `npx eslint server/`
Expected: no new errors (module-boundary rule: `sessions.service.ts` already imports `providerRegistry` from the same `providers` module, so no boundary violation is introduced).

- [ ] **Step 7: Commit**

```bash
git add server/modules/providers/services/sessions.service.ts server/modules/providers/provider.routes.ts server/modules/providers/tests/rename-session.service.test.ts
git commit -m "feat(providers): write session renames back to the Claude CLI via the Agent SDK"
```

---

### Task 4: Manual end-to-end verification against a real dev server

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev` (or confirm it's already running — see project gotcha: backend does not hot-reload, restart if `server:dev` was already running from before this change).

- [ ] **Step 2: Verify DB → disk direction**

In the webui sidebar, rename an existing real Claude session. Then check its transcript file directly:

```bash
tail -n 1 "$(sqlite3 ~/.cloudcli/auth.db "SELECT jsonl_path FROM sessions WHERE session_id = '<the session id>'")"
```

Expected: last line is `{"type":"custom-title","customTitle":"<the name you typed>","sessionId":"<id>"}`.

- [ ] **Step 3: Verify disk → DB direction**

From a terminal, rename that same session natively: open it interactively (`claude --resume <sessionId>`) and run `/rename Renamed From CLI`, then exit.

Then trigger a resync (either wait for the filesystem watcher, or call the full sync path used by `GET /api/.../sessions` — check `sessions-watcher.service.ts` for how it's normally triggered) and confirm the webui sidebar now shows "Renamed From CLI" for that session.

- [ ] **Step 4: Verify non-Claude providers are unaffected**

Rename a Cursor/Codex/OpenCode session (if any exist locally) through the webui and confirm it still renames successfully (DB-only, no error), since those synchronizers don't implement `writeBackCustomName`.

- [ ] **Step 5: Report results**

Note in the PR description whether steps 2-4 passed as expected. If step 3's `/rename` doesn't appear to update the webui, check whether the session is long enough to have pushed the `custom-title` event out of Claude Code's own tail-window read (a known upstream limitation, not a regression in this change) before treating it as a bug in this change.
