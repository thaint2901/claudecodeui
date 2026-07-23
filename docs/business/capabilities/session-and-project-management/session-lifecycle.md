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

## Flow (Fork via `/fork`)

The `/fork` command (see the Slash Commands capability) is the one case where the provider announces a *brand-new* native session id mid-run rather than filling in the id of the session the user is already looking at:

1. cloudcli allocates a new app session row up front — before the SDK run even starts — named `"<parent> (fork)"`, and resumes the parent's provider-native session id with `forkSession: true`.
2. The SDK starts the fork and, mid-stream, announces the fork's own new provider-native session id (a fork never keeps the parent's native id).
3. `recaptureForkSession` (in `server/claude-sdk.js`) re-keys the run's internal tracking onto the newly announced id, and the chat run registry maps that id onto the app session row allocated in step 1 — the only path in the app where a provider id changes after a run has already begun.
4. At the moment the fork's id is announced, cloudcli writes the fork's name back into the fork's own transcript as a `custom-title` event via `renameSessionById` (highest-precedence title source), so a later watcher sync doesn't overwrite the `" (fork)"` suffix with something derived from the copied history.
5. An acknowledgment is written into the *original* session's transcript telling the user where the fork went; if the write-back at step 4 fails, or the run itself fails, the failure surfaces as a `task_notification` rather than failing silently.

## Output

- A stable app session id.
- A mapped provider session id.
- A consistent sidebar that survives across providers and resumes.
- For `/fork`: a new sidebar entry named `"<parent> (fork)"` whose provider-native id was captured mid-run.

## Technical Mapping

- **Backend service:** `server/modules/providers/services/sessions.service.ts`
- **Backend writer:** `server/modules/websocket/services/chat-session-writer.service.ts`
- **Backend repo:** `server/modules/database/repositories/sessions.db.ts`
- **Backend fork capture:** `server/claude-sdk.js` (`recaptureForkSession`)
- **Backend fork interception:** `server/modules/websocket/services/chat-websocket.service.ts` (`parseForkCommand`, `handleChatSend`)
- **Frontend sidebar:** `src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx`, `SidebarSessionItem.tsx`

## Dependencies

- **Database Layer** — `sessions` table.
- **Chat & Agent Streaming** — Allocates the session id.
- **Provider Integration** — Provides the native id.
