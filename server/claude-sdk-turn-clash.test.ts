import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Run with:
//   npx tsx --test --experimental-test-module-mocks --tsconfig server/tsconfig.json \
//     server/claude-sdk-turn-clash.test.ts
// (`mock.module` throws `TypeError: mock.module is not a function` without the
// flag on Node 24+.)
//
// Two requests running a turn on ONE session at the same time. Reachable in
// production because only the websocket path is serialised (`chatRunRegistry`);
// the REST entry point (`server/routes/agent.js`) is not, and it takes the same
// `appSessionId`. The pool refuses the second one — that part is pinned by
// `claude-session-pool.test.js` — and what this file pins is how the refusal
// LOOKS to the client, because the pool's message is an internal sentence
// (`Session "<id>" already has a turn in flight`) that used to reach the user
// verbatim as a `kind: 'error'` frame.
//
// A Stop-then-resend does NOT come here: an aborted turn keeps the slot and the
// next turn waits for it. What is left is genuine concurrency.

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Resolves once the fake CLI has actually taken turn 1's prompt off the stream. */
const turnOneRunning = createDeferred();
/** Held until the test has finished clashing against turn 1. */
const releaseTurnOne = createDeferred();

const realSdk = await import('@anthropic-ai/claude-agent-sdk');

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    ...realSdk,
    query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const generator = (async function* run() {
        let turn = 0;
        for await (const _userMessage of prompt) {
          turn += 1;
          if (turn === 1) {
            yield { type: 'system', subtype: 'init', session_id: 'clash-provider-1', slash_commands: [] };
            // Turn 1 is still generating — no terminator yet, so it holds the
            // pool's turn slot, which is the whole precondition of this test.
            turnOneRunning.resolve();
            await releaseTurnOne.promise;
          }
          yield { type: 'result', subtype: 'success' };
        }
      })();
      (generator as unknown as { interrupt: () => Promise<void> }).interrupt = async () => {};
      (generator as unknown as { close: () => void }).close = () => {};
      return generator;
    },
  },
});

process.env.DATABASE_PATH = path.join(os.tmpdir(), `claude-sdk-turn-clash-${process.pid}.db`);
const { initializeDatabase } = await import('@/modules/database/index.js');
initializeDatabase();

const { queryClaudeSDK } = await import('./claude-sdk.js');
const { claudeSessionPool, TURN_IN_FLIGHT_ERROR_CODE } = await import('./claude-session-pool.js');

type Frame = Record<string, unknown>;

function createFakeWs() {
  const sent: Frame[] = [];
  return {
    userId: null,
    isWebSocketWriter: true,
    send: (msg: Frame) => sent.push(msg),
    sent,
  };
}

const cwd = os.tmpdir();

test('a second request on a session that is already running a turn is refused as a protocol error, not as an internal failure', async () => {
  claudeSessionPool._resetForTests();

  const firstWs = createFakeWs();
  const firstRun = queryClaudeSDK(
    'the turn that is already running',
    {
      appSessionId: 'clash',
      cwd,
      images: [],
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    },
    firstWs,
  );

  await turnOneRunning.promise;

  // The REST shape: same app session id, its own writer, no idea that anything
  // else is running.
  const secondWs = createFakeWs();
  await queryClaudeSDK(
    'the request that arrives on top of it',
    {
      appSessionId: 'clash',
      sessionId: 'clash-provider-1',
      cwd,
      images: [],
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    },
    secondWs,
  );

  assert.deepEqual(
    secondWs.sent.map((frame) => frame.kind),
    ['protocol_error', 'complete'],
    'a refusal reports like the held-process refusal: one coded protocol_error, then the terminal '
    + 'complete the websocket layer is waiting for',
  );
  const [refusal, complete] = secondWs.sent;
  assert.equal(refusal.code, TURN_IN_FLIGHT_ERROR_CODE);
  assert.match(
    String(refusal.error),
    /already running on this session/i,
    'the user has to be told that their message was not started, and why',
  );
  assert.doesNotMatch(
    String(refusal.error),
    /turn in flight/i,
    'the pool\'s internal sentence is not a user-facing explanation',
  );
  assert.equal(complete.exitCode, 1, 'the turn the user asked for did not happen');

  // And the run it collided with is untouched: still holding the slot, still
  // able to finish normally.
  releaseTurnOne.resolve();
  await firstRun;
  assert.ok(
    firstWs.sent.some((frame) => frame.kind === 'complete' && frame.exitCode === 0),
    `the first run must still complete normally, got ${JSON.stringify(firstWs.sent.map((f) => f.kind))}`,
  );

  claudeSessionPool._resetForTests();
});
