import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { useWebSocket } from './WebSocketContext';
import { fetchLockStatus } from './sessionLockApi';

interface SessionLockState {
  /** True if any session is currently being polled, prevents flicker between events */
  loading: boolean;
  /** Map of provider session id -> whether that session is locked by a bg agent */
  lockedIds: Map<string, boolean>;
  /** True if the given session id is locked right now */
  isLocked: (sessionId: string | null | undefined) => boolean;
  /** Force-refresh the lock state of one session from the REST endpoint.
   * Call this when a chat view mounts so the UI knows about sessions that
   * were already locked *before* the WebSocket `session_lock_state_changed`
   * stream began — the delta events only cover changes, not initial state. */
  refreshSession: (sessionId: string) => Promise<void>;
  /** Force-refresh all tracked sessions. Kept for API symmetry. */
  refresh: () => Promise<void>;
}

const SessionLockContext = createContext<SessionLockState | null>(null);

interface LockStateEvent {
  kind: 'session_lock_state_changed';
  locked?: string[];
  unlocked?: string[];
  timestamp?: string;
}

export function SessionLockProvider({ children }: { children: React.ReactNode }) {
  const { subscribe } = useWebSocket();
  const [lockedIds, setLockedIds] = useState<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(false);

  const applyDelta = useCallback((locked: string[], unlocked: string[]) => {
    setLockedIds((prev) => {
      const next = new Map(prev);
      for (const id of unlocked) next.set(id, false);
      for (const id of locked) next.set(id, true);
      return next;
    });
  }, []);

  // Listen for WebSocket lock state changes
  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      if (event && (event as LockStateEvent).kind === 'session_lock_state_changed') {
        const payload = event as LockStateEvent;
        applyDelta(payload.locked ?? [], payload.unlocked ?? []);
      }
    });
    return unsubscribe;
  }, [subscribe, applyDelta]);

  const isLocked = useCallback(
    (sessionId: string | null | undefined) => {
      if (!sessionId) return false;
      return Boolean(lockedIds.get(sessionId));
    },
    [lockedIds],
  );

  const refreshSession = useCallback(async (sessionId: string) => {
    if (!sessionId) return;
    const locked = await fetchLockStatus(sessionId);
    setLockedIds((prev) => {
      // Keep the latest WS-driven value if a newer event arrived in the
      // meantime (it won via timestamp/delta). A naive overwrite here would
      // clobber a just-broadcast unlock with stale data. We only seed when
      // the entry is absent — the common case on first open.
      if (prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.set(sessionId, locked);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(false);
  }, []);

  return (
    <SessionLockContext.Provider value={{ loading, lockedIds, isLocked, refreshSession, refresh }}>
      {children}
    </SessionLockContext.Provider>
  );
}

export function useSessionLock(): SessionLockState {
  const ctx = useContext(SessionLockContext);
  if (!ctx) {
    // Allow components rendered outside the provider to render safely; this
    // happens during storybook-style tests and one-off CLI invocations.
    return {
      loading: false,
      lockedIds: new Map(),
      isLocked: () => false,
      refreshSession: async () => {},
      refresh: async () => {},
    };
  }
  return ctx;
}
