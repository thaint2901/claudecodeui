import test from 'node:test';
import assert from 'node:assert/strict';

// getToolsSettings (inside computeSendOptions) reads through safeLocalStorage,
// which calls the global `localStorage`. Node's test runner has no DOM, so
// stub a minimal in-memory implementation before the module under test loads
// — without it, safeLocalStorage.getItem still degrades safely (try/catch
// logs and returns null), but the stub lets tests also assert the "saved
// settings" path deterministically.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
};

const { computeSendOptions, classifySlashCommand } = await import('./useSubmitPipeline.js');

// --- computeSendOptions ---------------------------------------------------
// Characterizes buildSendOptions's real body (useChatComposerState.ts, the
// buildSendOptions useCallback before extraction) PLUS the editAtMessageUuid
// merge that used to happen inline at handleSubmit's sendMessage call site
// (`...(editingSentPrompt ? { editAtMessageUuid: editingSentPrompt.uuid } : {})`).

const resolvePermissionModeForProvider = (_provider: string, requestedMode: string) => `resolved:${requestedMode}`;

const baseArgs = {
  provider: 'claude' as const,
  cursorModel: 'cursor-model',
  claudeModel: 'claude-model',
  codexModel: 'codex-model',
  opencodeModel: 'opencode-model',
  currentProviderEffort: 'medium',
  permissionMode: 'default',
  resolvePermissionModeForProvider,
  selectedSession: null,
  currentInput: 'hello world',
  editingSentPrompt: null,
};

test('computeSendOptions: plain send carries no fork field', () => {
  store.clear();
  const result = computeSendOptions(baseArgs as any);
  assert.equal('editAtMessageUuid' in result, false);
  assert.equal(result.model, 'claude-model');
  assert.equal(result.effort, 'medium');
  assert.equal(result.permissionMode, 'resolved:default');
  assert.deepEqual(result.toolsSettings, {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false,
  });
  assert.equal(result.skipPermissions, false);
});

test('computeSendOptions: an active edit-fork submission attaches editAtMessageUuid and reflects the edited uuid', () => {
  store.clear();
  const result = computeSendOptions({
    ...baseArgs,
    editingSentPrompt: { uuid: 'msg-123', content: 'edited text' },
  } as any);
  assert.equal(result.editAtMessageUuid, 'msg-123');
});

test('computeSendOptions: picks the model matching the active provider', () => {
  store.clear();
  const result = computeSendOptions({ ...baseArgs, provider: 'cursor' } as any);
  assert.equal(result.model, 'cursor-model');
});

test('computeSendOptions: sessionSummary falls back to the truncated current input when the session has no summary/name/title', () => {
  store.clear();
  const longInput = 'x'.repeat(100);
  const result = computeSendOptions({ ...baseArgs, currentInput: longInput } as any);
  assert.equal(result.sessionSummary, `${'x'.repeat(77)}...`);
});

test('computeSendOptions: honors saved per-provider tools settings from localStorage', () => {
  store.clear();
  store.set('claude-settings', JSON.stringify({ allowedTools: ['Bash'], disallowedTools: [], skipPermissions: true }));
  const result = computeSendOptions(baseArgs as any);
  assert.deepEqual(result.toolsSettings, { allowedTools: ['Bash'], disallowedTools: [], skipPermissions: true });
  assert.equal(result.skipPermissions, true);
});

test('computeSendOptions: picks the codex model when the active provider is codex', () => {
  store.clear();
  const result = computeSendOptions({ ...baseArgs, provider: 'codex' } as any);
  assert.equal(result.model, 'codex-model');
});

test('computeSendOptions: picks the opencode model when the active provider is opencode', () => {
  store.clear();
  const result = computeSendOptions({ ...baseArgs, provider: 'opencode' } as any);
  assert.equal(result.model, 'opencode-model');
});

test('computeSendOptions: honors saved cursor tools settings under the cursor-tools-settings key', () => {
  store.clear();
  store.set(
    'cursor-tools-settings',
    JSON.stringify({ allowedTools: ['Read'], disallowedTools: ['Bash'], skipPermissions: false }),
  );
  const result = computeSendOptions({ ...baseArgs, provider: 'cursor' } as any);
  assert.deepEqual(result.toolsSettings, { allowedTools: ['Read'], disallowedTools: ['Bash'], skipPermissions: false });
});

test('computeSendOptions: sessionSummary prefers summary over name and title when all three are set', () => {
  store.clear();
  const result = computeSendOptions({
    ...baseArgs,
    selectedSession: { summary: 'summary-value', name: 'name-value', title: 'title-value' },
  } as any);
  assert.equal(result.sessionSummary, 'summary-value');
});

test('computeSendOptions: sessionSummary falls back to name over title when summary is absent', () => {
  store.clear();
  const result = computeSendOptions({
    ...baseArgs,
    selectedSession: { name: 'name-value', title: 'title-value' },
  } as any);
  assert.equal(result.sessionSummary, 'name-value');
});

// --- classifySlashCommand --------------------------------------------------
// Characterizes handleSubmit's slash-command classification block (the
// "is this input a slash command" decision the Task 3 ledger noted lives in
// concern E, not concern C).

const slashCommands = [
  { name: '/compact', type: 'custom' },
  { name: '/skill-thing', type: 'skill' },
  { name: '/builtin-thing', type: 'claude-builtin' },
] as any[];

test('classifySlashCommand: plain text is not a command', () => {
  assert.equal(classifySlashCommand('just a message', slashCommands), null);
});

test('classifySlashCommand: matches a known command and returns the raw input as dispatchInput', () => {
  const result = classifySlashCommand('/compact focus on X', slashCommands);
  assert.deepEqual(result, { command: slashCommands[0], dispatchInput: '/compact focus on X' });
});

test('classifySlashCommand: "help" (bare word) aliases to the synthetic /help command', () => {
  const result = classifySlashCommand('help', slashCommands);
  assert.equal(result?.command.name, '/help');
  assert.equal(result?.dispatchInput, '/help');
});

test('classifySlashCommand: an unmatched slash-prefixed input is not intercepted', () => {
  assert.equal(classifySlashCommand('/nonexistent', slashCommands), null);
});

test('classifySlashCommand: a matched "skill" command is not intercepted (handled elsewhere)', () => {
  assert.equal(classifySlashCommand('/skill-thing', slashCommands), null);
});

test('classifySlashCommand: a matched "claude-builtin" command is not intercepted (handled elsewhere)', () => {
  assert.equal(classifySlashCommand('/builtin-thing', slashCommands), null);
});
