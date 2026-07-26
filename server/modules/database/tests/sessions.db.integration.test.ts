import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
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

test('session archive queries hide archived rows from active project views', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-active', 'claude', '/workspace/demo-project', 'Active Session');
    sessionsDb.createSession('session-archived', 'claude', '/workspace/demo-project', 'Archived Session');
    sessionsDb.updateSessionIsArchived('session-archived', true);

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const activeProjectSessions = sessionsDb.getSessionsByProjectPath('/workspace/demo-project');
    const allProjectSessions = sessionsDb.getSessionsByProjectPathIncludingArchived('/workspace/demo-project');

    assert.deepEqual(activeSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(archivedSessions.map((session) => session.session_id), ['session-archived']);
    assert.deepEqual(activeProjectSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(
      allProjectSessions.map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo-project'), 1);
  });
});

test('createSession reactivates archived rows when the session becomes active again', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.updateSessionIsArchived('session-reused', true);

    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const restoredSession = sessionsDb.getSessionById('session-reused');

    assert.equal(activeSessions.length, 1);
    assert.equal(activeSessions[0]?.session_id, 'session-reused');
    assert.equal(activeSessions[0]?.custom_name, 'Updated Name');
    assert.equal(archivedSessions.length, 0);
    assert.equal(restoredSession?.isArchived, 0);
  });
});

test('repository reads normalize SQLite UTC timestamps to ISO strings', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-timezone', 'claude', '/workspace/demo-project');

    const row = sessionsDb.getSessionById('session-timezone');
    assert.ok(row?.created_at.endsWith('Z'));
    assert.ok(row?.updated_at.endsWith('Z'));
    assert.match(row?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row?.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

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

/**
 * Builds root -> branch-mid -> branch-leaf, with `branch-leaf` holding the
 * cluster's only `active_leaf = 1`. Recency is pinned explicitly: every row is
 * inserted with CURRENT_TIMESTAMP, which has one-second resolution, so without
 * fixed timestamps "the most recently touched survivor" would be decided by
 * whichever tie-break the ids happen to give and the promotion assertions
 * below would pass or fail for the wrong reason.
 */
function createForkClusterOfThree(projectPath: string): void {
  sessionsDb.createSession('root-s', 'claude', projectPath);
  sessionsDb.createForkedSession({
    providerSessionId: 'branch-mid', parentSessionId: 'root-s',
    forkedAtMessageUuid: 'u1', provider: 'claude', projectPath,
  });
  sessionsDb.createForkedSession({
    providerSessionId: 'branch-leaf', parentSessionId: 'branch-mid',
    forkedAtMessageUuid: 'u2', provider: 'claude', projectPath,
  });

  const setUpdatedAt = getConnection().prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?');
  setUpdatedAt.run('2024-01-01 00:00:01', 'root-s');
  setUpdatedAt.run('2024-01-01 00:00:02', 'branch-mid');
  setUpdatedAt.run('2024-01-01 00:00:03', 'branch-leaf');
}

function leafFlagsOf(clusterMemberId: string): Record<string, number> {
  return Object.fromEntries(
    sessionsDb.getClusterBranches(clusterMemberId).map((row) => [row.session_id, row.active_leaf]),
  );
}

// Deleting the branch that happened to carry the leaf flag once wiped the whole
// cluster out of the sidebar: every survivor stayed at 0, both sidebar queries
// filter on the flag, and nothing in the UI could hand it back — the original
// conversation was gone for good. Deleting the leaf has to move the flag to a
// survivor, not just remove it.
test('deleting the cluster leaf promotes the most recent surviving branch', async () => {
  await withIsolatedDatabase(() => {
    createForkClusterOfThree('/workspace/demo-project');

    assert.equal(sessionsDb.deleteSessionById('branch-leaf'), true);

    assert.deepEqual(leafFlagsOf('root-s'), { 'root-s': 0, 'branch-mid': 1 });
  });
});

// Archiving is the soft-delete twin of the case above and orphaned the cluster
// the same way: the archived row is hidden, so its leaf flag no longer counts,
// and the branches left behind were all at 0.
test('archiving the cluster leaf promotes a surviving branch', async () => {
  await withIsolatedDatabase(() => {
    createForkClusterOfThree('/workspace/demo-project');

    sessionsDb.updateSessionIsArchived('branch-leaf', true);

    assert.equal(sessionsDb.getSessionById('branch-mid')?.active_leaf, 1);
    assert.equal(sessionsDb.getSessionById('root-s')?.active_leaf, 0);
  });
});

// The archived row must also drop its OWN flag. Leaving it set is invisible
// while the row is hidden, which is exactly why it survived review once: the
// damage only shows up on restore, when the cluster suddenly has two live
// leaves. Asserted on its own so this half of the fix has a check that no
// amount of correct promotion can keep green.
test('archiving clears the archived row own leaf flag', async () => {
  await withIsolatedDatabase(() => {
    createForkClusterOfThree('/workspace/demo-project');

    sessionsDb.updateSessionIsArchived('branch-leaf', true);

    assert.equal(sessionsDb.getSessionById('branch-leaf')?.active_leaf, 0);
  });
});

// The observable payoff of the two halves together: archive the leaf, restore
// it, and the cluster is still exactly one sidebar row. Before the fix this
// round trip listed both `branch-mid` and `branch-leaf` — one conversation
// permanently fanned out into two entries.
test('archive then restore leaves the cluster with exactly one live leaf', async () => {
  await withIsolatedDatabase(() => {
    createForkClusterOfThree('/workspace/demo-project');

    sessionsDb.updateSessionIsArchived('branch-leaf', true);
    sessionsDb.updateSessionIsArchived('branch-leaf', false);

    const liveLeaves = sessionsDb
      .getClusterBranches('root-s')
      .filter((row) => row.isArchived === 0 && row.active_leaf === 1)
      .map((row) => row.session_id);
    assert.deepEqual(liveLeaves, ['branch-mid']);
    assert.deepEqual(sessionsDb.getSessionsByProjectPathPage('/workspace/demo-project', 10, 0)
      .map((row) => row.session_id), ['branch-mid']);
  });
});

// Restoring into a cluster that has no live leaf at all is the `preferSessionId`
// path: the row the user just clicked "restore" on takes the flag. Without it
// the row leaves the archived list and still never appears in the sidebar, so
// the click looks like it did nothing.
//
// Note: this cannot distinguish "preferred" from "most recent survivor" — the
// only way to reach a leafless cluster through the public API is to archive
// every branch, which leaves the restored row as the sole unarchived candidate
// for both rules. Asserting the outcome the user sees is as far as the public
// API goes; reaching into the helper to prove which branch chose it would be
// testing the implementation, not the behaviour.
test('restoring into a leafless cluster hands the leaf to the restored branch', async () => {
  await withIsolatedDatabase(() => {
    createForkClusterOfThree('/workspace/demo-project');

    sessionsDb.updateSessionIsArchived('branch-leaf', true);
    sessionsDb.updateSessionIsArchived('branch-mid', true);
    sessionsDb.updateSessionIsArchived('root-s', true);
    // Everything is hidden, so no branch holds the flag any more.
    assert.deepEqual(
      sessionsDb.getClusterBranches('root-s').filter((row) => row.active_leaf === 1),
      [],
    );

    // The oldest branch, i.e. not the one plain recency would surface.
    sessionsDb.updateSessionIsArchived('root-s', false);

    assert.deepEqual(leafFlagsOf('root-s'), { 'root-s': 1, 'branch-mid': 0, 'branch-leaf': 0 });
    assert.deepEqual(sessionsDb.getSessionsByProjectPathPage('/workspace/demo-project', 10, 0)
      .map((row) => row.session_id), ['root-s']);
  });
});

// The repair only ever applies to fork clusters. A plain session has no
// `fork_root_session_id`, and neighbouring plain sessions are not siblings of
// anything — deleting or archiving one must not reach over and rewrite another
// row's flag.
test('deleting or archiving a never-forked session promotes nothing', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('plain-a', 'claude', '/workspace/demo-project');
    sessionsDb.createSession('plain-b', 'claude', '/workspace/demo-project');
    sessionsDb.createSession('plain-c', 'claude', '/workspace/demo-project');

    assert.equal(sessionsDb.deleteSessionById('plain-a'), true);
    sessionsDb.updateSessionIsArchived('plain-b', true);

    // Untouched neighbour keeps its own flag; the archived row is not a
    // cluster, so nothing was promoted in its place either.
    assert.equal(sessionsDb.getSessionById('plain-c')?.active_leaf, 1);
    assert.equal(sessionsDb.getSessionById('plain-b')?.fork_root_session_id, null);
    assert.deepEqual(sessionsDb.getClusterBranches('plain-c'), []);
  });
});
