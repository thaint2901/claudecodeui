/**
 * When a background task settles, WHICH frames announce it, and in what order?
 *
 * The pool clears its tracking on either a `task_notification` or a
 * `task_updated` whose `patch.status` is terminal, but only the notification is
 * forwarded to the user — so a task announced solely by `task_updated` settles
 * silently. Fixing that needs two facts inference cannot supply:
 *
 *   1. Does a settling task emit BOTH frames? (If it does, forwarding both would
 *      put two rows in the transcript for one task.)
 *   2. If both, in WHICH order? (The dedup rule must keep the richer frame — only
 *      `task_notification` carries `output_file` and `summary` — so "report the
 *      first, suppress the second" is only safe if the notification comes first.)
 *
 * Records every `task_started` / `task_progress` / `task_updated` /
 * `task_notification` in arrival order, grouped per task id.
 *
 * Run: node spikes/streaming-input-mode/task-settlement-frames.mjs
 */
import { openSession, endSession, tempCwd, sanitizedEnv, verdict } from './_probe-lib.mjs';

const { input, q } = openSession({
  cwd: tempCwd('tasksettle'),
  env: sanitizedEnv(['CLAUDE_CODE_FORK_SUBAGENT', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']),
  allowedTools: ['Bash', 'Agent', 'Task'],
  permissionMode: 'bypassPermissions',
});

/** @type {Map<string, Array<{ seq: number, at: number, subtype: string, label: string }>>} */
const perTask = new Map();
let seq = 0;
let endTurn = null;

const label = (message) => {
  if (message.subtype === 'task_updated') return `task_updated{${JSON.stringify(message.patch)}}`;
  if (message.subtype === 'task_notification') {
    return `task_notification{status:${message.status},output_file:${Boolean(message.output_file)}}`;
  }
  return message.subtype;
};

const drain = (async () => {
  for await (const message of q) {
    if (message.type === 'system' && typeof message.task_id === 'string'
      && ['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(message.subtype)) {
      seq += 1;
      if (!perTask.has(message.task_id)) perTask.set(message.task_id, []);
      perTask.get(message.task_id).push({
        seq, at: Date.now(), subtype: message.subtype, label: label(message),
      });
      console.log(`   #${seq} ${message.task_id.slice(0, 8)} ${label(message)}`);
    }
    if (message.type === 'result' && endTurn) endTurn();
  }
})();

const turn = (text) => new Promise((resolve) => { endTurn = resolve; input.push(text); });

console.log('--- TURN 1: a backgrounded Bash that finishes on its own');
await turn(
  'Use the Bash tool with run_in_background true to run exactly: '
  + "bash -c 'for i in 1 2 3; do echo t$i; sleep 2; done'. "
  + 'Do not wait, do not poll. Reply STARTED.',
);

console.log('--- TURN 2: a subagent');
await turn('Use the Agent tool to launch one subagent whose entire job is to reply with the single word PONG.');

// Let the shell finish and every late settlement frame land.
await new Promise((resolve) => setTimeout(resolve, 20000));

const TERMINAL = ['completed', 'failed', 'killed'];
const settled = [];
for (const [taskId, frames] of perTask) {
  const notification = frames.find((f) => f.subtype === 'task_notification') ?? null;
  const terminalUpdate = frames.find(
    (f) => f.subtype === 'task_updated' && TERMINAL.some((s) => f.label.includes(`"status":"${s}"`)),
  ) ?? null;
  settled.push({ taskId, notification, terminalUpdate, frames });
}

console.log('');
for (const entry of settled) {
  console.log(`task ${entry.taskId.slice(0, 8)}:`);
  for (const frame of entry.frames) console.log(`    #${frame.seq} ${frame.label}`);
  if (entry.notification && entry.terminalUpdate) {
    console.log(`  notification - terminal task_updated = ${entry.notification.at - entry.terminalUpdate.at} ms`);
  }
}

const bothFrames = settled.filter((e) => e.notification && e.terminalUpdate);
const notificationFirst = bothFrames.every((e) => e.notification.seq < e.terminalUpdate.seq);
const updateOnly = settled.filter((e) => !e.notification && e.terminalUpdate);
const gaps = bothFrames.map((e) => e.notification.at - e.terminalUpdate.at);

console.log('');
console.log('tasks emitting BOTH             :', bothFrames.length);
console.log('  ...notification first in all  :', bothFrames.length > 0 ? notificationFirst : 'n/a');
console.log('  ...notification lag (ms)      :', gaps.join(', ') || 'n/a');
console.log('tasks emitting only task_updated:', updateOnly.length);

verdict({
  inconclusive: settled.every((e) => !e.notification && !e.terminalUpdate),
  reason: 'no task settled at all during the probe, so no settlement frame shape was observed',
  yes: bothFrames.length > 0,
  detail: {
    yes: `a settling task can emit both frames, so forwarding both would double-report. `
      + `Notification first in every case: ${notificationFirst}. Lag after the terminal `
      + `task_updated: ${gaps.join(', ')} ms.`,
    no: 'each task announced its settlement through exactly one of the two frames, '
      + 'so both can be forwarded without a dedup rule.',
  },
});

await endSession(input, q);
await drain.catch(() => {});
process.exit(0);
