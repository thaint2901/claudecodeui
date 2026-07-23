# Subsystem 8: Session & Project Management

## Business Purpose

The **Session & Project Management** subsystem owns the lifecycle of the two primary user-facing entities: **projects** (the local directories the user has registered) and **sessions** (the chat conversations within a project, across all providers). It auto-discovers existing provider transcripts, persists them, and serves the sidebar payload that drives navigation.

Every chat the user has ever had — across Claude, Cursor, Codex, and OpenCode — flows through this subsystem.

## Key Capabilities

| Capability | Description |
|------------|-------------|
| **Project CRUD** | Create, archive, restore, hard-delete, rename, star |
| **Project with sessions payload** | Sidebar list with sessions grouped under each project |
| **Soft-delete (archive)** | Hide from default lists; recoverable |
| **Hard-delete** | Remove jsonl transcripts, sessions rows, and the project row |
| **Star / unstar** | Mark favorite projects |
| **Display name resolution** | Custom name → `package.json` name → basename fallback |
| **GitHub clone** | Clone a repo with progress streamed over Server-Sent Events |
| **TaskMaster detection** | Per-project task metadata (parses `tasks.json` with status counts) |
| **Loading-progress broadcasts** | WebSocket `kind: loading_progress` |
| **Session create / resume** | Allocate a stable app session id, map to provider-native id. `/fork` is the one path where the provider-native id is announced *mid-run* rather than at creation, onto a session row already allocated before the run started. |
| **Session history** | Fetch and normalize past messages for display |
| **Session archive / rename / delete** | Lifecycle management |
| **Session search** | Cross-provider SSE search |
| **Auto-discovery** | Watcher service scans provider artifact roots and broadcasts `session_upserted` |
| **Token usage** | Parse provider JSONL / Codex events / OpenCode sqlite for per-session token usage |
| **Sidebar running indicator** | Live indicator for sessions currently being run |

## Two-ID Session Design

The `sessions` table stores two ids:

- `session_id` — the stable app-facing id used by the frontend (assigned by the app on first chat)
- `provider_session_id` — the native id used by the CLI/SDK transcript (filled in once the provider announces it)

The `chat-session-writer.service.ts` remaps the provider-native id to the stable app id so the UI never sees two different ids for the same session. The synchronizer reads the provider's on-disk artifact (jsonl for Claude/Cursor/Codex, sqlite for OpenCode) and populates `provider_session_id`.

## Stakeholders

| Stakeholder | What They Get |
|-------------|---------------|
| **End users** | A sidebar that lists every project and every session across providers. |
| **Power users** | Search across all past session messages; archive; restore; rename. |
| **External integrators** | `/api/agent` can resolve a project id to a path and a session id. |
| **The sessions-watcher** | Discovers sessions created outside the UI (e.g. directly in a CLI). |
| **The notification orchestrator** | Resolves a session id to a stable app id before sending. |

## How the Sidebar Loads

1. The user opens the app; the sidebar mounts.
2. The sidebar calls `getProjectsWithSessions` (or the paged variant) over REST.
3. The projects module joins `projects` × `sessions` and returns the sidebar payload.
4. The watcher service has already scanned each provider's artifact root and populated `sessions` via the synchronizer.
5. Running sessions surface a live indicator (the chat run registry reports active state).
6. The user can search, archive, rename, delete, or start a new session.

## Cross-Cutting Concerns

- **Session-id identity mapping** — Stable app id; provider-native id; remapped in the writer.
- **Auto-discovery** — The `sessions-watcher.service.ts` uses chokidar to watch provider artifact roots; debounced `session_upserted` broadcasts.
- **Scan watermark** — `scan_state` table tracks the last scan time to skip work.
- **Project-root path validation** — `validateWorkspacePath` guards every project path operation.
- **GitHub auth** — Clone uses `user_credentials` (github_token) for auth; URL is sanitized.
- **TaskMaster** — Detected per project; tasks JSON parsed; real-time updates broadcast over WebSocket.

## Technical Mapping (Entry Points)

- **Projects module:** `server/modules/projects/`
  - `projects.routes.ts`
  - `services/project-management.service.ts`
  - `services/project-delete.service.ts`
  - `services/project-star.service.ts`
  - `services/projects-with-sessions-fetch.service.ts`
  - `services/project-clone.service.ts`
  - `services/projects-has-taskmaster.service.ts`
- **Provider services:**
  - `server/modules/providers/services/sessions.service.ts`
  - `server/modules/providers/services/session-synchronizer.service.ts`
  - `server/modules/providers/services/sessions-watcher.service.ts`
  - `server/modules/providers/services/session-conversations-search.service.ts`
- **Repositories:** `server/modules/database/repositories/projects.db.ts`, `sessions.db.ts`, `scan-state.db.ts`
- **Frontend:** `src/components/sidebar/view/Sidebar.tsx` and subcomponents
- **Frontend project creation:** `src/components/project-creation-wizard/ProjectCreationWizard.tsx`

## Capability Documents

- [capabilities/session-and-project-management/project-crud.md](capabilities/session-and-project-management/project-crud.md)
- [capabilities/session-and-project-management/session-lifecycle.md](capabilities/session-and-project-management/session-lifecycle.md)
- [capabilities/session-and-project-management/auto-discovery-and-watcher.md](capabilities/session-and-project-management/auto-discovery-and-watcher.md)
- [capabilities/session-and-project-management/sidebar-payload-and-search.md](capabilities/session-and-project-management/sidebar-payload-and-search.md)
- [capabilities/session-and-project-management/github-clone.md](capabilities/session-and-project-management/github-clone.md)
- [capabilities/session-and-project-management/taskmaster-integration.md](capabilities/session-and-project-management/taskmaster-integration.md)
- [capabilities/session-and-project-management/token-usage-lookup.md](capabilities/session-and-project-management/token-usage-lookup.md)
