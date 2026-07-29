/**
 * Realtime frame kinds that are NOT chat messages and must never reach
 * `sessionStore.appendRealtime()`.
 *
 * The generic routing path in useChatRealtimeHandlers is allow-by-default: it
 * force-casts anything not explicitly excluded into a NormalizedMessage. A
 * frame without `.id` corrupts that session's store and crashes every later
 * merge on `.id.startsWith`, so every non-message kind must be listed here AND
 * return early from the first switch.
 *
 * The early `return` is the first line of defence and this set is the second:
 * it only matters on the day an edit drops one of those returns. That is why
 * kinds which build their own well-formed row before returning
 * (`protocol_error`, `background_task`) belong here too — what the guard has to
 * stop is the RAW frame being force-cast, and the raw frame has no `.id` either
 * way. `realtimeKinds.test.ts` reads the switch arms out of the hook's source
 * so a kind added there without an entry here fails a test rather than
 * silently shipping with only one defence.
 */
const NON_TRANSCRIPT_KINDS = new Set([
  'websocket_reconnected',
  'chat_subscribed',
  'branch_created',
  'protocol_error',
  'session_upserted',
  'loading_progress',
  'session_lock_state_changed',
  'background_task',
]);

export function isNonTranscriptKind(kind: string): boolean {
  return NON_TRANSCRIPT_KINDS.has(kind);
}

/**
 * Resolves a `background_task` frame's `status` into the transcript's own
 * status + human outcome phrase, and says whether the frame is an ADVISORY
 * about work still in progress rather than a settled outcome.
 *
 * Fails toward "not a success" on purpose. The previous coercion mapped
 * anything that was not exactly `failed`/`stopped` onto `completed`, so a
 * producer that renamed an outcome — or omitted `status` altogether — would
 * render a failure as a green tick the user then trusts. An unrecognised status
 * is not evidence of success; it is evidence of not knowing.
 *
 * `advisory` exists because that same fail-closed rule is wrong for one frame
 * the backend now sends: a task still holding a CLI process open has neither
 * succeeded nor failed, and rendering it as either would misreport running work.
 * Callers use the flag to keep completion signals (tab indicator, chime) off it
 * and to give its row an id that cannot collide with the same task's eventual
 * settlement.
 */
export function resolveBackgroundTaskOutcome(status: unknown): {
  status: 'completed' | 'failed' | 'stopped' | 'running';
  outcome: string;
  advisory: boolean;
} {
  if (status === 'completed') {
    return { status: 'completed', outcome: 'completed', advisory: false };
  }
  if (status === 'stopped') {
    return { status: 'stopped', outcome: 'was stopped (likely reaped under memory pressure)', advisory: false };
  }
  if (status === 'failed') {
    return { status: 'failed', outcome: 'failed', advisory: false };
  }
  if (status === 'running') {
    return { status: 'running', outcome: 'still running', advisory: true };
  }
  return {
    status: 'failed',
    outcome: `did not report success (status: ${JSON.stringify(status ?? null)})`,
    advisory: false,
  };
}

/**
 * Whether a `background_task` frame may fire the completion signals — the tab
 * title indicator and the chime.
 *
 * Both signals are global to the browser tab, so they only make sense for the
 * conversation the user is actually looking at. Firing them for any session
 * meant a second tab (or a colleague's browser, before the server started
 * scoping delivery to the task's owner) got dinged about work it has no view
 * of, with nothing on screen to explain the sound.
 *
 * The transcript row is written regardless — that is how a task that settled on
 * a session in the background is still there when the user switches to it.
 * This gate is only about the attention-grabbing part.
 *
 * `advisory` frames never signal: a task still holding a CLI process open has
 * not completed, and both signals mean "the thing you were waiting for is
 * done".
 */
export function shouldSignalBackgroundTaskCompletion(args: {
  advisory: boolean;
  /** The frame's resolved session id (`msg.sessionId` or the viewed session). */
  sessionId: string | null;
  activeViewSessionId: string | null;
}): boolean {
  if (args.advisory) {
    return false;
  }
  if (!args.sessionId || !args.activeViewSessionId) {
    return false;
  }
  return args.sessionId === args.activeViewSessionId;
}

/**
 * Composes a `background_task` row's summary line.
 *
 * The output path is how the user retrieves the full output, so it is appended
 * when there is one — and omitted entirely when there is not. A task lost to a
 * CLI process that died never wrote an output file and the producer sends no
 * `outputFile` for it, so rendering the field unconditionally would print
 * `undefined` where a path belongs.
 */
export function buildBackgroundTaskSummary(outcome: string, summary: unknown, outputFile: unknown): string {
  const summaryText = (typeof summary === 'string' && summary) || 'Background task finished';
  const path = typeof outputFile === 'string' && outputFile ? ` — output: ${outputFile}` : '';
  return `Background task ${outcome}: ${summaryText}${path}`;
}
