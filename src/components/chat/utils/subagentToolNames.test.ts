import test from 'node:test';
import assert from 'node:assert/strict';

import { isSubagentToolName, SUBAGENT_TOOL_NAMES } from './subagentToolNames.js';

test('recognizes the current Agent tool name', () => {
  assert.equal(isSubagentToolName('Agent'), true);
});

test('recognizes the legacy Task tool name', () => {
  assert.equal(isSubagentToolName('Task'), true);
});

test('rejects other tools and empty input', () => {
  assert.equal(isSubagentToolName('Bash'), false);
  assert.equal(isSubagentToolName('TaskCreate'), false);
  assert.equal(isSubagentToolName(undefined), false);
  assert.equal(isSubagentToolName(''), false);
});

test('set contains exactly the two known names', () => {
  assert.deepEqual([...SUBAGENT_TOOL_NAMES].sort(), ['Agent', 'Task']);
});
