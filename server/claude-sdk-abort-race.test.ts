import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Run with: npx tsx --test --experimental-test-module-mocks --tsconfig server/tsconfig.json <path>
// `mock.module` throws `TypeError: mock.module is not a function` under plain
// `tsx --test` without `--experimental-test-module-mocks` (Node 24+).
//
// Fix-round-1 regression guard: a `task_started` message the fake CLI has
// already decided to send, but which the pool's drain loop has not yet
// routed, must not be lost to a premature close driven by
// `abortClaudeSDKSession`. The existing scripted-message tests in
// `claude-session-pool.test.js` cannot exercise this — they only prove the
// pool's own primitives (`settleTurn`, `getLiveTaskIds`, `closeSession`)
// behave correctly in isolation, each of which IS correct on its own. The
// bug was in how the OLD `abortClaudeSDKSession` composed them: a
// synchronous `getLiveTaskIds(...).length === 0 -> closeSession(...)` check
// performed from OUTSIDE the drain loop, which can only ever see a
// stale/incomplete snapshot. This test drives `queryClaudeSDK` and
// `abortClaudeSDKSession` for real (mocking only the SDK's `query()`, which
// would otherwise spawn a real CLI process) and deliberately holds the
// `task_started` message back — releasing it only AFTER
// `abortClaudeSDKSession` has already returned — to force exactly the
// ordering the reviewer flagged, deterministically rather than hoping for a
// particular microtask interleaving.

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const state = { closed: false, interruptCalls: 0 };
const releaseTaskStarted = createDeferred();

// Other modules in the transitive import graph (e.g. the session
// synchronizer provider) import OTHER named exports from this same package
// (`renameSession`, `listSessions`, ...) — `mock.module`'s `namedExports`
// replaces the whole module, so the real exports must be spread through and
// only `query` overridden, or those imports fail at load time.
const realSdk = await import('@anthropic-ai/claude-agent-sdk');

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    ...realSdk,
    query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const generator = (async function* run() {
        for await (const _userMessage of prompt) {
          // Announces the provider session id immediately so
          // abortClaudeSDKSession has something to address.
          yield { type: 'system', subtype: 'init', session_id: 'abort-race-provider-1', slash_commands: [] };
          // The CLI has "already sent" task_started at this point in the real
          // world (the OS pipe already has the bytes) — but it is
          // deliberately held back from this iterator until the test
          // explicitly releases it, reproducing the in-flight ordering.
          await releaseTaskStarted.promise;
          yield { type: 'system', subtype: 'task_started', task_id: 'abort-race-task' };
          // No `result` — matches an interrupted turn (spike-verified).
        }
      })();
      (generator as unknown as { interrupt: () => Promise<void> }).interrupt = async () => {
        state.interruptCalls += 1;
      };
      (generator as unknown as { close: () => void }).close = () => {
        state.closed = true;
      };
      return generator;
    },
  },
});

process.env.DATABASE_PATH = path.join(os.tmpdir(), `claude-sdk-abort-race-${process.pid}.db`);
const { initializeDatabase } = await import('@/modules/database/index.js');
initializeDatabase();

const { queryClaudeSDK, abortClaudeSDKSession } = await import('./claude-sdk.js');
const { claudeSessionPool } = await import('./claude-session-pool.js');

function createFakeWs() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    userId: null,
    isWebSocketWriter: true,
    send: (msg: Record<string, unknown>) => sent.push(msg),
    sent,
  };
}

async function waitFor(predicate: () => boolean, { maxTicks = 2000 } = {}): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (predicate()) {
      return;
    }
    // Real fs I/O (loadMcpConfig, provider-model cache reads) needs actual
    // event-loop turns, not just microtasks — setImmediate yields to those.
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition did not become true in time');
}

test('abort must not close a session while a task_started message is still in flight, unrouted', async () => {
  claudeSessionPool._resetForTests();
  const ws = createFakeWs();

  const turnPromise = queryClaudeSDK(
    'start something in the background',
    { appSessionId: 'abort-race-app-1', cwd: os.tmpdir(), images: [], permissionMode: 'bypassPermissions' },
    ws,
  );

  // Wait for the session to register: handleSdkMessage captures the
  // provider session id from the `init` message and announces
  // `session_created`.
  await waitFor(() => ws.sent.some((m) => m.kind === 'session_created'));

  const aborted = await abortClaudeSDKSession('abort-race-provider-1');
  assert.equal(aborted, true);
  assert.equal(state.interruptCalls, 1);

  // At this exact point task_started has NOT been released — this is the
  // moment the OLD code's synchronous `getLiveTaskIds().length === 0 ->
  // closeSession()` check would have run, and it would have read empty.
  assert.equal(
    claudeSessionPool.getLiveTaskIds('abort-race-app-1').length,
    0,
    'the message genuinely has not been routed yet — a synchronous check here is provably stale',
  );
  assert.equal(
    state.closed,
    false,
    'abort must not have closed the process based on that stale/empty read',
  );

  // Now let the "in flight" message actually arrive at the pool's drain loop.
  releaseTaskStarted.resolve();
  await waitFor(() => claudeSessionPool.getLiveTaskIds('abort-race-app-1').length > 0);

  assert.deepEqual(claudeSessionPool.getLiveTaskIds('abort-race-app-1'), ['abort-race-task']);
  assert.equal(
    state.closed,
    false,
    'the task that just registered must not have been killed by the earlier abort',
  );

  await turnPromise;
  claudeSessionPool.closeSession('abort-race-app-1');
  assert.equal(state.closed, true, 'explicit close must still work once the caller is done with it');
});
