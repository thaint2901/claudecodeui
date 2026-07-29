/**
 * Shared plumbing for the streaming-input probes in this directory.
 *
 * Every helper here exists because a probe that skipped it produced a WRONG
 * answer that then reached a spec, a plan, and CLAUDE.md. Read `WHY` on each.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * A push-based `AsyncIterable<SDKUserMessage>` that stays open until closed —
 * the minimum needed to be in streaming input mode. Single-consumer, like
 * `server/claude-session-input-stream.js`.
 */
export function makeInputStream() {
  const waiters = [];
  const queued = [];
  let closed = false;
  return {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (queued.length > 0) {
          yield queued.shift();
          continue;
        }
        const next = await new Promise((resolve) => waiters.push(resolve));
        if (next === null) return;
        yield next;
      }
    },
    push(text) {
      const message = {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
      };
      if (waiters.length > 0) waiters.shift()(message);
      else queued.push(message);
    },
    close() {
      closed = true;
      while (waiters.length > 0) waiters.shift()(null);
    },
  };
}

/**
 * WHY: a probe measures the env it actually gets, not the env it meant to set.
 *
 * The CLI resolves env from THREE sources, and `options.env` is only one of
 * them: it can ADD what `settings.json` lacks but cannot REMOVE what
 * `settings.json` sets. On top of that, a probe launched from inside a Claude
 * Code session inherits that session's own flags through `process.env`.
 *
 * So neutralising a flag takes BOTH layers: drop it from the env we pass AND
 * cut the settings source that would re-inject it. Doing only one is how the
 * H1 "approval is per-session" conclusion got recorded as fact.
 *
 * @param {string[]} dropKeys env names this probe must guarantee are ABSENT.
 */
export function sanitizedEnv(dropKeys = []) {
  const env = { ...process.env };
  for (const key of dropKeys) delete env[key];
  return env;
}

/**
 * `settingSources` that exclude the user scope. ccui itself ships
 * `['project', 'user', 'local']` (`server/claude-sdk.js`), so a probe that
 * wants to simulate a host WITHOUT a flag in `~/.claude/settings.json` must
 * drop `'user'` here as well as from `env`.
 */
export const SETTING_SOURCES_NO_USER = ['project', 'local'];

export function tempCwd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function claudeExecutable() {
  return process.env.CLAUDE_CLI_PATH || path.join(os.homedir(), '.local/bin/claude');
}

/** Opens a streaming session with this directory's shared defaults. */
export function openSession({ cwd, env, allowedTools, permissionMode, canUseTool, settingSources }) {
  const input = makeInputStream();
  const options = {
    cwd,
    env,
    allowedTools,
    permissionMode,
    settingSources: settingSources ?? SETTING_SOURCES_NO_USER,
    pathToClaudeCodeExecutable: claudeExecutable(),
  };
  if (canUseTool) options.canUseTool = canUseTool;
  return { input, q: query({ prompt: input, options }) };
}

/** Closes the session without tripping on `close()` returning undefined. */
export async function endSession(input, q) {
  input.close();
  const closing = q.close?.();
  if (closing && typeof closing.then === 'function') await closing;
}

/**
 * WHY: a probe with only pass/fail branches cannot tell "the hypothesis is
 * false" apart from "the thing I meant to measure never happened". Both H1 and
 * H2 were recorded as findings when the real answer was the latter.
 *
 * `inconclusive` is therefore mandatory, and it is printed FIRST so it cannot
 * be mistaken for a result.
 */
export function verdict({ inconclusive, reason, yes, no, detail }) {
  console.log('');
  if (inconclusive) {
    console.log(`>>> INCONCLUSIVE: ${reason}`);
    console.log('    The probe did not exercise the condition. Fix the probe, do not record a finding.');
    return;
  }
  console.log(`>>> ${yes ? 'YES' : 'NO'}: ${yes ? detail.yes : detail.no}`);
}
