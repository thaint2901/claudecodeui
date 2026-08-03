import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { normalizeProjectPath } from '@/shared/workspace-paths.js';

type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
  fork_root_session_id: string | null;
  forked_from_session_id: string | null;
  forked_at_message_uuid: string | null;
  active_leaf: number;
};

const SESSION_ROW_COLUMNS =
  'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at, fork_root_session_id, forked_from_session_id, forked_at_message_uuid, active_leaf';

/**
 * Newest-first ordering shared by the sidebar page and the orphan-cluster
 * fallback below, so the row the fallback surfaces is the row the page would
 * have put first anyway.
 */
const SESSION_RECENCY_ORDER =
  'datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC';

/**
 * Visibility predicate for the sidebar: one row per conversation, and for a
 * fork cluster, one row per cluster.
 *
 * The second arm is a self-heal. A cluster is supposed to keep exactly one
 * `active_leaf = 1`, but deleting or archiving that leaf used to leave every
 * remaining row at 0, and both sidebar queries then dropped the whole cluster —
 * original conversation included — with no way back from the UI. The write
 * paths now repair the cluster (see `promoteClusterLeafIfOrphaned`), but any
 * database that already ran the broken build still holds orphaned clusters, so
 * the read side has to surface them too. Falling back to the most recent
 * surviving sibling keeps the one-row-per-cluster contract instead of suddenly
 * fanning every branch out into the list.
 */
const VISIBLE_SESSION_PREDICATE = `(
    active_leaf = 1
    OR (
      fork_root_session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sessions AS live
        WHERE live.fork_root_session_id = sessions.fork_root_session_id
          AND live.isArchived = 0
          AND live.active_leaf = 1
      )
      AND session_id = (
        SELECT pick.session_id FROM sessions AS pick
        WHERE pick.fork_root_session_id = sessions.fork_root_session_id
          AND pick.isArchived = 0
        ORDER BY datetime(COALESCE(pick.updated_at, pick.created_at)) DESC, pick.session_id DESC
        LIMIT 1
      )
    )
  )`;

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is stored as UTC without a timezone suffix.
  // Normalize it here so every session reader returns canonical ISO strings
  // and the sidebar never interprets fresh rows as local-time "hours old".
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeSessionRow<T extends SessionRow | null | undefined>(row: T): T {
  if (!row) {
    return row;
  }

  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

function normalizeSessionRows(rows: SessionRow[]): SessionRow[] {
  return rows.map((row) => normalizeSessionRow(row) as SessionRow);
}

type DatabaseHandle = ReturnType<typeof getConnection>;

/** Cluster a session belongs to, read before the row is deleted or hidden. */
function getForkRootId(db: DatabaseHandle, sessionId: string): string | null {
  const row = db
    .prepare('SELECT fork_root_session_id FROM sessions WHERE session_id = ? LIMIT 1')
    .get(sessionId) as { fork_root_session_id: string | null } | undefined;
  return row?.fork_root_session_id ?? null;
}

/**
 * Keeps a fork cluster reachable after its visible leaf goes away.
 *
 * Deleting or archiving the branch that carried `active_leaf = 1` used to leave
 * every sibling at 0, and the sidebar hides those — so the original
 * conversation and every other branch disappeared with no UI path back. The
 * most recently touched surviving branch is promoted instead. Call inside the
 * same transaction as the delete/archive so the cluster is never observable
 * without a leaf.
 *
 * `preferSessionId` names a row that should win the promotion over plain
 * recency. Restoring an archived branch passes it: the user just asked to see
 * that specific conversation, and handing the leaf to whichever sibling
 * happens to be newest makes their click look like it did nothing — the row
 * leaves the archived list and still never appears in the sidebar. It only
 * applies when the cluster has no live leaf at all; a healthy cluster keeps
 * the leaf it already has, so restoring a branch never yanks the view away
 * from the conversation someone is reading.
 */
function promoteClusterLeafIfOrphaned(
  db: DatabaseHandle,
  forkRootId: string | null,
  preferSessionId?: string
): void {
  if (!forkRootId) return;

  const stillHasLeaf = db
    .prepare(
      `SELECT 1 FROM sessions
       WHERE fork_root_session_id = ? AND isArchived = 0 AND active_leaf = 1
       LIMIT 1`
    )
    .get(forkRootId);
  if (stillHasLeaf) return;

  const preferred = preferSessionId
    ? (db
        .prepare(
          `SELECT session_id FROM sessions
           WHERE session_id = ? AND fork_root_session_id = ? AND isArchived = 0
           LIMIT 1`
        )
        .get(preferSessionId, forkRootId) as { session_id: string } | undefined)
    : undefined;

  const replacement =
    preferred ??
    (db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE fork_root_session_id = ? AND isArchived = 0
         ORDER BY ${SESSION_RECENCY_ORDER}
         LIMIT 1`
      )
      .get(forkRootId) as { session_id: string } | undefined);
  if (!replacement) return;

  db.prepare('UPDATE sessions SET active_leaf = 1 WHERE session_id = ?').run(replacement.session_id);
}

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

export const sessionsDb = {
  /**
   * Upserts one session row discovered on disk by a provider synchronizer.
   *
   * The given id is the provider-native session id. Rows are keyed by
   * `provider_session_id` so a session that was first created by the app
   * (with an app-allocated `session_id`) is updated in place once its
   * transcript shows up on disk, instead of producing a duplicate row.
   */
  createSession(
    providerSessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null
  ): string {
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    // First, ensure the project path is recorded in the projects table,
    // since it's a foreign key in the sessions table.
    projectsDb.createProjectPath(normalizedProjectPath);

    const existing = db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as { session_id: string } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE sessions SET
           provider = ?,
           updated_at = COALESCE(?, CURRENT_TIMESTAMP),
           project_path = ?,
           jsonl_path = ?,
           isArchived = 0,
           custom_name = COALESCE(?, custom_name)
         WHERE session_id = ?`
      ).run(
        provider,
        updatedAtValue,
        normalizedProjectPath,
        jsonlPath ?? null,
        customName ?? null,
        existing.session_id
      );

      return existing.session_id;
    }

    // Sessions created outside the app (directly via the provider CLI) are
    // keyed by the provider-native id for both columns. The ON CONFLICT path
    // covers legacy rows that predate the provider_session_id mapping.
    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         updated_at = excluded.updated_at,
         project_path = excluded.project_path,
         jsonl_path = excluded.jsonl_path,
         isArchived = 0,
         custom_name = COALESCE(excluded.custom_name, sessions.custom_name)`
    ).run(
      providerSessionId,
      provider,
      providerSessionId,
      customName ?? null,
      normalizedProjectPath,
      jsonlPath ?? null,
      createdAtValue,
      updatedAtValue
    );

    return providerSessionId;
  },

  /**
   * Inserts one app-allocated session row before any provider run happens.
   *
   * The session gateway uses this when the frontend starts a brand-new chat:
   * `session_id` is the stable app-facing id, while `provider_session_id`
   * stays NULL until the provider runtime announces its own id and
   * `assignProviderSessionId` records the mapping.
   */
  createAppSession(sessionId: string, provider: string, projectPath: string): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    projectsDb.createProjectPath(normalizedProjectPath);

    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(sessionId, provider, normalizedProjectPath);

    return sessionId;
  },

  /**
   * Records the provider-native session id for one app-allocated session.
   *
   * If the filesystem watcher indexed the provider transcript before this
   * mapping was recorded (a duplicate row keyed by the provider id exists),
   * the duplicate is merged into the app row: its transcript path and name
   * are adopted and the duplicate row is removed. Runs in a transaction so
   * the sidebar can never observe both rows at once.
   */
  assignProviderSessionId(sessionId: string, providerSessionId: string): void {
    const db = getConnection();

    const merge = db.transaction(() => {
      const duplicate = db
        .prepare(
          `SELECT ${SESSION_ROW_COLUMNS} FROM sessions
           WHERE (session_id = ? OR provider_session_id = ?)
             AND session_id <> ?
           LIMIT 1`
        )
        .get(providerSessionId, providerSessionId, sessionId) as SessionRow | undefined;

      if (duplicate) {
        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(duplicate.session_id);
        db.prepare(
          `UPDATE sessions SET
             provider_session_id = ?,
             jsonl_path = COALESCE(jsonl_path, ?),
             custom_name = COALESCE(custom_name, ?),
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        ).run(providerSessionId, duplicate.jsonl_path, duplicate.custom_name, sessionId);
        return;
      }

      db.prepare(
        `UPDATE sessions SET
           provider_session_id = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`
      ).run(providerSessionId, sessionId);
    });

    merge();
  },

  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  getSessionById(sessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Resolves one session row through the provider-native id.
   *
   * The filesystem watcher only knows provider ids (they come from transcript
   * file names), so it uses this lookup to translate disk artifacts back to
   * the app-facing session row before broadcasting sidebar updates.
   */
  getSessionByProviderSessionId(providerSessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider_session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(providerSessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Finds the newest app-created session for a project that is still waiting
   * for its provider-native id to be recorded.
   *
   * Primary intention: OpenCode can expose a new session in its shared
   * `opencode.db` before the websocket runtime reports that same provider id
   * back to our app. At that moment the sidebar already has an optimistic
   * app-owned session row, but the watcher only knows the provider-native id.
   *
   * Without this lookup, the synchronizer would insert a second row keyed by
   * the provider id, then `assignProviderSessionId()` would merge it a moment
   * later. That eventually self-heals, but on slow networks the user can still
   * briefly see two sidebar sessions for the same conversation.
   *
   * This helper lets the synchronizer claim the pending app row first, so the
   * provider id is attached before any watcher-created row exists. The result
   * is simpler than frontend dedupe and keeps the race resolved at the source.
   */
  findLatestPendingAppSession(provider: string, projectPath: string): SessionRow | null {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider = ?
           AND project_path = ?
           AND provider_session_id IS NULL
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT 1`
      )
      .get(provider, normalizedProjectPath) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 0`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 1
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           AND ${VISIBLE_SESSION_PREDICATE}
         ORDER BY ${SESSION_RECENCY_ORDER}
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, limit, offset) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           AND ${VISIBLE_SESSION_PREDICATE}`
      )
      .get(normalizedProjectPath) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    const forkRootId = getForkRootId(db, sessionId);
    const run = db.transaction(() => {
      // Archiving also clears the row's own leaf flag. An archived row is
      // hidden either way, so a stale `active_leaf = 1` on it is invisible
      // until the row comes back — and then the cluster has two live leaves
      // and fans out into two sidebar rows, which is exactly the one-row-per
      // -cluster contract this feature rests on. Measured before this line
      // existed: archive C then restore C listed both B and C.
      db.prepare(
        `UPDATE sessions
         SET isArchived = ?, active_leaf = CASE WHEN ? THEN 0 ELSE active_leaf END
         WHERE session_id = ?`
      ).run(isArchived ? 1 : 0, isArchived ? 1 : 0, sessionId);
      // Archiving the leaf orphans its cluster, so some sibling has to take
      // over. Restoring is the opposite: if the cluster has no leaf, the row
      // the user just restored is the one they asked to see.
      promoteClusterLeafIfOrphaned(db, forkRootId, isArchived ? undefined : sessionId);
    });
    run();
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    const forkRootId = getForkRootId(db, sessionId);
    const run = db.transaction(() => {
      const deleted = db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
      if (deleted) {
        promoteClusterLeafIfOrphaned(db, forkRootId);
      }
      return deleted;
    });
    return run();
  },

  /**
   * Records one conversation branch created by the edit-prompt fork flow.
   * The fork's provider-native id doubles as its app session_id (same
   * convention as disk-discovered sessions), so the filesystem watcher's
   * later createSession() call updates this row instead of duplicating it.
   * Runs in a transaction so the cluster never has 0 or 2 active leaves.
   */
  createForkedSession(args: {
    providerSessionId: string;
    parentSessionId: string;
    /** Shared fork anchor (assistant uuid); null for first-prompt forks. */
    forkedAtMessageUuid: string | null;
    provider: string;
    projectPath: string;
    jsonlPath?: string | null;
  }): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(args.provider, args.projectPath);
    projectsDb.createProjectPath(normalizedProjectPath);

    const insertBranch = db.transaction(() => {
      const parent = db
        .prepare(`SELECT ${SESSION_ROW_COLUMNS} FROM sessions WHERE session_id = ? LIMIT 1`)
        .get(args.parentSessionId) as SessionRow | undefined;
      if (!parent) {
        throw new Error(`Fork parent session "${args.parentSessionId}" not found`);
      }

      const rootId = parent.fork_root_session_id ?? parent.session_id;

      // Whole cluster (including a root that predates its own fork column)
      // goes inactive; the new branch becomes the single active leaf.
      db.prepare(
        `UPDATE sessions SET active_leaf = 0, fork_root_session_id = ?
         WHERE session_id = ? OR fork_root_session_id = ?`
      ).run(rootId, rootId, rootId);

      db.prepare(
        `INSERT INTO sessions (
           session_id, provider, provider_session_id, custom_name, project_path,
           jsonl_path, isArchived, created_at, updated_at,
           fork_root_session_id, forked_from_session_id, forked_at_message_uuid, active_leaf
         ) VALUES (?, ?, ?, NULL, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, 1)`
      ).run(
        args.providerSessionId, args.provider, args.providerSessionId,
        normalizedProjectPath, args.jsonlPath ?? null,
        rootId, args.parentSessionId, args.forkedAtMessageUuid,
      );

      return args.providerSessionId;
    });

    return insertBranch();
  },

  /** Makes one branch the cluster's visible leaf (two-step, one transaction). */
  activateBranch(sessionId: string): SessionRow | null {
    const db = getConnection();
    const activate = db.transaction(() => {
      const row = db
        .prepare(`SELECT ${SESSION_ROW_COLUMNS} FROM sessions WHERE session_id = ? LIMIT 1`)
        .get(sessionId) as SessionRow | undefined;
      if (!row || !row.fork_root_session_id) {
        return null;
      }
      db.prepare('UPDATE sessions SET active_leaf = 0 WHERE fork_root_session_id = ?')
        .run(row.fork_root_session_id);
      db.prepare('UPDATE sessions SET active_leaf = 1, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?')
        .run(sessionId);
      return db
        .prepare(`SELECT ${SESSION_ROW_COLUMNS} FROM sessions WHERE session_id = ? LIMIT 1`)
        .get(sessionId) as SessionRow | undefined;
    });
    return normalizeSessionRow(activate() ?? null) ?? null;
  },

  /** All branches of a session's fork cluster; [] when never forked. */
  getClusterBranches(sessionId: string): SessionRow[] {
    const db = getConnection();
    const row = db
      .prepare('SELECT fork_root_session_id FROM sessions WHERE session_id = ? LIMIT 1')
      .get(sessionId) as { fork_root_session_id: string | null } | undefined;
    if (!row?.fork_root_session_id) {
      return [];
    }
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS} FROM sessions
         WHERE fork_root_session_id = ?
         ORDER BY datetime(created_at) ASC, session_id ASC`
      )
      .all(row.fork_root_session_id) as SessionRow[];
    return normalizeSessionRows(rows);
  },
};
