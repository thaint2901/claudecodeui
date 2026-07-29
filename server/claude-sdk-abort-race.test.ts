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
const releaseTerminator = createDeferred();
const releaseResendTerminator = createDeferred();
const releaseResendTurnTwo = createDeferred();

type Frame = Record<string, unknown>;

/**
 * One scripted generator body per `query()` invocation, taken in order. Each
 * test in this file drives a different post-abort ordering, and a pooled
 * session is one `query()` call, so the script has to be per-invocation rather
 * than a single shared body.
 */
const frameScripts: Array<() => AsyncGenerator<Frame>> = [];

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
      const script = frameScripts.shift();
      const generator = (async function* run() {
        for await (const _userMessage of prompt) {
          if (!script) {
            return;
          }
          yield* script();
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

const { queryClaudeSDK, abortClaudeSDKSession, isClaudeSDKSessionActive } = await import('./claude-sdk.js');
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

  frameScripts.push(async function* script() {
    // Announces the provider session id immediately so abortClaudeSDKSession
    // has something to address.
    yield { type: 'system', subtype: 'init', session_id: 'abort-race-provider-1', slash_commands: [] };
    // The CLI has "already sent" task_started at this point in the real world
    // (the OS pipe already has the bytes) — but it is deliberately held back
    // from this iterator until the test explicitly releases it, reproducing
    // the in-flight ordering.
    await releaseTaskStarted.promise;
    yield { type: 'system', subtype: 'task_started', task_id: 'abort-race-task' };
    // The terminator an interrupted turn really does emit — measured in
    // `spikes/streaming-input-mode/interrupt-result.mjs`. It is what settles
    // the turn now that abort no longer settles it itself.
    yield { type: 'result', subtype: 'error_during_execution' };
  });

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

/**
 * Task A / defect A2: `abortClaudeSDKSession` used to settle the turn itself
 * (`claudeSessionPool.settleTurn(poolSessionId, 'aborted')`) on the premise
 * that an interrupted turn emits no terminator. It does emit one — a `result`
 * with `subtype: 'error_during_execution'`, within milliseconds. Settling on
 * abort therefore vacated the turn slot while the CLI was still emitting for
 * that turn, and `SDKResultMessage` carries no turn-correlation field, so the
 * frame that arrived afterwards could not be attributed back: it was dropped
 * by the between-turn sink, or worse, attributed to whatever turn had claimed
 * the slot in the meantime. Abort must now only interrupt; the real terminator
 * settles the turn.
 */
test('abort interrupts the turn but leaves it in flight — its own terminator settles it', async () => {
  claudeSessionPool._resetForTests();
  state.closed = false;
  state.interruptCalls = 0;
  const ws = createFakeWs();

  frameScripts.push(async function* script() {
    yield { type: 'system', subtype: 'init', session_id: 'abort-settle-provider-1', slash_commands: [] };
    yield { type: 'system', subtype: 'task_started', task_id: 'abort-settle-task' };
    await releaseTerminator.promise;
    yield { type: 'result', subtype: 'error_during_execution' };
  });

  let runFinished = false;
  const turnPromise = queryClaudeSDK(
    'work on something long',
    { appSessionId: 'abort-settle-app-1', cwd: os.tmpdir(), images: [], permissionMode: 'bypassPermissions' },
    ws,
  ).then(() => { runFinished = true; });

  await waitFor(() => claudeSessionPool.getLiveTaskIds('abort-settle-app-1').length > 0);

  assert.equal(await abortClaudeSDKSession('abort-settle-provider-1'), true);
  assert.equal(state.interruptCalls, 1);

  // Give the run every chance to finish early. It must not: the turn is still
  // in flight, deliberately holding the slot until the CLI terminates it.
  for (let tick = 0; tick < 50; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runFinished, false, 'abort must not settle the turn — the CLI is still emitting for it');

  releaseTerminator.resolve();
  await turnPromise;
  assert.equal(runFinished, true, 'the CLI\'s own terminator is what settles the aborted turn');

  // The abort path's whole reason for existing: the background task outlives it.
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('abort-settle-app-1'), ['abort-settle-task']);
  assert.equal(state.closed, false, 'aborting a turn must never take the process down');

  // Abort already sent the terminal complete, so the run must not send a second.
  assert.deepEqual(ws.sent.filter((m) => m.kind === 'complete'), []);

  claudeSessionPool.closeSession('abort-settle-app-1');
});

/**
 * Fix-round-1 finding 1, a regression this task's own A4 wait introduced.
 *
 * `activeSessions` is keyed by the PROVIDER-native id and `addSession`
 * overwrites, so both runs of a Stop-then-resend share one key. Because the
 * aborted turn now keeps the slot, run 2 registers its abort handle and then
 * parks inside `runTurn` — and run 1's completion path, which reaches
 * `removeSession(capturedSessionId)` only after that, used to delete the entry
 * unconditionally. It was deleting run 2's handle. The user's re-sent turn was
 * then unstoppable: `abortClaudeSDKSession` found nothing, returned false, and
 * the UI reported "stopped" while the CLI ran the turn to completion.
 *
 * Reachable by construction, not by luck: the client's queued-draft flush fires
 * exactly on `isLoading` -> false, which `handleChatAbort` triggers as soon as
 * the abort returns — i.e. inside the window A4 exists to serve.
 */
test('a run finishing after a Stop-then-resend must not deregister the re-sent run\'s abort handle', async () => {
  claudeSessionPool._resetForTests();
  state.closed = false;
  state.interruptCalls = 0;
  const providerId = 'resend-provider-1';
  const appSessionId = 'resend-app-1';

  // One script closure for the pooled process, branching per turn: the live
  // background task keeps the process alive, so run 2 reuses it.
  frameScripts.push((() => {
    let turn = 0;
    return async function* script() {
      turn += 1;
      if (turn === 1) {
        yield { type: 'system', subtype: 'init', session_id: providerId, slash_commands: [] };
        yield { type: 'system', subtype: 'task_started', task_id: 'resend-task' };
        await releaseResendTerminator.promise;
        yield { type: 'result', subtype: 'error_during_execution' };
      } else {
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the re-sent answer' }] } };
        await releaseResendTurnTwo.promise;
        yield { type: 'result', subtype: 'success' };
      }
    };
  })());

  const wsOne = createFakeWs();
  let runOneFinished = false;
  const runOne = queryClaudeSDK(
    'the first prompt',
    { appSessionId, cwd: os.tmpdir(), images: [], permissionMode: 'bypassPermissions' },
    wsOne,
  ).then(() => { runOneFinished = true; });

  await waitFor(() => claudeSessionPool.getLiveTaskIds(appSessionId).length > 0);

  // Stop. Abort deregisters its own handle (so a second Stop is a no-op) and
  // leaves the turn in flight, holding the slot.
  assert.equal(await abortClaudeSDKSession(providerId), true);
  assert.equal(Boolean(isClaudeSDKSessionActive(providerId)), false);

  // The queued draft flushes. Run 2 registers its handle under the same
  // provider id, then parks on the aborted turn's settlement.
  const wsTwo = createFakeWs();
  const runTwo = queryClaudeSDK(
    'the re-sent prompt',
    { appSessionId, sessionId: providerId, cwd: os.tmpdir(), images: [], permissionMode: 'bypassPermissions' },
    wsTwo,
  );
  await waitFor(() => Boolean(isClaudeSDKSessionActive(providerId)));

  // Turn 1 terminates: run 2 takes the slot and starts streaming, and run 1
  // only now reaches its own cleanup.
  releaseResendTerminator.resolve();
  await waitFor(() => runOneFinished && wsTwo.sent.some((m) => m.kind === 'text'));

  assert.equal(
    Boolean(isClaudeSDKSessionActive(providerId)),
    true,
    'run 1\'s cleanup must not delete an entry that now belongs to run 2',
  );
  assert.equal(
    await abortClaudeSDKSession(providerId),
    true,
    'the re-sent turn must still be stoppable — otherwise the UI says stopped while the CLI keeps going',
  );

  releaseResendTurnTwo.resolve();
  await runOne;
  await runTwo;
  claudeSessionPool.closeSession(appSessionId);
});
