import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
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

test('activateBranch on a never-forked session returns null and leaves active_leaf untouched', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('plain', 'claude', '/workspace/p');
    assert.equal(sessionsDb.activateBranch('plain'), null);
    assert.equal(sessionsDb.getSessionById('plain')?.active_leaf, 1);
  });
});

test('activateBranch on a nonexistent session id returns null', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(sessionsDb.activateBranch('does-not-exist'), null);
  });
});

test('createForkedSession with a nonexistent parent throws and leaves no partial state', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => {
        sessionsDb.createForkedSession({
          providerSessionId: 'orphan-branch',
          parentSessionId: 'no-such-parent',
          forkedAtMessageUuid: 'uuid-msg-x',
          provider: 'claude',
          projectPath: '/workspace/p',
          jsonlPath: null,
        });
      },
      /not found/,
    );
    assert.equal(sessionsDb.getSessionById('orphan-branch'), null);
  });
});
