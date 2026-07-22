import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `claude-subagent-test-${process.pid}.db`);

const { initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { ClaudeSessionsProvider } = await import('@/modules/providers/list/claude/claude-sessions.provider.js');

await initializeDatabase();

const PROVIDER_SESSION_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = 'abc123def456';
const PARENT_TOOL_ID = 'toolu_parent01';

function jsonlLine(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

test('fetchHistory stamps parentToolUseId onto subagent child messages', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'claude-proj-'));
  try {
    const mainJsonl = path.join(projectDir, `${PROVIDER_SESSION_ID}.jsonl`);
    // Parent: assistant Agent tool_use, then user tool_result carrying toolUseResult.agentId
    await writeFile(mainJsonl, [
      jsonlLine({
        sessionId: PROVIDER_SESSION_ID, timestamp: '2026-07-22T10:00:00Z', type: 'assistant',
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: PARENT_TOOL_ID, name: 'Agent',
            input: { description: 'Review readme', subagent_type: 'general-purpose', prompt: 'Review the readme' } },
        ] },
      }),
      jsonlLine({
        sessionId: PROVIDER_SESSION_ID, timestamp: '2026-07-22T10:01:00Z', type: 'user',
        toolUseResult: { agentId: AGENT_ID },
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: PARENT_TOOL_ID, content: 'Report: looks fine' },
        ] },
      }),
    ].join(''));

    // Child transcript at the REAL nested location
    const subagentsDir = path.join(projectDir, PROVIDER_SESSION_ID, 'subagents');
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(path.join(subagentsDir, `agent-${AGENT_ID}.jsonl`), [
      jsonlLine({
        timestamp: '2026-07-22T10:00:10Z', type: 'assistant',
        message: { role: 'assistant', content: [
          { type: 'text', text: 'Reading the readme now.' },
          { type: 'tool_use', id: 'toolu_child01', name: 'Read', input: { file_path: '/tmp/README.md' } },
        ] },
      }),
      jsonlLine({
        timestamp: '2026-07-22T10:00:20Z', type: 'user',
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_child01', content: '# README' },
        ] },
      }),
    ].join(''));

    const appSessionId = sessionsDb.createSession(
      PROVIDER_SESSION_ID, 'claude', projectDir, undefined, undefined, undefined, mainJsonl,
    );

    const provider = new ClaudeSessionsProvider();
    const result = await provider.fetchHistory(appSessionId, {
      providerSessionId: PROVIDER_SESSION_ID, limit: null, offset: 0,
    });

    const children = result.messages.filter((m) => m.parentToolUseId === PARENT_TOOL_ID);
    // Child text + child tool_use at minimum (tool_result attaches to tool_use downstream)
    assert.ok(children.length >= 2, `expected stamped children, got ${children.length}`);
    const childToolUse = children.find((m) => m.kind === 'tool_use');
    assert.equal(childToolUse?.toolName, 'Read');
    const childText = children.find((m) => m.kind === 'text');
    assert.equal(childText?.content, 'Reading the readme now.');

    // Parent Agent tool_use is top-level (no parentToolUseId) and has no subagentTools field
    const parent = result.messages.find((m) => m.toolId === PARENT_TOOL_ID);
    assert.ok(parent);
    assert.equal(parent.parentToolUseId, undefined);
    assert.equal('subagentTools' in parent, false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
