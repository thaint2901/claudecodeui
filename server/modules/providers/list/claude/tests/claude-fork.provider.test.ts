import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findForkResumePoint, ForkResumePointError } from '@/modules/providers/list/claude/claude-fork.provider.js';

const SID = 'prov-session-1';
const line = (obj: Record<string, unknown>) => JSON.stringify({ sessionId: SID, ...obj });

async function withFixture(run: (jsonlPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fork-fixture-'));
  const jsonlPath = path.join(dir, `${SID}.jsonl`);
  await writeFile(jsonlPath, [
    line({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'ONE' } }),
    line({ uuid: 'a1', type: 'assistant', message: { role: 'assistant', content: [] } }),
    line({ uuid: 'u2', type: 'user', message: { role: 'user', content: 'TWO' } }),
    line({ uuid: 'a2', type: 'assistant', message: { role: 'assistant', content: [] } }),
    // foreign-session line that must be ignored:
    JSON.stringify({ sessionId: 'other', uuid: 'x9', type: 'assistant' }),
  ].join('\n'));
  try { await run(jsonlPath); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('finds the assistant message preceding the edited prompt', async () => {
  await withFixture(async (p) => {
    assert.deepEqual(await findForkResumePoint(p, SID, 'u2'), { resumeSessionAt: 'a1' });
  });
});

test('editing the first prompt resumes from the beginning', async () => {
  await withFixture(async (p) => {
    assert.deepEqual(await findForkResumePoint(p, SID, 'u1'), { resumeSessionAt: null });
  });
});

test('unknown uuid throws RESUME_POINT_NOT_FOUND', async () => {
  await withFixture(async (p) => {
    await assert.rejects(
      () => findForkResumePoint(p, SID, 'missing-uuid'),
      (err: unknown) => err instanceof ForkResumePointError && err.code === 'RESUME_POINT_NOT_FOUND',
    );
  });
});
