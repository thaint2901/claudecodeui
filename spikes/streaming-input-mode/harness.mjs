/**
 * SPIKE — streaming input mode feasibility probe. NOT production code.
 *
 * Answers the two open questions from the background-shell investigation:
 *   Q-A  does streaming input mode coexist with ccui's hooks + canUseTool + fork?
 *   Q-B  what does a live session cost in RAM?
 *
 * Plus the premise check that must not be assumed:
 *   Q-0  does a background shell actually survive a turn boundary here?
 *
 * Mirrors the option set ccui passes in server/claude-sdk.js (env forwarding,
 * Notification hook, canUseTool, permissionMode, pathToClaudeCodeExecutable)
 * so a green result here is evidence about ccui, not about a toy.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CWD = path.join(os.tmpdir(), `spike-streaming-${process.pid}`);
fs.mkdirSync(CWD, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s]`, ...a);

/** Push-based AsyncIterable that stays open until close() — the crux of streaming mode. */
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

// ---- instrumentation counters (the actual findings) -------------------------
const seen = {
  hookCalls: 0,
  canUseToolCalls: [],
  results: 0,
  sessionIds: new Set(),
  taskNotifications: [],
  bgTaskFile: null,
};

const env = { ...process.env };
delete env.CLAUDE_JOB_DIR;          // don't inherit this session's job dir
delete env.CLAUDE_BG_BACKEND;
delete env.CLAUDE_CODE_SESSION_ID;
env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT = '1';   // ccui sets this

const input = createInputStream();

const q = query({
  prompt: input,
  options: {
    cwd: CWD,
    env,
    permissionMode: 'default',            // force canUseTool to be exercised
    allowedTools: [],
    pathToClaudeCodeExecutable: '/home/thaint/.local/bin/claude',
    hooks: {
      Notification: [{
        matcher: '',
        hooks: [async () => { seen.hookCalls += 1; return {}; }],
      }],
      PreToolUse: [{
        matcher: '',
        hooks: [async (i) => { seen.hookCalls += 1; log(`   hook PreToolUse: ${i?.tool_name}`); return {}; }],
      }],
    },
    canUseTool: async (toolName, toolInput) => {
      seen.canUseToolCalls.push(toolName);
      log(`   canUseTool -> ${toolName} (approving)`);
      return { behavior: 'allow', updatedInput: toolInput };
    },
  },
});

// ---- turn demux: `result` ends a turn; the generator stays open -------------
let turnEnd = null;
const drain = (async () => {
  for await (const m of q) {
    if (m.session_id) seen.sessionIds.add(m.session_id);
    const s = JSON.stringify(m);
    const f = s.match(/(\/tmp\/[^"\\ ]+\.output)/);
    if (f && !seen.bgTaskFile) { seen.bgTaskFile = f[1]; log(`   bg task file: ${f[1]}`); }
    if (s.includes('task_notification') || s.includes('task-notification')) {
      const st = s.match(/<status>([a-z]+)<\/status>/) || s.match(/"status":"([a-z]+)"/);
      seen.taskNotifications.push(st ? st[1] : 'unknown');
      log(`   >>> TASK NOTIFICATION: ${st ? st[1] : s.slice(0, 200)}`);
    }
    if (m.type === 'result') {
      seen.results += 1;
      log(`   turn ${seen.results} ended (${m.subtype})`);
      if (turnEnd) { const r = turnEnd; turnEnd = null; r(m); }
    }
  }
  log('generator COMPLETED (process exiting)');
})();

const nextTurn = () => new Promise((res) => { turnEnd = res; });

async function send(text, label) {
  log(`--- TURN: ${label}`);
  const done = nextTurn();
  input.push(text);
  return done;
}

const MARK = `SPIKE_TICK_${process.pid}`;
const ticks = () => {
  try {
    return fs.readFileSync(seen.bgTaskFile, 'utf8').split('\n').filter((x) => x.includes('tick')).length;
  } catch { return -1; }
};
const claudeProc = () => {
  try {
    const out = execSync(
      `ps -eo pid,rss,args | grep -E "local/bin/claude --output-format stream-json" | grep -v grep || true`,
    ).toString().trim().split('\n').filter(Boolean);
    return out.map((l) => { const p = l.trim().split(/\s+/); return { pid: p[0], rssMB: (Number(p[1]) / 1024).toFixed(1) }; });
  } catch { return []; }
};

// ============================ THE SPIKE =====================================
log('Q-0 premise: does a background shell survive a turn boundary?');
await send(
  `Use the Bash tool with run_in_background true to run EXACTLY:\n\n`
  + `bash -c 'for i in $(seq 1 90); do echo ${MARK} tick $i; sleep 2; done'\n\n`
  + `Do not wait, do not poll. Immediately reply STARTED and end your turn.`,
  'start background shell',
);

log(`at turn-1 end      -> ticks=${ticks()}  claude procs=${JSON.stringify(claudeProc())}`);
await new Promise((r) => setTimeout(r, 12000));
const ticksAfterIdle = ticks();
log(`+12s idle          -> ticks=${ticksAfterIdle}   ${ticksAfterIdle > 5 ? '*** SURVIVED ***' : 'DEAD'}`);

log('Q-A part 1: do hooks + canUseTool still fire on a SECOND turn in the same query?');
const hooksBefore = seen.hookCalls;
const cutBefore = seen.canUseToolCalls.length;
await send('Use the Bash tool to run exactly: echo turn2-alive', 'second turn, needs approval');
log(`hook calls +${seen.hookCalls - hooksBefore}, canUseTool +${seen.canUseToolCalls.length - cutBefore} (${seen.canUseToolCalls.join(',')})`);
log(`ticks now=${ticks()} (background shell should STILL be climbing)`);

log('Q-A part 2: control methods that are streaming-only');
let bgOk = 'n/a';
let stopOk = 'n/a';
try { bgOk = String(await q.backgroundTasks()); } catch (e) { bgOk = `THREW: ${e.message}`; }
log(`backgroundTasks() -> ${bgOk}`);
try { await q.setPermissionMode('default'); log('setPermissionMode() -> ok'); } catch (e) { log(`setPermissionMode() THREW: ${e.message}`); }

log('Q-B: RAM of the live session process while idle');
await new Promise((r) => setTimeout(r, 3000));
log(`claude procs: ${JSON.stringify(claudeProc())}`);

log('interrupt() mid-turn, then verify the session still accepts a turn afterwards');
const interrupted = nextTurn();
input.push({
  type: 'user',
  message: { role: 'user', content: 'Use the Bash tool to run exactly: sleep 45' },
  parent_tool_use_id: null,
  timestamp: new Date().toISOString(),
});
await new Promise((r) => setTimeout(r, 6000));
let interruptOk = 'n/a';
try { await q.interrupt(); interruptOk = 'ok'; } catch (e) { interruptOk = `THREW: ${e.message}`; }
log(`interrupt() -> ${interruptOk}`);
const iRes = await Promise.race([interrupted, new Promise((r) => setTimeout(() => r({ subtype: 'NO_RESULT_WITHIN_30s' }), 30000))]);
log(`post-interrupt result subtype: ${iRes?.subtype}`);

const survivedInterrupt = await Promise.race([
  send('Reply with exactly: STILL-HERE', 'turn after interrupt').then(() => 'session usable'),
  new Promise((r) => setTimeout(() => r('SESSION DEAD after interrupt'), 45000)),
]);
log(`=> ${survivedInterrupt}`);

log('stopTask() on the still-running background shell');
let stopped = 'n/a';
const tid = seen.bgTaskFile?.match(/tasks\/([a-z0-9]+)\.output/)?.[1];
try { stopped = tid ? String(await q.stopTask(tid)) : 'no task id'; } catch (e) { stopped = `THREW: ${e.message}`; }
log(`stopTask(${tid}) -> ${stopped}`);

// ============================ SUMMARY =======================================
const finalTicks = ticks();
console.log('\n================ SPIKE FINDINGS ================');
console.log(`Q-0 bg shell survived turn boundary : ${ticksAfterIdle > 5 ? 'YES' : 'NO'} (ticks 5s→${ticksAfterIdle}, final ${finalTicks})`);
console.log(`Q-A hooks fired across turns        : ${seen.hookCalls} calls`);
console.log(`Q-A canUseTool fired across turns   : ${seen.canUseToolCalls.length} (${seen.canUseToolCalls.join(', ')})`);
console.log(`Q-A backgroundTasks() [Ctrl-B]      : ${bgOk}`);
console.log(`Q-A interrupt()                     : ${interruptOk} / after: ${survivedInterrupt}`);
console.log(`Q-A stopTask()                      : ${stopped}`);
console.log(`Q-A turns served by ONE process     : ${seen.results}`);
console.log(`Q-A distinct session ids            : ${seen.sessionIds.size} (${[...seen.sessionIds].join(', ')})`);
console.log(`    task notifications seen         : ${seen.taskNotifications.join(', ') || 'none'}`);
console.log(`Q-B RSS of live session             : ${JSON.stringify(claudeProc())}`);
console.log('================================================\n');

input.close();
await Promise.race([drain, new Promise((r) => setTimeout(r, 10000))]);
try { fs.rmSync(CWD, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(0);
