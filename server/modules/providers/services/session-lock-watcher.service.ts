/**
 * Session Lock Watcher
 *
 * Monitors ~/.claude/daemon/roster.json to track which Claude sessions are
 * currently held by background agents. When a session enters or leaves the
 * roster, the change is broadcast to all connected WebSocket clients so the
 * UI can block (or re-enable) the prompt input.
 *
 * Why roster.json and not `claude agents --json`?
 *   - roster.json is the canonical on-disk source of truth (per Anthropic docs)
 *   - Reading a file is cheaper than spawning a subprocess on every change
 *   - Falls back to the CLI if the file disappears or is malformed
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import chokidar, { type FSWatcher } from 'chokidar';

import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

const execFileAsync = promisify(execFile);

const ROSTER_PATH = path.join(os.homedir(), '.claude', 'daemon', 'roster.json');
const REFRESH_INTERVAL_MS = 60_000; // safety-net poll in case chokidar misses an event
const FILE_READ_TIMEOUT_MS = 5_000;
const CLI_FALLBACK_TIMEOUT_MS = 5_000;

let watcher: FSWatcher | null = null;
let lastLocked: Set<string> = new Set();
let lastBroadcastAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

type RosterShape = {
  workers?: Record<string, { sessionId?: string }>;
};

/**
 * Parse roster.json and return the set of provider session IDs currently
 * claimed by background workers. Returns an empty set if the file is missing
 * or malformed — callers should treat that as "no sessions are locked".
 */
async function readRoster(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(ROSTER_PATH, 'utf8');
    const parsed = JSON.parse(raw) as RosterShape;
    const ids = new Set<string>();
    for (const worker of Object.values(parsed.workers ?? {})) {
      if (typeof worker?.sessionId === 'string' && worker.sessionId) {
        ids.add(worker.sessionId);
      }
    }
    return ids;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[SessionLockWatcher] Roster read failed:', (error as Error).message);
    }
    return new Set();
  }
}

/**
 * Fallback path: spawn `claude agents --json` if the roster file is
 * unavailable. Slower than reading the file but resilient to schema changes
 * and missing files. Returns an empty set if the CLI is not installed.
 */
async function readAgentsFromCli(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync(
      resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
      ['agents', '--json'],
      { timeout: CLI_FALLBACK_TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout) as Array<{ sessionId?: string }>;
    const ids = new Set<string>();
    for (const entry of parsed) {
      if (typeof entry?.sessionId === 'string' && entry.sessionId) {
        ids.add(entry.sessionId);
      }
    }
    return ids;
  } catch (error) {
    console.warn('[SessionLockWatcher] CLI fallback failed:', (error as Error).message);
    return new Set();
  }
}

/**
 * Compute the delta between the previous and current lock set, then broadcast
 * a `session_lock_state_changed` event to every connected client. The event
 * uses the same envelope as the existing session watcher.
 */
function broadcastDelta(current: Set<string>): void {
  const newlyLocked: string[] = [];
  const newlyUnlocked: string[] = [];

  for (const id of current) {
    if (!lastLocked.has(id)) {
      newlyLocked.push(id);
    }
  }
  for (const id of lastLocked) {
    if (!current.has(id)) {
      newlyUnlocked.push(id);
    }
  }

  lastLocked = current;
  lastBroadcastAt = Date.now();

  if (newlyLocked.length === 0 && newlyUnlocked.length === 0) {
    return;
  }

  const payload = JSON.stringify({
    kind: 'session_lock_state_changed',
    locked: newlyLocked,
    unlocked: newlyUnlocked,
    timestamp: new Date().toISOString(),
  });

  let delivered = 0;
  for (const client of connectedClients.values()) {
    if (client.readyState === WS_OPEN_STATE) {
      try {
        client.send(payload);
        delivered += 1;
      } catch (error) {
        console.warn('[SessionLockWatcher] Failed to deliver lock event:', (error as Error).message);
      }
    }
  }

  console.log('[SessionLockWatcher] Broadcast', {
    locked: newlyLocked.length,
    unlocked: newlyUnlocked.length,
    delivered,
  });
}

/**
 * Read the roster, reconcile with the cached state, and broadcast any delta.
 * Safe to call repeatedly — no-ops when nothing changed.
 */
async function reconcile(): Promise<void> {
  let current: Set<string>;
  try {
    current = await Promise.race([
      readRoster(),
      new Promise<Set<string>>((_, reject) =>
        setTimeout(() => reject(new Error('roster read timeout')), FILE_READ_TIMEOUT_MS),
      ),
    ]);
  } catch (error) {
    console.warn('[SessionLockWatcher] Falling back to CLI:', (error as Error).message);
    current = await readAgentsFromCli();
  }

  broadcastDelta(current);
}

/**
 * Public API: returns the set of session IDs currently held by background
 * workers. Used by the lock-status REST endpoint to seed the UI on first
 * load before any WebSocket event has arrived.
 */
export async function getLockedBgSessionIds(): Promise<Set<string>> {
  const fromFile = await readRoster();
  if (fromFile.size > 0) {
    return fromFile;
  }
  return readAgentsFromCli();
}

/**
 * Starts the file watcher and primes the cache. Idempotent — calling twice
 * has no effect. Should be invoked once during server startup.
 */
export async function initializeSessionLockWatcher(): Promise<void> {
  if (initialized) {
    return;
  }
  initialized = true;

  console.log('[SessionLockWatcher] Watching roster.json for bg session changes');

  // Prime the cache so the first delta is meaningful
  await reconcile();

  // Watch the containing directory rather than the file itself: the daemon
  // writes roster.json via write-temp-then-rename, which swaps out the
  // underlying inode on every update. A watch on the file path directly dies
  // silently the moment that first rename happens, leaving only the 60s
  // safety-net poll to notice future changes.
  const rosterFilename = path.basename(ROSTER_PATH);
  watcher = chokidar.watch(path.dirname(ROSTER_PATH), {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  const onRosterEvent = (changedPath: string) => {
    if (path.basename(changedPath) !== rosterFilename) return;
    void reconcile();
  };

  watcher.on('add', onRosterEvent);
  watcher.on('change', onRosterEvent);
  watcher.on('unlink', (changedPath: string) => {
    if (path.basename(changedPath) !== rosterFilename) return;
    // Daemon exited — clear the cache and broadcast an unlock for everything
    lastLocked = new Set();
    void reconcile();
  });
  watcher.on('error', (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[SessionLockWatcher] Chokidar error:', message);
  });

  // Safety-net poll: if chokidar ever misses an event we still re-sync
  refreshTimer = setInterval(() => {
    void reconcile();
  }, REFRESH_INTERVAL_MS);
}

/**
 * Stops the watcher. Used by tests and graceful shutdown.
 */
export async function shutdownSessionLockWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  initialized = false;
  lastLocked = new Set();
}

// Aliased export so other modules can wire this into shutdown handlers
export { shutdownSessionLockWatcher as closeSessionLockWatcher };

/**
 * Service-shaped export for callers that prefer an object/namespace over
 * a bag of top-level functions.
 */
export const sessionLockWatcherService = {
  initialize: initializeSessionLockWatcher,
  shutdown: shutdownSessionLockWatcher,
  getLockedIds: getLockedBgSessionIds,
};
