// server/claude-session-pool.js
import { createInputStream } from './claude-session-input-stream.js';

/**
 * Owns the lifetime of live `claude` CLI processes, one per app session.
 *
 * Why this exists: ccui used to create a `query()` per turn, so the subprocess
 * exited at turn end and took any background shell with it. The CLI only
 * reaps background tasks once its input is closed, so this pool keeps the input
 * stream open while background work is live and closes it otherwise. A session
 * that never starts background work therefore behaves exactly as before.
 *
 * Deliberately knows nothing about normalized messages or websockets: callers
 * pass `onMessage` / `onBetweenTurnMessage` and keep translation to themselves.
 */

const IDLE_GRACE_MS = 60000;

/**
 * Option fields whose value must match the live process for a turn to be
 * allowed to reuse it, split by whether a RUNNING process can be reconfigured.
 *
 * `LIVE_APPLICABLE_*` have a real mid-session mechanism: `setPermissionMode()`
 * and `setModel()` are SDK control requests (streaming-input-only — which is
 * exactly the mode this pool put us in), and the allow/deny lists reach our own
 * approval callback through the shared `turnContext` object rather than through
 * the closure the SDK captured on turn 1.
 *
 * `RECREATE_ONLY_*` can only be honoured by a fresh `query()`: `cwd` and
 * `effort` are fixed at spawn, and a fork needs its own process (there is no
 * fork-mid-stream control request). When background work is live we refuse to
 * close, so those changes are reported and skipped rather than silently
 * pretended-applied.
 *
 * Deliberately NOT relevant:
 * - `resume`: an artifact of process creation, not a behaviour knob. A live
 *   process is by definition already on its session, and turn 2 of a brand-new
 *   session always gains a `resume` value that turn 1 lacked — treating that as
 *   a change would recreate (or warn) on every such turn for no benefit.
 * - `env` / `mcpServers` / `hooks` / `canUseTool`: rebuilt per turn by
 *   `mapCliOptionsToSDK`, so they differ by identity every time; MCP-server
 *   parity across turns is an explicit non-goal of the design spec.
 */
const LIVE_APPLICABLE_OPTION_FIELDS = ['permissionMode', 'model', 'allowedTools', 'disallowedTools'];
const RECREATE_ONLY_OPTION_FIELDS = ['cwd', 'effort', 'forkSession', 'resumeSessionAt'];
const RELEVANT_OPTION_FIELDS = [...LIVE_APPLICABLE_OPTION_FIELDS, ...RECREATE_ONLY_OPTION_FIELDS];

/** @type {Map<string, LiveSession>} */
const live = new Map();

/**
 * @typedef {object} LiveSession
 * @property {string} appSessionId
 * @property {object} query
 * @property {ReturnType<typeof createInputStream>} input
 * @property {Set<string>} liveTaskIds
 * @property {{ onMessage: Function, resolve: Function, reject: Function } | null} currentTurn
 * @property {Function} onBetweenTurnMessage
 * @property {object} optionSnapshot - Normalized `RELEVANT_OPTION_FIELDS` as
 *   currently in force on this process (creation values, amended by whatever
 *   control requests have since been applied).
 * @property {object | null} turnContext - Mutable object the caller's captured
 *   callbacks (`canUseTool`, hooks) read from. Updated IN PLACE on reuse so
 *   turn 1's captured closures act on turn N's writer and settings.
 * @property {NodeJS.Timeout | null} idleTimer
 * @property {boolean} dead
 */

/** Order-insensitive for lists, so a reshuffled allowlist is not a "change". */
function normalizeOptionValue(value) {
  if (Array.isArray(value)) {
    return [...value].map(String).sort();
  }
  return value === undefined ? null : value;
}

function snapshotOptions(sdkOptions) {
  /** @type {Record<string, unknown>} */
  const snapshot = {};
  for (const field of RELEVANT_OPTION_FIELDS) {
    snapshot[field] = normalizeOptionValue(sdkOptions?.[field]);
  }
  return snapshot;
}

function differingFields(fields, current, next) {
  return fields.filter((field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]));
}

/**
 * Reconfigures a RUNNING process to the new turn's options.
 *
 * Only reached when the session has live background work, i.e. when closing and
 * recreating would kill the very task this pool exists to protect. A failure to
 * apply `permissionMode` rejects the turn instead of running it: the mode is a
 * safety boundary (`bypassPermissions` skips the approval callback entirely
 * inside the CLI), so silently proceeding under the previous mode would let a
 * user who just tightened their settings be auto-approved against the old ones.
 * `model` is not a safety boundary, so a failure there is logged and the turn
 * proceeds.
 */
async function applyLiveOptionChanges(session, nextSnapshot) {
  const changed = differingFields(LIVE_APPLICABLE_OPTION_FIELDS, session.optionSnapshot, nextSnapshot);

  if (changed.includes('permissionMode')) {
    const mode = nextSnapshot.permissionMode ?? 'default';
    if (typeof session.query.setPermissionMode !== 'function') {
      throw new Error(
        `Cannot switch the live Claude session "${session.appSessionId}" to permission mode "${mode}": `
        + 'this SDK build exposes no setPermissionMode() control request, and the process must stay '
        + 'alive for its background work. Refusing to run the turn under the previous mode.',
      );
    }
    await session.query.setPermissionMode(mode);
  }

  if (changed.includes('model')) {
    try {
      await session.query.setModel?.(nextSnapshot.model ?? undefined);
    } catch (error) {
      console.warn('[ClaudeSessionPool] setModel() failed; the live session keeps its previous model', {
        appSessionId: session.appSessionId,
        model: nextSnapshot.model,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // `allowedTools` / `disallowedTools` need no control request: they are read
  // per invocation from `session.turnContext`, which the caller refreshes on
  // every turn. Caveat, recorded honestly: the CLI ALSO holds the spawn-time
  // allowlist and auto-approves against it without consulting our callback, so
  // a tool REMOVED from `allowedTools` mid-session stays auto-approved inside
  // the CLI until the process is recreated. Tightening via `disallowedTools`
  // does take effect, because those tools reach our callback.
  for (const field of changed) {
    session.optionSnapshot[field] = nextSnapshot[field];
  }
}

function clearIdleTimer(session) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

/**
 * Removes `session` from `live` only if it is still the entry stored at its
 * own key. `destroy()` and `drain()`'s `finally` both race a superseding
 * session created for the same `appSessionId` (e.g. `closeSession()` runs
 * synchronously, but the old session's async generator does not actually
 * finish until a later microtask) — an unconditional `live.delete()` would
 * delete the NEW session's entry instead of a stale one that's already gone.
 */
function removeFromLiveIfCurrent(session) {
  if (live.get(session.appSessionId) === session) {
    live.delete(session.appSessionId);
  }
}

function destroy(session) {
  clearIdleTimer(session);
  session.dead = true;
  session.input.close();
  try {
    session.query.close?.();
  } catch (error) {
    console.warn('[ClaudeSessionPool] close() failed', {
      appSessionId: session.appSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  removeFromLiveIfCurrent(session);
}

/**
 * Live-task bookkeeping, driven by typed SDK messages rather than tool_result
 * prose. A missed announcement would leave the set empty and let us close the
 * process — killing the very task we are trying to protect — so this must not
 * depend on string matching.
 */
function trackTask(session, message) {
  if (message?.type !== 'system') {
    return;
  }
  if (message.subtype === 'task_started' && typeof message.task_id === 'string') {
    session.liveTaskIds.add(message.task_id);
    return;
  }
  if (message.subtype === 'task_notification' && typeof message.task_id === 'string') {
    session.liveTaskIds.delete(message.task_id);
    return;
  }
  if (message.subtype === 'task_updated' && typeof message.task_id === 'string') {
    const status = message.patch?.status;
    if (status === 'completed' || status === 'failed' || status === 'killed') {
      session.liveTaskIds.delete(message.task_id);
    }
  }
}

/** Closes the session unless background work still needs the process alive. */
function closeIfIdle(session) {
  if (session.dead || session.currentTurn) {
    return;
  }
  if (session.liveTaskIds.size > 0) {
    clearIdleTimer(session);
    return;
  }
  destroy(session);
}

function settleCurrentTurn(session, result) {
  const turn = session.currentTurn;
  if (!turn) {
    return false;
  }
  session.currentTurn = null;
  turn.resolve(result);
  return true;
}

/**
 * Arms the idle-close timer if nothing is currently tracked as live and no
 * timer is already pending. Deliberately does NOT decide anything itself —
 * `closeIfIdle` (run only when the timer fires, `IDLE_GRACE_MS` later) is the
 * sole place that actually closes, and it re-reads `liveTaskIds` at that
 * later point rather than trusting the snapshot taken when the timer was
 * armed. That distinction matters: a caller outside the drain loop (e.g.
 * abort) can only ever see a stale/incomplete `liveTaskIds` snapshot, since a
 * message the CLI already sent may not have been routed through
 * `routeMessage` yet. Arming a deferred check — instead of closing on that
 * stale snapshot — gives any in-flight message the whole grace window to
 * arrive and register before the close decision is actually made.
 */
function armIdleTimerIfIdle(session) {
  if (session.liveTaskIds.size === 0 && !session.idleTimer) {
    session.idleTimer = setTimeout(() => closeIfIdle(session), IDLE_GRACE_MS);
  }
}

function isTaskNotification(message) {
  return message?.type === 'system' && message?.subtype === 'task_notification';
}

function routeMessage(session, message) {
  trackTask(session, message);

  if (message?.type === 'result') {
    settleCurrentTurn(session, message);
    closeIfIdle(session);
    return;
  }

  if (session.currentTurn) {
    // A task settling while a LATER turn is in flight must still reach the
    // session sink. The in-turn path normalizes SDK messages by `message.role`
    // (claude-sessions.provider.ts), so a `system`/`task_notification` frame
    // normalizes to nothing — routing it only to the turn would make a
    // completion, a failure, or a reaper kill vanish silently, which is exactly
    // what goal 3 of the design forbids.
    if (isTaskNotification(message)) {
      session.onBetweenTurnMessage(message);
    }
    session.currentTurn.onMessage(message);
    return;
  }

  // No turn in flight: this is the path that carries a background task's
  // completion to the UI after its turn already finished.
  session.onBetweenTurnMessage(message);

  armIdleTimerIfIdle(session);
}

async function drain(session) {
  try {
    for await (const message of session.query) {
      routeMessage(session, message);
    }
  } catch (error) {
    const turn = session.currentTurn;
    session.currentTurn = null;
    if (turn) {
      turn.reject(error instanceof Error ? error : new Error(String(error)));
    }
  } finally {
    // The process is gone. Reject any turn still waiting so the caller's
    // promise settles and its own safety net can complete the run.
    const turn = session.currentTurn;
    session.currentTurn = null;
    if (turn) {
      turn.reject(new Error('Claude session process ended before the turn completed'));
    }
    session.dead = true;
    clearIdleTimer(session);
    removeFromLiveIfCurrent(session);
  }
}

function createLiveSession({ appSessionId, sdkOptions, turnContext, onBetweenTurnMessage, createQuery }) {
  const input = createInputStream();
  const query = createQuery({ prompt: input, options: sdkOptions });

  /** @type {LiveSession} */
  const session = {
    appSessionId,
    query,
    input,
    liveTaskIds: new Set(),
    currentTurn: null,
    onBetweenTurnMessage,
    optionSnapshot: snapshotOptions(sdkOptions),
    turnContext: turnContext ?? null,
    idleTimer: null,
    dead: false,
  };

  live.set(appSessionId, session);
  void drain(session);
  return session;
}

export const claudeSessionPool = {
  /**
   * Runs one turn, reusing the session's live process when there is one.
   * Resolves with that turn's SDK `result` message.
   *
   * A reused process must never keep running turn 1's options: the SDK holds
   * the `query()` options it was constructed with, so a user who switches
   * permission mode or unchecks a tool would otherwise be silently evaluated
   * against the settings they just abandoned. Reconciliation happens before the
   * prompt is pushed — recreate when nothing is at stake, reconfigure in place
   * when background work must survive.
   */
  async runTurn({ appSessionId, userMessage, sdkOptions, turnContext, onMessage, onBetweenTurnMessage, createQuery }) {
    let session = live.get(appSessionId);
    if (session?.dead) {
      session = undefined;
    }

    if (session) {
      if (session.currentTurn) {
        throw new Error(`Session "${appSessionId}" already has a turn in flight`);
      }

      const nextSnapshot = snapshotOptions(sdkOptions);
      const changed = differingFields(RELEVANT_OPTION_FIELDS, session.optionSnapshot, nextSnapshot);

      if (changed.length > 0 && session.liveTaskIds.size === 0) {
        // Nothing to protect. The pre-pool behaviour closed at turn end anyway,
        // so a clean recreate costs nothing and is the only way to honour EVERY
        // option — including the ones no control request can change.
        destroy(session);
        session = undefined;
      } else if (changed.length > 0) {
        const unappliable = differingFields(RECREATE_ONLY_OPTION_FIELDS, session.optionSnapshot, nextSnapshot);
        if (unappliable.length > 0) {
          console.warn('[ClaudeSessionPool] keeping the live process for its background work, so these option changes cannot take effect until it closes', {
            appSessionId,
            fields: unappliable,
          });
        }
        await applyLiveOptionChanges(session, nextSnapshot);
        // Applying a control request yields the event loop; the process can die
        // in that window.
        if (session.dead) {
          session = undefined;
        }
      }
    }

    if (session) {
      // Keep the sink pointed at the newest caller so between-turn events reach
      // whoever is currently watching, and refresh the shared turn context IN
      // PLACE so the approval callback the SDK captured on turn 1 resolves this
      // turn's writer and this turn's allow/deny lists.
      session.onBetweenTurnMessage = onBetweenTurnMessage;
      if (session.turnContext && turnContext) {
        Object.assign(session.turnContext, turnContext);
      }
    } else {
      session = createLiveSession({ appSessionId, sdkOptions, turnContext, onBetweenTurnMessage, createQuery });
    }

    clearIdleTimer(session);

    return new Promise((resolve, reject) => {
      session.currentTurn = { onMessage, resolve, reject };
      session.input.push(userMessage);
    });
  },

  hasLiveSession(appSessionId) {
    const session = live.get(appSessionId);
    return Boolean(session && !session.dead);
  },

  getLiveTaskIds(appSessionId) {
    return [...(live.get(appSessionId)?.liveTaskIds ?? [])];
  },

  /**
   * Settles an in-flight turn WITHOUT killing the process. Used by abort.
   *
   * Never closes synchronously — the caller (abort) can only ever hold a
   * stale view of `liveTaskIds`, since a message the CLI already sent (e.g.
   * `task_started`) may still be in flight, unrouted by this session's drain
   * loop, at the exact moment abort settles the turn. Deciding to close from
   * outside on that stale snapshot would risk killing a background task that
   * just registered — instead this only arms the same deferred idle-close
   * check `routeMessage` uses between turns, which re-reads `liveTaskIds`
   * `IDLE_GRACE_MS` later, from inside the drain loop's own ordering, by
   * which point any in-flight message has certainly been routed.
   */
  settleTurn(appSessionId, reason) {
    const session = live.get(appSessionId);
    if (!session) {
      return false;
    }
    const settled = settleCurrentTurn(session, { type: 'result', subtype: reason });
    if (settled) {
      armIdleTimerIfIdle(session);
    }
    return settled;
  },

  /**
   * Interrupts the CURRENT turn without closing the input stream or killing
   * the process — a background shell started earlier in the session must
   * survive. The underlying SDK query object never leaves the pool; callers
   * (abort) reach it only through this method. A missing/dead session is a
   * silent no-op: there is nothing left to interrupt.
   */
  async interruptTurn(appSessionId) {
    const session = live.get(appSessionId);
    if (!session || session.dead) {
      return false;
    }
    try {
      await session.query.interrupt?.();
    } catch (error) {
      console.warn('[ClaudeSessionPool] interrupt() failed', {
        appSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  },

  closeSession(appSessionId) {
    const session = live.get(appSessionId);
    if (session) {
      destroy(session);
    }
  },

  /**
   * Closes every live session. Called on server shutdown.
   *
   * Not a leak backstop: the SDK already registers one `process.on('exit')`
   * handler that SIGTERMs every child it spawned (`V2`/`W2` in `sdk.mjs`), so an
   * abrupt exit does not orphan the ~320 MB `claude` process. What that handler
   * cannot do is give the CLI a chance to shut down cleanly — a SIGTERM'd CLI
   * never reaches the `inputClosed` branch that reaps its own background tasks,
   * so those shells are left behind for the OS to inherit. Closing the input
   * stream here is what lets each CLI reap its own children before it dies.
   * @returns {number} How many sessions were closed.
   */
  closeAllSessions() {
    const sessions = [...live.values()];
    for (const session of sessions) {
      destroy(session);
    }
    live.clear();
    return sessions.length;
  },

  _resetForTests() {
    claudeSessionPool.closeAllSessions();
  },
};
