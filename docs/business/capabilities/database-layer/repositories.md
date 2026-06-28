# Capability: Repositories

## Description

One repository module per table: a thin, typed wrapper around the SQL operations. The rest of the backend never writes raw SQL — it imports the repository functions. This makes the data layer testable and refactor-safe.

## Actors

- **All other backend modules** — The only consumers.
- **The repositories** — One per table.
- **`getConnection`** — The shared connection.

## Trigger

- Any CRUD operation on a known table.

## Flow

1. A route or service calls, e.g., `usersRepo.getUserById(userId)`.
2. The repository executes the SQL against the shared connection.
3. The result is returned to the caller.

## Repository List

| Repository | Table | Operations |
|------------|-------|------------|
| `users.ts` | `users` | getUserById, getUserByUsername, createUser, updateLastLogin, updateGitConfig, hasCompletedOnboarding, completeOnboarding, getFirstUser |
| `api-keys.ts` | `api_keys` | createApiKey, validateApiKey, listApiKeys, deleteApiKey |
| `credentials.ts` | `user_credentials` | getCredential, setCredential, deleteCredential, listCredentials |
| `github-tokens.ts` | `user_credentials` (filtered) | getGithubToken, setGithubToken, deleteGithubToken |
| `projects.db.ts` | `projects` | createProjectPath, getProjectPathById, getProjectById, listProjects, archiveProject, restoreProject, deleteProject, starProject, unstarProject, updateCustomName |
| `sessions.db.ts` | `sessions` | createAppSession, assignProviderSessionId, createSession, findLatestPendingAppSession, updateSessionIsArchived, updateSessionCustomName, deleteSessionById, listSessionsByProject |
| `notification-preferences.ts` | `user_notification_preferences` | getPreferences, setPreferences |
| `push-subscriptions.ts` | `push_subscriptions` | createSubscription, deleteSubscription, listSubscriptionsByUser, pruneDeadSubscriptions |
| `vapid-keys.ts` | `vapid_keys` | getOrCreate, get |
| `app-config.ts` | `app_config` | get, set, getOrCreateJwtSecret, getOrCreateBrowserUseSettings |
| `scan-state.db.ts` | `scan_state` | getLastScannedAt, updateLastScannedAt |

## Output

- A consistent, typed data layer.
- One SQL string per operation, all in one place.

## Technical Mapping

- **Repositories:** `server/modules/database/repositories/*.ts`
- **Barrel:** `server/modules/database/index.ts`

## Dependencies

- **Database Layer** — Connection & bootstrap, schema & migrations.
- All other subsystems — The consumers.
