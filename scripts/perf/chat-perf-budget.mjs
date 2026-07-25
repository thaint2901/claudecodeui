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
 * Usage:
 *   1. google-chrome --remote-debugging-port=9222
 *   2. open the app and navigate to a session with several code blocks
 *      (an empty session measures nothing — the cost scales with highlighted
 *      tokens, not with message count)
 *   3. npm run perf:budget
 *
 * Env:
 *   PERF_CDP_PORT   devtools port (default 9222)
 *   PERF_URL_MATCH  substring used to pick the tab (default "localhost")
 *
 * Exits non-zero when a budget is exceeded, so it can gate a release check.
 */

import WebSocket from 'ws';

const CDP_HOST = process.env.PERF_CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.PERF_CDP_PORT || 9222);
const URL_MATCH = process.env.PERF_URL_MATCH || 'localhost';

/** Thresholds come from .claude/rules/performance.md, plus one chat-specific rule. */
const BUDGET = {
  inpMs: 200,
  // A single task over ~50ms is what reads as a visible stutter; the aggregate
  // budgets above can pass while one long task still ruins the interaction.
  longTaskMs: 50,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pickTarget() {
  let targets;
  try {
    const response = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
    targets = await response.json();
  } catch (error) {
    throw new Error(
      `Cannot reach Chrome DevTools on ${CDP_HOST}:${CDP_PORT} (${error.message}).\n` +
      `Start Chrome with:  google-chrome --remote-debugging-port=${CDP_PORT}`,
    );
  }
  const page = targets.find((t) => t.type === 'page' && String(t.url).includes(URL_MATCH));
  if (!page) {
    const seen = targets.filter((t) => t.type === 'page').map((t) => t.url).join('\n  ');
    throw new Error(`No open tab whose URL contains "${URL_MATCH}". Open tabs:\n  ${seen || '(none)'}`);
  }
  return page;
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
      if (msg.error) entry.reject(new Error(`${msg.error.message} (${entry.method})`));
      else entry.resolve(msg.result);
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
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

const ARM = `(() => {
  window.__perfBudget = { long: [], events: [] };
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
  return 'armed';
})()`;

const COLLECT = `(() => {
  const b = window.__perfBudget || { long: [], events: [] };
  window.__pbLong?.disconnect();
  window.__pbEvent?.disconnect();
  return {
    longCount: b.long.length,
    longTotal: b.long.reduce((s, d) => s + d, 0),
    longMax: b.long.reduce((m, d) => Math.max(m, d), 0),
    inpMax: b.events.reduce((m, e) => Math.max(m, e.dur), 0),
    procMax: b.events.reduce((m, e) => Math.max(m, e.proc), 0),
    eventCount: b.events.length,
  };
})()`;

/** Focuses the composer; returns false when the chat view is not on screen. */
const FOCUS_COMPOSER = `(() => {
  const el = document.querySelector('.chat-composer-shell textarea')
    || document.querySelector('form textarea')
    || document.querySelector('textarea');
  if (!el) return false;
  el.focus();
  return document.activeElement === el;
})()`;

const clickTab = (label) => `(() => {
  const wanted = ${JSON.stringify(label)}.toLowerCase();
  const btn = [...document.querySelectorAll('button, [role="tab"]')]
    .find((b) => (b.textContent || '').trim().toLowerCase() === wanted);
  if (!btn) return false;
  btn.click();
  return true;
})()`;

async function typeChars(cdp, text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(30);
  }
}

async function probeTyping(cdp) {
  const focused = await cdp.evaluate(FOCUS_COMPOSER);
  if (!focused) throw new Error('Composer textarea not found — is the chat tab open on a session?');
  await cdp.evaluate(ARM);
  await typeChars(cdp, 'perf budget probe');
  await sleep(1500);
  const result = await cdp.evaluate(COLLECT);
  // Leave the composer as we found it rather than stranding a draft.
  await cdp.evaluate(`(() => {
    const el = document.activeElement;
    if (el && el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  })()`);
  return result;
}

async function probeTabSwitch(cdp) {
  await cdp.evaluate(ARM);
  const away = await cdp.evaluate(clickTab('Files'));
  if (!away) throw new Error('Files tab button not found — cannot run the tab-switch probe');
  await sleep(1200);
  const back = await cdp.evaluate(clickTab('Chat'));
  if (!back) throw new Error('Chat tab button not found — the view was left on Files');
  await sleep(1500);
  return cdp.evaluate(COLLECT);
}

function report(name, result, checks) {
  const failures = checks.filter((c) => !c.ok);
  const status = failures.length === 0 ? 'PASS' : 'FAIL';
  console.log(`\n${status}  ${name}`);
  console.log(`      long tasks: ${result.longCount} (total ${result.longTotal}ms, max ${result.longMax}ms)`);
  console.log(`      interaction events > 16ms: ${result.eventCount} (max duration ${result.inpMax}ms, max processing ${result.procMax}ms)`);
  for (const check of checks) {
    console.log(`      ${check.ok ? 'ok  ' : 'over'}  ${check.label}`);
  }
  return failures.length === 0;
}

async function main() {
  const target = await pickTarget();
  console.log(`Attached to: ${target.title}\n             ${target.url}`);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  let passed = true;
  try {
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
  console.error(`\n${error.message}`);
  process.exitCode = 2;
});
