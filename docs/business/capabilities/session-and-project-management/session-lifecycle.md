# Capability: Session Lifecycle

## Description

Creates, resumes, archives, renames, and deletes chat sessions. The two-id design (`session_id` + `provider_session_id`) keeps the app-facing id stable while the provider's native id is filled in once announced.

## Actors

- **End user** — Starts, resumes, renames, archives, deletes sessions.
- **The provider runtime** — Announces its native session id.
- **The chat session writer** — Remaps provider ids to app ids.
- **The sessions service** — Owns the lifecycle.
- **The sidebar** — Renders the list and provides actions.

## Trigger

- The user sends the first message in a project (new session).
- The user clicks a past session in the sidebar (resume).
- The user renames / archives / deletes a session.

## Flow (Create)

1. The user sends the first message in a project.
2. The chat hub allocates a stable `session_id` (UUID) and calls `sessionsDb.createAppSession`.
3. The frontend renders the new session in the sidebar.
4. When the provider announces its native id, the runtime calls `sessionsDb.assignProviderSessionId`.
5. The session row is updated; the runtime can now resume the session on the provider side.

## Flow (Resume)

1. The user clicks a session in the sidebar.
2. The chat view navigates to `/session/:sessionId`.
3. The history loader fetches the transcript.
4. The runtime resumes the session using the `provider_session_id` (e.g. `sdkOptions.resume`, `--resume`, `--session`).

## Flow (Archive / Rename / Delete)

1. The user clicks a session action in the sidebar.
2. The frontend calls the appropriate endpoint.
3. The sessions service updates the row.
4. The sidebar re-renders.

## Output

- A stable app session id.
- A mapped provider session id.
- A consistent sidebar that survives across providers and resumes.

## Technical Mapping

- **Backend service:** `server/modules/providers/services/sessions.service.ts`
- **Backend writer:** `server/modules/websocket/services/chat-session-writer.service.ts`
- **Backend repo:** `server/modules/database/repositories/sessions.db.ts`
- **Frontend sidebar:** `src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx`, `SidebarSessionItem.tsx`

## Dependencies

- **Database Layer** — `sessions` table.
- **Chat & Agent Streaming** — Allocates the session id.
- **Provider Integration** — Provides the native id.
