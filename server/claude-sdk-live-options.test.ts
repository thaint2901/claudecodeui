import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Run with: npx tsx --test --experimental-test-module-mocks --tsconfig server/tsconfig.json <path>
//
// Final-review CRITICAL + IMPORTANT 2 + IMPORTANT 6, driven end-to-end through
// the real `queryClaudeSDK` (only the SDK's `query()` is mocked, since the real
// one spawns a CLI).
//
// The bug this pins: a live process keeps the options object `query()` was
// constructed with, INCLUDING the `canUseTool` closure. So on turn 2 of a reused
// session the SDK still calls turn 1's closure, which read turn 1's
// `permissionMode` / `allowedTools` / `disallowedTools` and sent its frames
// through turn 1's (already completed) writer. A user who switched off
// `bypassPermissions` or unchecked a tool was still evaluated against the
// settings they had just abandoned — and the resulting `permission_request` was
// appended to the finished run's event log, where a reconnecting client's
// `lastSeq` could step straight over the live run's events.
//
// The pool must not simply recreate the process here: turn 1 left a background
// task running, and closing the process is what kills it — the whole bug this
// branch exists to fix.

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const sdkState = {
  /** One entry per `query()` call, i.e. per spawned process. */
  queryCalls: [] as Array<{ options: Record<string, unknown> }>,
  closeCalls: 0,
  permissionModes: [] as unknown[],
  flagSettings: [] as unknown[],
};

const turnTwoReachedTheProcess = createDeferred();
const releaseTurnTwoResult = createDeferred();

// `mock.module` replaces the whole module, so the real exports must be spread
// through — other modules in the import graph use `renameSession`, `listSessions`, …
const realSdk = await import('@anthropic-ai/claude-agent-sdk');

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    ...realSdk,
    query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      sdkState.queryCalls.push({ options });

      const generator = (async function* run() {
        let turn = 0;
        for await (const _userMessage of prompt) {
          turn += 1;

          if (turn === 1) {
            yield { type: 'system', subtype: 'init', session_id: 'live-opts-provider-1', slash_commands: [] };
            // Backgrounded shell: from here on the process must stay alive.
            yield { type: 'system', subtype: 'task_started', task_id: 'bg-shell' };
            yield { type: 'result', subtype: 'success' };
            continue;
          }

          turnTwoReachedTheProcess.resolve();
          // Ambient housekeeping task: tracked for lifetime purposes, but the
          // spec says it must never be shown in the transcript.
          yield {
            type: 'system',
            subtype: 'task_notification',
            task_id: 'ambient-housekeeping',
            status: 'completed',
            output_file: '/tmp/ambient.output',
            summary: 'ambient upkeep',
            skip_transcript: true,
          };
          // The real settlement — arriving MID-TURN, which used to be dropped by
          // the role-keyed normalizer and never seen by the user.
          yield {
            type: 'system',
            subtype: 'task_notification',
            task_id: 'bg-shell',
            status: 'stopped',
            output_file: '/tmp/bg-shell.output',
            summary: 'killed under memory pressure',
          };
          await releaseTurnTwoResult.promise;
          yield { type: 'result', subtype: 'success' };
        }
      })();

      (generator as unknown as { interrupt: () => Promise<void> }).interrupt = async () => {};
      (generator as unknown as { close: () => void }).close = () => {
        sdkState.closeCalls += 1;
      };
      (generator as unknown as { setPermissionMode: (m: unknown) => Promise<void> }).setPermissionMode = async (mode) => {
        sdkState.permissionModes.push(mode);
      };
      (generator as unknown as { setModel: (m?: unknown) => Promise<void> }).setModel = async () => {};
      (generator as unknown as { applyFlagSettings: (s: unknown) => Promise<void> }).applyFlagSettings = async (settings) => {
        sdkState.flagSettings.push(settings);
      };

      return generator;
    },
  },
});

process.env.DATABASE_PATH = path.join(os.tmpdir(), `claude-sdk-live-options-${process.pid}.db`);
const { initializeDatabase } = await import('@/modules/database/index.js');
initializeDatabase();

const { queryClaudeSDK, resolveToolApproval } = await import('./claude-sdk.js');
const { claudeSessionPool } = await import('./claude-session-pool.js');
const { connectedClients } = await import('@/modules/websocket/services/websocket-state.service.js');

function createFakeWs() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    userId: null,
    isWebSocketWriter: true,
    send: (msg: Record<string, unknown>) => sent.push(msg),
    sent,
  };
}

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function waitFor(predicate: () => boolean, { maxTicks = 2000, message = 'condition' } = {}): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (predicate()) {
      return;
    }
    // Real fs I/O (loadMcpConfig, provider-model cache reads) needs actual
    // event-loop turns, not just microtasks.
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`${message} did not become true in time`);
}

test('a reused live session runs the CURRENT turn\'s options, writer included, without killing its background task', async () => {
  claudeSessionPool._resetForTests();
  connectedClients.clear();
  const uiClient = new FakeConnection();
  connectedClients.add(uiClient as never);

  const cwd = os.tmpdir();
  const wsTurnOne = createFakeWs();
  const wsTurnTwo = createFakeWs();

  // Turn 1: permissions wide open, Bash explicitly allowed, and it backgrounds
  // a shell — so the process must survive the turn boundary.
  await queryClaudeSDK(
    'start a long shell',
    {
      appSessionId: 'live-opts-app',
      cwd,
      images: [],
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: ['Bash'], disallowedTools: [], skipPermissions: false },
    },
    wsTurnOne,
  );

  assert.deepEqual(
    claudeSessionPool.getLiveTaskIds('live-opts-app'),
    ['bg-shell'],
    'the background task must be tracked, which is what forbids a close-and-recreate',
  );
  assert.equal(sdkState.queryCalls.length, 1);

  // Turn 2: the user has since switched to `default` and DISALLOWED Bash.
  const turnTwo = queryClaudeSDK(
    'now with tightened settings',
    {
      appSessionId: 'live-opts-app',
      sessionId: 'live-opts-provider-1',
      cwd,
      images: [],
      permissionMode: 'default',
      toolsSettings: { allowedTools: [], disallowedTools: ['Bash'], skipPermissions: false },
    },
    wsTurnTwo,
  );

  await turnTwoReachedTheProcess.promise;

  assert.equal(sdkState.queryCalls.length, 1, 'the process must NOT have been recreated — that kills the background shell');
  assert.equal(sdkState.closeCalls, 0, 'and it must not have been closed');
  assert.deepEqual(
    sdkState.permissionModes,
    ['default'],
    'the mode switch must be pushed into the running process via setPermissionMode()',
  );
  // The security regression this closes: refreshing `turnContext` cannot tighten
  // anything, because the CLI auto-approves from the `--allowedTools` list it was
  // spawned with WITHOUT calling `canUseTool` at all. Only a rule pushed into the
  // CLI's own permission engine stops it. Verified against the real binary in
  // `spikes/streaming-input-mode/live-deny.mjs`.
  assert.deepEqual(
    sdkState.flagSettings,
    [{ permissions: { ask: [], deny: ['Bash'] } }],
    'the newly disallowed tool must be denied inside the live CLI, not just inside our callback',
  );

  // This is literally the closure the SDK captured on turn 1. Before the fix it
  // auto-approved everything (turn 1 was `bypassPermissions`) and reported to
  // turn 1's writer.
  const capturedCanUseTool = sdkState.queryCalls[0].options.canUseTool as (
    toolName: string,
    input: unknown,
    context: unknown,
  ) => Promise<{ behavior: string; message?: string }>;

  const bashDecision = await capturedCanUseTool('Bash', { command: 'rm -rf /tmp/whatever' }, {});
  assert.equal(bashDecision.behavior, 'deny', 'turn 2 disallowed Bash; the captured closure must honour that');
  assert.equal(bashDecision.message, 'Tool disallowed by settings');

  // A tool on neither list must prompt — and the prompt belongs to the turn that
  // is actually running.
  const writeDecision = capturedCanUseTool('Write', { file_path: '/tmp/x', content: 'y' }, {});
  await waitFor(() => wsTurnTwo.sent.some((m) => m.kind === 'permission_request'), {
    message: 'a permission_request on turn 2\'s writer',
  });
  assert.equal(
    wsTurnOne.sent.some((m) => m.kind === 'permission_request'),
    false,
    'the completed run\'s writer must not receive turn 2\'s frames — that is what corrupts a reconnecting client\'s seq',
  );
  const request = wsTurnTwo.sent.find((m) => m.kind === 'permission_request') as { requestId: string };
  resolveToolApproval(request.requestId, { allow: false, message: 'no thanks' });
  assert.equal((await writeDecision).behavior, 'deny');

  // The mid-turn settlement must have reached the UI, and the ambient
  // housekeeping task must NOT have.
  await waitFor(() => uiClient.frames.length > 0, { message: 'a background_task frame' });
  assert.deepEqual(
    uiClient.frames.map((f) => f.taskId),
    ['bg-shell'],
    'exactly the real task: a mid-turn settlement must not be silently dropped, and a skip_transcript task must not be shown',
  );
  assert.equal(uiClient.frames[0].status, 'stopped', 'a reaper kill must be reported as such');
  assert.equal(uiClient.frames[0].sessionId, 'live-opts-app');

  releaseTurnTwoResult.resolve();
  await turnTwo;

  connectedClients.clear();
  claudeSessionPool._resetForTests();
});
