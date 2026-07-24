import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Run with: npx tsx --test --experimental-test-module-mocks --tsconfig server/tsconfig.json <path>
// `mock.module` (used below) throws `TypeError: mock.module is not a function`
// under plain `node --test`/`tsx --test` without the `--experimental-test-module-mocks`
// flag (Node 24+).
//
// The fork transcript is a verbatim copy of the parent's history, so the
// sessions-watcher sync would otherwise pick up the parent's inherited title
// event and clobber the " (fork)" suffix `handleChatSend` sets on the fork's
// row. These tests drive the real `/fork` handler end-to-end (mocking only
// the database and provider-registry boundaries chat-websocket.service.ts
// hard-imports) and assert the handler writes the fork's own name back
// through `sessionsService.renameSessionById` — the call that appends a
// `custom-title` event to the fork's transcript so every later sync keeps
// this name — as soon as the fork's own provider session id is announced,
// not only after the whole run finishes.
const PARENT_SESSION_ID = 'parent-session-id';
const PARENT_CUSTOM_NAME = 'whoami. check it using subagent to run the bash command';
const FORKED_APP_SESSION_ID = 'forked-app-session-id';
const FORKED_PROVIDER_SESSION_ID = 'forked-provider-session-id';

const parentSessionRow = {
  session_id: PARENT_SESSION_ID,
  provider: 'claude',
  provider_session_id: 'parent-provider-session-id',
  project_path: '/tmp/project',
  jsonl_path: null,
  custom_name: PARENT_CUSTOM_NAME,
  isArchived: false,
  created_at: null,
  updated_at: null,
};

const renameCalls: Array<{ sessionId: string; summary: string }> = [];
const updateCustomNameCalls: Array<{ sessionId: string; customName: string }> = [];
// Toggled per test to make the mocked rename report success/failure.
let renameWriteBackResult = true;

// Auto-no-op stand-in for the repositories this test never touches — the
// database barrel re-exports many repos, and `mock.module`'s `namedExports`
// must supply every export the transitive import graph reads, not just the
// two this test cares about.
const noopRepo = new Proxy({}, { get: () => () => undefined });

mock.module('@/modules/database/index.js', {
  namedExports: {
    initializeDatabase: () => {},
    closeConnection: () => {},
    getConnection: () => {},
    getDatabasePath: () => '',
    apiKeysDb: noopRepo,
    appConfigDb: noopRepo,
    credentialsDb: noopRepo,
    githubTokensDb: noopRepo,
    notificationChannelEndpointsDb: noopRepo,
    notificationPreferencesDb: noopRepo,
    pushSubscriptionsDb: noopRepo,
    scanStateDb: noopRepo,
    userDb: noopRepo,
    vapidKeysDb: noopRepo,
    sessionsDb: {
      getSessionById: (sessionId: string) => (sessionId === PARENT_SESSION_ID ? parentSessionRow : null),
      updateSessionCustomName: (sessionId: string, customName: string) => {
        updateCustomNameCalls.push({ sessionId, customName });
      },
      assignProviderSessionId: () => {},
    },
    projectsDb: {
      getProjectPath: () => null,
    },
  },
});

mock.module('@/modules/providers/index.js', {
  namedExports: {
    sessionSynchronizerService: noopRepo,
    providerSkillsService: noopRepo,
    providerMcpService: noopRepo,
    initializeSessionsWatcher: () => {},
    closeSessionsWatcher: () => {},
    initializeSessionLockWatcher: () => {},
    shutdownSessionLockWatcher: () => {},
    getLockedBgSessionIds: () => [],
    sessionLockWatcherService: noopRepo,
    closeSessionLockWatcher: () => {},
    sessionsService: {
      createAppSession: () => ({ sessionId: FORKED_APP_SESSION_ID }),
      renameSessionById: async (sessionId: string, summary: string) => {
        renameCalls.push({ sessionId, summary });
        return { sessionId, summary, writeBack: renameWriteBackResult };
      },
    },
  },
});

const { handleChatConnection } = await import('../services/chat-websocket.service.js');

function createFakeWs() {
  const emitter = new EventEmitter();
  const sent: string[] = [];
  const ws = Object.assign(emitter, {
    readyState: 1,
    send: (payload: string) => sent.push(payload),
  });
  return { ws: ws as unknown as Parameters<typeof handleChatConnection>[0], sent };
}

test('/fork writes the fork name back as soon as the fork announces its own provider session id', async () => {
  renameWriteBackResult = true;
  renameCalls.length = 0;
  updateCustomNameCalls.length = 0;

  const { ws } = createFakeWs();
  let resolveSpawn: () => void = () => {};
  const spawnCalled = new Promise<void>((resolve) => {
    resolveSpawn = resolve;
  });

  handleChatConnection(ws, { user: { id: 'user-1' } } as any, {
    spawnFns: {
      claude: async (_command: unknown, _options: unknown, writer: { setSessionId: (id: string) => void }) => {
        // Simulate the SDK announcing the fork's own (distinct) provider
        // session id mid-run, the way `claude-sdk.js`'s recapture branch does
        // via `ws.setSessionId(...)`. The rename must fire from this
        // announcement, not from the spawnFn's eventual resolution below.
        writer.setSessionId(FORKED_PROVIDER_SESSION_ID);
        assert.equal(renameCalls.length, 1, 'rename must happen synchronously with the announcement, before spawnFn resolves');
        resolveSpawn();
      },
    } as any,
    abortFns: {} as any,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  });

  (ws as unknown as EventEmitter).emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'chat.send', sessionId: PARENT_SESSION_ID, content: '/fork' }))
  );

  await spawnCalled;
  // Let the post-spawn continuation (which awaits the announcement-time
  // rename promise) run to completion.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(updateCustomNameCalls.length, 1);
  assert.equal(updateCustomNameCalls[0]?.sessionId, FORKED_APP_SESSION_ID);
  assert.equal(updateCustomNameCalls[0]?.customName, `${PARENT_CUSTOM_NAME} (fork)`);

  // Exactly one rename call: the announcement-time write-back succeeded, so
  // the post-spawn retry must not fire a second one.
  assert.equal(renameCalls.length, 1);
  assert.equal(renameCalls[0]?.sessionId, FORKED_APP_SESSION_ID);
  assert.equal(renameCalls[0]?.summary, `${PARENT_CUSTOM_NAME} (fork)`);
});

test('/fork retries the write-back after spawn resolves when the announcement never fires', async () => {
  renameWriteBackResult = true;
  renameCalls.length = 0;
  updateCustomNameCalls.length = 0;

  const { ws } = createFakeWs();
  let resolveSpawn: () => void = () => {};
  const spawnCalled = new Promise<void>((resolve) => {
    resolveSpawn = resolve;
  });

  handleChatConnection(ws, { user: { id: 'user-1' } } as any, {
    spawnFns: {
      // Never calls writer.setSessionId — the run completes without ever
      // announcing a distinct provider session id.
      claude: async () => {
        resolveSpawn();
      },
    } as any,
    abortFns: {} as any,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  });

  (ws as unknown as EventEmitter).emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'chat.send', sessionId: PARENT_SESSION_ID, content: '/fork' }))
  );

  await spawnCalled;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(renameCalls.length, 1);
  assert.equal(renameCalls[0]?.sessionId, FORKED_APP_SESSION_ID);
  assert.equal(renameCalls[0]?.summary, `${PARENT_CUSTOM_NAME} (fork)`);
});

test('/fork surfaces a task_notification when both the announcement-time and retry write-backs fail', async () => {
  renameWriteBackResult = false;
  renameCalls.length = 0;
  updateCustomNameCalls.length = 0;

  const { ws, sent } = createFakeWs();
  let resolveSpawn: () => void = () => {};
  const spawnCalled = new Promise<void>((resolve) => {
    resolveSpawn = resolve;
  });

  handleChatConnection(ws, { user: { id: 'user-1' } } as any, {
    spawnFns: {
      claude: async (_command: unknown, _options: unknown, writer: { setSessionId: (id: string) => void }) => {
        writer.setSessionId(FORKED_PROVIDER_SESSION_ID);
        resolveSpawn();
      },
    } as any,
    abortFns: {} as any,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  });

  (ws as unknown as EventEmitter).emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'chat.send', sessionId: PARENT_SESSION_ID, content: '/fork' }))
  );

  await spawnCalled;
  await new Promise((resolve) => setImmediate(resolve));

  // Announcement-time attempt, then the post-spawn retry — both fail.
  assert.equal(renameCalls.length, 2);

  const warnNotification = sent
    .map((payload) => JSON.parse(payload))
    .find((message) => message.kind === 'task_notification' && /may not persist/.test(message.summary ?? ''));
  assert.ok(warnNotification, 'expected a task_notification warning about the write-back failure');
});
