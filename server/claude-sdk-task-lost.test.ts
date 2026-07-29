import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Run with:
//   npx tsx --test --experimental-test-module-mocks --tsconfig server/tsconfig.json \
//     server/claude-sdk-task-lost.test.ts
// (`mock.module` throws `TypeError: mock.module is not a function` without the
// flag on Node 24+.)
//
// Final-review CRITICAL: a pooled CLI process that dies BETWEEN turns took every
// background task it was running with it and told nobody. `claude-session-pool`'s
// own tests prove the pool now calls `onTaskLost`, which is a different claim
// from "the user is told": the transport lives on the other side of the pool's
// deliberate ignorance of websockets, so a missing `onTaskLost:` line in
// `queryClaudeSDK` would leave every one of those tests green and production
// silent. This drives `queryClaudeSDK` for real (mocking only the SDK's
// `query()`, which would otherwise spawn a CLI) and asserts on the frame that
// actually reaches a connected client.

const state = { closed: false };

type Frame = Record<string, unknown>;

const frameScripts: Array<() => AsyncGenerator<Frame>> = [];

// `mock.module`'s `namedExports` replaces the whole module, so the real exports
// must be spread through — other modules in the import graph use them.
const realSdk = await import('@anthropic-ai/claude-agent-sdk');

const { mock } = await import('node:test');

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
      (generator as unknown as { interrupt: () => Promise<void> }).interrupt = async () => {};
      (generator as unknown as { close: () => void }).close = () => {
        state.closed = true;
      };
      return generator;
    },
  },
});

process.env.DATABASE_PATH = path.join(os.tmpdir(), `claude-sdk-task-lost-${process.pid}.db`);
const { initializeDatabase, userDb } = await import('@/modules/database/index.js');
initializeDatabase();

// The owner-scoped tests below hand `queryClaudeSDK` a real user id, and the
// run-stopped notification it emits at the end of a turn reads that user's
// notification preferences — an id with no `users` row fails the FK constraint
// and the throw escapes the run. Two rows so "the other user" is a real one.
const OWNER_USER_ID = Number(userDb.createUser('task-owner', 'x').id);
const OTHER_USER_ID = Number(userDb.createUser('task-bystander', 'x').id);

const { connectedClients, WS_OPEN_STATE } = await import('@/modules/websocket/index.js');
const { queryClaudeSDK } = await import('./claude-sdk.js');
const { claudeSessionPool } = await import('./claude-session-pool.js');

function createFakeWs(userId: string | number | null = null) {
  const sent: Array<Record<string, unknown>> = [];
  return {
    userId,
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
    // event-loop turns, not just microtasks.
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition did not become true in time');
}

test('a background task lost with the CLI process reaches the client as a failed event with no output path', async () => {
  claudeSessionPool._resetForTests();
  const ws = createFakeWs();

  // `emitBackgroundTaskEvent` fans out to every connected client (a background
  // task outlives the turn that started it, so it has no run writer to ride on).
  const frames: Frame[] = [];
  const client = {
    readyState: WS_OPEN_STATE,
    send: (data: string) => { frames.push(JSON.parse(data) as Frame); },
  };
  connectedClients.add(client);

  frameScripts.push(async function* script() {
    yield { type: 'system', subtype: 'init', session_id: 'task-lost-provider-1', slash_commands: [] };
    yield {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-lost-1',
      description: 'Echo t1-t10 with delays',
    };
    yield { type: 'result', subtype: 'success' };
    // The turn is over and the process is still held open for the task above —
    // then it dies. This is the window the whole fix is about.
    throw new Error('CLI process exited unexpectedly (simulated OOM kill)');
  });

  try {
    await queryClaudeSDK(
      'start something in the background',
      { appSessionId: 'task-lost-app-1', cwd: os.tmpdir(), images: [], permissionMode: 'bypassPermissions' },
      ws,
    );

    await waitFor(() => frames.some((frame) => frame.kind === 'background_task'));
    const frame = frames.find((f) => f.kind === 'background_task') as Frame;

    assert.equal(frame.sessionId, 'task-lost-app-1', 'the app session id, never the provider-native one');
    assert.equal(frame.taskId, 'task-lost-1');
    assert.equal(frame.status, 'failed', 'a task killed with its process did not complete');
    assert.match(
      String(frame.summary),
      /Echo t1-t10 with delays/,
      'the row must say WHICH task was lost',
    );
    assert.match(
      String(frame.summary),
      /ended before this task reported a result/,
      'and plainly why, rather than reading as a normal completion',
    );
    // Only `task_notification` carries an output path; `task_started` does not,
    // and a task lost this way never wrote one.
    assert.equal(
      Object.hasOwn(frame, 'outputFile'),
      false,
      'no invented path, and no empty string pretending to be one',
    );
  } finally {
    connectedClients.delete(client);
    claudeSessionPool._resetForTests();
  }
});

// Same boundary argument as the test above, for the other report the pool
// cannot deliver itself: the pool proves it calls `onHoldWarning`, which is not
// the same claim as "the user is told". A missing `onHoldWarning:` line in
// `queryClaudeSDK` would leave every pool test green and production silent, and
// this is also the only place the advisory's `status` value on the wire can be
// pinned down — the frontend fails an unrecognised status toward "not a
// success", so the two sides have to agree here or a still-running task renders
// as a failure.
test('a task still holding the CLI process open past ten minutes reaches the client as an advisory, not an outcome', async (t) => {
  claudeSessionPool._resetForTests();
  // Only the two APIs the hold check itself uses. `setTimeout`/`setImmediate`
  // stay real so the run's own fs I/O and the pool's async draining behave
  // normally, and `now` starts at the real clock so nothing under test sees a
  // 1970 timestamp.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const ws = createFakeWs();

  const frames: Frame[] = [];
  const client = {
    readyState: WS_OPEN_STATE,
    send: (data: string) => { frames.push(JSON.parse(data) as Frame); },
  };
  connectedClients.add(client);

  frameScripts.push(async function* script() {
    yield { type: 'system', subtype: 'init', session_id: 'task-held-provider-1', slash_commands: [] };
    yield {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-held-1',
      description: 'Echo t1-t10 with delays',
    };
    yield { type: 'result', subtype: 'success' };
    // No death and no notification: the process is simply held, which is the
    // state that used to last for the life of the server, unobserved.
  });

  try {
    await queryClaudeSDK(
      'start something in the background',
      { appSessionId: 'task-held-app-1', cwd: os.tmpdir(), images: [], permissionMode: 'bypassPermissions' },
      ws,
    );

    assert.deepEqual(claudeSessionPool.getLiveTaskIds('task-held-app-1'), ['task-held-1']);
    for (let i = 0; i < 10; i += 1) {
      t.mock.timers.tick(60000);
    }

    const frame = frames.find((f) => f.kind === 'background_task') as Frame;
    assert.ok(frame, 'the advisory must actually reach a connected client');
    assert.equal(frame.sessionId, 'task-held-app-1', 'the app session id, never the provider-native one');
    assert.equal(frame.taskId, 'task-held-1');
    assert.equal(
      frame.status,
      'running',
      'the task has not completed, failed or been stopped — reusing any of those would be a lie',
    );
    assert.match(String(frame.summary), /Echo t1-t10 with delays/, 'the row must say WHICH command');
    assert.match(String(frame.summary), /10 minutes/, 'and how long it has been running');
    assert.match(String(frame.summary), /holding a Claude CLI process open/, 'and what that is costing');
    assert.match(String(frame.summary), /Nothing will stop it automatically/, 'and that nobody will end it');
    assert.equal(Object.hasOwn(frame, 'outputFile'), false, 'a running task has written no result file');

    // Report-only, end to end: the advisory must not have ended the hold.
    assert.equal(claudeSessionPool.hasLiveSession('task-held-app-1'), true);
    assert.deepEqual(claudeSessionPool.getLiveTaskIds('task-held-app-1'), ['task-held-1']);
  } finally {
    connectedClients.delete(client);
    claudeSessionPool._resetForTests();
    t.mock.timers.reset();
  }
});

// `emitBackgroundTaskEvent` scopes delivery to the task's owner, but only the
// producer can say who that is, and the only available answer is the user whose
// turn set the work going — carried by the run writer. The service's own tests
// prove the filter; they cannot prove `queryClaudeSDK` passes an owner at all, and
// a missing `ownerUserId:` line there would leave them green while every user kept
// receiving the task text and the host output path. Covers the settled producer
// (`task_notification`), the one frame that carries the path.
test('a settled task reaches only the connections of the user whose turn started it', async () => {
  claudeSessionPool._resetForTests();
  const ws = createFakeWs(OWNER_USER_ID);

  const ownerFrames: Frame[] = [];
  const ownerClient = {
    readyState: WS_OPEN_STATE,
    userId: OWNER_USER_ID,
    send: (data: string) => { ownerFrames.push(JSON.parse(data) as Frame); },
  };
  const otherFrames: Frame[] = [];
  const otherClient = {
    readyState: WS_OPEN_STATE,
    userId: OTHER_USER_ID,
    send: (data: string) => { otherFrames.push(JSON.parse(data) as Frame); },
  };
  connectedClients.add(ownerClient);
  connectedClients.add(otherClient);

  frameScripts.push(async function* script() {
    yield { type: 'system', subtype: 'init', session_id: 'task-owned-provider-1', slash_commands: [] };
    yield {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-owned-1',
      description: 'Echo t1-t10 with delays',
    };
    yield { type: 'result', subtype: 'success' };
    // Settles AFTER the turn ended — the between-turn path, which is the whole
    // reason this event cannot ride on a run writer.
    yield {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-owned-1',
      status: 'completed',
      output_file: '/home/alice/.claude/tasks/task-owned-1.output',
      summary: 'Echo t1-t10 with delays',
    };
  });

  try {
    await queryClaudeSDK(
      'start something in the background',
      { appSessionId: 'task-owned-app-1', cwd: os.tmpdir(), images: [], permissionMode: 'bypassPermissions' },
      ws,
    );

    await waitFor(() => ownerFrames.some((frame) => frame.kind === 'background_task'));
    const frame = ownerFrames.find((f) => f.kind === 'background_task') as Frame;
    assert.equal(frame.sessionId, 'task-owned-app-1');
    assert.equal(frame.outputFile, '/home/alice/.claude/tasks/task-owned-1.output');
    assert.equal(
      otherFrames.filter((f) => f.kind === 'background_task').length,
      0,
      'another user must not be handed the task text or the absolute host path',
    );
  } finally {
    connectedClients.delete(ownerClient);
    connectedClients.delete(otherClient);
    claudeSessionPool._resetForTests();
  }
});

// The gate is in `emitBackgroundTaskEvent`, but what decides whether it trips is
// the value `queryClaudeSDK` passes: `poolSessionId` falls back to the
// provider-native id (or a fresh request id) for the REST entry points, and the
// frontend would take either as an app session id and write a transcript row into
// a store bucket no session reads.
test('a REST-originated run — no app session id — emits no background_task at all', async () => {
  claudeSessionPool._resetForTests();
  const ws = createFakeWs(OWNER_USER_ID);

  const frames: Frame[] = [];
  const client = {
    readyState: WS_OPEN_STATE,
    userId: OWNER_USER_ID,
    send: (data: string) => { frames.push(JSON.parse(data) as Frame); },
  };
  connectedClients.add(client);

  frameScripts.push(async function* script() {
    yield { type: 'system', subtype: 'init', session_id: 'task-rest-provider-1', slash_commands: [] };
    yield {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-rest-1',
      description: 'Echo t1-t10 with delays',
    };
    yield { type: 'result', subtype: 'success' };
    yield {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-rest-1',
      status: 'completed',
      output_file: '/tmp/task-rest-1.output',
      summary: 'Echo t1-t10 with delays',
    };
  });

  try {
    // Exactly what server/routes/agent.js and server/routes/git.js pass: a
    // provider `sessionId` at most, never an `appSessionId`.
    await queryClaudeSDK(
      'start something in the background',
      { cwd: os.tmpdir(), images: [], permissionMode: 'bypassPermissions' },
      ws,
    );

    // Drain the between-turn path the same number of ticks the owner test needs
    // to see its frame, then assert nothing arrived.
    for (let tick = 0; tick < 200; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(
      frames.filter((f) => f.kind === 'background_task').length,
      0,
      'the frame carries a non-app session id and must not reach the wire',
    );
  } finally {
    connectedClients.delete(client);
    claudeSessionPool._resetForTests();
  }
});
