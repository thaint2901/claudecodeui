import test from 'node:test';
import assert from 'node:assert/strict';

import type { NormalizedMessage } from '../../../stores/useSessionStore.js';

import { normalizedToChatMessages } from './useChatMessages.js';

const base = { sessionId: 's1', provider: 'claude' as const, timestamp: '2026-07-22T10:00:00Z' };

function subagentFixture(): NormalizedMessage[] {
  return [
    { ...base, id: 'm1', kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_p',
      toolInput: JSON.stringify({ description: 'Review readme', subagent_type: 'general-purpose', prompt: 'go' }) },
    { ...base, id: 'm2', kind: 'text', role: 'user', content: 'delegation prompt text', parentToolUseId: 'toolu_p' },
    { ...base, id: 'm3', kind: 'tool_use', toolName: 'Read', toolId: 'toolu_c1',
      toolInput: '{"file_path":"/tmp/README.md"}', parentToolUseId: 'toolu_p' },
    { ...base, id: 'm4', kind: 'tool_result', toolId: 'toolu_c1', content: '# README', parentToolUseId: 'toolu_p' },
    { ...base, id: 'm5', kind: 'text', role: 'assistant', content: 'Looks fine.', parentToolUseId: 'toolu_p' },
    { ...base, id: 'm6', kind: 'tool_result', toolId: 'toolu_p', content: 'Report: fine' },
  ] as NormalizedMessage[];
}

test('children nest under the Agent container, not top level', () => {
  const out = normalizedToChatMessages(subagentFixture());
  const containers = out.filter((m) => m.isSubagentContainer);
  assert.equal(containers.length, 1);
  // Nothing with a parent renders top-level: no fake user bubble, no stray Read
  assert.equal(out.some((m) => m.type === 'user'), false);
  assert.equal(out.some((m) => m.toolName === 'Read'), false);
});

test('subagentState carries tools and the full child transcript', () => {
  const out = normalizedToChatMessages(subagentFixture());
  const container = out.find((m) => m.isSubagentContainer);
  assert.ok(container?.subagentState);
  assert.equal(container.subagentState.childTools.length, 1);
  assert.equal(container.subagentState.childTools[0].toolName, 'Read');
  assert.equal(container.subagentState.childTools[0].toolResult?.content, '# README');
  assert.equal(container.subagentState.isComplete, true);
  // childMessages: delegation text + Read tool + assistant text (order preserved)
  const kinds = container.subagentState.childMessages.map((m) => m.isToolUse ? 'tool' : m.type);
  assert.deepEqual(kinds, ['user', 'tool', 'assistant']);
});

test('running subagent (no parent result) reports isComplete=false', () => {
  const msgs = subagentFixture().filter((m) => m.id !== 'm6');
  const container = normalizedToChatMessages(msgs).find((m) => m.isSubagentContainer);
  assert.equal(container?.subagentState?.isComplete, false);
});

test('legacy Task tool name still groups', () => {
  const msgs = subagentFixture();
  (msgs[0] as { toolName?: string }).toolName = 'Task';
  const container = normalizedToChatMessages(msgs).find((m) => m.isSubagentContainer);
  assert.ok(container);
});

test('orphan children (parent trimmed out of window) are dropped, not top-leveled', () => {
  const out = normalizedToChatMessages(subagentFixture().slice(1, 5));
  assert.equal(out.some((m) => m.type === 'user'), false);
  assert.equal(out.some((m) => m.toolName === 'Read'), false);
});

function nestedSubagentFixture(): NormalizedMessage[] {
  return [
    // Outer Agent (toolu_a)
    { ...base, id: 'n1', kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_a',
      toolInput: JSON.stringify({ description: 'Outer', subagent_type: 'general-purpose', prompt: 'go' }) },
    // Nested Agent (toolu_b), a direct child of the outer Agent
    { ...base, id: 'n2', kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_b',
      toolInput: JSON.stringify({ description: 'Inner', subagent_type: 'general-purpose', prompt: 'go deeper' }),
      parentToolUseId: 'toolu_a' },
    { ...base, id: 'n3', kind: 'tool_result', toolId: 'toolu_b', content: 'Inner report', parentToolUseId: 'toolu_a' },
    // Grandchildren: children of the NESTED Agent, not the outer one
    { ...base, id: 'n4', kind: 'text', role: 'assistant', content: 'Inner thinking', parentToolUseId: 'toolu_b' },
    { ...base, id: 'n5', kind: 'tool_use', toolName: 'Read', toolId: 'toolu_c',
      toolInput: '{"file_path":"/tmp/nested.md"}', parentToolUseId: 'toolu_b' },
    { ...base, id: 'n6', kind: 'tool_result', toolId: 'toolu_c', content: '# Nested', parentToolUseId: 'toolu_b' },
  ] as NormalizedMessage[];
}

test('2-level nesting: nested Agent keeps its own children (grandchildren)', () => {
  const out = normalizedToChatMessages(nestedSubagentFixture());

  // Nothing rendered at top level besides the outer container.
  assert.equal(out.length, 1);
  const outerContainer = out[0];
  assert.equal(outerContainer.isSubagentContainer, true);

  // Outer container's childMessages contain the nested container (and nothing else stray).
  const outerChildMessages = outerContainer.subagentState?.childMessages ?? [];
  const nestedContainer = outerChildMessages.find((m) => m.isSubagentContainer);
  assert.ok(nestedContainer, 'nested Agent container should appear in outer childMessages');
  assert.equal(outerChildMessages.length, 1);

  // The nested container's subagentState.childTools contains the Read with its result attached.
  const childTools = nestedContainer.subagentState?.childTools ?? [];
  assert.equal(childTools.length, 1);
  assert.equal(childTools[0].toolName, 'Read');
  assert.equal(childTools[0].toolResult?.content, '# Nested');

  // The nested container's own childMessages include the grandchild text + tool.
  const nestedChildMessages = nestedContainer.subagentState?.childMessages ?? [];
  const kinds = nestedChildMessages.map((m) => (m.isToolUse ? 'tool' : m.type));
  assert.deepEqual(kinds, ['assistant', 'tool']);
});
