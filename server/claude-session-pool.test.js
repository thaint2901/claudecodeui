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
    const record = { closed: false, interrupted: false, turns: 0 };
    invocations.push(record);

    const generator = (async function* run() {
      for await (const userMessage of prompt) {
        void userMessage;
        const turns = scriptPerInvocation[invocationIndex] ?? [];
        const script = turns[record.turns] ?? [{ type: 'result', subtype: 'success' }];
        record.turns += 1;
        for (const message of script) {
          yield message;
        }
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

  // Give A's drain loop plenty of time to finish its `finally` — if the
  // delete there were unguarded, it would remove B's entry from the map
  // right about now.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(claudeSessionPool.hasLiveSession(appSessionId), true, 'B must still be registered after A fully unwinds');
  assert.deepEqual(claudeSessionPool.getLiveTaskIds(appSessionId), ['t2'], 'B\'s live task must still be tracked');

  // A subsequent turn must reuse B, not spawn a third process.
  await claudeSessionPool.runTurn({ ...common, userMessage: userMessage('b-two') });
  assert.equal(invocations.length, 2, 'must not have spawned a third process');
  assert.equal(claudeSessionPool.hasLiveSession(appSessionId), false, 'B closes once its task completes and no turn is in flight');

  claudeSessionPool.closeSession(appSessionId);
});

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
