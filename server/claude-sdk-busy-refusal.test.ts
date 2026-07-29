import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Run with:
//   npx tsx --test --experimental-test-module-mocks --tsconfig server/tsconfig.json \
//     server/claude-sdk-busy-refusal.test.ts
// (`mock.module` throws `TypeError: mock.module is not a function` without the
// flag on Node 24+.)
//
// Final-review CRITICAL: some option changes can only be honoured by a fresh
// `claude` process. When a background task is holding the current one open, the
// pool used to log a `console.warn` and run the turn anyway — which silently
// turned two user actions into different features:
//
//   - `/subtask` is implemented purely through the child's environment
//     (`CLAUDE_CODE_FORK_SUBAGENT` + `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, set
//     in `mapCliOptionsToSDK`). `env` has no mid-session control request, so on a
//     reused process the flags never reach the CLI and the "subtask" runs as an
//     ordinary subagent that never saw the conversation — while still answering
//     plausibly.
//   - Editing an earlier prompt sends the SAME `appSessionId` with
//     `forkSession: true`. Reusing the process appends the edited prompt to the
//     conversation tip instead of branching it.
//
// These drive the real `queryClaudeSDK` (only the SDK's `query()` is mocked,
// since the real one spawns a CLI) and assert on the frames that actually reach
// a client, because the refusal has to be visible there: the websocket layer
// registers the run BEFORE calling the spawn function, so a silent return leaves
// the UI spinning forever.

const sdkState = {
  /** One entry per `query()` call, i.e. per spawned process. */
  queryCalls: [] as Array<{ options: Record<string, unknown> }>,
  closeCalls: 0,
  /** Prompts actually pushed into each process, in order. */
  promptsPerProcess: [] as string[][],
};

// `mock.module`'s `namedExports` replaces the whole module, so the real exports
// must be spread through — other modules in the import graph use them.
const realSdk = await import('@anthropic-ai/claude-agent-sdk');

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    ...realSdk,
    query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      const processIndex = sdkState.queryCalls.length + 1;
      sdkState.queryCalls.push({ options });
      const prompts: string[] = [];
      sdkState.promptsPerProcess.push(prompts);

      const generator = (async function* run() {
        let turn = 0;
        for await (const userMessage of prompt) {
          turn += 1;
          prompts.push(String((userMessage as { message: { content: unknown } }).message.content));
          if (turn === 1) {
            yield { type: 'system', subtype: 'init', session_id: `busy-provider-${processIndex}`, slash_commands: [] };
            // A backgrounded shell: from here on the process must stay alive,
            // which is exactly what makes a fresh-process-only option change
            // impossible to honour.
            yield {
              type: 'system',
              subtype: 'task_started',
              task_id: `bg-shell-${processIndex}`,
              description: 'Echo t1-t10 with delays',
            };
          }
          yield { type: 'result', subtype: 'success' };
        }
      })();

      (generator as unknown as { interrupt: () => Promise<void> }).interrupt = async () => {};
      (generator as unknown as { close: () => void }).close = () => { sdkState.closeCalls += 1; };
      (generator as unknown as { setPermissionMode: (m: unknown) => Promise<void> }).setPermissionMode = async () => {};
      (generator as unknown as { setModel: (m?: unknown) => Promise<void> }).setModel = async () => {};
      (generator as unknown as { applyFlagSettings: (s: unknown) => Promise<void> }).applyFlagSettings = async () => {};

      return generator;
    },
  },
});

process.env.DATABASE_PATH = path.join(os.tmpdir(), `claude-sdk-busy-refusal-${process.pid}.db`);
const { initializeDatabase } = await import('@/modules/database/index.js');
initializeDatabase();

const { queryClaudeSDK } = await import('./claude-sdk.js');
const { claudeSessionPool } = await import('./claude-session-pool.js');
const { chatRunRegistry, WS_OPEN_STATE } = await import('@/modules/websocket/index.js');

type Frame = Record<string, unknown>;

function createFakeWs() {
  const sent: Frame[] = [];
  return {
    userId: null,
    isWebSocketWriter: true,
    send: (msg: Frame) => sent.push(msg),
    sent,
  };
}

const cwd = os.tmpdir();

/** The turn that puts a background task in the way of everything that follows. */
async function startHeldSession(appSessionId: string) {
  const ws = createFakeWs();
  await queryClaudeSDK(
    'start a long shell in the background',
    {
      appSessionId,
      cwd,
      images: [],
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: ['Bash'], disallowedTools: [], skipPermissions: false },
    },
    ws,
  );
  assert.equal(
    claudeSessionPool.getLiveTaskIds(appSessionId).length,
    1,
    'the background task must be tracked, which is what forbids closing the process',
  );
  return ws;
}

function refusal(ws: { sent: Frame[] }) {
  return ws.sent.find((frame) => frame.kind === 'protocol_error');
}

function resetSdkState() {
  sdkState.queryCalls.length = 0;
  sdkState.closeCalls = 0;
  sdkState.promptsPerProcess.length = 0;
}

test('/subtask on a session holding a background task is refused, not silently downgraded', async (t) => {
  claudeSessionPool._resetForTests();
  resetSdkState();
  await startHeldSession('busy-subtask');

  // Spied only from here, so the held session's own turn 1 ran for real.
  const runTurn = t.mock.method(claudeSessionPool, 'runTurn');

  const ws = createFakeWs();
  await queryClaudeSDK(
    'Run a subtask: summarize the conversation so far',
    {
      appSessionId: 'busy-subtask',
      sessionId: 'busy-provider-1',
      cwd,
      images: [],
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: ['Bash'], disallowedTools: [], skipPermissions: false },
      // What the websocket gateway adds for `/subtask` — and the whole
      // mechanism: it exists only as child env, so a reused process cannot get it.
      forkSubagent: true,
    },
    ws,
  );

  const error = refusal(ws);
  assert.ok(error, `expected a protocol_error frame, got ${JSON.stringify(ws.sent)}`);
  assert.equal(error.code, 'SESSION_BUSY_BACKGROUND_TASK');
  assert.match(
    String(error.error),
    /subtask/i,
    'a generic "session busy" does not tell the user which action was refused',
  );

  const kinds = ws.sent.map((frame) => frame.kind);
  assert.deepEqual(
    kinds,
    ['protocol_error', 'complete'],
    'the run is already registered by the websocket layer, so a refusal without a terminal complete '
    + 'leaves the client spinning forever',
  );
  assert.equal(ws.sent[1].exitCode, 1);

  assert.equal(runTurn.mock.callCount(), 0, 'the turn must never reach the process');
  assert.equal(sdkState.queryCalls.length, 1, 'and no second process may be spawned behind the user\'s back');
  assert.deepEqual(
    sdkState.promptsPerProcess[0],
    ['start a long shell in the background'],
    'the refused prompt must not have been pushed into the live process',
  );
  assert.deepEqual(
    claudeSessionPool.getLiveTaskIds('busy-subtask'),
    ['bg-shell-1'],
    'refusing must leave the background task exactly as it was',
  );
  assert.equal(sdkState.closeCalls, 0, 'and must not close the process it was protecting');

  claudeSessionPool._resetForTests();
});

test('/subtask on a session with no live background task runs normally', async () => {
  claudeSessionPool._resetForTests();
  resetSdkState();

  const ws = createFakeWs();
  await queryClaudeSDK(
    'Run a subtask: summarize the conversation so far',
    {
      appSessionId: 'free-subtask',
      cwd,
      images: [],
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
      forkSubagent: true,
    },
    ws,
  );

  assert.equal(refusal(ws), undefined, `unexpected refusal: ${JSON.stringify(ws.sent)}`);
  assert.equal(sdkState.queryCalls.length, 1);
  assert.equal(
    sdkState.queryCalls[0].options.env
      && (sdkState.queryCalls[0].options.env as Record<string, string>).CLAUDE_CODE_FORK_SUBAGENT,
    '1',
    'a fresh process is exactly where /subtask CAN be honoured — the refusal must not reach here',
  );
  assert.ok(ws.sent.some((frame) => frame.kind === 'complete' && frame.exitCode === 0));

  claudeSessionPool._resetForTests();
});

test('an edit-prompt fork on a session holding a background task is refused, and the message names the fork', async (t) => {
  claudeSessionPool._resetForTests();
  resetSdkState();
  await startHeldSession('busy-fork');

  const runTurn = t.mock.method(claudeSessionPool, 'runTurn');

  const ws = createFakeWs();
  await queryClaudeSDK(
    'the edited prompt',
    {
      // The edit-prompt fork reuses the SAME app session id (only the explicit
      // /fork flow allocates a new one), which is why the pool finds the held
      // process instead of spawning its own.
      appSessionId: 'busy-fork',
      sessionId: 'busy-provider-1',
      cwd,
      images: [],
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: ['Bash'], disallowedTools: [], skipPermissions: false },
      forkSession: true,
      resumeSessionAt: 'anchor-uuid',
    },
    ws,
  );

  const error = refusal(ws);
  assert.ok(error, `expected a protocol_error frame, got ${JSON.stringify(ws.sent)}`);
  // A refused fork is now the EXPECTED outcome of this combination, so it has to
  // join the fork flow's existing error contract — restore the edited text,
  // restore the view, one message. `code === 'FORK_FAILED'` is the frontend's
  // only route into it (`onForkFailed`, the sole caller of
  // `restoreEditSentPrompt`), and it also clears `pendingForkRef`, which is what
  // stops `onCompleteWithoutBranch` adding a second, contentless error row when
  // our terminal `complete` lands. A code the frontend does not recognise would
  // leave the user's edited paragraphs discarded from composer AND draft.
  assert.equal(error.code, 'FORK_FAILED');
  assert.match(String(error.error), /edit|branch|fork/i);
  assert.match(
    String(error.error),
    /background/i,
    'whichever code carries it, the user must still be told it was the background task that blocked them',
  );
  assert.deepEqual(ws.sent.map((frame) => frame.kind), ['protocol_error', 'complete']);
  assert.equal(runTurn.mock.callCount(), 0, 'appending the edited prompt to the tip is the bug, not the fallback');
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('busy-fork'), ['bg-shell-1']);

  claudeSessionPool._resetForTests();
});

test('a turn asking for a different working directory on a held session is refused', async (t) => {
  claudeSessionPool._resetForTests();
  resetSdkState();
  await startHeldSession('busy-cwd');

  const runTurn = t.mock.method(claudeSessionPool, 'runTurn');

  const ws = createFakeWs();
  await queryClaudeSDK(
    'now work over there',
    {
      appSessionId: 'busy-cwd',
      sessionId: 'busy-provider-1',
      cwd: path.join(cwd, 'somewhere-else'),
      images: [],
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: ['Bash'], disallowedTools: [], skipPermissions: false },
    },
    ws,
  );

  const error = refusal(ws);
  assert.ok(error, `expected a protocol_error frame, got ${JSON.stringify(ws.sent)}`);
  assert.equal(error.code, 'SESSION_BUSY_BACKGROUND_TASK');
  assert.match(String(error.error), /director/i);
  assert.equal(runTurn.mock.callCount(), 0, 'running in the wrong directory is a correctness problem, not a cosmetic one');

  claudeSessionPool._resetForTests();
});

test('an effort change on a held session is NOT refused — it keeps the existing warn-and-skip', async (t) => {
  claudeSessionPool._resetForTests();
  resetSdkState();
  await startHeldSession('busy-effort');

  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });

  const ws = createFakeWs();
  await queryClaudeSDK(
    'same place, less thinking',
    {
      appSessionId: 'busy-effort',
      sessionId: 'busy-provider-1',
      cwd,
      images: [],
      model: 'sonnet',
      effort: 'low',
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: ['Bash'], disallowedTools: [], skipPermissions: false },
    },
    ws,
  );

  // Deliberate asymmetry: `applyFlagSettings`'s `effortLevel` cannot express the
  // whole `effort` domain, so effort cannot be fully applied live either — but
  // running a turn at the previous effort is a degradation, not a different
  // feature. Refusing it would block ordinary turns for no protection.
  assert.equal(refusal(ws), undefined, `unexpected refusal: ${JSON.stringify(ws.sent)}`);
  assert.equal(sdkState.queryCalls.length, 1, 'and it must still not recreate the process');
  assert.equal(sdkState.closeCalls, 0);
  assert.deepEqual(sdkState.promptsPerProcess[0], ['start a long shell in the background', 'same place, less thinking']);
  const unappliable = warnings.filter((args) => String(args[0]).includes('cannot take effect'));
  assert.equal(unappliable.length, 1, 'the warn-and-skip is the documented behaviour for effort');
  assert.deepEqual((unappliable[0][1] as { fields: string[] }).fields, ['effort']);

  claudeSessionPool._resetForTests();
});

test('an explicit /fork is not refused by a background task on the PARENT session', async () => {
  claudeSessionPool._resetForTests();
  resetSdkState();
  await startHeldSession('busy-parent');

  // The explicit /fork flow allocates the fork its OWN app session row and
  // passes that as `appSessionId`, so the pool looks up a different key and
  // spawns a fresh process — the parent's held process is irrelevant to it.
  const ws = createFakeWs();
  await queryClaudeSDK(
    'continue from where the conversation left off',
    {
      appSessionId: 'busy-parent-fork-child',
      sessionId: 'busy-provider-1',
      cwd,
      images: [],
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: ['Bash'], disallowedTools: [], skipPermissions: false },
      forkSession: true,
    },
    ws,
  );

  assert.equal(refusal(ws), undefined, `unexpected refusal: ${JSON.stringify(ws.sent)}`);
  assert.equal(sdkState.queryCalls.length, 2, 'the fork gets its own process');
  assert.equal(sdkState.queryCalls[1].options.forkSession, true);
  assert.deepEqual(
    claudeSessionPool.getLiveTaskIds('busy-parent'),
    ['bg-shell-1'],
    'and the parent\'s background task is untouched',
  );

  claudeSessionPool._resetForTests();
});

test('the refusal reaches a real client through the gateway writer, addressed by the app session id', async () => {
  claudeSessionPool._resetForTests();
  resetSdkState();
  await startHeldSession('busy-gateway');

  // The runtimes never hold a raw websocket — they hold a `ChatSessionWriter`,
  // whose `send()` takes the frame as an OBJECT and remaps its `sessionId` to
  // the app id. A refusal built for a raw socket (stringified, guarded on
  // `readyState`) would be dropped here without a sound, and the client would
  // spin forever: this pins the transport, not just the decision.
  const frames: Frame[] = [];
  const connection = {
    readyState: WS_OPEN_STATE,
    send: (data: string) => { frames.push(JSON.parse(data) as Frame); },
  };
  const run = chatRunRegistry.startRun({
    appSessionId: 'busy-gateway',
    provider: 'claude',
    providerSessionId: 'busy-provider-1',
    connection: connection as never,
    userId: null,
  });
  assert.ok(run);

  await queryClaudeSDK(
    'Run a subtask: summarize the conversation so far',
    {
      appSessionId: 'busy-gateway',
      sessionId: 'busy-provider-1',
      cwd,
      images: [],
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: ['Bash'], disallowedTools: [], skipPermissions: false },
      forkSubagent: true,
    },
    run.writer,
  );

  assert.deepEqual(frames.map((frame) => frame.kind), ['protocol_error', 'complete']);
  assert.equal(frames[0].code, 'SESSION_BUSY_BACKGROUND_TASK');
  assert.equal(frames[0].sessionId, 'busy-gateway', 'the frontend only ever knows the app session id');
  assert.equal(frames[1].sessionId, 'busy-gateway');
  assert.equal(frames[1].exitCode, 1);

  claudeSessionPool._resetForTests();
});

test('an ordinary turn on a parent whose process drifted onto an edit-prompt fork is refused', async (t) => {
  claudeSessionPool._resetForTests();
  resetSdkState();

  // Turn 1 is the edit-prompt fork: it runs under the PARENT's app session id
  // (that is what makes it different from explicit /fork), resumes the parent's
  // transcript, and the SDK announces the BRANCH's own provider id — so from
  // here the live process is on the branch's conversation while the pool key
  // still names the parent. It also backgrounds a shell, so the process cannot
  // be closed.
  const forkWs = createFakeWs();
  await queryClaudeSDK(
    'the edited prompt',
    {
      appSessionId: 'busy-drift',
      sessionId: 'parent-provider',
      cwd,
      images: [],
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: ['Bash'], disallowedTools: [], skipPermissions: false },
      forkSession: true,
      resumeSessionAt: 'anchor-uuid',
    },
    forkWs,
  );
  assert.equal(refusal(forkWs), undefined, 'the fork itself creates the process, so it must not be refused');
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('busy-drift'), ['bg-shell-1']);

  const runTurn = t.mock.method(claudeSessionPool, 'runTurn');

  // The user returns to the PARENT session in the sidebar and carries on there.
  // No option field says anything is wrong — the only thing that does is the
  // identity of the conversation the process is on. Running anyway writes this
  // prompt and its answer into the FORK's transcript and leaves the parent's
  // empty, which is the same class of silent wrongness as the two cases above.
  const ws = createFakeWs();
  await queryClaudeSDK(
    'let\'s keep going here',
    {
      appSessionId: 'busy-drift',
      sessionId: 'parent-provider',
      cwd,
      images: [],
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: ['Bash'], disallowedTools: [], skipPermissions: false },
    },
    ws,
  );

  const error = refusal(ws);
  assert.ok(error, `expected a protocol_error frame, got ${JSON.stringify(ws.sent)}`);
  // NOT `FORK_FAILED`: this turn is not a fork request, and `onForkFailed` would
  // push an unrelated parked edit back into the composer.
  assert.equal(error.code, 'SESSION_BUSY_BACKGROUND_TASK');
  assert.match(String(error.error), /branch|conversation/i);
  assert.deepEqual(ws.sent.map((frame) => frame.kind), ['protocol_error', 'complete']);
  assert.equal(runTurn.mock.callCount(), 0);
  assert.deepEqual(claudeSessionPool.getLiveTaskIds('busy-drift'), ['bg-shell-1']);

  claudeSessionPool._resetForTests();
});
