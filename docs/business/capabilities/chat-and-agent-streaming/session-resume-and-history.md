# Capability: Session Resume & History

## Description

Lets the user reopen any past session and continue from where they left off. The history is loaded from the provider transcript (jsonl for Claude/Codex/Cursor; sqlite for OpenCode), normalized into the UI's message format, and the session is resumed on the provider side (e.g. `sdkOptions.resume` for Claude, `--resume` for Cursor).

## Actors

- **End-user developer** — Clicks a session in the sidebar.
- **The sessions service** — Resolves the app id to a provider session id and transcript path.
- **The provider runtime** — Resumes the session.
- **The history loader** — Parses the transcript and normalizes messages.

## Trigger

- The user clicks a session in `SidebarProjectSessions`.

## Flow

1. The sidebar emits a session-click event.
2. The chat view navigates to `/session/:sessionId`.
3. The frontend calls `GET /api/sessions/:id/history`.
4. The sessions service looks up the session, resolves the `provider_session_id` and `jsonl_path`, and streams back the normalized history.
5. The chat pane renders the history.
6. The next user message uses the provider's resume mechanism (e.g. `sdkOptions.resume`).
7. New events continue from the resumed state.

## Output

- A fully rendered history of the past conversation.
- A resumed session that continues from the user's last turn.
- Persisted new turns appended to the transcript.

## Technical Mapping

- **Frontend entry:** `src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx`, `SidebarSessionItem.tsx`
- **Frontend chat view:** `src/components/chat/view/ChatInterface.tsx`
- **Backend service:** `server/modules/providers/services/sessions.service.ts` (`fetchHistory`, `normalizeMessage`)
- **Provider resume:**
  - Claude: `sdkOptions.resume` in `server/claude-sdk.js`
  - Cursor: `--resume` in `server/cursor-cli.js`
  - OpenCode: `--session <id>` in `server/opencode-cli.js`
  - Codex: SDK thread resume in `server/openai-codex.js`
- **Synchronizer:** `server/modules/providers/services/session-synchronizer.service.ts`

## Dependencies

- **Session & Project Management** — The session row and transcript path.
- **Provider Integration** — Provider-specific resume and history parsing.
- **Database Layer** — The `sessions` and `projects` tables.
