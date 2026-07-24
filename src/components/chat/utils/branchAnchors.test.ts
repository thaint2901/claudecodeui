import assert from 'node:assert/strict';
import test from 'node:test';

import { baseMessageUuid, pickBranchAnchorMessageIds } from './branchAnchors.js';

const UUID = '0b8a9d7e-1c2f-4a5b-8d3e-6f7a8b9c0d1e';

test('baseMessageUuid strips only a trailing _<digits> part suffix', () => {
  assert.equal(baseMessageUuid(`${UUID}_0`), UUID);
  assert.equal(baseMessageUuid(`${UUID}_12`), UUID);
  assert.equal(baseMessageUuid(UUID), UUID);
  // Generated ids may contain underscores mid-string — only a trailing
  // numeric suffix is a part index.
  assert.equal(baseMessageUuid('claude_abc_x'), 'claude_abc_x');
  assert.equal(baseMessageUuid('claude_abc_7'), 'claude_abc');
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
