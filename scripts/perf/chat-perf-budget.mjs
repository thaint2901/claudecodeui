#!/usr/bin/env node
/**
 * Chat view performance budget check.
 *
 * Drives an already-open Chrome tab over the DevTools Protocol and measures the
 * two interactions that regressed in July 2026: typing into the composer, and
 * switching away from the chat tab and back. Both used to re-render the whole
 * visible transcript, which re-runs the markdown pipeline and rebuilds one
 * React element per syntax-highlight token.
 *
 * Deliberately no Playwright/Puppeteer: those pull a ~300MB browser download
 * into a repo that has no browser-test infrastructure. `ws` is already a
 * dependency, and CDP over a raw socket is enough to dispatch real key events.
 *
 * A green run has to mean something. Three preconditions are enforced rather
 * than assumed, because each of them used to be a way to pass while measuring
 * nothing:
 *   - the target port is REQUIRED, never guessed. Port 3001 can serve a weeks-
 *     stale prebuilt `dist/`, so "first tab on localhost" could report a green
 *     budget for a build that is not the one under test.
 *   - the page must actually contain highlighted code blocks. The cost being
 *     measured scales with syntax-highlight tokens, so an empty session is not
 *     a cheap page, it is an unmeasured one.
 *   - every probe must observe live frames (and, for typing, real interaction
 *     events). Zero samples now fails as NOT MEASURED instead of passing.
 *
 * Usage:
 *   1. google-chrome --remote-debugging-port=9222
 *   2. open the app on the port under test and navigate to a session with
 *      several code blocks
 *   3. npm run perf:budget -- --port=5174
 *
 * Env (CLI flags win):
 *   PERF_APP_PORT   port of the app under test  (REQUIRED, or --port=)
 *   PERF_CDP_PORT   devtools port (default 9222)
 *   PERF_CDP_HOST   devtools host (default 127.0.0.1)
 *
 * Exit codes: 0 budgets met · 1 budget exceeded · 2 could not measure.
 */

import WebSocket from 'ws';

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const CDP_HOST = flag('cdp-host') || process.env.PERF_CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(flag('cdp-port') || process.env.PERF_CDP_PORT || 9222);
const APP_PORT = flag('port') || process.env.PERF_APP_PORT;

/** Thresholds come from .claude/rules/performance.md, plus one chat-specific rule. */
const BUDGET = {
  inpMs: 200,
  // A single task over ~50ms is what reads as a visible stutter; the aggregate
  // budgets above can pass while one long task still ruins the interaction.
  longTaskMs: 50,
};

/** Thrown for "the measurement could not be taken" — distinct from a budget miss. */
class NotMeasured extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requirePort() {
  if (!APP_PORT || !/^\d+$/.test(String(APP_PORT))) {
    throw new NotMeasured(
      'The port of the app under test is required — it is never guessed.\n' +
      'Port 3001 can serve a stale prebuilt dist/, so picking a tab by hand would\n' +
      'let this gate report a green budget for the wrong build.\n\n' +
      '  npm run perf:budget -- --port=5174\n' +
      '  PERF_APP_PORT=5174 npm run perf:budget',
    );
  }
  return String(APP_PORT);
}

async function pickTarget(port) {
  let targets;
  try {
    const response = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
    targets = await response.json();
  } catch (error) {
    throw new NotMeasured(
      `Cannot reach Chrome DevTools on ${CDP_HOST}:${CDP_PORT} (${error.message}).\n` +
      `Start Chrome with:  google-chrome --remote-debugging-port=${CDP_PORT}`,
    );
  }
  const pages = targets.filter((t) => t.type === 'page');
  const matches = pages.filter((t) => String(t.url).includes(`:${port}/`));
  if (matches.length === 0) {
    const seen = pages.map((t) => t.url).join('\n  ');
    throw new NotMeasured(`No open tab served from port ${port}. Open tabs:\n  ${seen || '(none)'}`);
  }
  if (matches.length > 1) {
    const seen = matches.map((t) => t.url).join('\n  ');
    throw new NotMeasured(`More than one tab on port ${port} — close the extras so the target is unambiguous:\n  ${seen}`);
  }
  return matches[0];
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`${msg.error.message} (${entry.method})`));
      else entry.resolve(msg.result);
    });
    // Without these the script would sit forever on a half-open socket: every
    // pending promise is only ever settled by a matching response id.
    const abort = (reason) => {
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new NotMeasured(`DevTools connection ${reason} during ${entry.method}`));
      }
    };
    ws.on('close', () => abort('closed'));
    ws.on('error', (error) => abort(`errored (${error.message})`));
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', (error) => reject(new NotMeasured(`Cannot attach to the tab: ${error.message}`)));
    });
    return new Cdp(ws);
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NotMeasured(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }

  /** Runs `expression` in the page and returns its value, throwing on page-side errors. */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(`Page evaluation failed: ${exceptionDetails.text} ${exceptionDetails.exception?.description || ''}`);
    }
    return result.value;
  }

  close() {
    this.ws.close();
  }
}

/** Counts highlighted tokens so an unmeasurable page fails loudly up front. */
const INSPECT_PAGE = `(() => {
  const pane = document.querySelector('.chat-messages-pane');
  return {
    hasPane: Boolean(pane),
    pre: pane ? pane.querySelectorAll('pre').length : 0,
    tokens: pane ? pane.querySelectorAll('pre span').length : 0,
  };
})()`;

const ARM = `(() => {
  window.__perfBudget = { long: [], events: [], frames: 0 };
  for (const key of ['__pbLong', '__pbEvent']) {
    if (window[key]) { window[key].disconnect(); delete window[key]; }
  }
  window.__pbLong = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__perfBudget.long.push(Math.round(e.duration));
  });
  window.__pbLong.observe({ entryTypes: ['longtask'] });
  window.__pbEvent = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__perfBudget.events.push({
        name: e.name,
        dur: Math.round(e.duration),
        proc: Math.round(e.processingEnd - e.processingStart),
      });
    }
  });
  window.__pbEvent.observe({ type: 'event', durationThreshold: 16, buffered: false });
  // Frame counter: proof the page was actually alive for the window we sampled.
  // Long-task and event counts can legitimately be zero on a fast build, so
  // they cannot distinguish "nothing went wrong" from "nothing was measured".
  window.__pbRaf = true;
  const tick = () => { if (!window.__pbRaf) return; window.__perfBudget.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return 'armed';
})()`;

const COLLECT = `(() => {
  const b = window.__perfBudget || { long: [], events: [], frames: 0 };
  window.__pbRaf = false;
  window.__pbLong?.disconnect();
  window.__pbEvent?.disconnect();
  return {
    longCount: b.long.length,
    longTotal: b.long.reduce((s, d) => s + d, 0),
    longMax: b.long.reduce((m, d) => Math.max(m, d), 0),
    inpMax: b.events.reduce((m, e) => Math.max(m, e.dur), 0),
    procMax: b.events.reduce((m, e) => Math.max(m, e.proc), 0),
    eventCount: b.events.length,
    frames: b.frames,
  };
})()`;

/**
 * Focuses the composer and remembers both the element and the draft already in
 * it, so the probe can put the user's text back rather than wiping it.
 */
const FOCUS_COMPOSER = `(() => {
  const el = document.querySelector('.chat-composer-shell textarea')
    || document.querySelector('form textarea')
    || document.querySelector('textarea');
  if (!el) return false;
  window.__pbComposer = el;
  window.__pbDraft = el.value;
  el.focus();
  return document.activeElement === el;
})()`;

/** Restores the pre-probe draft on the remembered element, not on activeElement. */
const RESTORE_COMPOSER = `(() => {
  const el = window.__pbComposer;
  if (!el) return 'no-element';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, window.__pbDraft ?? '');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  delete window.__pbComposer;
  delete window.__pbDraft;
  return 'restored';
})()`;

const clickTab = (label) => `(() => {
  const wanted = ${JSON.stringify(label)}.toLowerCase();
  const btn = [...document.querySelectorAll('button, [role="tab"]')]
    .find((b) => (b.textContent || '').trim().toLowerCase() === wanted);
  if (!btn) return false;
  btn.click();
  return true;
})()`;

const CHAT_PANE_VISIBLE = `Boolean(document.querySelector('.chat-messages-pane')?.offsetParent)`;

async function typeChars(cdp, text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(30);
  }
}

async function probeTyping(cdp) {
  const focused = await cdp.evaluate(FOCUS_COMPOSER);
  if (!focused) throw new NotMeasured('Composer textarea not found — is the chat tab open on a session?');
  await cdp.evaluate(ARM);
  await typeChars(cdp, 'perf budget probe');
  await sleep(1500);
  const result = await cdp.evaluate(COLLECT);
  await cdp.evaluate(RESTORE_COMPOSER);
  if (result.frames === 0) {
    throw new NotMeasured('Typing probe observed zero animation frames — the tab was backgrounded or frozen.');
  }
  if (result.eventCount === 0) {
    throw new NotMeasured(
      'Typing probe recorded no interaction events. Real keystrokes always produce them,\n' +
      'so this means the keys never reached the composer — not that typing was fast.',
    );
  }
  return result;
}

async function probeTabSwitch(cdp) {
  await cdp.evaluate(ARM);
  const away = await cdp.evaluate(clickTab('Files'));
  if (!away) throw new NotMeasured('Files tab button not found — cannot run the tab-switch probe');
  await sleep(1200);
  const leftChat = !(await cdp.evaluate(CHAT_PANE_VISIBLE));
  const back = await cdp.evaluate(clickTab('Chat'));
  if (!back) throw new NotMeasured('Chat tab button not found — the view was left on Files');
  await sleep(1500);
  const result = await cdp.evaluate(COLLECT);
  if (!leftChat) {
    throw new NotMeasured('Clicking Files never hid the transcript — the tab switch did not happen.');
  }
  if (!(await cdp.evaluate(CHAT_PANE_VISIBLE))) {
    throw new NotMeasured('The transcript did not come back after clicking Chat — the probe is not measuring a round trip.');
  }
  if (result.frames === 0) {
    throw new NotMeasured('Tab-switch probe observed zero animation frames — the tab was backgrounded or frozen.');
  }
  return result;
}

function report(name, result, checks) {
  const failures = checks.filter((c) => !c.ok);
  const status = failures.length === 0 ? 'PASS' : 'FAIL';
  console.log(`\n${status}  ${name}`);
  console.log(`      long tasks: ${result.longCount} (total ${result.longTotal}ms, max ${result.longMax}ms)`);
  console.log(`      interaction events > 16ms: ${result.eventCount} (max duration ${result.inpMax}ms, max processing ${result.procMax}ms)`);
  console.log(`      frames sampled: ${result.frames}`);
  for (const check of checks) {
    console.log(`      ${check.ok ? 'ok  ' : 'over'}  ${check.label}`);
  }
  return failures.length === 0;
}

async function main() {
  const port = requirePort();
  const target = await pickTarget(port);
  console.log(`Attached to: ${target.title}\n             ${target.url}`);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  let passed = true;
  try {
    const page = await cdp.evaluate(INSPECT_PAGE);
    if (!page.hasPane) {
      throw new NotMeasured('No chat transcript on this tab — open a session before running the budget.');
    }
    if (page.pre === 0) {
      throw new NotMeasured(
        'This session has no code blocks, so there is nothing to measure: the cost this\n' +
        'gate watches scales with syntax-highlight tokens, not with message count.\n' +
        'Open a session containing several code blocks and run it again.',
      );
    }
    console.log(`             ${page.pre} code blocks, ${page.tokens} highlighted tokens`);

    const typing = await probeTyping(cdp);
    passed = report('typing in composer', typing, [
      { label: `INP <= ${BUDGET.inpMs}ms`, ok: typing.inpMax <= BUDGET.inpMs },
      { label: `no long task > ${BUDGET.longTaskMs}ms`, ok: typing.longMax <= BUDGET.longTaskMs },
    ]) && passed;

    const tabs = await probeTabSwitch(cdp);
    passed = report('tab switch chat -> files -> chat', tabs, [
      { label: `no long task > ${BUDGET.longTaskMs}ms`, ok: tabs.longMax <= BUDGET.longTaskMs },
    ]) && passed;
  } finally {
    cdp.close();
  }

  console.log(passed ? '\nAll budgets met.' : '\nBudget exceeded.');
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  const label = error instanceof NotMeasured ? 'NOT MEASURED' : 'ERROR';
  console.error(`\n${label}: ${error.message}`);
  process.exitCode = 2;
});
