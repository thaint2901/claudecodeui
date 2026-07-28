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
 * @property {NodeJS.Timeout | null} idleTimer
 * @property {boolean} dead
 */

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

function routeMessage(session, message) {
  trackTask(session, message);

  if (message?.type === 'result') {
    settleCurrentTurn(session, message);
    closeIfIdle(session);
    return;
  }

  if (session.currentTurn) {
    session.currentTurn.onMessage(message);
    return;
  }

  // No turn in flight: this is the path that carries a background task's
  // completion to the UI after its turn already finished.
  session.onBetweenTurnMessage(message);

  if (session.liveTaskIds.size === 0 && !session.idleTimer) {
    session.idleTimer = setTimeout(() => closeIfIdle(session), IDLE_GRACE_MS);
  }
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

function createLiveSession({ appSessionId, sdkOptions, onBetweenTurnMessage, createQuery }) {
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
   */
  async runTurn({ appSessionId, userMessage, sdkOptions, onMessage, onBetweenTurnMessage, createQuery }) {
    let session = live.get(appSessionId);
    if (!session || session.dead) {
      session = createLiveSession({ appSessionId, sdkOptions, onBetweenTurnMessage, createQuery });
    } else {
      // Keep the sink pointed at the newest caller so between-turn events reach
      // whoever is currently watching.
      session.onBetweenTurnMessage = onBetweenTurnMessage;
    }

    clearIdleTimer(session);

    if (session.currentTurn) {
      throw new Error(`Session "${appSessionId}" already has a turn in flight`);
    }

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

  /** Settles an in-flight turn WITHOUT killing the process. Used by abort. */
  settleTurn(appSessionId, reason) {
    const session = live.get(appSessionId);
    if (!session) {
      return false;
    }
    return settleCurrentTurn(session, { type: 'result', subtype: reason });
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

  _resetForTests() {
    for (const session of [...live.values()]) {
      destroy(session);
    }
    live.clear();
  },
};
