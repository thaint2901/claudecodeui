/**
 * Realtime frame kinds that are NOT chat messages and must never reach
 * `sessionStore.appendRealtime()`.
 *
 * The generic routing path in useChatRealtimeHandlers is allow-by-default: it
 * force-casts anything not explicitly excluded into a NormalizedMessage. A
 * frame without `.id` corrupts that session's store and crashes every later
 * merge on `.id.startsWith`, so every non-message kind must be listed here AND
 * return early from the first switch.
 */
const NON_TRANSCRIPT_KINDS = new Set([
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
