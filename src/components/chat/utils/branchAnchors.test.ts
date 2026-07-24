import assert from 'node:assert/strict';
import test from 'node:test';

import { baseMessageUuid, firstUserMessageUuid, pickBranchAnchorMessageIds } from './branchAnchors.js';

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

test('picks the LAST assistant part whose base uuid matches the anchor', () => {
  const messages = [
    { uuid: 'u1', type: 'user' },
    { uuid: `${UUID}_0`, type: 'assistant' },
    { uuid: `${UUID}_1`, type: 'tool' },
    { uuid: `${UUID}_2`, type: 'assistant' },
    { uuid: 'other-uuid', type: 'assistant' },
  ];
  const chosen = pickBranchAnchorMessageIds(messages, [UUID]);
  assert.equal(chosen.get(UUID), `${UUID}_2`);
});

test('string-content assistant messages (bare id) match directly', () => {
  const messages = [{ uuid: UUID, type: 'assistant' }];
  assert.equal(pickBranchAnchorMessageIds(messages, [UUID]).get(UUID), UUID);
});

test('tool-only turns and missing anchors produce no entry', () => {
  const messages = [
    { uuid: `${UUID}_0`, type: 'tool' },
    { uuid: 'x_0', type: 'assistant' },
  ];
  const chosen = pickBranchAnchorMessageIds(messages, [UUID, null, undefined]);
  assert.equal(chosen.size, 0);
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
    { uuid: `${other}_0`, type: 'assistant' },
    { uuid: `${other}_3`, type: 'assistant' },
  ];
  const chosen = pickBranchAnchorMessageIds(messages, [UUID, other]);
  assert.equal(chosen.get(UUID), `${UUID}_0`);
  assert.equal(chosen.get(other), `${other}_3`);
});
