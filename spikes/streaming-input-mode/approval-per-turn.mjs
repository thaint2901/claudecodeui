/**
 * Is a tool approval per TURN or per SESSION on one held process?
 *
 * Corrects hazard H1 in FINDINGS.md, which recorded "approval becomes
 * per-session instead of per-turn" and fed a risk paragraph into the design
 * spec. That conclusion was an artifact: `harness.mjs` gated turn 1 with
 * `bash -c 'for i in $(seq 1 90); …'` and turn 2 with `echo turn2-alive`,
 * which the CLI classifies as safe and never routes through `canUseTool`. Two
 * different commands, so the comparison never held.
 *
 * This probe uses the SAME command shape in both turns and refuses to answer
 * unless turn 1 was actually gated.
 *
 * Run: node spikes/streaming-input-mode/approval-per-turn.mjs
 */
import { openSession, endSession, tempCwd, sanitizedEnv, verdict } from './_probe-lib.mjs';

const calls = [];
const { input, q } = openSession({
  cwd: tempCwd('approval'),
  env: sanitizedEnv(),
  allowedTools: [], // nothing pre-approved, so a gated tool must reach canUseTool
  permissionMode: 'default',
  canUseTool: async (name, toolInput) => {
    calls.push(name);
    console.log(`   canUseTool -> ${name}`);
    return { behavior: 'allow', updatedInput: toolInput };
  },
});

let endTurn = null;
const drain = (async () => {
  for await (const message of q) {
    if (message.type === 'assistant') {
      for (const block of message.message.content ?? []) {
        if (block.type === 'tool_use') {
          console.log(`   tool_use ${block.name} ${JSON.stringify(block.input).slice(0, 60)}`);
        }
      }
    }
    if (message.type === 'result' && endTurn) endTurn();
  }
})();

const turn = (text) => new Promise((resolve) => { endTurn = resolve; input.push(text); });

console.log('--- TURN 1');
const beforeTurn1 = calls.length;
await turn('Use the Bash tool to run exactly: touch approval-one');
const turn1Calls = calls.length - beforeTurn1;
console.log(`TURN 1 canUseTool consulted: ${turn1Calls}`);

console.log('--- TURN 2 (same command shape, same process)');
const beforeTurn2 = calls.length;
await turn('Use the Bash tool to run exactly: touch approval-two');
const turn2Calls = calls.length - beforeTurn2;
console.log(`TURN 2 canUseTool consulted: ${turn2Calls}`);

verdict({
  inconclusive: turn1Calls === 0,
  reason: 'turn 1 was never gated either, so turn 2 proves nothing about caching',
  yes: turn2Calls > 0,
  detail: {
    yes: 'approval is per TURN — the second turn was re-consulted. H1 was wrong.',
    no: 'approval persisted for the session — the second turn was auto-approved. H1 holds.',
  },
});

await endSession(input, q);
await drain.catch(() => {});
process.exit(0);
