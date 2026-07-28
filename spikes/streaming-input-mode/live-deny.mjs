/**
 * SPIKE — does `applyFlagSettings({ permissions: { deny: [...] } })` actually
 * stop a RUNNING claude CLI from auto-approving a tool that was in its
 * spawn-time `--allowedTools` allowlist? NOT production code.
 *
 * Why this cannot be a unit test: the thing under test is the CLI's own
 * permission engine. A faked `query()` has no permission engine, so a green
 * unit test would prove only that we called a method.
 *
 * Sequence, mirroring the real regression:
 *   1. Start a live session with permissionMode 'default' and Bash ALLOWED.
 *      Turn 1 runs Bash — expected: canUseTool is NOT consulted (the CLI
 *      auto-approves from its allowlist). That is the hole.
 *   2. Start a background shell, so the session is protected from recreation
 *      exactly as the pool would protect it.
 *   3. applyFlagSettings({ permissions: { deny: ['Bash'] } }) on the LIVE query.
 *   4. Ask for Bash again. Report whether it was denied / prompted (canUseTool
 *      consulted) or still auto-approved.
 *
 * Verdict lines are printed verbatim for the report.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CWD = path.join(os.tmpdir(), `spike-live-deny-${process.pid}`);
fs.mkdirSync(CWD, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s]`, ...a);

function createInputStream() {
  const pending = [];
  let waiting = null;
  let closed = false;
  return {
    push(text) {
      const msg = {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        timestamp: new Date().toISOString(),
      };
      if (waiting) { const w = waiting; waiting = null; w({ value: msg, done: false }); }
      else pending.push(msg);
    },
    close() {
      closed = true;
      if (waiting) { const w = waiting; waiting = null; w({ value: undefined, done: true }); }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((res) => { waiting = res; });
        },
        return() { closed = true; return Promise.resolve({ value: undefined, done: true }); },
      };
    },
  };
}

const seen = {
  canUseToolCalls: [],
  bashResults: [],
  toolUses: [],
};

const env = { ...process.env };
delete env.CLAUDE_JOB_DIR;
delete env.CLAUDE_BG_BACKEND;
delete env.CLAUDE_CODE_SESSION_ID;

const input = createInputStream();

const q = query({
  prompt: input,
  options: {
    cwd: CWD,
    env,
    permissionMode: 'default',
    // The exact shape ccui ships: the user's checked tools, plus the
    // auto-injected subagent dispatch tools.
    allowedTools: ['Bash', 'Agent', 'Task'],
    disallowedTools: [],
    tools: { type: 'preset', preset: 'claude_code' },
    pathToClaudeCodeExecutable: process.env.CLAUDE_CLI_PATH || '/home/thaint/.local/bin/claude',
    canUseTool: async (toolName, toolInput) => {
      seen.canUseToolCalls.push(toolName);
      log(`   canUseTool -> ${toolName} (ccui would decide here; approving so the run continues)`);
      return { behavior: 'allow', updatedInput: toolInput };
    },
  },
});

let turnEnd = null;
const drain = (async () => {
  for await (const m of q) {
    if (m.type === 'assistant') {
      for (const block of m.message?.content ?? []) {
        if (block.type === 'tool_use') {
          seen.toolUses.push(block.name);
        }
      }
    }
    if (m.type === 'user') {
      for (const block of m.message?.content ?? []) {
        if (block.type === 'tool_result') {
          const text = Array.isArray(block.content)
            ? block.content.map((c) => c.text ?? '').join('')
            : String(block.content ?? '');
          seen.bashResults.push({ isError: block.is_error === true, text: text.slice(0, 300) });
        }
      }
    }
    if (m.type === 'result') {
      log(`   turn ended (${m.subtype})`);
      if (turnEnd) { const r = turnEnd; turnEnd = null; r(m); }
    }
  }
  log('generator COMPLETED (process exiting)');
})();

const send = (text, label) => {
  log(`--- TURN: ${label}`);
  const done = new Promise((res) => { turnEnd = res; });
  input.push(text);
  return done;
};

// ---------------------------------------------------------------------------
log('STEP 1 — baseline: Bash is in the spawn-time allowlist');
const cutA = seen.canUseToolCalls.length;
const resA = seen.bashResults.length;
await send('Use the Bash tool to run exactly: echo BASELINE-OK', 'allowed Bash');
const baselineCanUseTool = seen.canUseToolCalls.slice(cutA);
const baselineResults = seen.bashResults.slice(resA);
log(`baseline canUseTool calls: ${JSON.stringify(baselineCanUseTool)}`);
log(`baseline tool_result: ${JSON.stringify(baselineResults)}`);

// ---------------------------------------------------------------------------
log('STEP 2 — start a background shell so the session must NOT be recreated');
await send(
  'Use the Bash tool with run_in_background true to run EXACTLY:\n\n'
  + "bash -c 'for i in $(seq 1 120); do echo tick $i; sleep 2; done'\n\n"
  + 'Do not wait, do not poll. Immediately reply STARTED and end your turn.',
  'background shell',
);
let bgTasks = 'n/a';
try { bgTasks = JSON.stringify(await q.backgroundTasks()); } catch (e) { bgTasks = `THREW: ${e.message}`; }
log(`backgroundTasks() -> ${bgTasks}`);

// ---------------------------------------------------------------------------
// A tool merely UN-CHECKED in ccui's Tools Settings means "prompt me", not
// "never" — `canUseTool` falls through to a permission_request for anything on
// neither list. So the faithful live mapping for that case is `ask`, and `deny`
// is reserved for tools the user put on `disallowedTools`. Both are measured.
log("STEP 3 — push the tightening LIVE: applyFlagSettings ask ['Bash']");
let applyAskOk = 'n/a';
try {
  await q.applyFlagSettings({ permissions: { ask: ['Bash'] } });
  applyAskOk = 'ok';
} catch (e) {
  applyAskOk = `THREW: ${e.message}`;
}
log(`applyFlagSettings({permissions:{ask:['Bash']}}) -> ${applyAskOk}`);

log('STEP 4 — ask for Bash again on the SAME live process (expect a PROMPT)');
const cutB = seen.canUseToolCalls.length;
const resB = seen.bashResults.length;
const useB = seen.toolUses.length;
await send('Use the Bash tool to run exactly: echo AFTER-ASK', 'Bash after live ask');
const askCanUseTool = seen.canUseToolCalls.slice(cutB);
const askResults = seen.bashResults.slice(resB);
const askToolUses = seen.toolUses.slice(useB);

// ---------------------------------------------------------------------------
log("STEP 5 — replace the flag layer with a hard deny: applyFlagSettings deny ['Bash']");
let applyDenyOk = 'n/a';
try {
  await q.applyFlagSettings({ permissions: { deny: ['Bash'] } });
  applyDenyOk = 'ok';
} catch (e) {
  applyDenyOk = `THREW: ${e.message}`;
}
log(`applyFlagSettings({permissions:{deny:['Bash']}}) -> ${applyDenyOk}`);

log('STEP 6 — ask for Bash again (expect a hard DENY, canUseTool never consulted)');
const cutC = seen.canUseToolCalls.length;
const resC = seen.bashResults.length;
const useC = seen.toolUses.length;
await send('Use the Bash tool to run exactly: echo AFTER-DENY', 'Bash after live deny');
const denyCanUseTool = seen.canUseToolCalls.slice(cutC);
const denyResults = seen.bashResults.slice(resC);
const denyToolUses = seen.toolUses.slice(useC);

// The whole point: none of this may have killed the background shell.
let bgStillAlive = 'n/a';
try { bgStillAlive = JSON.stringify(await q.backgroundTasks()); } catch (e) { bgStillAlive = `THREW: ${e.message}`; }

const verdict = (uses, calls, results) => {
  const blocked = results.some((r) => r.isError || /permission|denied|not allowed/i.test(r.text));
  if (calls.length > 0) return 'PROMPTED (reached canUseTool)';
  if (blocked) return 'DENIED by the CLI';
  if (uses.length === 0) return 'tool never attempted — inconclusive';
  return 'STILL AUTO-APPROVED — live tightening does NOT enforce';
};

console.log('\n================ LIVE-DENY FINDINGS ================');
console.log(`applyFlagSettings(ask) accepted        : ${applyAskOk}`);
console.log(`applyFlagSettings(deny) accepted       : ${applyDenyOk}`);
console.log(`STEP 1 canUseTool consulted           : ${baselineCanUseTool.length} ${JSON.stringify(baselineCanUseTool)}`);
console.log(`STEP 1 tool_result                    : ${JSON.stringify(baselineResults)}`);
console.log(`STEP 1 VERDICT (the hole)             : ${verdict(['Bash'], baselineCanUseTool, baselineResults)}`);
console.log(`STEP 4 tool_use attempted             : ${JSON.stringify(askToolUses)}`);
console.log(`STEP 4 canUseTool consulted           : ${askCanUseTool.length} ${JSON.stringify(askCanUseTool)}`);
console.log(`STEP 4 tool_result                    : ${JSON.stringify(askResults)}`);
console.log(`STEP 4 VERDICT (live 'ask')           : ${verdict(askToolUses, askCanUseTool, askResults)}`);
console.log(`STEP 6 tool_use attempted             : ${JSON.stringify(denyToolUses)}`);
console.log(`STEP 6 canUseTool consulted           : ${denyCanUseTool.length} ${JSON.stringify(denyCanUseTool)}`);
console.log(`STEP 6 tool_result                    : ${JSON.stringify(denyResults)}`);
console.log(`STEP 6 VERDICT (live 'deny')          : ${verdict(denyToolUses, denyCanUseTool, denyResults)}`);
console.log(`background task still alive afterwards : ${bgStillAlive}`);
console.log('====================================================\n');

input.close();
await Promise.race([drain, new Promise((r) => setTimeout(r, 10000))]);
try { fs.rmSync(CWD, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(0);
