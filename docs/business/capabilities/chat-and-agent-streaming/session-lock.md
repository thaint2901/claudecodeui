# Capability: Session Lock (Background Agent)

## Description

Detects when the currently-open session is being driven by a Claude Code background/daemon worker (dispatched via `claude agents`, `claude --bg`, or agent-view) rather than the web UI itself. While locked, the composer disables the prompt and shows a warning banner with a "Stop & Resume" action that terminates the background worker and re-enables typing.

## Actors

- **End-user developer** — has a session open in the chat view that is also running as a background CLI agent (e.g. dispatched from a terminal).
- **Session Lock Watcher** (`session-lock-watcher.service.ts`) — watches the Claude daemon's `roster.json` for lock/unlock changes.
- **WebSocket hub** — broadcasts `session_lock_state_changed` deltas to all connected chat clients.
- **SessionLockContext** (frontend) — tracks per-session locked state.
- **ChatComposer / SessionLockControls** — renders the lock banner and Stop & Resume button.

## Trigger

- A chat view mounts for a session that is currently held by a background worker (seeded via `GET /api/sessions/:id/lock-status`).
- The daemon's roster file changes — a background session starts or ends — broadcasting a delta to all connected clients.

## Flow

1. The server watches the directory containing `~/.claude/daemon/roster.json` (not the file directly — the daemon replaces it via atomic rename, which would break a direct file watch) and extracts the set of locked session IDs.
2. On change, the watcher diffs against the last-known set and broadcasts `locked`/`unlocked` deltas over the existing chat WebSocket.
3. `SessionLockContext` applies the delta to a `Map<sessionId, boolean>` and answers `isLocked(sessionId)` for any component.
4. `ChatInterface` looks up the current session's lock state; if locked, `ChatComposer` disables the textarea and renders `SessionLockBanner` + `SessionLockStopButton` in place of the normal Send button.
5. Clicking Stop & Resume calls `POST /api/sessions/:id/stop`, which resolves the real `claude` executable (via `resolveClaudeCodeExecutablePath`, honoring `CLAUDE_CLI_PATH`) and runs `claude stop <shortId>`.
6. Once the daemon releases the worker, the next roster change broadcasts an `unlocked` event; the composer re-enables and the session is refetched so its activity indicator clears.

## Output

- A composer that can't be typed into while a background agent holds the session, preventing a confusing double-write race.
- A one-click way to kill that background agent and resume typing in the web UI.

## Technical Mapping

- **Backend service:** `server/modules/providers/services/session-lock-watcher.service.ts` (`initializeSessionLockWatcher`, `getLockedBgSessionIds`)
- **Backend routes:** `server/routes/agent.js` — `sessionLockRouter` (`GET /api/sessions/:id/lock-status`, `POST /api/sessions/:id/stop`), mounted in `server/index.js` behind `authenticateToken`
- **Frontend context:** `src/contexts/SessionLockContext.tsx`, `src/contexts/sessionLockApi.ts`
- **Frontend UI:** `src/components/chat/view/subcomponents/SessionLockControls.tsx` (built on the shared `Alert`/`Button` primitives from `src/shared/view/ui`, not one-off styling)
- **Wired into:** `src/App.tsx` (provider), `ChatInterface.tsx`, `ChatComposer.tsx`
- **Realtime routing:** `session_lock_state_changed` is explicitly excluded from the generic chat-message reducer in `src/components/chat/hooks/useChatRealtimeHandlers.ts` — it is not a `NormalizedMessage` and must not be appended to a session's message list.

## Dependencies

- **Provider Integration** — depends on the Claude CLI's daemon/roster mechanism; this is Claude-specific and has no equivalent for the other four providers.
- **Chat & Agent Streaming (this subsystem)** — shares the same chat WebSocket connection and session identity (`session_id` == the Claude CLI's own session UUID) that the rest of the subsystem relies on.
- Local/self-hosted deployments only — `roster.json` is a local filesystem path on the machine running the server; this capability is not meaningful when the browser and daemon are on different hosts.
