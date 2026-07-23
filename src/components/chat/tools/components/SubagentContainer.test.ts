import test from 'node:test';
import assert from 'node:assert/strict';
import { extractResultText, isBackgroundLaunchAck } from './SubagentContainer';

// Fork-mode subagents (spec 2026-07-22-subagent-fork-subtask) always run in
// the background, so their tool_result is launch-ack boilerplate rather than
// the subagent's actual output. Users who enable background mode themselves
// can hit the same boilerplate, so this guard is defensive, not fork-only.

test('isBackgroundLaunchAck matches the launch-ack boilerplate', () => {
  assert.equal(isBackgroundLaunchAck('Async agent launched successfully. It will run in the background.'), true);
  assert.equal(isBackgroundLaunchAck('  Async agent launched successfully...'), true);
});

test('isBackgroundLaunchAck does not match real subagent output', () => {
  assert.equal(isBackgroundLaunchAck('Here is the summary of the files I found.'), false);
  assert.equal(isBackgroundLaunchAck(null), false);
});

test('extractResultText suppresses the launch-ack boilerplate with a neutral message', () => {
  const result = extractResultText({ content: 'Async agent launched successfully. It will run in the background.' });
  assert.equal(result, 'Running in background...');
});

test('extractResultText passes through real subagent output unchanged', () => {
  const result = extractResultText({ content: 'Task complete: found 3 matches.' });
  assert.equal(result, 'Task complete: found 3 matches.');
});

test('extractResultText still parses JSON array-of-text-parts content', () => {
  const result = extractResultText({ content: JSON.stringify([{ type: 'text', text: 'part one' }]) });
  assert.equal(result, 'part one');
});
