// server/claude-session-pool.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import { claudeSessionPool } from './claude-session-pool.js';

/**
 * Fake `query()`: consumes the input stream and emits whatever the scenario
 * queues per turn. Mirrors the real SDK shape — an AsyncGenerator with control
 * methods — without spawning a CLI.
 */
function createFakeQuery(scriptPerTurn, {
  omitSetPermissionMode = false,
  omitApplyFlagSettings = false,
  // Which applyFlagSettings() calls throw, by 0-based call index.
  applyFlagSettingsFailsOn = () => false,
  // A CLI that refuses the interrupt control request (or whose transport is
  // already gone) — the one case that genuinely produces no turn terminator.
  interruptFails = false,
} = {}) {
  const state = {
    closed: false,
    interrupted: false,
    turns: 0,
    prompts: [],
    permissionModes: [],
    models: [],
    flagSettings: [],
  };

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

    generator.interrupt = async () => {
      state.interrupted = true;
      if (interruptFails) {
        throw new Error('interrupt refused by the fake process');
      }
    };
    generator.close = () => { state.closed = true; };
    // The two real streaming-input-only control requests the pool uses to
    // reconfigure a process it must not close.
    if (!omitSetPermissionMode) {
      generator.setPermissionMode = async (mode) => { state.permissionModes.push(mode); };
    }
    generator.setModel = async (model) => { state.models.push(model); };
    // The control request that pushes tool permissions into the RUNNING CLI's own
    // permission engine — the only thing that can tighten a tool the CLI is
    // already auto-approving from its spawn-time allowlist.
    if (!omitApplyFlagSettings) {
      let applyCalls = 0;
      generator.applyFlagSettings = async (settings) => {
        const callIndex = applyCalls;
        applyCalls += 1;
        if (applyFlagSettingsFailsOn(callIndex)) {
          throw new Error('control request refused by the fake process');
        }
        state.flagSettings.push(settings);
      };
    }
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
  // Turn one never emits a result — what a turn whose terminator never arrives
  // looks like, i.e. a FAILED interrupt (a successful one DOES terminate; see
  // spikes/streaming-input-mode/interrupt-result.mjs).
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

  // This fake never emits a terminator, so the interrupted turn is settled here
  // by hand — the same job `interruptTurn`'s timed fallback does in production.
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

/**
 * Final-review CRITICAL: a reused live process kept running turn 1's options.
 * The SDK holds the options object `query()` was constructed with — including
 * the `canUseTool` closure that reads `permissionMode` / `allowedTools` /
 * `disallowedTools` — so a user who switched from `bypassPermissions` to
 * `default`, or unchecked a tool, was still evaluated against the settings they
 * had abandoned. The four tests below pin both halves of the fix: recreate when
 * nothing is at stake, reconfigure in place when a background task must survive.
 */
test('a live session with NO background task is recreated when the turn\'s options changed', async () => {
  claudeSessionPool._resetForTests();
  const { factory, invocations } = createCountingFakeQuery([
    // Invocation 0: turn 0 emits no `result` — what an interrupted turn looks
    // like. Settling it leaves the session live with nothing to protect, which
    // is the only way a task-free session survives a turn boundary.
    [[{ type: 'assistant', text: 'working' }]],
    [[{ type: 'result', subtype: 'success' }]],
  ]);

  const turnOneStarted = createDeferred();
  const pending = claudeSessionPool.runTurn({
    appSessionId: 'opts-idle',
    userMessage: userMessage('one'),
    sdkOptions: { permissionMode: 'bypassPermissions', allowedTools: ['Bash'], disallowedTools: [] },
    onMessage: () => turnOneStarted.resolve(),
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  await turnOneStarted.promise;
  assert.equal(claudeSessionPool.settleTurn('opts-idle', 'aborted'), true);
  await pending;

  assert.equal(claudeSessionPool.hasLiveSession('opts-idle'), true, 'the abort grace window keeps it live');
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('opts-idle'), [], 'and there is nothing to protect');

  await claudeSessionPool.runTurn({
    appSessionId: 'opts-idle',
    userMessage: userMessage('two'),
    sdkOptions: { permissionMode: 'default', allowedTools: [], disallowedTools: ['Bash'] },
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    // These fakes expose no setPermissionMode(), so an attempt to reconfigure
    // in place here would throw — the recreate path is the only one that passes.
    createQuery: factory,
  });

  assert.equal(invocations.length, 2, 'a stale-options session must be closed and recreated');
  assert.equal(invocations[0].closed, true, 'the process carrying the stale options must actually be closed');

  claudeSessionPool.closeSession('opts-idle');
});

test('a live session WITH a background task keeps its process and is reconfigured in place', async () => {
  claudeSessionPool._resetForTests();
  const { factory, state } = createFakeQuery([
    [{ type: 'system', subtype: 'task_started', task_id: 'survivor' }, { type: 'result', subtype: 'success' }],
    [{ type: 'result', subtype: 'success' }],
  ]);

  // Stands in for the object `claude-sdk.js` hands over: the SDK captures this
  // exact reference on turn 1, so the pool must update it IN PLACE rather than
  // swap it, or the captured approval callback keeps reading turn 1's values.
  const capturedContext = {
    ws: 'writer-for-turn-1',
    permissionMode: 'bypassPermissions',
    allowedTools: ['Bash'],
    disallowedTools: [],
  };

  await claudeSessionPool.runTurn({
    appSessionId: 'opts-live',
    userMessage: userMessage('start a long shell'),
    sdkOptions: { permissionMode: 'bypassPermissions', allowedTools: ['Bash'], disallowedTools: [], model: 'sonnet' },
    turnContext: capturedContext,
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  assert.deepEqual(claudeSessionPool.getLiveTaskIds('opts-live'), ['survivor']);

  await claudeSessionPool.runTurn({
    appSessionId: 'opts-live',
    userMessage: userMessage('now with tightened settings'),
    sdkOptions: { permissionMode: 'default', allowedTools: [], disallowedTools: ['Bash'], model: 'opus' },
    turnContext: {
      ws: 'writer-for-turn-2',
      permissionMode: 'default',
      allowedTools: [],
      disallowedTools: ['Bash'],
    },
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  assert.equal(state.turns, 2, 'both turns must run on the same process');
  assert.equal(state.closed, false, 'closing to apply new options would kill the background shell');
  assert.deepEqual(state.permissionModes, ['default'], 'the mode change must reach the live process');
  assert.deepEqual(state.models, ['opus'], 'the model change must reach the live process');
  assert.deepEqual(
    state.flagSettings,
    [{ permissions: { ask: [], deny: ['Bash'] } }],
    'Bash was in the spawn allowlist, so only a rule inside the CLI can stop it auto-approving; disallowed means deny',
  );
  assert.deepEqual(
    capturedContext,
    { ws: 'writer-for-turn-2', permissionMode: 'default', allowedTools: [], disallowedTools: ['Bash'] },
    'the captured context must now describe turn 2 — writer included, so this turn\'s frames go to this turn\'s writer',
  );

  claudeSessionPool.closeSession('opts-live');
});

test('unchanged options on a reused session issue no control requests', async () => {
  claudeSessionPool._resetForTests();
  const { factory, state } = createFakeQuery([
    [{ type: 'system', subtype: 'task_started', task_id: 'survivor' }, { type: 'result', subtype: 'success' }],
    [{ type: 'result', subtype: 'success' }],
  ]);

  const common = {
    appSessionId: 'opts-same',
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  };

  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('one'),
    sdkOptions: { permissionMode: 'default', allowedTools: ['Agent', 'Task'], disallowedTools: [] },
  });
  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('two'),
    // Same values, different object and different list order: not a change.
    sdkOptions: { permissionMode: 'default', allowedTools: ['Task', 'Agent'], disallowedTools: [] },
  });

  assert.equal(state.turns, 2);
  assert.deepEqual(state.permissionModes, []);
  assert.deepEqual(state.models, []);
  assert.deepEqual(state.flagSettings, [], 'nothing changed, so the CLI\'s permission engine must not be touched');

  claudeSessionPool.closeSession('opts-same');
});

/**
 * The gap final review flagged as untested, and the security regression this
 * whole round exists to close: a tool the user UN-CHECKS is removed from
 * `allowedTools` and does NOT appear in `disallowedTools`. ccui's `canUseTool`
 * treats "on neither list" as "prompt the user" — but on a protected live
 * session the callback is never reached at all, because the CLI auto-approves
 * from the `--allowedTools` list it was spawned with (measured in
 * `spikes/streaming-input-mode/live-deny.mjs` STEP 1). Refreshing `turnContext`
 * therefore fixes nothing here; only a rule pushed into the CLI does. It has to
 * be `ask` rather than `deny`, so the user keeps the ability to approve on
 * demand exactly as they would against a freshly spawned process (STEP 4:
 * PROMPTED; STEP 6: DENIED).
 */
test('a tool merely un-checked on a protected session becomes an ask rule inside the live CLI', async () => {
  claudeSessionPool._resetForTests();
  const { factory, state } = createFakeQuery([
    [{ type: 'system', subtype: 'task_started', task_id: 'survivor' }, { type: 'result', subtype: 'success' }],
    [{ type: 'result', subtype: 'success' }],
    [{ type: 'result', subtype: 'success' }],
  ]);

  const common = {
    appSessionId: 'opts-uncheck',
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  };

  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('one'),
    sdkOptions: { allowedTools: ['Bash', 'Write', 'Agent', 'Task'], disallowedTools: [] },
  });
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('opts-uncheck'), ['survivor']);

  // Turn 2: the user un-checked Bash. It is on NEITHER list now.
  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('two'),
    sdkOptions: { allowedTools: ['Write', 'Agent', 'Task'], disallowedTools: [] },
  });

  assert.equal(state.turns, 2, 'the process must be reused — recreating it kills the background shell');
  assert.equal(state.closed, false);
  assert.deepEqual(
    state.flagSettings,
    [{ permissions: { ask: ['Bash'], deny: [] } }],
    'the un-checked tool must stop being auto-approved, and must prompt rather than hard-fail',
  );

  // Turn 3: the user re-checks Bash. The restriction must lift, or a tool can
  // never be re-enabled for the lifetime of a long-held process.
  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('three'),
    sdkOptions: { allowedTools: ['Bash', 'Write', 'Agent', 'Task'], disallowedTools: [] },
  });

  assert.deepEqual(
    state.flagSettings[1],
    { permissions: null },
    'nothing left to restrict, so our flag layer is cleared rather than left as an empty object above the user\'s own settings',
  );

  claudeSessionPool.closeSession('opts-uncheck');
});

test('a shrinking allowedTools that cannot be pushed into a protected process rejects the turn', async () => {
  claudeSessionPool._resetForTests();
  const { factory, state } = createFakeQuery(
    [
      [{ type: 'system', subtype: 'task_started', task_id: 'survivor' }, { type: 'result', subtype: 'success' }],
      [{ type: 'result', subtype: 'success' }],
    ],
    { omitApplyFlagSettings: true },
  );

  const common = {
    appSessionId: 'opts-no-flags',
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  };

  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('one'),
    sdkOptions: { allowedTools: ['Bash'], disallowedTools: [] },
  });

  // Fail closed. Proceeding would run the turn with Bash still auto-approved
  // inside the CLI, and closing the process would kill the background task.
  await assert.rejects(
    () => claudeSessionPool.runTurn({
      ...common,
      userMessage: userMessage('two'),
      sdkOptions: { allowedTools: [], disallowedTools: [] },
    }),
    /applyFlagSettings/,
  );

  assert.equal(state.turns, 1, 'the refused turn must not have run');
  assert.equal(state.closed, false, 'the background task must survive the refusal');
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('opts-no-flags'), ['survivor']);

  claudeSessionPool.closeSession('opts-no-flags');
});

test('a failing applyFlagSettings rejects a tightening turn', async () => {
  claudeSessionPool._resetForTests();
  const { factory, state } = createFakeQuery(
    [
      [{ type: 'system', subtype: 'task_started', task_id: 'survivor' }, { type: 'result', subtype: 'success' }],
      [{ type: 'result', subtype: 'success' }],
    ],
    { applyFlagSettingsFailsOn: () => true },
  );

  const common = {
    appSessionId: 'opts-flags-throw',
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  };

  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('one'),
    sdkOptions: { allowedTools: ['Bash'], disallowedTools: [] },
  });

  await assert.rejects(
    () => claudeSessionPool.runTurn({
      ...common,
      userMessage: userMessage('two'),
      sdkOptions: { allowedTools: [], disallowedTools: ['Bash'] },
    }),
    /control request refused by the fake process/,
  );

  assert.equal(state.turns, 1, 'the refused turn must not have run');
  assert.equal(state.closed, false, 'the background task must survive the refusal');

  claudeSessionPool.closeSession('opts-flags-throw');
});

test('a failing applyFlagSettings does NOT reject a turn that only relaxes permissions', async () => {
  claudeSessionPool._resetForTests();
  // Call 0 is the tightening (it must succeed, so a restriction is on record);
  // call 1 is the relaxation that clears it, and that one fails.
  const { factory, state } = createFakeQuery(
    [
      [{ type: 'system', subtype: 'task_started', task_id: 'survivor' }, { type: 'result', subtype: 'success' }],
      [{ type: 'result', subtype: 'success' }],
      [{ type: 'result', subtype: 'success' }],
    ],
    { applyFlagSettingsFailsOn: (callIndex) => callIndex === 1 },
  );

  const common = {
    appSessionId: 'opts-flags-relax',
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  };

  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('one'),
    sdkOptions: { allowedTools: ['Bash'], disallowedTools: [] },
  });
  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('two'),
    sdkOptions: { allowedTools: [], disallowedTools: [] },
  });
  assert.deepEqual(state.flagSettings, [{ permissions: { ask: ['Bash'], deny: [] } }]);

  // Turn 3 re-checks Bash: the only consequence of failing to clear the rule is
  // that the user gets prompted when they need not have been. Nothing is
  // exposed, so blocking their work here would be gratuitous.
  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('three'),
    sdkOptions: { allowedTools: ['Bash'], disallowedTools: [] },
  });

  assert.equal(state.turns, 3, 'a failed RELAXATION must not stop the turn');
  assert.equal(state.closed, false);

  // Turn 4 asks for the exact same relaxation again. If the failed push in
  // turn 3 had advanced the reconciliation snapshot anyway, this identical
  // request would look "already applied" and the pool would never retry —
  // the process would keep denying Bash for the rest of its life while the UI
  // shows it enabled. It must actually call applyFlagSettings() again here.
  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('four'),
    sdkOptions: { allowedTools: ['Bash'], disallowedTools: [] },
  });
  assert.deepEqual(
    state.flagSettings,
    [
      { permissions: { ask: ['Bash'], deny: [] } },
      // `derivePermissionOverrides` collapses an empty ask/deny pair to `null`
      // so the caller clears the layer entirely instead of pushing an empty one.
      { permissions: null },
    ],
    'turn 4 must retry the relaxation push that turn 3 failed to apply',
  );

  // Turn 5 repeats the same request once more: the retry succeeded, so there
  // is nothing left to reconcile and no further push should happen.
  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('five'),
    sdkOptions: { allowedTools: ['Bash'], disallowedTools: [] },
  });
  assert.equal(state.flagSettings.length, 2, 'once the retry succeeds, an identical turn must not push again');

  assert.equal(state.turns, 5, 'a failed RELAXATION must not stop the turn');
  assert.equal(state.closed, false);

  claudeSessionPool.closeSession('opts-flags-relax');
});

test('a permission-mode change that cannot be applied to a protected process rejects the turn', async () => {
  claudeSessionPool._resetForTests();
  const { factory, state } = createFakeQuery(
    [
      [{ type: 'system', subtype: 'task_started', task_id: 'survivor' }, { type: 'result', subtype: 'success' }],
      [{ type: 'result', subtype: 'success' }],
    ],
    { omitSetPermissionMode: true },
  );

  const common = {
    appSessionId: 'opts-no-control',
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  };

  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('one'),
    sdkOptions: { permissionMode: 'bypassPermissions' },
  });

  // Fail closed: running the turn anyway would auto-approve against the mode
  // the user just left behind, and closing the process would kill the task.
  await assert.rejects(
    () => claudeSessionPool.runTurn({
      ...common,
      userMessage: userMessage('two'),
      sdkOptions: { permissionMode: 'default' },
    }),
    /setPermissionMode/,
  );

  assert.equal(state.closed, false, 'the background task must survive the refusal');
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('opts-no-control'), ['survivor']);

  claudeSessionPool.closeSession('opts-no-control');
});

/**
 * Final-review IMPORTANT 2: a task settling while a LATER turn is in flight was
 * routed only to that turn, where the role-keyed normalizer
 * (claude-sessions.provider.ts) turns a `system`/`task_notification` frame into
 * `[]` — so a completion, and worse a reaper kill (`status: 'stopped'`), was
 * silently lost. Goal 3 of the design forbids exactly that.
 */
test('a task_notification arriving DURING a later turn still reaches the session sink', async () => {
  claudeSessionPool._resetForTests();
  const { factory } = createFakeQuery([
    [{ type: 'system', subtype: 'task_started', task_id: 'reaped' }, { type: 'result', subtype: 'success' }],
    [
      { type: 'system', subtype: 'task_notification', task_id: 'reaped', status: 'stopped', output_file: '/tmp/reaped.output', summary: 'killed under memory pressure' },
      { type: 'result', subtype: 'success' },
    ],
  ]);

  const common = {
    appSessionId: 'mid-turn-settle',
    sdkOptions: {},
    createQuery: factory,
  };

  await claudeSessionPool.runTurn({ ...common, userMessage: userMessage('one'), onMessage: () => {}, onBetweenTurnMessage: () => {} });
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('mid-turn-settle'), ['reaped']);

  const sink = [];
  const inTurn = [];
  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('two'),
    onMessage: (m) => inTurn.push(m),
    onBetweenTurnMessage: (m) => sink.push(m),
  });

  assert.deepEqual(sink.map((m) => m.subtype), ['task_notification'], 'the settlement must reach the sink even mid-turn');
  assert.equal(sink[0].status, 'stopped');
  assert.equal(sink[0].output_file, '/tmp/reaped.output');
  assert.deepEqual(inTurn.map((m) => m.subtype), ['task_notification'], 'and still pass through the turn, as before');
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('mid-turn-settle'), [], 'the task is no longer live');
});

/**
 * Final-review IMPORTANT 4: `server/index.js` exits via `process.exit(0)`. A
 * pooled process deliberately outlives its turn, so without an explicit close
 * a ~320 MB `claude` child is orphaned indefinitely rather than for the
 * seconds-wide window per-turn processes used to have.
 */
test('closeAllSessions closes every live process, so shutdown cannot orphan one', async () => {
  claudeSessionPool._resetForTests();
  const first = createFakeQuery([[{ type: 'system', subtype: 'task_started', task_id: 'a' }, { type: 'result', subtype: 'success' }]]);
  const second = createFakeQuery([[{ type: 'system', subtype: 'task_started', task_id: 'b' }, { type: 'result', subtype: 'success' }]]);

  for (const [appSessionId, fake] of [['shutdown-1', first], ['shutdown-2', second]]) {
    await claudeSessionPool.runTurn({
      appSessionId,
      userMessage: userMessage('start bg'),
      sdkOptions: {},
      onMessage: () => {},
      onBetweenTurnMessage: () => {},
      createQuery: fake.factory,
    });
  }

  assert.equal(claudeSessionPool.hasLiveSession('shutdown-1'), true);
  assert.equal(claudeSessionPool.hasLiveSession('shutdown-2'), true);

  assert.equal(claudeSessionPool.closeAllSessions(), 2);
  assert.equal(first.state.closed, true);
  assert.equal(second.state.closed, true);
  assert.equal(claudeSessionPool.hasLiveSession('shutdown-1'), false);
  assert.equal(claudeSessionPool.hasLiveSession('shutdown-2'), false);
});

/**
 * Turn identity & abort semantics. One long-lived drain loop now serves many
 * turns and answers "which turn is this frame for?" from a single mutable slot,
 * so every defect below is a slot released too early or claimed too late.
 *
 * The measurement these tests are built on: an interrupted turn DOES emit a
 * terminating `result` (`subtype: 'error_during_execution'`, within
 * milliseconds — `spikes/streaming-input-mode/interrupt-result.mjs`), and
 * `SDKResultMessage` carries no turn-correlation field. So a frame arriving
 * after the slot has been reused cannot be attributed back to its own turn:
 * the slot must never be vacant while the CLI may still be emitting for it.
 */

test('interruptTurn propagates a failed interrupt() instead of reporting success', async () => {
  claudeSessionPool._resetForTests();
  const { factory, state } = createFakeQuery(
    [[{ type: 'assistant', text: 'working' }, { type: 'assistant', text: 'still working' }]],
    { interruptFails: true },
  );
  const turnStarted = createDeferred();
  const routed = [];

  const pending = claudeSessionPool.runTurn({
    appSessionId: 'int-fail',
    userMessage: userMessage('long'),
    sdkOptions: {},
    onMessage: (m) => {
      routed.push(m);
      turnStarted.resolve();
    },
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  await turnStarted.promise;

  // Swallowing this made `abortClaudeSDKSession`'s catch unreachable — the only
  // place that undoes `abortedSessionIds.add()`. The user was shown a clean
  // "stopped" while the CLI kept generating an answer nobody would ever see.
  await assert.rejects(
    () => claudeSessionPool.interruptTurn('int-fail'),
    /interrupt refused by the fake process/,
  );
  assert.equal(state.interrupted, true);
  assert.equal(state.closed, false, 'a failed interrupt must not take the process down');

  // The stop did not happen, so the run is still the user's run: its frames
  // must keep flowing rather than being suppressed as "aborted".
  await waitFor(() => routed.length === 2, { message: 'a non-interrupted turn keeps streaming' });

  claudeSessionPool.settleTurn('int-fail', 'aborted');
  await pending;
  claudeSessionPool.closeSession('int-fail');
});

test('interruptTurn on a dead session is still a no-op, not a failure', async () => {
  claudeSessionPool._resetForTests();
  const factory = ({ prompt }) => {
    const generator = (async function* run() {
      for await (const _message of prompt) {
        yield { type: 'result', subtype: 'success' };
        return; // generator ends -> process gone
      }
    })();
    generator.interrupt = async () => { throw new Error('the transport is gone'); };
    generator.close = () => {};
    return generator;
  };

  await claudeSessionPool.runTurn({
    appSessionId: 'int-dead',
    userMessage: userMessage('one'),
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  await waitFor(() => !claudeSessionPool.hasLiveSession('int-dead'), {
    message: 'the session should be dead once its generator returned',
  });
  assert.equal(await claudeSessionPool.interruptTurn('int-dead'), false);
  assert.equal(await claudeSessionPool.interruptTurn('never-existed'), false);
});

test('an aborted turn stops receiving frames but is still settled by its own terminator', async () => {
  claudeSessionPool._resetForTests();
  const postInterrupt = createDeferred();
  const state = { closed: false };

  const factory = ({ prompt }) => {
    const generator = (async function* run() {
      for await (const _message of prompt) {
        yield { type: 'assistant', text: 'before-stop' };
        // Released by the test AFTER interruptTurn has returned, so the
        // ordering under test is fixed rather than left to microtask luck.
        await postInterrupt.promise;
        yield { type: 'assistant', text: 'after-stop' };
        yield { type: 'result', subtype: 'error_during_execution' };
      }
    })();
    generator.interrupt = async () => {};
    generator.close = () => { state.closed = true; };
    return generator;
  };

  const routed = [];
  const turnStarted = createDeferred();
  const pending = claudeSessionPool.runTurn({
    appSessionId: 'abort-suppress',
    userMessage: userMessage('long'),
    sdkOptions: {},
    onMessage: (m) => {
      routed.push(m);
      turnStarted.resolve();
    },
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  await turnStarted.promise;
  assert.equal(await claudeSessionPool.interruptTurn('abort-suppress'), true);
  postInterrupt.resolve();

  const result = await pending;
  assert.equal(
    result.subtype,
    'error_during_execution',
    'the turn must be settled by the CLI\'s own terminator, not by abort guessing',
  );
  assert.deepEqual(
    routed.map((m) => m.text),
    ['before-stop'],
    'the user pressed Stop: no further text may appear, even though the slot is kept',
  );
  assert.equal(state.closed, true, 'nothing left to protect, so the settled turn closes the process');
});

test('an aborted turn whose terminator never arrives settles via the timed fallback', async (t) => {
  claudeSessionPool._resetForTests();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  // No `result` at all — a FAILED interrupt is the one case that really
  // produces no terminator, and the slot must not be held forever for it.
  const { factory, state } = createFakeQuery([[{ type: 'assistant', text: 'working' }]]);
  const turnStarted = createDeferred();

  let settled = null;
  const pending = claudeSessionPool.runTurn({
    appSessionId: 'abort-fallback',
    userMessage: userMessage('long'),
    sdkOptions: {},
    onMessage: () => turnStarted.resolve(),
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });
  pending.then((result) => { settled = result; });

  await turnStarted.promise;
  assert.equal(await claudeSessionPool.interruptTurn('abort-fallback'), true);

  await flushMicrotasks();
  assert.equal(settled, null, 'the slot is deliberately still held: the real terminator may yet arrive');

  t.mock.timers.tick(5000);
  await flushMicrotasks();
  assert.equal(settled?.subtype, 'aborted', 'the fallback must settle it, or the run hangs in "processing" forever');
  await pending;

  // And the fallback leaves the session in the same shape settleTurn does: an
  // idle aborted session eventually closes rather than leaking.
  assert.equal(state.closed, false, 'not synchronously — the grace window still applies');
  t.mock.timers.tick(60000);
  assert.equal(state.closed, true);

  t.mock.timers.reset();
});

/**
 * TOCTOU on the turn slot. The guard ran, then reconciliation awaited, then the
 * slot was claimed inside the returned Promise's executor — so two calls for
 * one session could both pass the guard and the second would overwrite the
 * first's resolve/reject: the first's promise never settled (its run hangs in
 * "processing") and its frames were delivered to the second caller's writer.
 * Reachable in production because only the websocket path is serialised by
 * `chatRunRegistry`; the REST entry point (`server/routes/agent.js`) is not.
 */
// Timeout, not an unbounded await: against the unfixed code the second call
// suspends on the same gate as the first instead of rejecting, so
// `assert.rejects` would never settle and the suite would hang rather than fail.
test('a second turn cannot take over the slot while the first is still reconciling options', { timeout: 5000 }, async () => {
  claudeSessionPool._resetForTests();
  const gate = createDeferred();
  const modes = [];
  let turns = 0;

  const factory = ({ prompt }) => {
    const generator = (async function* run() {
      for await (const _message of prompt) {
        turns += 1;
        if (turns === 1) {
          yield { type: 'system', subtype: 'task_started', task_id: 'survivor' };
          yield { type: 'result', subtype: 'success' };
        } else {
          yield { type: 'assistant', text: `turn-${turns}` };
          yield { type: 'result', subtype: 'success' };
        }
      }
    })();
    generator.interrupt = async () => {};
    generator.close = () => {};
    generator.setPermissionMode = async (mode) => {
      modes.push(mode);
      await gate.promise;
    };
    return generator;
  };

  const common = {
    appSessionId: 'toctou',
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  };

  // Turn 1 leaves a live background task, so the session must be reconfigured
  // in place from here on — closing it would kill the task.
  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('one'),
    sdkOptions: { permissionMode: 'default' },
    onMessage: () => {},
  });
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('toctou'), ['survivor']);

  const firstFrames = [];
  const first = claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('two'),
    sdkOptions: { permissionMode: 'plan' },
    onMessage: (m) => firstFrames.push(m),
  });

  // Let the first call reach the gate inside setPermissionMode.
  await waitFor(() => modes.length === 1, { message: 'the first turn must be suspended mid-reconcile' });

  await assert.rejects(
    () => claudeSessionPool.runTurn({
      ...common,
      userMessage: userMessage('three'),
      sdkOptions: { permissionMode: 'plan' },
      onMessage: () => {},
    }),
    /already has a turn in flight/,
    'the slot must be claimed before the first await, not after it',
  );

  gate.resolve();
  const result = await first;
  assert.equal(result.subtype, 'success', 'the first caller\'s promise must still settle');
  assert.deepEqual(firstFrames.map((m) => m.text), ['turn-2'], 'and its frames must reach its own writer');
  assert.equal(turns, 2, 'the rejected turn must not have run');

  claudeSessionPool.closeSession('toctou');
});

test('a turn sent while an aborted turn is still settling waits for it instead of throwing', async () => {
  claudeSessionPool._resetForTests();
  const postInterrupt = createDeferred();
  let turns = 0;

  const factory = ({ prompt }) => {
    const generator = (async function* run() {
      for await (const _message of prompt) {
        turns += 1;
        if (turns === 1) {
          yield { type: 'system', subtype: 'task_started', task_id: 'survivor' };
          yield { type: 'assistant', text: 'working' };
          await postInterrupt.promise;
          yield { type: 'result', subtype: 'error_during_execution' };
        } else {
          yield { type: 'assistant', text: 'second' };
          yield { type: 'result', subtype: 'success' };
        }
      }
    })();
    generator.interrupt = async () => {};
    generator.close = () => {};
    return generator;
  };

  const common = {
    appSessionId: 'stop-then-resend',
    sdkOptions: {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  };

  const turnStarted = createDeferred();
  const first = claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('one'),
    onMessage: () => turnStarted.resolve(),
  });

  await turnStarted.promise;
  assert.equal(await claudeSessionPool.interruptTurn('stop-then-resend'), true);

  // The user pressed Stop and immediately re-sent. The aborted turn still
  // holds the slot on purpose, so this must queue behind it, not error out.
  const secondFrames = [];
  const second = claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('two'),
    onMessage: (m) => secondFrames.push(m),
  });

  await flushMicrotasks();
  postInterrupt.resolve();

  assert.equal((await first).subtype, 'error_during_execution');
  assert.equal((await second).subtype, 'success');
  assert.deepEqual(secondFrames.map((m) => m.text), ['second'], 'the re-sent turn gets its own frames');
  assert.equal(turns, 2, 'both turns ran, on the same process');

  claudeSessionPool.closeSession('stop-then-resend');
});

/**
 * Fix-round-2. The abort fallback reintroduced Task A's own bug in a 5s-narrower
 * window: it settles a turn the CLI may simply not have finished unwinding yet
 * (an interrupt it acked but needs longer than ABORT_SETTLE_FALLBACK_MS to
 * honour, e.g. a foreground tool call it will not abandon). The slot was then
 * vacant, so a re-sent turn claimed it and inherited turn 1's tail: its frames
 * were delivered to turn 2's caller and turn 1's `error_during_execution`
 * settled turn 2 before turn 2 had emitted anything.
 *
 * The pool cannot tell "emitted nothing" from "has not emitted yet", and it has
 * no correlation field to key on — so instead of guessing, a fallback settle
 * records that one terminator is still OWED, and everything up to and including
 * the next `result` is swallowed. Task-lifecycle frames are exempt: they are
 * session-scoped, not turn-scoped, and they are what keeps a background shell's
 * process alive.
 */
test('a fallback-settled turn\'s tail is swallowed instead of being attributed to the next turn', async (t) => {
  claudeSessionPool._resetForTests();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const tailGate = createDeferred();
  let turns = 0;

  const factory = ({ prompt }) => {
    const generator = (async function* run() {
      for await (const _message of prompt) {
        turns += 1;
        if (turns === 1) {
          yield { type: 'system', subtype: 'task_started', task_id: 'survivor' };
          yield { type: 'assistant', text: 'before-stop' };
          // The CLI acked the interrupt but keeps unwinding well past the
          // fallback window; turn 2's prompt queues behind this, exactly as a
          // single-conversation CLI would serialise it.
          await tailGate.promise;
          yield { type: 'system', subtype: 'task_notification', task_id: 'survivor', status: 'completed', output_file: '/tmp/survivor.out' };
          yield { type: 'system', subtype: 'task_started', task_id: 'late-task' };
          yield { type: 'assistant', text: 'turn-1 tail' };
          yield { type: 'result', subtype: 'error_during_execution' };
        } else {
          yield { type: 'assistant', text: 'turn-2 answer' };
          yield { type: 'result', subtype: 'success' };
        }
      }
    })();
    generator.interrupt = async () => {};
    generator.close = () => {};
    return generator;
  };

  const sink = [];
  const common = {
    appSessionId: 'fallback-debt',
    sdkOptions: {},
    onBetweenTurnMessage: (m) => sink.push(m),
    createQuery: factory,
  };

  const turnStarted = createDeferred();
  const firstFrames = [];
  const first = claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('one'),
    onMessage: (m) => {
      firstFrames.push(m);
      // Stop only once the user has actually seen some of turn 1, so the
      // suppression under test is the TAIL, not the whole turn.
      if (m.type === 'assistant') {
        turnStarted.resolve();
      }
    },
  });

  await turnStarted.promise;
  assert.equal(await claudeSessionPool.interruptTurn('fallback-debt'), true);

  // No terminator within the window: the fallback settles turn 1 and takes on a
  // debt for the terminator that is still coming.
  t.mock.timers.tick(5000);
  await flushMicrotasks();
  assert.equal((await first).subtype, 'aborted');

  // The user re-sends. Turn 2 claims the now-free slot.
  const secondFrames = [];
  const second = claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('two'),
    onMessage: (m) => secondFrames.push(m),
  });
  await flushMicrotasks();

  // Only now does turn 1 finish unwinding.
  tailGate.resolve();

  const result = await second;
  assert.equal(
    result.subtype,
    'success',
    'turn 1\'s terminator must not settle turn 2 — that is the misattribution this whole task exists to prevent',
  );
  assert.deepEqual(
    secondFrames.map((m) => m.text ?? m.subtype),
    ['turn-2 answer'],
    'turn 1\'s tail must not appear in turn 2\'s transcript',
  );
  assert.deepEqual(firstFrames.map((m) => m.text ?? m.subtype), ['task_started', 'before-stop']);

  // The exemption that matters: task lifecycle keeps flowing through the debt
  // window, or the pool loses track of what is keeping the process alive.
  assert.deepEqual(
    sink.filter((m) => m.subtype === 'task_notification').map((m) => m.output_file),
    ['/tmp/survivor.out'],
    'a background task settling inside the debt window must still reach the session sink',
  );
  assert.deepEqual(
    claudeSessionPool.getLiveTaskIds('fallback-debt'),
    ['late-task'],
    'and task tracking must stay accurate, or the process is closed under a live shell',
  );

  claudeSessionPool.closeSession('fallback-debt');
  t.mock.timers.reset();
});

/**
 * Fix-round-1 finding 2. `interruptTurn` read `promptSent` AFTER awaiting
 * `interrupt()`, so it could not tell "the interrupt applied to this turn's
 * prompt" from "the interrupt reached the CLI before this prompt existed". A
 * Stop pressed while the next turn is merely RESERVED (parked in
 * `applyLiveOptionChanges`) therefore marked a turn the CLI never interrupted:
 * the user's fresh prompt ran to completion with every frame suppressed, and
 * the abort fallback was armed against a live turn — able to vacate the slot
 * mid-emission, which is the very state this whole task exists to prevent.
 */
test('a Stop landing while the next turn is only RESERVED is an honest no-op', async () => {
  claudeSessionPool._resetForTests();
  const reconcileGate = createDeferred();
  const promptPushed = createDeferred();
  let turns = 0;
  let interruptCalls = 0;

  const factory = ({ prompt }) => {
    const generator = (async function* run() {
      for await (const _message of prompt) {
        turns += 1;
        if (turns === 1) {
          yield { type: 'system', subtype: 'task_started', task_id: 'survivor' };
          yield { type: 'result', subtype: 'success' };
        } else {
          promptPushed.resolve();
          yield { type: 'assistant', text: 'answer to the fresh prompt' };
          yield { type: 'result', subtype: 'success' };
        }
      }
    })();
    generator.close = () => {};
    // Acked only once turn 2's prompt is already in the process — the ordering
    // that makes a post-await `promptSent` read report the wrong turn.
    generator.interrupt = async () => {
      interruptCalls += 1;
      await promptPushed.promise;
    };
    generator.setPermissionMode = async () => { await reconcileGate.promise; };
    return generator;
  };

  const common = {
    appSessionId: 'reserved-stop',
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  };

  // Turn 1 leaves a live background task, so turn 2 must reconcile in place —
  // which is what creates the reserved window at all.
  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('one'),
    sdkOptions: { permissionMode: 'default' },
    onMessage: () => {},
  });
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('reserved-stop'), ['survivor']);

  const frames = [];
  const second = claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('two'),
    sdkOptions: { permissionMode: 'plan' },
    onMessage: (m) => frames.push(m),
  });

  await waitFor(() => interruptCalls === 0 && turns === 1, { message: 'turn 2 must be reserved, not running' });
  const interrupted = claudeSessionPool.interruptTurn('reserved-stop');
  await flushMicrotasks();

  // Now let reconciliation finish, so the prompt is pushed and only THEN does
  // the CLI acknowledge the interrupt.
  reconcileGate.resolve();
  assert.equal(await interrupted, true);

  const result = await second;
  assert.equal(result.subtype, 'success');
  assert.deepEqual(
    frames.map((m) => m.text ?? m.subtype),
    ['answer to the fresh prompt'],
    'the CLI never interrupted this turn, so suppressing its frames would silently eat the user\'s prompt',
  );
  assert.equal(interruptCalls, 1);

  claudeSessionPool.closeSession('reserved-stop');
});

/**
 * Fix-round-1 finding 3. The `session.dead` branch dropped its own reference but
 * left the DEAD session still holding this turn in its slot. The dying drain
 * loop's teardown then rejects whatever it finds there — so if it unwinds after
 * the turn has been re-pointed at a fresh process and started running on it,
 * the caller is told "process ended before the turn completed" about a turn that
 * is generating normally on a process that is very much alive.
 */
test('a session killed from outside mid-reconcile must not reject the turn that moved to its replacement', async () => {
  claudeSessionPool._resetForTests();
  const reconcileGate = createDeferred();
  const teardownGate = createDeferred();
  const replacementTurnGate = createDeferred();
  const invocations = [];

  const factory = ({ prompt }) => {
    const record = { index: invocations.length, turns: 0, closed: false };
    invocations.push(record);

    const generator = (async function* run() {
      try {
        for await (const _message of prompt) {
          record.turns += 1;
          yield { type: 'system', subtype: 'task_started', task_id: `survivor-${record.index}-${record.turns}` };
          if (record.index > 0 && record.turns === 1) {
            // Keeps the re-pointed turn IN FLIGHT on the replacement process
            // while the dead one finishes unwinding.
            await replacementTurnGate.promise;
          }
          yield { type: 'result', subtype: 'success' };
        }
      } finally {
        if (record.index === 0) {
          // Holds the dying process's teardown open past the point where
          // `runTurn` has re-pointed the turn at the replacement process.
          await teardownGate.promise;
        }
      }
    })();
    generator.close = () => { record.closed = true; };
    generator.setPermissionMode = async () => { await reconcileGate.promise; };
    return generator;
  };

  const common = {
    appSessionId: 'killed-mid-reconcile',
    onBetweenTurnMessage: () => {},
    onMessage: () => {},
    createQuery: factory,
  };

  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('one'),
    sdkOptions: { permissionMode: 'default' },
  });
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('killed-mid-reconcile'), ['survivor-0-1']);

  const second = claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('two'),
    sdkOptions: { permissionMode: 'plan' },
  });

  await waitFor(() => invocations.length === 1 && invocations[0].turns === 1, {
    message: 'turn 2 must be parked inside setPermissionMode',
  });

  // Server shutdown (or any external close) lands in that window.
  assert.equal(claudeSessionPool.closeAllSessions(), 1);
  reconcileGate.resolve();

  // The turn is now running on the replacement, and only now does the dead
  // process finish unwinding. It must not reach into a turn it no longer owns.
  await waitFor(() => invocations.length === 2 && invocations[1].turns === 1, {
    message: 'the turn must have been re-pointed at a fresh process',
  });
  teardownGate.resolve();
  await flushMicrotasks();
  replacementTurnGate.resolve();

  const result = await second;
  assert.equal(result.subtype, 'success', 'the turn ran fine on the replacement: rejecting it is a lie');

  // And the replacement's own slot is still usable afterwards.
  await claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('three'),
    sdkOptions: { permissionMode: 'plan' },
  });
  assert.equal(invocations.length, 2, 'the third turn reuses the replacement process');

  claudeSessionPool.closeSession('killed-mid-reconcile');
});

test('genuine concurrency — a turn sent while a NON-aborted turn is in flight — still throws', async () => {
  claudeSessionPool._resetForTests();
  const { factory } = createFakeQuery([
    [{ type: 'assistant', text: 'working' }],
    [{ type: 'result', subtype: 'success' }],
  ]);
  const turnStarted = createDeferred();

  const common = {
    appSessionId: 'concurrent',
    sdkOptions: {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  };

  const pending = claudeSessionPool.runTurn({
    ...common,
    userMessage: userMessage('one'),
    onMessage: () => turnStarted.resolve(),
  });

  await turnStarted.promise;
  await assert.rejects(
    () => claudeSessionPool.runTurn({ ...common, userMessage: userMessage('two'), onMessage: () => {} }),
    /already has a turn in flight/,
    'nobody pressed Stop here — waiting would silently serialise two live runs',
  );

  claudeSessionPool.settleTurn('concurrent', 'aborted');
  await pending;
  claudeSessionPool.closeSession('concurrent');
});

/**
 * Final-review CRITICAL (goal 3 — "losses become visible, never silent"): a
 * pooled process that dies BETWEEN turns took every task it was running with it
 * and said nothing. `drain`'s error path rejects `currentTurn`, but between turns
 * that slot is `null`, so the error was dropped: no log line for the operator, no
 * frame for the user who had been told they would be notified on completion. The
 * six tests below pin the reporting, and the last one pins the no-regression
 * case — a deliberate close must stay quiet.
 */

/** Collects `console.error` for the duration of one test. */
function captureConsoleErrors(t) {
  const calls = [];
  t.mock.method(console, 'error', (...args) => { calls.push(args); });
  return {
    deaths: () => calls.filter((args) => String(args[0]).includes('ended unexpectedly')),
    all: calls,
  };
}

/**
 * A fake process that starts `tasks`, ends its turn, optionally settles some of
 * those tasks, and then dies the way a crashed/OOM-killed CLI does: by throwing
 * out of its own generator with no turn in the slot.
 */
function createDyingQuery({ tasks, settle = [], deathMessage = 'CLI process exited unexpectedly (simulated)' }) {
  return ({ prompt }) => {
    const generator = (async function* run() {
      for await (const _userMessage of prompt) {
        for (const task of tasks) {
          yield { type: 'system', subtype: 'task_started', ...task };
        }
        yield { type: 'result', subtype: 'success' };
        for (const taskId of settle) {
          yield {
            type: 'system',
            subtype: 'task_notification',
            task_id: taskId,
            status: 'completed',
            output_file: `/tmp/${taskId}.output`,
            summary: 'done',
          };
        }
        throw new Error(deathMessage);
      }
    })();
    generator.close = () => {};
    return generator;
  };
}

test('a process dying between turns reports every still-tracked task as lost, with its description', async (t) => {
  claudeSessionPool._resetForTests();
  const logged = captureConsoleErrors(t);

  const lost = [];
  await claudeSessionPool.runTurn({
    appSessionId: 'lost-between',
    userMessage: userMessage('start two background shells'),
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    onTaskLost: (event) => lost.push(event),
    createQuery: createDyingQuery({
      tasks: [
        { task_id: 'lost-1', description: 'Echo t1-t10 with delays' },
        { task_id: 'lost-2', description: 'Tail the build log' },
      ],
    }),
  });

  await waitFor(() => lost.length === 2, { message: 'both lost tasks should have been reported' });
  assert.deepEqual(lost, [
    { taskId: 'lost-1', description: 'Echo t1-t10 with delays' },
    { taskId: 'lost-2', description: 'Tail the build log' },
  ], 'each report must name the task it lost, so the row says WHICH task died');
  assert.equal(logged.deaths().length, 1, 'the operator gets exactly one death line, not one per task');
  assert.equal(claudeSessionPool.hasLiveSession('lost-between'), false);
});

test('a process dying between turns with nothing tracked is still logged, and reports nothing', async (t) => {
  claudeSessionPool._resetForTests();
  const logged = captureConsoleErrors(t);

  const lost = [];
  const settled = createDeferred();
  await claudeSessionPool.runTurn({
    appSessionId: 'lost-none',
    userMessage: userMessage('start one and let it finish'),
    sdkOptions: {},
    onMessage: () => {},
    // The notification arrives BETWEEN turns, which clears the task and leaves
    // the session alive on its idle grace window — the real window in which a
    // process can die with nothing tracked.
    onBetweenTurnMessage: () => settled.resolve(),
    onTaskLost: (event) => lost.push(event),
    createQuery: createDyingQuery({
      tasks: [{ task_id: 'settled-1', description: 'Echo once' }],
      settle: ['settled-1'],
    }),
  });

  await settled.promise;
  await waitFor(() => !claudeSessionPool.hasLiveSession('lost-none'), {
    message: 'the session should be dead once its generator threw',
  });
  assert.deepEqual(lost, [], 'nothing was live, so nothing may be reported as lost');
  assert.equal(logged.deaths().length, 1, 'the subprocess still died — the operator must be told');
});

test('a task that already settled is not reported lost when the process later dies', async (t) => {
  claudeSessionPool._resetForTests();
  captureConsoleErrors(t);

  const lost = [];
  const settled = createDeferred();
  await claudeSessionPool.runTurn({
    appSessionId: 'lost-partial',
    userMessage: userMessage('start two, one finishes'),
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => settled.resolve(),
    onTaskLost: (event) => lost.push(event),
    createQuery: createDyingQuery({
      tasks: [
        { task_id: 'done-1', description: 'Finished before the crash' },
        { task_id: 'still-live-1', description: 'Still running at the crash' },
      ],
      settle: ['done-1'],
    }),
  });

  await settled.promise;
  await waitFor(() => lost.length === 1, { message: 'the surviving task should be reported lost' });
  assert.deepEqual(lost, [{ taskId: 'still-live-1', description: 'Still running at the crash' }]);
});

test('a process dying WITH a turn in flight both rejects that turn and reports the lost task', async (t) => {
  claudeSessionPool._resetForTests();
  const logged = captureConsoleErrors(t);

  let turns = 0;
  const factory = ({ prompt }) => {
    const generator = (async function* run() {
      for await (const _userMessage of prompt) {
        turns += 1;
        if (turns === 1) {
          yield { type: 'system', subtype: 'task_started', task_id: 'inflight-loss', description: 'Long build' };
          yield { type: 'result', subtype: 'success' };
          continue;
        }
        // Turn 2 never terminates: the process dies underneath it.
        throw new Error('CLI process exited unexpectedly (simulated, mid-turn)');
      }
    })();
    generator.close = () => {};
    return generator;
  };

  const lost = [];
  const common = {
    appSessionId: 'lost-inflight',
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    onTaskLost: (event) => lost.push(event),
    createQuery: factory,
  };

  await claudeSessionPool.runTurn({ ...common, userMessage: userMessage('start the build') });
  await assert.rejects(
    () => claudeSessionPool.runTurn({ ...common, userMessage: userMessage('are you there?') }),
    /simulated, mid-turn/,
    'the caller must still learn its own turn failed',
  );

  assert.deepEqual(lost, [{ taskId: 'inflight-loss', description: 'Long build' }],
    'a turn in flight must not swallow the background loss');
  assert.equal(logged.deaths().length, 1);
});

test('a throwing onTaskLost cannot cost the next task its report, nor stop the session being torn down', async (t) => {
  claudeSessionPool._resetForTests();
  captureConsoleErrors(t);

  const lost = [];
  await claudeSessionPool.runTurn({
    appSessionId: 'lost-throwing-sink',
    userMessage: userMessage('start two background shells'),
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    onTaskLost: (event) => {
      if (event.taskId === 'throw-1') {
        throw new Error('the websocket writer blew up');
      }
      lost.push(event);
    },
    createQuery: createDyingQuery({
      tasks: [
        { task_id: 'throw-1', description: 'Reported by a sink that throws' },
        { task_id: 'throw-2', description: 'Must still be reported' },
      ],
    }),
  });

  await waitFor(() => lost.length === 1, { message: 'the second task should still be reported' });
  assert.deepEqual(lost, [{ taskId: 'throw-2', description: 'Must still be reported' }]);
  // Teardown outranks reporting: dead AND out of the map. `getLiveTaskIds`
  // reads the live map, so a stale entry left behind would still list both ids.
  assert.equal(claudeSessionPool.hasLiveSession('lost-throwing-sink'), false, 'the session must still be dead');
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('lost-throwing-sink'), [],
    'the session must still have been removed from the live map');
});

test('a normal turn-end close reports nothing and logs no death', async (t) => {
  claudeSessionPool._resetForTests();
  const logged = captureConsoleErrors(t);

  const { factory, state } = createFakeQuery([
    [{ type: 'assistant', text: 'nothing backgrounded here' }, { type: 'result', subtype: 'success' }],
  ]);

  const lost = [];
  await claudeSessionPool.runTurn({
    appSessionId: 'clean-close',
    userMessage: userMessage('hello'),
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    onTaskLost: (event) => lost.push(event),
    createQuery: factory,
  });

  await flushMicrotasks();
  assert.equal(state.closed, true, 'the pool closed this session itself — nothing was lost');
  assert.deepEqual(lost, [], 'a deliberate close is not a loss');
  assert.equal(logged.deaths().length, 0, 'and it must not cry wolf in the operator log');
});

test('an ambient skip_transcript task is counted in the death log but not shown to the user', async (t) => {
  claudeSessionPool._resetForTests();
  const logged = captureConsoleErrors(t);

  const lost = [];
  await claudeSessionPool.runTurn({
    appSessionId: 'lost-ambient',
    userMessage: userMessage('do something that spawns housekeeping'),
    sdkOptions: {},
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    onTaskLost: (event) => lost.push(event),
    createQuery: createDyingQuery({
      tasks: [
        { task_id: 'ambient-1', description: 'Ambient housekeeping', skip_transcript: true },
        { task_id: 'real-1', description: 'The task the user actually started' },
      ],
    }),
  });

  await waitFor(() => lost.length === 1, { message: 'the user-visible task should be reported' });
  // Same rule `forwardBetweenTurnMessage` applies to an ambient task's
  // notification: tracked, because closing the process would kill it, but never
  // put in the transcript — least of all as a failure the user cannot act on.
  assert.deepEqual(lost, [{ taskId: 'real-1', description: 'The task the user actually started' }]);
  assert.equal(logged.deaths().length, 1);
  assert.equal(logged.deaths()[0][1].lostTaskCount, 2, 'the operator still sees both, ambient included');
});

/**
 * Collects the pool's `console.warn` lines for the duration of one test.
 *
 * Separate from `captureConsoleErrors` because the thing under test below is a
 * warning that must NOT be emitted — an assertion no other test in this file
 * makes, since every other console line here is either an error or incidental.
 */
function captureConsoleWarnings(t) {
  const calls = [];
  t.mock.method(console, 'warn', (...args) => { calls.push(args); });
  return {
    unappliable: () => calls.filter((args) => String(args[0]).includes('cannot take effect')),
    all: calls,
  };
}

/**
 * The two fork flows differ in a way that decides whether a fork-created
 * process may be reused, and the difference is NOT visible in `forkSession`:
 *
 * - Explicit `/fork` runs under the FORK's own new app session id, so the pool
 *   key and the process's conversation agree from then on. Reuse is correct.
 * - The edit-prompt fork runs under the PARENT's app session id (the registry
 *   deliberately keeps the parent's app-id→provider-id mapping and inserts a
 *   separate branch row), so the process drifts onto the branch's transcript
 *   while the pool key still names the parent. Reuse writes the parent's next
 *   prompt into the fork's conversation.
 *
 * Both tests below therefore announce a provider session id and say which
 * conversation their next turn asks to continue — that identity, not the
 * `forkSession` flag, is what separates them.
 */
test('a fork-created session stops reporting its own consumed fork options as a pending change', async (t) => {
  claudeSessionPool._resetForTests();
  const warnings = captureConsoleWarnings(t);
  const { factory, state } = createFakeQuery([
    [
      { type: 'system', subtype: 'init', session_id: 'fork-provider' },
      { type: 'system', subtype: 'task_started', task_id: 'survivor' },
      { type: 'result', subtype: 'success' },
    ],
    [{ type: 'result', subtype: 'success' }],
  ]);

  // Turn 1 is the fork itself: `forkSession`/`resumeSessionAt` are consumed by
  // process creation, and the turn leaves a background shell behind, so the
  // process may not be closed afterwards.
  await claudeSessionPool.runTurn({
    appSessionId: 'fork-consumed',
    userMessage: userMessage('branch here'),
    sdkOptions: {
      resume: 'parent-provider',
      forkSession: true,
      resumeSessionAt: 'anchor-uuid',
      allowedTools: [],
      disallowedTools: [],
      permissionMode: 'bypassPermissions',
    },
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  assert.deepEqual(claudeSessionPool.getLiveTaskIds('fork-consumed'), ['survivor']);

  // Turn 2 is an ORDINARY turn on the fork's OWN session — it continues the
  // conversation the process is actually on, and does not ask to fork again. The
  // fork already happened, so there is nothing left to apply and nothing to
  // report — the snapshot used to keep `forkSession: true` forever and compare
  // every later turn as changed, warning on each one for the session's whole life.
  await claudeSessionPool.runTurn({
    appSessionId: 'fork-consumed',
    userMessage: userMessage('carry on'),
    sdkOptions: {
      resume: 'fork-provider',
      allowedTools: [],
      disallowedTools: [],
      permissionMode: 'bypassPermissions',
    },
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  assert.equal(state.turns, 2, 'both turns must run on the same process');
  assert.equal(state.closed, false, 'and the background shell must survive');
  assert.deepEqual(
    warnings.unappliable(),
    [],
    'the fork options were consumed at creation; reporting them as pending would warn on every later turn',
  );

  claudeSessionPool.closeSession('fork-consumed');
});

test('an explicit /fork session with nothing to protect is not needlessly recreated on its next turn', async () => {
  claudeSessionPool._resetForTests();
  const { factory, invocations } = createCountingFakeQuery([
    [
      // Turn 0 announces the fork's own provider id and emits no `result` — what
      // an interrupted turn looks like. Settling it by hand leaves the session
      // live with no background work, which is the only way a task-free session
      // survives a turn boundary.
      [{ type: 'system', subtype: 'init', session_id: 'fork-provider' }, { type: 'assistant', text: 'working' }],
      [{ type: 'result', subtype: 'success' }],
    ],
  ]);

  const turnOneStarted = createDeferred();
  const pending = claudeSessionPool.runTurn({
    // The fork's OWN app session id, which is what the /fork flow passes.
    appSessionId: 'fork-own-key',
    userMessage: userMessage('branch here'),
    sdkOptions: { resume: 'parent-provider', forkSession: true, resumeSessionAt: 'anchor-uuid' },
    onMessage: () => turnOneStarted.resolve(),
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  await turnOneStarted.promise;
  assert.equal(claudeSessionPool.settleTurn('fork-own-key', 'aborted'), true);
  await pending;

  await claudeSessionPool.runTurn({
    appSessionId: 'fork-own-key',
    userMessage: userMessage('carry on'),
    // The fork's app row now maps to the fork's own provider id, so this turn
    // continues exactly the conversation the live process is on.
    sdkOptions: { resume: 'fork-provider' },
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  assert.equal(
    invocations.length,
    1,
    'the fork options were consumed at creation and the process still serves this conversation, '
    + 'so the next ordinary turn has nothing to recreate for',
  );

  claudeSessionPool.closeSession('fork-own-key');
});

test('an edit-prompt fork drifts its process onto the branch, so the PARENT\'s next turn must not reuse it', async () => {
  claudeSessionPool._resetForTests();
  const { factory, invocations } = createCountingFakeQuery([
    [
      // The edit-prompt fork resumes the parent but the SDK announces the
      // BRANCH's own id — the one case where the provider session id changes
      // mid-stream. From here the process is on the branch's transcript.
      [{ type: 'system', subtype: 'init', session_id: 'branch-provider' }, { type: 'assistant', text: 'working' }],
      [{ type: 'result', subtype: 'success' }],
    ],
    [[{ type: 'result', subtype: 'success' }]],
  ]);

  const turnOneStarted = createDeferred();
  const pending = claudeSessionPool.runTurn({
    // The PARENT's app session id: the edit-prompt fork runs under it.
    appSessionId: 'edit-fork-parent',
    userMessage: userMessage('the edited prompt'),
    sdkOptions: { resume: 'parent-provider', forkSession: true, resumeSessionAt: 'anchor-uuid' },
    onMessage: () => turnOneStarted.resolve(),
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  await turnOneStarted.promise;
  assert.equal(claudeSessionPool.settleTurn('edit-fork-parent', 'aborted'), true);
  await pending;

  // The user goes back to the parent session in the sidebar and carries on
  // there. `resume` still addresses the PARENT's transcript — but the live
  // process is on the branch, and `resume` is ignored by a process that is
  // already running, so reusing it would write this prompt and its answer into
  // the fork's conversation and leave the parent's untouched.
  await claudeSessionPool.runTurn({
    appSessionId: 'edit-fork-parent',
    userMessage: userMessage('let\'s keep going here'),
    sdkOptions: { resume: 'parent-provider' },
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  assert.equal(
    invocations.length,
    2,
    'the live process no longer serves this pool key\'s conversation, so it must be recreated',
  );
  assert.equal(invocations[0].closed, true, 'and the drifted process must actually be closed');

  claudeSessionPool.closeSession('edit-fork-parent');
});

test('a session that is NOT forked still recreates when a fork is requested', async () => {
  claudeSessionPool._resetForTests();
  const { factory, invocations } = createCountingFakeQuery([
    [
      [{ type: 'assistant', text: 'working' }],
      [{ type: 'result', subtype: 'success' }],
    ],
    [[{ type: 'result', subtype: 'success' }]],
  ]);

  const turnOneStarted = createDeferred();
  const pending = claudeSessionPool.runTurn({
    appSessionId: 'fork-request',
    userMessage: userMessage('one'),
    sdkOptions: {},
    onMessage: () => turnOneStarted.resolve(),
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  await turnOneStarted.promise;
  assert.equal(claudeSessionPool.settleTurn('fork-request', 'aborted'), true);
  await pending;

  await claudeSessionPool.runTurn({
    appSessionId: 'fork-request',
    userMessage: userMessage('branch from here'),
    sdkOptions: { forkSession: true, resumeSessionAt: 'anchor-uuid' },
    onMessage: () => {},
    onBetweenTurnMessage: () => {},
    createQuery: factory,
  });

  // The boundary that stops "stop reporting a consumed fork" from becoming
  // "ignore forkSession": there is no fork-mid-stream control request, so a
  // session that is not already a fork can only honour one with a new process.
  assert.equal(invocations.length, 2, 'a fork request on a non-forked session must spawn its own process');
  assert.equal(invocations[0].closed, true);

  claudeSessionPool.closeSession('fork-request');
});
