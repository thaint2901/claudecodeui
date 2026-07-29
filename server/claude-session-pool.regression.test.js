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
