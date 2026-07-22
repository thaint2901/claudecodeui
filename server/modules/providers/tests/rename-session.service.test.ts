import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { patchClaudeConfigDir, patchHomeDir, withIsolatedDatabase } from '@/modules/providers/tests/test-helpers.js';

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
