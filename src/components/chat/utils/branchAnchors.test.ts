import assert from 'node:assert/strict';
import test from 'node:test';

import { baseMessageUuid, firstUserMessageUuid, pickBranchSwitcherOwners } from './branchAnchors.js';

const UUID = '0b8a9d7e-1c2f-4a5b-8d3e-6f7a8b9c0d1e';

test('baseMessageUuid strips every normalizer part suffix, nothing else', () => {
  // assistant parts
  assert.equal(baseMessageUuid(`${UUID}_0`), UUID);
  assert.equal(baseMessageUuid(`${UUID}_12`), UUID);
  // user text parts (array content / joined fallback)
  assert.equal(baseMessageUuid(`${UUID}_text_0`), UUID);
  assert.equal(baseMessageUuid(`${UUID}_text_12`), UUID);
  assert.equal(baseMessageUuid(`${UUID}_text`), UUID);
  // user tool-result and image-only parts
  assert.equal(baseMessageUuid(`${UUID}_tr_toolu_01AbCdEf`), UUID);
  assert.equal(baseMessageUuid(`${UUID}_images`), UUID);
  // bare ids pass through
  assert.equal(baseMessageUuid(UUID), UUID);
  // Generated ids may contain underscores mid-string — only a trailing
  // part suffix is stripped; `_text_` mid-string is untouched.
  assert.equal(baseMessageUuid('claude_abc_x'), 'claude_abc_x');
  assert.equal(baseMessageUuid('claude_abc_7'), 'claude_abc');
  assert.equal(baseMessageUuid('x_text_middle'), 'x_text_middle');
  assert.equal(baseMessageUuid('x_text_5_more'), 'x_text_5_more');
});

test('hands the switcher to the first user turn AFTER the anchor, not the anchor', () => {
  const messages = [
    { uuid: 'u1', type: 'user' },
    { uuid: `${UUID}_0`, type: 'assistant' },
    { uuid: `${UUID}_1`, type: 'tool' },
    { uuid: `${UUID}_2`, type: 'assistant' },
    { uuid: 'edited-prompt_text_0', type: 'user' },
    { uuid: 'later-user', type: 'user' },
  ];
  const owners = pickBranchSwitcherOwners(messages, [UUID]);
  // The prompt that differs between siblings owns it...
  assert.equal(owners.get('edited-prompt_text_0'), UUID);
  // ...and the shared assistant resume point does not.
  assert.equal(owners.has(`${UUID}_2`), false);
  assert.equal(owners.size, 1);
});

test('skips tool_result user entries, which render in ToolGroupContainer', () => {
  const messages = [
    { uuid: `${UUID}_0`, type: 'assistant' },
    { uuid: `${UUID}_tr_toolu_01AbCdEf`, type: 'user', isToolUse: true },
    { uuid: 'real-prompt_text_0', type: 'user' },
  ];
  const owners = pickBranchSwitcherOwners(messages, [UUID]);
  assert.equal(owners.get('real-prompt_text_0'), UUID);
});

test('falls back to the anchor itself when no user turn follows', () => {
  const messages = [
    { uuid: 'u1', type: 'user' },
    { uuid: `${UUID}_0`, type: 'assistant' },
    { uuid: `${UUID}_1`, type: 'assistant' },
  ];
  const owners = pickBranchSwitcherOwners(messages, [UUID]);
  assert.equal(owners.get(`${UUID}_1`), UUID);
});

test('string-content assistant messages (bare id) match directly', () => {
  const messages = [{ uuid: UUID, type: 'assistant' }];
  assert.equal(pickBranchSwitcherOwners(messages, [UUID]).get(UUID), UUID);
});

test('tool-only turns and missing anchors produce no entry', () => {
  const messages = [
    { uuid: `${UUID}_0`, type: 'tool' },
    { uuid: 'x_0', type: 'assistant' },
  ];
  const owners = pickBranchSwitcherOwners(messages, [UUID, null, undefined]);
  assert.equal(owners.size, 0);
});

test('two anchors competing for one prompt do not collapse into a single owner', () => {
  const other = 'f0e1d2c3-b4a5-6789-0123-456789abcdef';
  const messages = [
    { uuid: `${UUID}_0`, type: 'assistant' },
    { uuid: `${other}_0`, type: 'assistant' },
    { uuid: 'shared-next_text_0', type: 'user' },
  ];
  const owners = pickBranchSwitcherOwners(messages, [UUID, other]);
  // Earlier anchor keeps the shared prompt; the later one keeps its own part
  // rather than silently overwriting and losing a control.
  assert.equal(owners.get('shared-next_text_0'), UUID);
  assert.equal(owners.get(`${other}_0`), other);
  assert.equal(owners.size, 2);
});

test('firstUserMessageUuid finds the first user message when history is fully loaded', () => {
  const messages = [
    { uuid: `${UUID}_0`, type: 'assistant' },
    { type: 'user' }, // optimistic/pending row without a uuid is skipped
    { uuid: `${UUID}_text_0`, type: 'user' },
    { uuid: 'later-user', type: 'user' },
  ];
  assert.equal(firstUserMessageUuid(messages, false), `${UUID}_text_0`);
});

test('firstUserMessageUuid returns null while earlier history is unloaded', () => {
  const messages = [{ uuid: `${UUID}_text_0`, type: 'user' }];
  assert.equal(firstUserMessageUuid(messages, true), null);
});

test('firstUserMessageUuid returns null with no user messages', () => {
  assert.equal(firstUserMessageUuid([{ uuid: `${UUID}_0`, type: 'assistant' }], false), null);
  assert.equal(firstUserMessageUuid([], false), null);
});

test('multiple anchors resolve independently', () => {
  const other = 'f0e1d2c3-b4a5-6789-0123-456789abcdef';
  const messages = [
    { uuid: `${UUID}_0`, type: 'assistant' },
    { uuid: 'prompt-a_text_0', type: 'user' },
    { uuid: `${other}_0`, type: 'assistant' },
    { uuid: `${other}_3`, type: 'assistant' },
    { uuid: 'prompt-b_text_0', type: 'user' },
  ];
  const owners = pickBranchSwitcherOwners(messages, [UUID, other]);
  assert.equal(owners.get('prompt-a_text_0'), UUID);
  assert.equal(owners.get('prompt-b_text_0'), other);
});
