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

/**
 * Deterministic replacement for a wall-clock sleep when a test is really
 * waiting for one specific event to fire (a message reaching a callback).
 * The callback resolves this instead of the test guessing how many
 * milliseconds that takes.
 */
function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Deterministic replacement for a wall-clock sleep when a test is waiting on
 * observable pool state to settle (e.g. a session dying) rather than on one
 * named event. Ticks the microtask queue — everything relevant here
 * (async-generator draining, the input stream's queued waiters) settles via
 * microtasks, never timers — so this never needs to reach a macrotask
 * boundary. Bounded so a genuine regression fails the assertion immediately
 * instead of hanging the suite.
 */
async function waitFor(predicate, { maxTicks = 200, message = 'condition' } = {}) {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  assert.fail(`${message} (did not become true within ${maxTicks} microtask ticks)`);
}

/**
 * Bounded microtask flush used only where a fixed deterministic anchor exists
 * (e.g. a fake generator's own `finally`) but the pool's *own* async-generator
 * drain loop needs a few more microtask hops after that anchor to run its
 * matching `finally`. Not a predicate poll: there is no pool-observable state
 * that distinguishes "not yet" from "already ran as a guarded no-op" here, so
 * this is a fixed, generous tick budget rather than a wall-clock guess.
 */
async function flushMicrotasks(ticks = 50) {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

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
  const turnStarted = createDeferred();

  const pending = claudeSessionPool.runTurn({
    appSessionId: 's4',
    userMessage: userMessage('long'),
    sdkOptions: {},
    onMessage: () => turnStarted.resolve(),
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  // Wait for the turn to actually be mid-stream (the 'assistant' message
  // routed) before interrupting it, instead of guessing a wall-clock delay.
  await turnStarted.promise;
  assert.equal(claudeSessionPool.settleTurn('s4', 'aborted'), true);

  const result = await pending;
  assert.equal(result.subtype, 'aborted');
  assert.equal(state.closed, false);

  claudeSessionPool.closeSession('s4');
});

test('interruptTurn calls the live query\'s interrupt() without closing the process', async () => {
  claudeSessionPool._resetForTests();
  const { factory, state } = createFakeQuery([[{ type: 'assistant', text: 'working' }]]);
  const turnStarted = createDeferred();

  const pending = claudeSessionPool.runTurn({
    appSessionId: 's8',
    userMessage: userMessage('long'),
    sdkOptions: {},
    onMessage: () => turnStarted.resolve(),
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  await turnStarted.promise;
  assert.equal(await claudeSessionPool.interruptTurn('s8'), true);
  assert.equal(state.interrupted, true);
  assert.equal(state.closed, false, 'interruptTurn must not close the process');

  // The interrupted turn itself still needs settling — interruptTurn only
  // reaches the SDK's interrupt(), it is not a replacement for settleTurn.
  claudeSessionPool.settleTurn('s8', 'aborted');
  await pending;
  claudeSessionPool.closeSession('s8');
});

test('interruptTurn on a missing session is a silent no-op', async () => {
  claudeSessionPool._resetForTests();
  assert.equal(await claudeSessionPool.interruptTurn('does-not-exist'), false);
});

/**
 * Fix-round-1 finding: a synchronous `getLiveTaskIds().length === 0 ->
 * closeSession()` check performed from OUTSIDE the drain loop (the OLD
 * `abortClaudeSDKSession`) can only ever see a stale/incomplete snapshot — a
 * `task_started` message the CLI already sent may not have been routed by
 * `routeMessage` yet. The fix removes that external check entirely; abort
 * now only calls `settleTurn`, which arms the SAME deferred idle-close timer
 * `routeMessage`'s between-turn path already uses, so the close decision is
 * always made `IDLE_GRACE_MS` later, from inside the drain loop's own
 * ordering, by which point any in-flight message has certainly been routed.
 *
 * The full interrupt/settle race against a real (mocked-SDK) `abortClaudeSDKSession`
 * call is exercised end-to-end in `server/claude-sdk-abort-race.test.ts` —
 * that is the test that would have failed against the OLD code. This test
 * instead verifies `settleTurn`'s own contribution in isolation: an aborted
 * session with NO live task and no further messages must still eventually
 * close (previously it would leak forever, since old `settleTurn` armed
 * nothing), and — reusing `closeIfIdle`'s existing re-check — must not close
 * while a task is still live even once the grace timer fires.
 */
test('settleTurn on an idle session arms a deferred close, so an aborted session with no background work does not leak forever', async (t) => {
  claudeSessionPool._resetForTests();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { factory, state } = createFakeQuery([[{ type: 'assistant', text: 'working' }]]);
  const turnStarted = createDeferred();

  const pending = claudeSessionPool.runTurn({
    appSessionId: 'idle-abort-1',
    userMessage: userMessage('long, then abort with nothing backgrounded'),
    sdkOptions: {},
    onMessage: () => turnStarted.resolve(),
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  await turnStarted.promise;
  assert.equal(await claudeSessionPool.interruptTurn('idle-abort-1'), true);
  assert.equal(claudeSessionPool.settleTurn('idle-abort-1', 'aborted'), true);
  await pending;

  // No live task, nothing else will ever message this session again — the
  // OLD settleTurn armed no timer here, so this session would stay live
  // (leak) until process shutdown. The fix arms one.
  assert.equal(state.closed, false, 'must not close synchronously — give the grace window a chance');
  t.mock.timers.tick(60000);
  assert.equal(state.closed, true, 'an idle aborted session must still eventually close, not leak forever');

  t.mock.timers.reset();
});

test('settleTurn\'s deferred close still respects a live task at fire time', async (t) => {
  claudeSessionPool._resetForTests();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const state = { closed: false };
  const releaseTaskStarted = createDeferred();

  const factory = ({ prompt }) => {
    const generator = (async function* run() {
      for await (const _userMessage of prompt) {
        await releaseTaskStarted.promise;
        yield { type: 'system', subtype: 'task_started', task_id: 'racer' };
        // No `result` — matches an interrupted turn (spike-verified).
      }
    })();
    generator.interrupt = async () => { releaseTaskStarted.resolve(); };
    generator.close = () => { state.closed = true; };
    return generator;
  };

  const pending = claudeSessionPool.runTurn({
    appSessionId: 'race-1',
    userMessage: userMessage('start bg then abort'),
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  assert.equal(await claudeSessionPool.interruptTurn('race-1'), true);
  assert.equal(claudeSessionPool.settleTurn('race-1', 'aborted'), true);
  const result = await pending;
  assert.equal(result.subtype, 'aborted');

  await waitFor(() => claudeSessionPool.getLiveTaskIds('race-1').length > 0, {
    message: 'task_started must be tracked once routed',
  });
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('race-1'), ['racer']);

  // The deferred timer armed by settleTurn fires here — closeIfIdle must
  // re-check liveTaskIds at THIS point (not the stale snapshot from when the
  // timer was armed) and bail.
  t.mock.timers.tick(60000);
  assert.equal(state.closed, false, 'must not close while the task is still live, even once the grace timer fires');
  assert.equal(claudeSessionPool.hasLiveSession('race-1'), true);

  claudeSessionPool.closeSession('race-1');
  t.mock.timers.reset();
});

/**
 * Fake `query()` that counts how many times the factory itself is invoked
 * (i.e. how many "processes" were spawned), with a separate message script
 * per invocation. Used to prove that a superseded session's drain loop
 * finishing late does not cause a spurious extra process to be spawned.
 */
function createCountingFakeQuery(scriptPerInvocation) {
  const invocations = [];

  const factory = ({ prompt }) => {
    const invocationIndex = invocations.length;
    const finished = createDeferred();
    const record = { closed: false, interrupted: false, turns: 0, finished: finished.promise };
    invocations.push(record);

    const generator = (async function* run() {
      try {
        for await (const userMessage of prompt) {
          void userMessage;
          const turns = scriptPerInvocation[invocationIndex] ?? [];
          const script = turns[record.turns] ?? [{ type: 'result', subtype: 'success' }];
          record.turns += 1;
          for (const message of script) {
            yield message;
          }
        }
      } finally {
        // Resolves once THIS generator's own body has fully unwound (its
        // prompt was closed and its `for await` returned). The pool's own
        // drain loop finishes its matching `finally` a few more microtask
        // hops after this — see `flushMicrotasks` at the call site.
        finished.resolve();
      }
    })();

    generator.interrupt = async () => { record.interrupted = true; };
    generator.close = () => { record.closed = true; };
    return generator;
  };

  return { factory, invocations };
}

test('a superseded session drain finishing late does not delete the new session (race regression)', async () => {
  claudeSessionPool._resetForTests();

  const { factory, invocations } = createCountingFakeQuery([
    // Invocation 0 ("session A"): turn 0 starts a background task, so A is
    // still registered afterwards — we then force-close it explicitly.
    [[{ type: 'system', subtype: 'task_started', task_id: 't1' }, { type: 'result', subtype: 'success' }]],
    // Invocation 1 ("session B"): turn 0 starts its own background task, so
    // B stays registered too, then turn 1 clears it out.
    [
      [{ type: 'assistant', text: 'from-b' }, { type: 'system', subtype: 'task_started', task_id: 't2' }, { type: 'result', subtype: 'success' }],
      [{ type: 'system', subtype: 'task_updated', task_id: 't2', patch: { status: 'completed' } }, { type: 'result', subtype: 'success' }],
    ],
  ]);

  const appSessionId = 's5';
  const common = { appSessionId, sdkOptions: {}, onMessage: () => {}, onBetweenTurnMessage: () => {}, createQuery: factory };

  // Turn 0 on session A: leaves a live task, so A is not auto-closed.
  await claudeSessionPool.runTurn({ ...common, userMessage: userMessage('a-one') });
  assert.equal(claudeSessionPool.hasLiveSession(appSessionId), true);
  assert.equal(invocations.length, 1);

  // Force-close A. This synchronously deletes A's entry from the pool's map,
  // but A's fake generator (like the real CLI) does not actually finish
  // until a later microtask — that gap is exactly what the race needs.
  claudeSessionPool.closeSession(appSessionId);
  assert.equal(claudeSessionPool.hasLiveSession(appSessionId), false);

  // Immediately (same tick, no await in between) start a new turn for the
  // same appSessionId — this creates session B before A's drain loop has
  // had a chance to run its `finally`.
  await claudeSessionPool.runTurn({ ...common, userMessage: userMessage('b-one') });
  assert.equal(invocations.length, 2, 'must have spawned exactly one new process for B');
  assert.equal(claudeSessionPool.hasLiveSession(appSessionId), true, 'B must be registered');
  assert.deepEqual(claudeSessionPool.getLiveTaskIds(appSessionId), ['t2'], 'B\'s live task must be tracked');

  // Wait for A's own generator body to fully unwind (deterministic: it
  // resolves in the fake's own `finally`, not on a wall-clock guess), then
  // flush a bounded number of extra microtask ticks so the pool's own drain
  // loop — which finishes its matching `finally` a few hops after the
  // generator itself returns — has run its course. If the identity guard in
  // `removeFromLiveIfCurrent` were missing, this is exactly where it would
  // clobber B's entry.
  await invocations[0].finished;
  await flushMicrotasks();

  assert.equal(claudeSessionPool.hasLiveSession(appSessionId), true, 'B must still be registered after A fully unwinds');
  assert.deepEqual(claudeSessionPool.getLiveTaskIds(appSessionId), ['t2'], 'B\'s live task must still be tracked');

  // A subsequent turn must reuse B, not spawn a third process.
  await claudeSessionPool.runTurn({ ...common, userMessage: userMessage('b-two') });
  assert.equal(invocations.length, 2, 'must not have spawned a third process');
  assert.equal(claudeSessionPool.hasLiveSession(appSessionId), false, 'B closes once its task completes and no turn is in flight');

  claudeSessionPool.closeSession(appSessionId);
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
  const notificationReceived = createDeferred();
  await claudeSessionPool.runTurn({
    appSessionId: 's7',
    userMessage: userMessage('start bg'),
    sdkOptions: {},
    onMessage: (m) => inTurn.push(m),
    onBetweenTurnMessage: (m) => {
      betweenTurn.push(m);
      notificationReceived.resolve();
    },
    createQuery: factory,
  });

  // The notification is yielded by the fake generator on the SAME turn but
  // after the `result` that already resolved `runTurn`'s promise above, so
  // it is routed on a later microtask. Wait for the actual event (the sink
  // callback firing) instead of guessing a wall-clock delay.
  await notificationReceived.promise;

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
  // `runTurn` resolves as soon as the `result` message settles the turn, but
  // task `t1` is still live at that instant (closeIfIdle keeps the session
  // open) — the generator's `return` (ending the process) is only reached on
  // the drain loop's NEXT tick. Poll the actual state instead of guessing how
  // long that takes; the predicate is genuinely false at tick 0.
  await waitFor(() => !claudeSessionPool.hasLiveSession('s8'), {
    message: 'session s8 should have gone dead once its generator returned',
  });
  assert.equal(claudeSessionPool.hasLiveSession('s8'), false, 'generator ended, session is dead');

  await claudeSessionPool.runTurn({ ...common, userMessage: userMessage('two') });
  assert.equal(built, 2, 'a fresh query must be created');
});
