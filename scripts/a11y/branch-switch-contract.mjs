#!/usr/bin/env node
/**
 * Branch-switch accessibility contract.
 *
 * The version pager (`‹ n/total ›` on a forked conversation) is the one control
 * in the app whose own subtree is destroyed by pressing it: switching swaps the
 * transcript, and the pager lives in the prompt that DIFFERS between siblings.
 * Everything hard about it follows from that — the button you pressed is gone,
 * so focus and the screen-reader announcement both have to be re-established by
 * something that outlives the button.
 *
 * Six review rounds re-derived the same browser probes by hand and each round
 * measured something slightly different. That drift is how a live region that
 * never mutated passed a green criterion. These are the requirement-level
 * statements, executable:
 *
 *   1  every switch is announced — including a repeat of a position already
 *      announced, both across a session change and WITHOUT one (measured as
 *      DOM mutations on the live node; `isSameNode` is not evidence that
 *      anything was spoken)
 *   2  a keyboard switch lands focus inside the pager
 *   3  a pointer switch leaves focus and the focus ring alone
 *   4  navigating away while the ACTIVATION is in flight drags nothing back:
 *      not the route (4a), not focus (4b), not the announcement (4c)
 *   7  the same, one await later, while the TRANSCRIPT REFRESH is in flight
 *      (7a/7b/7c) — a separate window with its own guard, and one the
 *      activation-stage probe can never reach, because pausing the activation
 *      makes the switch abort before it gets there
 *
 *      `switchBranch` guards the route twice, once before each await, so either
 *      guard alone keeps 4a/7a/4b/7b green — those four are defence in depth,
 *      not discriminators. Removing the guard inside `commit` fails 4c alone;
 *      removing the one after the refresh fails 7a alone. Every half of the
 *      fix has exactly one check that only it can turn red.
 *   5  20 consecutive keyboard switches, zero landings on <body>
 *   6  the live region is empty after a session change, never stale
 *   9  the layout guards from earlier rounds still hold
 *
 * Deliberately NOT here: "a switch that brings back no pager leaves focus in
 * the transcript, not on <body>". The behaviour ships and was measured by hand
 * (see the commit that added the fallback), but it cannot be staged reliably
 * from the browser. The case needs a branch with more history after the fork
 * point than the window loads; starving the sweep of pagers instead races the
 * sweep's own settle, so the check passed and failed on identical input. A
 * gate that is sometimes red teaches people to re-run it until it is green,
 * which is worse than admitting the gap.
 *
 * Conventions follow scripts/perf/chat-perf-budget.mjs, including its failure
 * discipline: the app port is REQUIRED and never guessed (port 3001 can serve a
 * weeks-stale prebuilt dist/), and anything that cannot actually be measured
 * exits 2 as NOT MEASURED rather than reporting a pass. Input is dispatched
 * through the DevTools input pipeline, not synthesised in the page: synthetic
 * events run ~3x faster here and would hide the timing bug this file exists to
 * catch.
 *
 * Usage:
 *   1. google-chrome --remote-debugging-port=9222
 *   2. open the app on the port under test, on a session with a version pager
 *   3. npm run a11y:branch -- --port=5174 --other-session=<some other id>
 *
 * Env (CLI flags win):
 *   A11Y_APP_PORT       port of the app under test        (REQUIRED, or --port=)
 *   A11Y_OTHER_SESSION  id of a DIFFERENT session, used by the leave-and-return
 *                       and navigate-away probes          (REQUIRED)
 *   A11Y_CDP_PORT       devtools port (default 9222)
 *   A11Y_CDP_HOST       devtools host (default 127.0.0.1)
 *
 * Exit codes: 0 contract met · 1 contract broken · 2 could not measure.
 */

import WebSocket from 'ws';

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const CDP_HOST = flag('cdp-host') || process.env.A11Y_CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(flag('cdp-port') || process.env.A11Y_CDP_PORT || 9222);
const APP_PORT = flag('port') || process.env.A11Y_APP_PORT;
const OTHER_SESSION = flag('other-session') || process.env.A11Y_OTHER_SESSION;

/** How many switches criterion 5 walks. */
const WALK_SWITCHES = 20;
/** Transitions are 150-200ms; a resting style read any sooner is mid-flight. */
const SETTLE_MS = 450;

/** Thrown for "the measurement could not be taken" — distinct from a broken contract. */
class NotMeasured extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireInputs() {
  if (!APP_PORT || !/^\d+$/.test(String(APP_PORT))) {
    throw new NotMeasured(
      'The port of the app under test is required — it is never guessed.\n' +
      'Port 3001 can serve a stale prebuilt dist/, so picking a tab by hand would\n' +
      'let this gate report a green contract for the wrong build.\n\n' +
      '  npm run a11y:branch -- --port=5174 --other-session=<id>',
    );
  }
  if (!OTHER_SESSION) {
    throw new NotMeasured(
      'A second session id is required (--other-session=<id>). Two of the criteria\n' +
      'are about what happens when the user LEAVES the branched conversation, and\n' +
      'they cannot be faked from inside it.',
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
    this.listeners = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method) {
        for (const handler of this.listeners.get(msg.method) || []) handler(msg.params);
        return;
      }
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

  on(method, handler) {
    const list = this.listeners.get(method) || [];
    list.push(handler);
    this.listeners.set(method, list);
  }

  off(method) {
    this.listeners.delete(method);
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

/* ------------------------------------------------------------------ page --- */

const PAGER = '[data-branch-pager]';
const LIVE = '[role="status"][aria-live="polite"]';

/** The live region's text as a screen reader would take it: without the nonce. */
const SPOKEN = `(el) => (el ? el.textContent.replace(/[\\u2060\\u200b]/g, '') : null)`;

const INSPECT_PAGE = `(() => {
  const pagers = document.querySelectorAll(${JSON.stringify(PAGER)});
  const live = document.querySelectorAll(${JSON.stringify(LIVE)});
  const first = pagers[0];
  const match = first && first.textContent.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
  return {
    pagers: pagers.length,
    liveRegions: live.length,
    total: match ? Number(match[2]) : 0,
    session: location.pathname,
  };
})()`;

const READ = `(() => {
  const pager = document.querySelector(${JSON.stringify(PAGER)});
  const match = pager && pager.textContent.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
  const live = document.querySelector(${JSON.stringify(LIVE)});
  const active = document.activeElement;
  return {
    current: match ? Number(match[1]) : null,
    total: match ? Number(match[2]) : null,
    anchor: pager ? pager.getAttribute('data-branch-pager') : null,
    spoken: (${SPOKEN})(live),
    activeTag: active ? active.tagName : null,
    activeLabel: active && active.getAttribute ? active.getAttribute('aria-label') : null,
    activeInPager: Boolean(active && active.closest && active.closest(${JSON.stringify(PAGER)})),
    focusVisibleInPager: document.querySelectorAll(${JSON.stringify(PAGER)} + ' :focus-visible').length,
    path: location.pathname,
  };
})()`;

/**
 * Watches the live region for real DOM change, and counts animation frames so a
 * frozen tab cannot masquerade as a silent-but-correct one. Mutation records
 * are the evidence: a screen reader is driven by the node changing, not by the
 * app believing it set some state.
 */
const ARM = `(() => {
  const live = document.querySelector(${JSON.stringify(LIVE)});
  if (!live) return false;
  window.__a11y?.observer?.disconnect();
  const state = { node: live, mutations: [], frames: 0 };
  state.observer = new MutationObserver((records) => {
    state.mutations.push({ n: records.length, spoken: (${SPOKEN})(live), raw: live.textContent });
  });
  state.observer.observe(live, { childList: true, characterData: true, subtree: true });
  state.raf = true;
  const tick = () => { if (!state.raf) return; state.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__a11y = state;
  return true;
})()`;

const SNAPSHOT = `(() => {
  const s = window.__a11y;
  if (!s) return null;
  return { count: s.mutations.length, last: s.mutations[s.mutations.length - 1] || null, frames: s.frames, connected: s.node.isConnected };
})()`;

const DISARM = `(() => { const s = window.__a11y; if (!s) return false; s.raf = false; s.observer.disconnect(); return true; })()`;

const focusArrow = (direction) => `(() => {
  const el = document.querySelector(${JSON.stringify(PAGER)} + ' [data-branch-arrow="' + ${JSON.stringify(direction)} + '"]');
  if (!el) return false;
  el.focus();
  return document.activeElement === el;
})()`;

const arrowBox = (direction) => `(() => {
  const el = document.querySelector(${JSON.stringify(PAGER)} + ' [data-branch-arrow="' + ${JSON.stringify(direction)} + '"]');
  if (!el) return null;
  const bubble = el.closest('.chat-message');
  const a = el.getBoundingClientRect();
  const b = bubble ? bubble.getBoundingClientRect() : a;
  return { x: a.x + a.width / 2, y: a.y + a.height / 2, bubbleX: b.x + b.width / 2, bubbleY: b.y + b.height / 2 };
})()`;

const goToSession = (id) => `(() => {
  history.pushState({}, '', '/session/' + ${JSON.stringify(id)});
  dispatchEvent(new PopStateEvent('popstate'));
  return location.pathname;
})()`;

const BLUR = `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return document.activeElement ? document.activeElement.tagName : null; })()`;

/* ---------------------------------------------------------------- driving --- */

/**
 * A real keyboard activation: the arrow is focused the way a Tab-walk would
 * leave it, then Enter is delivered through the browser's input pipeline. The
 * resulting click is trusted and carries `detail === 0`, which is exactly the
 * signal the app uses to tell a keyboard press from a pointer one.
 */
async function pressWithKeyboard(cdp, direction) {
  const focused = await cdp.evaluate(focusArrow(direction));
  if (!focused) throw new NotMeasured(`Could not focus the "${direction}" chevron — is a version pager on screen?`);
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', ...key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

/**
 * A real mouse press. The controls row is hover-gated, so the pointer has to
 * arrive over the message first — clicking cold hits `pointer-events: none`.
 */
async function pressWithMouse(cdp, direction) {
  const box = await cdp.evaluate(arrowBox(direction));
  if (!box) throw new NotMeasured(`No "${direction}" chevron on screen to click`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.bubbleX, y: box.bubbleY, buttons: 0 });
  await sleep(SETTLE_MS);
  const after = await cdp.evaluate(arrowBox(direction));
  const point = after || box;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 });
  await sleep(120);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  }
}

/** Parks the pointer away from every hover-gated row so resting styles are readable. */
async function parkPointer(cdp) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, buttons: 0 });
}

async function readState(cdp) {
  return cdp.evaluate(READ);
}

/** Waits for the pager to actually move; a switch that never happened is unmeasured, not passing. */
async function waitForSwitch(cdp, from, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readState(cdp);
    if (state.current !== null && state.current !== from) return state;
    if (Date.now() > deadline) {
      throw new NotMeasured(
        `The pager never left ${from}/${state.total} — no switch happened, so nothing about a switch was measured.`,
      );
    }
    await sleep(120);
  }
}

/** Walks the pager to `target` with keyboard presses, so a probe starts from a known position. */
async function moveTo(cdp, target) {
  for (let guard = 0; guard < 12; guard += 1) {
    const state = await readState(cdp);
    if (state.current === null) throw new NotMeasured('No version pager on screen');
    if (state.current === target) return state;
    await pressWithKeyboard(cdp, state.current < target ? 'next' : 'prev');
    await waitForSwitch(cdp, state.current);
    await sleep(200);
  }
  throw new NotMeasured(`Could not walk the pager to position ${target}`);
}

async function mutationCount(cdp) {
  const snap = await cdp.evaluate(SNAPSHOT);
  if (!snap) throw new NotMeasured('The live-region observer is gone — the page reloaded mid-run.');
  if (!snap.connected) throw new NotMeasured('The live region left the document — the observer is watching a detached node.');
  return snap;
}

/* ----------------------------------------------------------------- checks --- */

const results = [];
function record(id, label, ok, detail) {
  results.push({ id, label, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${id}. ${label}`);
  if (detail) console.log(`        ${detail}`);
}

/**
 * Criteria 1 and 6. Announce a position, leave the conversation, come back, and
 * announce THE SAME position again. That second announcement is the one the
 * live region used to swallow: identical text is a no-op for `useState`, so the
 * node never changed and nothing was ever spoken, while the whole transcript
 * visibly swapped.
 */
async function probeAnnouncements(cdp, other) {
  await moveTo(cdp, 1);
  await sleep(300);
  // The id to come back to is the one showing position 1 — every sibling has
  // its own id, so returning to whichever id the run started on would land on
  // some other position and quietly measure a different scenario.
  const home = (await readState(cdp)).path.split('/').pop();

  const before = await mutationCount(cdp);
  await pressWithKeyboard(cdp, 'next');
  const afterFirst = await waitForSwitch(cdp, 1);
  await sleep(SETTLE_MS);
  const firstSnap = await mutationCount(cdp);
  const firstSpoken = afterFirst.spoken;
  record(
    '1a', 'a switch mutates the live region',
    firstSnap.count > before.count && Boolean(firstSpoken),
    `${firstSnap.count - before.count} mutation(s), now reading ${JSON.stringify(firstSpoken)}`,
  );

  await cdp.evaluate(goToSession(other));
  await sleep(2_000);
  const away = await mutationCount(cdp);
  const awayState = await readState(cdp);
  record(
    '6', 'the live region is empty after a session change',
    awayState.spoken === '',
    `reads ${JSON.stringify(awayState.spoken)} on ${awayState.path}; ${away.count - firstSnap.count} mutation(s) since`,
  );

  await cdp.evaluate(goToSession(home));
  await sleep(2_500);
  const back = await readState(cdp);
  if (back.current === null) throw new NotMeasured('The pager did not come back after returning to the branched session.');
  if (back.current !== 1) {
    throw new NotMeasured(
      `Returning to the session left the pager at ${back.current}/${back.total}, not 1/${back.total}.\n` +
      'The repeated-position scenario depends on that reset, so it was not reproduced —\n' +
      'this run proves nothing about criterion 1b either way.',
    );
  }
  const beforeSecond = await mutationCount(cdp);
  await pressWithKeyboard(cdp, 'next');
  const afterSecond = await waitForSwitch(cdp, 1);
  await sleep(SETTLE_MS);
  const secondSnap = await mutationCount(cdp);
  if (afterSecond.spoken !== firstSpoken) {
    throw new NotMeasured(
      `The second switch says ${JSON.stringify(afterSecond.spoken)} but the first said ${JSON.stringify(firstSpoken)}.\n` +
      'The point of this probe is a REPEATED position; different text does not exercise it.',
    );
  }
  record(
    '1b', 'a repeated position, after leaving and returning, still mutates the live region',
    secondSnap.count > beforeSecond.count,
    `${secondSnap.count - beforeSecond.count} mutation(s) for a second ${JSON.stringify(firstSpoken)}`,
  );
  return { frames: secondSnap.frames };
}

/**
 * Criterion 1c: two announcements of the same text with NO session change
 * between them.
 *
 * This is the case the invisible nonce exists for, and the only one that pins
 * it: 1b's scenario crosses a session change, which empties the live region on
 * its own, so the announcement after it always differs from "" and 1b stays
 * green with the nonce removed. Verified — a nonce-only revert passed the rest
 * of this file 12/12.
 *
 * The shape a user meets it in is a conversation forked at two points whose
 * pagers both sit at the same `n/total`: switching at one and then the other
 * says the identical sentence twice, and nothing resets in between. The
 * fixtures available here have a single fork anchor, and manufacturing a second
 * one with a matching sibling count means two real fork runs — so this stages
 * the same collision through the same commit path instead: the activation is
 * held at the network layer, the chevron is pressed a second time while the
 * pager is still showing the old position, and both presses therefore resolve
 * to the same target index. Two real switches, one identical sentence, no reset
 * between them.
 *
 * The refresh that follows the first activation is held too. That is what makes
 * the window deterministic rather than a race: while it is paused the view has
 * not moved on, so the second press's request is still valid when it lands.
 */
async function probeRepeatedAnnouncementInSession(cdp) {
  await moveTo(cdp, 1);
  await sleep(300);
  const start = await readState(cdp);
  if (start.current >= start.total) {
    throw new NotMeasured('The pager is at the end of the list; this probe needs a "next" to press twice.');
  }

  const paused = [];
  cdp.on('Fetch.requestPaused', (params) => { paused.push(params); });
  const waitFor = async (kind, index, what) => {
    const deadline = Date.now() + 6_000;
    for (;;) {
      const hits = paused.filter((p) => (kind === 'activate'
        ? String(p.request.url).includes('activate-branch')
        : /\/messages(\?|$)/.test(String(p.request.url))));
      if (hits.length > index) return hits[index];
      if (Date.now() > deadline) throw new NotMeasured(what);
      await sleep(50);
    }
  };

  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*activate-branch*', requestStage: 'Request' },
      { urlPattern: '*/messages*', requestStage: 'Request' },
    ],
  });
  try {
    await pressWithKeyboard(cdp, 'next');
    const first = await waitFor('activate', 0, 'The first activation never reached the network.');
    const beforeSecondPress = await readState(cdp);
    if (beforeSecondPress.current !== start.current) {
      throw new NotMeasured('The pager moved before the second press, so the two presses would target different versions.');
    }
    await pressWithKeyboard(cdp, 'next');
    const second = await waitFor('activate', 1, 'The second press produced no activation — the pager stopped accepting presses while one was in flight.');

    const m0 = await mutationCount(cdp);
    await cdp.send('Fetch.continueRequest', { requestId: first.requestId });
    // The transcript refresh being paused proves the first switch committed and
    // that the view is frozen mid-switch, which is the window the second press
    // has to land in.
    const refresh = await waitFor('messages', 0, 'The first switch never asked for the new transcript — it did not commit.');
    const m1 = await mutationCount(cdp);
    const firstSpoken = (await readState(cdp)).spoken;
    if (m1.count <= m0.count) {
      throw new NotMeasured('The first of the two switches did not announce at all; the repeat cannot be judged.');
    }

    await cdp.send('Fetch.continueRequest', { requestId: second.requestId });
    await sleep(1_200);
    const m2 = await mutationCount(cdp);
    const afterSpoken = (await readState(cdp)).spoken;
    if (afterSpoken !== firstSpoken) {
      throw new NotMeasured(
        `The second switch says ${JSON.stringify(afterSpoken)} but the first said ${JSON.stringify(firstSpoken)};\n` +
        'without identical text this probe is not testing a repeated announcement.',
      );
    }
    record(
      '1c', 'a repeated announcement with no session change in between still mutates the live region',
      m2.count > m1.count,
      `${m2.count - m1.count} mutation(s) for a second ${JSON.stringify(firstSpoken)} with no reset between them`,
    );
    await cdp.send('Fetch.continueRequest', { requestId: refresh.requestId }).catch(() => {});
  } finally {
    // Anything still held would freeze the app for the probes that follow.
    for (const p of paused) {
      await cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    }
    cdp.off('Fetch.requestPaused');
    await cdp.send('Fetch.disable').catch(() => {});
  }
  await sleep(2_000);
}

/** Criterion 2. */
async function probeKeyboardFocus(cdp) {
  const start = await readState(cdp);
  const direction = start.current < start.total ? 'next' : 'prev';
  await pressWithKeyboard(cdp, direction);
  await waitForSwitch(cdp, start.current);
  await sleep(SETTLE_MS);
  const after = await readState(cdp);
  record(
    '2', 'a keyboard switch lands focus inside the pager',
    after.activeInPager,
    `focus is on ${after.activeLabel || after.activeTag}`,
  );
}

/**
 * Criterion 3. A mouse user must not be handed a keyboard focus ring: a
 * programmatic `.focus()` on a freshly mounted node counts as keyboard focus in
 * Chrome, so restoring focus after a click drew a 1px ring the app never
 * otherwise shows for a click.
 */
async function probePointerFocus(cdp) {
  const start = await readState(cdp);
  const direction = start.current < start.total ? 'next' : 'prev';
  await pressWithMouse(cdp, direction);
  const moved = await waitForSwitch(cdp, start.current);
  await parkPointer(cdp);
  await sleep(SETTLE_MS);
  const after = await readState(cdp);
  record(
    '3', 'a pointer switch leaves focus and the focus ring untouched',
    after.focusVisibleInPager === 0 && !after.activeInPager,
    `switched to ${moved.current}/${moved.total}; focus on ${after.activeLabel || after.activeTag}, ` +
    `${after.focusVisibleInPager} focus-visible chevron(s)`,
  );
}

/**
 * Criterion 4. The activation request is held at the network layer while the
 * user leaves for another conversation. When it finally lands, it must not pull
 * the route back or take focus into a session the user has walked away from.
 */
/**
 * Reads focus as an IDENTITY rather than a predicate, so "focus did not move"
 * can be asserted directly.
 *
 * The earlier form of criterion 4 asked `!activeInPager`, which reduces to "is
 * the focused node inside a pager on the page currently loaded". That is a
 * question about the OTHER conversation's DOM, not about the switch under test,
 * and it answers false for almost any regression — including a steal into the
 * composer, the sidebar or <body>. Comparing a stamped node before and after
 * makes any movement at all observable, whatever it moves to.
 */
const STAMP_FOCUS = `(() => {
  document.querySelectorAll('[data-a11y-focus-mark]').forEach((el) => el.removeAttribute('data-a11y-focus-mark'));
  const el = document.activeElement;
  const tag = el ? el.tagName : null;
  if (el && el !== document.body && el.setAttribute) el.setAttribute('data-a11y-focus-mark', '1');
  return { tag, label: el && el.getAttribute ? el.getAttribute('aria-label') : null };
})()`;

const FOCUS_MOVED_FROM_STAMP = `(() => {
  const el = document.activeElement;
  const tag = el ? el.tagName : null;
  const marked = Boolean(el && el.getAttribute && el.getAttribute('data-a11y-focus-mark'));
  return {
    tag,
    label: el && el.getAttribute ? el.getAttribute('aria-label') : null,
    // Focus is unchanged if it is still on the node we stamped, or if it was on
    // <body> then and is on <body> now (body cannot carry the stamp).
    held: marked || (tag === 'BODY' && document.querySelectorAll('[data-a11y-focus-mark]').length === 0),
    inPager: Boolean(el && el.closest && el.closest(${JSON.stringify(PAGER)})),
  };
})()`;

/**
 * Leaving a conversation while a switch is in flight must not drag the route
 * back into it, and must not move focus out from under the user.
 *
 * `switchBranch` awaits TWICE — the activation, then the transcript refresh —
 * and each await is its own chance for the user to leave. Only the first was
 * ever probed, and the guard that existed sat between them, so a probe that
 * pauses the activation can never reach the second window: the switch aborts
 * before it gets there. Both windows are therefore driven here, by the request
 * each one is waiting on.
 */
async function probeNavigateAwayDuring(cdp, other, { urlPattern, ids, label, what }) {
  await moveTo(cdp, 1);
  await sleep(300);
  const home = (await readState(cdp)).path.split('/').pop();

  // Only the FIRST match is held. Leaving for the other session fetches its own
  // transcript, and holding that too would stall the navigation this probe
  // depends on — so every later match is waved through immediately.
  let paused = null;
  const onPaused = (params) => {
    if (paused) { cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {}); return; }
    paused = params;
  };
  cdp.on('Fetch.requestPaused', onPaused);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern, requestStage: 'Request' }] });
  try {
    await pressWithKeyboard(cdp, 'next');
    const deadline = Date.now() + 5_000;
    while (!paused && Date.now() < deadline) await sleep(50);
    if (!paused) {
      throw new NotMeasured(`The ${what} request was never intercepted — the switch never reached that stage, so this window was not measured.`);
    }

    await cdp.evaluate(goToSession(other));
    await sleep(1_500);
    const leftFor = await readState(cdp);
    if (!leftFor.path.includes(other)) {
      throw new NotMeasured(`Could not leave for the other session (still on ${leftFor.path}).`);
    }
    // Focus is stamped AFTER arriving, so the baseline is where the user's own
    // navigation left it — anything that moves it from here is the switch
    // reaching forward into a conversation it no longer owns.
    const before = await cdp.evaluate(STAMP_FOCUS);

    await cdp.send('Fetch.continueRequest', { requestId: paused.requestId });
    await sleep(2_500);
    const after = await readState(cdp);
    const focus = await cdp.evaluate(FOCUS_MOVED_FROM_STAMP);

    record(
      ids.route, `${label}: the route stays where the user went`,
      after.path.includes(other),
      `on ${after.path} after releasing the held ${what}`,
    );
    record(
      ids.focus, `${label}: focus stays where the user left it`,
      focus.held,
      `focus was ${before.label || before.tag}, is ${focus.label || focus.tag}${focus.inPager ? ' (inside a pager)' : ''}`,
    );
    // The route and the focus are guarded twice over — once before each await —
    // so either guard alone keeps them right and neither is pinned by the two
    // checks above. The announcement is not: it is made by `commit`, so only
    // `commit`'s own staleness check can stop a position being read out for a
    // conversation that is no longer on screen. This is the assertion that
    // fails when that check goes.
    record(
      ids.silence, `${label}: no position is announced for the conversation left behind`,
      !after.spoken,
      after.spoken ? `live region reads "${after.spoken}"` : 'live region is empty',
    );
  } finally {
    cdp.off('Fetch.requestPaused');
    await cdp.send('Fetch.disable').catch(() => {});
  }
  await cdp.evaluate(goToSession(home));
  await sleep(2_500);
}

/**
 * Criterion 5. Landing on <body> means the next Tab starts from the top of the
 * page, so a keyboard user pays for every version they step through.
 */
async function probeWalk(cdp) {
  const landings = [];
  for (let i = 0; i < WALK_SWITCHES; i += 1) {
    const state = await readState(cdp);
    if (state.current === null) throw new NotMeasured('The pager disappeared mid-walk.');
    const direction = state.current < state.total ? 'next' : 'prev';
    await pressWithKeyboard(cdp, direction);
    await waitForSwitch(cdp, state.current);
    await sleep(SETTLE_MS);
    const after = await readState(cdp);
    if (!after.activeInPager) landings.push(`#${i + 1} ${direction} -> ${after.activeTag}`);
  }
  record(
    '5', `${WALK_SWITCHES} consecutive switches, zero landings on <body>`,
    landings.length === 0,
    landings.length ? landings.join(', ') : `${WALK_SWITCHES}/${WALK_SWITCHES} kept focus in the pager`,
  );
}

/**
 * Criterion 9. Regression guards from the rounds before this one. Read at rest
 * with the pointer and focus parked: `:focus-within` reveals the hover-gated
 * row, and a style read inside the 150ms transition returns a mid-flight value.
 */
const MEASURE_LAYOUT = `(() => {
  const message = [...document.querySelectorAll('.chat-message.user')].find((m) => m.querySelector(${JSON.stringify(PAGER)}));
  if (!message) return null;
  const grid = message.firstElementChild;
  const bubbleWrap = grid.querySelector('[class*="row-start-1"]');
  const bubble = bubbleWrap && bubbleWrap.firstElementChild;
  const row = grid.querySelector('[class*="row-start-2"]');
  const avatar = grid.querySelector('[class*="col-start-2"]');
  const controls = row && row.firstElementChild;
  const timestamp = row && row.lastElementChild;
  if (!bubble || !row || !avatar || !controls || !timestamp) return null;
  const box = (el) => { const r = el.getBoundingClientRect(); return { right: r.right, bottom: r.bottom, top: r.top, height: r.height }; };
  const next = message.parentElement
    ? [...message.parentElement.children][[...message.parentElement.children].indexOf(message) + 1]
    : null;
  return {
    rowMinusBubbleRight: +(box(row).right - box(bubble).right).toFixed(2),
    avatarMinusBubbleBottom: +(box(avatar).bottom - box(bubble).bottom).toFixed(2),
    avatarHeight: box(avatar).height,
    controlsOpacity: getComputedStyle(controls).opacity,
    controlsPointerEvents: getComputedStyle(controls).pointerEvents,
    timestampOpacity: getComputedStyle(timestamp).opacity,
    groupHovered: grid.matches(':hover'),
    nextTop: next ? +box(next).top.toFixed(2) : null,
    bubbleX: (() => { const r = bubble.getBoundingClientRect(); return r.x + r.width / 2; })(),
    bubbleY: (() => { const r = bubble.getBoundingClientRect(); return r.y + r.height / 2; })(),
  };
})()`;

async function probeLayoutGuards(cdp) {
  await cdp.evaluate(BLUR);
  await parkPointer(cdp);
  await sleep(SETTLE_MS);
  const rest = await cdp.evaluate(MEASURE_LAYOUT);
  if (!rest) throw new NotMeasured('Could not resolve the user-turn layout — the message structure changed.');
  if (rest.avatarHeight === 0) {
    throw new NotMeasured('The avatar is not rendered at this window width; widen the window past the `sm` breakpoint.');
  }

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rest.bubbleX, y: rest.bubbleY, buttons: 0 });
  await sleep(SETTLE_MS);
  const hovered = await cdp.evaluate(MEASURE_LAYOUT);
  await parkPointer(cdp);
  await sleep(SETTLE_MS);

  record('9a', 'control row is right-aligned with the bubble', rest.rowMinusBubbleRight === 0,
    `row.right - bubble.right = ${rest.rowMinusBubbleRight}`);
  record('9b', 'avatar sits level with the bubble, not the controls', rest.avatarMinusBubbleBottom === 0,
    `avatar.bottom - bubble.bottom = ${rest.avatarMinusBubbleBottom}`);
  record('9c', 'hovering does not move the next message', rest.nextTop === hovered.nextTop,
    `next message top ${rest.nextTop} at rest, ${hovered.nextTop} hovered`);
  record('9d', 'controls are hidden and inert at rest, shown and clickable on hover',
    rest.controlsOpacity === '0' && rest.controlsPointerEvents === 'none'
      && hovered.controlsOpacity === '1' && hovered.controlsPointerEvents === 'auto',
    `rest ${rest.controlsOpacity}/${rest.controlsPointerEvents} (row hovered: ${rest.groupHovered}), ` +
    `hover ${hovered.controlsOpacity}/${hovered.controlsPointerEvents}`);
  record('9e', 'the timestamp stays visible at rest', rest.timestampOpacity === '1',
    `timestamp opacity ${rest.timestampOpacity}`);
}

/* ------------------------------------------------------------------- main --- */

async function main() {
  const port = requireInputs();
  const target = await pickTarget(port);
  console.log(`Attached to: ${target.title}\n             ${target.url}`);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    const page = await cdp.evaluate(INSPECT_PAGE);
    if (page.pagers === 0) {
      throw new NotMeasured(
        'No version pager on this tab. Every criterion here is about switching between\n' +
        'sibling versions, so a conversation that was never forked measures nothing.',
      );
    }
    if (page.pagers > 1) {
      throw new NotMeasured(`${page.pagers} version pagers on screen — the probes address one by selector and would be ambiguous.`);
    }
    if (page.total < 2) throw new NotMeasured(`The pager shows ${page.total} version(s); at least 2 are needed to switch.`);
    if (page.liveRegions !== 1) {
      throw new NotMeasured(`Expected exactly one transcript live region, found ${page.liveRegions}.`);
    }
    const session = page.session.split('/').pop();
    if (session === OTHER_SESSION) {
      throw new NotMeasured('--other-session is the session already open; it has to be a different conversation.');
    }
    console.log(`             session ${session}, ${page.total} versions\n`);

    if (!(await cdp.evaluate(ARM))) throw new NotMeasured('Could not attach the live-region observer.');

    await probeAnnouncements(cdp, OTHER_SESSION);
    await probeRepeatedAnnouncementInSession(cdp);
    await probeKeyboardFocus(cdp);
    await probePointerFocus(cdp);
    await probeNavigateAwayDuring(cdp, OTHER_SESSION, {
      urlPattern: '*activate-branch*',
      ids: { route: '4a', focus: '4b', silence: '4c' },
      label: 'leaving while the activation is in flight',
      what: 'activation',
    });
    await probeNavigateAwayDuring(cdp, OTHER_SESSION, {
      urlPattern: '*/messages*',
      ids: { route: '7a', focus: '7b', silence: '7c' },
      label: 'leaving while the transcript refresh is in flight',
      what: 'transcript refresh',
    });
    await probeWalk(cdp);
    await probeLayoutGuards(cdp);

    const final = await mutationCount(cdp);
    await cdp.evaluate(DISARM);
    if (final.frames === 0) {
      throw new NotMeasured('Zero animation frames over the whole run — the tab was backgrounded or frozen, so nothing here was observed live.');
    }
    console.log(`\n${final.frames} frames sampled, ${final.count} live-region mutations recorded.`);
  } finally {
    cdp.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0
    ? '\nContract met.'
    : `\nContract broken: ${failed.map((r) => r.id).join(', ')}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  const label = error instanceof NotMeasured ? 'NOT MEASURED' : 'ERROR';
  console.error(`\n${label}: ${error.message}`);
  process.exitCode = 2;
});
