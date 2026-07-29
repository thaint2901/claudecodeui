/**
 * Does an interrupted turn emit a terminating `result`?
 *
 * Corrects hazard H2 in FINDINGS.md, which recorded "interrupt() produces no
 * turn terminator" and led `server/claude-sdk.js` to settle the turn itself on
 * abort — and led CLAUDE.md to state the same as fact. Measurement says the
 * opposite: a `result` with `subtype: 'error_during_execution'` arrives within
 * milliseconds.
 *
 * The likely reason H2 went wrong is the reason this probe guards against
 * below: interrupting when no turn is actually in flight produces no result,
 * because there is nothing to terminate.
 *
 * Run: node spikes/streaming-input-mode/interrupt-result.mjs
 */
import { openSession, endSession, tempCwd, sanitizedEnv, verdict } from './_probe-lib.mjs';

const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

const { input, q } = openSession({
  cwd: tempCwd('interrupt'),
  env: sanitizedEnv(),
  allowedTools: ['Bash'],
  permissionMode: 'bypassPermissions', // keep the probe about interrupt, not approval
});

/** Proof that a turn was genuinely mid-flight when we interrupted. */
let sawToolUse = false;
let resultBeforeInterrupt = false;
let interruptCalled = false;
const resultsAfterInterrupt = [];

const drain = (async () => {
  for await (const message of q) {
    if (message.type === 'assistant') {
      for (const block of message.message.content ?? []) {
        if (block.type === 'tool_use') {
          sawToolUse = true;
          console.log(`[${at()}] tool_use ${block.name}`);
        }
      }
    }
    if (message.type === 'result') {
      console.log(`[${at()}] RESULT subtype=${message.subtype}`);
      if (interruptCalled) resultsAfterInterrupt.push(message.subtype);
      else resultBeforeInterrupt = true;
    }
  }
})();

console.log('sending a long FOREGROUND turn (not backgrounded)…');
input.push('Use the Bash tool (NOT background) to run exactly: sleep 45; echo done');

// Long enough for the CLI to reach the tool call, short enough to stay inside it.
await new Promise((resolve) => setTimeout(resolve, 8000));

console.log(`[${at()}] calling interrupt()…`);
interruptCalled = true;
let interruptError = null;
try {
  const receipt = await q.interrupt();
  console.log(`[${at()}] interrupt() resolved ->`, receipt);
} catch (error) {
  interruptError = error;
  console.log(`[${at()}] interrupt() THREW: ${error.message}`);
}

console.log(`[${at()}] waiting 30s for a post-interrupt result…`);
await new Promise((resolve) => setTimeout(resolve, 30000));

verdict({
  inconclusive: !sawToolUse || resultBeforeInterrupt || interruptError !== null,
  reason: !sawToolUse
    ? 'no tool_use was ever seen, so the turn may not have been mid-flight'
    : resultBeforeInterrupt
      ? 'the turn had already ended before interrupt() was called — nothing to interrupt'
      : 'interrupt() itself threw, so the emit behaviour was never exercised',
  yes: resultsAfterInterrupt.length > 0,
  detail: {
    yes: `interrupt DOES emit a terminator: ${JSON.stringify(resultsAfterInterrupt)}. `
      + 'The pool must let that result settle the turn instead of settling it blind.',
    no: 'no result arrived in 30s — the awaiting turn really must be settled explicitly.',
  },
});

await endSession(input, q);
await drain.catch(() => {});
process.exit(0);
