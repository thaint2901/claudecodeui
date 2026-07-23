import test from 'node:test';
import assert from 'node:assert/strict';

import { isSubagentToolName, isAgentMetadataBlockText, SUBAGENT_TOOL_NAMES, transcriptEndsWithText } from './subagentToolNames.js';

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

test('isAgentMetadataBlockText matches runtime routing metadata', () => {
  assert.equal(isAgentMetadataBlockText("agentId: ae810e7... (use SendMessage with to: '...', summary: '...')"), true);
});

test('isAgentMetadataBlockText does not match normal result text', () => {
  assert.equal(isAgentMetadataBlockText('Here is the summary of the changes.'), false);
});

test('transcriptEndsWithText is true when the last message is plain assistant text', () => {
  assert.equal(
    transcriptEndsWithText([
      { type: 'assistant', isToolUse: false, content: 'Done, all tests pass.' },
    ]),
    true,
  );
});

test('transcriptEndsWithText is false when the last message is a tool use', () => {
  assert.equal(
    transcriptEndsWithText([
      { type: 'assistant', isToolUse: false, content: 'Running the tests now.' },
      { type: 'assistant', isToolUse: true, content: '' },
    ]),
    false,
  );
});

test('transcriptEndsWithText is false when the trailing assistant text is empty/whitespace', () => {
  assert.equal(
    transcriptEndsWithText([
      { type: 'assistant', isToolUse: false, content: '   ' },
    ]),
    false,
  );
});

test('transcriptEndsWithText is false for an empty transcript', () => {
  assert.equal(transcriptEndsWithText([]), false);
});

test('transcriptEndsWithText is false when the last message is from the user', () => {
  assert.equal(
    transcriptEndsWithText([
      { type: 'assistant', isToolUse: false, content: 'Working on it.' },
      { type: 'user', isToolUse: false, content: 'Thanks!' },
    ]),
    false,
  );
});
