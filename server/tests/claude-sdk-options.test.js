import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCliOptionsToSDK } from '../claude-sdk.js';

test('always forwards subagent text, but does not enable fork-subagent by default', () => {
  const sdkOptions = mapCliOptionsToSDK({});
  assert.equal(sdkOptions.env.CLAUDE_CODE_FORK_SUBAGENT, undefined);
  assert.equal(sdkOptions.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, undefined);
  assert.equal(sdkOptions.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT, '1');
});

test('enables fork-subagent and disables background tasks when forkSubagent is requested', () => {
  const sdkOptions = mapCliOptionsToSDK({ forkSubagent: true });
  assert.equal(sdkOptions.env.CLAUDE_CODE_FORK_SUBAGENT, '1');
  assert.equal(sdkOptions.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.equal(sdkOptions.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT, '1');
});

test('always allowlists the subagent dispatch tool (both names)', () => {
  const sdkOptions = mapCliOptionsToSDK({});
  assert.ok(sdkOptions.allowedTools.includes('Agent'));
  assert.ok(sdkOptions.allowedTools.includes('Task'));
});

test('does not duplicate Agent when user already allowlisted it', () => {
  const sdkOptions = mapCliOptionsToSDK({
    toolsSettings: { allowedTools: ['Agent', 'Bash'], disallowedTools: [], skipPermissions: false },
  });
  assert.equal(sdkOptions.allowedTools.filter((t) => t === 'Agent').length, 1);
  assert.ok(sdkOptions.allowedTools.includes('Bash'));
});

test('honors an explicit user disallow of Agent by not force-allowing it', () => {
  const sdkOptions = mapCliOptionsToSDK({
    toolsSettings: { disallowedTools: ['Agent'] },
  });
  assert.equal(sdkOptions.allowedTools.includes('Agent'), false);
  assert.ok(sdkOptions.disallowedTools.includes('Agent'));
  assert.ok(sdkOptions.allowedTools.includes('Task'));
});

test('passes forkSession through when requested', () => {
  assert.equal(mapCliOptionsToSDK({ forkSession: true }).forkSession, true);
  assert.equal('forkSession' in mapCliOptionsToSDK({}), false);
});
