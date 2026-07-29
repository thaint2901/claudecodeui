/**
 * Which tracked tasks can outlive the turn that started them?
 *
 * The pool holds the CLI process open while `liveTaskIds` is non-empty, and it
 * currently adds EVERY `task_started`. That over-holds (a task belonging to the
 * turn pins ~320 MB after the turn ends) and the naive fix — "only hold for
 * background shells" — risks under-holding, because subagents run in the
 * background by default since CLI v2.1.198 and a backgrounded subagent also
 * outlives its turn.
 *
 * So the classification cannot be read off `task_type` alone. This probe
 * records `task_type` on `task_started` AND every `task_updated.patch`
 * (including `is_backgrounded`) for two shapes — a backgrounded Bash and a
 * subagent — so the filter can be designed from data instead of inference.
 *
 * Run: node spikes/streaming-input-mode/task-classification.mjs
 */
import { openSession, endSession, tempCwd, sanitizedEnv, verdict } from './_probe-lib.mjs';

// Simulate a host with no fork flag: drop it from env AND cut the user settings
// source that would re-inject it. See `sanitizedEnv` for why both are needed.
const { input, q } = openSession({
  cwd: tempCwd('taskclass'),
  env: sanitizedEnv(['CLAUDE_CODE_FORK_SUBAGENT', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']),
  allowedTools: ['Bash', 'Agent', 'Task'],
  permissionMode: 'bypassPermissions',
});

const startedEvents = [];
const updateEvents = [];
let endTurn = null;

const drain = (async () => {
  for await (const message of q) {
    if (message.type === 'system' && message.subtype === 'task_started') {
      startedEvents.push({
        task_id: message.task_id,
        task_type: message.task_type,
        has_tool_use_id: Boolean(message.tool_use_id),
        description: (message.description ?? '').slice(0, 48),
      });
      console.log(`   task_started task_type=${message.task_type} "${(message.description ?? '').slice(0, 40)}"`);
    }
    if (message.type === 'system' && message.subtype === 'task_updated') {
      updateEvents.push({ task_id: message.task_id, patch: message.patch });
      console.log(`   task_updated ${JSON.stringify(message.patch)}`);
    }
    if (message.type === 'result' && endTurn) endTurn();
  }
})();

const turn = (text) => new Promise((resolve) => { endTurn = resolve; input.push(text); });

console.log('--- TURN 1: backgrounded Bash');
await turn(
  'Use the Bash tool with run_in_background true to run exactly: '
  + "bash -c 'for i in 1 2 3 4 5 6 7 8 9 10; do echo t$i; sleep 3; done'. "
  + 'Do not wait, do not poll. Reply STARTED.',
);

console.log('--- TURN 2: a subagent');
await turn('Use the Agent tool to launch one subagent whose entire job is to reply with the single word PONG.');

// Let late task_updated frames land before classifying.
await new Promise((resolve) => setTimeout(resolve, 8000));

const byType = {};
for (const event of startedEvents) {
  byType[event.task_type ?? '(undefined)'] = (byType[event.task_type ?? '(undefined)'] ?? 0) + 1;
}
const backgroundedFlags = updateEvents
  .filter((event) => event.patch?.is_backgrounded !== undefined)
  .map((event) => `${event.task_id.slice(0, 8)}=${event.patch.is_backgrounded}`);

console.log('');
console.log('task_started by task_type :', JSON.stringify(byType));
console.log('is_backgrounded reported  :', backgroundedFlags.length ? backgroundedFlags.join(' ') : '(none)');
console.log('distinct task_ids started :', startedEvents.length);

verdict({
  inconclusive: startedEvents.length === 0,
  reason: 'no task_started arrived at all, so nothing was classified',
  yes: Object.keys(byType).length > 1 || backgroundedFlags.length > 0,
  detail: {
    yes: 'the stream distinguishes task shapes — the pool can filter on task_type '
      + 'and/or is_backgrounded instead of holding for every task_started.',
    no: 'every task looks identical in the stream; the pool cannot tell which '
      + 'tasks outlive their turn and must keep holding for all of them.',
  },
});

await endSession(input, q);
await drain.catch(() => {});
process.exit(0);
