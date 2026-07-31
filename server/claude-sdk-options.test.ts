import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCliOptionsToSDK, shouldRecaptureSessionId, recaptureForkSession } from '@/claude-sdk.js';

test('mapCliOptionsToSDK enables includePartialMessages so the SDK streams partial assistant text', () => {
  const sdkOptions = mapCliOptionsToSDK({
    sessionId: null,
    cwd: process.cwd(),
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    permissionMode: 'default',
  });

  assert.equal(sdkOptions.includePartialMessages, true);
});

test('always forwards subagent text, but does not enable fork-subagent by default', () => {
  // sdkOptions.env starts as a spread of process.env, so a CLAUDE_CODE_FORK_SUBAGENT
  // or CLAUDE_CODE_DISABLE_BACKGROUND_TASKS already set on the host (e.g. when this
  // test itself runs inside a nested Claude Code session) would otherwise leak
  // through and falsely satisfy — or defeat — the "undefined by default" assertions.
  const previousFork = process.env.CLAUDE_CODE_FORK_SUBAGENT;
  const previousDisableBg = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
  delete process.env.CLAUDE_CODE_FORK_SUBAGENT;
  delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;

  try {
    const sdkOptions = mapCliOptionsToSDK({
      sessionId: null,
      cwd: process.cwd(),
      toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
      permissionMode: 'default',
    });

    assert.equal(sdkOptions.env.CLAUDE_CODE_FORK_SUBAGENT, undefined);
    assert.equal(sdkOptions.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, undefined);
    assert.equal(sdkOptions.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT, '1');
  } finally {
    if (previousFork === undefined) {
      delete process.env.CLAUDE_CODE_FORK_SUBAGENT;
    } else {
      process.env.CLAUDE_CODE_FORK_SUBAGENT = previousFork;
    }
    if (previousDisableBg === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
    } else {
      process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = previousDisableBg;
    }
  }
});

test('enables fork-subagent and disables background tasks when forkSubagent is requested', () => {
  const sdkOptions = mapCliOptionsToSDK({
    sessionId: null,
    cwd: process.cwd(),
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    permissionMode: 'default',
    forkSubagent: true,
  });

  assert.equal(sdkOptions.env.CLAUDE_CODE_FORK_SUBAGENT, '1');
  assert.equal(sdkOptions.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.equal(sdkOptions.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT, '1');
});

test('always allowlists the subagent dispatch tool (both names)', () => {
  const sdkOptions = mapCliOptionsToSDK({
    sessionId: null,
    cwd: process.cwd(),
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    permissionMode: 'default',
  });

  assert.ok(sdkOptions.allowedTools.includes('Agent'));
  assert.ok(sdkOptions.allowedTools.includes('Task'));
});

test('does not duplicate Agent when user already allowlisted it', () => {
  const sdkOptions = mapCliOptionsToSDK({
    sessionId: null,
    cwd: process.cwd(),
    toolsSettings: { allowedTools: ['Agent', 'Bash'], disallowedTools: [], skipPermissions: false },
    permissionMode: 'default',
  });

  assert.equal(sdkOptions.allowedTools.filter((tool: string) => tool === 'Agent').length, 1);
  assert.ok(sdkOptions.allowedTools.includes('Bash'));
});

test('honors an explicit user disallow of Agent by not force-allowing it', () => {
  const sdkOptions = mapCliOptionsToSDK({
    sessionId: null,
    cwd: process.cwd(),
    toolsSettings: { allowedTools: [], disallowedTools: ['Agent'], skipPermissions: false },
    permissionMode: 'default',
  });

  assert.equal(sdkOptions.allowedTools.includes('Agent'), false);
  assert.ok(sdkOptions.disallowedTools.includes('Agent'));
  assert.ok(sdkOptions.allowedTools.includes('Task'));
});

test('passes forkSession through when requested', () => {
  const baseOptions = {
    sessionId: null,
    cwd: process.cwd(),
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    permissionMode: 'default',
  };

  assert.equal(mapCliOptionsToSDK({ ...baseOptions, forkSession: true }).forkSession, true);
  assert.equal('forkSession' in mapCliOptionsToSDK(baseOptions), false);
});

test('shouldRecaptureSessionId re-captures only for fork runs whose announced id differs', () => {
  // Fork run: SDK announces a new id distinct from the parent-seeded capture.
  assert.equal(shouldRecaptureSessionId(true, 'fork-new-id', 'parent-id'), true);

  // Fork run, but the announced id matches what's already captured — no-op.
  assert.equal(shouldRecaptureSessionId(true, 'parent-id', 'parent-id'), false);

  // Non-fork (resume) run must never re-capture, even if ids differ.
  assert.equal(shouldRecaptureSessionId(false, 'fork-new-id', 'parent-id'), false);

  // No announced id yet.
  assert.equal(shouldRecaptureSessionId(true, undefined, 'parent-id'), false);
});

test('recaptureForkSession removes the old id, tracks the new one, relabels the writer, and announces once', () => {
  const calls: string[] = [];
  const queryInstance = { marker: 'query-instance' };
  const ws = {
    setSessionId: (id: string) => {
      calls.push(`setSessionId:${id}`);
    },
  };

  const result = recaptureForkSession({
    oldId: 'parent-id',
    newId: 'fork-new-id',
    queryInstance,
    ws,
    removeSession: (id: string) => calls.push(`removeSession:${id}`),
    addSession: (id: string, instance: unknown, writer: unknown) => {
      assert.equal(instance, queryInstance);
      assert.equal(writer, ws);
      calls.push(`addSession:${id}`);
    },
    sendSessionCreated: () => calls.push('sendSessionCreated'),
  });

  assert.equal(result, 'fork-new-id');
  // Call order: old id removed before the new id is added, then the writer
  // is relabeled, then (and only then) session_created is announced.
  assert.deepEqual(calls, [
    'removeSession:parent-id',
    'addSession:fork-new-id',
    'setSessionId:fork-new-id',
    'sendSessionCreated',
  ]);
});

test('recaptureForkSession tolerates a writer with no setSessionId and still announces exactly once', () => {
  let sendCount = 0;
  const result = recaptureForkSession({
    oldId: 'parent-id',
    newId: 'fork-new-id',
    queryInstance: {},
    ws: {},
    removeSession: () => {},
    addSession: () => {},
    sendSessionCreated: () => {
      sendCount += 1;
    },
  });

  assert.equal(result, 'fork-new-id');
  assert.equal(sendCount, 1);
});
