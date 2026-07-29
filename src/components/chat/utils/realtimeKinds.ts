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
 * status + human outcome phrase.
 *
 * Fails toward "not a success" on purpose. The previous coercion mapped
 * anything that was not exactly `failed`/`stopped` onto `completed`, so a
 * producer that renamed an outcome — or omitted `status` altogether — would
 * render a failure as a green tick the user then trusts. An unrecognised status
 * is not evidence of success; it is evidence of not knowing.
 */
export function resolveBackgroundTaskOutcome(status: unknown): {
  status: 'completed' | 'failed' | 'stopped';
  outcome: string;
} {
  if (status === 'completed') {
    return { status: 'completed', outcome: 'completed' };
  }
  if (status === 'stopped') {
    return { status: 'stopped', outcome: 'was stopped (likely reaped under memory pressure)' };
  }
  if (status === 'failed') {
    return { status: 'failed', outcome: 'failed' };
  }
  return {
    status: 'failed',
    outcome: `did not report success (status: ${JSON.stringify(status ?? null)})`,
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
