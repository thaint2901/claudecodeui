import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// The fork transcript is a verbatim copy of the parent's history, so the
// sessions-watcher sync would otherwise pick up the parent's inherited title
// event and clobber the " (fork)" suffix `handleChatSend` sets on the fork's
// row. This test drives the real `/fork` handler end-to-end (mocking only the
// database and provider-registry boundaries chat-websocket.service.ts hard-
// imports) and asserts the handler writes the fork's own name back through
// `sessionsService.renameSessionById` — the call that appends a `custom-title`
// event to the fork's transcript so every later sync keeps this name.
const PARENT_SESSION_ID = 'parent-session-id';
const PARENT_CUSTOM_NAME = 'whoami. check it using subagent to run the bash command';
const FORKED_APP_SESSION_ID = 'forked-app-session-id';

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
        return { sessionId, summary };
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

test('/fork writes the fork name back into the transcript after spawn resolves', async () => {
  const { ws } = createFakeWs();
  let resolveSpawn: () => void = () => {};
  const spawnCalled = new Promise<void>((resolve) => {
    resolveSpawn = resolve;
  });

  handleChatConnection(ws, { user: { id: 'user-1' } } as any, {
    spawnFns: {
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
  // The write-back happens right after the awaited spawnFn resolves, inside
  // the same async message handler; yield a tick so that continuation runs.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(updateCustomNameCalls.length, 1);
  assert.equal(updateCustomNameCalls[0]?.sessionId, FORKED_APP_SESSION_ID);
  assert.equal(updateCustomNameCalls[0]?.customName, `${PARENT_CUSTOM_NAME} (fork)`);

  assert.equal(renameCalls.length, 1);
  assert.equal(renameCalls[0]?.sessionId, FORKED_APP_SESSION_ID);
  assert.equal(renameCalls[0]?.summary, `${PARENT_CUSTOM_NAME} (fork)`);
});
