# Background Shell Survival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A background shell started in one chat turn keeps running after that turn ends, and its real completion status reaches the UI.

**Architecture:** Keep-alive-on-demand. ccui currently spawns one `claude` CLI subprocess per turn; the shell is its child and dies with it. We introduce a pool that holds the SDK input stream open **only while background work is live**, so a session with no background work behaves exactly as today. The pool owns process lifetime and turn demux; `server/claude-sdk.js` keeps owning SDK-message translation. The `spawnFn(command, options, writer)` contract does not change, so the WebSocket layer is untouched except for one new session-scoped event frame.

**Tech Stack:** Node 22+ ESM, `@anthropic-ai/claude-agent-sdk` 0.3.165, Express + `ws`, React 18, `node:test` via `tsx`.

## Global Constraints

- Backend source is **ESM `.js`** (or `.ts` under `server/modules/`). No CommonJS.
- Run server tests with `npx tsx --test --tsconfig server/tsconfig.json <path>`. **`vitest` is broken in this checkout** — no config resolves the `@/` alias. Tests using `mock.module` additionally need `--experimental-test-module-mocks`.
- `npm run typecheck` runs `tsc --noEmit` on **both** `tsconfig.json` and `server/tsconfig.json`. Both must stay clean.
- `npm run lint` must stay clean. `eslint-plugin-boundaries` treats each `server/modules/*` folder as one element: cross-module imports must go through the module barrel (`index.ts`). **This is why the new pool lives at `server/` top level, not under `server/modules/`** — it is coupled to `server/claude-sdk.js`, which is top-level legacy, and placing it in a module would create a forbidden deep import.
- **Conventional Commits** are enforced by commitlint. Allowed types: `build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test`. `merge:` is **not** allowed.
- Never hardcode the string `'claude'` when spawning. Always `resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH)` from `server/shared/claude-cli-path.ts`.
- Idle grace period before closing an idle live session: **60000 ms**.
- The memory-pressure reaper stays **enabled** (`CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP` must NOT be set). Reap events are surfaced to the user instead.
- The dev server is a **systemd user service** (`cloudcli-dev`) serving the MAIN checkout on 5173/3001. Do not start a competing `npm run dev` on those ports. To test this branch, run `SERVER_PORT=3002 VITE_PORT=5174 npm run dev` from the worktree and browse 5174.

## Reference

- Spec: `docs/superpowers/specs/2026-07-28-streaming-input-mode-design.md`
- Spike + evidence: `spikes/streaming-input-mode/FINDINGS.md`, harness at `spikes/streaming-input-mode/harness.mjs`

## File Structure

| File | Responsibility |
|---|---|
| `server/claude-session-input-stream.js` (create) | The push-based `AsyncIterable<SDKUserMessage>` primitive. Stays open until `close()`. Nothing else. |
| `server/claude-session-input-stream.test.js` (create) | Unit tests for the primitive. |
| `server/claude-session-pool.js` (create) | Process lifetime, turn demux, live-task tracking, close policy, fallback. Knows nothing about normalized messages. |
| `server/claude-session-pool.test.js` (create) | Unit tests for the pool, with an injected fake query. |
| `server/claude-sdk.js` (modify) | Delegate to the pool. Keep translating SDK messages. Settle the turn on abort. |
| `server/modules/websocket/services/chat-session-events.service.ts` (create) | Session-scoped event sink: emit a frame to clients watching a session when no run is in flight. |
| `server/modules/websocket/index.ts` (modify) | Export the sink through the module barrel. |
| `src/components/chat/hooks/useChatRealtimeHandlers.ts` (modify) | Explicit `case 'background_task'`. |
| `src/components/chat/hooks/useChatRealtimeHandlers.backgroundTask.test.ts` (create) | Guard that the new kind never reaches `appendRealtime`. |

---

### Task 1: Push-based input stream primitive

The one piece that makes everything else possible: an `AsyncIterable` that yields messages as they are pushed and does **not** end until explicitly closed. Closing it is what arms the CLI's background-task reaper (its sweep branch runs only when `inputClosed === true`), so this object's lifetime is the whole feature.

**Files:**
- Create: `server/claude-session-input-stream.js`
- Test: `server/claude-session-input-stream.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createInputStream()` returning `{ push(sdkUserMessage): void, close(): void, get closed(): boolean, [Symbol.asyncIterator]() }`.

- [ ] **Step 1: Write the failing test**

```javascript
// server/claude-session-input-stream.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createInputStream } from './claude-session-input-stream.js';

const msg = (text) => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
});

test('yields messages pushed before iteration starts', async () => {
  const stream = createInputStream();
  stream.push(msg('one'));
  stream.push(msg('two'));
  stream.close();

  const seen = [];
  for await (const m of stream) {
    seen.push(m.message.content);
  }

  assert.deepEqual(seen, ['one', 'two']);
});

test('waits for a push instead of ending, then resumes', async () => {
  const stream = createInputStream();
  const iterator = stream[Symbol.asyncIterator]();

  const pending = iterator.next();
  let settled = false;
  void pending.then(() => { settled = true; });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, 'must not end just because the queue is empty');

  stream.push(msg('late'));
  const result = await pending;
  assert.equal(result.done, false);
  assert.equal(result.value.message.content, 'late');
});

test('close() ends a waiting iterator', async () => {
  const stream = createInputStream();
  const iterator = stream[Symbol.asyncIterator]();
  const pending = iterator.next();

  stream.close();

  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.equal(stream.closed, true);
});

test('push after close is ignored', async () => {
  const stream = createInputStream();
  stream.close();
  stream.push(msg('ignored'));

  const seen = [];
  for await (const m of stream) {
    seen.push(m);
  }
  assert.deepEqual(seen, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/claude-session-input-stream.test.js`
Expected: FAIL — cannot resolve `./claude-session-input-stream.js`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// server/claude-session-input-stream.js
/**
 * Push-based AsyncIterable of SDKUserMessage.
 *
 * The SDK's streaming input mode takes an AsyncIterable as `prompt`. While that
 * iterable stays un-ended, the CLI treats input as open — and its background
 * task reaper only sweeps when input is closed. So this object's lifetime IS
 * the lifetime of any background shell the session started.
 *
 * @returns {{
 *   push: (message: object) => void,
 *   close: () => void,
 *   readonly closed: boolean,
 *   [Symbol.asyncIterator]: () => AsyncIterator<object>
 * }}
 */
export function createInputStream() {
  /** @type {object[]} */
  const queued = [];
  /** @type {((result: { value: object | undefined, done: boolean }) => void) | null} */
  let waiting = null;
  let closed = false;

  const settleWaiting = (result) => {
    const resolve = waiting;
    waiting = null;
    resolve(result);
  };

  return {
    push(message) {
      if (closed) {
        return;
      }
      if (waiting) {
        settleWaiting({ value: message, done: false });
        return;
      }
      queued.push(message);
    },

    close() {
      if (closed) {
        return;
      }
      closed = true;
      if (waiting) {
        settleWaiting({ value: undefined, done: true });
      }
    },

    get closed() {
      return closed;
    },

    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queued.length > 0) {
            return Promise.resolve({ value: queued.shift(), done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
        return() {
          closed = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/claude-session-input-stream.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/claude-session-input-stream.js server/claude-session-input-stream.test.js
git commit -m "feat(claude): add push-based SDK input stream primitive"
```

---

### Task 2: Pool skeleton with turn demux

The pool turns "one process per turn" into "one process per session, closed on demand". Its hardest job is **turn demux**: one long-lived `for await` loop now serves many turns, and each turn's events must reach that turn's writer. Everything downstream assumes one run per loop, so a mis-routed event lands in the wrong session's store.

The pool takes `createQuery` as an injected dependency so tests never spawn a real CLI.

**Files:**
- Create: `server/claude-session-pool.js`
- Test: `server/claude-session-pool.test.js`

**Interfaces:**
- Consumes: `createInputStream()` from Task 1.
- Produces:
  - `claudeSessionPool.runTurn({ appSessionId, userMessage, sdkOptions, onMessage, onBetweenTurnMessage, createQuery })` → `Promise<object>` resolving with the SDK `result` message for **this** turn.
  - `claudeSessionPool.hasLiveSession(appSessionId)` → `boolean`
  - `claudeSessionPool.closeSession(appSessionId)` → `void`
  - `claudeSessionPool.settleTurn(appSessionId, reason)` → `boolean`
  - `claudeSessionPool.getLiveTaskIds(appSessionId)` → `string[]`
  - `claudeSessionPool._resetForTests()` → `void`

- [ ] **Step 1: Write the failing test**

```javascript
// server/claude-session-pool.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import { claudeSessionPool } from './claude-session-pool.js';

/**
 * Fake `query()`: consumes the input stream and emits whatever the scenario
 * queues per turn. Mirrors the real SDK shape — an AsyncGenerator with control
 * methods — without spawning a CLI.
 */
function createFakeQuery(scriptPerTurn) {
  const state = { closed: false, interrupted: false, turns: 0, prompts: [] };

  const factory = ({ prompt }) => {
    const generator = (async function* run() {
      for await (const userMessage of prompt) {
        state.prompts.push(userMessage.message.content);
        const script = scriptPerTurn[state.turns] ?? [{ type: 'result', subtype: 'success' }];
        state.turns += 1;
        for (const message of script) {
          yield message;
        }
      }
    })();

    generator.interrupt = async () => { state.interrupted = true; };
    generator.close = () => { state.closed = true; };
    return generator;
  };

  return { factory, state };
}

const userMessage = (text) => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
});

test('resolves a turn on its result message and routes events to that turn', async () => {
  claudeSessionPool._resetForTests();
  const { factory } = createFakeQuery([
    [{ type: 'assistant', text: 'a1' }, { type: 'result', subtype: 'success' }],
  ]);

  const routed = [];
  const result = await claudeSessionPool.runTurn({
    appSessionId: 's1',
    userMessage: userMessage('hello'),
    sdkOptions: {},
    onMessage: (m) => routed.push(m),
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  assert.equal(result.subtype, 'success');
  assert.deepEqual(routed.map((m) => m.type), ['assistant']);
});

test('closes the process at turn end when no background task is live', async () => {
  claudeSessionPool._resetForTests();
  const { factory, state } = createFakeQuery([[{ type: 'result', subtype: 'success' }]]);

  await claudeSessionPool.runTurn({
    appSessionId: 's2',
    userMessage: userMessage('hi'),
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  assert.equal(claudeSessionPool.hasLiveSession('s2'), false);
  assert.equal(state.closed, true);
});

test('two sequential turns share one process and route to their own writers', async () => {
  claudeSessionPool._resetForTests();
  const { factory, state } = createFakeQuery([
    [{ type: 'assistant', text: 'first' }, { type: 'system', subtype: 'task_started', task_id: 't1' }, { type: 'result', subtype: 'success' }],
    [{ type: 'assistant', text: 'second' }, { type: 'result', subtype: 'success' }],
  ]);

  const turnOne = [];
  const turnTwo = [];
  const common = {
    appSessionId: 's3',
    sdkOptions: {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  };

  await claudeSessionPool.runTurn({ ...common, userMessage: userMessage('one'), onMessage: (m) => turnOne.push(m) });
  // A live task keeps the session open, so turn two must reuse the same process.
  assert.equal(claudeSessionPool.hasLiveSession('s3'), true);

  await claudeSessionPool.runTurn({ ...common, userMessage: userMessage('two'), onMessage: (m) => turnTwo.push(m) });

  assert.deepEqual(turnOne.map((m) => m.text ?? m.subtype), ['first', 'task_started']);
  assert.deepEqual(turnTwo.map((m) => m.text), ['second']);
  assert.equal(state.turns, 2);
  assert.equal(state.closed, false, 'must stay open while task t1 is live');
});

test('settleTurn resolves an in-flight turn without closing the process', async () => {
  claudeSessionPool._resetForTests();
  // Turn one never emits a result — this is what an interrupted turn looks like.
  const { factory, state } = createFakeQuery([[{ type: 'assistant', text: 'working' }]]);

  const pending = claudeSessionPool.runTurn({
    appSessionId: 's4',
    userMessage: userMessage('long'),
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(claudeSessionPool.settleTurn('s4', 'aborted'), true);

  const result = await pending;
  assert.equal(result.subtype, 'aborted');
  assert.equal(state.closed, false);

  claudeSessionPool.closeSession('s4');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/claude-session-pool.test.js`
Expected: FAIL — cannot resolve `./claude-session-pool.js`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// server/claude-session-pool.js
import { createInputStream } from './claude-session-input-stream.js';

/**
 * Owns the lifetime of live `claude` CLI processes, one per app session.
 *
 * Why this exists: ccui used to create a `query()` per turn, so the subprocess
 * exited at turn end and took any background shell with it. The CLI only
 * reaps background tasks once its input is closed, so this pool keeps the input
 * stream open while background work is live and closes it otherwise. A session
 * that never starts background work therefore behaves exactly as before.
 *
 * Deliberately knows nothing about normalized messages or websockets: callers
 * pass `onMessage` / `onBetweenTurnMessage` and keep translation to themselves.
 */

const IDLE_GRACE_MS = 60000;

/** @type {Map<string, LiveSession>} */
const live = new Map();

/**
 * @typedef {object} LiveSession
 * @property {string} appSessionId
 * @property {object} query
 * @property {ReturnType<typeof createInputStream>} input
 * @property {Set<string>} liveTaskIds
 * @property {{ onMessage: Function, resolve: Function, reject: Function } | null} currentTurn
 * @property {Function} onBetweenTurnMessage
 * @property {NodeJS.Timeout | null} idleTimer
 * @property {boolean} dead
 */

function clearIdleTimer(session) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function destroy(session) {
  clearIdleTimer(session);
  session.dead = true;
  session.input.close();
  try {
    session.query.close?.();
  } catch (error) {
    console.warn('[ClaudeSessionPool] close() failed', {
      appSessionId: session.appSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  live.delete(session.appSessionId);
}

/**
 * Live-task bookkeeping, driven by typed SDK messages rather than tool_result
 * prose. A missed announcement would leave the set empty and let us close the
 * process — killing the very task we are trying to protect — so this must not
 * depend on string matching.
 */
function trackTask(session, message) {
  if (message?.type !== 'system') {
    return;
  }
  if (message.subtype === 'task_started' && typeof message.task_id === 'string') {
    session.liveTaskIds.add(message.task_id);
    return;
  }
  if (message.subtype === 'task_notification' && typeof message.task_id === 'string') {
    session.liveTaskIds.delete(message.task_id);
    return;
  }
  if (message.subtype === 'task_updated' && typeof message.task_id === 'string') {
    const status = message.patch?.status;
    if (status === 'completed' || status === 'failed' || status === 'killed') {
      session.liveTaskIds.delete(message.task_id);
    }
  }
}

/** Closes the session unless background work still needs the process alive. */
function closeIfIdle(session) {
  if (session.dead || session.currentTurn) {
    return;
  }
  if (session.liveTaskIds.size > 0) {
    clearIdleTimer(session);
    return;
  }
  destroy(session);
}

function settleCurrentTurn(session, result) {
  const turn = session.currentTurn;
  if (!turn) {
    return false;
  }
  session.currentTurn = null;
  turn.resolve(result);
  return true;
}

function routeMessage(session, message) {
  trackTask(session, message);

  if (message?.type === 'result') {
    settleCurrentTurn(session, message);
    closeIfIdle(session);
    return;
  }

  if (session.currentTurn) {
    session.currentTurn.onMessage(message);
    return;
  }

  // No turn in flight: this is the path that carries a background task's
  // completion to the UI after its turn already finished.
  session.onBetweenTurnMessage(message);

  if (session.liveTaskIds.size === 0 && !session.idleTimer) {
    session.idleTimer = setTimeout(() => closeIfIdle(session), IDLE_GRACE_MS);
  }
}

async function drain(session) {
  try {
    for await (const message of session.query) {
      routeMessage(session, message);
    }
  } catch (error) {
    const turn = session.currentTurn;
    session.currentTurn = null;
    if (turn) {
      turn.reject(error instanceof Error ? error : new Error(String(error)));
    }
  } finally {
    // The process is gone. Reject any turn still waiting so the caller's
    // promise settles and its own safety net can complete the run.
    const turn = session.currentTurn;
    session.currentTurn = null;
    if (turn) {
      turn.reject(new Error('Claude session process ended before the turn completed'));
    }
    session.dead = true;
    clearIdleTimer(session);
    live.delete(session.appSessionId);
  }
}

function createLiveSession({ appSessionId, sdkOptions, onBetweenTurnMessage, createQuery }) {
  const input = createInputStream();
  const query = createQuery({ prompt: input, options: sdkOptions });

  /** @type {LiveSession} */
  const session = {
    appSessionId,
    query,
    input,
    liveTaskIds: new Set(),
    currentTurn: null,
    onBetweenTurnMessage,
    idleTimer: null,
    dead: false,
  };

  live.set(appSessionId, session);
  void drain(session);
  return session;
}

export const claudeSessionPool = {
  /**
   * Runs one turn, reusing the session's live process when there is one.
   * Resolves with that turn's SDK `result` message.
   */
  async runTurn({ appSessionId, userMessage, sdkOptions, onMessage, onBetweenTurnMessage, createQuery }) {
    let session = live.get(appSessionId);
    if (!session || session.dead) {
      session = createLiveSession({ appSessionId, sdkOptions, onBetweenTurnMessage, createQuery });
    } else {
      // Keep the sink pointed at the newest caller so between-turn events reach
      // whoever is currently watching.
      session.onBetweenTurnMessage = onBetweenTurnMessage;
    }

    clearIdleTimer(session);

    if (session.currentTurn) {
      throw new Error(`Session "${appSessionId}" already has a turn in flight`);
    }

    return new Promise((resolve, reject) => {
      session.currentTurn = { onMessage, resolve, reject };
      session.input.push(userMessage);
    });
  },

  hasLiveSession(appSessionId) {
    const session = live.get(appSessionId);
    return Boolean(session && !session.dead);
  },

  getLiveTaskIds(appSessionId) {
    return [...(live.get(appSessionId)?.liveTaskIds ?? [])];
  },

  /** Settles an in-flight turn WITHOUT killing the process. Used by abort. */
  settleTurn(appSessionId, reason) {
    const session = live.get(appSessionId);
    if (!session) {
      return false;
    }
    return settleCurrentTurn(session, { type: 'result', subtype: reason });
  },

  closeSession(appSessionId) {
    const session = live.get(appSessionId);
    if (session) {
      destroy(session);
    }
  },

  _resetForTests() {
    for (const session of [...live.values()]) {
      destroy(session);
    }
    live.clear();
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/claude-session-pool.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/claude-session-pool.js server/claude-session-pool.test.js
git commit -m "feat(claude): add keep-alive-on-demand session pool with turn demux"
```

---

### Task 3: Live-task tracking and close policy edge cases

Task 2 established the happy paths. This task pins the behaviours that, if wrong, silently re-create the original bug — a session closing while a shell is still running.

**Files:**
- Modify: `server/claude-session-pool.test.js` (append tests)

**Interfaces:**
- Consumes: the full `claudeSessionPool` surface from Task 2.
- Produces: no new API. Confirms `getLiveTaskIds`, the never-close-with-live-tasks rule, and reaper (`killed`) handling.

- [ ] **Step 1: Write the failing tests**

Append to `server/claude-session-pool.test.js`, reusing `createFakeQuery` and `userMessage` already defined there:

```javascript
test('a task_started before turn end keeps the process alive', async () => {
  claudeSessionPool._resetForTests();
  const { factory, state } = createFakeQuery([[
    { type: 'system', subtype: 'task_started', task_id: 'bg1' },
    { type: 'result', subtype: 'success' },
  ]]);

  await claudeSessionPool.runTurn({
    appSessionId: 's5',
    userMessage: userMessage('start bg'),
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  assert.equal(claudeSessionPool.hasLiveSession('s5'), true);
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('s5'), ['bg1']);
  assert.equal(state.closed, false);

  claudeSessionPool.closeSession('s5');
});

test('task_updated status killed clears the task, so the reaper does not wedge the session open', async () => {
  claudeSessionPool._resetForTests();
  const { factory } = createFakeQuery([[
    { type: 'system', subtype: 'task_started', task_id: 'bg2' },
    { type: 'system', subtype: 'task_updated', task_id: 'bg2', patch: { status: 'killed' } },
    { type: 'result', subtype: 'success' },
  ]]);

  await claudeSessionPool.runTurn({
    appSessionId: 's6',
    userMessage: userMessage('start bg'),
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  assert.deepEqual(claudeSessionPool.getLiveTaskIds('s6'), []);
  assert.equal(claudeSessionPool.hasLiveSession('s6'), false);
});

test('a task_notification arriving after turn end goes to the between-turn sink', async () => {
  claudeSessionPool._resetForTests();

  // Emitted only after the turn's result, i.e. with no turn in flight.
  const notification = {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'bg3',
    status: 'completed',
    output_file: '/tmp/bg3.output',
    summary: 'sonar finished',
  };

  const factory = ({ prompt }) => {
    const generator = (async function* run() {
      for await (const _message of prompt) {
        yield { type: 'system', subtype: 'task_started', task_id: 'bg3' };
        yield { type: 'result', subtype: 'success' };
        yield notification;
      }
    })();
    generator.close = () => {};
    return generator;
  };

  const betweenTurn = [];
  const inTurn = [];
  await claudeSessionPool.runTurn({
    appSessionId: 's7',
    userMessage: userMessage('start bg'),
    sdkOptions: {},
    onMessage: (m) => inTurn.push(m),
    onBetweenTurnMessage: (m) => betweenTurn.push(m),
    createQuery: factory,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(inTurn.map((m) => m.subtype), ['task_started']);
  assert.deepEqual(betweenTurn.map((m) => m.subtype), ['task_notification']);
  assert.equal(betweenTurn[0].output_file, '/tmp/bg3.output');

  claudeSessionPool.closeSession('s7');
});

test('a dead process is replaced on the next turn instead of reused', async () => {
  claudeSessionPool._resetForTests();
  let built = 0;
  const factory = ({ prompt }) => {
    built += 1;
    const generator = (async function* run() {
      for await (const _message of prompt) {
        yield { type: 'system', subtype: 'task_started', task_id: `t${built}` };
        yield { type: 'result', subtype: 'success' };
        return; // generator ends -> process gone
      }
    })();
    generator.close = () => {};
    return generator;
  };

  const common = {
    appSessionId: 's8',
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  };

  await claudeSessionPool.runTurn({ ...common, userMessage: userMessage('one') });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(claudeSessionPool.hasLiveSession('s8'), false, 'generator ended, session is dead');

  await claudeSessionPool.runTurn({ ...common, userMessage: userMessage('two') });
  assert.equal(built, 2, 'a fresh query must be created');
});
```

- [ ] **Step 2: Run tests to verify the failures are real**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/claude-session-pool.test.js`
Expected: the four new tests fail if any close-policy rule from Task 2 is wrong. If they all pass immediately, that is the correct outcome — Task 2 implemented the rules — but read each assertion and confirm it is actually exercising the rule rather than passing vacuously.

- [ ] **Step 3: Fix any rule the tests expose**

No new code is expected. If a test fails, the bug is in `trackTask` or `closeIfIdle` in `server/claude-session-pool.js`; fix it there rather than weakening the test.

- [ ] **Step 4: Run the full pool suite**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/claude-session-pool.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/claude-session-pool.test.js server/claude-session-pool.js
git commit -m "test(claude): pin session-pool close policy against live background tasks"
```

---

### Task 4: Session-scoped event sink

A completing background task arrives with **no run in flight**, so the per-run `writer` has nowhere to put it. This adds a session-scoped emitter following the precedent already in `chat-run-registry.service.ts:115`, which iterates `connectedClients` from `websocket-state.service.ts:16` for `broadcastCanonicalSessionUpsert`.

**Files:**
- Create: `server/modules/websocket/services/chat-session-events.service.ts`
- Modify: `server/modules/websocket/index.ts`
- Test: `server/modules/websocket/tests/chat-session-events.test.ts`

**Interfaces:**
- Consumes: `connectedClients`, `WS_OPEN_STATE` from `@/modules/websocket/services/websocket-state.service.js`.
- Produces: `emitBackgroundTaskEvent({ sessionId, taskId, status, outputFile, summary })` → `void`, exported from the websocket module barrel. Emits frame `{ kind: 'background_task', sessionId, taskId, status, outputFile, summary, timestamp }`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/modules/websocket/tests/chat-session-events.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { emitBackgroundTaskEvent } from '@/modules/websocket/services/chat-session-events.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

test('emits a background_task frame to open clients', () => {
  connectedClients.clear();
  const open = new FakeConnection();
  const closed = new FakeConnection();
  closed.readyState = 3;
  connectedClients.add(open as never);
  connectedClients.add(closed as never);

  emitBackgroundTaskEvent({
    sessionId: 'app-1',
    taskId: 'bg1',
    status: 'completed',
    outputFile: '/tmp/bg1.output',
    summary: 'sonar finished',
  });

  assert.equal(open.frames.length, 1);
  const frame = open.frames[0];
  assert.equal(frame.kind, 'background_task');
  assert.equal(frame.sessionId, 'app-1');
  assert.equal(frame.taskId, 'bg1');
  assert.equal(frame.status, 'completed');
  assert.equal(frame.outputFile, '/tmp/bg1.output');
  assert.equal(frame.summary, 'sonar finished');
  assert.equal(typeof frame.timestamp, 'string');

  assert.equal(closed.frames.length, 0, 'must skip non-open sockets');
  connectedClients.clear();
});

test('a failing client does not stop delivery to the rest', () => {
  connectedClients.clear();
  const broken = {
    readyState: 1,
    send(): void { throw new Error('socket exploded'); },
  };
  const healthy = new FakeConnection();
  connectedClients.add(broken as never);
  connectedClients.add(healthy as never);

  emitBackgroundTaskEvent({
    sessionId: 'app-2',
    taskId: 'bg2',
    status: 'stopped',
    outputFile: '/tmp/bg2.output',
    summary: 'reaped',
  });

  assert.equal(healthy.frames.length, 1);
  connectedClients.clear();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/tests/chat-session-events.test.ts`
Expected: FAIL — cannot resolve `chat-session-events.service.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/modules/websocket/services/chat-session-events.service.ts
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

export interface BackgroundTaskEvent {
  sessionId: string;
  taskId: string;
  status: 'completed' | 'failed' | 'stopped';
  outputFile: string;
  summary: string;
}

/**
 * Emits a session-scoped background-task event.
 *
 * Unlike run events, this can fire with NO run in flight — a background shell
 * outlives the turn that started it, so its completion has no writer to ride
 * on. Mirrors the fan-out already used by `broadcastCanonicalSessionUpsert`.
 */
export function emitBackgroundTaskEvent(event: BackgroundTaskEvent): void {
  const frame = JSON.stringify({
    kind: 'background_task',
    sessionId: event.sessionId,
    taskId: event.taskId,
    status: event.status,
    outputFile: event.outputFile,
    summary: event.summary,
    timestamp: new Date().toISOString(),
  });

  connectedClients.forEach((client) => {
    if (client.readyState !== WS_OPEN_STATE) {
      return;
    }
    try {
      client.send(frame);
    } catch (error) {
      console.warn('[ChatSessionEvents] failed to deliver background_task frame', {
        sessionId: event.sessionId,
        taskId: event.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
```

Then add to the module barrel `server/modules/websocket/index.ts` (append alongside the existing exports):

```typescript
export { emitBackgroundTaskEvent } from '@/modules/websocket/services/chat-session-events.service.js';
export type { BackgroundTaskEvent } from '@/modules/websocket/services/chat-session-events.service.js';
```

- [ ] **Step 4: Run test and typecheck**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/tests/chat-session-events.test.ts`
Expected: PASS, 2 tests.

Run: `npm run typecheck && npm run lint`
Expected: both clean. A boundaries error here means the barrel export is missing.

- [ ] **Step 5: Commit**

```bash
git add server/modules/websocket/services/chat-session-events.service.ts server/modules/websocket/index.ts server/modules/websocket/tests/chat-session-events.test.ts
git commit -m "feat(websocket): add session-scoped background_task event sink"
```

---

### Task 5: Wire claude-sdk.js to the pool

The integration point. `queryClaudeSDK(command, options, ws)` keeps its signature — `chat-websocket.service.ts:503` calls it as `spawnFn(command, runtimeOptions, run.writer)` and must not change. What changes is that the SDK message loop stops being a `for await` owned by this function and becomes a callback the pool drives.

Read `server/claude-sdk.js` fully before editing. The existing loop body starting at the `for await (const message of queryInstance)` near line 757 is the translation logic; it moves into a `handleSdkMessage(message)` closure. Everything it closes over (`capturedSessionId`, `sessionCreatedSent`, `ws`, `emitNotification`) stays in scope.

**Files:**
- Modify: `server/claude-sdk.js` — `buildPromptPayload` (~:495), the query construction (~:724), the message loop (~:757), `abortClaudeSDKSession` (~:897)

**Interfaces:**
- Consumes: `claudeSessionPool.runTurn` / `settleTurn` / `closeSession` from Task 2; `emitBackgroundTaskEvent` from Task 4 (import from `@/modules/websocket/index.js`).
- Produces: unchanged public surface — `queryClaudeSDK(command, options, ws)`, `abortClaudeSDKSession(sessionId)`, `isClaudeSDKSessionActive(sessionId)`.

- [ ] **Step 1: Convert `buildPromptPayload` into a single-message builder**

It currently returns either a raw string or a one-shot generator. The pool needs one `SDKUserMessage` object instead. Replace the function body:

```javascript
/**
 * Builds ONE SDKUserMessage for the pool to push into the session's open input
 * stream. Previously this returned a bare string (or a generator that closed
 * after one yield), which told the CLI input was finished and made it reap the
 * session's background shells.
 */
async function buildPromptPayload(command, images, cwd) {
  const content = normalizeImageDescriptors(images).length === 0
    ? command
    : await buildClaudeUserContent(command, images, cwd);

  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString(),
  };
}
```

- [ ] **Step 2: Replace the query construction and loop with a pool call**

Delete the `queryInstance = query({ ... })` blocks and the `for await (const message of queryInstance)` wrapper. Keep the loop **body** verbatim inside a closure, and drive it from the pool:

```javascript
    const handleSdkMessage = (message) => {
      // <-- the entire former body of `for await (const message of queryInstance)`
      //     goes here unchanged: session-id capture, recaptureForkSession,
      //     normalization, ws.send(...) calls, everything.
    };

    const forwardBetweenTurnMessage = (message) => {
      // Only background-task settlement is meaningful with no turn in flight.
      if (message?.type !== 'system' || message.subtype !== 'task_notification') {
        return;
      }
      emitBackgroundTaskEvent({
        sessionId: capturedSessionId || sessionId,
        taskId: message.task_id,
        status: message.status,
        outputFile: message.output_file,
        summary: message.summary,
      });
    };

    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';
    try {
      await claudeSessionPool.runTurn({
        appSessionId: capturedSessionId || sessionId,
        userMessage: await buildPromptPayload(command, options.images, options.cwd),
        sdkOptions,
        onMessage: handleSdkMessage,
        onBetweenTurnMessage: forwardBetweenTurnMessage,
        createQuery: query,
      });
    } finally {
      if (prevStreamTimeout !== undefined) {
        process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
      } else {
        delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
      }
    }
```

Keep the existing `addSession(capturedSessionId, queryInstance, ws)` bookkeeping, but register the pool handle instead of a per-turn query instance, so `abortClaudeSDKSession` can still find the session.

**Preserve the existing hooks-retry fallback.** The current code wraps `query({...})` in a try/catch that retries **without** `sdkOptions.hooks` when hook registration throws, because older or newer SDK versions may reject the hook shape. Moving construction into the pool would silently drop that. Pass a wrapper as `createQuery` instead of the bare `query`:

```javascript
    const createQueryWithHookFallback = (params) => {
      try {
        return query(params);
      } catch (hookError) {
        // Older/newer SDK versions may not accept the hook shape. Keep the run
        // working; notifications degrade to runtime events.
        console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
        const { hooks: _dropped, ...optionsWithoutHooks } = params.options;
        return query({ ...params, options: optionsWithoutHooks });
      }
    };
```

Then pass `createQuery: createQueryWithHookFallback` to `runTurn`. This also satisfies the spec's "pool cannot create a live session → fall back" requirement: construction failures that are recoverable are recovered here, and unrecoverable ones reject the turn promise, which `chat-websocket.service.ts:513` already turns into a completed run. No separate one-shot code path is built — the pool already closes at turn end whenever no background task is live, which *is* the old one-shot behaviour.

Note the ordering hazard: `capturedSessionId` is `undefined` for a brand-new session until the first SDK message announces an id, but `runTurn` needs a key up front. Use the app-level `sessionId` from `options` as the pool key — it is stable for the session's whole lifetime, which is exactly what the pool wants. Do **not** key the pool on the provider session id, because forks change it mid-stream.

- [ ] **Step 3: Make abort settle the turn instead of relying on a result**

The spike showed an interrupted turn emits **no `result`** while the session stays usable. Without settling it ourselves, `spawnFn` never resolves. In `abortClaudeSDKSession`, after `await session.instance.interrupt()`:

```javascript
    abortedSessionIds.add(sessionId);
    await session.instance.interrupt();
    // An interrupted turn emits no `result` (verified in the spike), so settle
    // the awaiting turn ourselves. The process stays alive on purpose: a
    // background shell started earlier in this session must survive the abort.
    claudeSessionPool.settleTurn(sessionId, 'aborted');
    session.status = 'aborted';
    removeSession(sessionId);
```

- [ ] **Step 4: Verify against the real CLI**

Run the spike harness, which exercises the same option set end to end:

Run: `node spikes/streaming-input-mode/harness.mjs`
Expected: `Q-0 bg shell survived turn boundary : YES`.

Then start this branch's dev server and drive a real chat turn:

```bash
SERVER_PORT=3002 VITE_PORT=5174 npm run dev
```

Expected: a `Bash` call with `run_in_background: true` keeps writing to its output file after the turn shows as complete, and a `background_task` frame arrives when it settles.

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add server/claude-sdk.js
git commit -m "feat(claude): drive turns through the session pool so background shells survive"
```

---

### Task 6: Frontend handling for the new frame

**This task is mandatory, not cosmetic**, but get the mechanism right — read `src/components/chat/hooks/useChatRealtimeHandlers.ts:107-252` before editing. The `default:` branch of the first switch (line ~199) merely `break`s; the danger is *after* it. Control then reaches a generic path at line ~241:

```typescript
const shouldPersist =
  msg.kind !== 'complete'
  && msg.kind !== 'status'
  && msg.kind !== 'permission_request'
  && msg.kind !== 'permission_cancelled';

if (sid && shouldPersist) {
  sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
}
```

That is an **allow-by-default** force-cast. A `background_task` frame has no `.id`, so appending it corrupts the session's message store and crashes every later merge on `.id.startsWith`. Two kinds already dodge it by returning early in the first switch — `session_upserted` / `loading_progress` (line ~190) and `session_lock_state_changed` (line ~197, whose comment says exactly this: *"must not fall through to the generic appendRealtime path below"*). Follow that precedent.

**Files:**
- Create: `src/components/chat/utils/realtimeKinds.ts`
- Create: `src/components/chat/utils/realtimeKinds.test.ts`
- Modify: `src/components/chat/hooks/useChatRealtimeHandlers.ts`

**Interfaces:**
- Consumes: the `background_task` frame from Task 4.
- Produces: `isNonTranscriptKind(kind: string): boolean` from `src/components/chat/utils/realtimeKinds.ts`, plus an early-returning `case 'background_task'` in the first switch.

The predicate lives in a leaf util with **no imports** because that is the only frontend location that reliably runs under `npx tsx --test` — the hook itself pulls `notificationSound`, which touches browser globals at import time.

- [ ] **Step 1: Write the failing test**

```typescript
// src/components/chat/utils/realtimeKinds.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { isNonTranscriptKind } from './realtimeKinds.js';

test('background_task must never be appended to the transcript store', () => {
  assert.equal(isNonTranscriptKind('background_task'), true);
});

test('the kinds that already dodge the generic append path stay classified', () => {
  for (const kind of ['session_upserted', 'loading_progress', 'session_lock_state_changed']) {
    assert.equal(isNonTranscriptKind(kind), true, `${kind} must not be appended`);
  }
});

test('real chat message kinds remain transcript-bound', () => {
  for (const kind of ['text', 'tool_use', 'tool_result', 'thinking']) {
    assert.equal(isNonTranscriptKind(kind), false, `${kind} belongs in the transcript`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --tsconfig tsconfig.json src/components/chat/utils/realtimeKinds.test.ts`
Expected: FAIL — cannot resolve `./realtimeKinds.js`.

- [ ] **Step 3: Write the util**

```typescript
// src/components/chat/utils/realtimeKinds.ts
/**
 * Realtime frame kinds that are NOT chat messages and must never reach
 * `sessionStore.appendRealtime()`.
 *
 * The generic routing path in useChatRealtimeHandlers is allow-by-default: it
 * force-casts anything not explicitly excluded into a NormalizedMessage. A
 * frame without `.id` corrupts that session's store and crashes every later
 * merge on `.id.startsWith`, so every non-message kind must be listed here AND
 * return early from the first switch.
 */
const NON_TRANSCRIPT_KINDS = new Set([
  'session_upserted',
  'loading_progress',
  'session_lock_state_changed',
  'background_task',
]);

export function isNonTranscriptKind(kind: string): boolean {
  return NON_TRANSCRIPT_KINDS.has(kind);
}
```

- [ ] **Step 4: Add the case and harden the generic guard**

In `useChatRealtimeHandlers.ts`, import the util and add the case immediately after the `session_lock_state_changed` case (~line 197), so it returns before the generic path:

```typescript
        // A background shell settled — possibly long after the turn that
        // started it, possibly killed by the OS memory-pressure reaper. The
        // user needs to know either way, and it is not a transcript message.
        case 'background_task': {
          showCompletionTitleIndicator();
          void playNotificationSound();
          return;
        }
```

Both helpers are already imported at the top of the file and are called this way at lines 153 and 308-309.

Then make the generic guard use the shared predicate so the two lists cannot drift:

```typescript
      const shouldPersist =
        !isNonTranscriptKind(msg.kind)
        && msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_cancelled';
```

This is belt-and-braces: the early `return` is the real protection, and the predicate stops a future refactor that removes the case from silently re-opening the hole.

- [ ] **Step 5: Run test and typecheck**

Run: `npx tsx --test --tsconfig tsconfig.json src/components/chat/utils/realtimeKinds.test.ts`
Expected: PASS, 3 tests.

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Verify in the browser**

With `SERVER_PORT=3002 VITE_PORT=5174 npm run dev` running from the worktree, open `localhost:5174`, start a background command, let the turn finish, and confirm the completion notification arrives with the transcript intact — no crash, no duplicated or malformed message row. Browse **5174**, never 3001: hitting the backend directly serves a possibly weeks-stale prebuilt `dist/`.

- [ ] **Step 7: Commit**

```bash
git add src/components/chat/utils/realtimeKinds.ts src/components/chat/utils/realtimeKinds.test.ts src/components/chat/hooks/useChatRealtimeHandlers.ts
git commit -m "feat(chat): handle background_task frames without corrupting the transcript store"
```

---

### Task 7: Regression guard and documentation

Locks in the behaviour so a future change cannot quietly restore the bug, and records the reasoning where the next person will look.

**Files:**
- Create: `server/claude-session-pool.regression.test.js`
- Modify: `CLAUDE.md` (Gotchas section)
- Modify: `docs/business/capabilities/chat-and-agent-streaming/` — add `background-shell-survival.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no new API.

- [ ] **Step 1: Write the regression test**

The single assertion that would have caught the original bug:

```javascript
// server/claude-session-pool.regression.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import { claudeSessionPool } from './claude-session-pool.js';

/**
 * Regression guard for the background-shell bug: a session with a live task
 * MUST NOT have its process closed at turn end. Closing the input arms the
 * CLI's reaper (its sweep branch runs only when `inputClosed === true`), which
 * is what used to kill the shell.
 */
test('turn end must not close a session that still has a live background task', async () => {
  claudeSessionPool._resetForTests();
  let closed = false;

  const factory = ({ prompt }) => {
    const generator = (async function* run() {
      for await (const _message of prompt) {
        yield { type: 'system', subtype: 'task_started', task_id: 'survivor' };
        yield { type: 'result', subtype: 'success' };
      }
    })();
    generator.close = () => { closed = true; };
    return generator;
  };

  await claudeSessionPool.runTurn({
    appSessionId: 'regression',
    userMessage: { type: 'user', message: { role: 'user', content: 'go' }, parent_tool_use_id: null },
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  assert.equal(closed, false, 'closing here kills the background shell — the whole bug');
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('regression'), ['survivor']);

  claudeSessionPool.closeSession('regression');
  assert.equal(closed, true, 'explicit close must still work');
});
```

- [ ] **Step 2: Run it**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/claude-session-pool.regression.test.js`
Expected: PASS, 1 test.

- [ ] **Step 3: Add the gotcha to CLAUDE.md**

Append to the Gotchas list:

```markdown
- **The Claude provider holds its CLI subprocess open while background work is live.** `server/claude-session-pool.js` keeps the SDK input stream open until every tracked `task_id` settles, because the CLI's background-task reaper only sweeps when input is closed (`inputClosed === true` gates its sweep branch). Closing the input at turn end — the old behaviour — killed background shells ~5s after the turn's result, leaving a 0-byte output file and a `status=stopped` notification on the next message. Live tasks are tracked from typed SDK messages (`task_started` / `task_notification` / `task_updated`), never by parsing tool_result prose: a missed string match leaves the set empty and closes the process, failing toward killing the task.
```

- [ ] **Step 4: Write the capability doc**

`docs/business/**` is hand-authored narrative, not generated — do not run a doc generator at it. Read one sibling in `docs/business/capabilities/chat-and-agent-streaming/` first to match voice, then create `background-shell-survival.md` with this content:

```markdown
# Background Shell Survival

## Description
Long-running shell commands started by the agent keep running after the chat turn
that launched them ends, and report their real outcome when they finish.

## Actors
The user who asked for the long command; the Claude runtime that backgrounds it.

## Trigger
A `Bash` tool call either sets `run_in_background: true`, or exceeds its timeout
(120s by default) and is auto-backgrounded by the Claude CLI.

## Flow
1. The runtime backgrounds the command and returns a task id plus an output file path.
2. The turn completes normally; the UI stops showing "processing".
3. ccui keeps the session's CLI process alive because a tracked task is still live.
4. The command finishes, or is killed by the OS memory-pressure reaper.
5. ccui emits a session-scoped `background_task` event; the user is notified.
6. With no tasks left, ccui closes the process after a 60s idle grace period.

## Output
A notification carrying the task's terminal status (`completed`, `failed`, or
`stopped`), its summary, and the path to its full output file.

## Technical Mapping
- `server/claude-session-input-stream.js` — the input stream whose open state keeps the CLI from reaping tasks
- `server/claude-session-pool.js` — process lifetime, turn demux, live-task tracking
- `server/claude-sdk.js` — SDK message translation; drives the pool per turn
- `server/modules/websocket/services/chat-session-events.service.ts` — the `background_task` frame
- `src/components/chat/hooks/useChatRealtimeHandlers.ts` — surfaces it without touching the transcript store

## Dependencies
Claude provider only. Requires `@anthropic-ai/claude-agent-sdk` streaming input
mode; the CLI reaps background tasks whenever its input is closed.
```

- [ ] **Step 5: Full verification and commit**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/claude-session-pool.test.js server/claude-session-pool.regression.test.js server/claude-session-input-stream.test.js server/modules/websocket/tests/chat-session-events.test.ts`
Expected: all PASS.

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all clean.

```bash
git add server/claude-session-pool.regression.test.js CLAUDE.md docs/business/capabilities/chat-and-agent-streaming/background-shell-survival.md
git commit -m "test(claude): guard background-shell survival and document the reaper gate"
```

---

## Out of Scope

Per the scope decision, do **not** build these here:

- A Ctrl-B style "background it now" button (`query.backgroundTasks()`, verified working in the spike).
- A panel listing running background tasks with a stop button (`query.stopTask()`, verified working).
- Providers other than Claude.
- Mid-session `setModel`; parity verification for image prompts, MCP servers, and `settingSources` across turns.

## Known Follow-ups

- `recaptureForkSession` in `server/claude-sdk.js` remaps the provider session id mid-stream. The pool is keyed on the **app** session id specifically so forks do not confuse it, but the fork path must be exercised manually before merge: fork a session, confirm the fork gets its own live session and the parent's transcript is untouched.
- Toggling `skipPermissions` mid-session now needs `query.setPermissionMode()` (verified working), because the persistent process fixes `permissionMode` at creation. Not triggered by current usage — the a30 session ran `bypassPermissions` for all 1373 recorded hook payloads — but it is a real gap once a user flips the setting mid-conversation.
- Independent quick win, tracked separately: raise `BASH_DEFAULT_TIMEOUT_MS` from its 120000 default so ordinary long commands finish inside the turn and never need backgrounding.
