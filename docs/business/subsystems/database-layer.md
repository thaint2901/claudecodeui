# Subsystem 9: Database Layer

## Business Purpose

The **Database Layer** subsystem owns the single SQLite (better-sqlite3) connection that backs the entire app. It defines the schema, runs migrations on boot, and exposes one repository per table for the rest of the backend. Every other subsystem reads or writes through this layer.

The current state is a **migration-in-progress**: the new `server/modules/database/` layout is being adopted, while a few legacy runtime files (`server/sessionManager.js`, `server/utils/runtime-paths.js`) are whitelisted by ESLint during the window.

## Key Capabilities

| Capability | Description |
|------------|-------------|
| **Single SQLite connection** | `getConnection` returns a shared better-sqlite3 handle; legacy path migration on first boot |
| **Schema initialization** | `INIT_SCHEMA_SQL` creates all tables: `users`, `api_keys`, `user_credentials`, `user_notification_preferences`, `vapid_keys`, `push_subscriptions`, `projects`, `sessions`, `app_config`, `scan_state` |
| **Migrations** | Idempotent: rebuilds legacy `workspace_original_paths` and `session_names` into `projects` / `sessions`; adds `provider_session_id` mapping; drops legacy tables |
| **Eager `app_config` bootstrap** | Created before full schema applies so the JWT secret can be read at middleware load time |
| **Per-table repositories** | One module per table: users, projects, sessions, api-keys, credentials, github-tokens, notification-preferences, push-subscriptions, vapid-keys, app-config, scan-state |
| **Path resolution** | `~/.cloudcli/auth.db` default; `--database-path` CLI flag and `DATABASE_PATH` env override; one-time migration from legacy `server/database/auth.db` |
| **Shared utils** | `AppError` class, `asyncHandler`, `createApiSuccessResponse`, `validateWorkspacePath`, `normalizeProjectPath` |
| **Legacy compatibility** | `sessionManager.js` (Gemini in-memory + JSON) and `runtime-paths.js` are whitelisted during the migration window |

## Tables

| Table | Purpose | Repository |
|-------|---------|------------|
| `users` | Local app user accounts (bcrypt, git identity, onboarding flag) | `users.ts` |
| `api_keys` | Long-lived programmatic tokens (`ck_`-prefixed) | `api-keys.ts` |
| `user_credentials` | Polymorphic store for github/gitlab/bitbucket tokens | `credentials.ts` (specialized `github-tokens.ts`) |
| `user_notification_preferences` | Per-user JSON blob of notification settings | `notification-preferences.ts` |
| `vapid_keys` | Singleton VAPID key pair for web-push | `vapid-keys.ts` |
| `push_subscriptions` | Browser push API subscriptions per user | `push-subscriptions.ts` |
| `projects` | Canonical list of local project directories | `projects.db.ts` |
| `sessions` | Index of every chat session across providers (two-id design) | `sessions.db.ts` |
| `scan_state` | Singleton watermark for the sessions-watcher | `scan-state.db.ts` |
| `app_config` | Generic key/value store (JWT secret, browser-use settings) | `app-config.ts` |
| Legacy: `workspace_original_paths`, `session_names` | Pre-rename versions of `projects` / `sessions` | `migrations.ts` (drops them) |

## Stakeholders

| Stakeholder | What They Get |
|-------------|---------------|
| **All other subsystems** | A single, consistent persistence layer. |
| **Operators** | One SQLite file to back up (`~/.cloudcli/auth.db`). |
| **Migrators** | Idempotent migrations that survive interrupted boots. |
| **Test runners** | A `getConnection` they can swap for an in-memory DB. |

## How a Boot Works

1. `server/load-env.js` resolves `DATABASE_PATH` (env → CLI flag → default `~/.cloudcli/auth.db`).
2. `connection.ts` opens the SQLite handle (creating the directory if needed).
3. The `app_config` table is created **eagerly** (before full schema) so the auth middleware can read the JWT secret.
4. `init-db.ts` applies `INIT_SCHEMA_SQL` and runs `migrations.ts` (idempotent).
5. All repositories now point at the shared connection; downstream modules import from `server/modules/database/index.ts`.

## Cross-Cutting Concerns

- **Connection ownership** — One process-wide connection; repos are stateless.
- **Migration safety** — Idempotent SQL; safe to re-run on every boot.
- **Legacy data** — `workspace_original_paths` / `session_names` rows are merged then dropped.
- **Backups** — Operators back up `~/.cloudcli/auth.db`; VAPID keys, users, projects, sessions, and push subscriptions all live there.
- **Workspace validation** — `validateWorkspacePath` defends against path traversal; used by every handler that touches the filesystem.

## Technical Mapping (Entry Points)

- **Connection:** `server/modules/database/connection.ts`
- **Schema:** `server/modules/database/schema.ts`
- **Migrations:** `server/modules/database/migrations.ts`
- **Init:** `server/modules/database/init-db.ts`
- **Barrel:** `server/modules/database/index.ts`
- **Repositories:** `server/modules/database/repositories/*.ts`
- **Shared utils:** `server/shared/utils.ts`, `server/shared/types.ts`, `server/shared/interfaces.ts`
- **Legacy (migration window):** `server/sessionManager.js`, `server/utils/runtime-paths.js`

## Capability Documents

- [capabilities/database-layer/connection-and-bootstrap.md](capabilities/database-layer/connection-and-bootstrap.md)
- [capabilities/database-layer/schema-and-migrations.md](capabilities/database-layer/schema-and-migrations.md)
- [capabilities/database-layer/repositories.md](capabilities/database-layer/repositories.md)
- [capabilities/database-layer/legacy-compatibility.md](capabilities/database-layer/legacy-compatibility.md)
- [capabilities/database-layer/workspace-path-validation.md](capabilities/database-layer/workspace-path-validation.md)
