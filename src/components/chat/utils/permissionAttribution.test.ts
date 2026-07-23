import test from 'node:test';
import assert from 'node:assert/strict';
import { attributePermissionToSubagent } from './permissionAttribution.js';
import type { ChatMessage } from '../types/types.js';

const container = (desc: string, children: Array<{ toolName: string; done: boolean }>): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: new Date(),
  isToolUse: true,
  toolName: 'Agent',
  toolId: 'p1',
  toolResult: null,
  isSubagentContainer: true,
  toolInput: JSON.stringify({ description: desc, subagent_type: 'general-purpose', prompt: 'x' }),
  subagentState: {
    childMessages: [],
    currentToolIndex: 0,
    isComplete: false,
    childTools: children.map((c, i) => ({
      toolId: `c${i}`, toolName: c.toolName, toolInput: '{}',
      toolResult: c.done ? { content: 'ok', isError: false } : null,
      timestamp: new Date(),
    })),
  },
} as ChatMessage);

test('attributes a pending Bash permission to the running subagent', () => {
  const messages = [container('Review readme', [{ toolName: 'Bash', done: false }])];
  assert.deepEqual(attributePermissionToSubagent(messages, 'Bash'), { description: 'Review readme' });
});

test('returns null when no running subagent has a pending call of that tool', () => {
  const done = [container('Review readme', [{ toolName: 'Bash', done: true }])];
  assert.equal(attributePermissionToSubagent(done, 'Bash'), null);
  assert.equal(attributePermissionToSubagent([], 'Bash'), null);
  const otherTool = [container('Review readme', [{ toolName: 'Read', done: false }])];
  assert.equal(attributePermissionToSubagent(otherTool, 'Bash'), null);
});

test('picks the most recent matching subagent when several run', () => {
  const messages = [
    container('First', [{ toolName: 'Bash', done: false }]),
    container('Second', [{ toolName: 'Bash', done: false }]),
  ];
  assert.deepEqual(attributePermissionToSubagent(messages, 'Bash'), { description: 'Second' });
});

test('falls back to subagent_type when toolInput has no description', () => {
  const message: ChatMessage = {
    type: 'assistant',
    content: '',
    timestamp: new Date(),
    isToolUse: true,
    toolName: 'Agent',
    toolId: 'p1',
    toolResult: null,
    isSubagentContainer: true,
    toolInput: JSON.stringify({ subagent_type: 'general-purpose' }),
    subagentState: {
      childMessages: [],
      currentToolIndex: 0,
      isComplete: false,
      childTools: [{ toolId: 'c0', toolName: 'Bash', toolInput: '{}', toolResult: null, timestamp: new Date() }],
    },
  } as ChatMessage;
  assert.deepEqual(attributePermissionToSubagent([message], 'Bash'), { description: 'general-purpose' });
});

test('falls back to literal "subagent" when toolInput is invalid JSON', () => {
  const message: ChatMessage = {
    type: 'assistant',
    content: '',
    timestamp: new Date(),
    isToolUse: true,
    toolName: 'Agent',
    toolId: 'p1',
    toolResult: null,
    isSubagentContainer: true,
    toolInput: '{not valid json',
    subagentState: {
      childMessages: [],
      currentToolIndex: 0,
      isComplete: false,
      childTools: [{ toolId: 'c0', toolName: 'Bash', toolInput: '{}', toolResult: null, timestamp: new Date() }],
    },
  } as ChatMessage;
  assert.deepEqual(attributePermissionToSubagent([message], 'Bash'), { description: 'subagent' });
});
