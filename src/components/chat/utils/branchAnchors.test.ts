import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizedToChatMessages } from '../hooks/useChatMessages.js';

import {
  baseMessageUuid,
  firstUserMessageUuid,
  pickBranchIndex,
  pickBranchSwitcherOwners,
} from './branchAnchors.js';

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
    // A tool call as the renderer really emits it: assistant-typed, no uuid.
    { type: 'assistant', isToolUse: true },
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

// The uuid test in the anchor loop is load-bearing, not defensive: only
// user-text and assistant-text rows are given a uuid, so every tool, thinking
// and error row reaches this function with `uuid: undefined`. Drop the test
// and `baseMessageUuid` is handed undefined on the first tool call of any
// session. Shapes here come from the real converter — see the round-trip test
// at the bottom of this file.
test('ignores rows the renderer leaves without a uuid', () => {
  const messages = [
    { uuid: `${UUID}_0`, type: 'assistant' },
    { type: 'assistant', isToolUse: true, toolName: 'Read' },
    { type: 'error' },
    { uuid: 'real-prompt_text_0', type: 'user' },
  ];
  const owners = pickBranchSwitcherOwners(messages, [UUID]);
  assert.equal(owners.get('real-prompt_text_0'), UUID);
  assert.equal(owners.size, 1);
});

// Defensive only: nothing in src/ sets `isToolUse` on a user row today
// (useChatMessages.ts sets it on assistant rows). Kept because a user-typed
// tool_result would be routed to ToolGroupContainer, which cannot render the
// pager — but this shape is NOT produced by the current pipeline.
test('skips a user entry flagged as a tool result, if one ever appears', () => {
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

// ChatMessagesPane hands `renderBranchSwitcher` to MessageComponent only;
// grouped tool parts go to ToolGroupContainer, which has no switcher slot. A
// fallback pointing at a tool part would therefore render nothing at all, so
// the fallback must be the anchor's last NON-tool part.
test('the fallback lands on a renderable part, never on a tool part', () => {
  const messages = [
    { uuid: `${UUID}_0`, type: 'assistant' },
    { uuid: `${UUID}_1`, type: 'assistant', isToolUse: true, toolName: 'Read' },
  ];
  const owners = pickBranchSwitcherOwners(messages, [UUID]);
  assert.equal(owners.get(`${UUID}_0`), UUID);
  assert.equal(owners.has(`${UUID}_1`), false);
});

// Guards the tempting-but-wrong fix for the test above: excluding tool parts
// from the ANCHOR loop as well would drop the anchor entirely, losing the
// switcher even though a perfectly good prompt follows it.
//
// The uuid on a tool row is deliberately hypothetical — the renderer withholds
// one today, which is exactly why this mutation is invisible to every other
// test. This pins the contract for the day someone adds one (deep-linking,
// scroll-to-message): the anchor must still be found, only the FALLBACK may
// refuse a tool part.
test('an anchor turn made only of a tool part still hands the switcher to the next prompt', () => {
  const messages = [
    { uuid: `${UUID}_1`, type: 'assistant', isToolUse: true, toolName: 'Read' },
    { uuid: 'prompt_text_0', type: 'user' },
  ];
  assert.equal(pickBranchSwitcherOwners(messages, [UUID]).get('prompt_text_0'), UUID);
});

test('string-content assistant messages (bare id) match directly', () => {
  const messages = [{ uuid: UUID, type: 'assistant' }];
  assert.equal(pickBranchSwitcherOwners(messages, [UUID]).get(UUID), UUID);
});

test('unmatched anchors and null entries produce no owner', () => {
  const messages = [
    { type: 'assistant', isToolUse: true, toolName: 'Read' },
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

// Hand-written fixtures are how a previous defect shipped: a server test fed
// bare uuids while the renderer emits suffixed ones. This one is built by the
// real converter, so the shapes cannot drift from production.
test('resolves an anchor on rows produced by the real converter', () => {
  const base = { sessionId: 's1', provider: 'claude' as const, timestamp: '2026-07-22T10:00:00Z' };
  const anchor = 'bbbbbbbb-1111-4222-8333-444444444444';
  const rendered = normalizedToChatMessages([
    { ...base, id: `${UUID}_text_0`, kind: 'text', role: 'user', content: 'first prompt' },
    { ...base, id: `${anchor}_0`, kind: 'text', role: 'assistant', content: 'answer' },
    { ...base, id: 'tu1', kind: 'tool_use', toolName: 'Read', toolId: 'toolu_1', toolInput: '{"file_path":"/tmp/x"}' },
    { ...base, id: 'tr1', kind: 'tool_result', toolId: 'toolu_1', content: 'contents' },
    { ...base, id: 'edited_text_0', kind: 'text', role: 'user', content: 'edited prompt' },
  ]);

  // The tool row really does arrive assistant-typed and uuid-less; that is the
  // invariant the anchor loop's uuid test depends on.
  const toolRow = rendered.find((m) => m.isToolUse);
  assert.equal(toolRow?.type, 'assistant');
  assert.equal(toolRow?.uuid, undefined);

  const owners = pickBranchSwitcherOwners(rendered, [anchor]);
  assert.equal(owners.get('edited_text_0'), anchor);
  assert.equal(owners.size, 1);
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

// The pager's position must name the session ON SCREEN. `activeLeaf` is the
// server's opinion, and between a switch and the `/branches` refetch that
// follows it the two disagree: the transcript has already moved but the loaded
// branch rows still flag the previous sibling. Resolving both in one
// `findIndex(b => b.sessionId === current || b.activeLeaf)` let whichever came
// FIRST in the array win, so a stale leaf on an earlier sibling beat the exact
// match on a later one.
test('the position names the session on screen, not the server-flagged leaf', () => {
  const siblings = [
    { sessionId: 'parent', activeLeaf: true },
    { sessionId: 'fork', activeLeaf: false },
  ];
  assert.equal(pickBranchIndex(siblings, 'fork'), 1);
});

// Cold-open a branch and nothing on the client knows which row is "current"
// yet — `activeLeaf` is the only signal, and it is the right one.
test('the server-flagged leaf is the fallback when the session is not in the list', () => {
  const siblings = [
    { sessionId: 'parent', activeLeaf: false },
    { sessionId: 'fork', activeLeaf: true },
  ];
  assert.equal(pickBranchIndex(siblings, 'unrelated-session'), 1);
  assert.equal(pickBranchIndex(siblings, null), 1);
});

// Steady state: the two signals agree and the answer is the same either way.
test('an exact match that is also the leaf resolves to itself', () => {
  const siblings = [
    { sessionId: 'parent', activeLeaf: false },
    { sessionId: 'fork', activeLeaf: true },
  ];
  assert.equal(pickBranchIndex(siblings, 'fork'), 1);
});

// -1 keeps the caller's existing `if (idx < 0) return null` contract: a list
// that names neither the current session nor a leaf cannot be positioned, and
// rendering `0/n` would be a lie.
test('neither signal present yields -1 so the caller can withhold the pager', () => {
  const siblings = [
    { sessionId: 'parent', activeLeaf: false },
    { sessionId: 'fork', activeLeaf: false },
  ];
  assert.equal(pickBranchIndex(siblings, 'unrelated-session'), -1);
});
