import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

export interface BackgroundTaskEvent {
  sessionId: string;
  taskId: string;
  /**
   * A settled outcome, or `'running'`.
   *
   * `'running'` is an ADVISORY, not an outcome: the task is still going, and the
   * event exists to say that it is holding a CLI process open with nothing
   * scheduled to end it. It gets its own value rather than borrowing a settled
   * one because every consumer treats these as terminal — `'completed'` would
   * claim work that has not finished, and `'failed'`/`'stopped'` would report a
   * failure that has not happened, which is the mirror image of the bug this
   * pool exists to fix.
   *
   * The frontend fails an UNRECOGNISED status toward "not a success"
   * (`resolveBackgroundTaskOutcome`), so any value added here needs a matching
   * branch there or it renders as a failure.
   */
  status: 'completed' | 'failed' | 'stopped' | 'running';
  /**
   * Where the task's output was written — omitted when there is no such file.
   *
   * Only `task_notification` carries a path; `task_started` does not (measured:
   * `spikes/streaming-input-mode/task-classification.mjs`). So a task lost with
   * a dead CLI process has no path to report, and never wrote one. Optional
   * rather than an empty string: an empty path is still a claim about a file.
   */
  outputFile?: string;
  summary: string;
}

/**
 * Emits a session-scoped background-task event.
 *
 * Unlike run events, this can fire with NO run in flight — a background shell
 * outlives the turn that started it, so its completion has no writer to ride
 * on. Mirrors the fan-out already used by `broadcastCanonicalSessionUpsert`.
 */
export function emitBackgroundTaskEvent(event: BackgroundTaskEvent): void {
  const frame = JSON.stringify({
    kind: 'background_task',
    sessionId: event.sessionId,
    taskId: event.taskId,
    status: event.status,
    outputFile: event.outputFile,
    summary: event.summary,
    timestamp: new Date().toISOString(),
  });

  connectedClients.forEach((client) => {
    if (client.readyState !== WS_OPEN_STATE) {
      return;
    }
    try {
      client.send(frame);
    } catch (error) {
      console.warn('[ChatSessionEvents] failed to deliver background_task frame', {
        sessionId: event.sessionId,
        taskId: event.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
