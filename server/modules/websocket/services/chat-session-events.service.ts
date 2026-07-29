import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

export interface BackgroundTaskEvent {
  /**
   * The APP session id the frame belongs to, or `null` when the producer has
   * none.
   *
   * `null` is not an error — the REST entry points (`server/routes/agent.js`,
   * `server/routes/git.js`) have no app-session row, so the Claude pool keys
   * their runs on the provider-native id or a one-shot request id. The frontend
   * would take such a value as a session id and write a transcript row into a
   * store bucket that no session ever reads, so those events are dropped here
   * instead (see `emitBackgroundTaskEvent`).
   */
  sessionId: string | null;
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
  /**
   * The user whose turn started (or most recently ran) this work — the only
   * available notion of an owner, and what scopes delivery below.
   *
   * `null`/absent means genuinely unknown, which falls back to a broadcast. See
   * `emitBackgroundTaskEvent` for why that direction and not the other.
   */
  ownerUserId?: string | number | null;
}

/**
 * Emits a background-task event to the connections of the user it belongs to.
 *
 * Unlike run events, this can fire with NO run in flight — a background shell
 * outlives the turn that started it, so its completion has no writer to ride
 * on. That is why delivery walks `connectedClients` rather than a run's writer.
 *
 * It used to walk that set unconditionally, which sent every user the task's
 * description, its result summary and the absolute output path on the host, and
 * (via the frontend) rang their chime. Delivery is now scoped to the owner's own
 * connections, which the connection objects carry as `userId` (stamped at
 * registration in `handleChatConnection`) — one structure, no second map to keep
 * in sync with connects and disconnects.
 *
 * Note what this is and is not: it removes incidental exposure between users. It
 * is NOT tenancy isolation — the `sessions` table has no owner column and there
 * is no session-level ACL anywhere in the app, so any authenticated user can
 * still open any session over REST.
 *
 * Failure direction is deliberately open: an unknown owner broadcasts and logs,
 * because failing closed would drop the notification for the owner too, and the
 * notification is the entire feature.
 */
export function emitBackgroundTaskEvent(event: BackgroundTaskEvent): void {
  if (!event.sessionId) {
    // Never reaches the wire: the frontend resolves a frame without a session id
    // onto whatever session the user happens to be viewing.
    console.warn('[ChatSessionEvents] dropping a background_task with no app session id', {
      taskId: event.taskId,
      status: event.status,
    });
    return;
  }

  const ownerKey = event.ownerUserId === null || event.ownerUserId === undefined
    ? null
    : String(event.ownerUserId);

  if (ownerKey === null) {
    // Once per event, not once per client.
    console.warn('[ChatSessionEvents] background_task has an unknown owner — broadcasting to all clients', {
      sessionId: event.sessionId,
      taskId: event.taskId,
    });
  }

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
    // Compared as strings because the two ids travel different routes to get
    // here (the JWT payload via `readRequestUserId`, and the run writer's
    // `userId`), and a numeric row id that arrived as a string on one of them
    // would silently match nobody.
    if (ownerKey !== null && (client.userId === null || client.userId === undefined || String(client.userId) !== ownerKey)) {
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
