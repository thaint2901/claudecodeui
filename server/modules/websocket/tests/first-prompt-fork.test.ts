import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

const PROVIDER_SESSION_ID = 'prov-first-prompt';

/** Minimal ws double: captures handlers registered by handleChatConnection and outbound frames. */
class FakeWs {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  private handlers = new Map<string, (...args: unknown[]) => unknown>();

  on(event: string, callback: (...args: unknown[]) => unknown): void {
    this.handlers.set(event, callback);
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  async emit(event: string, argument: unknown): Promise<void> {
    await this.handlers.get(event)?.(argument);
  }
}

async function withFirstPromptFixture(
  run: (context: { ws: FakeWs; spawnCalls: unknown[][] }) => Promise<void>
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'first-prompt-fork-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  const jsonlPath = path.join(tempDirectory, `${PROVIDER_SESSION_ID}.jsonl`);

  // A transcript whose FIRST entry is the user prompt being edited — there is
  // no preceding assistant turn to anchor resumeSessionAt on.
  const line = (entry: Record<string, unknown>) =>
    JSON.stringify({ sessionId: PROVIDER_SESSION_ID, ...entry });
  await writeFile(jsonlPath, [
    line({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'ONE' } }),
    line({ uuid: 'a1', type: 'assistant', message: { role: 'assistant', content: [] } }),
  ].join('\n'));

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    sessionsDb.createSession(
      PROVIDER_SESSION_ID,
      'claude',
      '/workspace/first-prompt',
      undefined,
      undefined,
      undefined,
      jsonlPath
    );

    const ws = new FakeWs();
    const spawnCalls: unknown[][] = [];
    handleChatConnection(
      ws as never,
      { user: { id: 1 } } as unknown as AuthenticatedWebSocketRequest,
      {
        resolveRuntime: () => ({
          run: async (...args: unknown[]) => {
            spawnCalls.push(args);
          },
          abort: () => true,
        }),
      } as never
    );

    await run({ ws, spawnCalls });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('editing the first prompt is rejected with FORK_FAILED and never spawns', async () => {
  await withFirstPromptFixture(async ({ ws, spawnCalls }) => {
    await ws.emit(
      'message',
      JSON.stringify({
        type: 'chat.send',
        sessionId: PROVIDER_SESSION_ID,
        content: 'Say exactly: EDITED',
        options: { editAtMessageUuid: 'u1' },
      })
    );

    const protocolError = ws.sent.find((frame) => frame.kind === 'protocol_error');
    assert.ok(protocolError, `expected a protocol_error frame, got: ${JSON.stringify(ws.sent)}`);
    assert.equal(protocolError.code, 'FORK_FAILED');
    assert.match(String(protocolError.error), /first prompt/i);
    assert.equal(spawnCalls.length, 0);
  });
});

test('editing a later prompt still forks (regression guard for the null-anchor rejection)', async () => {
  await withFirstPromptFixture(async ({ ws, spawnCalls }) => {
    // u2 sits after assistant a1, so the resume anchor resolves to a1.
    const jsonlPath = sessionsDb.getSessionById(PROVIDER_SESSION_ID)?.jsonl_path;
    assert.ok(jsonlPath);
    await writeFile(jsonlPath, [
      JSON.stringify({ sessionId: PROVIDER_SESSION_ID, uuid: 'u1', type: 'user', message: { role: 'user', content: 'ONE' } }),
      JSON.stringify({ sessionId: PROVIDER_SESSION_ID, uuid: 'a1', type: 'assistant', message: { role: 'assistant', content: [] } }),
      JSON.stringify({ sessionId: PROVIDER_SESSION_ID, uuid: 'u2', type: 'user', message: { role: 'user', content: 'TWO' } }),
    ].join('\n'));

    await ws.emit(
      'message',
      JSON.stringify({
        type: 'chat.send',
        sessionId: PROVIDER_SESSION_ID,
        content: 'Say exactly: EDITED',
        options: { editAtMessageUuid: 'u2' },
      })
    );

    assert.equal(
      ws.sent.some((frame) => frame.kind === 'protocol_error'),
      false,
      `unexpected protocol_error: ${JSON.stringify(ws.sent)}`
    );
    assert.equal(spawnCalls.length, 1);
    const options = spawnCalls[0][1] as Record<string, unknown>;
    assert.equal(options.forkSession, true);
    assert.equal(options.resumeSessionAt, 'a1');
  });
});
