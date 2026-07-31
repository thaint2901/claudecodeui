import { useCallback, useEffect, useRef, useState } from 'react';

import type { BranchSwitchMeta } from '../view/subcomponents/BranchSwitcher';
import { PAGER_ANCHOR_ATTRIBUTE, PAGER_ARROW_ATTRIBUTE } from '../view/subcomponents/BranchSwitcher';

/**
 * Owns the lifecycle of one "switch to a sibling branch" interaction.
 *
 * Switching replaces the pager's own React subtree — the chevron that was
 * pressed is unmounted, because the pager lives in the prompt that DIFFERS
 * between siblings. Everything that has to survive that replacement (who takes
 * focus back, what the screen reader is told) used to be a bare ref and a bare
 * string with no owner: nothing validated them, nothing expired them, nothing
 * reset them on a session change. Five defects came out of that one gap, so the
 * state moved here as a single request-scoped record:
 *
 *   captured at REQUEST time  — anchor, direction, viewed session, input
 *                               modality, and the pager the press came from;
 *   validated at RESOLVE time — the switch only speaks, and only moves focus,
 *                               while all of it is still true;
 *   reset on session change   — nothing survives into another conversation.
 */

/**
 * How long after a switch the controller keeps putting focus back.
 *
 * Restoring focus cannot be a single shot taken when the new pager mounts. The
 * transcript swap and the activation response race each other: measured on the
 * dev server, the remount landed anywhere from 50ms before to 250ms after the
 * response, and when it came first the pager that would have taken focus had
 * already mounted and gone. That race is the most likely explanation for the
 * intermittent <body> landings — a single shot has to win it, a bounded sweep
 * does not have to.
 */
const FOCUS_SWEEP_MS = 1_500;

/**
 * How many consecutive frames the arrow must keep focus before the sweep calls
 * it settled and stops. Running to the deadline regardless meant the sweep
 * spent a second and a half arguing with anything else that touched focus.
 */
const SETTLED_FRAMES = 5;

export type BranchSwitchRequest = {
  id: number;
  anchor: string;
  direction: 'prev' | 'next';
  /** Session in view when the chevron was pressed. */
  fromSessionId: string | null;
  keyboard: boolean;
  /** The pager element the press came from, or null when it could not be resolved. */
  pager: HTMLElement | null;
};

type Announcement = { text: string; nonce: number };

type UseBranchSwitchControllerArgs = {
  /** The session currently in view; a change to it resets everything. */
  currentSessionId: string | null;
  /** Formats the spoken position, e.g. i18n `fork:branch.announced`. */
  formatAnnouncement: (current: number, total: number) => string;
};

/**
 * Is the focus the switch was given still the switch's to give back?
 *
 * Yes while it is inside the pager that was pressed. Also yes when it is on
 * `<body>` and that pager is gone from the document: that is the signature of
 * the transcript swap having removed the focused chevron, not of the user
 * having moved on. Anything else — the composer, another control — belongs to
 * the user now, and taking it back is defect I1.
 */
function focusStillBelongsToSwitch(pager: HTMLElement | null): boolean {
  if (!pager) return false;
  const active = document.activeElement;
  if (active && pager.contains(active)) return true;
  return (!active || active === document.body) && !pager.isConnected;
}

export function useBranchSwitchController({
  currentSessionId,
  formatAnnouncement,
}: UseBranchSwitchControllerArgs) {
  const requestIdRef = useRef(0);
  // Declared above every callback that closes over them: a `useCallback` placed
  // above the binding it reads throws at render time and eslint will not catch it.
  const sessionRef = useRef(currentSessionId);
  const sweepRef = useRef<{ requestId: number; cancel: () => void } | null>(null);
  // The session a committed switch is deliberately moving TO. Without it the
  // reset below cannot tell "the user left this conversation" (clear the live
  // region) from "the switch we just announced landed" (keep it).
  const expectedSessionRef = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement>({ text: '', nonce: 0 });

  const cancelSweep = useCallback((requestId?: number) => {
    const sweep = sweepRef.current;
    if (!sweep) return;
    if (requestId !== undefined && sweep.requestId !== requestId) return;
    sweep.cancel();
    sweepRef.current = null;
  }, []);

  /**
   * Puts focus back on the arrow that was pressed, for as long as the swap
   * keeps taking it away, and no longer.
   *
   * Every frame it re-reads the world instead of trusting the last one:
   *  - focus somewhere the user put it   → stop, it is not ours (I1);
   *  - the pager for THIS anchor exists  → focus its arrow;
   *  - focus has held for a few frames   → stop, the swap has settled and any
   *                                        later change of focus is the user's;
   *  - deadline reached                  → stop, so no intent is ever left
   *                                        lying around to be picked up by an
   *                                        unrelated mount minutes later (I2).
   */
  const startFocusSweep = useCallback((request: BranchSwitchRequest) => {
    cancelSweep();
    const selector = `[${PAGER_ANCHOR_ATTRIBUTE}="${CSS.escape(request.anchor)}"] [${PAGER_ARROW_ATTRIBUTE}="${request.direction}"]`;
    const deadline = Date.now() + FOCUS_SWEEP_MS;
    let frame = 0;
    let stopped = false;
    let heldFrames = 0;
    let everFound = false;
    /**
     * Nothing to give focus back to.
     *
     * The pager only renders when its fork anchor is inside the loaded tail of
     * the transcript, so switching INTO a long branch can land on a version
     * that shows no pager at all. The sweep then runs to its deadline having
     * never seen its target, and used to simply stop — leaving focus on
     * `<body>`, where the next Tab restarts from the top of the document with
     * nothing having said the control the user was on had gone (WCAG 2.4.3).
     *
     * The transcript region is the honest fallback: it is what the switch just
     * replaced and what the user is now reading, and Tab continues from there
     * into the composer exactly as it would have from the pager. Focus is only
     * taken if it is still nobody's — anything the user has since focused
     * outranks this.
     */
    const fallBackToTranscript = () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const region = document.querySelector<HTMLElement>('[data-transcript-region]');
      region?.focus({ preventScroll: true });
    };
    const stop = (exhausted = false) => {
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      if (sweepRef.current?.requestId === request.id) sweepRef.current = null;
      if (exhausted && !everFound) fallBackToTranscript();
    };
    const step = () => {
      if (stopped) return;
      const active = document.activeElement;
      const target = document.querySelector<HTMLElement>(selector);
      const activeIsOurs = !active || active === document.body || (target && active === target)
        || (request.pager?.isConnected && request.pager.contains(active));
      if (!activeIsOurs) {
        stop();
        return;
      }
      if (target && active !== target) {
        target.focus();
        heldFrames = 0;
      }
      // "Found" means a pager for this anchor exists once the pressed one has
      // LEFT the document. Testing for the target alone would be true on the
      // very first frame — the pager being replaced carries the same anchor —
      // and the fallback would then never fire in the one case it exists for.
      if (target && !request.pager?.isConnected) everFound = true;
      if (target && active === target && !request.pager?.isConnected) {
        // Only once the pressed pager has actually left the document: until
        // then `target` is still the OLD pager's arrow, which already has focus,
        // and counting those frames stopped the sweep before the swap it exists
        // to survive — 10 of 20 switches ended on <body>.
        heldFrames += 1;
      }
      // Focus has survived a few frames on the arrow of the pager that replaced
      // the one pressed, so the swap is over. Anything that moves focus after
      // this is the user, including a blur.
      if (heldFrames >= SETTLED_FRAMES) {
        stop();
        return;
      }
      if (Date.now() > deadline) {
        // The only exit that means "the switch never got its focus back".
        stop(true);
        return;
      }
      frame = requestAnimationFrame(step);
    };
    sweepRef.current = { requestId: request.id, cancel: stop };
    frame = requestAnimationFrame(step);
  }, [cancelSweep]);

  /**
   * Snapshots the interaction. Must be called synchronously from the click
   * handler path: the event's modality and the pager it came from are only
   * knowable before anything awaits.
   */
  const begin = useCallback((meta: BranchSwitchMeta, fromSessionId: string | null): BranchSwitchRequest => {
    // A new press supersedes the last one's focus intent. Without this, a
    // keyboard switch's sweep was still running when the user clicked a chevron
    // with the mouse a moment later, and it put the ring back on the chevron
    // that the pointer switch had deliberately left alone.
    cancelSweep();
    return {
      id: ++requestIdRef.current,
      anchor: meta.anchor,
      direction: meta.direction,
      fromSessionId,
      keyboard: meta.keyboard,
      pager: meta.pager,
    };
  }, [cancelSweep]);

  /**
   * Validates the snapshot against the world as it is now and, if it still
   * holds, speaks the new position and starts putting focus back. Returns false
   * when the request is stale — the caller must then leave the route and the
   * view alone.
   */
  const commit = useCallback((
    request: BranchSwitchRequest,
    toSessionId: string,
    position: { current: number; total: number },
  ): boolean => {
    // The user moved to another conversation while the switch was in flight.
    // Completing it would drag the route back and steal focus into a session
    // they had already left (I1b).
    if (sessionRef.current !== request.fromSessionId) return false;

    expectedSessionRef.current = toSessionId;

    // Focus is only ever taken back for a keyboard switch. Restoring it after a
    // pointer switch handed a mouse user a `:focus-visible` ring the app never
    // otherwise shows for a click, because a programmatic `.focus()` on a fresh
    // node counts as keyboard focus in Chrome (D4).
    if (request.keyboard && focusStillBelongsToSwitch(request.pager)) {
      startFocusSweep(request);
    }

    // The nonce is what makes a REPEATED position announce. `useState` bails on
    // `Object.is`, so re-setting the identical string left the DOM untouched and
    // no screen reader spoke — while the whole transcript visibly swapped (C2).
    // The rendered text carries an invisible, alternating suffix, so every
    // switch is a real characterData mutation and none of them changes what is
    // spoken.
    setAnnouncement((previous) => ({
      text: formatAnnouncement(position.current, position.total),
      nonce: previous.nonce + 1,
    }));
    return true;
  }, [formatAnnouncement, startFocusSweep]);

  /** Rolls the request back — nothing it started may outlive a failed switch. */
  const abort = useCallback((request: BranchSwitchRequest) => {
    // The sweep is cancelled by id whatever else is true — a dead request's
    // sweep must never keep hunting for a pager.
    cancelSweep(request.id);
    // Everything below is shared state that a LATER request may already own, so
    // a request that lost the race rolls back nothing but its own sweep.
    if (requestIdRef.current !== request.id) return;
    expectedSessionRef.current = null;
    // The announcement is the other thing `commit` starts that outlives the
    // frame it ran in, so it is the other thing an abort after a commit has to
    // take back. `activateBranch` succeeding and the transcript refresh then
    // failing leaves the server on the new branch and the view on the old one;
    // without this the user is told "showing version 2 of 3" and shown version
    // 1, under an error banner saying the switch did not happen. Clearing to
    // empty is itself silent — a live region is only spoken when it gains text.
    setAnnouncement((previous) => (previous.text === '' ? previous : { text: '', nonce: previous.nonce + 1 }));
  }, [cancelSweep]);

  useEffect(() => {
    sessionRef.current = currentSessionId;
    // The session a committed switch moved to is not a "session change" — the
    // announcement it just made describes exactly this view.
    if (expectedSessionRef.current === currentSessionId) {
      expectedSessionRef.current = null;
      return;
    }
    expectedSessionRef.current = null;
    cancelSweep();
    // Otherwise the user has left, and the live region must not read out a
    // position from a conversation that is no longer on screen.
    setAnnouncement((previous) => (previous.text === '' ? previous : { text: '', nonce: previous.nonce + 1 }));
  }, [currentSessionId, cancelSweep]);

  useEffect(() => () => cancelSweep(), [cancelSweep]);

  // U+2060 WORD JOINER: zero width, no line-break effect, and not spoken.
  const announcementText = announcement.text === ''
    ? ''
    : `${announcement.text}${announcement.nonce % 2 === 1 ? '\u2060' : ''}`;

  return { announcement: announcementText, begin, commit, abort };
}
