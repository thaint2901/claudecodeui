// scripts/spike-resume-session-at.mjs
// Usage: node scripts/spike-resume-session-at.mjs
// Requires a working `claude` login. Creates a throwaway 3-turn session in a
// temp dir, then forks it twice (resumeSessionAt = user uuid vs assistant
// uuid) and prints what each branch JSONL contains.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const cwd = mkdtempSync(path.join(tmpdir(), 'fork-spike-'));
const base = { cwd, allowedTools: [], maxTurns: 1, extraArgs: { 'replay-user-messages': null } };

async function run(prompt, extra = {}) {
  const messages = [];
  for await (const m of query({ prompt, options: { ...base, ...extra } })) messages.push(m);
  return messages;
}

// 1) Build a 3-turn session, capturing user-message uuids as they replay.
let sessionId, userUuids = [], assistantUuids = [];
for (const prompt of ['Say exactly: ONE', 'Say exactly: TWO', 'Say exactly: THREE']) {
  const msgs = await run(prompt, sessionId ? { resume: sessionId } : {});
  for (const m of msgs) {
    if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
    if (m.type === 'user' && m.uuid) userUuids.push(m.uuid);
    if (m.type === 'assistant' && m.uuid) assistantUuids.push(m.uuid);
  }
}
console.log({ sessionId, userUuids, assistantUuids });

// 2) Fork at the SECOND user message uuid (simulating "edit prompt 2").
async function fork(label, resumeSessionAt) {
  const msgs = await run('Say exactly: EDITED', { resume: sessionId, forkSession: true, ...(resumeSessionAt ? { resumeSessionAt } : {}) });
  const forkId = msgs.find((m) => m.type === 'system' && m.subtype === 'init')?.session_id;
  // On-disk project dir name under ~/.claude/projects/ replaces both `/` and `.` with `-`.
  const projDir = path.join(homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
  const jsonl = readFileSync(path.join(projDir, `${forkId}.jsonl`), 'utf8');
  const texts = jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .map((e) => JSON.stringify(e.message?.content ?? e.summary ?? '').slice(0, 80));
  console.log(`\n=== ${label} (fork ${forkId}) ===`);
  console.log(texts.join('\n'));
}

await fork('resumeSessionAt = user uuid of turn 2 (want: ONE only, then EDITED)', userUuids[1]);
await fork('resumeSessionAt = assistant uuid of turn 1 (want: ONE only, then EDITED)', assistantUuids[0]);
await fork('no resumeSessionAt (want: full copy + EDITED)', undefined);
