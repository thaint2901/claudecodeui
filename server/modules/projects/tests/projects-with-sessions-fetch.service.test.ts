import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { getProjectSessionsPage } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-with-sessions-fetch-'));
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

test('getProjectSessionsPage lists one row per fork cluster — the active leaf — plus plain sessions', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('root-s', 'claude', '/workspace/p');
    sessionsDb.createForkedSession({
      providerSessionId: 'branch-1',
      parentSessionId: 'root-s',
      forkedAtMessageUuid: 'u1',
      provider: 'claude',
      projectPath: '/workspace/p',
    });
    sessionsDb.createSession('plain-s', 'claude', '/workspace/p');

    const project = projectsDb.getProjectPath('/workspace/p');
    assert.ok(project);

    const page = await getProjectSessionsPage(project!.project_id, { limit: 10, offset: 0 });
    const byId = new Map(page.sessions.map((session) => [session.id, session]));

    // The deactivated root leaf is hidden from the page entirely (asserted
    // separately in the database-layer tests); only the active leaf and the
    // plain session should be present here.
    assert.deepEqual([...byId.keys()].sort(), ['branch-1', 'plain-s']);
  });
});
