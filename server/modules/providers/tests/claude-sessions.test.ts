import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { patchClaudeConfigDir, patchHomeDir, withIsolatedDatabase } from '@/modules/providers/tests/test-helpers.js';
import type { ProviderSessionId } from '@/shared/types.js';

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

test('Claude synchronizer uses history.jsonl display as a fallback name when disk has no title event but the DB has none either', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-namemap-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // No custom-title/ai-title/last-prompt event on disk for this session,
    // so processSessionFile's first fallback tier (disk-derived) yields
    // nothing and must fall through to history.jsonl's `display` field.
    await writeClaudeTranscript(tempRoot, 'claude-namemap-1', workspacePath);
    await mkdir(path.join(tempRoot, '.claude'), { recursive: true });
    await writeFile(
      path.join(tempRoot, '.claude', 'history.jsonl'),
      `${JSON.stringify({ sessionId: 'claude-namemap-1', display: 'First prompt from history.jsonl' })}\n`,
      'utf8'
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(
        sessionsDb.getSessionByProviderSessionId('claude-namemap-1')?.custom_name,
        'First prompt from history.jsonl'
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer keeps a custom-title as sticky even when a later last-prompt event is appended', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-sticky-lastprompt-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeClaudeTranscript(tempRoot, 'claude-sticky-1', workspacePath, [
      { type: 'custom-title', customTitle: 'Renamed via CLI' },
      { type: 'last-prompt', lastPrompt: 'what is the weather today' },
    ]);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionByProviderSessionId('claude-sticky-1')?.custom_name, 'Renamed via CLI');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer keeps a custom-title as sticky even when a later ai-title event is appended', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-sticky-aititle-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeClaudeTranscript(tempRoot, 'claude-sticky-2', workspacePath, [
      { type: 'custom-title', customTitle: 'Renamed via CLI' },
      { type: 'ai-title', aiTitle: 'Fix login bug' },
    ]);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionByProviderSessionId('claude-sticky-2')?.custom_name, 'Renamed via CLI');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer keeps a custom-title as sticky even when it sits outside the tail-scan byte budget', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-sticky-large-file-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // Padding pushes the custom-title event (written before it) outside the
    // synchronizer's tail-scan fast path (65536 bytes), so this only passes
    // if the full-scan fallback for custom-title actually runs.
    const filler = 'x'.repeat(80_000);
    await writeClaudeTranscript(tempRoot, 'claude-sticky-large-1', workspacePath, [
      { type: 'custom-title', customTitle: 'Renamed via CLI' },
      { type: 'last-prompt', lastPrompt: filler },
    ]);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionByProviderSessionId('claude-sticky-large-1')?.custom_name, 'Renamed via CLI');
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
    const providerSessionId = '11111111-2222-4333-8444-555555555555' as ProviderSessionId;
    const filePath = await writeClaudeTranscript(tempRoot, providerSessionId, workspacePath);

    const synchronizer = new ClaudeSessionSynchronizer();
    await synchronizer.writeBackCustomName(providerSessionId, 'Renamed via webui');

    const contents = await readFile(filePath, 'utf8');
    const lastLine = contents.trim().split('\n').pop()!;
    assert.deepEqual(JSON.parse(lastLine), {
      type: 'custom-title',
      customTitle: 'Renamed via webui',
      sessionId: providerSessionId,
    });
  } finally {
    restoreConfigDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer writeBackCustomName scopes the lookup to projectPath when provided', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-writeback-scoped-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreConfigDir = patchClaudeConfigDir(tempRoot);

  try {
    const providerSessionId = '22222222-3333-4444-8555-666666666666' as ProviderSessionId;
    const filePath = await writeClaudeTranscript(tempRoot, providerSessionId, workspacePath);

    const synchronizer = new ClaudeSessionSynchronizer();
    // Passing the project path should scope renameSession's lookup instead
    // of searching every project under CLAUDE_CONFIG_DIR/projects.
    await synchronizer.writeBackCustomName(providerSessionId, 'Renamed with scoped dir', workspacePath);

    const contents = await readFile(filePath, 'utf8');
    const lastLine = contents.trim().split('\n').pop()!;
    assert.deepEqual(JSON.parse(lastLine), {
      type: 'custom-title',
      customTitle: 'Renamed with scoped dir',
      sessionId: providerSessionId,
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
    await synchronizer.writeBackCustomName('99999999-8888-4777-8666-555555555555' as ProviderSessionId, 'Anything');
  } finally {
    restoreConfigDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
